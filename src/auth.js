// Panel authentication: password hash + short-lived server-side sessions.
// Exchange API keys never participate in panel authentication.
const fs = require('fs');
const { atomicWriteFileSync } = require('./util/atomicWrite');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const IDLE_TTL_MS = 30 * 60 * 1000;
const RECENT_AUTH_MS = 15 * 60 * 1000;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sessions = new Map();

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error('Panel kimlik dosyası okunamadı.');
  }
}
function writeAuth(record) {
  ensureDir();
  atomicWriteFileSync(AUTH_FILE, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch (e) { /* Windows */ }
}
function validatePassword(password) {
  if (typeof password !== 'string') throw new Error('Panel şifresi gerekli.');
  if (password.length < 12) throw new Error('Panel şifresi en az 12 karakter olmalı.');
  if (password.length > 256) throw new Error('Panel şifresi çok uzun.');
}
function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, SCRYPT);
  return { algorithm: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: key.toString('base64') };
}
function verifyPassword(password, record) {
  if (!record || record.algorithm !== 'scrypt') return false;
  if (typeof password !== 'string' || password.length > 256) return false;
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: record.N, r: record.r, p: record.p, maxmem: SCRYPT.maxmem });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (e) { return false; }
}
// --- Olay dongusunu bloke etmeyen dogrulama ---
// scryptSync her yanlis giriste ~100 ms bloke eder; kimliksiz saldirgan bot dongusunu (stop-loss/kill switch) geciktirebilirdi.
// Async scrypt libuv thread havuzunda calisir; es zamanli dogrulama sayisi sinirlidir, fazlasi kuyrukta bekler, kuyruk dolarsa reddedilir.
const MAX_VERIFY_CONCURRENCY = 2;
const MAX_VERIFY_QUEUE = 6;
let verifyRunning = 0;
const verifyQueue = [];
function acquireVerifySlot() {
  if (verifyRunning < MAX_VERIFY_CONCURRENCY) { verifyRunning++; return Promise.resolve(); }
  if (verifyQueue.length >= MAX_VERIFY_QUEUE) {
    const err = new Error('Sistem meşgul; birkaç saniye sonra tekrar dene.'); err.status = 503; err.busy = true;
    return Promise.reject(err);
  }
  return new Promise((resolve) => verifyQueue.push(resolve));
}
function releaseVerifySlot() {
  const next = verifyQueue.shift();
  if (next) next(); else verifyRunning--;
}
function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));
}
async function verifyPasswordAsync(password, record) {
  if (!record || record.algorithm !== 'scrypt') return false;
  if (typeof password !== 'string' || password.length > 256) return false;
  await acquireVerifySlot();
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const actual = await scryptAsync(password, salt, expected.length, { N: record.N, r: record.r, p: record.p, maxmem: SCRYPT.maxmem });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (e) { return false; }
  finally { releaseVerifySlot(); }
}
async function loginAsync(password) {
  const record = ensureConfigured();
  if (!(await verifyPasswordAsync(password, record))) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  addSession(token, now);
  return { token, createdAt: now };
}
async function reauthenticateAsync(token, password) {
  const session = getSession(token);
  if (!session) return false;
  const record = ensureConfigured();
  if (!(await verifyPasswordAsync(password, record))) return false;
  // Dogrulama sirasinda oturum kapanmis/silinmis olabilir.
  const still = sessions.get(token);
  if (!still) return false;
  still.reauthAt = Date.now();
  return true;
}
function setPassword(password) { const record = hashPassword(password); writeAuth(record); return record; }

