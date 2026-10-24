const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const { SimulatedExchange } = require('../src/simulatedExchange');
const { OrderManager } = require('../src/orderManager');
// Testler gercek saate BAGLI OLMASIN (sabit tarihli gun anahtarlari, Turkiye gece yarisini gecince bozuluyordu).
const FIXED_NOW = () => Date.UTC(2026, 9, 2, 12, 0);

function makeStore() { return { saves: 0, save() { this.saves++; } }; }
async function withTestnetEnv(fn) {
  const keys = ['BINANCE_ENV', 'ALLOW_BINANCE_TESTNET_TRADING', 'LIVE_TRADING_ENABLED', 'BINANCE_ALLOW_LOCAL_BASE_URL', 'ALLOW_PRODUCTION_TRADING'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.BINANCE_ENV = 'testnet';
  process.env.ALLOW_BINANCE_TESTNET_TRADING = 'true';
  process.env.LIVE_TRADING_ENABLED = 'true';
  delete process.env.BINANCE_ALLOW_LOCAL_BASE_URL;
  delete process.env.ALLOW_PRODUCTION_TRADING;
  try { return await fn(); } finally { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}
function makeExchange() {
  return {
    id: 'binance', environment: 'testnet', name: 'Test', quoteAssets: ['USDT'], // canli mod yalnizca binance kimligiyle baslar
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { return { USDT: { free: 1000, locked: 0 } }; },
    async fetchOpenOrders() { return []; },
    async getOrder() { return { status: 'FILLED', orderId: 1, clientOrderId: 'x', executedQty: 1, origQty: 1, cummulativeQuoteQty: 100 }; },
    async createMarketOrder(symbol, side, amount, cid) { return { status: 'FILLED', orderId: 1, clientOrderId: cid, executedQty: amount, origQty: amount, cummulativeQuoteQty: amount * 100 }; },
    async createStopOrder(symbol, side, amount, stop, limit, cid) { return { status: 'NEW', orderId: 2, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async createTakeProfitOrder(symbol, side, amount, stop, limit, cid) { return { status: 'NEW', orderId: 3, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async createOcoOrder(symbol, side, amount, args) {
      return { orderListId: 9, listClientOrderId: args.listClientOrderId, orders: [
        { orderId: 3, clientOrderId: args.takeProfitClientOrderId, symbol: 'BTCUSDT' },
        { orderId: 2, clientOrderId: args.stopClientOrderId, symbol: 'BTCUSDT' }
      ], orderReports: [
        { orderId: 3, clientOrderId: args.takeProfitClientOrderId, symbol: 'BTCUSDT', status: 'NEW', side: 'SELL', executedQty: 0, origQty: amount, stopPrice: args.takeProfitPrice },
        { orderId: 2, clientOrderId: args.stopClientOrderId, symbol: 'BTCUSDT', status: 'NEW', side: 'SELL', executedQty: 0, origQty: amount, stopPrice: args.stopPrice }
      ] };
    },
    async cancelOrder(symbol, orderId) { return { status: 'CANCELED', orderId }; },
    async fetchCandles() { return []; },
    async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10 }; }
  };
}

test('LiveEngine canlı güvenlik kilidi olmadan başlamaz', async () => {
  const state = store.defaultState(); state.settings.mode = 'live';
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: false });
  await assert.rejects(() => engine.start(), /LIVE_TRADING_ENABLED/);
});

test('LiveEngine recovery başarısızsa gerçek emir motorunu başlatmaz', async () => withTestnetEnv(async () => {
  const state = store.defaultState(); state.settings.mode = 'live'; Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
  const st = makeStore();
  const engine = new LiveEngine({
    exchange: makeExchange(), state, store: st, allowLive: true, nowFn: FIXED_NOW,
    recovery: { async recover() { return { safeToTrade: false }; } }
  });
  await assert.rejects(() => engine.start(), /güvenli değil/);
  assert.equal(state.running, false);
  assert.equal(engine.timer, null);
}));

test('OrderManager koruyucu stop emrini kaydeder ve iptal eder', async () => {
  const state = { liveOrders: {} }, st = makeStore(), ex = makeExchange();
  const om = new OrderManager({ exchange: ex, state, store: st });
  const stop = await om.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94.5, clientOrderId: 'stop-1' });
  assert.equal(stop.status, 'NEW');
  const canceled = await om.cancel('stop-1');
  assert.equal(canceled.status, 'CANCELED');
});


test('STOP cancel UNKNOWN dönerse market satışına geçmez', async () => {
  const state = store.defaultState(); state.settings.mode = 'live';
  state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  state.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100, stopOrderId:'stop-unknown' };
  state.liveOrders['stop-unknown'] = { clientOrderId:'stop-unknown', exchangeOrderId:2, symbol:'BTC/USDT', side:'sell', amount:1, status:'NEW', meta:{role:'protective-stop'} };
  const ex = makeExchange();
  let marketCalls = 0;
  ex.cancelOrder = async (symbol, orderId) => ({ orderId, clientOrderId:'stop-unknown', symbol:'BTCUSDT', side:'SELL', status:'UNKNOWN', executedQty:0, cummulativeQuoteQty:0 });
  ex.createMarketOrder = async (...args) => { marketCalls++; return makeExchange().createMarketOrder(...args); };
  const engine = new LiveEngine({ exchange:ex, state, store:makeStore(), allowLive:true });
  await assert.rejects(() => engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'test', engine.epoch), /iptal edilemedi/);
  assert.equal(marketCalls, 0);
  assert.equal(state.live.safeToTrade, false);
});

