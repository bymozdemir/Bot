const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createNotifier } = require('../src/notify');

function mockServer(handler) {
  return new Promise((resolve) => {
    const reqs = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { reqs.push({ method: req.method, url: req.url, body }); handler(req, res, reqs); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, reqs, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const quiet = { warn() {}, log() {}, error() {} };

test('hic kanal yoksa sessizce hicbir sey yapmaz', async () => {
  const n = createNotifier({ env: {}, logger: quiet });
  assert.deepEqual(n.status(), { telegram: false, termux: false, healthcheck: false });
  assert.deepEqual(await n.send('merhaba'), {});
  assert.equal(await n.ping(), false);
});

test('Telegram: dogru adres, govde ve durum', async (t) => {
  const m = await mockServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
  t.after(() => m.server.close());
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: '42', ALLOW_LOCAL_EXCHANGE_URLS: '1', TELEGRAM_API_BASE: m.base }, logger: quiet });
  assert.equal(n.status().telegram, true);
  const r = await n.send('ALIM BTC');
  assert.equal(r.telegram, true);
  assert.equal(m.reqs[0].method, 'POST');
  assert.equal(m.reqs[0].url, '/bot123:ABC/sendMessage');
  assert.deepEqual(JSON.parse(m.reqs[0].body), { chat_id: '42', text: 'ALIM BTC' });
});

test('Telegram hatasi (HTTP 401) hata firlatmaz, bir kez uyarir, token sizmaz', async (t) => {
  const m = await mockServer((req, res) => { res.statusCode = 401; res.end('{}'); });
  t.after(() => m.server.close());
  const warns = [];
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 'SECRET:TOKEN', TELEGRAM_CHAT_ID: '1', ALLOW_LOCAL_EXCHANGE_URLS: '1', TELEGRAM_API_BASE: m.base }, logger: { warn: (x) => warns.push(x) } });
  assert.equal((await n.send('a')).telegram, false);
  assert.equal((await n.send('b')).telegram, false);
  assert.equal(warns.length, 1, 'ayni kanal icin uyari tekrarlanmamali');
  assert.ok(!warns[0].includes('SECRET:TOKEN'));
});

test('ag yok / sunucu kapali: firlatmaz', async () => {
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', ALLOW_LOCAL_EXCHANGE_URLS: '1', TELEGRAM_API_BASE: 'http://127.0.0.1:1' }, logger: quiet });
  assert.equal((await n.send('x')).telegram, false);
});

test('ayni anahtarli bildirim minIntervalMs icinde tekrarlanmaz', async () => {
  let t = 1000;
  const sent = [];
  const n = createNotifier({ env: { NOTIFY_TERMUX: '1' }, execFn: (cmd, args, opts, cb) => { sent.push(args); cb(null); }, logger: quiet, now: () => t });
  await n.send('kesildi', { key: 'outage', minIntervalMs: 60000 });
  t += 30000;
  assert.equal((await n.send('kesildi', { key: 'outage', minIntervalMs: 60000 })).skipped, true);
  t += 31000;
  await n.send('kesildi', { key: 'outage', minIntervalMs: 60000 });
  assert.equal(sent.length, 2);
});

test('Termux: termux-notification dogru argumanlarla cagrilir; komut yoksa firlatmaz', async () => {
  const calls = [];
  const ok = createNotifier({ env: { NOTIFY_TERMUX: '1' }, execFn: (cmd, args, opts, cb) => { calls.push([cmd, args]); cb(null); }, logger: quiet });
  assert.equal((await ok.send('merhaba', { title: 'BASLIK' })).termux, true);
  assert.deepEqual(calls[0], ['termux-notification', ['--title', 'BASLIK', '--content', 'merhaba']]);
  const missing = createNotifier({ env: { NOTIFY_TERMUX: '1' }, execFn: (c, a, o, cb) => cb(new Error('ENOENT')), logger: quiet });
  assert.equal((await missing.send('x')).termux, false);
});

test('nabiz (healthcheck): GET atar, 30 sn icinde tekrar atmaz', async (t) => {
  const m = await mockServer((req, res) => res.end('OK'));
  t.after(() => m.server.close());
  let now = 0;
  const n = createNotifier({ env: { HEALTHCHECK_URL: m.base + '/ping/abc' }, logger: quiet, now: () => now });
  now = 100000;
  assert.equal(await n.ping(), true);
  now += 10000;
  assert.equal(await n.ping(), false);
  now += 25000;
  assert.equal(await n.ping(), true);
  assert.equal(m.reqs.length, 2);
  assert.equal(m.reqs[0].method, 'GET');
  assert.equal(m.reqs[0].url, '/ping/abc');
});
