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

function liveState() {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.maxConcurrentPositions = 1;
  state.settings.reserveCashPct = 0;
  state.settings.maxTradeQuote = 100;
  state.settings.dailyLossLimitPct = 100;
  state.settings.killSwitchLossPct = 0;
  state.live.safeToTrade = true;
  state.running = true;
  return state;
}

test('KAOS zinciri: kısmi stop -> yeniden başlatma -> mutabakat -> güvenli devam', async () => {
  const ex = new SimulatedExchange({ startingQuote: 900, prices: { 'BTC/USDT': 100 } });
  ex.balances.BTC = { free: 1, locked: 0 };
  ex.orders.set('stop-old', { orderId: 10, clientOrderId: 'stop-old', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', executedQty: 0, origQty: 1, stopPrice: 95, price: 94.5 });

  const state = liveState();
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopOrderId: 'stop-old', stopPrice: 95, stopExecutedQty: 0, stopCommissionBase: 0, stopNetQuoteQty: 0, stopThirdAssetCommissionQuote: 0, stopExecutionIds: [] };
  state.liveOrders['stop-old'] = { clientOrderId: 'stop-old', exchangeOrderId: 10, symbol: 'BTC/USDT', side: 'sell', status: 'NEW', meta: { role: 'protective-stop' } };
  state.pairs['BTC/USDT'].params.stopLossPct = 5;

  const engine = new LiveEngine({ exchange: ex, state, store: memStore(), allowLive: true });
  // Borsadaki gerçek kısmi stop dolumunu state'e olay olarak enjekte et.
  ex.balances.BTC.free = 0.6;
  ex.balances.USDT.free = 940;
  ex.orders.get('stop-old').status = 'PARTIALLY_FILLED';
  ex.orders.get('stop-old').executedQty = 0.4;
  ex.orders.get('stop-old').cummulativeQuoteQty = 40;
  engine._onOrderUpdate({
    symbol: 'BTC/USDT', clientOrderId: 'stop-old', status: 'PARTIALLY_FILLED',
    executedQty: 0.4, quoteQty: 40, netQuoteQty: 40, commissionByAsset: {},
    commissionBase: 0, lastExecutionId: 'stop-fill-1', meta: { role: 'protective-stop' }
  });
  await new Promise(r => setImmediate(() => setImmediate(r)));

  const remaining = state.live.positions['BTC/USDT'];
  assert.ok(remaining);
  assert.ok(Math.abs(remaining.quantity - 0.6) < 1e-12);
  const replacementId = remaining.stopOrderId;
  assert.ok(replacementId && replacementId !== 'stop-old');

  // Telefon/Termux kapanmış gibi: yalnızca diske yazılmış state ile yeni süreç başlıyor.
  const restarted = clone(state);
  const om2 = new OrderManager({ exchange: ex, state: restarted, store: memStore() });
  const rec2 = new AccountReconciler({ exchange: ex, state: restarted, store: memStore() });
  const recovery2 = new LiveRecovery({ orderManager: om2, reconciler: rec2, state: restarted, store: memStore() });
  const result = await recovery2.recover();

  assert.equal(result.safeToTrade, true);
  assert.equal(restarted.live.positions['BTC/USDT'].quantity, 0.6);
  assert.equal(restarted.live.positions['BTC/USDT'].stopOrderId, replacementId);
  assert.equal(ex.orders.get(replacementId).status, 'NEW');
});

test('KAOS zinciri: emir uygulandı -> 5xx -> güç kesildi -> yeni süreç recovery -> ikinci emir yok', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const state1 = { liveOrders: {} };
  const om1 = new OrderManager({ exchange: ex, state: state1, store: memStore() });
  ex.setFailure({ kind: 'market', executeBeforeError: true, unknownOutcome: true, httpStatus: 500, message: 'connection lost after execution' });

  const first = await om1.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'power-loss-1' });
  assert.equal(first.status, 'UNKNOWN');
  assert.equal(ex.orders.size, 1);

  const diskState = clone(state1);
  const om2 = new OrderManager({ exchange: ex, state: diskState, store: memStore() });
  const recovered = await om2.reconcile('power-loss-1');
  assert.equal(recovered.status, 'FILLED');
  assert.equal(ex.orders.size, 1);
  assert.equal(ex.balances.BTC.free, 1);
  assert.equal(ex.balances.USDT.free, 900);
});