test('koruyucu stop dolarsa LiveEngine yerel pozisyonu kapatır', async () => {
  const state = store.defaultState(); state.settings.mode = 'live';
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, stopOrderId: 'stop-1' };
  const st = makeStore();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: st, allowLive: true, nowFn: FIXED_NOW });
  engine._onOrderUpdate({ symbol: 'BTC/USDT', clientOrderId: 'stop-1', status: 'FILLED', executedQty: 1, quoteQty: 100, netQuoteQty: 100, commissionByAsset: {}, commissionBase: 0, lastExecutionId: 'stop-fill-1', meta: { role: 'protective-stop' } });
  await new Promise(r => setImmediate(r));
  assert.equal(state.live.positions['BTC/USDT'], undefined);
});



test('koruyucu stop kısmi dolarsa kalan pozisyon için eski stop iptal edilip yeni stop kurulur', async () => {
  const state = store.defaultState(); state.settings.mode='live'; state.settings.dailyLossLimitPct=100; state.settings.killSwitchLossPct=0;
  state.liveOrders['stop-partial'] = {clientOrderId:'stop-partial', symbol:'BTC/USDT', side:'sell', status:'PARTIALLY_FILLED', exchangeOrderId:5, meta:{role:'protective-stop'}};
  state.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100, stopOrderId:'stop-partial', stopPrice:95, stopExecutedQty:0, stopCommissionBase:0, stopNetQuoteQty:0, stopThirdAssetCommissionQuote:0, stopExecutionIds:[] };
  state.pairs['BTC/USDT'].params.stopLossPct = 5;
  const calls=[];
  const ex=makeExchange();
  ex.cancelOrder = async (symbol, orderId) => { calls.push(['cancel', orderId]); return {status:'CANCELED', orderId, clientOrderId:'stop-partial', symbol:'BTCUSDT', side:'SELL', executedQty:0.4, origQty:1, cummulativeQuoteQty:40}; };
  ex.createStopOrder = async (symbol, side, amount, stop, limit, cid) => { calls.push(['stop', amount]); return {status:'NEW', orderId:99, clientOrderId:cid, symbol:'BTCUSDT', side:'SELL', executedQty:0, origQty:amount, cummulativeQuoteQty:0}; };
  const engine=new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  engine._onOrderUpdate({symbol:'BTC/USDT',clientOrderId:'stop-partial',exchangeOrderId:5,status:'PARTIALLY_FILLED',executedQty:0.4,quoteQty:40,netQuoteQty:40,commissionByAsset:{},commissionBase:0,lastExecutionId:'fill-1',meta:{role:'protective-stop'}});
  await new Promise(r => setImmediate(() => setImmediate(r)));
  assert.equal(calls[0][0],'cancel');
  assert.equal(calls[1][0],'stop');
  assert.ok(Math.abs(calls[1][1]-0.6)<1e-12);
  assert.ok(Math.abs(state.live.positions['BTC/USDT'].quantity-0.6)<1e-12);
  assert.equal(state.live.positions['BTC/USDT'].stopOrderId, state.liveOrders[Object.keys(state.liveOrders).find(k => state.liveOrders[k].meta?.role === 'protective-stop-recovery')]?.clientOrderId);
  assert.equal(state.live.trades.length,1);
});

test('FILLED bildirimi anlamlı miktar bırakırsa pozisyon silinmez ve kalan miktara stop kurulur', async () => {
  const state = store.defaultState(); state.settings.mode='live'; state.settings.dailyLossLimitPct=100; state.settings.killSwitchLossPct=0;
  state.liveOrders['stop-filled-residual'] = {clientOrderId:'stop-filled-residual', symbol:'BTC/USDT', side:'sell', status:'FILLED', exchangeOrderId:5, amount:1, meta:{role:'protective-stop'}};
  state.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100, stopOrderId:'stop-filled-residual', stopPrice:95, stopExecutedQty:0, stopCommissionBase:0, stopNetQuoteQty:0, stopThirdAssetCommissionQuote:0, stopExecutionIds:[] };
  state.pairs['BTC/USDT'].params.stopLossPct = 5;
  const calls=[];
  const ex=makeExchange();
  ex.createStopOrder = async (symbol, side, amount, stop, limit, cid) => {
    calls.push({amount, stop, cid});
    return {status:'NEW', orderId:99, clientOrderId:cid, symbol:'BTCUSDT', side:'SELL', executedQty:0, origQty:amount, cummulativeQuoteQty:0};
  };
  const engine=new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  engine._onOrderUpdate({symbol:'BTC/USDT',clientOrderId:'stop-filled-residual',exchangeOrderId:5,status:'FILLED',executedQty:0.5,quoteQty:50,netQuoteQty:50,commissionByAsset:{},commissionBase:0,lastExecutionId:'residual-fill-1',meta:{role:'protective-stop'}});
  await new Promise(r => setImmediate(() => setImmediate(r)));
  const pos=state.live.positions['BTC/USDT'];
  assert.ok(pos, 'pozisyon kaydı korunmalı');
  assert.ok(Math.abs(pos.quantity-0.5)<1e-12, 'kalan 0.5 coin izlenmeye devam etmeli');
  assert.equal(calls.length,1, 'kalan miktar için yeni koruyucu stop kurulmalı');
  assert.ok(Math.abs(calls[0].amount-0.5)<1e-12);
  assert.equal(pos.stopOrderId,calls[0].cid);
  assert.equal(state.live.safeToTrade,false, 'koruma/mutabakat tamamlanana kadar işlem kilitli kalmalı');
});

