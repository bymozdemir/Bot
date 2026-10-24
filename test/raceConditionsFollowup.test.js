'use strict';
// Iptal/dolum yarisi ailesi: reconcile(), sell() ve dinamik stop yenileme + portfoy politikasi sirasi.
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const { SimulatedExchange } = require('../src/simulatedExchange');
const { OrderManager } = require('../src/orderManager');
const FIXED_NOW = () => Date.UTC(2026, 9, 2, 12, 0);
const makeStore = () => ({ save() {} });

function makeExchange() {
  return {
    id: 'binance', environment: 'testnet', name: 'Test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { return { USDT: { free: 1000, locked: 0 } }; },
    async fetchOpenOrders() { return []; },
    async getOrder() { return {}; },
    async createMarketOrder(s, side, amount, cid) { return { status: 'FILLED', orderId: 1, clientOrderId: cid, executedQty: amount, origQty: amount, cummulativeQuoteQty: amount * 100 }; },
    async createStopOrder(s, side, amount, stop, limit, cid) { return { status: 'NEW', orderId: 2, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async cancelOrder(symbol, orderId) { return { status: 'CANCELED', orderId }; },
    async fetchCandles() { return []; },
    async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10, tickSize: 0.01 }; }
  };
}
const fillEvent = (cid, extra = {}) => ({ e: 'executionReport', c: cid, i: 77, s: 'BTCUSDT', S: 'SELL', X: 'FILLED', x: 'TRADE', z: '1', Z: '95', q: '1', I: 'f1', E: 1, ...extra });

test('reconcile(): getOrder beklenirken WS FILLED gelirse eski REST (NEW) cevabı FILLED\'i ezmez', async () => {
  const state = { liveOrders: { r1: { clientOrderId: 'r1', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', exchangeOrderId: 77, executedQty: 0, quoteQty: 0, amount: 1 } } };
  const ex = makeExchange();
  const om = new OrderManager({ exchange: ex, state, store: makeStore() });
  ex.getOrder = async () => {
    om.applyExecutionReport(fillEvent('r1'));
    return { orderId: 77, clientOrderId: 'r1', symbol: 'BTCUSDT', side: 'SELL', status: 'NEW', executedQty: '0', origQty: '1', cummulativeQuoteQty: '0' };
  };
  const r = await om.reconcile('r1');
  assert.equal(r.status, 'FILLED');
  assert.equal(state.liveOrders.r1.executedQty, 1);
  assert.equal(state.liveOrders.r1.quoteQty, 95);
  assert.equal(state.liveOrders.r1.netExecutedQty, 0 + 1 - 0); // SELL: komisyonsuz brüt miktar
});

test('reconcile(): üçüncü varlık komisyonu fiyatlanırken WS FILLED gelirse durum korunur', async () => {
  const state = { liveOrders: { r2: { clientOrderId: 'r2', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', exchangeOrderId: 78, executedQty: 0, quoteQty: 0, amount: 1 } } };
  const ex = makeExchange();
  const om = new OrderManager({ exchange: ex, state, store: makeStore() });
  ex.getOrder = async () => ({ orderId: 78, clientOrderId: 'r2', symbol: 'BTCUSDT', side: 'SELL', status: 'NEW', executedQty: '0', origQty: '1', cummulativeQuoteQty: '0', fills: [{ price: '95', qty: '0.5', commission: '0.01', commissionAsset: 'BNB' }] });
  ex.fetchTicker = async () => { om.applyExecutionReport(fillEvent('r2', { i: 78, I: 'f2' })); return { price: 300 }; };
  const r = await om.reconcile('r2');
  assert.equal(r.status, 'FILLED');
  assert.equal(state.liveOrders.r2.executedQty, 1);
});

test('sell(): stop iptal edilirken zaten FILLED olduysa market satışı gönderilmez, pozisyon stop dolumuyla kapanır', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live'; state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  state.live.safeToTrade = true;
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, openedAt: '2026-10-02T10:00:00.000Z', entryOrderId: 'e1', stopOrderId: 'stop-1', stopPrice: 95, stopExecutionIds: [] };
  state.liveOrders['stop-1'] = { clientOrderId: 'stop-1', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', exchangeOrderId: 77, amount: 1, executedQty: 0, quoteQty: 0, meta: { role: 'protective-stop' } };
  const ex = makeExchange();
  let market = 0;
  ex.createMarketOrder = async () => { market++; throw new Error('market should not be sent'); };
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  ex.cancelOrder = async () => {
    engine.orderManager.applyExecutionReport(fillEvent('stop-1'));
    return { orderId: 77, clientOrderId: 'stop-1', symbol: 'BTCUSDT', side: 'SELL', status: 'CANCELED', executedQty: '0', origQty: '1', cummulativeQuoteQty: '0' };
  };
  await engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'strateji-cikis', engine.epoch);
  assert.equal(market, 0);
  assert.equal(state.liveOrders['stop-1'].status, 'FILLED');
  assert.equal(state.live.positions['BTC/USDT'], undefined, 'pozisyon stop dolumuyla kapanmış olmalı');
  assert.equal(state.live.trades.length, 1, 'stop dolumu tam bir kez deftere işlenmeli');
  assert.equal(state.live.safeToTrade, false, 'bakiye mutabakatı beklenirken kilitli kalmalı');
});

test('dinamik stop yenileme: eski stop iptal edilirken FILLED olduysa yeni stop kurulmaz, dolum işlenir', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true;
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, openedAt: '2026-10-02T10:00:00.000Z', entryOrderId: 'e1', stopOrderId: 'stop-1', stopPrice: 95, highWaterMark: 100, stopExecutionIds: [] };
  state.liveOrders['stop-1'] = { clientOrderId: 'stop-1', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', exchangeOrderId: 77, amount: 1, executedQty: 0, quoteQty: 0, meta: { role: 'protective-stop' } };
  const ex = makeExchange();
  let newStops = 0;
  ex.createStopOrder = async () => { newStops++; throw new Error('yeni stop kurulmamalı'); };
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  ex.cancelOrder = async () => {
    engine.orderManager.applyExecutionReport(fillEvent('stop-1'));
    return { orderId: 77, clientOrderId: 'stop-1', symbol: 'BTCUSDT', side: 'SELL', status: 'CANCELED', executedQty: '0', origQty: '1', cummulativeQuoteQty: '0' };
  };
  await engine._syncTrailingStop('BTC/USDT', state.live.positions['BTC/USDT'], { stopLossPct: 5, trailingStop: true }, 130);
  assert.equal(newStops, 0);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
  assert.equal(state.live.trades.length, 1);
  assert.equal(state.live.safeToTrade, false);
});

test('alış: maxTradeQuote sonrası nihai tutar portföy kova limitine sığıyorsa alış reddedilmez', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  let submits = 0;
  const original = ex.createMarketOrder.bind(ex);
  ex.createMarketOrder = async (...a) => { submits++; return original(...a); };
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.maxConcurrentPositions = 1;
  state.settings.reserveCashPct = 0;
  state.settings.maxTradeQuote = 50;                     // nihai tutar: 50
  state.settings.portfolioPolicy = { maxPositions: 3, reserveCashPct: 0, buckets: { core: { maxCapitalPct: 10 } } }; // limit: 1000 * %10 = 100
  state.pairs['BTC/USDT'].budgetPct = 100;               // ham tutar 1000 > 100, ama maxTradeQuote ile 50
  state.live.safeToTrade = true; state.running = true;
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'policy-order', engine.epoch);
  assert.equal(submits, 1, 'alış emri gönderilmeliydi');
});

test('alış: nihai tutar (maxTradeQuote sonrası) kova limitini hâlâ aşıyorsa alış reddedilir', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  let submits = 0;
  const original = ex.createMarketOrder.bind(ex);
  ex.createMarketOrder = async (...a) => { submits++; return original(...a); };
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.maxConcurrentPositions = 1;
  state.settings.reserveCashPct = 0;
  state.settings.maxTradeQuote = 500;                    // nihai 500 > limit 100
  state.settings.portfolioPolicy = { maxPositions: 3, reserveCashPct: 0, buckets: { core: { maxCapitalPct: 10 } } };
  state.pairs['BTC/USDT'].budgetPct = 100;
  state.live.safeToTrade = true; state.running = true;
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'policy-order-2', engine.epoch);
  assert.equal(submits, 0);
});

