const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderManager } = require('../src/orderManager');

function makeStore() {
  return { saves: 0, save() { this.saves++; } };
}

function makeState() { return { liveOrders: {} }; }

function makeExchange(overrides = {}) {
  return {
    id: 'test', name: 'Test Borsa',
    capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true },
    async createMarketOrder() { return { orderId: 10, clientOrderId: arguments[3], status: 'NEW', origQty: '1' }; },
    async getOrder() { return { orderId: 10, clientOrderId: arguments[2], status: 'FILLED', origQty: '1', executedQty: '1', cummulativeQuoteQty: '100' }; },
    ...overrides
  };
}

test('OrderManager emri gondermeden once PENDING kaydeder ve basarili sonucu saklar', async () => {
  const state = makeState(), store = makeStore();
  let calls = 0;
  const ex = makeExchange({ async createMarketOrder(symbol, side, amount, cid) { calls++; return { orderId: 11, clientOrderId: cid, status: 'FILLED', origQty: String(amount), executedQty: String(amount) }; } });
  const om = new OrderManager({ exchange: ex, state, store });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'cid-1' });
  assert.equal(calls, 1);
  assert.equal(r.status, 'FILLED');
  assert.equal(state.liveOrders['cid-1'].exchangeOrderId, 11);
  assert.ok(store.saves >= 2);
});

test('5xx unknown outcome olursa ikinci emir gondermez', async () => {
  const state = makeState(), store = makeStore();
  let calls = 0;
  const ex = makeExchange({ async createMarketOrder() { calls++; const e = new Error('503'); e.unknownOutcome = true; e.httpStatus = 503; throw e; } });
  const om = new OrderManager({ exchange: ex, state, store });
  const a = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'cid-2' });
  const b = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'cid-2' });
  assert.equal(calls, 1);
  assert.equal(a.status, 'UNKNOWN');
  assert.equal(a.uncertain, true);
  assert.equal(b.reused, true);
});

test('unknown emir yeniden baslatma sonrasinda sorgulanir ve FILLED olursa kesinlesir', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({
    async createMarketOrder() { const e = new Error('timeout'); e.unknownOutcome = true; throw e; },
    async getOrder(symbol, orderId, cid) { assert.equal(cid, 'cid-3'); return { orderId: 99, clientOrderId: cid, status: 'FILLED', origQty: '2', executedQty: '2', cummulativeQuoteQty: '200' }; }
  });
  const om = new OrderManager({ exchange: ex, state, store });
  await om.submitMarket({ symbol: 'ETH/USDT', side: 'buy', amount: 2, clientOrderId: 'cid-3' });
  const r = await om.reconcile('cid-3');
  assert.equal(r.status, 'FILLED');
  assert.equal(r.exchangeOrderId, 99);
  assert.equal(r.uncertain, false);
});

test('take-profit geçersiz limitPrice ile borsaya gönderilmez', async () => {
  const state = makeState(), store = makeStore();
  let calls = 0;
  const ex = makeExchange({
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, liveTradingVerified: true },
    async createTakeProfitOrder() { calls++; return { status: 'NEW', orderId: 1 }; },
    async cancelOrder() { return { status: 'CANCELED' }; }
  });
  const om = new OrderManager({ exchange: ex, state, store });
  await assert.rejects(() => om.submitTakeProfit({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 110, limitPrice: -1 }), /limitPrice/);
  assert.equal(calls, 0);
});

test('clientOrderId desteklemeyen borsada canli emir reddedilir', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({ capabilities: { clientOrderId: false, orderQuery: false, liveTradingVerified: true } });
  const om = new OrderManager({ exchange: ex, state, store });
  await assert.rejects(() => om.submitMarket({ symbol: 'BTC/TRY', side: 'buy', amount: 1 }), /clientOrderId/);
});