test('kısmi take-profit, eski miktarlı stop bacağını da iptal eder ve kalan miktarı tek stopla korur', async () => {
  const state = store.defaultState(); state.settings.mode='live'; state.settings.dailyLossLimitPct=100; state.settings.killSwitchLossPct=0;
  state.liveOrders['tp-partial'] = {clientOrderId:'tp-partial', symbol:'BTC/USDT', side:'sell', status:'PARTIALLY_FILLED', exchangeOrderId:3, amount:1, meta:{role:'protective-tp'}};
  state.liveOrders['stop-old'] = {clientOrderId:'stop-old', symbol:'BTC/USDT', side:'sell', status:'NEW', exchangeOrderId:2, amount:1, meta:{role:'protective-stop'}};
  state.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100, stopOrderId:'stop-old', tpOrderId:'tp-partial', stopPrice:95, tpPrice:110, protectiveMode:'oco', stopExecutedQty:0, stopCommissionBase:0, stopNetQuoteQty:0, stopThirdAssetCommissionQuote:0, stopExecutionIds:[] };
  state.pairs['BTC/USDT'].params.stopLossPct = 5;
  const calls=[];
  const ex=makeExchange();
  ex.cancelOrder = async (symbol, orderId) => { calls.push(['cancel', orderId]); return {status:'CANCELED', orderId, executedQty:0, origQty:1, cummulativeQuoteQty:0}; };
  ex.createStopOrder = async (symbol, side, amount, stop, limit, cid) => { calls.push(['stop', amount]); return {status:'NEW', orderId:99, clientOrderId:cid, symbol:'BTCUSDT', side:'SELL', executedQty:0, origQty:amount, cummulativeQuoteQty:0}; };
  const engine=new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  engine._onOrderUpdate({symbol:'BTC/USDT',clientOrderId:'tp-partial',exchangeOrderId:3,status:'PARTIALLY_FILLED',executedQty:0.4,quoteQty:44,netQuoteQty:44,commissionByAsset:{},commissionBase:0,lastExecutionId:'tp-fill-1',meta:{role:'protective-tp'}});
  await new Promise(r => setImmediate(() => setImmediate(r)));
  assert.deepEqual(calls.map(x => x[0]), ['cancel','cancel','stop']);
  assert.deepEqual(calls.slice(0,2).map(x => x[1]), [3,2]);
  assert.ok(Math.abs(calls[2][1]-0.6)<1e-12);
  const pos=state.live.positions['BTC/USDT'];
  assert.ok(pos);
  assert.ok(Math.abs(pos.quantity-0.6)<1e-12);
  assert.equal(pos.tpOrderId, null);
  assert.equal(pos.protectiveMode, 'single-stop');
  assert.ok(pos.stopOrderId);
  assert.equal(state.live.safeToTrade, false); // yeni koruma mutabakat tamamlanana kadar işlem kapısı kapalı
});

test('stop kurulumu reddedilse bile gerçek alış pozisyonu state\'te korunur', async () => {
  const { SimulatedExchange } = require('../src/simulatedExchange');
  const LiveEngine = require('../src/liveEngine');
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.setFailure({ kind: 'stop', message: 'stop rejected' });
  const state = {
    settings: { mode: 'live', maxConcurrentPositions: 1, reserveCashPct: 0, maxTradeQuote: 0, pollSeconds: 60, quoteAsset: 'USDT' },
    pairs: { 'BTC/USDT': { enabled: true, budgetPct: 10, strategyId: 'rsi_simple', params: {} } },
    running: true, killSwitch: null, log: [], decisions: {}, liveOrders: {}, liveReconciliation: { safeToTrade: true },
    live: { positions: {}, lastSignalT: {}, lastPrices: {}, safeToTrade: true }
  };
  const store = { save() {} };
  const engine = new LiveEngine({ exchange: ex, store, state, allowLive: true, nowFn: FIXED_NOW });
  await assert.rejects(() => engine.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'test', 0));
  assert.ok(state.live.positions['BTC/USDT']);
  assert.equal(state.live.positions['BTC/USDT'].quantity, 1);
  assert.equal(state.live.positions['BTC/USDT'].stopOrderId, null);
  assert.equal(state.live.safeToTrade, false);
});