test('KAOS: FILLED sonrası gecikmiş PARTIALLY_FILLED WebSocket olayı durumu geri düşüremez', () => {
  const state = { liveOrders: { 'race-1': { clientOrderId: 'race-1', status: 'NEW', executedQty: 0, quoteQty: 0, symbol: 'BTC/USDT', side: 'buy' } } };
  const om = new OrderManager({ exchange: { capabilities: { clientOrderId: true, orderQuery: true } }, state, store: memStore() });
  const filled = om.applyExecutionReport({ e:'executionReport', c:'race-1', i:1, s:'BTCUSDT', S:'BUY', X:'FILLED', z:'1', Z:'100', I:101, E:2000, N:'USDT', n:'0' });
  assert.equal(filled.order.status, 'FILLED');
  const delayed = om.applyExecutionReport({ e:'executionReport', c:'race-1', i:1, s:'BTCUSDT', S:'BUY', X:'PARTIALLY_FILLED', z:'0.4', Z:'40', I:100, E:1000, N:'USDT', n:'0' });
  assert.equal(delayed.order.status, 'FILLED');
  assert.equal(delayed.order.executedQty, 1);
});

test('KAOS: bakiye sorgusu sırasında kill-switch tetiklenirse ikinci kapı alış emrini engeller', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const state = liveState();
  let submitCount = 0;
  ex.fetchBalance = async () => {
    state.killSwitch = { t: new Date().toISOString(), reason: 'risk event during pre-order checks' };
    return { USDT: { free: 1000, locked: 0 } };
  };
  const original = ex.createMarketOrder.bind(ex);
  ex.createMarketOrder = async (...args) => { submitCount++; return original(...args); };
  const engine = new LiveEngine({ exchange: ex, state, store: memStore(), allowLive: true });
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'race', engine.epoch);
  assert.equal(submitCount, 0);
  assert.equal(ex.orders.size, 0);
});

test('KAOS: User Data Stream kopuksa yeni tick sinyal üretmeden önce işlem kapısı kapanır', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const state = liveState();
  state.liveReconciliation = { safeToTrade: true };
  state.liveStream = { connected: false };
  const engine = new LiveEngine({ exchange: ex, state, store: memStore(), allowLive: true, stream: {} });
  engine.reconcileEveryMs = Number.MAX_SAFE_INTEGER;
  let processed = 0;
  engine.processPair = async () => { processed++; };
  await engine.tick();
  assert.equal(processed, 0);
  assert.equal(state.live.safeToTrade, false);
});