test('kismi dolum FILLED kabul edilmez ve executedQty korunur', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({ async createMarketOrder(symbol, side, amount, cid) { return { orderId: 12, clientOrderId: cid, status: 'PARTIALLY_FILLED', origQty: String(amount), executedQty: '0.4', cummulativeQuoteQty: '40' }; } });
  const om = new OrderManager({ exchange: ex, state, store });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'cid-4' });
  assert.equal(r.status, 'PARTIALLY_FILLED');
  assert.equal(r.executedQty, 0.4);
});

test('executionReport mevcut emri FILLED durumuna ve gerçek dolum miktarına taşır', () => {
  const state = { liveOrders: { 'cid-ws': { clientOrderId: 'cid-ws', symbol: 'BTC/USDT', side: 'buy', amount: 1, status: 'NEW', exchangeOrderId: 5 } } }, store = makeStore();
  const om = new OrderManager({ exchange: makeExchange(), state, store });
  const r = om.applyExecutionReport({ e: 'executionReport', E: 123, c: 'cid-ws', i: 5, s: 'BTCUSDT', X: 'FILLED', x: 'TRADE', q: '1', z: '1', Z: '100' });
  assert.equal(r.handled, true);
  assert.equal(r.order.status, 'FILLED');
  assert.equal(r.order.executedQty, 1);
  assert.equal(r.order.quoteQty, 100);
  assert.equal(r.order.uncertain, false);
});

test('executionReport tanınmayan emir gelirse yerel emir oluşturmaz ve canlı kapıyı kapatır', () => {
  const state = { liveOrders: {}, liveReconciliation: { safeToTrade: true } }, store = makeStore();
  const om = new OrderManager({ exchange: makeExchange(), state, store });
  const r = om.applyExecutionReport({ e: 'executionReport', c: 'foreign', i: 88, s: 'ETHUSDT', X: 'NEW' });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'unknown_local_order');
  assert.equal(Object.keys(state.liveOrders).length, 0);
  assert.equal(state.liveReconciliation.safeToTrade, false);
  assert.equal(state.liveStreamWarning.exchangeOrderId, 88);
});


test('base asset komisyonu net koruyucu satış miktarını düşürür', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({
    async createMarketOrder(symbol, side, amount, cid) {
      return {
        orderId: 50, clientOrderId: cid, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED',
        origQty: '1', executedQty: '1', cummulativeQuoteQty: '100',
        fills: [{ price: '100', qty: '1', commission: '0.001', commissionAsset: 'BTC' }]
      };
    }
  });
  const om = new OrderManager({ exchange: ex, state, store });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'fee-1' });
  assert.equal(r.executedQty, 1);
  assert.equal(r.netExecutedQty, 0.999);
  assert.equal(r.commissionBase, 0.001);
});

test('quote asset komisyonu alış maliyetine eklenir', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({
    async createMarketOrder(symbol, side, amount, cid) {
      return {
        orderId: 51, clientOrderId: cid, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED',
        origQty: '1', executedQty: '1', cummulativeQuoteQty: '100',
        fills: [{ price: '100', qty: '1', commission: '0.1', commissionAsset: 'USDT' }]
      };
    }
  });
  const om = new OrderManager({ exchange: ex, state, store });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'fee-2' });
  assert.equal(r.netExecutedQty, 1);
  assert.equal(r.netQuoteQty, 100.1);
});

test('executionReport birden fazla fill komisyonunu varlık bazında toplar ve duplicate event iki kez sayılmaz', () => {
  const state = { liveOrders: { 'cid-fees': { clientOrderId: 'cid-fees', symbol: 'BTC/USDT', side: 'buy', amount: 1, status: 'NEW', exchangeOrderId: 7 } } }, store = makeStore();
  const om = new OrderManager({ exchange: makeExchange(), state, store });
  const a = om.applyExecutionReport({ e:'executionReport', E:1, I:101, c:'cid-fees', i:7, s:'BTCUSDT', S:'BUY', X:'PARTIALLY_FILLED', q:'1', z:'0.4', Z:'40', n:'0.0004', N:'BTC' });
  assert.equal(a.order.commissionByAsset.BTC, 0.0004);
  assert.equal(a.order.netExecutedQty, 0.3996);
  const b = om.applyExecutionReport({ e:'executionReport', E:1, I:101, c:'cid-fees', i:7, s:'BTCUSDT', S:'BUY', X:'PARTIALLY_FILLED', q:'1', z:'0.4', Z:'40', n:'0.0004', N:'BTC' });
  assert.equal(b.order.commissionByAsset.BTC, 0.0004);
  assert.equal(b.order.netExecutedQty, 0.3996);
  const c = om.applyExecutionReport({ e:'executionReport', E:2, I:102, c:'cid-fees', i:7, s:'BTCUSDT', S:'BUY', X:'FILLED', q:'1', z:'1', Z:'100', n:'0.0006', N:'BTC' });
  assert.equal(c.order.commissionByAsset.BTC, 0.001);
  assert.equal(c.order.netExecutedQty, 0.999);
});

