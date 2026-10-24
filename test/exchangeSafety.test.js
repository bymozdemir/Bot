const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceAdapter = require('../src/exchanges/binance');

test('Binance market emri clientOrderId alabilir; sonuc belirsizse tekrar emri caller vermeli', async () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's' });
  let seen;
  ex._signedRequest = async (method, path, params) => {
    seen = { method, path, params };
    return { orderId: 7, clientOrderId: params.newClientOrderId };
  };
  const r = await ex.createMarketOrder('BTC/USDT', 'buy', 0.01, 'bot-buy-123');
  assert.equal(r.orderId, 7);
  assert.equal(seen.path, '/api/v3/order');
  assert.equal(seen.params.newClientOrderId, 'bot-buy-123');
});

test('Binance: ondalık biçimlendirmede sıfıra düşen miktar ağ isteğinden önce reddedilir', async () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's' });
  let calls = 0;
  ex._signedRequest = async () => { calls++; return { orderId: 7 }; };
  await assert.rejects(() => ex.createMarketOrder('BTC/USDT', 'sell', 1e-10, 'bot-sell-tiny'), /sıfıra düşüyor/);
  assert.equal(calls, 0, 'geçersiz emir için borsaya istek gönderilmemeli');
});

test('Binance getOrder clientOrderId ile sonucu sorgulayabilir', async () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's' });
  let seen;
  ex._signedRequest = async (method, path, params, opts) => {
    seen = { method, path, params, opts };
    return { status: 'FILLED', orderId: 9 };
  };
  const r = await ex.getOrder('BTC/USDT', undefined, 'bot-buy-123');
  assert.equal(r.status, 'FILLED');
  assert.equal(seen.params.origClientOrderId, 'bot-buy-123');
  assert.equal(seen.opts.allowRetry, false);
});

test('Binance 5XX hatasi unknownOutcome olarak isaretlenir', async () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's' });
  const oldFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ msg: 'server error' }), { status: 503 });
  try {
    await assert.rejects(
      ex.createMarketOrder('BTC/USDT', 'buy', 0.01, 'bot-buy-123'),
      (err) => err.unknownOutcome === true && err.httpStatus === 503
    );
  } finally {
    global.fetch = oldFetch;
  }
});

test('Binance testnet ortamı doğru REST ve WebSocket adreslerini kullanır', () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's', environment: 'testnet' });
  assert.equal(ex.environment, 'testnet');
  assert.equal(ex.baseUrl, 'https://testnet.binance.vision');
  assert.equal(ex.getUserDataWsUrl(), 'wss://ws-api.testnet.binance.vision/ws-api/v3');
});

test('Binance WebSocket override ortam hostuyla eşleşmeli', () => {
  const original = process.env.BINANCE_WS_API_URL;
  try {
    process.env.BINANCE_WS_API_URL = 'wss://ws-api.binance.com/ws-api/v3';
    const testnet = new BinanceAdapter({ environment: 'testnet' });
    assert.throws(() => testnet.getUserDataWsUrl(), /ortamla uyumsuz/);
    const production = new BinanceAdapter({ environment: 'production' });
    assert.equal(production.getUserDataWsUrl(), 'wss://ws-api.binance.com/ws-api/v3');
    process.env.BINANCE_WS_API_URL = 'wss://ws-api.testnet.binance.vision/ws-api/v3';
    assert.equal(testnet.getUserDataWsUrl(), 'wss://ws-api.testnet.binance.vision/ws-api/v3');
    assert.throws(() => production.getUserDataWsUrl(), /ortamla uyumsuz/);
    process.env.BINANCE_WS_API_URL = 'wss://ws-api.binance.com.attacker.invalid/ws-api/v3';
    assert.throws(() => production.getUserDataWsUrl(), /izin verilen host|ortamla uyumsuz/i);
  } finally {
    if (original === undefined) delete process.env.BINANCE_WS_API_URL; else process.env.BINANCE_WS_API_URL = original;
  }
});

test('Binance User Data Stream HMAC imzası resmi örnekle uyuşur', () => {
  const ex = new BinanceAdapter({
    apiKey: 'vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A',
    apiSecret: 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j'
  });
  const p = ex.createUserDataStreamSignature({ timestamp: 1645423376532, recvWindow: 100 });
  assert.equal(p.apiKey, ex.apiKey);
  assert.equal(p.timestamp, 1645423376532);
  assert.equal(p.recvWindow, 100);
  assert.equal(p.signature, 'b666e0d1614e607abddfdddabc1a8f2ac648f6499ea62c9a4866421defbe019f');
});

test('Binance User Data Stream için artık SAPI userListenToken yolu kullanılmıyor', () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's' });
  assert.equal(typeof ex.createUserListenToken, 'undefined');
  assert.equal(typeof ex.createUserDataStreamSignature, 'function');
});

test('geçersiz Binance ortamı reddedilir', () => {
  assert.throws(() => new BinanceAdapter({ environment: 'wrong' }), /production veya testnet/);
});


