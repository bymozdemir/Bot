// 2.1.9: akış başlatma hatası, başlangıç nedeni ve testnet baseline genişletme testleri.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const { BinanceUserDataStream } = require('../src/userDataStream');

const FIXED_NOW = () => Date.UTC(2026, 9, 2, 12, 0);
function makeStore() { return { saves: 0, save() { this.saves++; } }; }
async function withTestnetEnv(fn) {
  const keys = ['BINANCE_ENV', 'ALLOW_BINANCE_TESTNET_TRADING', 'LIVE_TRADING_ENABLED', 'BINANCE_ALLOW_LOCAL_BASE_URL', 'ALLOW_PRODUCTION_TRADING'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.BINANCE_ENV = 'testnet'; process.env.ALLOW_BINANCE_TESTNET_TRADING = 'true'; process.env.LIVE_TRADING_ENABLED = 'true';
  delete process.env.BINANCE_ALLOW_LOCAL_BASE_URL; delete process.env.ALLOW_PRODUCTION_TRADING;
  try { return await fn(); } finally { for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
function makeExchange(balances = { USDT: { free: 1000, locked: 0 } }, env = 'testnet') {
  return {
    id: 'binance', environment: env, name: 'Test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { return balances; },
    async fetchOpenOrders() { return []; },
    async getOrder() { return { status: 'FILLED', orderId: 1, clientOrderId: 'x', executedQty: 1, origQty: 1, cummulativeQuoteQty: 100 }; },
    async createMarketOrder(symbol, side, amount, cid) { return { status: 'FILLED', orderId: 1, clientOrderId: cid, executedQty: amount, origQty: amount, cummulativeQuoteQty: amount * 100 }; },
    async createStopOrder(symbol, side, amount, stop, limit, cid) { return { status: 'NEW', orderId: 2, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async createTakeProfitOrder(symbol, side, amount, stop, limit, cid) { return { status: 'NEW', orderId: 3, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async createOcoOrder() { return { orderListId: 9, orders: [], orderReports: [] }; },
    async cancelOrder(symbol, orderId) { return { status: 'CANCELED', orderId }; },
    async fetchCandles() { return []; },
    async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10 }; }
  };
}
function liveState() {
  const state = store.defaultState(); state.settings.mode = 'live';
  Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
  return state;
}
function mkFakeWs(plan) { // plan: her yeni soket için 'reject' | 'ok'
  const sockets = [];
  class FakeWS extends EventEmitter {
    constructor() { super(); this.n = sockets.length; sockets.push(this); this.closed = false; this.mode = plan[this.n] || 'ok'; setImmediate(() => this.emit('open')); }
    send(data) {
      const id = JSON.parse(data).id;
      setImmediate(() => this.emit('message', JSON.stringify(this.mode === 'reject'
        ? { id, status: 400, error: { msg: 'Invalid API-key, IP, or permissions for action.' } }
        : { id, status: 200, result: { subscriptionId: this.n } })));
    }
    close() { if (this.closed) return; this.closed = true; setTimeout(() => this.emit('close'), 1); }
    terminate() { this.close(); }
  }
  FakeWS.sockets = sockets;
  return FakeWS;
}
const wsEx = { createUserDataStreamSignature: () => ({}), getUserDataWsUrl: () => 'ws://x' };

test('akış: ilk başlatma reddedilirse running işareti temizlenir ve ikinci start() GERÇEKTEN yeniden bağlanır', async () => {
  const WS = mkFakeWs(['reject', 'ok']);
  const state = {};
  const st = new BinanceUserDataStream({ exchange: wsEx, orderManager: { applyExecutionReport() {} }, state, store: { save() {} }, WebSocketImpl: WS, reconnectMs: 10, subscribeTimeoutMs: 500 });
  await assert.rejects(() => st.start(), /Invalid API-key/);
  assert.equal(st.running, false, 'başarısız başlatma sonrası running false olmalı');
  assert.equal(state.liveStream.running, false);
  assert.match(state.liveStream.error, /Invalid API-key/);
  await st.start(); // eskiden 'zaten çalışıyor' diye hiç bağlanmadan dönerdi
  assert.equal(WS.sockets.length, 2, 'ikinci denemede yeni soket açılmalı');
  assert.equal(state.liveStream.connected, true);
  await st.stop();
});

test('motor: akış başlatılamazsa akış durdurulur, -2015 için anlaşılır ipucu verilir ve bot çalışıyor görünmez', async () => withTestnetEnv(async () => {
  const state = liveState(); let stopped = 0; let starts = 0;
  const stream = { async start() { starts++; throw new Error('Invalid API-key, IP, or permissions for action.'); }, async stop() { stopped++; } };
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, stream,
    recovery: { async recover() { return { safeToTrade: true }; } } });
  await assert.rejects(() => engine.start(), (e) => /User Data Stream başlatılamadı/.test(e.message) && /BINANCE_ENV=testnet/.test(e.message));
  assert.equal(stopped, 1);
  assert.notEqual(state.running, true);
  assert.equal(state.live.safeToTrade, false);
  await assert.rejects(() => engine.start(), /User Data Stream başlatılamadı/);
  assert.equal(starts, 2, 'ikinci başlat yeniden akışı denemeli');
}));

test('motor: başlangıç mutabakatı başarısızsa hata metni ve kilit nedeni gerçek nedeni söyler', async () => withTestnetEnv(async () => {
  const state = liveState();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW,
    recovery: { async recover() { return { safeToTrade: false, errors: [], account: { errors: ['Bakiye sorgulanamadı: API anahtarı gerekli'], balanceMismatches: [{ asset: 'SOL', expected: 0, actual: 500, reason: 'unexpected_asset_balance' }] } }; } } });
  await assert.rejects(() => engine.start(), (e) => /mutabakatı tamamlanamadı/.test(e.message) && /Bakiye sorgulanamadı/.test(e.message) && /SOL: unexpected_asset_balance/.test(e.message));
  assert.match(state.live.lockReason, /Başlangıç mutabakatı: .*Bakiye sorgulanamadı/);
}));

test('baseline: testnet baseline varken sonradan eklenen paritenin başlangıç bakiyesi eklenir ve recovery güvenli olur', async () => withTestnetEnv(async () => {
  const state = liveState();
  state.live.balanceBaselineByAsset = { BTC: 1, ETH: 2, XRP: 0, DOGE: 0 }; // SOL sonradan eklendi
  const balances = { USDT: { free: 1000, locked: 0 }, BTC: { free: 1, locked: 0 }, ETH: { free: 2, locked: 0 }, SOL: { free: 500, locked: 0 }, XRP: { free: 0, locked: 0 } };
  const engine = new LiveEngine({ exchange: makeExchange(balances), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW });
  const r = await engine.recovery.recover();
  assert.equal(state.live.balanceBaselineByAsset.SOL, 500);
  assert.equal(r.safeToTrade, true, JSON.stringify(r.account?.errors));
}));

test('baseline: yerelde o coine ait emir/pozisyon kaydı varsa, kill switch açıksa veya testnet değilse genişletilmez', async () => withTestnetEnv(async () => {
  const account = { errors: ['Yönetilen varlık bakiyesi yerel pozisyon defteriyle uyuşmuyor.'], openOrders: [], orphanOpenOrders: [], unknownLocalOrders: [], balances: {},
    balanceMismatches: [{ asset: 'SOL', expected: 0, actual: 500, reason: 'unexpected_asset_balance' }] };
  const mk = (mut, env) => { const state = liveState(); state.live.balanceBaselineByAsset = { BTC: 1 }; mut(state); return { state, engine: new LiveEngine({ exchange: makeExchange({}, env), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW }) }; };

  let { state, engine } = mk((s) => { s.liveOrders = { a: { clientOrderId: 'a', symbol: 'SOL/USDT', side: 'buy', status: 'FILLED' } }; });
  assert.equal((await engine._repairRecoveredState({ account })).changed, false);
  assert.equal(state.live.balanceBaselineByAsset.SOL, undefined);

  ({ state, engine } = mk((s) => { s.killSwitch = { reason: 'test' }; }));
  assert.equal((await engine._repairRecoveredState({ account })).changed, false);
  assert.equal(state.live.balanceBaselineByAsset.SOL, undefined);

  ({ state, engine } = mk(() => {}, 'production'));
  assert.equal((await engine._repairRecoveredState({ account })).changed, false);
  assert.equal(state.live.balanceBaselineByAsset.SOL, undefined);

  // başka hata da varsa (ör. bakiye sorgusu) dokunulmaz
  ({ state, engine } = mk(() => {}));
  const bad = { ...account, errors: [...account.errors, 'Açık emirler sorgulanamadı: x'] };
  assert.equal((await engine._repairRecoveredState({ account: bad })).changed, false);
  assert.equal(state.live.balanceBaselineByAsset.SOL, undefined);

  // koşullar uygunsa eklenir
  ({ state, engine } = mk(() => {}));
  assert.equal((await engine._repairRecoveredState({ account })).changed, true);
  assert.equal(state.live.balanceBaselineByAsset.SOL, 500);
}));