test('canlı satış gerçekleşen P/L ve günlük gerçekleşen P/L kaydeder', async () => {
  const { SimulatedExchange } = require('../src/simulatedExchange');
  const ex = new SimulatedExchange({ startingQuote:1000, prices:{'BTC/USDT':100} });
  ex.balances.BTC = { free: 1, locked: 0 };
  const state = store.defaultState();
  state.settings.mode='live'; state.settings.maxConcurrentPositions=1; state.settings.reserveCashPct=0; state.settings.dailyLossLimitPct=100; state.settings.killSwitchLossPct=0;
  state.live.positions['BTC/USDT']={symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100, openedAt:'2026-10-02T10:00:00.000Z', entryOrderId:'entry-1', stopOrderId:null};
  state.live.dayKey='2026-10-02'; state.live.dayStartEquity=1000; state.live.dayRealizedPnl=0;
  const engine = new LiveEngine({exchange:ex, state, store:makeStore(), allowLive:true, nowFn: FIXED_NOW});
  ex.setPrice('BTC/USDT', 110);
  await engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 110, 'test', engine.epoch);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
  assert.equal(state.live.realizedPnl, 10);
  assert.equal(state.live.dayRealizedPnl, 10);
  assert.equal(state.live.trades.length, 1);
  assert.equal(state.live.trades[0].pnl, 10);
});

test('equity hesabı borsadaki gerçek coin bakiyesini kullanır ve yerel pozisyonu ikinci kez saymaz', () => {
  const state = store.defaultState();
  state.settings.mode='live';
  state.live.lastBalance={
    USDT:{free:900,locked:0,total:900},
    BTC:{free:1,locked:0,total:1}
  };
  state.live.lastPrices={'BTC/USDT':110};
  state.live.positions={'BTC/USDT':{symbol:'BTC/USDT',quantity:1,entryPrice:100,costQuote:100}};
  const engine = new LiveEngine({exchange:makeExchange(),state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  assert.equal(engine.computeEquity(), 1010);
});

test('equity hesabı pozisyon defteri ile bakiye arasında geçici fark varsa yerel pozisyonu kopyalamaz', () => {
  const state = store.defaultState();
  state.settings.mode='live';
  state.live.lastBalance={
    USDT:{free:800,locked:0,total:800},
    BTC:{free:0.9,locked:0,total:0.9}
  };
  state.live.lastPrices={'BTC/USDT':100};
  state.live.positions={'BTC/USDT':{symbol:'BTC/USDT',quantity:1,entryPrice:100,costQuote:100}};
  const engine = new LiveEngine({exchange:makeExchange(),state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  assert.equal(engine.computeEquity(), 890);
});

test('satışta base komisyonu gerçek pozisyon çıkışına eklenir, maliyet tabanı çift sayılmaz', async () => {
  const ex = makeExchange();
  ex.createMarketOrder = async (symbol,side,amount,cid) => ({
    orderId:55, clientOrderId:cid, symbol:'BTCUSDT', side:'SELL', status:'FILLED',
    origQty:String(amount), executedQty:'1', cummulativeQuoteQty:'110',
    fills:[{price:'110',qty:'1',commission:'0.001',commissionAsset:'BTC'}]
  });
  const state = store.defaultState(); state.settings.mode='live';
  state.settings.dailyLossLimitPct=100; state.settings.killSwitchLossPct=0;
  state.live.positions['BTC/USDT']={symbol:'BTC/USDT',quantity:1.5,entryPrice:100,costQuote:150,openedAt:'2026-10-02T10:00:00.000Z',entryOrderId:'e1',stopOrderId:null};
  const engine = new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  await engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 110, 'base-fee', engine.epoch);
  assert.ok(Math.abs(state.live.positions['BTC/USDT'].quantity - 0.499) < 1e-12);
  assert.ok(Math.abs(state.live.positions['BTC/USDT'].costQuote - 49.9) < 1e-12);
  assert.ok(Math.abs(state.live.trades[0].costBasisQuote - 100.1) < 1e-12);
  assert.ok(Math.abs(state.live.trades[0].pnl - 9.9) < 1e-12);
});

// Equity-based daily protection must stop even when the loss is not realized.
// This does NOT book an unrealized price move as a realized accounting loss.
test('günlük özkaynak zararı korumayı tetikler, gerçekleşmiş K/Z kaydını değiştirmez', async () => {
  const ex = makeExchange();
  const state = store.defaultState();
  state.settings.mode='live'; state.settings.dailyLossLimitPct=5; state.settings.killSwitchLossPct=0; state.settings.closeOnDailyLoss=false;
  state.running=true;
  state.live.startingEquity=1000; state.live.dayKey='2026-10-02'; state.live.dayStartEquity=1000; state.live.dayRealizedPnl=0;
  state.live.lastBalance={USDT:{free:900,locked:0}};
  state.live.positions={'BTC/USDT':{symbol:'BTC/USDT',quantity:1,entryPrice:100,costQuote:100}};
  state.live.lastPrices={'BTC/USDT':0};
  const engine = new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  await engine._checkRiskGate();
  assert.ok(state.killSwitch);
  assert.equal(state.running, false);
  assert.equal(state.live.dayRealizedPnl, 0);
});

test('günlük zarar kapısı gerçekleşmiş zararda devreye girer', async () => {
  const ex = makeExchange();
  const state = store.defaultState();
  state.settings.mode='live'; state.settings.dailyLossLimitPct=5; state.settings.killSwitchLossPct=0; state.settings.closeOnDailyLoss=false;
  state.running=true;
  state.live.startingEquity=1000; state.live.dayStartEquity=1000; state.live.dayRealizedPnl=-60;
  state.live.lastBalance={USDT:{free:1000,locked:0,total:1000}};
  const engine = new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  state.live.dayKey = engine.getRiskDayKey();
  await engine._checkRiskGate();
  assert.ok(state.killSwitch);
  assert.equal(state.running, false);
});

test('karışık quote varlıklı eski pozisyon varken canlı alış fail-closed durur', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live'; state.settings.quoteAsset = 'USDT'; state.settings.maxConcurrentPositions = 3;
  state.settings.reserveCashPct = 0; state.settings.maxTradeQuote = 100;
  state.settings.killSwitchLossPct = 0; state.settings.dailyLossLimitPct = 100;
  state.live.safeToTrade = true;
  state.live.positions['ETH/TRY'] = { symbol: 'ETH/TRY', quoteAsset: 'TRY', quantity: 1, entryPrice: 100000, costQuote: 100000 };
  const ex = makeExchange(); let orderCalls = 0;
  ex.createMarketOrder = async () => { orderCalls++; throw new Error('must not send'); };
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  await assert.rejects(() => engine.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'mixed quote regression', engine.epoch), /Karışık\/uyuşmayan kasa birimi/);
  assert.equal(orderCalls, 0);
  assert.equal(state.live.safeToTrade, false);
});

test('canlı motor kısmi market alışın kalanını iptal etmeden pozisyonu korumaya çalışmaz', async () => {
  const state = store.defaultState(); state.settings.mode='live'; state.settings.maxConcurrentPositions=1; state.settings.reserveCashPct=0; state.settings.maxTradeQuote=100; state.settings.killSwitchLossPct=0; state.settings.dailyLossLimitPct=100;
  state.live.safeToTrade=true;
  const calls=[];
  const ex = makeExchange();
  ex.fetchBalance = async () => ({USDT:{free:1000,locked:0}});
  ex.createMarketOrder = async (symbol,side,amount,cid) => ({orderId:9,clientOrderId:cid,symbol:'BTCUSDT',side:'BUY',status:'PARTIALLY_FILLED',origQty:amount,executedQty:0.4,cummulativeQuoteQty:40});
  ex.cancelOrder = async (symbol,id) => { calls.push(['cancel',id]); return {orderId:id,clientOrderId:Object.keys(state.liveOrders)[0],symbol:'BTCUSDT',side:'BUY',status:'CANCELED',origQty:1,executedQty:0.4,cummulativeQuoteQty:40}; };
  ex.createStopOrder = async (symbol,side,amount,stop,limit,cid) => { calls.push(['stop',amount]); return {orderId:10,clientOrderId:cid,symbol:'BTCUSDT',side:'SELL',status:'NEW',origQty:amount,executedQty:0,cummulativeQuoteQty:0}; };
  const engine = new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], {stopLossPct:5}, 100, 'partial', engine.epoch);
  assert.equal(calls[0][0], 'cancel');
  assert.equal(calls[1][0], 'stop');
  assert.ok(state.live.positions['BTC/USDT']);
  assert.equal(state.live.positions['BTC/USDT'].quantity, 0.4);
});

