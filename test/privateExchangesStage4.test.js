// Stage 4 — özel API adaptörleri: mock tabanlı sözleşme testleri.
// !!! Bu testler gerçek borsa sunucularına BAĞLANMAZ. Borsa davranışının kanıtı DEĞİLDİR; yalnızca
// adaptörün belgelenmiş istek biçimini, belirsiz-sonuç sınıflandırmasını ve kurtarma akışını doğrular.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createExchange } = require('../src/exchanges');
const { OrderManager } = require('../src/orderManager');

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const SECRET_B64 = Buffer.from('secret').toString('base64');
const CID = 'market-mgqx1abc-0123456789';

function res(body, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { if (body === undefined) throw new Error('bad json'); return body; }, headers: { get() { return null; } } }; }
function install(route) {
  const calls = []; const old = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { url: String(url), path: u.pathname, search: u.search, method: String(init.method || 'GET').toUpperCase(), headers: init.headers || {}, raw: init.body, body: init.body ? safeJson(init.body) : undefined };
    calls.push(call);
    return route(call, calls);
  };
  return { calls, restore() { global.fetch = old; } };
}
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return Object.fromEntries(new URLSearchParams(s)); } }
const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };

// Her borsa için: oluşturma/sorgu yönlendiricisi ve belgelenmiş alan kontrolleri.
const SPECS = {
  coinbaseexchange: {
    opts: { apiKey: 'key', apiSecret: SECRET_B64, apiPassphrase: 'pass', nowFn: () => NOW }, symbol: 'BTC/USD',
    isPost: (c) => c.method === 'POST' && c.path === '/orders',
    created: (c) => res({ id: 'cb-1', client_oid: c.body.client_oid, status: 'pending', side: 'buy', product_id: 'BTC-USD', size: '0.01' }),
    isQuery: (c) => c.method === 'GET' && c.path.startsWith('/orders/'),
    queried: () => res({ id: 'cb-1', status: 'done', done_reason: 'filled', filled_size: '0.01', executed_value: '600', fill_fees: '2.4', side: 'buy', product_id: 'BTC-USD', size: '0.01' }),
    notFound: () => res({ message: 'NotFound' }, 404),
    reject: () => res({ message: 'Insufficient funds' }, 400),
    checkPost: (c) => { assert.equal(c.body.type, 'market'); assert.equal(c.body.side, 'buy'); assert.equal(c.body.product_id, 'BTC-USD'); assert.equal(c.body.size, '0.01'); assert.match(c.body.client_oid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); },
    checkQueryByCid: (c) => assert.match(c.path, /^\/orders\/client:[0-9a-f-]{36}$/)
  },
  kraken: {
    opts: { apiKey: 'key', apiSecret: SECRET_B64, nowFn: () => NOW }, symbol: 'BTC/USD',
    isPost: (c) => c.path === '/0/private/AddOrder',
    created: () => res({ error: [], result: { txid: ['OABC-1'], descr: { order: 'buy 0.01 XBTUSD @ market' } } }),
    isQuery: (c) => ['/0/private/QueryOrders', '/0/private/OpenOrders', '/0/private/ClosedOrders'].includes(c.path),
    queried: (c) => c.path === '/0/private/QueryOrders'
      ? res({ error: [], result: { 'OABC-1': { status: 'closed', vol: '0.01', vol_exec: '0.01', cost: '600', fee: '1.5', descr: { pair: 'XBTUSD', type: 'buy' } } } })
      : c.path === '/0/private/OpenOrders' ? res({ error: [], result: { open: {} } })
      : res({ error: [], result: { closed: { 'OABC-1': { status: 'closed', vol: '0.01', vol_exec: '0.01', cost: '600', fee: '1.5', descr: { pair: 'XBTUSD', type: 'buy' } } }, count: 1 } }),
    notFound: (c) => c.path === '/0/private/QueryOrders' ? res({ error: [], result: {} }) : c.path === '/0/private/OpenOrders' ? res({ error: [], result: { open: {} } }) : res({ error: [], result: { closed: {}, count: 0 } }),
    reject: () => res({ error: ['EOrder:Insufficient funds'], result: {} }),
    checkPost: (c) => { assert.equal(c.body.ordertype, 'market'); assert.equal(c.body.type, 'buy'); assert.equal(c.body.pair, 'XBTUSD'); assert.equal(c.body.volume, '0.01'); assert.match(c.body.cl_ord_id, /^[0-9a-f-]{36}$/); assert.ok(c.body.nonce); },
    checkQueryByCid: (c) => { assert.match(c.body.cl_ord_id, /^[0-9a-f-]{36}$/); }
  },
  bitstamp: {
    opts: { apiKey: 'key', apiSecret: 'secret', nowFn: () => NOW, nonceFn: () => 'nonce-1' }, symbol: 'BTC/USD',
    isPost: (c) => c.path === '/api/v2/buy/market/btcusd/',
    created: (c) => res({ id: '123', datetime: '2026-10-14 12:00:00', type: '0', price: '0', amount: '0.01', client_order_id: c.body.client_order_id }),
    isQuery: (c) => c.path === '/api/v2/order_status/',
    queried: () => res({ id: '123', status: 'Finished', amount_remaining: '0', transactions: [{ tid: 1, price: '60000', usd: '-600', btc: '0.01', fee: '1.5', type: '2' }] }),
    notFound: () => res({ status: 'error', reason: 'Order not found.', code: '404.002' }, 404),
    reject: () => res({ status: 'error', reason: { __all__: ['You have only 1 USD available.'] }, code: 'API0001' }, 400),
    checkPost: (c) => { assert.equal(c.body.amount, '0.01'); assert.match(c.body.client_order_id, /^[0-9a-f-]{36}$/); },
    checkQueryByCid: (c) => assert.match(c.body.client_order_id, /^[0-9a-f-]{36}$/)
  },
  okx: {
    opts: { apiKey: 'key', apiSecret: 'secret', apiPassphrase: 'pass', nowFn: () => NOW }, symbol: 'BTC/USDT',
    isPost: (c) => c.path === '/api/v5/trade/order' && c.method === 'POST',
    created: (c) => res({ code: '0', msg: '', data: [{ ordId: '99', clOrdId: c.body.clOrdId, sCode: '0', sMsg: '' }] }),
    isQuery: (c) => c.path === '/api/v5/trade/order' && c.method === 'GET',
    queried: () => res({ code: '0', msg: '', data: [{ ordId: '99', instId: 'BTC-USDT', side: 'buy', sz: '0.01', accFillSz: '0.01', avgPx: '60000', state: 'filled', fee: '-0.00001', feeCcy: 'BTC' }] }),
    notFound: () => res({ code: '51603', msg: 'Order does not exist', data: [] }),
    reject: () => res({ code: '1', msg: 'All operations failed', data: [{ sCode: '51008', sMsg: 'Insufficient balance' }] }),
    checkPost: (c) => { assert.equal(c.body.tdMode, 'cash'); assert.equal(c.body.ordType, 'market'); assert.equal(c.body.tgtCcy, 'base_ccy'); assert.equal(c.body.instId, 'BTC-USDT'); assert.equal(c.body.sz, '0.01'); assert.match(c.body.clOrdId, /^[A-Za-z0-9]{1,32}$/); },
    checkQueryByCid: (c) => assert.match(new URL(c.url).searchParams.get('clOrdId'), /^[A-Za-z0-9]{1,32}$/)
  },
  okxtr: null, // aşağıda okx spec'inden türetilir
  bybittr: {
    opts: { apiKey: 'key', apiSecret: 'secret', nowFn: () => NOW }, symbol: 'BTC/USDT',
    isPost: (c) => c.path === '/v5/order/create',
    created: (c) => res({ retCode: 0, retMsg: 'OK', result: { orderId: 'by-1', orderLinkId: c.body.orderLinkId } }),
    isQuery: (c) => c.method === 'GET' && (c.path === '/v5/order/realtime' || c.path === '/v5/order/history'),
    queried: (c) => res({ retCode: 0, retMsg: 'OK', result: { list: new URL(c.url).searchParams.get('orderFilter') === 'Order' ? [{ orderId: 'by-1', orderLinkId: new URL(c.url).searchParams.get('orderLinkId') || CID, symbol: 'BTCUSDT', side: 'Buy', orderStatus: 'Filled', qty: '0.01', cumExecQty: '0.01', cumExecValue: '600', cumExecFee: '0.00001', feeCurrency: 'BTC' }] : [] } }),
    notFound: () => res({ retCode: 0, retMsg: 'OK', result: { list: [] } }),
    reject: () => res({ retCode: 110007, retMsg: 'Insufficient available balance', result: {} }),
    checkPost: (c) => { assert.equal(c.body.category, 'spot'); assert.equal(c.body.side, 'Buy'); assert.equal(c.body.orderType, 'Market'); assert.equal(c.body.marketUnit, 'baseCoin'); assert.equal(c.body.symbol, 'BTCUSDT'); assert.equal(c.body.qty, '0.01'); assert.equal(c.body.orderLinkId, CID); },
    checkQueryByCid: (c) => assert.equal(new URL(c.url).searchParams.get('orderLinkId'), CID)
  }
};
SPECS.okxtr = { ...SPECS.okx };