test('KAOS birleşik: aynı anda iki stop dolumu -> tek recovery stopu', async () => {
  const state = liveState();
  state.live.positions['BTC/USDT'] = {
    symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100,
    stopOrderId:'stop-race', stopPrice:95, stopExecutedQty:0,
    stopCommissionBase:0, stopNetQuoteQty:0, stopThirdAssetCommissionQuote:0,
    stopExecutionIds:[]
  };
  state.liveOrders['stop-race'] = { clientOrderId:'stop-race', exchangeOrderId:10, symbol:'BTC/USDT', side:'sell', status:'PARTIALLY_FILLED', meta:{role:'protective-stop'} };
  state.pairs['BTC/USDT'].params.stopLossPct = 5;
  const calls=[];
  const ex = new SimulatedExchange({ startingQuote:900, prices:{'BTC/USDT':100} });
  ex.balances.BTC={free:0.6,locked:0};
  ex.cancelOrder = async (symbol,id) => { calls.push(['cancel',id]); return {status:'CANCELED', orderId:10, clientOrderId:id, symbol:'BTCUSDT', side:'SELL', executedQty:0.4, origQty:1, cummulativeQuoteQty:40}; };
  ex.createStopOrder = async (symbol,side,amount,stop,limit,cid) => { calls.push(['stop',amount]); return {status:'NEW', orderId:99, clientOrderId:cid, symbol:'BTCUSDT', side:'SELL', executedQty:0, origQty:amount, cummulativeQuoteQty:0}; };
  const engine = new LiveEngine({exchange:ex,state,store:memStore(),allowLive:true});
  engine._onOrderUpdate({symbol:'BTC/USDT',clientOrderId:'stop-race',status:'PARTIALLY_FILLED',executedQty:0.4,quoteQty:40,netQuoteQty:40,commissionByAsset:{},commissionBase:0,lastExecutionId:'race-1',meta:{role:'protective-stop'}});
  engine._onOrderUpdate({symbol:'BTC/USDT',clientOrderId:'stop-race',status:'PARTIALLY_FILLED',executedQty:0.4,quoteQty:40,netQuoteQty:40,commissionByAsset:{},commissionBase:0,lastExecutionId:'race-2',meta:{role:'protective-stop'}});
  await new Promise(r => setImmediate(() => setImmediate(r)));
  assert.equal(calls.filter(x=>x[0]==='cancel').length,1);
  assert.equal(calls.filter(x=>x[0]==='stop').length,1);
  assert.equal(state.live.positions['BTC/USDT'].quantity,0.6);
});

test('KAOS birleşik: stop kurulumu anında FILLED dönerse pozisyon açık kalmaz', async () => {
  const state = liveState();
  state.settings.maxTradeQuote=100;
  const ex = new SimulatedExchange({startingQuote:1000, prices:{'BTC/USDT':100}});
  ex.createStopOrder = async (symbol,side,amount,stop,limit,cid) => ({
    status:'FILLED', orderId:77, clientOrderId:cid, symbol:'BTCUSDT', side:'SELL',
    executedQty:amount, origQty:amount, cummulativeQuoteQty:95*amount,
    commissionByAsset:{}, commissionBase:0, netQuoteQty:95*amount,
    meta:{role:'protective-stop', entryClientOrderId:state.live.positions['BTC/USDT']?.entryOrderId}
  });
  const engine = new LiveEngine({exchange:ex,state,store:memStore(),allowLive:true});
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], {stopLossPct:5}, 100, 'instant-stop', engine.epoch);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
  assert.equal(state.live.trades.length,1);
});

test('KAOS birleşik: Binance BTCUSDT executionReport yerel BTC/USDT pozisyonunu doğru kapatır', async () => {
  const state = liveState();
  state.live.positions['BTC/USDT'] = {
    symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100,
    stopOrderId:'stop-compact', stopPrice:95, stopExecutedQty:0,
    stopCommissionBase:0, stopNetQuoteQty:0, stopThirdAssetCommissionQuote:0,
    stopExecutionIds:[]
  };
  const ex = new SimulatedExchange({startingQuote:900, prices:{'BTC/USDT':95}});
  const engine = new LiveEngine({exchange:ex,state,store:memStore(),allowLive:true});
  state.liveOrders['stop-compact'] = { clientOrderId:'stop-compact', exchangeOrderId:55, symbol:'BTC/USDT', side:'sell', status:'NEW', executedQty:0, quoteQty:0, meta:{role:'protective-stop'} };
  engine.orderManager.applyExecutionReport({e:'executionReport',E:1000,c:'stop-compact',i:55,s:'BTCUSDT',S:'SELL',X:'FILLED',x:'TRADE',q:'1',z:'1',Z:'95',I:1,N:'USDT',n:'0'});
  await new Promise(r => setImmediate(() => setImmediate(r)));
  assert.equal(state.live.positions['BTC/USDT'], undefined);
});

