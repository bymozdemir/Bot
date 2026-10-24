const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, summarize } = require('../walkForwardTrend');

test('Trend V1 walk-forward: varsayılanlar sabit ve CLI parse edilir', () => {
  const o = parseArgs(['--months', '60', '--tf', '4h', '--symbols', 'BTC/USDT,ETH/USDT']);
  assert.equal(o.months, 60);
  assert.equal(o.oosMonths, 4);
  assert.equal(o.contextMonths, 12);
  assert.equal(o.tf, '4h');
  assert.deepEqual(o.symbols, ['BTC/USDT', 'ETH/USDT']);
});

test('Trend V1 walk-forward: özet pozitiflik ve bileşik getiriyi deterministik hesaplar', () => {
  const s = summarize([
    { returnPct: 10, buyHoldPct: 5, trades: 2, maxDrawdownPct: -4 },
    { returnPct: -5, buyHoldPct: 8, trades: 3, maxDrawdownPct: -9 },
    { returnPct: 20, buyHoldPct: 10, trades: 4, maxDrawdownPct: -6 }
  ]);
  assert.equal(s.resultCount, 3);
  assert.equal(s.positive, 2);
  assert.equal(s.beatBuyHold, 2);
  assert.equal(s.totalTrades, 9);
  assert.equal(s.worstFoldDrawdownPct, -9);
  assert.equal(Number(s.compoundedReturnPct.toFixed(6)), 25.4);
  assert.equal(Number(s.compoundedBuyHoldPct.toFixed(6)), 24.74);
});

test('Trend V1 walk-forward: bileşik getiri farklı pariteleri tek zincirde çarpmaz', () => {
  const s = summarize([
    { fold: 1, symbol: 'BTC/USDT', returnPct: 10, buyHoldPct: 0, trades: 1, maxDrawdownPct: -1 },
    { fold: 2, symbol: 'BTC/USDT', returnPct: 10, buyHoldPct: 0, trades: 1, maxDrawdownPct: -1 },
    { fold: 1, symbol: 'ETH/USDT', returnPct: -20, buyHoldPct: 0, trades: 1, maxDrawdownPct: -1 },
    { fold: 2, symbol: 'ETH/USDT', returnPct: 0, buyHoldPct: 0, trades: 1, maxDrawdownPct: -1 }
  ]);
  assert.equal(Number(s.compoundedReturnBySymbol['BTC/USDT'].toFixed(6)), 21);
  assert.equal(Number(s.compoundedReturnBySymbol['ETH/USDT'].toFixed(6)), -20);
  // Parite ortalaması: (21 + -20) / 2 — tek zincir (1.1*1.1*0.8*1.0) olsaydı -3.2 çıkardı.
  assert.equal(Number(s.compoundedReturnPct.toFixed(6)), 0.5);
});