function make(id) { return createExchange(id, SPECS[id].opts); }
function router(spec, { post, query }) {
  return (c) => spec.isPost(c) ? post(c) : spec.isQuery(c) ? query(c) : res({ error: 'beklenmeyen istek', path: c.path }, 599);
}

for (const id of ['coinbaseexchange', 'kraken', 'bitstamp', 'okx', 'okxtr', 'bybittr']) {
  const spec = SPECS[id];

  test(`${id}: market emir belgelenmiş biçimde TEK POST ile gider ve dolum durumu sorgulanır`, async () => {
    const ex = make(id);
    const h = install(router(spec, { post: spec.created, query: spec.queried }));
    try {
      const o = await ex.createMarketOrder(spec.symbol, 'buy', 0.01, CID);
      assert.equal(h.calls.filter((c) => spec.isPost(c)).length, 1);
      spec.checkPost(h.calls.find((c) => spec.isPost(c)));
      assert.equal(o.status, 'FILLED');
      assert.equal(o.executedQty, 0.01);
      assert.ok(o.orderId, 'orderId (OrderManager/Reconciler alanı) olmalı');
      assert.equal(o.exchangeOrderId, o.orderId);
      assert.equal(o.clientOrderId, CID, 'botun kimliği geri döner');
      assert.ok(o.fills.length === 1 && o.fills[0].commission > 0, 'komisyon aktarılır');
    } finally { h.restore(); }
  });

  test(`${id}: POST sonrası zaman aşımı => unknownOutcome, tekrar POST yok`, async () => {
    const ex = make(id);
    const h = install(() => abort());
    try {
      await assert.rejects(() => ex.createMarketOrder(spec.symbol, 'buy', 0.01, CID), (e) => e.unknownOutcome === true);
      assert.equal(h.calls.length, 1);
    } finally { h.restore(); }
  });

  test(`${id}: 5xx ve çözümlenemeyen yanıt => unknownOutcome; borsa reddi => unknownOutcome DEĞİL`, async () => {
    const ex = make(id);
    let h = install(() => res({ message: 'down' }, 503));
    try { await assert.rejects(() => ex.createMarketOrder(spec.symbol, 'buy', 0.01, CID), (e) => e.unknownOutcome === true && e.httpStatus === 503); assert.equal(h.calls.length, 1); } finally { h.restore(); }
    h = install(() => res(undefined, 200));
    try { await assert.rejects(() => ex.createMarketOrder(spec.symbol, 'buy', 0.01, CID), (e) => e.unknownOutcome === true); } finally { h.restore(); }
    h = install(router(spec, { post: spec.reject, query: spec.queried }));
    try { await assert.rejects(() => ex.createMarketOrder(spec.symbol, 'buy', 0.01, CID), (e) => !e.unknownOutcome); } finally { h.restore(); }
  });

  test(`${id}: yeniden başlatma sonrası yalnızca clientOrderId ile getOrder sorgusu yapılır`, async () => {
    const ex = make(id);
    const h = install(router(spec, { post: spec.created, query: spec.queried }));
    try {
      const o = await ex.getOrder(spec.symbol, null, CID);
      assert.equal(o.status, 'FILLED');
      assert.equal(o.clientOrderId, CID);
      spec.checkQueryByCid(h.calls.find((c) => spec.isQuery(c)));
    } finally { h.restore(); }
  });

  test(`${id}: sorguda "bulunamadı" emir yok kanıtı sayılmaz (orderNotFound işaretlenir)`, async () => {
    const ex = make(id);
    const h = install(router(spec, { post: spec.created, query: spec.notFound }));
    try {
      await assert.rejects(() => ex.getOrder(spec.symbol, null, CID), (e) => e.orderNotFound === true && !e.unknownOutcome);
    } finally { h.restore(); }
  });

  test(`${id}: oluşturma başarılı ama durum sorgusu bulunamazsa kabul edilmiş emir NEW olarak korunur`, async () => {
    const ex = make(id);
    const h = install(router(spec, { post: spec.created, query: spec.notFound }));
    try {
      const o = await ex.createMarketOrder(spec.symbol, 'buy', 0.01, CID);
      assert.equal(o.status, 'NEW');
      assert.ok(o.orderId);
    } finally { h.restore(); }
  });

  test(`${id}: OrderManager ile uçtan uca — belirsiz POST, tek POST, yeniden başlatma sonrası FILLED`, async () => {
    const ex = make(id);
    ex.capabilities.liveTradingVerified = true; // YALNIZCA bu testte kanıt tamamlanmış gibi davranılır
    const state = { liveOrders: {} }; const store = { save() {} };
    let h = install(() => abort());
    try {
      const om = new OrderManager({ exchange: ex, state, store });
      const first = await om.submitMarket({ symbol: spec.symbol, side: 'buy', amount: 0.01, clientOrderId: CID });
      assert.equal(first.status, 'UNKNOWN');
      const again = await om.submitMarket({ symbol: spec.symbol, side: 'buy', amount: 0.01, clientOrderId: CID });
      assert.equal(again.reused, true);
      assert.equal(h.calls.length, 1, 'ikinci POST gönderilmemeli');
    } finally { h.restore(); }
    // "Yeniden başlatma": yeni OrderManager, aynı kalıcı state; borsa artık emri biliyor.
    h = install(router(spec, { post: () => res({ error: 'POST olmamalı' }, 599), query: spec.queried }));
    try {
      const om2 = new OrderManager({ exchange: make(id), state, store });
      om2.exchange.capabilities.liveTradingVerified = true;
      const rec = await om2.reconcile(CID);
      assert.equal(rec.status, 'FILLED');
      assert.equal(h.calls.filter((c) => spec.isPost(c)).length, 0);
    } finally { h.restore(); }
  });
}

