'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const OkxAdapter = require('../src/exchanges/okx');
const { validateMarketOrder } = require('../src/orderRules');

test('OKX SPOT kuralları minSz/lotSz değerlerini baz varlık miktarı olarak uygular', async () => {
  const ex = new OkxAdapter({});
  ex._ok = async () => [{
    instId: 'BTC-USDT', state: 'live', lotSz: '0.0001', minSz: '0.001',
    maxMktSz: '1000000', tickSz: '0.1'
  }];
  const rules = await ex.fetchSymbolRules('BTC/USDT');
  assert.equal(rules.stepSize, 0.0001);
  assert.equal(rules.minQty, 0.001);
  assert.equal(rules.marketMinQty, 0.001);
  assert.equal(rules.maxQty, 0, 'OKX maxMktSz quote cinsindeyken baz miktar üst sınırı gibi kullanılmamalı');
  assert.equal(rules.marketMaxQty, 0);
  assert.equal(rules.minNotional, 0);
  assert.equal(rules.minNotionalMode, 'quantity-only');
  assert.equal(validateMarketOrder({ rules, side: 'buy', amount: 0.001, price: 50000 }).ok, true);
  assert.deepEqual(validateMarketOrder({ rules, side: 'buy', amount: 0.0009, price: 50000 }).errors, ['minQty']);
});

test('canlı motor yalnızca açıkça quantity-only tanımlı kurallarda minNotional olmadan ilerleyebilir', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/liveEngine'), 'utf8');
  assert.match(source, /const quantityOnlyRules = rules\.minNotionalMode === 'quantity-only'/);
  assert.match(source, /if \(quantityOnlyRules && \(\!\(Number\(rules\.minQty\) > 0\) \|\| \!\(Number\(rules\.stepSize\) > 0\)\)\)/);
  assert.match(source, /minNotional > 0 && rules\.minNotionalAppliesToMarket !== false && baseQty \* price < minNotional/);
});
