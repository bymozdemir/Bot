const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const PaperEngine = require('../src/paperEngine');
const LiveEngine = require('../src/liveEngine');
const { OrderManager } = require('../src/orderManager');

const H = 3600000;
const T0 = Date.UTC(2026, 9, 1, 0, 0);
const candle = (i, p = 100) => ({ t: T0 + i * H, o: p, h: p, l: p, c: p, v: 1 });

function paperState() {
  const s = store.defaultState();
  s.running = true;
  s.pairs = { 'BTC/USDT': { ...s.pairs['BTC/USDT'], enabled: true, budgetPct: 100 } };
  s.settings.reserveCashPct = 0;
  s.settings.dailyLossLimitPct = 100;
  s.settings.killSwitchLossPct = 0;
  return s;
}

test('1.6 hardening: aktif kasa TRY ise BTC/USDT paper alımı engellenir', async () => {
  const state = paperState();
  state.settings.quoteAsset = 'TRY';
  const engine = new PaperEngine({
    exchange: { quoteAssets: ['TRY', 'USDT'], fetchSymbolRules: async () => ({ minNotional: 10 }) },
    store: { save() {} }, state
  });
  await engine.tryBuy('BTC/USDT', state.pairs['BTC/USDT'], { action: 'buy', reason: 'test' }, state.pairs['BTC/USDT'].params, 100, T0, 0);
  assert.equal(Object.keys(state.paper.positions).length, 0);
});

test('1.6 hardening: sadece kapanmış mum dönen API eski sinyali fresh saymaz', async () => {
  const state = paperState();
  const candles = Array.from({ length: 10 }, (_, i) => candle(i));
  const now = T0 + 9 * H + 2 * H; // son kapanmış mumun kapanışından 1 saat sonra
  const engine = new PaperEngine({
    exchange: { quoteAssets: ['USDT'], fetchCandles: async () => candles, fetchSymbolRules: async () => ({ minNotional: 10 }) },
    store: { save() {} }, state, nowFn: () => now
  });
  const strategy = require('../src/strategies').registry.rsi_ema_macd;
  const original = strategy.evaluate;
  strategy.evaluate = () => ({ action: 'buy', reason: 'stale-test' });
  try {
    await engine.tick();
    assert.equal(Object.keys(state.paper.positions).length, 0);
    assert.equal(state.decisions['BTC/USDT'].stale, true);
  } finally { strategy.evaluate = original; }
});

test('1.6 hardening: OrderManager gerçek take-profit emrini ayrı kimlikle kaydeder', async () => {
  const state = { liveOrders: {} };
  const ex = {
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, recoveryByFingerprint: false, liveTradingVerified: true },
    async createMarketOrder() { return { status:'FILLED', orderId:1, clientOrderId:'m', executedQty:1, origQty:1 }; },
    async getOrder() { return { status:'NEW' }; },
    async createTakeProfitOrder(symbol, side, amount, stopPrice, limitPrice, cid) {
      return { status: 'NEW', orderId: 77, clientOrderId: cid, symbol, side, executedQty: 0, origQty: amount, stopPrice };
    },
    async cancelOrder() { return { status: 'CANCELED' }; }
  };
  const om = new OrderManager({ exchange: ex, state, store: { save() {} } });
  const tp = await om.submitTakeProfit({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 106 });
  assert.equal(tp.status, 'NEW');
  assert.equal(tp.type, 'TAKE_PROFIT');
  assert.equal(state.liveOrders[tp.clientOrderId].meta.role, undefined);
});

test('1.6 hardening: take-profit kesin API reddinde REJECTED kaydeder, catch içi ReferenceError üretmez', async () => {
  const state = { liveOrders: {} };
  const ex = {
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, recoveryByFingerprint: false, liveTradingVerified: true },
    async createMarketOrder() { throw new Error('not used'); },
    async cancelOrder() { throw new Error('not used'); },
    async createTakeProfitOrder() { throw new Error('definite exchange rejection'); },
    async getOrder() { throw new Error('not used'); }
  };
  const om = new OrderManager({ exchange: ex, state, store: { save() {} } });
  const result = await om.submitTakeProfit({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 106 });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.uncertain, false);
  assert.match(result.error.message, /definite exchange rejection/);
});

test('1.6 hardening: take-profit yanıtından sonraki hata emri UNKNOWN yapar', async () => {
  const state = { liveOrders: {} };
  const ex = {
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, recoveryByFingerprint: false, liveTradingVerified: true },
    async createMarketOrder() { throw new Error('not used'); },
    async cancelOrder() { throw new Error('not used'); },
    async createTakeProfitOrder(symbol, side, amount, stopPrice, limitPrice, cid) {
      return { status: 'NEW', orderId: 78, clientOrderId: cid, symbol, side, executedQty: 0, origQty: amount };
    },
    async getOrder() { throw new Error('not used'); }
  };
  const om = new OrderManager({ exchange: ex, state, store: { save() {} } });
  om._enrichThirdAssetFee = async () => { throw new Error('post-response processing failed'); };
  const result = await om.submitTakeProfit({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 106 });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.uncertain, true);
  assert.equal(result.requiresReconciliation, true);
});