test('canlı alışta üçüncü varlık komisyonu maliyete quote karşılığıyla eklenir', async () => {
  const state = store.defaultState();
  state.settings.mode='live'; state.settings.maxConcurrentPositions=1; state.settings.reserveCashPct=0; state.settings.maxTradeQuote=1000; state.settings.killSwitchLossPct=0; state.settings.dailyLossLimitPct=100;
  state.live.safeToTrade=true;
  const ex = makeExchange();
  ex.fetchBalance = async () => ({USDT:{free:1000,locked:0}});
  ex.fetchSymbolRules = async () => ({stepSize:0.001,minQty:0.001,minNotional:10});
  ex.fetchTicker = async (symbol) => symbol === 'BNB/USDT' ? {price:600} : {price:100};
  ex.createMarketOrder = async (symbol,side,amount,cid) => ({orderId:101,clientOrderId:cid,symbol:'BTCUSDT',side:'BUY',status:'FILLED',origQty:String(amount),executedQty:'1',cummulativeQuoteQty:'100',fills:[{price:'100',qty:'1',commission:'0.01',commissionAsset:'BNB'}]});
  ex.createStopOrder = async (symbol,side,amount,stop,limit,cid) => ({orderId:102,clientOrderId:cid,symbol:'BTCUSDT',side:'SELL',status:'NEW',origQty:String(amount),executedQty:'0',cummulativeQuoteQty:'0'});
  const engine = new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], {stopLossPct:5}, 100, 'third-fee', engine.epoch);
  assert.equal(state.live.positions['BTC/USDT'].costQuote, 106);
  assert.equal(state.live.positions['BTC/USDT'].entryThirdAssetCommissionQuote, 6);
});

