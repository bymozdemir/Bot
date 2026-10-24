'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier } = require('../src/notify');

function mk(envExtra = {}) {
  let t = 1_000_000; const calls = [];
  const fetchFn = async (url, o) => { calls.push({ at: t, text: JSON.parse(o.body).text }); t += 300; return { ok: true }; };   // her istek 300 ms sürer
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', ...envExtra }, fetchFn, logger: { warn() {}, log() {} }, now: () => t, sleep: async (ms) => { t += ms; } });
  return { n, calls };
}

test('bildirim kuyruğu: varsayılan olarak mesajlar arası en az 5 sn (art arda üç alım)', async () => {
  const { n, calls } = mk();
  await Promise.all(['XRP', 'DOGE', 'SOL'].map((c, i) => n.send(`ALIM ${c}`, { key: `live-buy:${c}:${i}`, minIntervalMs: 60000 })));
  assert.equal(calls.length, 3, 'üç mesaj da gönderilmeli');
  for (let i = 1; i < calls.length; i++) {
    const gapSinceEnd = calls[i].at - (calls[i - 1].at + 300);
    assert.ok(gapSinceEnd >= 5000 - 1, `mesaj ${i} ile önceki arası ${gapSinceEnd} ms (en az 5000 beklenir)`);
  }
});

test('bildirim kuyruğu: NOTIFY_MIN_GAP_MS ile değiştirilebilir', async () => {
  const { n, calls } = mk({ NOTIFY_MIN_GAP_MS: '1000' });
  await Promise.all(['A', 'B'].map((c, i) => n.send(`M ${c}`, { key: `k${i}`, minIntervalMs: 60000 })));
  const gapSinceEnd = calls[1].at - (calls[0].at + 300);
  assert.ok(gapSinceEnd >= 999 && gapSinceEnd < 5000, `aralık ${gapSinceEnd}`);
});


test('bildirim kuyruğu: aynı anda oluşan beş alımın tamamı sırayla gönderilir', async () => {
  const { n, calls } = mk();
  const symbols = ['BCH', 'NEAR', 'BTC', 'ETH', 'AVAX'];
  const results = await Promise.all(symbols.map((s) => n.send(`ALIM ${s}/USDT`, { durable: true, html: true })));
  assert.equal(calls.length, 5, 'beş alım bildiriminin tümü gönderilmeli');
  assert.deepEqual(calls.map((c) => c.text), symbols.map((s) => `ALIM ${s}/USDT`));
  assert.ok(results.every((r) => r.telegram === true));
});
