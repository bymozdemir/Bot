'use strict';
// Kaos kampanyasinda bulunan gercek hatalar icin hedefli regresyon testleri.
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const { OrderManager } = require('../src/orderManager');
const { ChaosExchange, mulberry32 } = require('./chaos/chaosExchange');

const quietP = { errorProb: 0, unknownProb: 0, staleProb: 0, dropProb: 0, dupProb: 0, injectProb: 0 };
const mkEx = (opts = {}) => new ChaosExchange(mulberry32(7), { btc: 1, usdt: 1e6, p: { ...quietP, ...(opts.p || {}) }, ...opts });
const ev = (cid, o = {}) => ({ e: 'executionReport', c: cid, i: 100, s: 'BTCUSDT', S: 'BUY', X: 'PARTIALLY_FILLED', x: 'TRADE', z: '1', Z: '100', q: '1', I: 1, E: 1, t: 't1', N: 'BTC', n: '0.001', ...o });
const mkOm = (ex, rec) => { const state = { liveOrders: rec ? { [rec.clientOrderId]: rec } : {} }; return { om: new OrderManager({ exchange: ex, state, store: { save() {} } }), state }; };
const baseRec = (o = {}) => ({ clientOrderId: 'c1', symbol: 'BTC/USDT', side: 'buy', status: 'NEW', exchangeOrderId: 100, executedQty: 0, quoteQty: 0, amount: 1, ...o });

test('komisyon: aynı işlem hem REST fills hem WS ile gelirse BİR kez sayılır (eskiden 2 kat)', () => {
  const ex = mkEx(); const { om, state } = mkOm(ex, baseRec());
  om.applyExecutionReport(ev('c1'));
  const raw = { orderId: 100, clientOrderId: 'c1', symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', executedQty: '1', origQty: '1', cummulativeQuoteQty: '100', fills: [{ tradeId: 't1', qty: '1', price: '100', commission: '0.001', commissionAsset: 'BTC' }] };
  om._recordExchangeResponse('c1', require('../src/orderManager').normalizeOrder(raw, om.get('c1')));
  assert.ok(Math.abs(state.liveOrders.c1.commissionByAsset.BTC - 0.001) < 1e-12, `BTC komisyonu ${state.liveOrders.c1.commissionByAsset.BTC}`);
  om.applyExecutionReport(ev('c1', { I: 2, E: 2 }));   // aynı işlem tekrar (farklı olay kimliğiyle)
  assert.ok(Math.abs(state.liveOrders.c1.commissionByAsset.BTC - 0.001) < 1e-12);
});

test('komisyon: önce REST fills sonra WS gelirse REST komisyonu silinmez (eskiden WS toplamı üzerine yazıyordu)', () => {
  const ex = mkEx(); const { om, state } = mkOm(ex, baseRec());
  const raw = { orderId: 100, clientOrderId: 'c1', symbol: 'BTCUSDT', side: 'BUY', status: 'PARTIALLY_FILLED', executedQty: '0.5', origQty: '1', cummulativeQuoteQty: '50', fills: [{ tradeId: 't1', qty: '0.5', price: '100', commission: '0.0005', commissionAsset: 'BTC' }] };
  om._recordExchangeResponse('c1', require('../src/orderManager').normalizeOrder(raw, om.get('c1')));
  om.applyExecutionReport(ev('c1', { t: 't2', I: 9, z: '1', Z: '100', X: 'FILLED', n: '0.0005' }));
  assert.ok(Math.abs(state.liveOrders.c1.commissionByAsset.BTC - 0.001) < 1e-12, `BTC=${state.liveOrders.c1.commissionByAsset.BTC}`);
});

test('verifyFees: kaybolan WS olayları myTrades ile tamamlanır, net miktar düzelir', async () => {
  const ex = mkEx(); const { om, state } = mkOm(ex, baseRec());
  const o = ex._newOrder({ symbol: 'BTCUSDT', side: 'buy', amount: 1, cid: 'c1', type: 'MARKET' });
  ex.fillStep(o, true);
  ex.pending.length = 0;                                         // tum WS olaylari kayboldu
  state.liveOrders.c1.status = 'FILLED'; state.liveOrders.c1.executedQty = 1; state.liveOrders.c1.quoteQty = 100; state.liveOrders.c1.netExecutedQty = 1;
  const r = await om.verifyFees('c1');
  assert.ok(r.commissionByAsset.BTC > 0 || r.commissionByAsset.BNB > 0 || r.commissionByAsset.USDT > 0);
  assert.equal(r.feesVerifiedQty, 1);
  if (r.commissionByAsset.BTC) assert.ok(r.netExecutedQty < 1);
});

test('cancel: borsa -2011 (Unknown order) dönerse gerçek durum REST ile öğrenilir (FILLED ise FILLED döner)', async () => {
  const ex = mkEx(); const { om } = mkOm(ex, baseRec({ side: 'sell' }));
  const o = ex._newOrder({ symbol: 'BTCUSDT', side: 'sell', amount: 1, cid: 'c1', type: 'STOP_LOSS_LIMIT', locked: true });
  ex.balances.BTC.locked = 1; ex.balances.BTC.free = 0; ex.fillStep(o, true); ex.pending.length = 0;   // stop dolu, WS gecikti
  const r = await om.cancel('c1');
  assert.equal(r.status, 'FILLED');
  assert.equal(r.executedQty, 1);
});

test('UNKNOWN (zaman aşımı) olan çıkış emri sonradan FILLED çıkarsa pozisyona işlenir, stop denenmez (eskiden hayalet pozisyon)', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true; state.running = true; state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, openedAt: '2026-10-02T10:00:00.000Z', entryOrderId: 'e1', stopOrderId: null, stopExecutionIds: [] };
  const sellOrder = ex._newOrder({ symbol: 'BTCUSDT', side: 'sell', amount: 1, cid: 'x1', type: 'MARKET' });
  ex.balances.BTC.free = 1; ex.fillStep(sellOrder, true); ex.pending.length = 0;
  state.liveOrders.x1 = { clientOrderId: 'x1', symbol: 'BTC/USDT', side: 'sell', status: 'UNKNOWN', uncertain: true, exchangeOrderId: 100, executedQty: 0, quoteQty: 0, amount: 1, meta: { role: 'exit', entryOrderId: 'e1', reason: 'test' } };
  await engine.orderManager.refreshPending();
  await engine.tick();
  assert.equal(state.live.positions['BTC/USDT'], undefined, 'çıkış dolumu pozisyona işlenmeli');
  assert.equal(state.live.trades.length, 1);
  assert.equal(state.liveOrders.x1.exitBooked, true);
  await engine.tick();                                            // ikinci tur: tekrar işlenmez
  assert.equal(state.live.trades.length, 1);
});

