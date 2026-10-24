const test = require('node:test');
const assert = require('node:assert/strict');
const { checkMarketOrderSafety } = require('../src/marketSafety');
const Binance = require('../src/exchanges/binance');
const BinanceTr = require('../src/exchanges/binancetr');
const Btcturk = require('../src/exchanges/btcturk');
const Paribu = require('../src/exchanges/paribu');

test('market safety: dar spread + yeterli depth BUY geçer', () => {
  const book = { bids:[[100,20],[99.9,20]], asks:[[100.1,20],[100.2,20]] };
  const r = checkMarketOrderSafety({ book, side:'buy', baseQty:1, quoteQty:100.1, marketBuyUsesQuote:true, maxSpreadPct:0.75, maxSlippagePct:0.5, minDepthCoverage:1.25 });
  assert.equal(r.ok, true);
  assert.ok(r.spreadPct < 0.75 && r.impactPct < 0.5 && r.coverage >= 1.25);
});

test('market safety: geniş spread MARKET emrini reddeder', () => {
  const book = { bids:[[99,100]], asks:[[102,100]] };
  const r = checkMarketOrderSafety({ book, side:'buy', baseQty:1, quoteQty:102, marketBuyUsesQuote:true, maxSpreadPct:0.75, maxSlippagePct:0.5, minDepthCoverage:1.25 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /spread/);
});

test('market safety: yetersiz order-book derinliği MARKET emrini reddeder', () => {
  const book = { bids:[[100,0.2]], asks:[[100.1,0.2]] };
  assert.throws(() => checkMarketOrderSafety({ book, side:'sell', baseQty:1, maxSpreadPct:1, maxSlippagePct:1, minDepthCoverage:1.25 }), /derinlik|order book/i);
});

test('market safety: kademeli defterde tahmini market etkisi hesaplanır', () => {
  const book = { bids:[[100,1],[99,1]], asks:[[101,0.1],[102,1]] };
  const r = checkMarketOrderSafety({ book, side:'buy', baseQty:0.5, maxSpreadPct:2, maxSlippagePct:0.5, minDepthCoverage:1 });
  assert.ok(r.avgPrice > 101 && r.impactPct > 0);
  assert.equal(r.ok, false);
});

test('exchange adapters: market orderbook capability açık olan üç borsa gerçek public method sunuyor', () => {
  for (const Ex of [Binance, BinanceTr, Btcturk]) {
    const ex = new Ex({ apiKey:'x', apiSecret:'x' });
    assert.equal(ex.capabilities.marketOrderBook, true);
    assert.equal(typeof ex.fetchOrderBook, 'function');
  }
});

test('Paribu: market BUY quote tutarı olarak gönderilir ve market orderbook doğrulanmadığı için live kapalı kalır', () => {
  const ex = new Paribu({ apiKey:'x', apiSecret:'x' });
  assert.equal(ex.marketBuyUsesQuote, true);
  assert.equal(ex.capabilities.marketBuyUsesQuote, true);
  assert.equal(ex.capabilities.marketOrderBook, false);
  assert.equal(ex.capabilities.clientOrderId, false);
});

test('Binance orderbook adapter: /api/v3/depth sözleşmesini normalize eder', async () => {
  const ex = new Binance({ environment:'testnet', baseUrl:'https://testnet.binance.vision' });
  const old = global.fetch;
  global.fetch = async (url) => ({ ok:true, status:200, async json(){ return { bids:[['100','2']], asks:[['101','3']] }; } });
  try { const b = await ex.fetchOrderBook('BTC/USDT', 20); assert.deepEqual(b.bids, [['100','2']]); assert.deepEqual(b.asks, [['101','3']]); } finally { global.fetch = old; }
});

test('Binance TR orderbook adapter: resmi market endpointini kullanır', async () => {
  const ex = new BinanceTr({});
  const old = global.fetch; let seen='';
  global.fetch = async (url) => { seen=String(url); return { ok:true, status:200, async json(){ return { code:0, data:{ bids:[['100','2']], asks:[['101','3']] } }; } }; };
  try { const b = await ex.fetchOrderBook('BTC/TRY', 20); assert.match(seen, /api\.binance\.me\/api\/v3\/depth\?symbol=BTCTRY/); assert.deepEqual(b.asks, [['101','3']]); } finally { global.fetch = old; }
});

test('BTCTurk orderbook adapter: resmi /api/v2/orderbook endpointini kullanır', async () => {
  const ex = new Btcturk({});
  const old = global.fetch; let seen='';
  global.fetch = async (url) => { seen=String(url); return { ok:true, status:200, async json(){ return { success:true, data:{ bids:[['100','2']], asks:[['101','3']] } }; } }; };
  try { const b = await ex.fetchOrderBook('BTC/TRY', 25); assert.match(seen, /api\.btcturk\.com\/api\/v2\/orderbook\?pairSymbol=BTCTRY/); assert.deepEqual(b.bids, [['100','2']]); } finally { global.fetch = old; }
});