test('KAOS derin: REST/WebSocket/bakiye/açık emir snapshotları hangi sırada gelirse gelsin çelişki canlı kapısını açmaz', async () => {
  const { AccountReconciler } = require('../src/reconciliation');
  const baseState = () => ({
    pairs: { 'BTC/USDT': {} },
    liveOrders: {
      stop1: { clientOrderId: 'stop1', exchangeOrderId: 10, symbol: 'BTC/USDT', side: 'sell', status: 'NEW', meta: { role: 'protective-stop' } }
    },
    live: { positions: { 'BTC/USDT': { symbol: 'BTC/USDT', quantity: 1, costQuote: 100, stopOrderId: 'stop1' } } }
  });

  const snapshots = {
    consistent: {
      balances: { USDT: { free: 900, locked: 0 }, BTC: { free: 1, locked: 0 } },
      open: [{ orderId: 10, clientOrderId: 'stop1', symbol: 'BTCUSDT', side: 'sell', status: 'NEW', executedQty: 0 }]
    },
    staleBalanceAfterFill: {
      balances: { USDT: { free: 940, locked: 0 }, BTC: { free: 0.6, locked: 0 } },
      open: [{ orderId: 10, clientOrderId: 'stop1', symbol: 'BTCUSDT', side: 'sell', status: 'NEW', executedQty: 0 }]
    },
    staleOrdersAfterReplacement: {
      balances: { USDT: { free: 940, locked: 0 }, BTC: { free: 0.6, locked: 0 } },
      open: [{ orderId: 10, clientOrderId: 'stop1', symbol: 'BTCUSDT', side: 'sell', status: 'NEW', executedQty: 0 }]
    },
    missingStop: {
      balances: { USDT: { free: 900, locked: 0 }, BTC: { free: 1, locked: 0 } },
      open: []
    },
    orphanOrder: {
      balances: { USDT: { free: 900, locked: 0 }, BTC: { free: 1, locked: 0 } },
      open: [
        { orderId: 10, clientOrderId: 'stop1', symbol: 'BTCUSDT', side: 'sell', status: 'NEW', executedQty: 0 },
        { orderId: 99, clientOrderId: 'foreign', symbol: 'BTCUSDT', side: 'sell', status: 'NEW', executedQty: 0 }
      ]
    }
  };

  // Her snapshot tek başına çelişkiliyse hiçbir sırada safeToTrade=true olmamalı.
  for (const [name, snap] of Object.entries(snapshots)) {
    const state = baseState();
    if (name === 'staleBalanceAfterFill' || name === 'staleOrdersAfterReplacement') {
      // Snapshot borsa tarafında 0.6 BTC'ye düşmüş kabul ediliyor; yerel defter
      // henüz 1 BTC ise bunun güvenli kabul edilmesi yasaktır.
    }
    const ex = {
      id: 'race-test',
      capabilities: { balanceQuery: true, openOrdersQuery: true },
      async fetchBalance() { return snap.balances; },
      async fetchOpenOrders() { return snap.open; }
    };
    const r = await new AccountReconciler({ exchange: ex, state, store: memStore() }).reconcile();
    if (name === 'consistent') assert.equal(r.safeToTrade, true, name);
    else assert.equal(r.safeToTrade, false, name);
  }

  // Taze, tutarlı snapshot'a dönüldüğünde kapı tekrar açılabilir.
  const state = baseState();
  let snap = snapshots.staleBalanceAfterFill;
  const ex = {
    id: 'race-test',
    capabilities: { balanceQuery: true, openOrdersQuery: true },
    async fetchBalance() { return snap.balances; },
    async fetchOpenOrders() { return snap.open; }
  };
  const rec = new AccountReconciler({ exchange: ex, state, store: memStore() });
  const unsafe = await rec.reconcile();
  assert.equal(unsafe.safeToTrade, false);
  snap = snapshots.consistent;
  const safe = await rec.reconcile();
  assert.equal(safe.safeToTrade, true);
});

