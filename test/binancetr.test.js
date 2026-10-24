const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceTrAdapter = require('../src/exchanges/binancetr');

function fakeResponse(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

function withMockFetch(handler, fn) {
  const old = global.fetch;
  global.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/open/v1/common/time') return fakeResponse({ code: 0, msg: 'success', timestamp: Date.now() });
    return handler(url, opts);
  };
  return Promise.resolve().then(fn).finally(() => { global.fetch = old; });
}

test('Binance TR adresi ve sembol formatı Binance TR sözleşmesine göre ayrıdır', () => {
  const ex = new BinanceTrAdapter({ apiKey: 'k', apiSecret: 's' });
  assert.equal(ex.baseUrl, 'https://www.binance.tr');
  assert.equal(ex.normalizeSymbol('BTC/TRY'), 'BTC_TRY');
  assert.equal(ex.normalizeSymbol('BTC_TRY'), 'BTC_TRY');
});

test('Binance TR public response wrapperı data alanından doğru açılır', async () => {
  const ex = new BinanceTrAdapter();
  const old = global.fetch;
  global.fetch = async (url) => {
    assert.match(url, /www\.binance\.tr\/open\/v1\/common\/time$/);
    return fakeResponse({ code: 0, msg: 'success', timestamp: 123 });
  };
  try { assert.equal(await ex.fetchServerTime(), 123); } finally { global.fetch = old; }
});

test('Binance TR kline endpointi api.binance.me/api/v1/klines kullanır ve diziye çevirir', async () => {
  const ex = new BinanceTrAdapter();
  await withMockFetch(async (url) => {
    assert.match(url, /^https:\/\/api\.binance\.me\/api\/v1\/klines\?symbol=BTCTRY&interval=1h&limit=2$/);
    return fakeResponse({ code: 0, msg: 'success', data: [[1,'2','3','1.5','2.5','10']] });
  }, async () => {
    assert.deepEqual(await ex.fetchCandles('BTC/TRY', '1h', 2), [{t:1,o:2,h:3,l:1.5,c:2.5,v:10}]);
  });
});

test('Binance TR imzalı emir Binance TR endpointi, numeric side/type ve clientId kullanır', async () => {
  const ex = new BinanceTrAdapter({ apiKey: 'key', apiSecret: 'secret' });
  await withMockFetch(async (url, opts) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/open/v1/orders');
    assert.equal(u.searchParams.get('symbol'), 'BTC_TRY');
    assert.equal(u.searchParams.get('side'), '0');
    assert.equal(u.searchParams.get('type'), '2');
    assert.equal(u.searchParams.get('quantity'), '0.01');
    assert.equal(u.searchParams.get('clientId'), 'cid-1');
    assert.ok(u.searchParams.get('signature'));
    assert.equal(opts.headers['X-MBX-APIKEY'], 'key');
    return fakeResponse({ code: 0, message: 'success', data: { orderId: '42', createTime: 123 } });
  }, async () => {
    const o = await ex.createMarketOrder('BTC/TRY', 'buy', 0.01, 'cid-1');
    assert.equal(o.orderId, '42');
    assert.equal(o.clientOrderId, 'cid-1');
    assert.equal(o.status, 'NEW');
  });
});

test('Binance TR account wrapperı accountAssets listesini normalize eder', async () => {
  const ex = new BinanceTrAdapter({ apiKey: 'key', apiSecret: 'secret' });
  await withMockFetch(async (url) => {
    assert.match(url, /\/open\/v1\/account\/spot\?/);
    return fakeResponse({ code: 0, msg: 'success', data: { accountAssets: [
      {asset:'TRY', free:'1000', locked:'50'}, {asset:'BTC', free:'0', locked:'0'}
    ] } });
  }, async () => {
    assert.deepEqual(await ex.fetchBalance(), { TRY: { free: 1000, locked: 50 } });
  });
});

test('Binance TR open orders sembol başına çağrılır ve numeric status normalize edilir', async () => {
  const ex = new BinanceTrAdapter({ apiKey: 'key', apiSecret: 'secret' });
  let calls = 0;
  await withMockFetch(async (url) => {
    calls++;
    const u = new URL(url);
    assert.equal(u.pathname, '/open/v1/orders');
    assert.equal(u.searchParams.get('type'), '1');
    return fakeResponse({ code: 0, msg: 'success', data: { list: [
      { orderId:'9', clientId:'stop-1', symbol:'BTC_TRY', side:1, status:0, origQty:'0.1', executedQty:'0' }
    ] } });
  }, async () => {
    const rows = await ex.fetchOpenOrders(['BTC/TRY', 'ETH/TRY']);
    assert.equal(calls, 2);
    assert.equal(rows[0].status, 'NEW');
    assert.equal(rows[0].side, 'sell');
    assert.equal(rows[0].symbol, 'BTC/TRY');
  });
});

