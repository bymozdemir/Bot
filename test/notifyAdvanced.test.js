'use strict';
// Bildirim katmani: oncelik/sessiz, yeniden deneme, HTML + duz metin dususu, 4096 bolme, sira, sessiz mod.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, splitMessage, stripTags } = require('../src/notify');

const quiet = { warn() {}, log() {}, error() {} };
const baseEnv = { TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: '42', NOTIFY_MIN_GAP_MS: '0', NOTIFY_RETRY_BASE_MS: '0' };
const noSleep = async () => {};
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const r = await handler(body, calls.length);
    return r || { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  fn.calls = calls;
  return fn;
}
const httpErr = (status, info = {}) => ({ ok: false, status, json: async () => info });

test('varsayilan (normal, duz metin) govde eski sozlesmeyle ayni: yalnizca chat_id + text', async () => {
  const f = fakeFetch(() => null);
  const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: noSleep });
  await n.send('merhaba');
  assert.deepEqual(f.calls[0], { chat_id: '42', text: 'merhaba' });
});

test('quiet oncelik disable_notification=true gonderir; critical sessiz modda da sesli kalir', async () => {
  const f = fakeFetch(() => null);
  const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: noSleep });
  await n.send('rutin', { priority: 'quiet' });
  assert.equal(f.calls[0].disable_notification, true);
  n.mute(60 * 60 * 1000);
  await n.send('normal mesaj');
  await n.send('kritik', { priority: 'critical' });
  assert.equal(f.calls[1].disable_notification, true, 'sessiz modda normal mesaj sessiz iletilir');
  assert.equal(f.calls[2].disable_notification, undefined, 'kritik mesaj sessiz modda da sesli');
  n.unmute();
  await n.send('tekrar normal');
  assert.equal(f.calls[3].disable_notification, undefined);
});

test('sessiz mod suresi dolunca kendiliginden kapanir', async () => {
  let t = 1000;
  const f = fakeFetch(() => null);
  const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: noSleep, now: () => t });
  n.mute(10 * 60 * 1000);
  assert.equal(n.isMuted(), true);
  assert.equal(n.detail().muted, true);
  t += 11 * 60 * 1000;
  assert.equal(n.isMuted(), false);
  assert.equal(n.detail().mutedUntil, null);
});

test('html=true parse_mode HTML ile gider; Telegram etiketi reddederse etiketsiz duz metne duser', async () => {
  const f = fakeFetch((body) => (body.parse_mode ? httpErr(400, { description: "Bad Request: can't parse entities in message text" }) : null));
  const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: noSleep });
  const r = await n.send('<b>ALIM</b> BTC &amp; ETH', { html: true });
  assert.equal(r.telegram, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].parse_mode, 'HTML');
  assert.equal(f.calls[1].parse_mode, undefined);
  assert.equal(f.calls[1].text, 'ALIM BTC & ETH');
});

test('429 retry_after ve ag hatasinda kritik mesaj yeniden denenir; 401 gibi kalici hatada denenmez', async () => {
  let n429 = 0;
  const f = fakeFetch(() => (++n429 < 3 ? httpErr(429, { parameters: { retry_after: 1 } }) : null));
  const sleeps = [];
  const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: async (ms) => { sleeps.push(ms); } });
  const r = await n.send('kritik', { priority: 'critical' });
  assert.equal(r.telegram, true);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(sleeps.slice(0, 2), [1000, 1000], 'retry_after saniyesi kadar beklenir');

  const f2 = fakeFetch(() => httpErr(401, {}));
  const n2 = createNotifier({ env: baseEnv, fetchFn: f2, logger: quiet, sleep: noSleep });
  assert.equal((await n2.send('x', { priority: 'critical' })).telegram, false);
  assert.equal(f2.calls.length, 1, 'yetki hatasi tekrar denenmez');
});

test('rutin (quiet) mesaj tek deneme, normal 2 deneme, kritik 4 deneme yapar', async () => {
  const make = () => fakeFetch(() => httpErr(500, {}));
  for (const [prio, expected] of [['quiet', 1], ['normal', 2], ['critical', 4]]) {
    const f = make();
    const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: noSleep });
    assert.equal((await n.send('x', { priority: prio })).telegram, false);
    assert.equal(f.calls.length, expected, prio);
  }
});

