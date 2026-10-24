const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateCommissions, addExecutionCommission } = require('../src/financial');
const { runPortfolioBacktest } = require('../src/backtest/portfolioSimulator');

const C = (i, o, h = o, l = o, c = o) => ({ t: i * 60000, o, h, l, c, v: 1 });

test('commissionTotal tek varlikta miktardir; birden fazla varlikta yaniltici toplama yapmaz', () => {
  const one = aggregateCommissions([{ commission: 0.001, commissionAsset: 'BTC' }]);
  assert.equal(one.total, 0.001);
  const multi = aggregateCommissions([
    { commission: 0.001, commissionAsset: 'BTC' },
    { commission: 0.25, commissionAsset: 'USDT' }
  ]);
  assert.equal(multi.total, null);
  assert.deepEqual(multi.byAsset, { BTC: 0.001, USDT: 0.25 });
  const incremental = addExecutionCommission({ total: 0.001, byAsset: { BTC: 0.001 } }, 'USDT', 0.25);
  assert.equal(incremental.total, null);
  assert.deepEqual(incremental.byAsset, { BTC: 0.001, USDT: 0.25 });
});

test('portfoy al-tut karsilastirmasi komisyon ve kaymayi stratejiyle ayni esasla uygular', () => {
  const candles = [C(0, 100), C(1, 110), C(2, 120)];
  const strategy = { id: 'hold-test', defaultParams: {}, minCandles: () => 999, evaluate: () => ({ action: 'hold' }) };
  const r = runPortfolioBacktest({
    datasets: { 'BTC/USDT': { candles } }, symbols: ['BTC/USDT'], startIndex: 0, endIndex: 2,
    strategy, capital: 1000, feePct: 0.1, slippagePct: 0.05, reserveCashPct: 0,
    maxConcurrentPositions: 1, budgetPct: 100
  });
  const buy = 100 * 1.0005;
  const sell = 120 * 0.9995;
  const qty = 1 / (buy * 1.001);
  const expected = (qty * sell * 0.999 - 1) * 100;
  assert.ok(Math.abs(r.buyHoldBySymbol['BTC/USDT'] - expected) < 1e-9);
  assert.ok(Math.abs(r.buyHoldBySymbolGrossPct['BTC/USDT'] - 20) < 1e-9);
  assert.ok(r.buyHoldBySymbol['BTC/USDT'] < r.buyHoldBySymbolGrossPct['BTC/USDT']);
});
