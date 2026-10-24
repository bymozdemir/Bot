'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fr = require('../src/firstRun');

const TOKEN = '123456789:' + 'A'.repeat(35);
const TOKEN2 = '987654321:' + 'B'.repeat(35);

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'firstrun-')); }
function fakeIO({ hidden = [], typed = [], yn = [] } = {}) {
  const out = [];
  const next = (q, name) => { if (!q.length) throw new Error(`beklenmeyen soru (${name})`); return q.shift(); };
  return {
    out,
    print: (s = '') => out.push(String(s)),
    ask: async () => next(typed, 'ask'),
    askHidden: async () => next(hidden, 'askHidden'),
    askYesNo: async () => next(yn, 'askYesNo'),
    left: () => ({ hidden: hidden.length, typed: typed.length, yn: yn.length })
  };
}
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const method = url.split('/').pop().split('?')[0];
    const h = handlers[method];
    if (!h) throw new Error(`istek beklenmiyordu: ${method}`);
    const r = await h(url, calls.filter((c) => c.includes(`/${method}`)).length);
    return { status: r.status || 200, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const okMe = { getMe: async () => ({ body: { ok: true, result: { username: 'afsar_bot' } } }), sendMessage: async () => ({ body: { ok: true } }) };

test('upsertEnv dosyayı 600 izniyle oluşturur, yorumları ve diğer satırları korur', () => {
  const dir = tmp(); const f = path.join(dir, '.env');
  fr.upsertEnv(f, { TELEGRAM_BOT_TOKEN: TOKEN });
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
  fs.appendFileSync(f, '# benim notum\nPORT=8787\n');
  fr.upsertEnv(f, { TELEGRAM_BOT_TOKEN: TOKEN2, TELEGRAM_CHAT_ID: '12345' });
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /# benim notum/);
  assert.match(text, /PORT=8787/);
  assert.equal(text.match(/TELEGRAM_BOT_TOKEN=/g).length, 1);
  assert.match(text, new RegExp(`TELEGRAM_BOT_TOKEN=${TOKEN2}`));
  assert.deepEqual(fr.readEnvFile(f).TELEGRAM_CHAT_ID, '12345');
  fr.upsertEnv(f, { TELEGRAM_CHAT_ID: null });
  assert.equal(fr.readEnvFile(f).TELEGRAM_CHAT_ID, undefined);
  assert.equal(fr.readEnvFile(f).PORT, '8787');
});

test('upsertEnv güvensiz değerleri ve geçersiz anahtarları reddeder', () => {
  const f = path.join(tmp(), '.env');
  assert.throws(() => fr.upsertEnv(f, { A: 'x y' }), /güvenli karakter/);
  assert.throws(() => fr.upsertEnv(f, { A: 'x\nB=1' }), /güvenli karakter/);
  assert.throws(() => fr.upsertEnv(f, { 'A B': '1' }), /Geçersiz ayar adı/);
  assert.equal(fs.existsSync(f), false);
});

test('needsSetup: şifre, Telegram ve atlama işareti', () => {
  const dir = tmp(); const envFile = path.join(dir, '.env'); const dataDir = path.join(dir, 'data');
  assert.equal(fr.needsSetup({ envFile, dataDir, env: {} }), true);
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'auth.json'), '{"algorithm":"scrypt"}\n');
  assert.equal(fr.needsSetup({ envFile, dataDir, env: {} }), true, 'Telegram yok ve atlanmadı');
  fr.upsertEnv(envFile, { TELEGRAM_SETUP_SKIPPED: '1' });
  assert.equal(fr.needsSetup({ envFile, dataDir, env: {} }), false);
  fr.upsertEnv(envFile, { TELEGRAM_SETUP_SKIPPED: null, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '777' });
  assert.equal(fr.needsSetup({ envFile, dataDir, env: {} }), false);
  assert.equal(fr.needsSetup({ envFile, dataDir: path.join(dir, 'yok'), env: {} }), true, 'auth.json yok');
  assert.equal(fr.needsSetup({ envFile, dataDir: path.join(dir, 'yok'), env: { PANEL_PASSWORD: 'x'.repeat(12) } }), false, 'ortam değişkeni ile şifre');
});