test('submitMarket: gönderim sırasında WS FILLED gelip ardından yanıt işlenemezse emir UNKNOWN\'a düşmez', async () => {
  const state = { liveOrders: {} };
  const ex = makeExchange();
  const om = new OrderManager({ exchange: ex, state, store: makeStore() });
  ex.createMarketOrder = async (s, side, amt, cid) => {
    om.applyExecutionReport({ e: 'executionReport', c: cid, i: 5, s: 'BTCUSDT', S: 'BUY', X: 'FILLED', x: 'TRADE', z: '1', Z: '100', q: '1', I: 'b1', E: 1 });
    throw Object.assign(new Error('timeout'), { unknownOutcome: true });
  };
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'm1' });
  assert.equal(r.status, 'FILLED');
  assert.equal(state.liveOrders.m1.executedQty, 1);
  assert.ok(state.liveOrders.m1.error, 'hata bilgisi yine de kaydedilmeli');
});

test('cancel(): iptal çağrısı ağ hatasıyla belirsiz biterken WS FILLED gelmişse FILLED korunur', async () => {
  const state = { liveOrders: { c1: { clientOrderId: 'c1', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', exchangeOrderId: 77, executedQty: 0, quoteQty: 0, amount: 1 } } };
  const ex = makeExchange();
  const om = new OrderManager({ exchange: ex, state, store: makeStore() });
  ex.cancelOrder = async () => { om.applyExecutionReport(fillEvent('c1')); throw Object.assign(new Error('timeout'), { unknownOutcome: true }); };
  const r = await om.cancel('c1');
  assert.equal(r.status, 'FILLED');
  assert.equal(state.liveOrders.c1.uncertain, false);
});

test('reconcile(): getOrder hata verirken WS FILLED gelmişse FILLED korunur (UNKNOWN yapılmaz)', async () => {
  const state = { liveOrders: { c2: { clientOrderId: 'c2', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', exchangeOrderId: 77, executedQty: 0, quoteQty: 0, amount: 1 } } };
  const ex = makeExchange();
  const om = new OrderManager({ exchange: ex, state, store: makeStore() });
  ex.getOrder = async () => { om.applyExecutionReport(fillEvent('c2')); throw new Error('network'); };
  const r = await om.reconcile('c2');
  assert.equal(r.status, 'FILLED');
});

test('UNKNOWN koruması yalnızca terminal durumu korur: PENDING emir hâlâ UNKNOWN olabilir', async () => {
  const state = { liveOrders: {} };
  const ex = makeExchange();
  ex.createMarketOrder = async () => { throw Object.assign(new Error('timeout'), { unknownOutcome: true }); };
  const om = new OrderManager({ exchange: ex, state, store: makeStore() });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'm2' });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.requiresReconciliation, true);
});