test('4096 sinirini asan mesaj satir sinirindan bolunur ve sirayla gider', async () => {
  const f = fakeFetch(() => null);
  const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: noSleep });
  const long = Array.from({ length: 300 }, (_, i) => `satir ${i} ${'x'.repeat(30)}`).join('\n');
  await n.send(long);
  assert.ok(f.calls.length >= 3);
  for (const c of f.calls) assert.ok(c.text.length <= 4010, `parca cok uzun: ${c.text.length}`);
  assert.match(f.calls[0].text, /^\(1\/\d+\) satir 0 /);
  const rejoined = f.calls.map((c) => c.text.replace(/^\(\d+\/\d+\) /, '')).join('\n');
  assert.equal(rejoined, long);
});

test('splitMessage: tek asiri uzun satir sert bolunur; kisa metin oldugu gibi kalir; stripTags etiketleri temizler', () => {
  assert.deepEqual(splitMessage('kisa'), ['kisa']);
  const parts = splitMessage('a'.repeat(9000));
  assert.equal(parts.length, 3);
  assert.equal(parts.join('').length, 9000);
  assert.equal(stripTags('<b>x</b> &lt;y&gt; <code>z</code>'), 'x <y> z');
});

test('mesajlar gonderilme sirasini korur; kritik mesaj kuyrukta rutinlerin onune gecer', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  const f = fakeFetch(async (body) => { if (first) { first = false; await gate; } order.push(body.text); return null; });
  const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: noSleep });
  const p1 = n.send('A');
  const p2 = n.send('B');
  const p3 = n.send('C');
  const p4 = n.send('KRITIK', { priority: 'critical' });
  release();
  await Promise.all([p1, p2, p3, p4]);
  assert.deepEqual(order, ['A', 'KRITIK', 'B', 'C']);
});

test('kanal sagligi: basarisizlik sayilir, basari sifirlar; token detail ciktisinda sizmaz', async () => {
  let fail = true;
  const f = fakeFetch(() => (fail ? httpErr(500, {}) : null));
  const n = createNotifier({ env: { ...baseEnv, TELEGRAM_BOT_TOKEN: 'SECRET:TOKEN' }, fetchFn: f, logger: quiet, sleep: noSleep });
  await n.send('a', { priority: 'quiet' });
  await n.send('b', { priority: 'quiet' });
  assert.equal(n.detail().channels.telegram.failures, 2);
  assert.ok(!JSON.stringify(n.detail()).includes('SECRET:TOKEN'));
  fail = false;
  await n.send('c', { priority: 'quiet' });
  assert.equal(n.detail().channels.telegram.failures, 0);
  assert.ok(n.detail().channels.telegram.lastOkAt > 0);
  assert.equal(n.detail().queued, 0);
});

test('farkli olay anahtarli mesajlar elenmez; anahtar tablosu sismez', async () => {
  let t = 0;
  const f = fakeFetch(() => null);
  const n = createNotifier({ env: baseEnv, fetchFn: f, logger: quiet, sleep: noSleep, now: () => t });
  for (let i = 0; i < 300; i++) { t += 1000; await n.send(`m${i}`, { key: `live-buy:BTC/USDT:${i}`, minIntervalMs: 60000, priority: 'quiet' }); }
  assert.equal(f.calls.length, 300, 'her farkli anahtar ayri mesajdir');
  t += 2 * 3600 * 1000;
  await n.send('son', { key: 'k-son', minIntervalMs: 60000, priority: 'quiet' });
  assert.equal((await n.send('son', { key: 'k-son', minIntervalMs: 60000 })).skipped, true);
});

test('Termux: HTML mesaj etiketsiz metin olarak gosterilir', async () => {
  const calls = [];
  const n = createNotifier({ env: { NOTIFY_TERMUX: '1' }, execFn: (c, a, o, cb) => { calls.push(a); cb(null); }, logger: quiet });
  await n.send('🟢 <b>ALIM BTC/USDT</b> &amp; x', { html: true, title: 'T' });
  assert.deepEqual(calls[0], ['--title', 'T', '--content', '🟢 ALIM BTC/USDT & x']);
});
