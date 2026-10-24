'use strict';
// USD/GBP gibi sabit listede olmayan kasa birimlerinde baz komisyonu düşülmeli (pozisyon miktarı şişmemeli).
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrder, splitSymbol } = require('../src/orderManager');

test('splitSymbol: kanonik BAZ/KASA biçimi her kasa birimi için doğru ayrılır', () => {
  for (const [sym, base, quote] of [['BTC/USDT', 'BTC', 'USDT'], ['BTC/USD', 'BTC', 'USD'], ['ETH/GBP', 'ETH', 'GBP'], ['SOL/EUR', 'SOL', 'EUR'], ['USDC/USDT', 'USDC', 'USDT'], ['BTC/TRY', 'BTC', 'TRY'], ['ETH/BTC', 'ETH', 'BTC']]) {
    assert.deepEqual(splitSymbol(sym), { base, quote }, sym);
  }
  assert.deepEqual(splitSymbol('BTCUSDT'), { base: 'BTC', quote: 'USDT' });
  assert.deepEqual(splitSymbol('BTCUSD'), { base: 'BTC', quote: 'USD' });
  assert.deepEqual(splitSymbol('USDT'), { base: null, quote: null }); // sadece kasa adı: baz yok
  assert.deepEqual(splitSymbol('A/B/C'), { base: null, quote: null });
});

test('normalizeOrder: USD ve GBP kasalı çiftte alımın baz komisyonu net miktardan düşülür', () => {
  for (const sym of ['BTC/USDT', 'BTC/USD', 'ETH/GBP']) {
    const base = sym.split('/')[0];
    const o = normalizeOrder({ symbol: sym, side: 'BUY', status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100', clientOrderId: 'x', fills: [{ price: '100', qty: '1', commission: '0.001', commissionAsset: base }] }, { symbol: sym });
    assert.ok(Math.abs(o.netExecutedQty - 0.999) < 1e-12, `${sym}: netExecutedQty=${o.netExecutedQty}`);
    assert.equal(o.commissionBase, 0.001, sym);
  }
});