test('stop gönderimi zaman aşımına uğrayıp borsada AÇIK kaldıysa pozisyona bağlanır, yeni stop gönderilmez', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true; state.running = true; state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  let creates = 0; const orig = ex.createStopOrder.bind(ex); ex.createStopOrder = async (...a) => { creates++; return orig(...a); };
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, openedAt: '2026-10-02T10:00:00.000Z', entryOrderId: 'e1', stopOrderId: null, stopPrice: 95, stopExecutionIds: [] };
  ex.balances.BTC.free = 1;
  await engine.orderManager.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94, clientOrderId: 's1', meta: { role: 'protective-stop', entryClientOrderId: 'e1' } });
  await engine._ensurePositionProtection();
  assert.equal(state.live.positions['BTC/USDT'].stopOrderId, 's1');
  assert.equal(creates, 1, 'ikinci stop gönderilmemeli');
});

test('koruyucu dolum: aynı son olay kimliğiyle ama REST ile büyümüş dolum yok sayılmaz (kümülatif tekrar koruması)', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true;
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  ex.balances.BTC.free = 1;
  await engine.orderManager.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94, clientOrderId: 's1', meta: { role: 'protective-stop', entryClientOrderId: 'e1' } });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, entryOrderId: 'e1', stopOrderId: 's1', stopExecutionIds: [] };
  const mk = (q) => ({ ...state.liveOrders.s1, status: 'PARTIALLY_FILLED', executedQty: q, netQuoteQty: q * 100, quoteQty: q * 100, commissionByAsset: {}, commissionBase: 0, lastExecutionId: 'same' });
  await engine._handleProtectiveStopUpdate(mk(0.3));
  assert.ok(Math.abs(state.live.positions['BTC/USDT'].quantity - 0.7) < 1e-9, `ilk kısmi dolum: ${state.live.positions['BTC/USDT'].quantity}`);
  // Aynı emir (s1) için aynı son olay kimliği, ama REST/iptal yanıtıyla kümülatif dolum 0.6'ya büyüdü.
  const p = state.live.positions['BTC/USDT'];
  await engine.orderManager.cancel(p.stopOrderId);              // ilk yedek stop borsada bakiyeyi kilitlemesin (test düzeneği)
  // Emir hâlâ bağlı ve ilk dolum işlenmiş sayılıyor: tekrar-koruma listesi ilk olayı içerir (eski ve yeni anahtar biçimi).
  p.stopOrderId = 's1'; p.stopExecutedQty = 0.3; p.stopNetQuoteQty = 30; p.stopExecutionIds = ['same', 'same|0.3|30'];
  await engine._handleProtectiveStopUpdate(mk(0.6));
  assert.ok(Math.abs(state.live.positions['BTC/USDT'].quantity - 0.4) < 1e-9, `büyüyen dolum işlenmeli: ${state.live.positions['BTC/USDT'].quantity}`);
});