test('WebSocketten gelen fiyatlanmamış üçüncü varlık komisyonu canlı muhasebeyi kapatır', () => {
  const state = store.defaultState(); state.settings.mode='live'; state.live.safeToTrade=true;
  state.live.positions['BTC/USDT']={symbol:'BTC/USDT',quantity:1,entryPrice:100,costQuote:100,stopOrderId:'stop-3'};
  const engine = new LiveEngine({exchange:makeExchange(),state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  engine._onOrderUpdate({symbol:'BTC/USDT',clientOrderId:'stop-3',status:'FILLED',executedQty:1,netQuoteQty:110,commissionByAsset:{BNB:0.01},commissionBase:0,commissionQuote:0,meta:{role:'protective-stop'}});
  assert.ok(state.live.positions['BTC/USDT']);
  assert.equal(state.live.safeToTrade, false);
  assert.equal(state.live.unpricedRealizedTrades, 1);
});

test('LiveEngine: Binance production ek kilit olmadan başlatılamaz', () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.id = 'binance';
  ex.environment = 'production';
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  const old = process.env.ALLOW_PRODUCTION_TRADING;
  delete process.env.ALLOW_PRODUCTION_TRADING;
  try {
    assert.throws(() => engine.assertStartAllowed(), /üretim ortamı ek güvenlik kilidi/);
  } finally {
    if (old === undefined) delete process.env.ALLOW_PRODUCTION_TRADING;
    else process.env.ALLOW_PRODUCTION_TRADING = old;
  }
});

test('LiveEngine: Binance testnet üretim kilidine takılmaz', async () => withTestnetEnv(async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.id = 'binance';
  ex.capabilities.marketOrderBook = true;
  ex.environment = 'testnet';
  Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  assert.doesNotThrow(() => engine.assertStartAllowed());
}));

test('koruyucu stop fiyatı tickSize adımına aşağı yuvarlanır', async () => {
  const state=store.defaultState(); state.settings.mode='live'; state.settings.maxConcurrentPositions=1; state.settings.reserveCashPct=0; state.settings.maxTradeQuote=100; state.settings.killSwitchLossPct=0; state.settings.dailyLossLimitPct=100;
  state.live.safeToTrade=true;
  const ex=makeExchange();
  ex.fetchSymbolRules=async()=>({stepSize:0.001,minQty:0.001,minNotional:10,marketStepSize:0.001,marketMinQty:0.001,tickSize:0.1});
  let stopArgs;
  ex.createMarketOrder=async(symbol,side,amount,cid)=>({orderId:1,clientOrderId:cid,symbol:'BTCUSDT',side:'BUY',status:'FILLED',origQty:amount,executedQty:amount,cummulativeQuoteQty:amount*103.17});
  ex.createStopOrder=async(symbol,side,amount,stop,limit,cid)=>{stopArgs={amount,stop,limit};return {orderId:2,clientOrderId:cid,symbol:'BTCUSDT',side:'SELL',status:'NEW',origQty:amount,executedQty:0,cummulativeQuoteQty:0};};
  const engine=new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true, nowFn: FIXED_NOW});
  await engine.buy('BTC/USDT',state.pairs['BTC/USDT'],{stopLossPct:5},103.17,'tick',engine.epoch);
  assert.ok(Math.abs((stopArgs.stop/0.1)-Math.round(stopArgs.stop/0.1))<1e-9);
  assert.ok(Math.abs((stopArgs.limit/0.1)-Math.round(stopArgs.limit/0.1))<1e-9);
  assert.ok(stopArgs.limit < stopArgs.stop);
});

test('kill-switch yarışında ikinci risk kapısı yeni alış emrini engeller', async () => {
  const { SimulatedExchange } = require('../src/simulatedExchange');
  const LiveEngine = require('../src/liveEngine');
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  let submits = 0;
  const original = ex.createMarketOrder.bind(ex);
  ex.createMarketOrder = async (...args) => { submits++; return original(...args); };
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.maxConcurrentPositions = 1;
  state.settings.reserveCashPct = 0;
  state.settings.maxTradeQuote = 100;
  state.live.safeToTrade = true;
  state.running = true;
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  state.killSwitch = { t: new Date().toISOString(), reason: 'simulated concurrent risk trigger' };
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'race', engine.epoch);
  assert.equal(submits, 0);
});

test('koruyucu stop iptal edilirken kısmi dolum varsa market satışına devam etmez', async () => {
  const state = store.defaultState();
  state.settings.mode='live'; state.settings.dailyLossLimitPct=100; state.settings.killSwitchLossPct=0;
  state.live.safeToTrade=true;
  state.live.positions['BTC/USDT']={
    symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100,
    openedAt:'2026-10-02T10:00:00.000Z', entryOrderId:'e1', stopOrderId:'stop-1'
  };
  state.liveOrders['stop-1']={clientOrderId:'stop-1',symbol:'BTC/USDT',side:'sell',status:'NEW',exchangeOrderId:77,amount:1,meta:{role:'protective-stop'}};
  const calls=[];
  const ex = makeExchange();
  ex.cancelOrder = async (symbol,id) => ({
    orderId:id, clientOrderId:'stop-1', symbol:'BTCUSDT', side:'SELL',
    status:'CANCELED', origQty:1, executedQty:0.4, cummulativeQuoteQty:38
  });
  ex.createMarketOrder = async () => { calls.push('market'); throw new Error('market should not be sent'); };
  const engine = new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true});
  await assert.rejects(
    () => engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'race', engine.epoch),
    /kısmen dolmuş/
  );
  assert.deepEqual(calls, []);
  assert.equal(state.live.safeToTrade, false);
  assert.equal(state.live.stopCancelPartialFill.executedQty, 0.4);
});