test('ilk kurulum: şifre + Telegram (token doğrulanır, chat ID yazılır, test mesajı gider)', async () => {
  const dir = tmp(); const envFile = path.join(dir, '.env');
  const saved = [];
  const io = fakeIO({ hidden: ['uzun-bir-sifre-123', 'uzun-bir-sifre-123', TOKEN], typed: ['424242'], yn: [true] });
  const f = fakeFetch(okMe);
  const r = await fr.runSetup({ io, envFile, dataDir: path.join(dir, 'data'), env: {}, setPassword: (p) => saved.push(p), fetchFn: f });
  assert.deepEqual(saved, ['uzun-bir-sifre-123']);
  assert.deepEqual(r, { password: true, telegram: true });
  const env = fr.readEnvFile(envFile);
  assert.equal(env.TELEGRAM_BOT_TOKEN, TOKEN);
  assert.equal(env.TELEGRAM_CHAT_ID, '424242');
  assert.equal(env.TELEGRAM_SETUP_SKIPPED, undefined);
  assert.ok(f.calls.some((c) => c.includes('/sendMessage?chat_id=424242')));
  assert.ok(io.out.some((l) => l.includes('@afsar_bot')));
  assert.ok(!io.out.join('\n').includes(TOKEN), 'token ekrana basılmamalı');
  assert.deepEqual(io.left(), { hidden: 0, typed: 0, yn: 0 });
});

test('şifre: kısa ve uyuşmayan girişler yeniden sorulur, setPassword hatası yeniden sorar', async () => {
  const dir = tmp();
  const saved = [];
  let n = 0;
  const io = fakeIO({ hidden: ['kisa', 'uzun-sifre-0001', 'farkli-sifre-002', 'uzun-sifre-0003', 'uzun-sifre-0003', 'uzun-sifre-0004', 'uzun-sifre-0004'], yn: [false] });
  const setPassword = (p) => { n++; if (n === 1) throw new Error('reddedildi'); saved.push(p); };
  const r = await fr.runSetup({ io, envFile: path.join(dir, '.env'), dataDir: path.join(dir, 'data'), env: {}, setPassword, fetchFn: fakeFetch({}) });
  assert.equal(r.password, true);
  assert.deepEqual(saved, ['uzun-sifre-0004']);
  assert.ok(io.out.some((l) => /en az 12/i.test(l)));
  assert.ok(io.out.some((l) => /aynı değil/.test(l)));
});

test('şifre 4 denemede de olmazsa kurulum hata verir ve hiçbir şey kaydedilmez', async () => {
  const dir = tmp();
  const io = fakeIO({ hidden: ['a', 'b', 'c', 'd'] });
  await assert.rejects(fr.runSetup({ io, envFile: path.join(dir, '.env'), dataDir: path.join(dir, 'data'), env: {}, setPassword: () => { throw new Error('olmaz'); }, fetchFn: fakeFetch({}) }), /Panel şifresi ayarlanamadı/);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
});

test('Telegram reddedilirse atlama işareti yazılır, tekrar sorulmaz', async () => {
  const dir = tmp(); const envFile = path.join(dir, '.env'); const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'auth.json'), '{"a":1}\n');
  const io = fakeIO({ yn: [false] });
  const r = await fr.runSetup({ io, envFile, dataDir, env: {}, setPassword: () => assert.fail('şifre sorulmamalı'), fetchFn: fakeFetch({}) });
  assert.deepEqual(r, { password: false, telegram: false });
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_SETUP_SKIPPED, '1');
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(fr.needsSetup({ envFile, dataDir, env: {} }), false);
});

test('geçersiz token: biçim hatası ve Telegram reddi; 4 denemeden sonra atlanır', async () => {
  const dir = tmp(); const envFile = path.join(dir, '.env'); const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'auth.json'), '{"a":1}\n');
  const io = fakeIO({ hidden: ['bozuk', '', TOKEN, TOKEN], yn: [true] });
  const f = fakeFetch({ getMe: async () => ({ status: 401, body: { ok: false } }) });
  const r = await fr.runSetup({ io, envFile, dataDir, env: {}, setPassword() {}, fetchFn: f });
  assert.equal(r.telegram, false);
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_SETUP_SKIPPED, '1');
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_BOT_TOKEN, undefined);
  assert.ok(io.out.some((l) => /biçimi hatalı/.test(l)));
  assert.ok(io.out.some((l) => /reddetti/.test(l)));
});

