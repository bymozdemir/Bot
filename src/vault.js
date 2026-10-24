// src/vault.js
//
// API anahtarlarini diskte SIFRELI tutan basit bir kasa. Node'un kendi
// `crypto` modulunu kullanir, ek paket gerekmez (Termux'ta kurulum kolaylasir).
//
// Nasil calisir:
//   - Panelden bir ANA SIFRE (passphrase) girilir. Bu sifrenin kendisi HICBIR
//     YERE yazilmaz. Sadece o an calisan sunucu surecinin BELLEGINDE, sifreden
//     turetilmis bir AES anahtari olarak tutulur (sessionKey).
//   - API key/secret bu anahtarla AES-256-GCM ile sifrelenip data/credentials.enc.json
//     dosyasina yazilir. Dosyayi acip okuyan biri ana sifre olmadan hicbir sey
//     goremez (rastgele bayt gorur).
//   - Sunucu yeniden baslarsa (telefon yeniden acilir, islem coker vb.)
//     sessionKey bellekte kaybolur -- panelden ana sifre TEKRAR girilmeli.
//     Bu bilincli bir tercih: anahtarin sifresi disk uzerinde hicbir yerde
//     acik durmuyor demek.
//   - Ana sifreyi unutursan kurtarma YOK. data/credentials.enc.json dosyasini
//     silip yeni bir ana sifreyle yeniden kaydetmek gerekir.

const crypto = require('crypto');
const fs = require('fs');
const { atomicWriteFileSync } = require('./util/atomicWrite');
const path = require('path');

// API anahtarları yalnızca bu kurulumun kendi veri kökünde tutulur.
// BOT_DATA_DIR farklıysa bu kasa da tamamen ayrı bir dosyaya gider.
const DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CRED_FILE = path.join(DATA_DIR, 'credentials.enc.json');
const CANARY_TEXT = 'al-sat-vault-ok';

let sessionKey = null; // Buffer(32) | null -- sadece bellekte

// KDF parametreleri dosyada saklanir (kdf alani): ileride guclendirilebilir, eski kasalar bozulmaz.
// Eski dosyalarda kdf yoktur -> Node varsayilanlari (N=16384, r=8, p=1) ile acilir ve ilk acilista yukseltilir.
const LEGACY_KDF = { N: 16384, r: 8, p: 1 };
const STRONG_KDF = { N: 131072, r: 8, p: 1 }; // ~128 MiB, offline kaba kuvveti belirgin zorlastirir
const MIN_PASSPHRASE = 12;

function deriveKey(passphrase, saltB64, kdf = LEGACY_KDF) {
  // KDF metadata is read from a local JSON file and must not be trusted. Without
  // strict bounds a damaged/tampered N/r/p can block the event loop or exhaust RAM.
  const allowed = (kdf && kdf.N === LEGACY_KDF.N && kdf.r === LEGACY_KDF.r && kdf.p === LEGACY_KDF.p)
    || (kdf && kdf.N === STRONG_KDF.N && kdf.r === STRONG_KDF.r && kdf.p === STRONG_KDF.p);
  if (!allowed) throw new Error('Kasa KDF parametreleri geçersiz veya desteklenmiyor. Dosyayı yedekten kurtarın.');
  if (typeof saltB64 !== 'string' || saltB64.length > 128) throw new Error('Kasa salt alanı geçersiz.');
  const salt = Buffer.from(saltB64, 'base64');
  if (salt.length !== 16 || salt.toString('base64').replace(/=+$/, '') !== saltB64.replace(/=+$/, '')) {
    throw new Error('Kasa salt alanı geçersiz.');
  }
  if (typeof passphrase !== 'string' || passphrase.length > 256) throw new Error('Ana şifre biçimi geçersiz.');
  return crypto.scryptSync(passphrase, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

function loadFile() {
  if (!fs.existsSync(CRED_FILE)) return { salt: null, canary: null, exchanges: {} };
  try {
    // Credentials are tiny; reject oversized/corrupt local files before reading/parsing them.
    const st = fs.statSync(CRED_FILE);
    if (!st.isFile() || st.size > 1024 * 1024) throw new Error('dosya boyutu geçersiz');
    const parsed = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON kökü geçersiz');
    return parsed;
  } catch (e) {
    throw new Error('credentials.enc.json okunamadı/bozuk (' + e.message + '). Dosyayı yedekten kurtarın.');
  }
}

function saveFile(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  atomicWriteFileSync(CRED_FILE, JSON.stringify(data, null, 2), { mode: 0o600, backup: true, backupEveryMs: 0 });
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), data: enc.toString('base64'), tag: authTag.toString('base64') };
}