test('satışta base komisyonu pozisyon azaltımını gross executedQty üzerinden bırakır', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({ async createMarketOrder(symbol, side, amount, cid) {
    return { orderId:52, clientOrderId:cid, symbol:'BTCUSDT', side:'SELL', status:'FILLED', origQty:String(amount), executedQty:'1', cummulativeQuoteQty:'100', fills:[{price:'100',qty:'1',commission:'0.001',commissionAsset:'BTC'}] };
  }});
  const om = new OrderManager({ exchange:ex, state, store });
  const r = await om.submitMarket({symbol:'BTC/USDT', side:'sell', amount:1, clientOrderId:'fee-sell-1'});
  assert.equal(r.executedQty, 1);
  assert.equal(r.netExecutedQty, 1);
  assert.equal(r.commissionBase, 0.001);
});

test('finansal yardımcı: satışta base komisyonu pozisyon çıkışına eklenir', () => {
  const { positionReductionOnSell } = require('../src/financial');
  assert.equal(positionReductionOnSell(1, 0.001), 1.001);
  assert.equal(positionReductionOnSell(1, 0), 1);
});


test('cancel UNKNOWN cevabını CANCELED saymaz ve reconciliation ister', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({
    async cancelOrder(symbol, orderId) {
      return { orderId, clientOrderId:'cid-unknown-cancel', symbol:'BTCUSDT', side:'SELL', status:'UNKNOWN', executedQty:'0', cummulativeQuoteQty:'0' };
    }
  });
  const om = new OrderManager({ exchange:ex, state, store });
  const created = await om.submitMarket({ symbol:'BTC/USDT', side:'sell', amount:1, clientOrderId:'cid-unknown-cancel' });
  const result = await om.cancel(created.clientOrderId);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.uncertain, true);
  assert.equal(result.requiresReconciliation, true);
});

test('kısmi market emir iptalinde iptal sonucu gerçekleşen miktarı korur', async () => {
  const state = makeState(), store = makeStore();
  let canceled = 0;
  const ex = makeExchange({
    async createMarketOrder(symbol, side, amount, cid) { return { orderId:77, clientOrderId:cid, symbol:'BTCUSDT', side:'BUY', status:'PARTIALLY_FILLED', origQty:String(amount), executedQty:'0.4', cummulativeQuoteQty:'40' }; },
    async cancelOrder(symbol, orderId) { canceled++; return { orderId, clientOrderId:'cid-partial', symbol:'BTCUSDT', side:'BUY', status:'CANCELED', origQty:'1', executedQty:'0.4', cummulativeQuoteQty:'40' }; }
  });
  const om = new OrderManager({ exchange:ex, state, store });
  const r = await om.submitMarket({symbol:'BTC/USDT', side:'buy', amount:1, clientOrderId:'cid-partial'});
  const c = await om.cancel(r.clientOrderId);
  assert.equal(canceled, 1);
  assert.equal(c.status, 'CANCELED');
  assert.equal(c.executedQty, 0.4);
  assert.equal(c.quoteQty, 40);
});

