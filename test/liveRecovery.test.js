const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveRecovery } = require('../src/liveRecovery');
const LiveEngine = require('../src/liveEngine');
const { OrderManager } = require('../src/orderManager');
const { SimulatedExchange } = require('../src/simulatedExchange');
const stateStore = require('../src/store');

function memStore() { return { save() {} }; }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

function store() { return { saves: 0, save() { this.saves++; } }; }

test('restart recovery önce açık emirleri çözer, sonra hesabı mutabakat yapar', async () => {
  const calls = [];
  const state = { liveOrders: {} };
  const st = store();
  const orderManager = { async reconcileAll() { calls.push('orders'); return [{ status: 'FILLED' }]; } };
  const reconciler = { async reconcile() { calls.push('account'); return { safeToTrade: true }; } };
  const r = await new LiveRecovery({ orderManager, reconciler, state, store: st, nowFn: () => 0 }).recover();
  assert.deepEqual(calls, ['orders', 'account']);
  assert.equal(r.safeToTrade, true);
  assert.equal(state.liveRecovery.safeToTrade, true);
});

test('emir kurtarma hata verirse canlı geçiş güvenli sayılmaz', async () => {
  const state = { liveOrders: {} };
  const st = store();
  const orderManager = { async reconcileAll() { throw new Error('timeout'); } };
  const reconciler = { async reconcile() { return { safeToTrade: true }; } };
  const r = await new LiveRecovery({ orderManager, reconciler, state, store: st }).recover();
  assert.equal(r.safeToTrade, false);
  assert.match(r.errors[0], /timeout/);
});

test('recovery hesap mutabakatı güvenli değilse eski safeToTrade durumu geri açılmaz', async () => {
  const state = { liveOrders:{}, live:{safeToTrade:false} };
  const st = store();
  const orderManager = { async reconcileAll(){ return []; } };
  const reconciler = { async reconcile(){ return { safeToTrade:false, errors:['mismatch'] }; } };
  const r = await new LiveRecovery({orderManager,reconciler,state,store:st}).recover();
  assert.equal(r.safeToTrade,false);
  assert.equal(state.liveRecovery.safeToTrade,false);
});

test('RED TEAM P0: UNKNOWN BUY -> FILLED recovery local pozisyonu yeniden kurar ve koruyucu stop oluşturur', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.setFailure({ kind: 'market', executeBeforeError: true, unknownOutcome: true, httpStatus: 500 });
  const s = stateStore.defaultState();
  s.settings.mode = 'live'; s.settings.quoteAsset = 'USDT'; s.settings.maxTradeQuote = 100; s.settings.dailyLossLimitPct = 5; s.settings.killSwitchLossPct = 25;
  s.pairs['BTC/USDT'].enabled = true; s.pairs['BTC/USDT'].params = { ...s.pairs['BTC/USDT'].params, stopLossPct: 5, takeProfitPct: 0, trailingStop: false };
  const om1 = new OrderManager({ exchange: ex, state: s, store: memStore() });
  const first = await om1.submitMarket({ symbol:'BTC/USDT', side:'buy', amount:1, meta:{ role:'entry', reason:'red-team' } });
  assert.equal(first.status, 'UNKNOWN');
  assert.equal(ex.balances.BTC.free, 1);

  const restarted = clone(s);
  const engine = new LiveEngine({ exchange: ex, state: restarted, store: memStore(), allowLive: true });
  const result = await engine.recovery.recover();
  assert.equal(result.safeToTrade, true);
  assert.ok(restarted.live.positions['BTC/USDT']);
  const pos = restarted.live.positions['BTC/USDT'];
  assert.equal(pos.quantity, 1);
  assert.ok(pos.stopOrderId);
  assert.equal(ex.orders.get(pos.stopOrderId).status, 'NEW');
});

test('RED TEAM P0: orphan STOP recovery mevcut stopu sahiplenir, ikinci STOP açmaz', async () => {
  const ex = new SimulatedExchange({ startingQuote: 900, prices: { 'BTC/USDT': 100 } });
  ex.balances.BTC = { free: 1, locked: 0 };
  ex.orders.set('real-stop', { orderId: 77, clientOrderId:'real-stop', symbol:'BTC/USDT', side:'sell', status:'NEW', executedQty:0, origQty:1, stopPrice:95, price:94.5 });
  const s = stateStore.defaultState();
  s.settings.mode='live'; s.settings.quoteAsset='USDT'; s.settings.maxTradeQuote=100; s.settings.dailyLossLimitPct=5; s.settings.killSwitchLossPct=25;
  s.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', baseAsset:'BTC', quoteAsset:'USDT', quantity:1, entryPrice:100, costQuote:100, entryOrderId:'buy-1', stopOrderId:null, stopPrice:95, tpOrderId:null, tpPrice:null, protectiveMode:'single-stop', takeProfitPct:0, trailingStop:false };
  const engine = new LiveEngine({ exchange:ex, state:s, store:memStore(), allowLive:true });
  const result = await engine.recovery.recover();
  assert.equal(result.safeToTrade, true);
  assert.equal(s.live.positions['BTC/USDT'].stopOrderId, 'real-stop');
  assert.equal(ex.orders.size, 1);
});

test('RED TEAM P0: iki eşleşen orphan STOP varsa yeni emir açılmaz ve canlı kapı kilitlenir', async () => {
  const ex = new SimulatedExchange({ startingQuote: 900, prices: { 'BTC/USDT': 100 } });
  ex.balances.BTC = { free: 1, locked: 0 };
  ex.orders.set('stop-a', { orderId: 77, clientOrderId:'stop-a', symbol:'BTC/USDT', side:'sell', status:'NEW', executedQty:0, origQty:1, stopPrice:95, price:94.5 });
  ex.orders.set('stop-b', { orderId: 78, clientOrderId:'stop-b', symbol:'BTC/USDT', side:'sell', status:'NEW', executedQty:0, origQty:1, stopPrice:94, price:93.5 });
  const s = stateStore.defaultState();
  s.settings.mode='live'; s.settings.quoteAsset='USDT';
  s.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', baseAsset:'BTC', quoteAsset:'USDT', quantity:1, entryPrice:100, costQuote:100, entryOrderId:'buy-1', stopOrderId:null, protectiveMode:'single-stop', takeProfitPct:0 };
  const engine = new LiveEngine({ exchange:ex, state:s, store:memStore(), allowLive:true });
  const result = await engine.recovery.recover();
  assert.equal(result.safeToTrade, false);
  assert.equal(ex.orders.size, 2);
});