test('KAOS derin: 5000 rastgele eski/yeni executionReport + REST sorgusu monotonluğu korur', async () => {
  const { OrderManager } = require('../src/orderManager');
  const state = { liveOrders: { race: { clientOrderId: 'race', exchangeOrderId: 7, symbol: 'BTC/USDT', side: 'buy', status: 'NEW', executedQty: 0, quoteQty: 0, commissionByAsset: {} } } };
  const store = memStore();
  const rest = { status: 'PARTIALLY_FILLED', orderId: 7, clientOrderId: 'race', symbol: 'BTCUSDT', side: 'BUY', executedQty: 0.2, origQty: 1, cummulativeQuoteQty: 20, fills: [] };
  const ex = {
    id: 'race-test',
    capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true },
    async createMarketOrder() { throw new Error('not used'); },
    async getOrder() { return rest; }
  };
  const om = new OrderManager({ exchange: ex, state, store });
  const levels = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1];
  const seed = 0x51f15e;
  let x = seed >>> 0;
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 0x100000000; };
  let maxSeen = 0;
  for (let i = 0; i < 5000; i++) {
    const level = levels[Math.floor(rnd() * levels.length)];
    const status = level >= 1 ? 'FILLED' : 'PARTIALLY_FILLED';
    const id = 1000 + i;
    const event = { e: 'executionReport', E: i + 1, c: 'race', i: 7, s: 'BTCUSDT', S: 'BUY', X: status, x: 'TRADE', q: '1', z: String(level), Z: String(level * 100), I: id, N: 'USDT', n: '0' };
    const result = om.applyExecutionReport(event);
    maxSeen = Math.max(maxSeen, level);
    assert.ok(Number(result.order.executedQty) + 1e-12 >= maxSeen);
    if (i % 3 === 0) {
      const reconciled = await om.reconcile('race');
      assert.ok(Number(reconciled.executedQty) + 1e-12 >= maxSeen);
    }
  }
  assert.equal(state.liveOrders.race.status, 'FILLED');
  assert.equal(state.liveOrders.race.executedQty, 1);
});

test('KAOS: BUY emri 5xx/timeout ile UNKNOWN olursa canlı kapısı açık kalmaz', async () => {
  const LiveEngine = require('../src/liveEngine');
  const state = {
    settings: { mode: 'live', maxConcurrentPositions: 1, reserveCashPct: 0, maxTradeQuote: 0, pollSeconds: 60 },
    killSwitch: false,
    live: { positions: {}, safeToTrade: true, trades: [], stats: { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, realizedPnl: 0 }, realizedPnl: 0, dayRealizedPnl: 0 },
    pairs: { 'BTC/USDT': { budgetPct: 100, params: { stopLossPct: 2 } } },
    liveOrders: {}, log: []
  };
  const store = { save() {} };
  const ex = {
    name: 'chaos', id: 'test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, liveTradingVerified: true },
    async fetchBalance() { return { USDT: { free: 1000 } }; },
    async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { minNotional: 10, marketStepSize: 0.001, minQty: 0.001, maxQty: 100, tickSize: 0.01 }; },
    async createMarketOrder() { const e = new Error('timeout after exchange accepted order'); e.unknownOutcome = true; e.httpStatus = 504; throw e; },
    async getOrder() { return { status: 'UNKNOWN' }; },
    async createStopOrder() { throw new Error('must not reach stop creation'); },
    async cancelOrder() { throw new Error('must not reach cancel'); }
  };
  const engine = new LiveEngine({ exchange: ex, store, state, allowLive: true });
  engine.epoch = 1;
  await assert.rejects(() => engine.buy('BTC/USDT', state.pairs['BTC/USDT'], state.pairs['BTC/USDT'].params, 100, 'chaos', 1), /belirsiz/);
  assert.equal(state.live.safeToTrade, false);
  assert.equal(Object.keys(state.live.positions).length, 0);
});

