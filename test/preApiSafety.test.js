// 1.7.0 "API denemesi öncesi" denetiminde bulunan finansal mantık hatalarının regresyon testleri.
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const PaperEngine = require('../src/paperEngine');
const { OrderManager } = require('../src/orderManager');
const { checkManagedBalances } = require('../src/reconciliation');
const { plainDecimal } = require('../src/execution');

const FIXED_NOW = () => Date.UTC(2026, 9, 2, 12, 0);
const makeStore = () => ({ saves: 0, save() { this.saves++; } });

function makeExchange(over = {}) {
  const calls = { market: [], stop: [], oco: [], cancel: [] };
  const ex = {
    calls,
    id: 'binance', environment: 'testnet', name: 'Test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { return { USDT: { free: 1000, locked: 0 } }; },
    async fetchOpenOrders() { return []; },
    async getOrder() { throw new Error('yok'); },
    async createMarketOrder(symbol, side, amount, cid) {
      calls.market.push({ side, amount });
      const fills = side === 'buy' ? [{ commission: String(amount * 0.001), commissionAsset: 'BTC' }] : [];
      return { status: 'FILLED', orderId: 1, clientOrderId: cid, executedQty: amount, origQty: amount, cummulativeQuoteQty: amount * 100, fills };
    },
    async createStopOrder(symbol, side, amount, stop, limit, cid) { calls.stop.push({ amount, stop, limit }); return { status: 'NEW', orderId: 2, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async createOcoOrder(symbol, side, amount, args) {
      calls.oco.push({ amount, args });
      return { orderListId: 9, listClientOrderId: args.listClientOrderId, orders: [], orderReports: [
        { orderId: 3, clientOrderId: args.takeProfitClientOrderId, symbol: 'BTCUSDT', status: 'NEW', side: 'SELL', executedQty: 0, origQty: amount },
        { orderId: 2, clientOrderId: args.stopClientOrderId, symbol: 'BTCUSDT', status: 'NEW', side: 'SELL', executedQty: 0, origQty: amount }
      ] };
    },
    async cancelOrder(symbol, orderId) { calls.cancel.push(orderId); return { status: 'CANCELED', orderId, executedQty: 0 }; },
    async fetchCandles() { return []; },
    async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, marketStepSize: 0.001, minQty: 0.001, marketMinQty: 0.001, minNotional: 10, tickSize: 0.01 }; },
    ...over
  };
  return ex;
}

function liveState(params = { stopLossPct: 3, takeProfitPct: 0, trailingStop: false }) {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0; state.settings.maxTradeQuote = 0;
  state.pairs = { 'BTC/USDT': { symbol: 'BTC/USDT', enabled: true, strategyId: 'rsi_ema_macd', timeframe: '1h', budgetPct: 30, params } };
  state.live.safeToTrade = true;
  return state;
}

function engineFor(state, ex) {
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  engine.ensureState();
  state.live.safeToTrade = true;
  return engine;
}

test('plainDecimal üstel gösterim ve kayan nokta artığı üretmez', () => {
  assert.equal(plainDecimal(1e-7), '0.0000001');
  assert.equal(plainDecimal(0.30000000000000004), '0.3');
  assert.equal(plainDecimal(65000), '65000');
  assert.equal(plainDecimal(0.000999), '0.000999');
});

test('plainDecimal yukarı yuvarlayıp emir miktarını büyütmez', () => {
  assert.equal(plainDecimal(0.123456789), '0.12345678');
  assert.equal(plainDecimal(0.999999999), '0.99999999');
  assert.equal(plainDecimal(0.1 + 0.2), '0.3');
  assert.equal(plainDecimal(1.000000009), '1');
  // Truncation must not round up at the extra-digit boundary.
  assert.equal(plainDecimal(0.9999999999999), '0.99999999');
  assert.equal(plainDecimal(0.1234567899999), '0.12345678');
  assert.equal(plainDecimal(4.99999, 0), '4');
  // Decimal strings retain precision that Number() would lose.
  assert.equal(plainDecimal('0.99999999999999999'), '0.99999999');
  assert.equal(plainDecimal('12345678.999999999999'), '12345678.99999999');
  assert.equal(plainDecimal('1e-3'), '0.001');
  assert.equal(plainDecimal('1e+21'), '1000000000000000000000');
});