test('çökme: borsada hiç görülmemiş UNKNOWN emir, iki kez ve bekleme süresi sonrası "-2013" ile hiç gönderilmemiş sayılır', async () => {
  const ex = mkEx(); let now = Date.UTC(2026, 9, 2, 12);
  const state = { liveOrders: { x1: { clientOrderId: 'x1', symbol: 'BTC/USDT', side: 'sell', status: 'UNKNOWN', uncertain: true, exchangeOrderId: null, executedQty: 0, quoteQty: 0, amount: 1, createdAt: new Date(now).toISOString() } } };
  const om = new OrderManager({ exchange: ex, state, store: { save() {} }, nowFn: () => now });
  await om.reconcile('x1', { markUnknownOnError: false }).catch(() => {});
  assert.equal(state.liveOrders.x1.status, 'UNKNOWN', 'bekleme süresi dolmadan çözülmemeli');
  now += 130000;
  await om.reconcile('x1', { markUnknownOnError: false }).catch(() => {});
  assert.equal(state.liveOrders.x1.status, 'REJECTED');
  assert.equal(state.liveOrders.x1.neverPlaced, true);
});

test('çökme: -2013 yalnızca ihtiyatlı koşullarda çözer (borsada id görülmüşse veya adaptör kesin saymıyorsa UNKNOWN kalır)', async () => {
  let now = Date.UTC(2026, 9, 2, 12);
  const mk = (rec, caps) => { const ex = mkEx(); Object.assign(ex.capabilities, caps || {}); const state = { liveOrders: { x1: { clientOrderId: 'x1', symbol: 'BTC/USDT', side: 'sell', status: 'UNKNOWN', uncertain: true, exchangeOrderId: null, executedQty: 0, quoteQty: 0, amount: 1, createdAt: new Date(now).toISOString(), ...rec } } }; return { om: new OrderManager({ exchange: ex, state, store: { save() {} }, nowFn: () => now }), state }; };
  for (const [rec, caps, why] of [[{ exchangeOrderId: 55 }, {}, 'borsada id görülmüş'], [{}, { orderNotFoundIsDefinitive: false }, 'adaptör kesin saymıyor']]) {
    const { om, state } = mk(rec, caps);
    await om.reconcile('x1', { markUnknownOnError: false }).catch(() => {});
    now += 130000;
    await om.reconcile('x1', { markUnknownOnError: false }).catch(() => {});
    now += 130000;
    await om.reconcile('x1', { markUnknownOnError: false }).catch(() => {});
    assert.equal(state.liveOrders.x1.status, 'UNKNOWN', why);
  }
});

test('eşzamanlı koruyucu dolum işleyicileri (trailing + WS) aynı dolumu iki kez düşmez', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true;
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  ex.balances.BTC.free = 1;
  await engine.orderManager.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94, clientOrderId: 's1', meta: { role: 'protective-stop', entryClientOrderId: 'e1' } });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, entryOrderId: 'e1', stopOrderId: 's1', stopPrice: 95, stopExecutionIds: [] };
  const t = ex.byCid.get('s1');
  t.fills.push({ id: 't1', qty: 0.5, price: 100, commission: 0.05, asset: 'USDT' }); t.exec = 0.5; t.quote = 50; t.status = 'PARTIALLY_FILLED';
  // WS olayı (işleyiciyi kuyruğa alır) ile doğrudan çağrı (trailing akışı) aynı anda: komisyon doğrulaması bekleme noktası oluşturur.
  engine.orderManager.applyExecutionReport({ e: 'executionReport', c: 's1', i: t.id, s: 'BTCUSDT', S: 'SELL', X: 'PARTIALLY_FILLED', x: 'TRADE', z: '0.5', Z: '50', q: '1', I: 9, E: 9, t: 't1', N: 'USDT', n: '0.05' });
  const direct = engine._handleProtectiveStopUpdate(engine.orderManager.get('s1'));
  await Promise.all([direct, engine.stopUpdateLocks.get('BTC/USDT')].filter(Boolean));
  const pos = state.live.positions['BTC/USDT'];
  assert.ok(pos, 'pozisyon silinmemeli');
  assert.ok(Math.abs(pos.quantity - 0.5) < 1e-9, `kalan miktar 0.5 olmalı, ${pos.quantity}`);
  assert.equal(state.live.trades.length, 1, 'dolum tek bir kez deftere işlenmeli');
});