test('ağ yoksa token doğrulanamaz: kullanıcı onaylarsa kaydedilir', async () => {
  const dir = tmp(); const envFile = path.join(dir, '.env'); const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'auth.json'), '{"a":1}\n');
  const io = fakeIO({ hidden: [TOKEN], typed: ['5551234'], yn: [true, true] });
  const f = fakeFetch({ getMe: async () => { throw new Error('ENOTFOUND'); }, sendMessage: async () => { throw new Error('ENOTFOUND'); } });
  const r = await fr.runSetup({ io, envFile, dataDir, env: {}, setPassword() {}, fetchFn: f });
  assert.equal(r.telegram, true);
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_CHAT_ID, '5551234');
  assert.ok(io.out.some((l) => /ulaşılamadı/.test(l)));
});

test('chat ID boş bırakılırsa özel sohbetten otomatik bulunur; grup mesajı yok sayılır; bekleyen mesajlar onaylanır', async () => {
  const dir = tmp(); const envFile = path.join(dir, '.env'); const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'auth.json'), '{"a":1}\n');
  const io = fakeIO({ hidden: [TOKEN], typed: [''], yn: [true, true] });
  const f = fakeFetch({
    ...okMe,
    getUpdates: async (url) => {
      if (url.includes('offset=')) return { body: { ok: true, result: [] } };
      return { body: { ok: true, result: [
        { update_id: 10, message: { chat: { id: -100999, type: 'group' } } },
        { update_id: 11, message: { chat: { id: 31337, type: 'private', first_name: 'Afşar' } } }
      ] } };
    }
  });
  const r = await fr.runSetup({ io, envFile, dataDir, env: {}, setPassword() {}, fetchFn: f });
  assert.equal(r.telegram, true);
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_CHAT_ID, '31337');
  assert.ok(f.calls.some((c) => c.includes('getUpdates?offset=12')), 'bekleyen mesajlar onaylanmalı');
  assert.ok(io.out.some((l) => l.includes('Afşar')));
});

test('webhook varsa (409) otomatik bulma bırakılır ve chat ID elle istenir', async () => {
  const dir = tmp(); const envFile = path.join(dir, '.env'); const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'auth.json'), '{"a":1}\n');
  const io = fakeIO({ hidden: [TOKEN], typed: ['', '999000'], yn: [true, true] });
  const f = fakeFetch({ ...okMe, getUpdates: async () => ({ status: 409, body: { ok: false } }) });
  const r = await fr.runSetup({ io, envFile, dataDir, env: {}, setPassword() {}, fetchFn: f });
  assert.equal(r.telegram, true);
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_CHAT_ID, '999000');
  assert.ok(io.out.some((l) => /webhook/.test(l)));
});

test('kurulu sistemde sorulmaz; reconfigure yalnızca onaylananı değiştirir', async () => {
  const dir = tmp(); const envFile = path.join(dir, '.env'); const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'auth.json'), '{"a":1}\n');
  fr.upsertEnv(envFile, { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '111222' });
  const quiet = fakeIO();
  await fr.runSetup({ io: quiet, envFile, dataDir, env: {}, setPassword: () => assert.fail(), fetchFn: fakeFetch({}) });
  assert.deepEqual(quiet.left(), { hidden: 0, typed: 0, yn: 0 });
  const saved = [];
  const io = fakeIO({ yn: [false, true, true], hidden: [TOKEN2], typed: ['333444'] });
  const r = await fr.runSetup({ io, envFile, dataDir, env: {}, reconfigure: true, setPassword: (p) => saved.push(p), fetchFn: fakeFetch(okMe) });
  assert.deepEqual(saved, [], 'şifre değiştirilmedi');
  assert.equal(r.telegram, true);
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_BOT_TOKEN, TOKEN2);
  assert.equal(fr.readEnvFile(envFile).TELEGRAM_CHAT_ID, '333444');
});

test('PANEL_PASSWORD ortam değişkeni varsa şifre sorulmaz', async () => {
  const dir = tmp();
  const io = fakeIO({ yn: [false] });
  const r = await fr.runSetup({ io, envFile: path.join(dir, '.env'), dataDir: path.join(dir, 'data'), env: { PANEL_PASSWORD: 'x'.repeat(14) }, setPassword: () => assert.fail('sorulmamalı'), fetchFn: fakeFetch({}) });
  assert.equal(r.password, false);
});
