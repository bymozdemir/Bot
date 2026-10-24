'use strict';
// Emir borsaya GİTTİKTEN sonraki hatalar (disk yazımı, yanıt işleme) emri "REJECTED" yapmamalı.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderManager } = require('../src/orderManager');

const exchange = (over = {}) => ({
  id: 't', name: 'T', capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true, oco: true },
  async getOrder() { return {}; },
  async createMarketOrder(s, side, amt, cid) { return { orderId: 11, clientOrderId: cid, status: 'FILLED', origQty: String(amt), executedQty: String(amt), cummulativeQuoteQty: '100' }; },
  async createStopOrder(s, side, amt, sp, lp, cid) { return { orderId: 12, clientOrderId: cid, status: 'NEW', origQty: String(amt) }; },
  async cancelOrder() { return {}; },
  ...over
});

test('emir borsaya gittikten sonra disk yazımı hata verirse emir FILLED kalır ve istisna fırlatılmaz', async () => {
  const state = { liveOrders: {} };
  let saves = 0;
  const om = new OrderManager({ exchange: exchange(), state, store: { save() { saves++; if (saves >= 2) throw new Error('ENOSPC'); } } });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'a' });
  assert.equal(r.status, 'FILLED');
  assert.equal(state.liveOrders.a.status, 'FILLED');
  assert.match(om.lastSaveError.message, /ENOSPC/);
});

test('gönderim ÖNCESİ PENDING kaydı diske yazılamazsa emir HİÇ gönderilmez', async () => {
  let sent = 0;
  const om = new OrderManager({ exchange: exchange({ async createMarketOrder() { sent++; return {}; } }), state: { liveOrders: {} }, store: { save() { throw new Error('ENOSPC'); } } });
  await assert.rejects(() => om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'b' }), /ENOSPC/);
  assert.equal(sent, 0);
});

test('yanıt işlenemezse (market/stop) emir REJECTED değil UNKNOWN (belirsiz) işaretlenir', async () => {
  const bad = { orderId: 13, status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100', fills: { boom: true } };
  for (const kind of ['market', 'stop']) {
    const om = new OrderManager({ exchange: exchange({ async createMarketOrder(s, sd, a, cid) { return { ...bad, clientOrderId: cid }; }, async createStopOrder(s, sd, a, sp, lp, cid) { return { ...bad, clientOrderId: cid }; } }), state: { liveOrders: {} }, store: { save() {} } });
    const r = kind === 'market'
      ? await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'c1' })
      : await om.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 90, clientOrderId: 'c2' });
    assert.equal(r.status, 'UNKNOWN', kind);
    assert.equal(r.uncertain, true, kind);
    assert.equal(r.requiresReconciliation, true, kind);
  }
});

test('borsa emri açıkça reddederse (gönderim hatası) yine REJECTED kaydedilir', async () => {
  const om = new OrderManager({ exchange: exchange({ async createMarketOrder() { throw new Error('insufficient balance'); } }), state: { liveOrders: {} }, store: { save() {} } });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'd' });
  assert.equal(r.status, 'REJECTED');
});

test('iptal / mutabakat / WebSocket dolum olayında disk yazımı hatası işlemi kesmez', async () => {
  const state = { liveOrders: { s1: { clientOrderId: 's1', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', exchangeOrderId: 5, executedQty: 0, quoteQty: 0 } } };
  let failing = false;
  const om = new OrderManager({
    exchange: exchange({ async cancelOrder() { return { orderId: 5, clientOrderId: 's1', status: 'CANCELED', executedQty: '0' }; }, async getOrder() { return { orderId: 5, clientOrderId: 's1', status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100', side: 'SELL' }; } }),
    state, store: { save() { if (failing) throw new Error('ENOSPC'); } }
  });
  failing = true;
  const c = await om.cancel('s1');
  assert.equal(c.status, 'CANCELED', 'iptal borsada oldu; disk hatası bunu gizlememeli');
  state.liveOrders.s1.status = 'NEW';
  const r = await om.reconcile('s1');
  assert.equal(r.status, 'FILLED');
  const ev = om.applyExecutionReport({ e: 'executionReport', c: 's1', s: 'BTCUSDT', S: 'SELL', X: 'FILLED', i: 5, z: '1', Z: '100', q: '1', I: 77 });
  assert.equal(ev.handled, true);
  assert.equal(state.liveOrders.s1.status, 'FILLED');
});
