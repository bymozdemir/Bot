const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { evaluateCriteria, CRITERIA_VERSION, REQUIRED_MONTHS } = require('../src/backtest/criteria');
const { formatSensitivity, formatCriteria } = require('../src/backtest/report');
const { runBacktest } = require('../src/backtest/simulator');

const tf = strategies.get('trend_filter');
const H = 3600000;
const mk = (closes) => closes.map((c, i) => ({ t: i * H, o: c, h: c, l: c, c, v: 1 }));
const P = { ...tf.defaultParams, period: 20, bufferPct: 1 };
const pos = (over = {}) => ({ entryPrice: 100, stopPrice: 85, highWaterMark: 100, ...over });

test('trend_filter: tek varyant varsayilanlari sabit (SMA200, tampon %1, stop %8)', () => {
  assert.deepEqual(tf.defaultParams, { period: 200, bufferPct: 1, stopLossPct: 8, takeProfitPct: 0, trailingStop: false });
  assert.equal(strategies.validateParams('trend_filter', tf.defaultParams), null);
});

test('trend_filter: ust bandin ustunde AL, band icinde BEKLE', () => {
  const base = Array.from({ length: 25 }, () => 100);
  assert.equal(tf.evaluate({ candles: mk([...base, 102]), position: null, params: P }).action, 'buy'); // 100*1.01 = 101 < 102
  const inside = tf.evaluate({ candles: mk([...base, 100.5]), position: null, params: P });
  assert.equal(inside.action, 'hold');
  assert.match(inside.reason, /nakitte bekle/);
});

test('trend_filter: pozisyonda alt bandin altinda SAT, bandin icinde TUT (tampon gereksiz satisi onler)', () => {
  const base = Array.from({ length: 25 }, () => 100);
  assert.equal(tf.evaluate({ candles: mk([...base, 98]), position: pos(), params: P }).action, 'sell');
  assert.equal(tf.evaluate({ candles: mk([...base, 99.5]), position: pos(), params: P }).action, 'hold');
});

test('trend_filter: veri yetersizken bile genis stop-loss calisir; pozisyonsuz hold doner', () => {
  assert.equal(tf.evaluate({ candles: mk([100, 100, 80]), position: pos(), params: P }).reason, 'stop-loss tetiklendi');
  assert.equal(tf.evaluate({ candles: mk([100, 100]), position: null, params: P }).action, 'hold');
});

test('trend_filter: parametre dogrulamasi', () => {
  assert.match(strategies.validateParams('trend_filter', { ...tf.defaultParams, period: 5 }), /en az/);
  assert.match(strategies.validateParams('trend_filter', { ...tf.defaultParams, bufferPct: 50 }), /en çok/);
});

test('trend_filter: dusen piyasada nakde gecer, kayip al-tut\'tan cok daha az (simulasyon)', () => {
  // 300 mum yukselis, sonra 300 mum sert dusus
  const up = Array.from({ length: 300 }, (_, i) => 100 * Math.exp(i * 0.004));
  const peak = up[up.length - 1];
  const down = Array.from({ length: 300 }, (_, i) => peak * Math.exp(-(i + 1) * 0.006));
  const candles = mk([...up, ...down]);
  const r = runBacktest({ candles, startIndex: 250, strategy: tf, params: P, feePct: 0.1, slippagePct: 0.05 });
  assert.ok(r.maxDrawdownPct > r.buyHoldMaxDrawdownPct / 2, `strateji dususu ${r.maxDrawdownPct} al-tut ${r.buyHoldMaxDrawdownPct}`);
  assert.ok(r.returnPct > r.buyHoldPct, 'duseni atlatinca al-tut\'u geride birakmali');
  assert.ok(r.trades >= 1 && r.trades < 10, `islem ${r.trades}`);
});

// ---- Kriterler ----
function rows(tfName, id, spec) { // spec: [{ret, bh, dd, bhdd, h1, h2, trades}, ...5 parite]
  return spec.map((s, i) => ({ timeframe: tfName, symbol: `P${i}/USDT`, strategyId: id, returnPct: s.ret, buyHoldPct: s.bh, maxDrawdownPct: s.dd, buyHoldMaxDrawdownPct: s.bhdd, firstHalfPct: s.h1, secondHalfPct: s.h2, trades: s.trades }));
}
const five = (over = {}) => Array.from({ length: 5 }, () => ({ ret: 10, bh: 30, dd: -20, bhdd: -60, h1: 4, h2: 5, trades: 12, ...over }));

test('kriterler sabit ve surumlu', () => {
  assert.equal(CRITERIA_VERSION, 1);
  assert.equal(REQUIRED_MONTHS, 24);
});

test('G seti: K1+K2+K3+K4 saglanirsa ADAY G', () => {
  const e = evaluateCriteria(rows('4h', 'x', five({ trades: 12 })).concat([])); // 60 islem toplam
  assert.deepEqual(e['4h'].x.k, { K1: true, K2: true, K3: true, K4: true, K5: false, K6: true });
  assert.equal(e['4h'].x.G, true);
  assert.equal(e['4h'].x.R, false); // K5: getiri 10 < 30*0.5
});

