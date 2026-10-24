'use strict';
// Birleştirme regresyonu: security-patched (yön/clientOrderId/XBT-BTC/executed<=orig) ve audit-fixes
// (adaptör-bazlı sembol, istenen miktarı aşma, kasa tutarlı alış istisnası, OCO) kontrollerinin HEPSİ
// tek doğrulayıcıda birlikte çalışmalı.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertResponseMatchesRequest, assertOrderMatchesRequest, OrderManager } = require('../src/orderManager');

const CID = 'market-merged-0001';
const req = { clientOrderId: CID, symbol: 'BTC/USDT', side: 'buy', amount: 1 };
const good = { orderId: 1, clientOrderId: CID, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1' };
const verified = { capabilities: { verifiesResponseSymbol: true } };
const plain = { capabilities: {} };
const quoteSized = { capabilities: { marketBuyUsesQuote: true }, marketBuyUsesQuote: true };

test('geçerli yanıt her adaptör türünde kabul edilir', () => {
  for (const ex of [verified, plain, quoteSized]) assert.doesNotThrow(() => assertResponseMatchesRequest(ex, good, req));
});

test('D kolu: yön, clientOrderId, executed>orig, nesne olmayan yanıt reddedilir', () => {
  for (const bad of [
    { ...good, side: 'SELL' },
    { ...good, clientOrderId: 'other' },
    { ...good, executedQty: '2', origQty: '1' },
    null, [], 'x'
  ]) {
    assert.throws(() => assertResponseMatchesRequest(plain, bad, req), (e) => e.unknownOutcome === true);
  }
});

test('B kolu: istenen miktarı aşan yanıt reddedilir; kasa tutarlı alış muaf', () => {
  const over = { ...good, origQty: '5', executedQty: '5' };
  assert.throws(() => assertResponseMatchesRequest(plain, over, req), (e) => e.unknownOutcome === true);
  assert.doesNotThrow(() => assertResponseMatchesRequest(quoteSized, over, { ...req, amount: 100 }));
  assert.doesNotThrow(() => assertResponseMatchesRequest(quoteSized, over, req)); // kasa tutarı: miktar sınırı yok
});

test('kasa tutarlı alış: executedQty > origQty (ucuz coin) yanlış alarm üretmez, geçersiz sayı yine reddedilir', () => {
  const cheap = { ...good, origQty: '100', executedQty: '1000000' };
  assert.doesNotThrow(() => assertResponseMatchesRequest(quoteSized, cheap, { ...req, amount: 100 }));
  assert.throws(() => assertResponseMatchesRequest(plain, cheap, { ...req, amount: 100 }));
  assert.throws(() => assertResponseMatchesRequest(quoteSized, { ...good, executedQty: '-1' }, req));
});

test('sembol: doğrulanmış adaptörde birebir, diğerlerinde XBT/BTC takma adına toleranslı', () => {
  const wrongSym = { ...good, symbol: 'ETHUSDT' };
  assert.throws(() => assertResponseMatchesRequest(verified, wrongSym, req));
  assert.throws(() => assertResponseMatchesRequest(plain, wrongSym, req));
  const xbt = { ...good, symbol: 'XBTUSDT' };
  assert.doesNotThrow(() => assertResponseMatchesRequest(plain, xbt, req));          // takma ad: yanlış alarm yok
  assert.throws(() => assertResponseMatchesRequest(verified, xbt, req));            // doğrulanmışta takma ad beklenmez
  // ayrıştırılamayan sembol biçimi (ör. paribu 'btc_tl') yanlış alarm üretmez
  assert.doesNotThrow(() => assertResponseMatchesRequest(plain, { ...good, symbol: 'btc_tl' }, { ...req, symbol: 'BTC/TRY' }));
});

test('geriye dönük: assertOrderMatchesRequest takma adı hâlâ çalışır', () => {
  assert.doesNotThrow(() => assertOrderMatchesRequest(good, req));
  assert.throws(() => assertOrderMatchesRequest({ ...good, side: 'sell' }, req));
});

test('OrderManager: tutarsız yanıt (yön) UNKNOWN olur ve yeniden gönderilmez', async () => {
  let posts = 0;
  const ex = { id: 'fake', name: 'Fake', capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true },
    async createMarketOrder() { posts++; return { ...good, side: 'SELL' }; }, async getOrder() { throw new Error('n/a'); } };
  const om = new OrderManager({ exchange: ex, state: { liveOrders: {} }, store: { save() {} } });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: CID });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.requiresReconciliation, true);
  await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: CID });
  assert.equal(posts, 1);
});


test('geriye dönük yanıt alanı takma adları korunur (typeSide/orderSide/newClientOrderId)', () => {
  for (const field of ['typeSide', 'orderSide']) {
    const aliased = { ...good, side: undefined, [field]: 'BUY' };
    assert.doesNotThrow(() => assertResponseMatchesRequest(plain, aliased, req));
    assert.throws(() => assertResponseMatchesRequest(plain, { ...aliased, [field]: 'SELL' }, req), (e) => e.unknownOutcome === true);
  }
  const cidAlias = { ...good, clientOrderId: undefined, newClientOrderId: CID };
  assert.doesNotThrow(() => assertResponseMatchesRequest(plain, cidAlias, req));
  assert.throws(() => assertResponseMatchesRequest(plain, { ...cidAlias, newClientOrderId: 'other' }, req), (e) => e.unknownOutcome === true);
});

test('negatif olmayan sayısal alanlar zorunlu doğrulamadan geçer; NaN ve negatif değer reddedilir', () => {
  for (const field of ['origQty', 'executedQty']) {
    for (const value of ['-1', 'NaN', 'Infinity']) {
      assert.throws(() => assertResponseMatchesRequest(plain, { ...good, [field]: value }, req), (e) => e.unknownOutcome === true);
    }
  }
});