test('STOP FILLED WebSocket bildirimi stopOrderId atanmadan gelirse buy sonradan kayitli FILLED durumu işler', async () => {
  const state = store.defaultState(); state.settings.mode='live'; state.settings.maxConcurrentPositions=1; state.settings.reserveCashPct=0; state.settings.maxTradeQuote=100; state.live.safeToTrade=true;
  const ex = makeExchange();
  const om = {
    get(id) { return { clientOrderId:id, symbol:'BTC/USDT', status:'FILLED', executedQty:1, quoteQty:100, netQuoteQty:100, commissionByAsset:{}, commissionBase:0, lastExecutionId:'early-stop-fill', meta:{role:'protective-stop'} }; },
    async submitMarket({ clientOrderId }) { return { clientOrderId, symbol:'BTC/USDT', side:'buy', status:'FILLED', executedQty:1, netExecutedQty:1, quoteQty:100, netQuoteQty:100, commissionByAsset:{}, commissionTotal:0 }; },
    async submitStop(args) { return { ...args, clientOrderId:'stop-race', status:'NEW', executedQty:0, quoteQty:0 }; }
  };
  const engine = new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true,orderManager:om});
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], {stopLossPct:5}, 100, 'race', engine.epoch);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
});

test('STOP kurulumu beklenmedik throw ederse canlı kapisi kapanir ve pozisyon korunur', async () => {
  const state = store.defaultState(); state.settings.mode='live'; state.settings.maxConcurrentPositions=1; state.settings.reserveCashPct=0; state.settings.maxTradeQuote=100; state.live.safeToTrade=true;
  const ex = makeExchange();
  const om = {
    get() { return null; },
    async submitMarket({ clientOrderId }) { return { clientOrderId, symbol:'BTC/USDT', side:'buy', status:'FILLED', executedQty:1, netExecutedQty:1, quoteQty:100, netQuoteQty:100, commissionByAsset:{}, commissionTotal:0 }; },
    async submitStop() { throw new Error('unexpected stop transport failure'); }
  };
  const engine = new LiveEngine({exchange:ex,state,store:makeStore(),allowLive:true,orderManager:om});
  await assert.rejects(() => engine.buy('BTC/USDT', state.pairs['BTC/USDT'], {stopLossPct:5}, 100, 'throw', engine.epoch), /unexpected stop transport failure/);
  assert.ok(state.live.positions['BTC/USDT']);
  assert.equal(state.live.safeToTrade, false);
});

test('reconciliation geçici olarak başarısız olunca eski sonuç canlı motoru kalıcı deadlocka sokmaz', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.dailyLossLimitPct = 100;
  state.settings.killSwitchLossPct = 100;
  state.settings.pollSeconds = 60;
  state.liveReconciliation = { safeToTrade: false };
  state.running = true;
  let now = FIXED_NOW();
  let calls = 0;
  const engine = new LiveEngine({
    exchange: makeExchange(),
    state,
    store: makeStore(),
    allowLive: true,
    nowFn: () => now,
    reconciler: {
      async reconcile() {
        calls++;
        return { safeToTrade: calls >= 2, balances: { USDT: { free: 1000, locked: 0 } } };
      }
    }
  });

  await engine.tick();
  assert.equal(calls, 1);
  assert.equal(state.live.safeToTrade, false);

  now += engine.reconcileEveryMs + 1;
  await engine.tick();
  assert.equal(calls, 2);
  assert.equal(state.live.safeToTrade, true);
});


test('RED TEAM: live engine malformed candle (NaN / bozuk OHLC / yanlış timeframe) ile sinyal üretmez', async () => {
  const state = require('../src/store').defaultState();
  state.settings.mode='live'; state.settings.maxTradeQuote=20; state.settings.dailyLossLimitPct=5; state.settings.killSwitchLossPct=25;
  const ex = {
    id:'simulation', quoteAssets:['USDT'], capabilities:{clientOrderId:true,orderQuery:true,balanceQuery:true,openOrdersQuery:true,oco:true,nativeTrailingOco:true,marketOrderBook:true,liveTradingVerified:true},
    fetchCandles: async () => [{t:0,o:100,h:101,l:99,c:100,v:1},{t:3600000,o:100,h:NaN,l:99,c:100,v:1}],
    fetchTicker: async()=>({price:100}), fetchSymbolRules: async()=>({stepSize:0.001,marketStepSize:0.001,minQty:0.001,marketMinQty:0.001,minNotional:1,tickSize:0.01})
  };
  const e = new (require('../src/liveEngine'))({exchange:ex,state,store:{save(){}},allowLive:true});
  await assert.rejects(()=>e.processPair('BTC/USDT', state.pairs['BTC/USDT'], e.epoch), /Geçersiz candle/);
});

test('RED TEAM: live engine stale candle series is rejected before ticker/signal processing', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  const now = FIXED_NOW();
  let tickerCalls = 0;
  const ex = makeExchange();
  ex.fetchCandles = async () => [
    { t: now - 12 * 3600000, o: 100, h: 101, l: 99, c: 100, v: 1 },
    { t: now - 11 * 3600000, o: 100, h: 101, l: 99, c: 100, v: 1 }
  ];
  ex.fetchTicker = async () => { tickerCalls++; return { price: 100 }; };
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  await assert.rejects(() => engine.processPair('BTC/USDT', state.pairs['BTC/USDT'], engine.epoch), /piyasa verisi eski/);
  assert.equal(tickerCalls, 0, 'stale candles must not proceed to signal evaluation');
});

