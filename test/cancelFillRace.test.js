'use strict';
// Gecikmis iptal cevabi, WebSocket'ten gelen daha yeni dolum bilgisini ezmemeli.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderManager } = require('../src/orderManager');

function setup(cancelImpl) {
  const state = { liveOrders: { s1: { clientOrderId: 's1', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', exchangeOrderId: 5, executedQty: 0, quoteQty: 0, amount: 1 } } };
  const exchange = {
    id: 't', name: 'T',
    capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true },
    async getOrder() { return {}; },
    async createMarketOrder() { return {}; },
    cancelOrder: (...a) => cancelImpl(om, ...a)
  };
  const om = new OrderManager({ exchange, state, store: { save() {} } });
  return { om, state };
}
const fillEvent = (extra = {}) => ({ e: 'executionReport', c: 's1', i: 5, s: 'BTCUSDT', S: 'SELL', X: 'FILLED', x: 'TRADE', z: '1', Z: '100', q: '1', I: 'e1', ...extra });

test('iptal beklenirken WS FILLED bildirirse gecikmiş CANCELED cevabı FILLED\'i ezmez', async () => {
  const { om, state } = setup(async (m) => {
    m.applyExecutionReport(fillEvent());
    return { orderId: 5, clientOrderId: 's1', status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' };
  });
  const r = await om.cancel('s1');
  assert.equal(r.status, 'FILLED');
  assert.equal(state.liveOrders.s1.executedQty, 1);
  assert.equal(state.liveOrders.s1.quoteQty, 100);
  assert.equal(state.liveOrders.s1.canceledAt, undefined);
  assert.ok(state.liveOrders.s1.cancelIgnoredReason);
});

test('iptal beklenirken WS kısmi dolum bildirirse miktar korunur, durum CANCELED olur', async () => {
  const { om, state } = setup(async (m) => {
    m.applyExecutionReport(fillEvent({ X: 'PARTIALLY_FILLED', z: '0.4', Z: '40' }));
    return { orderId: 5, clientOrderId: 's1', status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' };
  });
  const r = await om.cancel('s1');
  assert.equal(r.status, 'CANCELED');
  assert.equal(state.liveOrders.s1.executedQty, 0.4);
  assert.ok(state.liveOrders.s1.canceledAt);
});

test('iptal beklenirken FILLED gelmişse belirsiz (UNKNOWN) iptal cevabı FILLED\'i UNKNOWN yapmaz', async () => {
  const { om, state } = setup(async (m) => {
    m.applyExecutionReport(fillEvent());
    return { orderId: 5, clientOrderId: 's1', status: 'WEIRD' };
  });
  const r = await om.cancel('s1');
  assert.equal(r.status, 'FILLED');
  assert.equal(state.liveOrders.s1.uncertain, false);
});

test('normal iptal (yarış yok) hâlâ CANCELED yazar', async () => {
  const { om, state } = setup(async () => ({ orderId: 5, clientOrderId: 's1', status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' }));
  const r = await om.cancel('s1');
  assert.equal(r.status, 'CANCELED');
  assert.ok(state.liveOrders.s1.canceledAt);
});
