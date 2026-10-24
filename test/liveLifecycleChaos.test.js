const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { SimulatedExchange } = require('../src/simulatedExchange');
const { OrderManager } = require('../src/orderManager');
const { AccountReconciler } = require('../src/reconciliation');
const { LiveRecovery } = require('../src/liveRecovery');
const LiveEngine = require('../src/liveEngine');

function memStore() { return { save() {} }; }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function state() {
  const s = store.defaultState();
  s.settings.mode = 'live';
  s.settings.maxConcurrentPositions = 1;
  s.settings.reserveCashPct = 0;
  s.settings.maxTradeQuote = 100;
  s.settings.dailyLossLimitPct = 100;
  s.settings.killSwitchLossPct = 0;
  s.live.safeToTrade = true;
  s.running = true;
  return s;
}

async function settle() {
  await new Promise(r => setImmediate(() => setImmediate(r)));
}

// Her senaryoda temel invariant: gerçek pozisyon yerelde biliniyorsa ve miktar > 0 ise
// ya koruyucu stop doğrulanmış olmalı ya da canlı kapısı kesinlikle kapalı olmalı.
function assertProtectionInvariant(s) {
  for (const pos of Object.values(s.live.positions || {})) {
    if (Number(pos.quantity) > 0) {
      const protectedByStop = !!pos.stopOrderId;
      assert.ok(protectedByStop || s.live.safeToTrade === false,
        `korumasız açık pozisyon canlı kapısını açmış: ${pos.symbol}`);
    }
  }
}

test('YAŞAM DÖNGÜSÜ: BUY -> stop -> bağlantı kopması -> restart -> reconciliation -> güvenli devam', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const s1 = state();
  const e1 = new LiveEngine({ exchange: ex, state: s1, store: memStore(), allowLive: true });

  await e1.buy('BTC/USDT', s1.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'lifecycle', e1.epoch);
  const pos1 = s1.live.positions['BTC/USDT'];
  assert.ok(pos1?.stopOrderId);
  assert.equal(ex.orders.get(pos1.stopOrderId).status, 'NEW');
  assertProtectionInvariant(s1);

  // Süreç kapanıyor: disk state'i ile yeni süreç.
  const s2 = clone(s1);
  const om = new OrderManager({ exchange: ex, state: s2, store: memStore() });
  const rec = new AccountReconciler({ exchange: ex, state: s2, store: memStore() });
  const recovery = new LiveRecovery({ orderManager: om, reconciler: rec, state: s2, store: memStore() });
  const result = await recovery.recover();
  assert.equal(result.safeToTrade, true);
  assert.equal(s2.live.positions['BTC/USDT'].stopOrderId, pos1.stopOrderId);
  assertProtectionInvariant(s2);
});

test('YAŞAM DÖNGÜSÜ: BUY gerçekleşir -> STOP UNKNOWN -> restart -> güvenli kapı kapalı', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.setFailure({ kind: 'stop', executeBeforeError: true, unknownOutcome: true, httpStatus: 500 });
  const s = state();
  const e = new LiveEngine({ exchange: ex, state: s, store: memStore(), allowLive: true });
  await assert.rejects(() => e.buy('BTC/USDT', s.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'stop-unknown', e.epoch));
  assert.equal(s.live.safeToTrade, false);
  assert.ok(s.live.positions['BTC/USDT']);
  assert.equal(s.live.positions['BTC/USDT'].stopOrderId, null);
  assertProtectionInvariant(s);

  const restarted = clone(s);
  const om = new OrderManager({ exchange: ex, state: restarted, store: memStore() });
  const rec = new AccountReconciler({ exchange: ex, state: restarted, store: memStore() });
  const result = await new LiveRecovery({ orderManager: om, reconciler: rec, state: restarted, store: memStore() }).recover();
  assert.equal(result.safeToTrade, false);
  assertProtectionInvariant(restarted);
});

test('YAŞAM DÖNGÜSÜ: BUY UNKNOWN -> restart -> order reconciliation -> ikinci BUY yok', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.setFailure({ kind: 'market', executeBeforeError: true, unknownOutcome: true, httpStatus: 500 });
  const s1 = state();
  const om1 = new OrderManager({ exchange: ex, state: s1, store: memStore() });
  const first = await om1.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'lifecycle-unknown-buy' });
  assert.equal(first.status, 'UNKNOWN');
  assert.equal(ex.orders.size, 1);

  const s2 = clone(s1);
  const om2 = new OrderManager({ exchange: ex, state: s2, store: memStore() });
  const recovered = await om2.reconcile('lifecycle-unknown-buy');
  assert.equal(recovered.status, 'FILLED');
  assert.equal(ex.orders.size, 1);
  assert.equal(ex.balances.BTC.free, 1);
  assert.equal(ex.balances.USDT.free, 900);
});