test('1.6 hardening: trailing stop yeni ticker zirvesinde gerçek stop emrini yukarı taşır', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.quoteAsset = 'USDT';
  state.running = true;
  state.live.safeToTrade = true;
  state.liveOrders = { old: { clientOrderId:'old', symbol:'BTC/USDT', side:'sell', amount:1, status:'NEW', exchangeOrderId:11, executedQty:0 } };
  state.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', quantity:1, entryPrice:100, stopOrderId:'old', stopPrice:97, tpOrderId:null, highWaterMark:100, entryOrderId:'entry', costQuote:100 };
  const calls = [];
  const ex = {
    id:'binance', quoteAssets:['USDT'], capabilities:{clientOrderId:true,orderQuery:true,balanceQuery:true,openOrdersQuery:true,recoveryByFingerprint:false,liveTradingVerified:true},
    fetchSymbolRules: async () => ({ tickSize:0.01, minNotional:10 }),
    async createMarketOrder() { return { status:'FILLED', orderId:1, clientOrderId:'m', executedQty:1, origQty:1 }; },
    async getOrder() { return { status:'NEW' }; },
    async cancelOrder(symbol, id) { calls.push(['cancel', id]); return { status:'CANCELED', orderId:11, clientOrderId:id, executedQty:0 }; },
    async createStopOrder(symbol, side, amount, stop, limit, cid) { calls.push(['stop', stop]); return { status:'NEW', orderId:12, clientOrderId:cid, symbol, side, executedQty:0, origQty:amount }; }
  };
  const e = new LiveEngine({ exchange:ex, state, store:{save(){}}, allowLive:true });
  await e._syncTrailingStop('BTC/USDT', state.live.positions['BTC/USDT'], { trailingStop:true, stopLossPct:3 }, 120);
  assert.equal(calls[0][0], 'cancel');
  assert.equal(calls[1][0], 'stop');
  assert.equal(calls[1][1], 116.4);
  assert.equal(state.live.positions['BTC/USDT'].stopPrice, 116.4);
});

test('yeni risk modeli: TP eşiği OCO kurmaz, tek koruyucu stop kurar', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.quoteAsset = 'USDT';
  state.settings.maxConcurrentPositions = 1;
  state.settings.reserveCashPct = 0;
  state.settings.maxTradeQuote = 100;
  state.settings.dailyLossLimitPct = 100;
  state.live.safeToTrade = true;
  state.pairs['BTC/USDT'].params = { ...state.pairs['BTC/USDT'].params, stopLossPct: 3, takeProfitPct: 6, trailingStop: false };
  const calls = [];
  const ex = {
    id: 'binance', environment: 'testnet', quoteAssets: ['USDT'],
    capabilities: { clientOrderId:true, orderQuery:true, balanceQuery:true, openOrdersQuery:true, oco:true, nativeTrailingOco:true, liveTradingVerified:true },
    async fetchBalance() { return { USDT:{free:1000,locked:0} }; },
    async fetchSymbolRules() { return { marketStepSize:0.001, marketMinQty:0.001, minNotional:10, tickSize:0.01 }; },
    async createMarketOrder(symbol, side, amount, cid) { calls.push('market'); return {status:'FILLED',orderId:1,clientOrderId:cid,symbol:'BTCUSDT',side:'BUY',executedQty:amount,origQty:amount,cummulativeQuoteQty:amount*100}; },
    async createStopOrder(symbol, side, amount, stop, limit, cid) { calls.push({type:'stop', stop}); return {status:'NEW',orderId:2,clientOrderId:cid,symbol:'BTCUSDT',side:'SELL',executedQty:0,origQty:amount,stopPrice:stop}; },
    async getOrder() { return {status:'NEW'}; }, async fetchOpenOrders(){return[];}, async cancelOrder(){return {status:'CANCELED'};}
  };
  const engine = new LiveEngine({exchange:ex,state,store:{save(){}},allowLive:true});
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], state.pairs['BTC/USDT'].params, 100, 'profit-lock-test', engine.epoch);
  assert.equal(calls.filter(x => x === 'market').length, 1);
  assert.equal(calls.filter(x => x && x.type === 'stop').length, 1);
  assert.equal(state.live.positions['BTC/USDT'].protectiveMode, 'single-stop');
  assert.equal(state.live.positions['BTC/USDT'].tpOrderId, null);
});

test('1.6.2 hardening: trailingStop + Binance native capability yazılımsal trailing replacement yapmaz', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live'; state.settings.quoteAsset='USDT'; state.live.safeToTrade=true;
  state.live.positions['BTC/USDT'] = { symbol:'BTC/USDT', quantity:1, entryPrice:100, stopOrderId:'stop', stopPrice:97, nativeTrailing:true };
  const ex = { id:'binance', quoteAssets:['USDT'], capabilities:{clientOrderId:true,orderQuery:true,balanceQuery:true,openOrdersQuery:true,oco:true,nativeTrailingOco:true} };
  const engine = new LiveEngine({exchange:ex,state,store:{save(){}},allowLive:true});
  await engine._syncTrailingStop('BTC/USDT', state.live.positions['BTC/USDT'], {trailingStop:true,stopLossPct:3}, 120);
  assert.equal(state.live.positions['BTC/USDT'].stopPrice,97);
});
