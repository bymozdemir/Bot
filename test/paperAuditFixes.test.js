'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('paper reset factory initializes cash, day-start and kill-switch baseline in selected quote asset', () => {
  for (const quote of ['TRY', 'USDT', 'EUR']) {
    const p = store.defaultPaper(250, quote);
    assert.equal(p.cashByAsset[quote], 250);
    assert.equal(p.startingBalanceByAsset[quote], 250);
    assert.equal(p.dayStartEquityByAsset[quote], 250);
    assert.equal(p.cash, 250);
    assert.deepEqual(Object.keys(p.cashByAsset), [quote]);
  }
});
