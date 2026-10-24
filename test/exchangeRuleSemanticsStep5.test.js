'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceAdapter = require('../src/exchanges/binance');
const BinanceTrAdapter = require('../src/exchanges/binancetr');
const BtcturkAdapter = require('../src/exchanges/btcturk');
const { validateMarketOrder } = require('../src/orderRules');

test('Binance NOTIONAL market flags are interpreted separately and stop capability is per-symbol', async () => {
  const ex = new BinanceAdapter();
  ex._publicGet = async () => ({ symbols: [{ status: 'TRADING', baseAsset: 'ABC', quoteAsset: 'USDT', orderTypes: ['LIMIT', 'MARKET'], filters: [
    { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '100', stepSize: '0.1' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.1', maxQty: '100', stepSize: '0.1' },
    { filterType: 'NOTIONAL', minNotional: '10', maxNotional: '1000', applyMinToMarket: false, applyMaxToMarket: false }
  ] }] });
  const rules = await ex.fetchSymbolRules('ABC/USDT');
  assert.equal(rules.minNotionalAppliesToMarket, false);
  assert.equal(rules.maxNotionalAppliesToMarket, false);
  assert.equal(rules.supportsProtectiveStop, false);
  assert.equal(validateMarketOrder({ rules, side: 'buy', amount: 2, price: 1000 }).ok, true);
});

test('Binance rejects a non-trading symbol from exchangeInfo', async () => {
  const ex = new BinanceAdapter();
  ex._publicGet = async () => ({ symbols: [{ status: 'HALT', filters: [] }] });
  await assert.rejects(ex.fetchSymbolRules('ABC/USDT'), /işlem için açık değil/);
});

test('Binance TR reports a known symbol without STOP_LOSS as lacking a protective stop', async () => {
  const ex = new BinanceTrAdapter();
  ex._publicGet = async (path) => {
    if (path === '/open/v1/common/symbols') return { list: [{ symbol: 'ABC_TRY', status: 'TRADING', orderTypes: [1, 2], filters: [
      { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '100', stepSize: '0.1' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.1', maxQty: '100', stepSize: '0.1' },
      { filterType: 'NOTIONAL', minNotional: '10', maxNotional: '1000', applyMinToMarket: true, applyMaxToMarket: false }
    ] }] };
    return {};
  };
  const rules = await ex.fetchSymbolRules('ABC/TRY');
  assert.equal(rules.supportsProtectiveStop, false);
  assert.equal(rules.maxNotionalAppliesToMarket, false);
});

test('BTCTurk symbol without STOP_MARKET is marked unsafe for protective-stop entry', async () => {
  const ex = new BtcturkAdapter();
  ex._publicGet = async () => ({ symbols: [{ name: 'ABC/TRY', nameNormalized: 'ABC_TRY', status: 'TRADING', numerator: 'ABC', denominator: 'TRY', numeratorScale: 4, filters: [
    { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '100000', tickSize: '0.01', minExchangeValue: '100', minAmount: null, maxAmount: null }
  ], orderMethods: ['LIMIT', 'STOP_LIMIT'] }] });
  const rules = await ex.fetchSymbolRules('ABC/TRY');
  assert.ok(Math.abs(rules.stepSize - 0.0001) < 1e-12);
  assert.equal(rules.minNotional, 100);
  assert.equal(rules.supportsProtectiveStop, false);
});

test('BTCTurk rejects a non-trading pair before order planning', async () => {
  const ex = new BtcturkAdapter();
  ex._publicGet = async () => ({ symbols: [{ name: 'ABCTRY', nameNormalized: 'ABC_TRY', status: 'HALTED', filters: [] }] });
  await assert.rejects(ex.fetchSymbolRules('ABC/TRY'), /işlem için açık değil/);
});