function decrypt(key, payload, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  if (aad && payload.aad !== false) decipher.setAAD(Buffer.from(aad, 'utf8'));
  const tag = Buffer.from(payload.tag, 'base64');
  if (tag.length !== 16) throw new Error('gecersiz GCM etiketi'); // kisaltilmis etiketle sahteciligi onle
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

function status() {
  // Bozuk dosya yuzunden status() firlatirsa panelin TUM durum yayini (publicState)
  // cokerdi; bu yuzden hatayi yakalayip durumu 'error' alaniyla bildiriyoruz.
  let file;
  try {
    file = loadFile();
  } catch (e) {
    return { initialized: true, unlocked: false, exchangesWithKeys: [], error: e.message };
  }
  return {
    initialized: !!file.salt, // daha once bir ana sifre belirlenmis mi
    unlocked: !!sessionKey, // bu surecte kasa acik mi
    exchangesWithKeys: Object.keys(file.exchanges || {})
  };
}

// Ilk kullanimda ana sifreyi BELIRLER (yeni salt + canary olusturur).
// Sonraki kullanimlarda ayni fonksiyon DOGRULAR (canary'yi cozup kontrol eder).
function unlock(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`Ana şifre en az ${MIN_PASSPHRASE} karakter olmalı.`);
  }
  if (passphrase.length > 256) throw new Error('Ana şifre çok uzun.');
  const file = loadFile();

  if (!file.salt) {
    const salt = crypto.randomBytes(16).toString('base64');
    const key = deriveKey(passphrase, salt, STRONG_KDF);
    const canary = encrypt(key, CANARY_TEXT);
    saveFile({ version: 2, kdf: STRONG_KDF, salt, canary, exchanges: {} });
    sessionKey = key;
    armAutoLock();
    return { created: true };
  }

  const kdf = file.kdf && file.kdf.N ? file.kdf : LEGACY_KDF;
  const key = deriveKey(passphrase, file.salt, kdf);
  try {
    const check = decrypt(key, file.canary);
    if (check !== CANARY_TEXT) throw new Error('mismatch');
  } catch (e) {
    throw new Error('Ana şifre hatalı.');
  }
  sessionKey = key;
  // Eski (zayif KDF'li) kasayi dogru sifre girilince guclu parametrelerle yeniden sarmala.
  if (!file.kdf || file.kdf.N < STRONG_KDF.N) {
    try {
      const entries = {};
      for (const [id, e] of Object.entries(file.exchanges || {})) {
        entries[id] = { apiKey: decrypt(key, e.apiKey, e.aad === true ? aadFor(id, 'apiKey') : undefined), apiSecret: decrypt(key, e.apiSecret, e.aad === true ? aadFor(id, 'apiSecret') : undefined) };
        if (e.apiPassphrase) entries[id].apiPassphrase = decrypt(key, e.apiPassphrase, aadFor(id, 'apiPassphrase'));
      }
      const salt = crypto.randomBytes(16).toString('base64');
      const newKey = deriveKey(passphrase, salt, STRONG_KDF);
      const upgraded = { version: 2, kdf: STRONG_KDF, salt, canary: encrypt(newKey, CANARY_TEXT), exchanges: {} };
      for (const [id, v] of Object.entries(entries)) {
        const old = file.exchanges[id];
        upgraded.exchanges[id] = { apiKey: encrypt(newKey, v.apiKey, aadFor(id, 'apiKey')), apiSecret: encrypt(newKey, v.apiSecret, aadFor(id, 'apiSecret')), aad: true, savedAt: old.savedAt };
        if (v.apiPassphrase) upgraded.exchanges[id].apiPassphrase = encrypt(newKey, v.apiPassphrase, aadFor(id, 'apiPassphrase'));
      }
      saveFile(upgraded);
      sessionKey = newKey;
    } catch (e) { /* yukseltme basarisizsa eski kasayla devam; veri kaybi yok */ }
  }
  armAutoLock();
  return { created: false };
}