function ensureConfigured() {
  let record = readAuth();
  if (record) return record;
  // One-time bootstrap only. After auth.json exists, the environment password
  // is no longer used for authentication.
  if (process.env.PANEL_PASSWORD) {
    record = hashPassword(process.env.PANEL_PASSWORD);
    writeAuth(record);
    console.warn('[auth] PANEL_PASSWORD yalnızca ilk kurulum için kullanıldı; bundan sonra data/auth.json kullanılıyor.');
    return record;
  }
  throw new Error('Panel kimliği ayarlı değil. Önce "npm run auth:setup" çalıştır veya ilk kurulum için PANEL_PASSWORD ver.');
}
const MAX_SESSIONS = 20;
function addSession(token, now) {
  // Sinirsiz oturum birikmesi bellek/yer tuketir: en eskiyi at.
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
  sessions.set(token, { createdAt: now, lastSeenAt: now, reauthAt: now });
}
function login(password) {
  const record = ensureConfigured();
  if (!verifyPassword(password, record)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  addSession(token, now);
  return { token, createdAt: now };
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.createdAt > SESSION_TTL_MS || now - s.lastSeenAt > IDLE_TTL_MS) {
    sessions.delete(token); return null;
  }
  s.lastSeenAt = now;
  return s;
}
function logout(token) { if (token) sessions.delete(token); }
function reauthenticate(token, password) {
  const session = getSession(token);
  if (!session) return false;
  const record = ensureConfigured();
  if (!verifyPassword(password, record)) return false;
  session.reauthAt = Date.now();
  return true;
}
function isRecentlyAuthenticated(session) {
  return Boolean(session && Date.now() - session.reauthAt <= RECENT_AUTH_MS);
}
// x-forwarded-proto yalnizca guvenilir proxy (TRUST_PROXY=true) varsa dikkate alinir;
// aksi halde istemci basligi taklit ederek Secure/__Host- karari uzerinde etki kuramaz.
function isSecureRequest(req) {
  if (!req) return false;
  // Express req.secure: TLS dogrudan ya da 'trust proxy' (sinirli hop) ile guvenilir proxy'den gelen X-Forwarded-Proto.
  if (req.secure === true) return true;
  if (req.socket && req.socket.encrypted) return true;
  // Ham 'upgrade' (WebSocket) isteklerinde Express alanlari (req.secure/req.get) YOKTUR; ayni guven kuralini elle uygula:
  // basliga yalnizca TRUST_PROXY=true ise guvenilir. (Eskiden bu yol hic yoktu: HTTPS proxy arkasinda WS kimligi bozuluyordu.)
  if (req.secure === undefined && process.env.TRUST_PROXY === 'true') {
    return String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}
function cookieName(secure) { return secure ? '__Host-panel_session' : 'panel_session'; }
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      // Gecersiz % kodlamasi decodeURIComponent'i firlatir; bozuk cerez oturumsuz sayilir, surec cokmez.
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* yoksay */ }
    }
  });
  return out;
}
function tokenFromRequest(req) {
  // HTTPS'te SADECE __Host- cerezi kabul edilir: korumasiz 'panel_session' (cerez tohumlama/fixation) reddedilir.
  const secure = isSecureRequest(req);
  const cookies = parseCookies(req.headers.cookie);
  return cookies[cookieName(secure)] || null;
}
function sessionFromRequest(req) { return getSession(tokenFromRequest(req)); }
function setSessionCookie(res, req, token) {
  const secure = isSecureRequest(req);
  const name = cookieName(secure);
  const attrs = [`${name}=${encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res, req) {
  const secure = isSecureRequest(req);
  const names = [cookieName(secure), 'panel_session', '__Host-panel_session'];
  res.setHeader('Set-Cookie', names.map((name) => `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`));
}
function status() { return { configured: Boolean(readAuth()), sessions: sessions.size, sessionTtlMinutes: SESSION_TTL_MS / 60000, idleTtlMinutes: IDLE_TTL_MS / 60000, recentAuthMinutes: RECENT_AUTH_MS / 60000 }; }
const cleanup = setInterval(() => {
  for (const [token, s] of sessions) if (!getSession(token)) sessions.delete(token);
}, 5 * 60 * 1000);
cleanup.unref();

module.exports = { setPassword, ensureConfigured, login, loginAsync, getSession, logout, reauthenticate, reauthenticateAsync, verifyPasswordAsync, tokenFromRequest, isSecureRequest, isRecentlyAuthenticated, sessionFromRequest, setSessionCookie, clearSessionCookie, status, AUTH_FILE };