// ---- borsaya özgü sözleşme ayrıntıları ----------------------------------------------------------

test('Kraken: belgelenmiş API-Sign örnek vektörü birebir eşleşir', () => {
  const k = createExchange('kraken', { apiKey: 'k', apiSecret: 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==' });
  const post = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
  assert.equal(k._sign('/0/private/AddOrder', '1616492376594', post), '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
});

test('Kraken: nonce kesin artar (aynı milisaniyede bile) ve EService hatası belirsiz sayılır', async () => {
  const k = createExchange('kraken', { apiKey: 'k', apiSecret: SECRET_B64, nowFn: () => NOW });
  const a = BigInt(k._nextNonce()), b = BigInt(k._nextNonce());
  assert.ok(b > a);
  let h = install(() => res({ error: ['EService:Unavailable'], result: {} }));
  try { await assert.rejects(() => k.createMarketOrder('BTC/USD', 'buy', 0.01, CID), (e) => e.unknownOutcome === true); } finally { h.restore(); }
  h = install(() => res({ error: ['EOrder:Insufficient funds'], result: {} }));
  try { await assert.rejects(() => k.createMarketOrder('BTC/USD', 'buy', 0.01, CID), (e) => !e.unknownOutcome); } finally { h.restore(); }
});

test('Kraken: bakiye BalanceEx ile kullanılabilir = balance - hold_trade; stake varlıkları sayılmaz; varlık kodları çevrilir', async () => {
  const k = createExchange('kraken', { apiKey: 'k', apiSecret: SECRET_B64, nowFn: () => NOW });
  const h = install(() => res({ error: [], result: { XXBT: { balance: '1.0', hold_trade: '0.25' }, ZUSD: { balance: '100', hold_trade: '0' }, 'ETH.F': { balance: '5', hold_trade: '0' } } }));
  try {
    const b = await k.fetchBalance();
    assert.deepEqual(b, { BTC: { free: 0.75, locked: 0.25 }, USD: { free: 100, locked: 0 } });
  } finally { h.restore(); }
});

test('Coinbase: imza = base64(HMAC-SHA256(base64decode(secret), ts+METHOD+path+body)) ve istek yolu sorguyu içerir', async () => {
  const ex = make('coinbaseexchange');
  const h = install(() => res([]));
  try {
    await ex.fetchOpenOrders(['BTC/USD']);
    const c = h.calls[0];
    const ts = c.headers['CB-ACCESS-TIMESTAMP'];
    assert.equal(ts, String(Math.floor(NOW / 1000)));
    const requestPath = `${c.path}${c.search}`;
    assert.match(requestPath, /^\/orders\?status=open&status=active&status=pending&limit=100&product_id=BTC-USD$/);
    const expected = crypto.createHmac('sha256', Buffer.from(SECRET_B64, 'base64')).update(`${ts}GET${requestPath}`).digest('base64');
    assert.equal(c.headers['CB-ACCESS-SIGN'], expected);
    assert.equal(c.headers['CB-ACCESS-PASSPHRASE'], 'pass');
  } finally { h.restore(); }
});

test('Coinbase: 100 açık emir sayfalama sınırı eksik liste sayılır ve işlem durdurulur; 404 mesajı belirsizliği söyler', async () => {
  const ex = make('coinbaseexchange');
  let h = install(() => res(Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, status: 'open', side: 'buy', product_id: 'BTC-USD', size: '1', filled_size: '0' }))));
  try { await assert.rejects(() => ex.fetchOpenOrders(['BTC/USD']), /sayfalama/); } finally { h.restore(); }
  h = install(() => res({ message: 'NotFound' }, 404));
  try { await assert.rejects(() => ex.getOrder('BTC/USD', 'x'), /kanıtı değildir/); } finally { h.restore(); }
});

