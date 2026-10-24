const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRiskExit } = require('../src/strategies/riskExit');
const BtcturkAdapter = require('../src/exchanges/btcturk');
const fs = require('fs');
const path = require('path');

test('final hardening: takeProfitPct=0 paper/live ile aynı biçimde kapalıdır', () => {
  const pos = { entryPrice: 100, highWaterMark: 100, stopPrice: 80 };
  assert.equal(checkRiskExit(pos, 1100, { stopLossPct: 15, takeProfitPct: 0, trailingStop: false }), null);
  assert.equal(checkRiskExit(pos, 1100.01, { stopLossPct: 15, takeProfitPct: 0, trailingStop: false }), null);
});

test('final hardening: BtcTurk Untouched/Partial durumları güvenli normalize edilir', () => {
  const ex = new BtcturkAdapter({});
  assert.equal(ex._normalizeOrder({ id: 1, status: 'Untouched', type: 'sell', pairsymbolnormalized: 'BTC_TRY', quantity: '1' }).status, 'NEW');
  assert.equal(ex._normalizeOrder({ id: 2, status: 'Partial', type: 'sell', pairsymbolnormalized: 'BTC_TRY', quantity: '1', executedQuantity: '0.4' }).status, 'PARTIALLY_FILLED');
});

test('final hardening: Binance TR API preflight boş sembol listesiyle açık emir sorgulamaya çalışmaz', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'apiPreflight.js'), 'utf8');
  assert.match(src, /if \(id === 'binancetr'\)/);
  assert.match(src, /symbols = Object\.keys\(store\.defaultState\(\)\.pairs/);
  assert.match(src, /fetchOpenOrders\(symbols\)/);
});

test('final hardening: panel risk para birimi settings.quoteAsset üzerinden okunur', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const quote = String\(state\.settings\.quoteAsset \|\| 'USDT'\)\.toUpperCase\(\);/);
  assert.match(src, /startingBalanceByAsset\?\.\[quote\]/);
  assert.match(src, /cashByAsset\?\.\[quote\]/);
});