test('K1: pozitif parite sayisi 5te 3 sinirda gecer, 2de kalir', () => {
  const spec = (n) => five().map((s, i) => ({ ...s, ret: i < n ? 5 : -5 }));
  assert.equal(evaluateCriteria(rows('4h', 'x', spec(3)))['4h'].x.k.K1, true);
  assert.equal(evaluateCriteria(rows('4h', 'x', spec(2)))['4h'].x.k.K1, false);
});

test('K2: bir yarim negatifse gecmez (sinirda sifir da gecmez)', () => {
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ h1: -1, h2: 9 })))['4h'].x.k.K2, false);
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ h1: 0, h2: 9 })))['4h'].x.k.K2, false);
});

test('K3/K6: islem sayisi esikleri 50 ve 10', () => {
  assert.deepEqual([evaluateCriteria(rows('4h', 'x', five({ trades: 9 })))['4h'].x.k.K3, evaluateCriteria(rows('4h', 'x', five({ trades: 9 })))['4h'].x.k.K6], [false, true]); // 45 toplam
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ trades: 10 })))['4h'].x.k.K3, true); // 50 toplam
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ trades: 1 })))['4h'].x.k.K6, false); // 5 toplam
});

test('K4: dusus al-tut\'un tam yarisinda gecer, biraz fazlasinda gecmez', () => {
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ dd: -30, bhdd: -60 })))['4h'].x.k.K4, true);
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ dd: -30.1, bhdd: -60 })))['4h'].x.k.K4, false);
});

test('K5: al-tut pozitifken yarisi, negatifken al-tut\'un kendisi', () => {
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ ret: 15, bh: 30 })))['4h'].x.k.K5, true);
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ ret: 14.9, bh: 30 })))['4h'].x.k.K5, false);
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ ret: -10, bh: -44 })))['4h'].x.k.K5, true); // nakitte kalan zarari azaltti
  assert.equal(evaluateCriteria(rows('4h', 'x', five({ ret: -50, bh: -44 })))['4h'].x.k.K5, false);
});

test('R seti: risk azaltici strateji (az islem, buyuk dususten kacinma) ADAY R olur', () => {
  const e = evaluateCriteria(rows('1d', 't', five({ ret: 20, bh: 30, dd: -15, bhdd: -60, trades: 4 }))); // 20 islem
  assert.equal(e['1d'].t.G, false); // K3: 20 < 50
  assert.equal(e['1d'].t.R, true);
  assert.equal(e['1d'].t.candidate, true);
});

test('hicbir ADAY yoksa rapor bunu acikca soyler; aralik/strateji bazinda ayri degerlendirilir', () => {
  const bad = rows('1h', 'bad', five({ ret: -30, bh: 25, dd: -60, bhdd: -70, trades: 600 })).concat(rows('4h', 'bad', five({ ret: -30, bh: 25, dd: -60, bhdd: -70, trades: 600 })));
  const e = evaluateCriteria(bad);
  assert.deepEqual(Object.keys(e), ['1h', '4h']);
  const text = formatCriteria(e, 24, 1, 24);
  assert.match(text, /ADAY YOK/);
  assert.match(text, /KABUL ÖLÇÜTLERİ \(sürüm 1, 24 ay\)/);
  assert.ok(!/Not: ölçütler/.test(text));
  assert.match(formatCriteria(e, 12, 1, 24), /Not: ölçütler 24 aylık/);
  for (const line of text.split('\n')) assert.ok(line.length <= 46, `satir uzun (${line.length}): ${line}`);
});

test('aday varsa rapor adini ve araligini listeler', () => {
  const e = evaluateCriteria(rows('1d', 'trend_filter', five({ ret: 20, bh: 30, dd: -15, bhdd: -60, trades: 4 })));
  const text = formatCriteria(e, 24, 1, 24);
  assert.match(text, /ADAY: Trend \(SMA\) 1d/);
  assert.match(text, /ŞANS UYARISI: 1 kombinasyon denendi/);
  assert.match(text, /ADAY R/);
});

test('maliyet duyarliligi tablosu: brut sutunu, al-tut satiri, dar ekran', () => {
  const scenarios = [{ label: 'brüt', feePct: 0, slippagePct: 0 }, { label: 'düşük', feePct: 0.075, slippagePct: 0.02 }, { label: 'vars.', feePct: 0.1, slippagePct: 0.05 }, { label: 'yüksek', feePct: 0.2, slippagePct: 0.1 }];
  const results = rows('4h', 'ema_cross', five()).map((r) => ({ ...r, sens: [{ returnPct: 12, buyHoldPct: 31 }, { returnPct: 11, buyHoldPct: 30.5 }, { returnPct: 10, buyHoldPct: 30 }, { returnPct: 8, buyHoldPct: 29 }] }));
  const text = formatSensitivity(results, scenarios);
  assert.match(text, /MALİYET DUYARLILIĞI/);
  assert.match(text, /brüt/);
  assert.match(text, /EMA kesişimi\s+\+12\.0%\s+\+11\.0%\s+\+10\.0%\s+\+8\.0%/);
  assert.ok(!/%\+/.test(text), 'sutunlar birbirine yapismamali');
  assert.match(text, /al-tut\s+\+31\.0%/);
  for (const line of text.split('\n')) assert.ok(line.length <= 46, `satir uzun (${line.length}): ${line}`);
});