test('Coinbase: mükerrer client_oid hatası emir var olabilir => unknownOutcome', async () => {
  const ex = make('coinbaseexchange');
  const h = install(() => res({ message: 'client_oid already used' }, 400));
  try { await assert.rejects(() => ex.createMarketOrder('BTC/USD', 'buy', 0.01, CID), (e) => e.unknownOutcome === true); } finally { h.restore(); }
});

test('Coinbase: stop-limit emri stop=loss + stop_price ile gider, limit stop fiyatını aşamaz', async () => {
  const ex = make('coinbaseexchange');
  const h = install((c) => {
    if (c.method === 'GET' && c.path === '/products/BTC-USD') return res({ id: 'BTC-USD', status: 'online', base_increment: '0.00000001', quote_increment: '0.01', base_min_size: '0.0001', base_max_size: '1000', min_market_funds: '1' });
    if (c.method === 'POST') return res({ id: 'st-1', client_oid: c.body.client_oid, status: 'pending', side: 'sell', product_id: 'BTC-USD', size: '0.01', stop_price: '59000' });
    return res({ message: 'NotFound' }, 404);
  });
  try {
    const o = await ex.createStopOrder('BTC/USD', 'sell', 0.01, 59000, 0, 'stop-1');
    const post = h.calls.find((c) => c.method === 'POST');
    assert.equal(post.body.stop, 'loss'); assert.equal(post.body.stop_price, '59000'); assert.equal(post.body.type, 'limit');
    assert.ok(Number(post.body.price) <= 59000 && Number(post.body.price) > 0);
    assert.equal(o.orderId, 'st-1');
    await assert.rejects(() => ex.createStopOrder('BTC/USD', 'sell', 0.01, 59000, 60000, 'stop-2'), /limit fiyatı stop fiyatını aşamaz/);
  } finally { h.restore(); }
});