test('YAŞAM DÖNGÜSÜ: STOP FILLED -> gecikmiş eski event -> restart -> pozisyon yeniden açılamaz', async () => {
  const ex = new SimulatedExchange({ startingQuote: 900, prices: { 'BTC/USDT': 95 } });
  ex.balances.BTC = { free: 1, locked: 0 };
  const s = state();
  s.live.positions['BTC/USDT'] = {
    symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100,
    entryOrderId:'buy-1', stopOrderId:'stop-1', stopPrice:95,
    stopExecutedQty:0, stopCommissionBase:0, stopNetQuoteQty:0,
    stopThirdAssetCommissionQuote:0, stopExecutionIds:[]
  };
  s.liveOrders['stop-1'] = { clientOrderId:'stop-1', exchangeOrderId:1, symbol:'BTC/USDT', side:'sell', status:'NEW', executedQty:0, quoteQty:0, meta:{role:'protective-stop'} };
  const e = new LiveEngine({ exchange: ex, state:s, store:memStore(), allowLive:true });

  e.orderManager.applyExecutionReport({ e:'executionReport', c:'stop-1', i:1, s:'BTCUSDT', S:'SELL', X:'FILLED', x:'TRADE', q:'1', z:'1', Z:'95', I:10, N:'USDT', n:'0' });
  await settle();
  assert.equal(s.live.positions['BTC/USDT'], undefined);

  // Gecikmiş eski event, kapanmış pozisyonu yeniden oluşturmamalı.
  e.orderManager.applyExecutionReport({ e:'executionReport', c:'stop-1', i:1, s:'BTCUSDT', S:'SELL', X:'PARTIALLY_FILLED', x:'TRADE', q:'0.4', z:'0.4', Z:'38', I:9, N:'USDT', n:'0' });
  await settle();
  assert.equal(s.live.positions['BTC/USDT'], undefined);
});

test('YAŞAM DÖNGÜSÜ: STOP cancel UNKNOWN -> market SELL kesinlikle gönderilmez', async () => {
  const ex = new SimulatedExchange({ startingQuote: 900, prices: { 'BTC/USDT': 100 } });
  ex.balances.BTC = { free: 1, locked: 0 };
  const s = state();
  s.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100, stopOrderId:'stop-cancel-unknown', stopPrice:95 };
  s.liveOrders['stop-cancel-unknown'] = { clientOrderId:'stop-cancel-unknown', exchangeOrderId:1, symbol:'BTC/USDT', side:'sell', status:'NEW', executedQty:0, quoteQty:0, meta:{role:'protective-stop'} };
  ex.orders.set('stop-cancel-unknown', { orderId:1, clientOrderId:'stop-cancel-unknown', symbol:'BTC/USDT', side:'sell', status:'NEW', executedQty:0, origQty:1, stopPrice:95, price:94.5 });
  ex.setFailure({ kind:'cancel', unknownOutcome:true, httpStatus:500 });
  let marketCalls = 0;
  const original = ex.createMarketOrder.bind(ex);
  ex.createMarketOrder = async (...args) => { marketCalls++; return original(...args); };
  const e = new LiveEngine({ exchange:ex, state:s, store:memStore(), allowLive:true });
  await assert.rejects(() => e.sell('BTC/USDT', s.live.positions['BTC/USDT'], 100, 'signal', e.epoch));
  assert.equal(marketCalls, 0);
  assert.equal(s.live.safeToTrade, false);
});

test('YAŞAM DÖNGÜSÜ: restart sırasında bakiye + açık stop tutarlıysa kapı açılır; bir veri eskiyse kapanır', async () => {
  const ex = new SimulatedExchange({ startingQuote:900, prices:{'BTC/USDT':100} });
  ex.balances.BTC = { free:1, locked:0 };
  ex.orders.set('stop-1',{orderId:1,clientOrderId:'stop-1',symbol:'BTC/USDT',side:'sell',status:'NEW',executedQty:0,origQty:1,stopPrice:95,price:94.5});
  const base = state();
  base.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100, stopOrderId:'stop-1', stopPrice:95 };
  base.liveOrders['stop-1'] = { clientOrderId:'stop-1', exchangeOrderId:1, symbol:'BTC/USDT', side:'sell', status:'NEW', executedQty:0, quoteQty:0, meta:{role:'protective-stop'} };

  const good = clone(base);
  const goodResult = await new LiveRecovery({
    orderManager:new OrderManager({exchange:ex,state:good,store:memStore()}),
    reconciler:new AccountReconciler({exchange:ex,state:good,store:memStore()}), state:good,store:memStore()
  }).recover();
  assert.equal(goodResult.safeToTrade,true);

  const stale = clone(base);
  ex.balances.BTC.free = 0.6;
  const staleResult = await new LiveRecovery({
    orderManager:new OrderManager({exchange:ex,state:stale,store:memStore()}),
    reconciler:new AccountReconciler({exchange:ex,state:stale,store:memStore()}), state:stale,store:memStore()
  }).recover();
  assert.equal(staleResult.safeToTrade,false);
  assert.equal(staleResult.safeToTrade,false);
});