test('üçüncü varlık komisyonu quote karşılığıyla değerlenir', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({
    async createMarketOrder(symbol, side, amount, cid) {
      return { orderId: 90, clientOrderId: cid, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1', cummulativeQuoteQty: '100',
        fills: [{ price:'100', qty:'1', commission:'0.01', commissionAsset:'BNB' }] };
    },
    async fetchTicker(symbol) {
      assert.equal(symbol, 'BNB/USDT');
      return { symbol, price: 600 };
    }
  });
  const om = new OrderManager({ exchange: ex, state, store });
  const r = await om.submitMarket({ symbol:'BTC/USDT', side:'buy', amount:1, clientOrderId:'third-fee-1' });
  assert.equal(r.thirdAssetCommissionQuote, 6);
  assert.equal(r.thirdAssetCommissionValuationComplete, true);
  assert.equal(r.thirdAssetCommissionValuation.BNB.quoteValue, 6);
});

test('üçüncü varlık komisyonu fiyatlanamazsa muhasebe bunu tamamlanmış saymaz', async () => {
  const state = makeState(), store = makeStore();
  const ex = makeExchange({
    async createMarketOrder(symbol, side, amount, cid) {
      return { orderId: 91, clientOrderId: cid, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1', cummulativeQuoteQty: '100',
        fills: [{ price:'100', qty:'1', commission:'0.01', commissionAsset:'BNB' }] };
    },
    async fetchTicker() { throw new Error('ticker unavailable'); }
  });
  const om = new OrderManager({ exchange: ex, state, store });
  const r = await om.submitMarket({ symbol:'BTC/USDT', side:'buy', amount:1, clientOrderId:'third-fee-2' });
  assert.equal(r.thirdAssetCommissionQuote, null);
  assert.equal(r.thirdAssetCommissionValuationComplete, false);
});

test('gecikmiş WebSocket olayı FILLED durumunu geri düşüremez ve kümülatif dolum azalmaz', () => {
  const state = { liveOrders: { 'cid-order': { clientOrderId: 'cid-order', symbol: 'BTC/USDT', side: 'buy', amount: 1, status: 'NEW', exchangeOrderId: 5 } } }, store = makeStore();
  const om = new OrderManager({ exchange: makeExchange(), state, store });
  const filled = om.applyExecutionReport({ e:'executionReport', E:10, I:101, c:'cid-order', i:5, s:'BTCUSDT', S:'BUY', X:'FILLED', x:'TRADE', q:'1', z:'1', Z:'100', n:'0.001', N:'BTC' });
  assert.equal(filled.order.status, 'FILLED');
  const late = om.applyExecutionReport({ e:'executionReport', E:9, I:100, c:'cid-order', i:5, s:'BTCUSDT', S:'BUY', X:'PARTIALLY_FILLED', x:'TRADE', q:'1', z:'0.4', Z:'40', n:'0.0004', N:'BTC' });
  assert.equal(late.order.status, 'FILLED');
  assert.equal(late.order.executedQty, 1);
  assert.equal(late.order.quoteQty, 100);
  assert.equal(late.order.commissionByAsset.BTC, 0.0014);
});

test('ayni executionReport tekrarlandiginda komisyon ikinci kez yazilmaz', () => {
  const state = { liveOrders: { 'cid-dup': { clientOrderId:'cid-dup', symbol:'BTC/USDT', side:'buy', status:'NEW', exchangeOrderId:7 } } }, store = makeStore();
  const om = new OrderManager({ exchange: makeExchange(), state, store });
  const e = { e:'executionReport', E:1, I:555, c:'cid-dup', i:7, s:'BTCUSDT', S:'BUY', X:'PARTIALLY_FILLED', x:'TRADE', q:'1', z:'0.5', Z:'50', n:'0.0005', N:'BTC' };
  om.applyExecutionReport(e);
  om.applyExecutionReport(e);
  assert.equal(state.liveOrders['cid-dup'].commissionByAsset.BTC, 0.0005);
  assert.equal(state.liveOrders['cid-dup'].executedQty, 0.5);
});