test('Bitstamp: v2 imza mesajı belgelenmiş sırada kurulur; gövdesiz istekte Content-Type yok', () => {
  const ex = make('bitstamp');
  const withBody = ex._buildRequest('/buy/market/btcusd/', { amount: '0.01', client_order_id: 'abc' });
  const expectedMsg = `BITSTAMP keyPOSTwww.bitstamp.net/api/v2/buy/market/btcusd/application/x-www-form-urlencoded` + `nonce-1${NOW}v2amount=0.01&client_order_id=abc`;
  assert.equal(withBody._message, expectedMsg);
  assert.equal(withBody.headers['X-Auth-Signature'], crypto.createHmac('sha256', 'secret').update(expectedMsg).digest('hex'));
  assert.equal(withBody.headers['X-Auth'], 'BITSTAMP key');
  assert.equal(withBody.headers['X-Auth-Version'], 'v2');
  const noBody = ex._buildRequest('/balance/');
  assert.equal(noBody.headers['Content-Type'], undefined);
  assert.equal(noBody._message, `BITSTAMP keyPOSTwww.bitstamp.net/api/v2/balance/nonce-1${NOW}v2`);
});

test('Bitstamp: 400.019 mükerrer client_order_id => unknownOutcome; "Finished" ama kalan > 0 => UNKNOWN durum', async () => {
  const ex = make('bitstamp');
  let h = install(() => res({ status: 'error', reason: 'Provided client_order_id already exists.', code: '400.019' }, 400));
  try { await assert.rejects(() => ex.createMarketOrder('BTC/USD', 'buy', 0.01, CID), (e) => e.unknownOutcome === true); } finally { h.restore(); }
  h = install(() => res({ id: '1', status: 'Finished', amount_remaining: '0.005', transactions: [{ btc: '0.005', usd: '-300', fee: '1' }] }));
  try { const o = await ex.getOrder('BTC/USD', '1'); assert.equal(o.status, 'UNKNOWN'); } finally { h.restore(); }
});

test('OKX: imza ISO zaman damgası ile; demo başlığı yalnızca simulated iken; clOrdId ≤32 alfanümerik ve deterministik', async () => {
  const ex = make('okx');
  const h = install(() => res({ code: '0', data: [{ details: [{ ccy: 'USDT', availBal: '10', frozenBal: '1' }] }] }));
  try {
    const b = await ex.fetchBalance();
    assert.deepEqual(b, { USDT: { free: 10, locked: 1 } });
    const c = h.calls[0];
    const ts = new Date(NOW).toISOString();
    assert.equal(c.headers['OK-ACCESS-TIMESTAMP'], ts);
    assert.equal(c.headers['OK-ACCESS-SIGN'], crypto.createHmac('sha256', 'secret').update(`${ts}GET/api/v5/account/balance`).digest('base64'));
    assert.equal(c.headers['x-simulated-trading'], undefined);
  } finally { h.restore(); }
  const sim = createExchange('okx', { ...SPECS.okx.opts, simulated: true });
  assert.equal(sim._buildRequest('GET', '/api/v5/account/balance').headers['x-simulated-trading'], '1');
  assert.equal(ex._clOrdId(CID), ex._clOrdId(CID));
  assert.match(ex._clOrdId(CID), /^[a-f0-9]{32}$/);
  assert.notEqual(ex._clOrdId(CID), ex._clOrdId(`${CID}x`));
});

test('OKX: sCode 51149 ve 50001 belirsiz; 51008 kesin ret; OKX TR varsayılan host tr.okx.com', async () => {
  const ex = make('okx');
  let h = install(() => res({ code: '1', msg: 'fail', data: [{ sCode: '51149', sMsg: 'Order timed out' }] }));
  try { await assert.rejects(() => ex.createMarketOrder('BTC/USDT', 'buy', 0.01, CID), (e) => e.unknownOutcome === true); } finally { h.restore(); }
  h = install(() => res({ code: '50001', msg: 'Service temporarily unavailable', data: [] }));
  try { await assert.rejects(() => ex.createMarketOrder('BTC/USDT', 'buy', 0.01, CID), (e) => e.unknownOutcome === true); } finally { h.restore(); }
  assert.equal(new URL(createExchange('okxtr').baseUrl).hostname, 'tr.okx.com');
  assert.equal(createExchange('okxtr').id, 'okxtr');
});