test('Binance testnet, production base URL ile karıştırılamaz', () => {
  assert.throws(() => new BinanceAdapter({ environment: 'testnet', baseUrl: 'https://api.binance.com' }), /ortamla uyumsuz/);
});

test('Binance production, testnet base URL ile karıştırılamaz', () => {
  assert.throws(() => new BinanceAdapter({ environment: 'production', baseUrl: 'https://testnet.binance.vision' }), /ortamla uyumsuz/);
});

test('Binance production public data-api adresi imzalı canlı REST tabanı olarak reddedilir', () => {
  assert.throws(() => new BinanceAdapter({ environment: 'production', baseUrl: 'https://data-api.binance.vision' }), /ortamla uyumsuz/);
});

test('Binance mutating transport timeout unknownOutcome olur', async () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's' });
  const oldFetch = global.fetch;
  global.fetch = async () => { throw new Error('network timeout'); };
  try {
    await assert.rejects(ex.createMarketOrder('BTC/USDT', 'buy', 0.01, 'cid-timeout'), (err) => err.unknownOutcome === true);
  } finally { global.fetch = oldFetch; }
});

test('Binance exchangeInfo kuralları MARKET_LOT_SIZE ve PRICE_FILTER bilgilerini de taşır', async () => {
  const ex = new BinanceAdapter({ apiKey:'k', apiSecret:'s' });
  ex._publicGet = async () => ({ symbols:[{ baseAsset:'BTC', quoteAsset:'USDT', filters:[
    {filterType:'LOT_SIZE', minQty:'0.0001', maxQty:'100', stepSize:'0.0001'},
    {filterType:'MARKET_LOT_SIZE', minQty:'0.001', maxQty:'10', stepSize:'0.001'},
    {filterType:'PRICE_FILTER', minPrice:'0.01', maxPrice:'1000000', tickSize:'0.01'},
    {filterType:'MIN_NOTIONAL', minNotional:'10'}
  ] }] });
  const r=await ex.fetchSymbolRules('BTC/USDT');
  assert.equal(r.marketStepSize,0.001);
  assert.equal(r.marketMinQty,0.001);
  assert.equal(r.marketMaxQty,10);
  assert.equal(r.tickSize,0.01);
});

test('Binance Spot OCO: endpoint, fiyatlar ve istemci kimlikleri doğrulanır', async () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's', environment: 'testnet' });
  let seen;

  ex._signedRequest = async (method, path, params) => {
    seen = { method, path, params };
    return { orderListId: 123, listClientOrderId: params.listClientOrderId, orders: [] };
  };

  await ex.createOcoOrder('BTC/USDT', 'sell', 0.1, {
    takeProfitPrice: 70000,
    stopPrice: 60000,
    stopLimitPrice: 59000,
    listClientOrderId: 'list-test-123',
    takeProfitClientOrderId: 'tp-test-123',
    stopClientOrderId: 'sl-test-123'
  });

  assert.equal(seen.method, 'POST');
  assert.equal(seen.path, '/api/v3/orderList/oco');
  assert.equal(seen.params.symbol, 'BTCUSDT');
  assert.equal(seen.params.side, 'SELL');
  assert.equal(seen.params.quantity, '0.1');
  assert.equal(seen.params.aboveType, 'TAKE_PROFIT');
  assert.equal(seen.params.belowType, 'STOP_LOSS_LIMIT');
  assert.equal(seen.params.aboveStopPrice, '70000');
  assert.equal(seen.params.belowPrice, '59000');
  assert.equal(seen.params.belowStopPrice, '60000');
  assert.equal(seen.params.belowTimeInForce, 'GTC');
  assert.equal(seen.params.listClientOrderId, 'list-test-123');
  assert.equal(seen.params.aboveClientOrderId, 'tp-test-123');
  assert.equal(seen.params.belowClientOrderId, 'sl-test-123');
});

test('Binance Spot OCO: iz süren stop belowTrailingDelta olarak gönderilir', async () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's', environment: 'testnet' });
  let seen;

  ex._signedRequest = async (method, path, params) => {
    seen = { method, path, params };
    return { orderListId: 124, orders: [] };
  };

  await ex.createOcoOrder('ETH/USDT', 'sell', 0.5, {
    takeProfitPrice: 4000,
    trailingDelta: 125,
    listClientOrderId: 'list-trail-124',
    takeProfitClientOrderId: 'tp-trail-124',
    stopClientOrderId: 'sl-trail-124'
  });

  assert.equal(seen.method, 'POST');
  assert.equal(seen.path, '/api/v3/orderList/oco');
  assert.equal(seen.params.symbol, 'ETHUSDT');
  assert.equal(seen.params.belowType, 'STOP_LOSS');
  assert.equal(seen.params.aboveStopPrice, '4000');
  assert.equal(seen.params.belowTrailingDelta, 125);
  assert.equal(seen.params.belowStopPrice, undefined);
});
