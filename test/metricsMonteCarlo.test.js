const test = require('node:test');
const assert = require('node:assert/strict');
const { equityMetrics, tradeMetrics, monteCarlo, significance, mulberry32 } = require('../src/backtest/metrics');

test('mulberry32 tohumlu ve tekrarlanabilir', () => {
  const a = mulberry32(5), b = mulberry32(5);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('equityMetrics: duz egri icin Sharpe yok, yukselen egri icin pozitif', () => {
  assert.equal(equityMetrics(Array(50).fill(1000)).sharpe, null);
  const up = Array.from({ length: 400 }, (_, i) => 1000 * (1 + 0.001 * i + (i % 2 ? 0.0004 : -0.0004)));
  const m = equityMetrics(up, { barsPerYear: 8760 });
  assert.ok(m.sharpe > 0 && m.sortino === null || m.sortino > 0);
  assert.ok(m.ulcerIndex >= 0);
});

test('equityMetrics: cok kisa pencerede CAGR/Calmar yillandirilmaz (null)', () => {
  const m = equityMetrics([1000, 1010, 1005, 1020, 1015, 1040], { barsPerYear: 8760 });
  assert.equal(m.cagrPct, null);
  assert.equal(m.calmar, null);
});

test('tradeMetrics: beklenti, payoff ve ust uste kayip serisi', () => {
  const m = tradeMetrics([{ pnlPct: 2 }, { pnlPct: -1 }, { pnlPct: -1 }, { pnlPct: -1 }, { pnlPct: 4 }]);
  assert.equal(m.count, 5);
  assert.equal(m.maxConsecutiveLosses, 3);
  assert.ok(Math.abs(m.expectancyPct - 0.6) < 1e-9);
  assert.ok(Math.abs(m.payoffRatio - 3) < 1e-9);
});

test('monteCarlo: ayni tohum ayni sonuc; az islemde acik hata', () => {
  const t = [2, -1, 3, -1.5, 1, 2, -0.5, 4, -2, 1.5];
  assert.deepEqual(monteCarlo(t, { runs: 200, seed: 9 }), monteCarlo(t, { runs: 200, seed: 9 }));
  const bad = monteCarlo([1, 2], {});
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /en az 5/);
});

test('monteCarlo: tamamen kazandiran islemler zarar olasiligi 0', () => {
  const r = monteCarlo(Array(20).fill(1), { runs: 300 });
  assert.equal(r.probLossPct, 0);
  assert.ok(r.returnPct.p5 > 0);
});

test('significance: net pozitif ornek anlamli, sifir ortalamali ornek anlamsiz', () => {
  const good = significance(Array.from({ length: 40 }, (_, i) => 1 + (i % 3) * 0.2), { runs: 2000 });
  assert.equal(good.ok, true);
  assert.ok(good.pValue < 0.05);
  const noise = significance(Array.from({ length: 40 }, (_, i) => (i % 2 ? 1 : -1)), { runs: 2000 });
  assert.ok(noise.pValue > 0.05);
  assert.equal(significance([1, 2, 3], {}).ok, false);
});