test('OKX: koruyucu stop algo emridir (conditional, slOrdPx=-1); orderId "algo:" öneki taşır ve iptal cancel-algos kullanır', async () => {
  const ex = make('okx');
  const h = install((c) => {
    if (c.path === '/api/v5/trade/order-algo' && c.method === 'POST') return res({ code: '0', data: [{ algoId: '777', algoClOrdId: c.body.algoClOrdId, sCode: '0' }] });
    if (c.path === '/api/v5/trade/order-algo' && c.method === 'GET') return res({ code: '0', data: [{ algoId: '777', state: 'live', instId: 'BTC-USDT', sz: '0.01', slTriggerPx: '59000' }] });
    if (c.path === '/api/v5/trade/cancel-algos') return res({ code: '0', data: [{ algoId: '777', sCode: '0' }] });
    return res({ code: '1', data: [] }, 599);
  });
  try {
    const o = await ex.createStopOrder('BTC/USDT', 'sell', 0.01, 59000, 0, 'stop-1');
    const post = h.calls.find((c) => c.method === 'POST');
    assert.equal(post.body.ordType, 'conditional'); assert.equal(post.body.slOrdPx, '-1'); assert.equal(post.body.slTriggerPx, '59000');
    assert.match(post.body.algoClOrdId, /^[a-f0-9]{32}$/);
    assert.equal(o.orderId, 'algo:777');
    const c = await ex.cancelOrder('BTC/USDT', 'algo:777');
    assert.deepEqual(h.calls.find((x) => x.path === '/api/v5/trade/cancel-algos').body, [{ algoId: '777', instId: 'BTC-USDT' }]);
    assert.equal(c.status, 'UNKNOWN', 'iptal sonrası durum hâlâ live ise CANCELED varsayılmaz');
  } finally { h.restore(); }
});

test('Bybit TR: imza timestamp+apiKey+recvWindow+gövde; alım emri marketUnit=baseCoin; mükerrer orderLinkId belirsiz', async () => {
  const ex = make('bybittr');
  const h = install(() => res({ retCode: 0, result: { orderId: 'x', orderLinkId: CID } }));
  try {
    await ex.createMarketOrder('BTC/USDT', 'buy', 0.01, CID).catch(() => {});
    const c = h.calls.find((x) => x.path === '/v5/order/create');
    assert.equal(c.url.startsWith('https://api.bybit.tr/'), true);
    const expected = crypto.createHmac('sha256', 'secret').update(`${NOW}key5000${c.raw}`).digest('hex');
    assert.equal(c.headers['X-BAPI-SIGN'], expected);
    assert.equal(c.body.marketUnit, 'baseCoin');
  } finally { h.restore(); }
  const h2 = install(() => res({ retCode: 110072, retMsg: 'OrderLinkedID is duplicate', result: {} }));
  try { await assert.rejects(() => ex.createMarketOrder('BTC/USDT', 'buy', 0.01, CID), (e) => e.unknownOutcome === true); } finally { h2.restore(); }
  await assert.rejects(() => ex.createMarketOrder('BTC/USDT', 'buy', 0.01, 'bad id with spaces'), /orderLinkId/);
});

