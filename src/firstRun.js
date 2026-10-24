'use strict';
// İlk kurulum sihirbazı: `npm start` ilk açılışta eksik bilgileri sırayla sorar.
//  - Panel şifresi  -> data/auth.json (scrypt özeti; şifre düz metin saklanmaz)
//  - Telegram token / chat ID (isteğe bağlı) -> .env (izin 600)
// Etkileşimli terminal yoksa (Termux:Boot, systemd, Docker) hiçbir şey sormaz; eski davranış aynen sürer.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { atomicWriteFileSync } = require('./util/atomicWrite');

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;
const CHAT_ID_RE = /^-?\d{3,20}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9_:.\-]+$/;
const ENV_HEADER = '# AL-SAT bot ayarları. Kurulum sihirbazı tarafından oluşturuldu; bu dosyayı kimseyle paylaşma.\n# Yeniden kurmak için: npm run setup\n';

function parseEnvText(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readEnvFile(envFile) {
  try { return parseEnvText(fs.readFileSync(envFile, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

// updates: { KEY: 'değer' | null }. null = satırı sil. Diğer satırlar ve yorumlar korunur.
function upsertEnv(envFile, updates) {
  let text = '';
  try { text = fs.readFileSync(envFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const created = text === '';
  let lines = created ? [] : text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Geçersiz ayar adı: ${key}`);
    if (value !== null && !SAFE_VALUE_RE.test(String(value))) throw new Error(`${key} değeri güvenli karakterler dışında içeriyor.`);
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const idx = [];
    lines.forEach((l, i) => { if (!l.trim().startsWith('#') && re.test(l)) idx.push(i); });
    if (value === null) {
      lines = lines.filter((_, i) => !idx.includes(i));
    } else if (idx.length) {
      lines[idx[0]] = `${key}=${value}`;
      lines = lines.filter((_, i) => !idx.slice(1).includes(i));
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  const body = (created ? ENV_HEADER : '') + lines.join('\n') + '\n';
  atomicWriteFileSync(envFile, body, { mode: 0o600 });
  try { fs.chmodSync(envFile, 0o600); } catch (e) { /* Windows */ }
}

function hasPanelPassword(dataDir) {
  try { return fs.statSync(path.join(dataDir, 'auth.json')).size > 2; } catch (e) { return false; }
}

function effectiveEnv(envFile, env) { return { ...readEnvFile(envFile), ...env }; }

function needsSetup({ envFile, dataDir, env = process.env }) {
  const e = effectiveEnv(envFile, env);
  const pwMissing = !hasPanelPassword(dataDir) && !e.PANEL_PASSWORD;
  const tgMissing = !(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID) && !e.TELEGRAM_SETUP_SKIPPED;
  return pwMissing || tgMissing;
}

function telegramBase(e) {
  // Ana kod yalnızca ALLOW_LOCAL_EXCHANGE_URLS=1 iken özel taban adresi kabul eder; aynı kural.
  const b = e.TELEGRAM_API_BASE && e.ALLOW_LOCAL_EXCHANGE_URLS === '1' ? e.TELEGRAM_API_BASE : 'https://api.telegram.org';
  return b.replace(/\/+$/, '');
}

async function tgCall(fetchFn, base, token, method, query = '') {
  const url = `${base}/bot${token}/${method}${query}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
  let body = null;
  try { body = await res.json(); } catch (e) { /* gövde yok */ }
  return { status: res.status, body };
}

async function askToken(io, fetchFn, base) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = (await io.askHidden('Telegram bot token (BotFather\'dan; yazarken görünmez, yapıştırabilirsin): ')).trim();
    if (!token) { io.print('Boş bırakıldı.'); continue; }
    if (!TOKEN_RE.test(token)) { io.print('Token biçimi hatalı. Örnek biçim: 123456789:ABC... (BotFather\'ın verdiği tamamını yapıştır).'); continue; }
    io.print(`Token alındı (${token.length} karakter), Telegram ile doğrulanıyor...`);
    try {
      const r = await tgCall(fetchFn, base, token, 'getMe');
      if (r.body && r.body.ok && r.body.result) {
        io.print(`✓ Bot doğrulandı: @${r.body.result.username}`);
        return { token, username: r.body.result.username };
      }
      io.print('Telegram bu token\'ı reddetti (401/404). Tokenı BotFather\'dan yeniden kopyala.');
    } catch (e) {
      io.print(`Telegram\'a ulaşılamadı (${String(e.message || e).slice(0, 80)}). Token doğrulanamadı.`);
      if (await io.askYesNo('Yine de bu token kaydedilsin mi?', false)) return { token, username: null };
    }
  }
  return null;
}

async function detectChatId(io, fetchFn, base, token, username) {
  io.print(`Telegram'da @${username || 'botun'} ile sohbeti aç ve ona bir mesaj yaz (örn. /start). En fazla 90 saniye bekliyorum...`);
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    let r;
    try { r = await tgCall(fetchFn, base, token, 'getUpdates', `?timeout=${Date.now() + 25000 < until ? 20 : 5}&allowed_updates=%5B%22message%22%5D`); } catch (e) { io.print('Bağlantı hatası, yeniden deniyorum...'); await new Promise((res) => setTimeout(res, 2000)); continue; }
    if (r.status === 409) { io.print('Bu bota bağlı bir webhook var; chat ID elle girilmeli.'); return null; }
    const list = r.body && Array.isArray(r.body.result) ? r.body.result : [];
    const hit = list.find((u) => u.message && u.message.chat && u.message.chat.type === 'private');
    if (hit) {
      const chat = hit.message.chat;
      // Bekleyen eski mesajların bot açılınca komut olarak işlenmemesi için onaylanır (silinir).
      try { await tgCall(fetchFn, base, token, 'getUpdates', `?offset=${list[list.length - 1].update_id + 1}&timeout=0`); } catch (e) { /* önemli değil */ }
      const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '';
      io.print(`Mesaj bulundu: ${name ? name + ' ' : ''}(chat ID ${chat.id})`);
      if (await io.askYesNo('Bildirimler bu sohbete gelsin mi?', true)) return String(chat.id);
      return null;
    }
    if (!list.length) await new Promise((res) => setTimeout(res, 500));
  }
  io.print('90 saniye içinde mesaj gelmedi.');
  return null;
}

async function setupTelegram({ io, fetchFn, e, envFile }) {
  const base = telegramBase(e);
  const t = await askToken(io, fetchFn, base);
  if (!t) { io.print('Telegram kurulumu tamamlanamadı; atlandı. Sonra kurmak için: npm run setup'); upsertEnv(envFile, { TELEGRAM_SETUP_SKIPPED: '1' }); return false; }
  let chatId = null;
  for (let attempt = 0; attempt < 3 && !chatId; attempt++) {
    const typed = (await io.ask('Telegram chat ID (bilmiyorsan boş bırak, otomatik bulayım): ')).trim();
    if (typed) {
      if (CHAT_ID_RE.test(typed)) chatId = typed; else io.print('Chat ID yalnızca rakamlardan oluşmalı (negatif olabilir).');
    } else {
      chatId = await detectChatId(io, fetchFn, base, t.token, t.username);
      if (!chatId && !(await io.askYesNo('Tekrar denensin mi?', true))) break;
    }
  }
  if (!chatId) { io.print('Chat ID alınamadı; Telegram atlandı. Sonra kurmak için: npm run setup'); upsertEnv(envFile, { TELEGRAM_SETUP_SKIPPED: '1' }); return false; }
  upsertEnv(envFile, { TELEGRAM_BOT_TOKEN: t.token, TELEGRAM_CHAT_ID: chatId, TELEGRAM_SETUP_SKIPPED: null });
  try {
    const q = `?chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent('✅ AL-SAT botu kuruldu. Bildirimler ve komutlar bu sohbette çalışacak. /yardim yaz.')}`;
    const r = await tgCall(fetchFn, base, t.token, 'sendMessage', q);
    io.print(r.body && r.body.ok ? '✓ Telegram\'a test mesajı gönderildi.' : 'Test mesajı gönderilemedi (chat ID yanlış olabilir); bot yine de açılacak.');
  } catch (e2) { io.print('Test mesajı gönderilemedi (ağ); ayarlar kaydedildi.'); }
  return true;
}

async function setupPassword({ io, setPassword }) {
  io.print('Panel şifresi en az 12 karakter olmalı. Yazarken görünmez.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const a = await io.askHidden('Yeni panel şifresi: ');
    if (a.length < 12) { io.print('En az 12 karakter olmalı.'); continue; }
    const b = await io.askHidden('Şifreyi tekrar yaz: ');
    if (a !== b) { io.print('İki şifre aynı değil, yeniden dene.'); continue; }
    try { setPassword(a); io.print('✓ Panel şifresi kaydedildi (data/auth.json).'); return true; } catch (e) { io.print(`Şifre kabul edilmedi: ${e.message}`); }
  }
  return false;
}

async function runSetup({ io, envFile, dataDir, env = process.env, reconfigure = false, setPassword, fetchFn = globalThis.fetch }) {
  const e = effectiveEnv(envFile, env);
  io.print('');
  io.print(reconfigure ? '=== AL-SAT bot ayarlarını yenile ===' : '=== AL-SAT bot ilk kurulum ===');
  if (!reconfigure) io.print('Birkaç soru soracağım. Cevaplar kaydedilir; sonraki açılışlarda tekrar sorulmaz.');
  const result = { password: false, telegram: false };

  const pwNeeded = reconfigure ? await io.askYesNo('Panel şifresi değiştirilsin mi?', false) : (!hasPanelPassword(dataDir) && !e.PANEL_PASSWORD);
  if (pwNeeded) {
    result.password = await setupPassword({ io, setPassword });
    if (!result.password) throw new Error('Panel şifresi ayarlanamadı.');
  }

  const haveTg = e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID;
  const tgNeeded = reconfigure ? await io.askYesNo('Telegram bilgileri yenilensin mi?', !haveTg) : (!haveTg && !e.TELEGRAM_SETUP_SKIPPED);
  if (tgNeeded) {
    const want = reconfigure ? true : await io.askYesNo('Telegram bildirimleri ve komutları kurulsun mu? (Önerilir; BotFather\'dan aldığın token gerekir)', true);
    if (want) result.telegram = await setupTelegram({ io, fetchFn, e, envFile });
    else { upsertEnv(envFile, { TELEGRAM_SETUP_SKIPPED: '1' }); io.print('Telegram atlandı. Sonra kurmak için: npm run setup'); }
  }
  io.print('');
  io.print('Kurulum tamam.');
  return result;
}

function makeTerminalIO(input = process.stdin, output = process.stdout) {
  const print = (s = '') => output.write(String(s) + '\n');
  function ask(q) {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input, output });
      let done = false;
      rl.question(q, (a) => { done = true; rl.close(); resolve(String(a).trim()); });
      rl.on('close', () => { if (!done) reject(new Error('iptal edildi')); });
    });
  }
  function askHidden(q) {
    return new Promise((resolve, reject) => {
      if (!input.isTTY || typeof input.setRawMode !== 'function') { ask(q).then(resolve, reject); return; }
      output.write(q);
      let buf = '';
      let skipEsc = false;
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
      const finish = (err) => {
        input.removeListener('data', onData);
        input.setRawMode(false);
        input.pause();
        output.write('\n');
        err ? reject(err) : resolve(buf);
      };
      function onData(chunk) {
        for (const ch of String(chunk)) {
          if (skipEsc) { if (/[A-Za-z~]/.test(ch)) skipEsc = false; continue; }
          if (ch === '\u001b') { skipEsc = true; continue; }
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
          if (ch === '\u0003') return finish(new Error('iptal edildi'));
          if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
          if (ch >= ' ') buf += ch;
        }
      }
      input.on('data', onData);
    });
  }
  async function askYesNo(q, def = true) {
    for (;;) {
      const a = (await ask(`${q} (${def ? 'E/h' : 'e/H'}) `)).toLowerCase();
      if (!a) return def;
      if (['e', 'evet', 'y', 'yes'].includes(a)) return true;
      if (['h', 'hayır', 'hayir', 'n', 'no'].includes(a)) return false;
      print('Lütfen e veya h yaz.');
    }
  }
  return { print, ask, askHidden, askYesNo };
}

module.exports = { parseEnvText, readEnvFile, upsertEnv, hasPanelPassword, needsSetup, runSetup, makeTerminalIO, TOKEN_RE, CHAT_ID_RE };