test('KAOS birleşik: fiyat çöküşü + kısmi market dolumu + güç kesintisi sonrası açık giriş emri canlı kapısını açmaz', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const s1 = liveState();
  const om1 = new OrderManager({ exchange: ex, state: s1, store: memStore() });
  ex.setFailure({ kind: 'market', executeBeforeError: true, unknownOutcome: true, partialPct: 50, httpStatus: 500, message: 'power loss after partial fill' });

  const first = await om1.submitMarket({
    symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'chaos-partial-entry'
  });
  assert.equal(first.status, 'UNKNOWN');
  assert.equal(ex.orders.get('chaos-partial-entry').status, 'PARTIALLY_FILLED');
  assert.equal(ex.balances.BTC.free, 0.5);

  // Piyasa aynı anda sert düşüyor; süreç kapanıyor.
  ex.setPrice('BTC/USDT', 50);
  const diskState = clone(s1);
  const om2 = new OrderManager({ exchange: ex, state: diskState, store: memStore() });
  const rec2 = new AccountReconciler({ exchange: ex, state: diskState, store: memStore() });
  const recovery = await new LiveRecovery({ orderManager: om2, reconciler: rec2, state: diskState, store: memStore() }).recover();

  assert.equal(recovery.safeToTrade, false);
  assert.ok(recovery.account.unknownLocalOrders.length === 0);
  assert.ok(recovery.account.openOrders.some(o => o.clientOrderId === 'chaos-partial-entry'));
  assert.ok(recovery.account.errors.length > 0 || recovery.errors.length > 0);
});

test('KAOS stres: 1000 rastgele çoklu arıza kombinasyonunda recovery yalnızca güvenli duruma izin verir', async () => {
  let seed = 0x51a7c0de;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const modes = ['priceCrash', 'unknownMarket', 'orphanOrder', 'balanceMismatch', 'killSwitch'];
  for (let i = 0; i < 1000; i++) {
    const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
    const s = liveState();
    const mode = modes[Math.floor(rnd() * modes.length)];
    if (mode === 'priceCrash') ex.setPrice('BTC/USDT', 100 * (0.1 + rnd() * 0.9));
    if (mode === 'unknownMarket') {
      const om = new OrderManager({ exchange: ex, state: s, store: memStore() });
      ex.setFailure({ kind: 'market', executeBeforeError: true, unknownOutcome: true, partialPct: 25 + rnd() * 50, httpStatus: 500 });
      await om.submitMarket({ symbol:'BTC/USDT', side:'buy', amount:0.5, clientOrderId:`chaos-${i}` });
    }
    if (mode === 'orphanOrder') ex.orders.set(`orphan-${i}`, { orderId:9000+i, clientOrderId:`orphan-${i}`, symbol:'BTC/USDT', side:'BUY', status:'NEW', executedQty:0, origQty:0.1, price:100 });
    if (mode === 'balanceMismatch') ex.balances.BTC = { free: 0.25 + rnd(), locked: 0 };
    if (mode === 'killSwitch') s.killSwitch = { t:new Date().toISOString(), reason:'chaos-test' };
    const disk = clone(s);
    const om2 = new OrderManager({ exchange:ex, state:disk, store:memStore() });
    const rec2 = new AccountReconciler({ exchange:ex, state:disk, store:memStore() });
    const recovery = await new LiveRecovery({ orderManager:om2, reconciler:rec2, state:disk, store:memStore() }).recover();
    if (mode !== 'priceCrash') assert.equal(recovery.safeToTrade, false, `iteration ${i}, mode ${mode}`);
    else assert.equal(recovery.safeToTrade, true, `iteration ${i}, mode ${mode}`);
  }
});