test('plainDecimal geçersiz emir sayısını sessizce sıfıra/başka değere dönüştürmez', () => {
  for (const value of [null, undefined, '', '   ', true, false, '0x10', NaN, Infinity, -1, 0, 1e-10]) {
    assert.throws(() => plainDecimal(value), undefined, `değer reddedilmeli: ${String(value)}`);
  }
  for (const decimals of [-1, 1.5, 101, NaN]) {
    assert.throws(() => plainDecimal(1.25, decimals), RangeError);
  }
});

test('alış: baz komisyonu düşülen net miktar adıma yuvarlanarak koruyucu stop kurulur', async () => {
  const state = liveState();
  const ex = makeExchange();
  const engine = engineFor(state, ex);
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], state.pairs['BTC/USDT'].params, 100, 'test', engine.epoch);
  const pos = state.live.positions['BTC/USDT'];
  assert.ok(pos, 'pozisyon kaydedilmeli');
  assert.ok(Math.abs(pos.quantity - 2.6973) < 1e-9, `net miktar ${pos.quantity}`);
  assert.equal(ex.calls.stop.length, 1);
  assert.equal(ex.calls.stop[0].amount, 2.697); // 0.001 adımına aşağı yuvarlanmış
  assert.ok(pos.stopOrderId);
});

test('alış: takeProfitPct=0 (fiilen kapalı) OCO yerine tek koruyucu stop kurar', async () => {
  const state = liveState({ stopLossPct: 15, takeProfitPct: 0, trailingStop: false });
  const ex = makeExchange();
  const engine = engineFor(state, ex);
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], state.pairs['BTC/USDT'].params, 100, 'test', engine.epoch);
  assert.equal(ex.calls.oco.length, 0);
  assert.equal(ex.calls.stop.length, 1);
});

test('alış: %6 TP artık OCO kurmaz; tek koruyucu stop kurar', async () => {
  const state = liveState({ stopLossPct: 3, takeProfitPct: 6, trailingStop: false });
  const ex = makeExchange();
  const engine = engineFor(state, ex);
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], state.pairs['BTC/USDT'].params, 100, 'test', engine.epoch);
  assert.equal(ex.calls.oco.length, 0);
  assert.equal(ex.calls.stop.length, 1);
});

test('alış: geçersiz stopLossPct ise market alış HİÇ gönderilmez', async () => {
  const state = liveState({ stopLossPct: 0, takeProfitPct: 0, trailingStop: false });
  const ex = makeExchange();
  const engine = engineFor(state, ex);
  await assert.rejects(() => engine.buy('BTC/USDT', state.pairs['BTC/USDT'], state.pairs['BTC/USDT'].params, 100, 'test', engine.epoch), /stopLossPct/);
  assert.equal(ex.calls.market.length, 0);
});

test('alış: OCO desteği olmasa da %6 kâr koruma eşiğiyle alış mümkündür', async () => {
  const state = liveState({ stopLossPct: 3, takeProfitPct: 6, trailingStop: false });
  const ex = makeExchange();
  ex.capabilities = { ...ex.capabilities, oco: false };
  const engine = engineFor(state, ex);
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], state.pairs['BTC/USDT'].params, 100, 'test', engine.epoch);
  assert.equal(ex.calls.market.length, 1);
  assert.equal(ex.calls.stop.length, 1);
});

function seedPosition(state, { quantity = 1, withStop = true } = {}) {
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity, entryPrice: 100, costQuote: quantity * 100, stopPrice: 97, stopOrderId: withStop ? 'stop-old' : null, protectiveMode: 'single-stop', entryOrderId: 'e1' };
  if (withStop) state.liveOrders['stop-old'] = { clientOrderId: 'stop-old', exchangeOrderId: 2, symbol: 'BTC/USDT', side: 'sell', amount: quantity, status: 'NEW', meta: { role: 'protective-stop' } };
}

test('satış: order-book güvenlik kontrolü başarısızsa koruyucu stop İPTAL EDİLMEZ', async () => {
  const state = liveState();
  seedPosition(state);
  const ex = makeExchange({ async fetchOrderBook() { return { bids: [[90, 100]], asks: [[110, 100]] }; } });
  const engine = engineFor(state, ex);
  await assert.rejects(() => engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'test', engine.epoch), /güvenlik kontrolü reddetti/);
  assert.equal(ex.calls.cancel.length, 0, 'stop iptal edilmemeli');
  assert.equal(state.live.positions['BTC/USDT'].stopOrderId, 'stop-old');
  assert.equal(state.liveOrders['stop-old'].status, 'NEW');
});

