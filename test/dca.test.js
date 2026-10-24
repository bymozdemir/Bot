const test = require('node:test');
const assert = require('node:assert/strict');
const { runDca } = require('../src/backtest/dca');
const { runBacktest } = require('../src/backtest/simulator');
const { aggregate, formatSummary } = require('../src/backtest/report');
const { evaluateCriteria } = require('../src/backtest/criteria');

const D = 86400000;
const C = (i, o, c, step = D) => ({ t: i * step, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 });
const daily = (closes) => closes.map((c, i) => C(i, i === 0 ? c : closes[i - 1], c));
const flat = (n, p) => daily(Array.from({ length: n }, () => p));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ZERO = { feePct: 0, slippagePct: 0, capital: 1000 };

test('DCA: sermaye esit parcalara bolunur, duzenli aralikla alinir, tamamen yatirilir', () => {
  const r = runDca({ candles: flat(20, 100), intervalDays: 7, ...ZERO });
  assert.equal(r.trades, 2); // 20 mum / 7 = 2 alim
  assert.deepEqual(r.tradeList.map((p) => p.amount), [500, 500]);
  assert.equal(r.tradeList[1].t - r.tradeList[0].t, 7 * D);
  near(r.finalEquity, 1000); // sabit fiyat, maliyetsiz: sermaye korunur
  near(r.returnPct, 0);
});

test('DCA: tek alimlik pencerede al-tut ile AYNI sonuc (ayni maliyet modeli)', () => {
  const candles = daily([100, 104, 99, 110, 120]);
  const r = runDca({ candles, intervalDays: 90, capital: 1000, feePct: 0.1, slippagePct: 0.05 });
  assert.equal(r.trades, 1);
  near(r.returnPct, r.buyHoldPct, 1e-9);
  near(r.maxDrawdownPct, r.buyHoldMaxDrawdownPct, 1e-9);
});

test('DCA: yukselen piyasada al-tut\'un gerisinde, dusen piyasada onun onunde (az kaybeder)', () => {
  const up = daily(Array.from({ length: 140 }, (_, i) => 100 * Math.exp(i * 0.01)));
  const down = daily(Array.from({ length: 140 }, (_, i) => 100 * Math.exp(-i * 0.01)));
  const a = runDca({ candles: up, intervalDays: 7, ...ZERO });
  assert.ok(a.returnPct > 0 && a.returnPct < a.buyHoldPct, `yukselis: dca ${a.returnPct} al-tut ${a.buyHoldPct}`);
  const b = runDca({ candles: down, intervalDays: 7, ...ZERO });
  assert.ok(b.returnPct < 0 && b.returnPct > b.buyHoldPct, `dusus: dca ${b.returnPct} al-tut ${b.buyHoldPct}`);
  assert.ok(Math.abs(b.maxDrawdownPct) < Math.abs(b.buyHoldMaxDrawdownPct));
});

test('DCA: komisyon ve kayma odenir (maliyet artinca getiri duser) ve ortalama maruziyet %100\'un altinda', () => {
  const up = daily(Array.from({ length: 100 }, (_, i) => 100 * Math.exp(i * 0.005)));
  const free = runDca({ candles: up, intervalDays: 7, ...ZERO });
  const paid = runDca({ candles: up, intervalDays: 7, capital: 1000, feePct: 0.1, slippagePct: 0.05 });
  assert.ok(paid.returnPct < free.returnPct);
  assert.ok(paid.feesPct > 0 && paid.slippagePct > 0);
  assert.ok(paid.exposurePct > 20 && paid.exposurePct < 100, `maruziyet ${paid.exposurePct}`);
});

test('DCA: metrikler tutarli (yarilar, sonlu degerler) ve 4 saatlik mumda hafta = 42 mum', () => {
  const H4 = 4 * 3600000;
  const candles = Array.from({ length: 600 }, (_, i) => C(i, 100 + i * 0.1, 100 + (i + 1) * 0.1, H4));
  const r = runDca({ candles, startIndex: 100, intervalDays: 7, capital: 1000, feePct: 0.1, slippagePct: 0.05 });
  assert.equal(r.tradeList[1].t - r.tradeList[0].t, 42 * H4);
  assert.equal(r.trades, Math.floor(500 / 42));
  for (const k of ['returnPct', 'buyHoldPct', 'maxDrawdownPct', 'firstHalfPct', 'secondHalfPct', 'exposurePct', 'finalEquity']) assert.ok(Number.isFinite(r[k]), k);
  near((1 + r.firstHalfPct / 100) * (1 + r.secondHalfPct / 100), 1 + r.returnPct / 100, 1e-9);
  assert.equal(r.startT, candles[100].t);
});

test('DCA: gecersiz girdiler anlasilir hata verir', () => {
  assert.throws(() => runDca({ candles: [], ...ZERO }), /yeterli mum/);
  assert.throws(() => runDca({ candles: flat(10, 100), intervalDays: 0, ...ZERO }), /pozitif/);
});

test('DCA: raporda "DCA haftalık" olarak al-tut yaninda gorunur, kabul olcutlerinden gecer', () => {
  const candles = daily(Array.from({ length: 800 }, (_, i) => 100 * Math.exp(Math.sin(i / 60) * 0.3 + i * 0.001)));
  const rows = ['SOL/USDT', 'ETH/USDT'].map((symbol) => ({ timeframe: '1d', symbol, strategyId: 'dca_weekly', ...runDca({ candles, startIndex: 400, intervalDays: 7 }) }));
  const text = formatSummary({ startT: 0, endT: 700 * D, days: 700, capital: 1000, feePct: 0.1, slippagePct: 0.05, symbols: ['SOL/USDT', 'ETH/USDT'], gaps: 0 }, aggregate(rows));
  assert.match(text, /DCA haftalık/);
  assert.match(text, /al-tut/);
  const e = evaluateCriteria(rows);
  assert.ok(e['1d'].dca_weekly.k.K3, 'haftalik alim sayisi 50 esigini gecmeli (400 gun / 7 = 57)');
});