test('Binance TR query order ve cancel resmi signed endpointlerine gider', async () => {
  const ex = new BinanceTrAdapter({ apiKey:'key', apiSecret:'secret' });
  let n = 0;
  await withMockFetch(async (url) => {
    n++;
    const u = new URL(url);
    if (u.pathname === '/open/v1/orders/detail') return fakeResponse({ code:0, msg:'success', data:{ orderId:'42', clientId:'cid-1', symbol:'BTC_TRY', side:1, status:2, executedQty:'0.1', executedQuoteQty:'250000' } });
    if (u.pathname === '/open/v1/orders/cancel') return fakeResponse({ code:0, msg:'success', data:{ orderId:'42', clientId:'cid-1', symbol:'BTC_TRY', side:1, status:3, executedQty:'0.1' } });
    throw new Error('unexpected endpoint');
  }, async () => {
    const q = await ex.getOrder('BTC/TRY', '42');
    assert.equal(q.orderId, '42');
    assert.equal(q.status, 'FILLED');
    const c = await ex.cancelOrder('BTC/TRY', '42');
    assert.equal(c.status, 'CANCELED');
    assert.equal(n, 2);
  });
});


test('Binance TR mutating transport hatasi unknownOutcome olur', async () => {
  const ex = new BinanceTrAdapter({ apiKey:'k', apiSecret:'s' });
  const oldFetch = global.fetch;
  global.fetch = async () => { throw new Error('network timeout'); };
  try {
    await assert.rejects(ex.createMarketOrder('BTC/TRY','buy',100,'cid-timeout'), (err) => err.unknownOutcome === true);
  } finally { global.fetch = oldFetch; }
});

test('Binance TR resmi OCO endpointi tek emir listesi olarak oluşturur ve iki legi clientId ile doğrular', async () => {
  const ex = new BinanceTrAdapter({ apiKey:'key', apiSecret:'secret' });
  const seen = [];
  await withMockFetch(async (url) => {
    const u = new URL(url);
    seen.push(u);
    if (u.pathname === '/open/v1/orders/oco') {
      assert.equal(u.searchParams.get('symbol'), 'BTC_TRY');
      assert.equal(u.searchParams.get('side'), '1');
      assert.equal(u.searchParams.get('quantity'), '0.1');
      assert.equal(u.searchParams.get('price'), '70000');
      assert.equal(u.searchParams.get('stopPrice'), '60000');
      assert.equal(u.searchParams.get('stopLimitPrice'), '60000');
      assert.equal(u.searchParams.get('listClientId'), 'oco-list-1');
      assert.equal(u.searchParams.get('limitClientId'), 'tp-1');
      assert.equal(u.searchParams.get('stopClientId'), 'sl-1');
      return fakeResponse({ code:0, msg:'success', data:{ orderId:'100', createTime:123 } });
    }
    if (u.pathname === '/open/v1/orders/detail') {
      const cid = u.searchParams.get('clientId');
      assert.ok(['tp-1','sl-1'].includes(cid));
      return fakeResponse({ code:0, msg:'success', data:{
        orderId: cid === 'tp-1' ? '101' : '102', orderListId:'9001', clientId:cid,
        symbol:'BTC_TRY', side:1, status:0, origQty:'0.1', executedQty:'0',
        price: cid === 'tp-1' ? '70000' : '60000', stopPrice: cid === 'tp-1' ? '70000' : '60000'
      }});
    }
    throw new Error(`unexpected endpoint ${u.pathname}`);
  }, async () => {
    const o = await ex.createOcoOrder('BTC/TRY','sell',0.1, {
      takeProfitPrice:70000, stopPrice:60000,
      listClientOrderId:'oco-list-1', takeProfitClientOrderId:'tp-1', stopClientOrderId:'sl-1'
    });
    assert.equal(o.orderListId, '9001');
    assert.equal(o.orders.length, 2);
    assert.deepEqual(o.orders.map(x => x.clientOrderId).sort(), ['sl-1','tp-1']);
    assert.equal(seen.length, 3);
  });
});

test('Binance TR OCO transport belirsizliğinde tekrar OCO göndermez', async () => {
  const ex = new BinanceTrAdapter({ apiKey:'k', apiSecret:'s' });
  const oldFetch = global.fetch;
  global.fetch = async () => { throw new Error('network timeout'); };
  try {
    await assert.rejects(ex.createOcoOrder('BTC/TRY','sell',0.1, {
      takeProfitPrice:70000, stopPrice:60000, listClientOrderId:'l', takeProfitClientOrderId:'t', stopClientOrderId:'s'
    }), (err) => err.unknownOutcome === true);
  } finally { global.fetch = oldFetch; }
});