test('YAŞAM DÖNGÜSÜ: aynı clientOrderId ile recovery sonrası ikinci BUY gönderilemez', async () => {
  const ex = new SimulatedExchange({ startingQuote:1000, prices:{'BTC/USDT':100} });
  const s = { liveOrders:{} };
  const om = new OrderManager({exchange:ex,state:s,store:memStore()});
  const first = await om.submitMarket({symbol:'BTC/USDT',side:'buy',amount:1,clientOrderId:'idempotent-life'});
  assert.equal(first.status,'FILLED');
  const before = ex.orders.size;
  const second = await om.submitMarket({symbol:'BTC/USDT',side:'buy',amount:1,clientOrderId:'idempotent-life'});
  assert.equal(second.reused,true);
  assert.equal(ex.orders.size,before);
  assert.equal(ex.balances.BTC.free,1);
});

test('YAŞAM DÖNGÜSÜ: kill-switch kalıcıysa yeniden başlatma kapısı kesinlikle açılmaz', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const s = state();
  s.killSwitch = { t: new Date().toISOString(), reason: 'önceki süreçte toplam zarar limiti aşıldı' };
  const e = new LiveEngine({ exchange: ex, state: s, store: memStore(), allowLive: true });
  await assert.rejects(() => e.start(), /Kill switch devrede/);
  assert.equal(s.running, true);
  assert.equal(s.live.safeToTrade, true);
  assert.equal(e.timer, null);
});

test('YAŞAM DÖNGÜSÜ: restart sonrası borsadaki tanınmayan açık emir canlı kapısını açmaz', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.orders.set('orphan-1', {
    orderId: 77, clientOrderId: 'orphan-1', symbol: 'BTC/USDT', side: 'BUY',
    status: 'NEW', executedQty: 0, origQty: 1, price: 100
  });
  const s = state();
  const om = new OrderManager({ exchange: ex, state: s, store: memStore() });
  const rec = new AccountReconciler({ exchange: ex, state: s, store: memStore() });
  const result = await new LiveRecovery({ orderManager: om, reconciler: rec, state: s, store: memStore() }).recover();
  assert.equal(result.safeToTrade, false);
  assert.equal(result.account.orphanOpenOrders.length, 1);
  assert.equal(result.account.orphanOpenOrders[0].orderId, 77);
});

test('YAŞAM DÖNGÜSÜ: restart sonrası exchange üzerinde kayıp local emir canlı kapısını açmaz', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const s = state();
  s.liveOrders['missing-1'] = {
    clientOrderId: 'missing-1', exchangeOrderId: 88, symbol: 'BTC/USDT', side: 'BUY',
    status: 'NEW', executedQty: 0, quoteQty: 0
  };
  const om = new OrderManager({ exchange: ex, state: s, store: memStore() });
  const rec = new AccountReconciler({ exchange: ex, state: s, store: memStore() });
  const result = await new LiveRecovery({ orderManager: om, reconciler: rec, state: s, store: memStore() }).recover();
  assert.equal(result.safeToTrade, false);
  assert.equal(result.account.unknownLocalOrders.length, 1);
  assert.equal(result.account.unknownLocalOrders[0].exchangeOrderId, 88);
});

test('YAŞAM DÖNGÜSÜ: restart sonrası stop borsada FILLED ama local pozisyon açık kalmışsa kapı açılmaz', async () => {
  const ex = new SimulatedExchange({ startingQuote: 900, prices: { 'BTC/USDT': 95 } });
  ex.balances.BTC = { free: 0, locked: 0 };
  ex.orders.set('stop-filled', {
    orderId: 91, clientOrderId: 'stop-filled', symbol: 'BTC/USDT', side: 'SELL',
    status: 'FILLED', executedQty: 1, origQty: 1, stopPrice: 95, price: 94.5
  });
  const s = state();
  s.live.positions['BTC/USDT'] = {
    symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100,
    stopOrderId: 'stop-filled', stopPrice: 95
  };
  s.liveOrders['stop-filled'] = {
    clientOrderId: 'stop-filled', exchangeOrderId: 91, symbol: 'BTC/USDT', side: 'SELL',
    status: 'FILLED', executedQty: 1, quoteQty: 95, meta: { role: 'protective-stop' }
  };
  const om = new OrderManager({ exchange: ex, state: s, store: memStore() });
  const rec = new AccountReconciler({ exchange: ex, state: s, store: memStore() });
  const result = await new LiveRecovery({ orderManager: om, reconciler: rec, state: s, store: memStore() }).recover();
  assert.equal(result.safeToTrade, false);
  assert.ok(result.account.errors.some(x => /Koruyucu stop açık değil/.test(x) || /bakiye/.test(x)));
});