test('Bybit TR: GET imzası sorgu dizesini kullanır; spot adım büyüklüğü basePrecision', async () => {
  const ex = make('bybittr');
  const h = install((c) => c.path === '/v5/market/instruments-info'
    ? res({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', status: 'Trading', lotSizeFilter: { basePrecision: '0.000001', minOrderQty: '0.00004', maxOrderQty: '100', minOrderAmt: '1' }, priceFilter: { tickSize: '0.01' } }] } })
    : res({ retCode: 0, result: { list: [{ coin: [{ coin: 'USDT', walletBalance: '10', locked: '3' }] }] } }));
  try {
    const rules = await ex.fetchSymbolRules('BTC/USDT');
    assert.equal(rules.stepSize, 0.000001); assert.equal(rules.minQty, 0.00004); assert.equal(rules.minNotional, 1); assert.equal(rules.tickSize, 0.01);
    const b = await ex.fetchBalance();
    assert.deepEqual(b, { USDT: { free: 7, locked: 3 } });
    const c = h.calls.find((x) => x.path === '/v5/account/wallet-balance');
    assert.equal(c.headers['X-BAPI-SIGN'], crypto.createHmac('sha256', 'secret').update(`${NOW}key5000accountType=UNIFIED`).digest('hex'));
  } finally { h.restore(); }
});

// ---- Paribu ----------------------------------------------------------------------------------

test('Paribu: emir sonuçları OrderManager/Reconciler uyumlu orderId alanını da taşır (önceden yalnızca exchangeOrderId)', async () => {
  const ex = createExchange('paribu', { apiKey: 'k', apiSecret: 's' });
  const o = ex._normalizeOrder({ id: '42', market: 'btc_tl', trade: 'buy', status: 'open', amount: '0.01' });
  assert.equal(o.orderId, '42'); assert.equal(o.exchangeOrderId, '42');
  const h = install(() => res([{ id: '7', market: 'btc_tl', trade: 'sell', status: 'open', amount: '1' }]));
  try { const list = await ex.fetchOpenOrders(['BTC/TRY']); assert.equal(list[0].orderId, '7'); } finally { h.restore(); }
});

test('Paribu: kurtarma kanıtı danışma amaçlıdır — hiçbir durumda otomatik sahiplenmez, fingerprint kapalı kalır', async () => {
  const ex = createExchange('paribu', { apiKey: 'k', apiSecret: 's' });
  assert.equal(ex.capabilities.recoveryByFingerprint, false);
  assert.equal(await ex.findOrderForRecovery({ clientOrderId: 'x' }), null);
  const before = { openOrderIds: ['1'], balance: { TRY: { free: 1000, locked: 0 }, BTC: { free: 0, locked: 0 } } };
  const none = ex.assessUnknownOrder(before, { openOrderIds: ['1'], balance: before.balance });
  assert.equal(none.verdict, 'NO_EVIDENCE'); assert.match(none.reasons.join(' '), /kanıtı DEĞİLDİR/);
  const one = ex.assessUnknownOrder(before, { openOrderIds: ['1', '2'], balance: before.balance });
  assert.equal(one.verdict, 'LIKELY_PRESENT'); assert.deepEqual(one.newOpenOrderIds, ['2']);
  const many = ex.assessUnknownOrder(before, { openOrderIds: ['1', '2', '3'], balance: before.balance });
  assert.equal(many.verdict, 'AMBIGUOUS');
  const filled = ex.assessUnknownOrder(before, { openOrderIds: ['1'], balance: { TRY: { free: 400, locked: 0 }, BTC: { free: 0.0002, locked: 0 } } });
  assert.equal(filled.verdict, 'LIKELY_FILLED_OR_MANUAL');
  for (const r of [none, one, many, filled]) { assert.equal(r.autoAdopt, false); assert.equal(r.requiresOperator, true); }
});

// ---- Düzeltme turu: tarayıcı ticker şekli, Bitstamp stop-limit, kasa passphrase -------------------

const SCANNER_KEYS = ['symbol', 'lastPrice', 'changePct', 'quoteVolume', 'highPrice', 'lowPrice'];
function assertScannerRow(r, symbol) {
  for (const k of SCANNER_KEYS) assert.ok(k in r, `${k} yok`);
  assert.equal(r.symbol, symbol);
  assert.ok(Number.isFinite(r.lastPrice) && r.lastPrice > 0);
  assert.ok(Number.isFinite(r.quoteVolume) && r.quoteVolume > 0, 'quoteVolume tarayıcı filtresi için sayı olmalı');
}

test('Tarayıcı uyumu: tüm yeni adaptörlerin fetchAllTickers24h çıktısı quoteVolume/lastPrice/changePct içerir', async () => {
  const { scan } = require('../src/scanner');
  const cases = [
    ['kraken', (c) => c.path === '/0/public/Ticker' ? res({ error: [], result: { XXBTZUSD: { c: ['60000', '1'], o: '58000', v: ['10', '100'], p: ['59000', '59500'], h: ['61000', '62000'], l: ['57000', '56000'] } } }) : res({ error: [], result: { XXBTZUSD: { wsname: 'XBT/USD' } } }), 'BTC/USD', 100 * 59500],
    ['bitstamp', () => res([{ pair: 'BTC/USD', last: '60000', open: '58000', volume: '100', vwap: '59500', high: '62000', low: '56000' }]), 'BTC/USD', 100 * 59500],
    ['okx', () => res({ code: '0', data: [{ instId: 'BTC-USDT', last: '60000', open24h: '58000', volCcy24h: '5950000', vol24h: '100', high24h: '62000', low24h: '56000' }] }), 'BTC/USDT', 5950000],
    ['okxtr', () => res({ code: '0', data: [{ instId: 'BTC-TRY', last: '2000000', open24h: '1900000', volCcy24h: '9000000', vol24h: '4', high24h: '2100000', low24h: '1800000' }] }), 'BTC/TRY', 9000000],
    ['bybittr', () => res({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '60000', price24hPcnt: '0.05', turnover24h: '7000000', volume24h: '120', highPrice24h: '62000', lowPrice24h: '56000' }, { symbol: 'WEIRDXYZ', lastPrice: '1' }] } }), 'BTC/USDT', 7000000],
    ['coinbaseexchange', (c) => c.path === '/products' ? res([{ id: 'BTC-USD', status: 'online', quote_currency: 'USD' }, { id: 'ETH-BTC', status: 'online', quote_currency: 'BTC' }]) : res({ last: '60000', open: '58000', high: '62000', low: '56000', volume: '100' }), 'BTC/USD', 6000000]
  ];
  for (const [id, route, symbol, qv] of cases) {
    const ex = createExchange(id);
    const h = install(route);
    try {
      const rows = await ex.fetchAllTickers24h();
      assert.equal(rows.length, 1, `${id}: yalnızca eşlenebilen satırlar`);
      assertScannerRow(rows[0], symbol);
      assert.equal(rows[0].quoteVolume, qv, id);
      const found = await scan({ fetchAllTickers24h: async () => rows }, { minVolume: 1 });
      assert.equal(found.length, 1, `${id}: scan() satırı kabul etmeli`);
    } finally { h.restore(); }
  }
});