test('Binance kompakt sembolü yerel slashlı sembolü ezmez', () => {
  const { canonicalSymbol } = require('../src/orderManager');
  assert.equal(canonicalSymbol('BTCUSDT', 'BTC/USDT'), 'BTC/USDT');
  assert.equal(canonicalSymbol('BTC/USDT', 'BTC/USDT'), 'BTC/USDT');
});

test('REST sorgusu WebSocketten daha eskiyse FILLED ve kümülatif dolum geriye dönmez', async () => {
  const state = { liveOrders: { 'rest-ws-1': { clientOrderId:'rest-ws-1', symbol:'BTC/USDT', side:'buy', amount:1, status:'NEW', exchangeOrderId:88 } } }, store = makeStore();
  const ex = makeExchange({ async getOrder() {
    return { orderId:88, clientOrderId:'rest-ws-1', symbol:'BTCUSDT', side:'BUY', status:'PARTIALLY_FILLED', origQty:'1', executedQty:'0.4', cummulativeQuoteQty:'40' };
  }});
  const om = new OrderManager({ exchange: ex, state, store });
  om.applyExecutionReport({ e:'executionReport', E:20, I:200, c:'rest-ws-1', i:88, s:'BTCUSDT', S:'BUY', X:'FILLED', x:'TRADE', q:'1', z:'1', Z:'100', n:'0.001', N:'BTC' });
  const r = await om.reconcile('rest-ws-1');
  assert.equal(r.status, 'FILLED');
  assert.equal(r.executedQty, 1);
  assert.equal(r.quoteQty, 100);
  assert.equal(r.commissionByAsset.BTC, 0.001);
});

test('REST sorgusu WebSocketten eski kısmi dolumu geri düşürmez', async () => {
  const state = { liveOrders: { 'rest-ws-2': { clientOrderId:'rest-ws-2', symbol:'BTC/USDT', side:'sell', amount:1, status:'PARTIALLY_FILLED', exchangeOrderId:89, executedQty:0.6, quoteQty:60, commissionByAsset:{BTC:0.0006} } } }, store = makeStore();
  const ex = makeExchange({ async getOrder() {
    return { orderId:89, clientOrderId:'rest-ws-2', symbol:'BTCUSDT', side:'SELL', status:'PARTIALLY_FILLED', origQty:'1', executedQty:'0.4', cummulativeQuoteQty:'40' };
  }});
  const om = new OrderManager({ exchange: ex, state, store });
  const r = await om.reconcile('rest-ws-2');
  assert.equal(r.status, 'PARTIALLY_FILLED');
  assert.equal(r.executedQty, 0.6);
  assert.equal(r.quoteQty, 60);
  assert.equal(r.commissionByAsset.BTC, 0.0006);
});

test('REST + WebSocket ayni filli iki kez komisyon olarak saymaz', async () => {
  const state = { liveOrders: { 'rest-ws-3': { clientOrderId:'rest-ws-3', symbol:'BTC/USDT', side:'buy', amount:1, status:'NEW', exchangeOrderId:90 } } }, store = makeStore();
  const ex = makeExchange({ async getOrder() {
    return { orderId:90, clientOrderId:'rest-ws-3', symbol:'BTCUSDT', side:'BUY', status:'FILLED', origQty:'1', executedQty:'1', cummulativeQuoteQty:'100' };
  }});
  const om = new OrderManager({ exchange: ex, state, store });
  om.applyExecutionReport({ e:'executionReport', E:30, I:300, c:'rest-ws-3', i:90, s:'BTCUSDT', S:'BUY', X:'FILLED', x:'TRADE', q:'1', z:'1', Z:'100', n:'0.001', N:'BTC' });
  const r = await om.reconcile('rest-ws-3');
  assert.equal(r.commissionByAsset.BTC, 0.001);
  assert.equal(r.netExecutedQty, 0.999);
});