// Kasa bellekte sonsuza dek acik kalmasin: bos kalirsa otomatik kilitlenir.
const AUTO_LOCK_MS = Number(process.env.VAULT_AUTO_LOCK_MINUTES || 60) * 60000;
let lockTimer = null;
function armAutoLock() {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = null;
  if (!sessionKey || !(AUTO_LOCK_MS > 0)) return;
  lockTimer = setTimeout(() => { sessionKey = null; lockTimer = null; }, AUTO_LOCK_MS);
  if (lockTimer.unref) lockTimer.unref();
}

function lock() {
  sessionKey = null;
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
}

function requireUnlocked() {
  if (!sessionKey) throw new Error('Kasa kilitli. Önce ana şifreyi gir.');
}

function aadFor(exchangeId, field) { return `al-sat-vault:v2:${exchangeId}:${field}`; }

function saveExchangeKeys(exchangeId, apiKey, apiSecret, apiPassphrase = null) {
  requireUnlocked();
  if (!apiKey || !apiSecret) throw new Error('API key ve secret gerekli.');
  const file = loadFile();
  file.exchanges = file.exchanges || {};
  file.exchanges[exchangeId] = {
    apiKey: encrypt(sessionKey, apiKey, aadFor(exchangeId, 'apiKey')),
    apiSecret: encrypt(sessionKey, apiSecret, aadFor(exchangeId, 'apiSecret')),
    aad: true,
    savedAt: new Date().toISOString()
  };
  // Coinbase Exchange ve OKX/OKX TR API passphrase ister; yalnızca verilmişse, diğer alanlarla aynı AAD'li şifrelemeyle saklanır.
  if (apiPassphrase) file.exchanges[exchangeId].apiPassphrase = encrypt(sessionKey, apiPassphrase, aadFor(exchangeId, 'apiPassphrase'));
  saveFile(file);
  armAutoLock();
}

// Sadece sunucu ici kullanim icin (ornegin exchange adaptorune gecirmek).
// Panelin HICBIR endpoint'i bu degerleri oldugu gibi geri dondurmemeli.
function getExchangeKeys(exchangeId) {
  if (!sessionKey) return null;
  const file = loadFile();
  const entry = file.exchanges && file.exchanges[exchangeId];
  if (!entry) return null;
  try {
    // aad:true olmayan eski kayitlar AAD'siz cozulur (geriye uyumluluk).
    const useAad = entry.aad === true;
    armAutoLock();
    const out = {
      apiKey: decrypt(sessionKey, entry.apiKey, useAad ? aadFor(exchangeId, 'apiKey') : undefined),
      apiSecret: decrypt(sessionKey, entry.apiSecret, useAad ? aadFor(exchangeId, 'apiSecret') : undefined)
    };
    if (entry.apiPassphrase) out.apiPassphrase = decrypt(sessionKey, entry.apiPassphrase, aadFor(exchangeId, 'apiPassphrase'));
    return out;
  } catch (e) {
    throw new Error('Kayıtlı anahtar çözülemedi (ana şifre değişmiş olabilir).');
  }
}

function removeExchangeKeys(exchangeId) {
  const file = loadFile();
  if (file.exchanges) delete file.exchanges[exchangeId];
  saveFile(file);
  // atomicWrite onceki surumu .bak'a kopyalar: silinen anahtarin sifreli hali orada kalmasin.
  for (const bak of [CRED_FILE + '.bak']) { try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch (e) { /* yoksay */ } }
}

module.exports = {
  status,
  unlock,
  lock,
  saveExchangeKeys,
  getExchangeKeys,
  removeExchangeKeys
};