test('Bybit TR: 24s değişim yüzdesi price24hPcnt (kesir) ile tutarlı hesaplanır', async () => {
  const ex = createExchange('bybittr');
  const h = install(() => res({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '105', price24hPcnt: '0.05', turnover24h: '1', volume24h: '1', highPrice24h: '110', lowPrice24h: '100' }] } }));
  try { const [r] = await ex.fetchAllTickers24h(); assert.ok(Math.abs(r.changePct - 5) < 1e-9); } finally { h.restore(); }
});

test('Bitstamp: koruyucu stop = stop-limit satış (stop_price + price), limit stop fiyatını aşamaz, tick değerine yuvarlanır', async () => {
  const ex = make('bitstamp');
  const h = install((c) => {
    if (c.path === '/api/v2/trading-pairs-info/') return res([{ url_symbol: 'btcusd', trading: 'Enabled', base_decimals: 8, counter_decimals: 2, minimum_order: '10.0 USD' }]);
    if (c.path === '/api/v2/sell/btcusd/') return res({ id: '555', type: '1', amount: '0.01', price: '58410', client_order_id: c.body.client_order_id });
    if (c.path === '/api/v2/order_status/') return res({ id: '555', status: 'Open', amount_remaining: '0.01', transactions: [] });
    return res({ error: 'beklenmeyen' }, 599);
  });
  try {
    const o = await ex.createStopOrder('BTC/USD', 'sell', 0.01, 59000.123, 0, 'stop-1');
    const post = h.calls.find((c) => c.path === '/api/v2/sell/btcusd/');
    assert.equal(post.body.stop_price, '59000.12');
    assert.ok(Number(post.body.price) < 59000.12 && Number(post.body.price) > 0);
    assert.equal(post.body.amount, '0.01');
    assert.match(post.body.client_order_id, /^[0-9a-f-]{36}$/);
    assert.equal(o.orderId, '555'); assert.equal(o.status, 'NEW');
    await assert.rejects(() => ex.createStopOrder('BTC/USD', 'sell', 0.01, 59000, 60000, 'stop-2'), /limit fiyatı stop fiyatını aşamaz/);
    await assert.rejects(() => ex.createStopOrder('BTC/USD', 'buy', 0.01, 59000, 0, 'stop-3'), /yalnızca sell/);
  } finally { h.restore(); }
});

test('Kasa: passphrase AAD ile şifreli saklanır, geri okunur; passphrase yoksa eski çıktı biçimi korunur', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-pp-'));
  const prev = process.env.BOT_DATA_DIR; process.env.BOT_DATA_DIR = dir;
  for (const k of Object.keys(require.cache)) if (k.endsWith(`${path.sep}src${path.sep}vault.js`)) delete require.cache[k];
  try {
    const vault = require('../src/vault');
    vault.unlock('correct horse battery staple');
    vault.saveExchangeKeys('okx', 'KEY-OKX-1', 'SECRET-OKX-1', 'PASSPHRASE-1');
    vault.saveExchangeKeys('kraken', 'KEY-KR-1', 'SECRET-KR-1');
    assert.deepEqual(vault.getExchangeKeys('okx'), { apiKey: 'KEY-OKX-1', apiSecret: 'SECRET-OKX-1', apiPassphrase: 'PASSPHRASE-1' });
    assert.deepEqual(vault.getExchangeKeys('kraken'), { apiKey: 'KEY-KR-1', apiSecret: 'SECRET-KR-1' });
    const files = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.ok(!files.includes('PASSPHRASE-1'), 'passphrase düz metin olarak diske yazılmamalı');
    // Başka borsanın alanına taşınan şifreli passphrase çözülememeli (AAD bağı)
    const credFile = fs.readdirSync(dir).find((f) => /cred|vault/i.test(f) && !f.endsWith('.bak'));
    assert.ok(credFile, 'kasa dosyası bulunamadı (test boş geçmemeli)');
    if (credFile) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, credFile), 'utf8'));
      j.exchanges.kraken.apiPassphrase = j.exchanges.okx.apiPassphrase;
      fs.writeFileSync(path.join(dir, credFile), JSON.stringify(j));
      assert.throws(() => vault.getExchangeKeys('kraken'), /çözülemedi/);
    }
  } finally {
    if (prev === undefined) delete process.env.BOT_DATA_DIR; else process.env.BOT_DATA_DIR = prev;
    for (const k of Object.keys(require.cache)) if (k.endsWith(`${path.sep}src${path.sep}vault.js`)) delete require.cache[k];
  }
});
