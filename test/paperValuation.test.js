'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const PaperEngine = require('../src/paperEngine');
const { quoteEquity } = require('../src/paperValuation');

test('paper equity tek ortak fonksiyonla komisyon/kayma sonrası tasfiye değerini hesaplar', () => {
  const state = store.defaultState();
  state.settings.mode = 'paper';
  state.settings.quoteAsset = 'USDT';
  state.settings.paperFeePct = 0.1;
  state.settings.paperSlippagePct = 0.05;
  state.paper.cash = 50;
  state.paper._legacyCashMirror = 50;
  state.paper.cashByAsset = { USDT: 50, TRY: 900 };
  state.paper.positions = {
    'BTC/USDT': { symbol: 'BTC/USDT', quoteAsset: 'USDT', quantity: 1, entryPrice: 100, costQuote: 100 },
    'ETH/TRY': { symbol: 'ETH/TRY', quoteAsset: 'TRY', quantity: 2, entryPrice: 10, costQuote: 20 }
  };
  state.paper.lastPrices = { 'BTC/USDT': 120, 'ETH/TRY': 11 };
  const engine = new PaperEngine({ exchange: { quoteAssets: ['USDT', 'TRY'] }, store: { save() {} }, state });
  const expected = 50 + 120 * (1 - 0.0005) * (1 - 0.001);
  assert.ok(Math.abs(engine.computeEquity() - expected) < 1e-9);
  assert.ok(Math.abs(engine.liquidationEquity() - expected) < 1e-9);
  assert.ok(Math.abs(quoteEquity({ quote: 'USDT', cashByAsset: state.paper.cashByAsset, positions: state.paper.positions, lastPrices: state.paper.lastPrices, feeRate: 0.001, slippagePct: 0.05, liquidation: true }) - expected) < 1e-9);
  assert.equal(engine.computeEquityByQuote().TRY, 900 + 2 * 11 * (1 - 0.0005) * (1 - 0.001));
});


test('sıfır/bozuk son fiyat, pozisyonu sıfır değerlemez; giriş fiyatına geri döner', () => {
  const positions = { 'BTC/USDT': { symbol: 'BTC/USDT', quantity: 2, entryPrice: 100 } };
  const eq = quoteEquity({ quote: 'USDT', cashByAsset: { USDT: 10 }, positions, lastPrices: { 'BTC/USDT': 0 }, feeRate: 0, slippagePct: 0, liquidation: false });
  assert.equal(eq, 210);
});