test('satış: market satış reddedilirse koruyucu stop yeniden kurulur', async () => {
  const state = liveState();
  seedPosition(state);
  const ex = makeExchange({ async createMarketOrder() { throw new Error('reddedildi'); } });
  const engine = engineFor(state, ex);
  await assert.rejects(() => engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'test', engine.epoch), /yeniden kuruldu/);
  assert.equal(ex.calls.cancel.length, 1);
  assert.equal(ex.calls.stop.length, 1);
  const pos = state.live.positions['BTC/USDT'];
  assert.ok(pos.stopOrderId && pos.stopOrderId !== 'stop-old');
  assert.equal(state.live.safeToTrade, false);
});

test('satış: adım artığı (dust) pozisyonu kapatır, dust defterine yazılır ve mutabakat uyuşur', async () => {
  const state = liveState();
  seedPosition(state, { quantity: 2.6973, withStop: false });
  const ex = makeExchange();
  const engine = engineFor(state, ex);
  await engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'trend bozuldu', engine.epoch);
  assert.equal(ex.calls.market[0].amount, 2.697);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
  assert.ok(Math.abs(state.live.dustByAsset.BTC - 0.0003) < 1e-9);
  // Borsada kalan 0.0003 BTC beklenen artık olarak kabul edilir.
  const mism = checkManagedBalances(state, { BTC: { free: 0.0003, locked: 0, total: 0.0003 } });
  assert.deepEqual(mism, []);
});

test('mutabakat: dust defteri yokken artık bakiye hâlâ uyuşmazlık sayılır', () => {
  const state = liveState();
  const mism = checkManagedBalances(state, { BTC: { free: 0.0003, locked: 0, total: 0.0003 } });
  assert.equal(mism.length, 1);
  assert.equal(mism[0].reason, 'unexpected_asset_balance');
});

test('mutabakat: kaydedilmiş Testnet başlangıç envanteri yerel pozisyondan ayrı tutulur', () => {
  const state = liveState();
  state.live.balanceBaselineByAsset = { BTC: 1 };
  const mism = checkManagedBalances(state, { BTC: { free: 1, locked: 0, total: 1 } });
  assert.deepEqual(mism, []);
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', baseAsset: 'BTC', quantity: 0.25, costQuote: 25 };
  const withPosition = checkManagedBalances(state, { BTC: { free: 1.25, locked: 0, total: 1.25 } });
  assert.deepEqual(withPosition, []);
  const shortfall = checkManagedBalances(state, { BTC: { free: 1.1, locked: 0, total: 1.1 } });
  assert.equal(shortfall[0].reason, 'position_balance_shortfall');
});

test('OrderManager: WS dolumu, gecikmiş REST cevabıyla (NEW/0) net alanlarda ezilmez', async () => {
  const state = { liveOrders: {} };
  let om;
  const ex = makeExchange({
    async createMarketOrder(symbol, side, amount, cid) {
      om.applyExecutionReport({ e: 'executionReport', c: cid, s: 'BTCUSDT', S: 'BUY', X: 'FILLED', x: 'TRADE', z: '1', Z: '100', q: '1', i: 7, I: 1, N: 'USDT', n: '0' });
      return { status: 'NEW', orderId: 7, clientOrderId: cid, executedQty: 0, origQty: 1, cummulativeQuoteQty: 0 };
    }
  });
  om = new OrderManager({ exchange: ex, state, store: makeStore() });
  const r = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'cid-race' });
  assert.equal(r.status, 'FILLED');
  assert.equal(r.executedQty, 1);
  assert.equal(r.netExecutedQty, 1);
  assert.equal(r.netQuoteQty, 100);
});

test('PaperEngine.processPair: timeframe tanımsız değişkeni ReferenceError üretmez', async () => {
  const state = store.defaultState();
  const engine = new PaperEngine({ exchange: { id: 'fake', quoteAssets: ['USDT'], fetchSymbolRules: async () => ({ minNotional: 10 }) }, store: { save() {} }, state });
  engine.log = () => {};
  const pairCfg = state.pairs['BTC/USDT'];
  const strategy = { id: 'x', evaluate: () => ({ action: 'hold', reason: 'test' }) };
  // Tek mum: adım hesaplanamaz, eski kod burada timeframeMs(timeframe) ile çöküyordu.
  await engine.processPair({ symbol: 'BTC/USDT', pairCfg, strategy, params: {}, candles: [{ t: Date.now() - 10 * 3600e3, o: 1, h: 1, l: 1, c: 1, v: 1 }], now: Date.now(), price: 1, epoch: engine.epoch });
});