test('RED TEAM: live engine future-dated candle series is rejected', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  const now = FIXED_NOW();
  const ex = makeExchange();
  ex.fetchCandles = async () => [
    { t: now + 6 * 60 * 1000 - 3600000, o: 100, h: 101, l: 99, c: 100, v: 1 },
    { t: now + 6 * 60 * 1000, o: 100, h: 101, l: 99, c: 100, v: 1 }
  ];
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  await assert.rejects(() => engine.processPair('BTC/USDT', state.pairs['BTC/USDT'], engine.epoch), /zaman damgası sistem zamanından ileride/);
});

test('tick açık pozisyonun piyasa verisi eksikse aynı turda yeni alımları durdurur', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.running = true;
  state.live.safeToTrade = true;
  state.pairs = {
    'BTC/USDT': { ...state.pairs['BTC/USDT'], enabled: true },
    'ETH/USDT': { ...state.pairs['ETH/USDT'], enabled: true }
  };
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopOrderId: 'existing-stop' };
  const ex = makeExchange();
  ex.fetchCandles = async (symbol) => {
    if (symbol === 'BTC/USDT') throw new Error('simulated candle outage');
    const t = FIXED_NOW() - 2 * 3600000;
    return [0, 1].map((i) => ({ t: t + i * 3600000, o: 100, h: 101, l: 99, c: 100, v: 10 }));
  };
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  engine._reconcileIfDue = async () => {};
  engine._adoptFilledEntries = async () => {};
  engine._adoptFilledExits = async () => {};
  engine._ensurePositionProtection = async () => {};
  engine._checkRiskGate = async () => {};
  const calls = [];
  engine.processPair = async (symbol, cfg, epoch, marketData, allowNewEntries) => {
    calls.push({ symbol, marketData, allowNewEntries });
    if (marketData?.error) throw marketData.error;
  };
  await engine.tick();
  const eth = calls.find((x) => x.symbol === 'ETH/USDT');
  assert.ok(eth, 'healthy symbol should still be evaluated');
  assert.equal(eth.allowNewEntries, false, 'new entries must pause for this tick');
  assert.equal(state.live.safeToTrade, true, 'temporary market data failure should not permanently lock the engine');
});

test('tick açık pozisyon için eski mum verisi gelirse yeni alımları durdurur', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.running = true;
  state.live.safeToTrade = true;
  state.pairs = {
    'BTC/USDT': { ...state.pairs['BTC/USDT'], enabled: true },
    'ETH/USDT': { ...state.pairs['ETH/USDT'], enabled: true }
  };
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopOrderId: 'existing-stop' };
  const ex = makeExchange();
  ex.fetchCandles = async (symbol) => {
    const latest = symbol === 'BTC/USDT' ? FIXED_NOW() - 10 * 3600000 : FIXED_NOW() - 3600000;
    return [0, 1].map((i) => ({ t: latest - 3600000 + i * 3600000, o: 100, h: 101, l: 99, c: 100, v: 10 }));
  };
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  engine._reconcileIfDue = async () => {};
  engine._adoptFilledEntries = async () => {};
  engine._adoptFilledExits = async () => {};
  engine._ensurePositionProtection = async () => {};
  engine._checkRiskGate = async () => {};
  const calls = [];
  engine.processPair = async (symbol, cfg, epoch, marketData, allowNewEntries) => {
    calls.push({ symbol, marketData, allowNewEntries });
    if (marketData?.error) throw marketData.error;
  };
  await engine.tick();
  const eth = calls.find((x) => x.symbol === 'ETH/USDT');
  assert.ok(eth, 'healthy symbol should still be evaluated');
  assert.equal(eth.allowNewEntries, false, 'stale position data must pause new entries');
});

test('quote artık desteklenmese bile açık canlı pozisyon veri ve çıkış yönetiminden atlanmaz', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.running = true;
  state.live.safeToTrade = true;
  state.pairs = {
    'BTC/USDT': { ...state.pairs['BTC/USDT'], enabled: false },
    'ETH/USDT': { ...state.pairs['ETH/USDT'], enabled: true }
  };
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopOrderId: 'existing-stop' };
  const ex = makeExchange();
  ex.quoteAssets = ['TRY'];
  ex.fetchCandles = async () => {
    const t = FIXED_NOW() - 2 * 3600000;
    return [0, 1].map((i) => ({ t: t + i * 3600000, o: 100, h: 101, l: 99, c: 100, v: 10 }));
  };
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  engine._reconcileIfDue = async () => {};
  engine._adoptFilledEntries = async () => {};
  engine._adoptFilledExits = async () => {};
  engine._ensurePositionProtection = async () => {};
  engine._checkRiskGate = async () => {};
  const processed = [];
  engine.processPair = async (symbol) => { processed.push(symbol); };
  await engine.tick();
  assert.ok(processed.includes('BTC/USDT'), 'open position must still be managed');
  assert.ok(!processed.includes('ETH/USDT'), 'unsupported quote without a position remains skipped');
});