test('işlenmiş + terminal (iptal) stopa bağlı pozisyon: bağ temizlenir, acil çıkış/yeni stop engellenmez (eskiden kalıcı kilit)', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true; state.running = true; state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  ex.balances.BTC.free = 0.5;
  // Stop kısmen (0.5) dolup iptal edildi ve dolumu zaten pozisyona işlendi; fiyat (100) stop seviyesinin (123.5) altında.
  state.liveOrders.s1 = { clientOrderId: 's1', symbol: 'BTC/USDT', side: 'sell', status: 'CANCELED', exchangeOrderId: 77, executedQty: 0.5, quoteQty: 50, netQuoteQty: 50, amount: 1, commissionByAsset: {}, meta: { role: 'protective-stop', entryClientOrderId: 'e1' } };
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 0.5, entryPrice: 100, costQuote: 50, entryOrderId: 'e1', stopOrderId: 's1', stopPrice: 123.5, stopExecutedQty: 0.5, stopNetQuoteQty: 50, stopExecutionIds: [], stopBooked: { s1: { gross: 0.5, baseFee: 0, netQuote: 50, thirdFee: 0 } } };
  await engine._ensurePositionProtection();
  assert.equal(ex.marketSells.length, 1, 'bağ temizlenmeli ve acil piyasa çıkışı denenmeli');
  assert.notEqual(state.live.positions['BTC/USDT']?.stopOrderId, 's1');
});

test('disk arızası: koruyucu dolum olayında persist() hata verse bile işleyici çalışır, süreç çökmez (eskiden işleyici atlanıyordu / yakalanmamış reddedilme)', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true;
  let failing = false;
  const flaky = { save() { if (failing) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } };
  const engine = new LiveEngine({ exchange: ex, state, store: flaky, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  ex.balances.BTC.free = 1;
  await engine.orderManager.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94, clientOrderId: 's1', meta: { role: 'protective-stop', entryClientOrderId: 'e1' } });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, entryOrderId: 'e1', stopOrderId: 's1', stopPrice: 95, stopExecutionIds: [] };
  failing = true;                                                // bundan sonra her disk yazımı başarısız
  const t = ex.byCid.get('s1'); ex.fillStep(t, true); ex.pending.length = 0;
  engine.orderManager.applyExecutionReport({ e: 'executionReport', c: 's1', i: t.id, s: 'BTCUSDT', S: 'SELL', X: 'FILLED', x: 'TRADE', z: '1', Z: '100', q: '1', I: 5, E: 5, t: t.fills[0].id, N: 'USDT', n: String(t.fills[0].commission) });
  await engine.stopUpdateLocks.get('BTC/USDT');
  assert.equal(state.live.positions['BTC/USDT'], undefined, 'dolum işlenmeli (pozisyon kapanmış sayılmalı)');
  assert.equal(state.live.safeToTrade, false);
});

test('çıkış dolumu: "işlendi" bayrağı ve pozisyon değişikliği ASLA ayrı kayıtlarla diske yazılmaz (çökme/disk arızasında hayalet pozisyon)', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true;
  let violations = 0;
  const watch = { save(st) {
    const o = st.liveOrders?.x1; const p = st.live?.positions?.['BTC/USDT'];
    if (o && o.exitBooked && p && Number(p.quantity) > 0) violations++;   // diskte "işlendi" ama pozisyon hâlâ açık
  } };
  const engine = new LiveEngine({ exchange: ex, state, store: watch, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, entryOrderId: 'e1', stopOrderId: null, stopExecutionIds: [] };
  state.liveOrders.x1 = { clientOrderId: 'x1', symbol: 'BTC/USDT', side: 'sell', status: 'FILLED', exchangeOrderId: 5, executedQty: 1, quoteQty: 100, netQuoteQty: 100, amount: 1, commissionByAsset: {}, meta: { role: 'exit', entryOrderId: 'e1', reason: 'test' } };
  await engine._adoptFilledExits();
  assert.equal(violations, 0);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
  assert.equal(state.live.trades.length, 1);
  assert.equal(state.liveOrders.x1.exitBooked, true);
});