test('REST create cevabi, aradaki WebSocket FILLED durumunu NEW ile geri alamaz', async () => {
  const state = { liveOrders: {} }, st = { save() {} };
  let resolveCreate;
  const ex = {
    name: 'RaceEx', capabilities: { clientOrderId: true, liveTradingVerified: true },
    createMarketOrder: async (symbol, side, amount, cid) => new Promise(resolve => { resolveCreate = () => resolve({ orderId: 501, clientOrderId: cid, symbol: 'BTCUSDT', side: 'BUY', status: 'NEW', origQty: String(amount), executedQty: '0', cummulativeQuoteQty: '0' }); }),
    getOrder: async () => ({ status: 'FILLED', orderId: 501, clientOrderId: 'race-buy', symbol: 'BTCUSDT', side: 'BUY', origQty: '1', executedQty: '1', cummulativeQuoteQty: '100' })
  };
  const { OrderManager } = require('../src/orderManager');
  const om = new OrderManager({ exchange: ex, state, store: st });
  const promise = om.submitMarket({ symbol:'BTC/USDT', side:'buy', amount:1, clientOrderId:'race-buy' });
  while (!resolveCreate) await new Promise(r => setImmediate(r));
  const ws = om.applyExecutionReport({ e:'executionReport', E:20, I:200, c:'race-buy', i:501, s:'BTCUSDT', S:'BUY', X:'FILLED', x:'TRADE', q:'1', z:'1', Z:'100', n:'0', N:null });
  assert.equal(ws.handled, true);
  resolveCreate();
  const r = await promise;
  assert.equal(r.status, 'FILLED');
  assert.equal(r.executedQty, 1);
});

test('borsa emri kabul ettikten sonra yerel kayit hatasi REJECTED degil UNKNOWN olur', async () => {
  const state = makeState();
  let calls = 0;
  const store = {
    saves: 0,
    save() {
      this.saves++;
      // PENDING kaydi basarili; borsadan cevap geldikten sonraki ilk kalici
      // kayit gecici hata verir. Sonraki UNKNOWN kaydinin yazilmasina izin ver.
      if (this.saves === 2) throw new Error('gecici disk hatasi');
    }
  };
  const ex = makeExchange({ async createMarketOrder(symbol, side, amount, cid) {
    calls++;
    return { orderId: 77, clientOrderId: cid, status: 'FILLED', origQty: String(amount), executedQty: String(amount), cummulativeQuoteQty: '100' };
  } });
  const om = new OrderManager({ exchange: ex, state, store });
  const result = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'cid-save-failure' });
  assert.equal(calls, 1, 'borsaya ikinci POST gönderilmemeli');
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.uncertain, true);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(state.liveOrders['cid-save-failure'].status, 'UNKNOWN');
});

test('OCO yaniti iki clientOrderId bacağını doğrulamıyorsa UNKNOWN olur', async () => {
  const state = makeState();
  const store = makeStore();
  let calls = 0;
  const ex = makeExchange({
    capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true, oco: true },
    async createOcoOrder() { calls++; return { orderListId: 123, orders: [] }; }
  });
  const om = new OrderManager({ exchange: ex, state, store });
  await assert.rejects(() => om.submitOco({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 90, takeProfitPrice: 110 }), (err) => err.unknownOutcome === true);
  assert.equal(calls, 1);
  const ocoOrders = Object.values(state.liveOrders).filter(o => o.meta?.oco);
  assert.equal(ocoOrders.length, 2);
  assert.ok(ocoOrders.every(o => o.status === 'UNKNOWN' && o.requiresReconciliation === true));
});

test('Borsa yanıtındaki eksik veya tanınmayan durum NEW varsayılmaz; UNKNOWN ve mutabakat gerekir', async () => {
  for (const response of [
    { orderId: 901, clientOrderId: 'cid-unknown-status', origQty: '1' },
    { orderId: 902, clientOrderId: 'cid-unknown-status', status: 'accepted-ish', origQty: '1' }
  ]) {
    const state = makeState();
    const store = makeStore();
    const ex = makeExchange({ async createMarketOrder(_symbol, _side, _amount, cid) { return { ...response, clientOrderId: cid }; } });
    const om = new OrderManager({ exchange: ex, state, store });
    const result = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'cid-unknown-status' });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.uncertain, true);
    assert.equal(result.requiresReconciliation, true);
  }
});
