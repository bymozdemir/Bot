const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchKlinesRange, loadCandles, INTERVAL_MS, WARMUP_CANDLES, monthsToMs } = require('../src/backtest/data');

const STEP = INTERVAL_MS['1h'];

// Binance klines davranisini taklit eden sahte fetch: startTime dahil, endTime (acilis zamani) dahil, limit ust sinir.
function fakeBinance(series, { calls } = {}) {
  return async (url) => {
    const u = new URL(url);
    if (calls) calls.push(url);
    const start = Number(u.searchParams.get('startTime'));
    const end = Number(u.searchParams.get('endTime'));
    const limit = Number(u.searchParams.get('limit'));
    assert.equal(u.pathname, '/api/v3/klines');
    assert.match(u.searchParams.get('symbol'), /^[A-Z0-9]+$/); // BTC/USDT -> BTCUSDT
    const rows = series.filter((k) => k[0] >= start && k[0] <= end).slice(0, limit);
    return { ok: true, status: 200, json: async () => rows, text: async () => '' };
  };
}
const series = (n, endOpen, step = STEP) => Array.from({ length: n }, (_, i) => {
  const t = endOpen - (n - 1 - i) * step;
  const p = 100 + (i % 50);
  return [t, String(p), String(p + 2), String(p - 2), String(p + 1), '10', t + step - 1];
});
const NOW = Date.UTC(2026, 8, 30, 12, 30); // 12:30 -> 12:00 mumu henuz kapanmadi
const LAST_CLOSED_OPEN = Date.UTC(2026, 8, 30, 11, 0);

test('sayfalama: 2500 mum 3 istekte gelir, siralı, tekrarsiz, bosluksuz', async () => {
  const calls = [];
  const s = series(2500, LAST_CLOSED_OPEN);
  const r = await fetchKlinesRange({ symbol: 'BTC/USDT', interval: '1h', startMs: s[0][0], endMs: NOW, fetchFn: fakeBinance(s, { calls }), pauseMs: 0, nowMs: NOW });
  assert.equal(r.candles.length, 2500);
  assert.equal(calls.length, 3);
  assert.equal(r.gaps, 0);
  assert.ok(r.candles.every((c, i) => i === 0 || c.t === r.candles[i - 1].t + STEP));
  assert.deepEqual(Object.keys(r.candles[0]), ['t', 'o', 'h', 'l', 'c', 'v']);
  assert.equal(r.candles[0].o, 100);
});

test('tam 1000\'in kati mum sayisinda sonsuz dongu/eksik veri olmaz', async () => {
  const s = series(2000, LAST_CLOSED_OPEN);
  const r = await fetchKlinesRange({ symbol: 'ETH/USDT', interval: '1h', startMs: s[0][0], endMs: NOW, fetchFn: fakeBinance(s), pauseMs: 0, nowMs: NOW });
  assert.equal(r.candles.length, 2000);
});

test('henuz KAPANMAMIS mum veriye girmez', async () => {
  const s = series(50, Date.UTC(2026, 8, 30, 12, 0)); // son mum 12:00, kapanis 12:59 > simdi (12:30)
  const r = await fetchKlinesRange({ symbol: 'BTC/USDT', interval: '1h', startMs: s[0][0], endMs: NOW, fetchFn: fakeBinance(s), pauseMs: 0, nowMs: NOW });
  assert.equal(r.candles.length, 49);
  assert.equal(r.candles.at(-1).t, LAST_CLOSED_OPEN);
});

test('veri boslugu sayilir', async () => {
  const s = series(100, LAST_CLOSED_OPEN);
  s.splice(40, 1);
  const r = await fetchKlinesRange({ symbol: 'BTC/USDT', interval: '1h', startMs: s[0][0], endMs: NOW, fetchFn: fakeBinance(s), pauseMs: 0, nowMs: NOW });
  assert.equal(r.gaps, 1);
});

test('HTTP hatasi (451 bolge engeli gibi) anlasilir hata verir', async () => {
  const fetchFn = async () => ({ ok: false, status: 451, text: async () => 'Service unavailable from a restricted location' });
  await assert.rejects(() => fetchKlinesRange({ symbol: 'BTC/USDT', interval: '1h', startMs: NOW - 10 * STEP, endMs: NOW, fetchFn, pauseMs: 0, nowMs: NOW }), /451/);
});

test('desteklenmeyen mum araligi reddedilir', async () => {
  await assert.rejects(() => fetchKlinesRange({ symbol: 'BTC/USDT', interval: '7m', startMs: 0, endMs: 1, pauseMs: 0 }), /Desteklenmeyen/);
});

test('loadCandles: pencere/isinma ayrimi, onbellek ve --refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const months = 1;
  const windowStart = NOW - monthsToMs(months);
  const s = series(1700, LAST_CLOSED_OPEN);
  const calls = [];
  const args = { symbol: 'BTC/USDT', interval: '1h', months, cacheDir: dir, nowMs: NOW, fetchFn: fakeBinance(s, { calls }), pauseMs: 0 };

  const a = await loadCandles(args);
  assert.equal(a.fromCache, false);
  assert.ok(a.candles[a.startIndex].t >= windowStart);
  assert.ok(a.candles[a.startIndex - 1].t < windowStart);
  assert.ok(a.startIndex >= WARMUP_CANDLES - 1, `isinma mumu yetersiz: ${a.startIndex}`);
  const firstCalls = calls.length;
  assert.ok(firstCalls >= 1);

  const b = await loadCandles(args); // ayni gun: internete cikmamali
  assert.equal(b.fromCache, true);
  assert.equal(calls.length, firstCalls);
  assert.deepEqual(b.candles, a.candles);

  const c = await loadCandles({ ...args, refresh: true });
  assert.equal(c.fromCache, false);
  assert.ok(calls.length > firstCalls);

  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{bozuk'); // bozuk onbellek -> yeniden indirilir
  const d = await loadCandles(args);
  assert.equal(d.fromCache, false);
});

test('1 gunluk mum araligi desteklenir: sayfalama dogru adimla ilerler', async () => {
  const DAY = INTERVAL_MS['1d'];
  assert.equal(DAY, 86400000);
  const s = series(1200, LAST_CLOSED_OPEN - 35 * STEP, DAY); // gunluk mumlar; son mum 29 Eylul 00:00 (kapanmis), 30 Eylul mumu hala olusuyor
  const r = await fetchKlinesRange({ symbol: 'BTC/USDT', interval: '1d', startMs: s[0][0], endMs: NOW, fetchFn: fakeBinance(s), pauseMs: 0, nowMs: NOW });
  assert.equal(r.candles.length, 1200);
  assert.equal(r.gaps, 0);
  assert.equal(r.candles[1].t - r.candles[0].t, DAY);
});