test('kill switch: REJECTED (hiç var olmamış) bir yedek stopa bağlı pozisyon satılabilir (eskiden her satış reddediliyor, pozisyon korumasız kalıyordu)', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true; state.running = true; state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  ex.balances.BTC.free = 1;
  state.liveOrders.s1 = { clientOrderId: 's1', symbol: 'BTC/USDT', side: 'sell', status: 'REJECTED', executedQty: 0, quoteQty: 0, amount: 1, meta: { role: 'protective-stop-recovery', entryClientOrderId: 'e1' } };
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, entryOrderId: 'e1', stopOrderId: 's1', stopPrice: 95, stopExecutionIds: [] };
  await engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'test', engine.epoch, { emergency: true });
  assert.equal(ex.marketSells.length, 1, 'market satış gönderilmeli');
});

test('satış sırasında iptal edilen stopun işlenmemiş kısmi dolumu TEK kez işlenir (çift düşme yok) ve sonraki deneme güncel miktarla satar', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.live.safeToTrade = true; state.running = true; state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => Date.UTC(2026, 9, 2, 12) });
  ex.balances.BTC.free = 1;
  await engine.orderManager.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94, clientOrderId: 's1', meta: { role: 'protective-stop', entryClientOrderId: 'e1' } });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, entryOrderId: 'e1', stopOrderId: 's1', stopPrice: 95, stopExecutionIds: [] };
  // Stop, iptal isteğinden hemen önce 0.4 doldu (WS olayı kayboldu): yerel kayıt henüz bilmiyor.
  const t = ex.byCid.get('s1'); t.fills.push({ id: 't1', qty: 0.4, price: 100, commission: 0.04, asset: 'USDT' }); t.exec = 0.4; t.quote = 40; t.status = 'PARTIALLY_FILLED'; ex.balances.BTC.locked = 0.6;
  await assert.rejects(() => engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'test', engine.epoch), /kısmen dolmuş/);
  assert.ok(Math.abs(state.live.positions['BTC/USDT'].quantity - 0.6) < 1e-9, `kalan 0.6 olmalı: ${state.live.positions['BTC/USDT'].quantity}`);
  assert.equal(ex.marketSells.length, 0, 'bu denemede market satış gönderilmemeli');
  await engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'test', engine.epoch);   // sonraki deneme
  assert.equal(ex.marketSells.length, 1);
  assert.ok(Math.abs(ex.marketSells[0].amount - 0.6) < 1e-5, `güncel miktar (0.6) satılmalı: ${ex.marketSells[0].amount}`);
});

test('canlı motor: durdurulmuş (enabled=false) coine yeni alım yok; açık pozisyonu olan durdurulmuş coin yönetilmeye devam eder', async () => {
  const ex = mkEx(); const state = store.defaultState();
  state.settings.mode = 'live'; state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  state.live.safeToTrade = true; state.running = true; state.live.lastPrices['BTC/USDT'] = 100;
  state.pairs['BTC/USDT'].enabled = false;
  let clock = Date.UTC(2026, 9, 2, 12);
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => clock });
  const seen = [];
  engine.processPair = async (symbol) => { seen.push(symbol); };
  const quietLog = console.log; console.log = () => {};
  try {
    // 1) Pozisyon yok + enabled=false: pariteye hiç dokunulmaz (alım sinyali bile değerlendirilmez).
    clock += 120000; engine.lastReconcileAt = 0; await engine.tick();
    assert.ok(!seen.includes('BTC/USDT'), 'durdurulmuş ve pozisyonsuz coin işlenmemeli');
    // 2) Açık pozisyon + enabled=false: stop/çıkış yönetimi için işlenmeye devam eder.
    ex.balances.BTC.free = 1;
    await engine.orderManager.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94, clientOrderId: 's1', meta: { role: 'protective-stop', entryClientOrderId: 'e1' } });
    state.liveOrders.e1 = { clientOrderId: 'e1', symbol: 'BTC/USDT', side: 'buy', status: 'FILLED', exchangeOrderId: 1, executedQty: 1, netExecutedQty: 1, quoteQty: 100, amount: 1 };
    state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, entryOrderId: 'e1', stopOrderId: 's1', stopPrice: 95, stopExecutionIds: [] };
    clock += 120000; engine.lastReconcileAt = 0; await engine.tick();
    assert.ok(seen.includes('BTC/USDT'), 'açık pozisyonu olan durdurulmuş coin yönetilmeye devam etmeli');
    assert.equal(state.live.positions['BTC/USDT'].stopOrderId, 's1', 'pozisyon ve stopu dokunulmadan kalmalı');
  } finally { console.log = quietLog; }
});
