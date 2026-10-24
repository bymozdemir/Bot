const test = require('node:test');
const assert = require('node:assert/strict');
const BtcturkAdapter = require('../src/exchanges/btcturk');

function fakeResponse(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}
function withMockFetch(handler, fn) {
  const old = global.fetch;
  global.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { global.fetch = old; });
}

test('BTCTurk kline 15m/1h/4h çözünürlüğünü resmi graph API formatında kullanır', async () => {
  const ex = new BtcturkAdapter();
  await withMockFetch(async (url) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://graph-api.btcturk.com');
    assert.equal(u.pathname, '/v1/klines/history');
    assert.equal(u.searchParams.get('symbol'), 'BTCTRY');
    assert.equal(u.searchParams.get('resolution'), '15');
    assert.ok(Number(u.searchParams.get('from')) < Number(u.searchParams.get('to')));
    return fakeResponse({ s: 'ok', t: [100, 100 + 900], o: [10, 11], h: [12, 13], l: [9, 10], c: [11, 12], v: [100, 110] });
  }, async () => {
    const rows = await ex.fetchCandles('BTC/TRY', '15m', 2);
    assert.deepEqual(rows, [
      {t:100000,o:10,h:12,l:9,c:11,v:100},
      {t:1000000,o:11,h:13,l:10,c:12,v:110}
    ]);
  });
});

test('BTCTurk günlük veri yanlışlıkla saatlik istek olarak kabul edilmez', async () => {
  const ex = new BtcturkAdapter();
  await withMockFetch(async () => fakeResponse({ s:'ok', t:[100, 100 + 86400], o:[10,11], h:[12,13], l:[9,10], c:[11,12], v:[100,110] }), async () => {
    await assert.rejects(ex.fetchCandles('BTC/TRY','1h',2), /mum çözünürlüğü doğrulanamadı/);
  });
});

test('BTCTurk private yetenekleri güvenli canlı motor için tanımlıdır', () => {
  const ex = new BtcturkAdapter({apiKey:'k', apiSecret:'c2VjcmV0'});
  assert.deepEqual(ex.capabilities, {clientOrderId:true, marketBuyUsesQuote:true, orderQuery:true, balanceQuery:true, openOrdersQuery:true, userDataStream:false, oco:false, nativeTrailingOco:false, marketOrderBook:true, protectiveStopImplemented:true, liveTradingVerified:false});
});

test('BTCTurk açık emirleri bids ve asks listesini normalize eder', async () => {
  const ex = new BtcturkAdapter({apiKey:'k', apiSecret:'c2VjcmV0'});
  await withMockFetch(async (url) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/api/v1/openOrders');
    assert.equal(u.searchParams.get('pairSymbol'), 'BTCTRY');
    return fakeResponse({success:true, code:0, data:{
      bids:[{id:1, pairSymbolNormalized:'BTC_TRY', type:'Buy', method:'Limit', quantity:'0.01', price:'100'}],
      asks:[{id:2, pairSymbolNormalized:'BTC_TRY', type:'Sell', method:'Stop Limit', quantity:'0.02', price:'90'}]
    }});
  }, async () => {
    const rows = await ex.fetchOpenOrders(['BTC/TRY']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].side, 'buy');
    assert.equal(rows[1].side, 'sell');
    assert.equal(rows[1].symbol, 'BTC/TRY');
  });
});

test('BTCTurk koruyucu stop emri resmi stopMarket yazımını kullanır', async () => {
  const ex = new BtcturkAdapter({apiKey:'k', apiSecret:'c2VjcmV0'});
  await withMockFetch(async (url, opts) => {
    assert.equal(new URL(url).pathname, '/api/v1/order');
    const body = JSON.parse(opts.body);
    assert.equal(body.orderMethod, 'stopMarket');
    assert.equal(body.orderType, 'sell');
    assert.equal(body.stopPrice, 95);
    assert.equal(body.price, 0);
    // Canlı koruyucu stop kimliksiz gönderilmez: belirsiz sonuçta clientOrderId ile kurtarma gerekir.
    assert.equal(body.newOrderClientId, 'stop-test-1');
    return fakeResponse({success:true, code:0, data:{id:42, pairSymbol:'BTCTRY', type:'Sell', method:'Stop Limit', quantity:'0.1', price:'94', stopPrice:'95', newOrderClientId:'stop-test-1'}});
  }, async () => {
    const row = await ex.createStopOrder('BTC/TRY','sell',0.1,95,94,'stop-test-1');
    assert.equal(row.orderId, 42);
    assert.equal(row.side, 'sell');
  });
});


test('BTCTurk koruyucu stop alış yönünü reddeder', async () => {
  const ex = new BtcturkAdapter({apiKey:'k', apiSecret:'c2VjcmV0'});
  await assert.rejects(ex.createStopOrder('BTC/TRY','buy',0.1,95,94), /yalnızca sell/);
});

test('BTCTurk mutating 5XX ve transport hatasi unknownOutcome olur', async () => {
  const ex = new BtcturkAdapter({apiKey:'k', apiSecret:'c2VjcmV0'});
  const oldFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({message:'server'}), {status:503});
  try {
    await assert.rejects(ex.createMarketOrder('BTC/TRY','buy',100,'cid-5xx'), (err) => err.unknownOutcome === true && err.httpStatus === 503);
  } finally { global.fetch = oldFetch; }
  global.fetch = async () => { throw new Error('network timeout'); };
  try {
    await assert.rejects(ex.createMarketOrder('BTC/TRY','buy',100,'cid-timeout'), (err) => err.unknownOutcome === true);
  } finally { global.fetch = oldFetch; }
});

test('BTCTurk cancelOrder DELETE kabulünü nihai iptal saymaz; GET ile CANCELED ve dolan miktarı doğrular', async () => {
  const ex = new BtcturkAdapter({apiKey:'k', apiSecret:'c2VjcmV0'});
  let statusReads = 0;
  await withMockFetch(async (url, opts = {}) => {
    const u = new URL(url);
    if (opts.method === 'DELETE') {
      assert.equal(u.pathname, '/api/v1/order');
      assert.equal(u.searchParams.get('id'), '42');
      return fakeResponse({success:true, code:0, data:{}});
    }
    assert.equal(u.pathname, '/api/v1/order/42');
    statusReads++;
    return fakeResponse({success:true, data:{
      id:42, pairSymbolNormalized:'BTC_TRY', type:'Sell', quantity:'1',
      executedQuantity:'0.2', status: statusReads === 1 ? 'Partial' : 'Canceled'
    }});
  }, async () => {
    const row = await ex.cancelOrder('BTC/TRY', 42);
    assert.equal(row.status, 'CANCELED');
    assert.equal(row.executedQty, 0.2);
    assert.equal(statusReads, 2);
  });
});

test('BTCTurk cancelOrder active kalan emri CANCELED diye sunmaz', async () => {
  const ex = new BtcturkAdapter({apiKey:'k', apiSecret:'c2VjcmV0'});
  await withMockFetch(async (url, opts = {}) => {
    const u = new URL(url);
    if (opts.method === 'DELETE') return fakeResponse({success:true, code:0, data:{}});
    assert.equal(u.pathname, '/api/v1/order/43');
    return fakeResponse({success:true, data:{
      id:43, pairSymbolNormalized:'BTC_TRY', type:'Sell', quantity:'1',
      executedQuantity:'0', status:'Untouched'
    }});
  }, async () => {
    const row = await ex.cancelOrder('BTC/TRY', 43);
    assert.equal(row.status, 'NEW');
    assert.notEqual(row.status, 'CANCELED');
  });
});
