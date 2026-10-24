// Birlestirme sirasinda crypto-bot-6-fix15'te bulunan hatalarin KALICI regresyon testleri.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const strategies = require('../src/strategies');
const LiveEngine = require('../src/liveEngine');
const BinanceAdapter = require('../src/exchanges/binance');
const { listExchanges, createExchange } = require('../src/exchanges');
const { intrabarRiskExit } = require('../src/execution');

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

// ---- 1) Panelin durum yayini: listExchanges her ortamda calismali (fix15: Binance TR yuzunden daima cokuyordu) ----
test('listExchanges() her BINANCE_ENV degerinde calisir ve tum kayitli borsalari listeler', () => {
  for (const env of [undefined, '', 'production', 'testnet']) {
    withEnv({ BINANCE_ENV: env }, () => {
      const ids = listExchanges().map((e) => e.id).sort();
      assert.deepEqual(ids, ['binance', 'binancetr', 'btcturk', 'paribu', 'coinbaseexchange', 'kraken', 'bitstamp', 'okx', 'okxtr', 'bybittr', 'midas'].sort(), `BINANCE_ENV=${env}`);
    });
  }
});

test('Binance TR adaptoru kendi adresiyle olusur', () => {
  withEnv({ BINANCE_ENV: undefined }, () => {
    const tr = createExchange('binancetr', {});
    assert.equal(tr.id, 'binancetr');
    assert.match(tr.baseUrl, /binance\.tr/);
  });
});

// ---- 2) Imzali istekler yalnizca resmi adreslere ----
test('Binance base URL: resmi adresler kabul, yabanci adres reddedilir, yerel adres yalnizca test bayragiyla', () => {
  withEnv({ BINANCE_ALLOW_LOCAL_BASE_URL: undefined }, () => {
    assert.doesNotThrow(() => new BinanceAdapter({ baseUrl: 'https://api.binance.com', environment: 'production' }));
    assert.throws(() => new BinanceAdapter({ baseUrl: 'https://data-api.binance.vision', environment: 'production' }), /ortamla uyumsuz/);
    assert.doesNotThrow(() => new BinanceAdapter({ baseUrl: 'https://testnet.binance.vision', environment: 'testnet' }));
    assert.throws(() => new BinanceAdapter({ baseUrl: 'https://evil.example', environment: 'production' }), /ortamla uyumsuz/);
    assert.throws(() => new BinanceAdapter({ baseUrl: 'https://api.binance.com', environment: 'testnet' }), /ortamla uyumsuz/);
    assert.throws(() => new BinanceAdapter({ baseUrl: 'http://api.binance.com', environment: 'production' }), /HTTPS|güvensiz/);
    assert.throws(() => new BinanceAdapter({ baseUrl: 'http://testnet.binance.vision', environment: 'testnet' }), /HTTPS|güvensiz/);
    assert.throws(() => new BinanceAdapter({ baseUrl: 'https://user:pass@api.binance.com', environment: 'production' }), /güvensiz/);
    assert.throws(() => new BinanceAdapter({ baseUrl: 'https://api.binance.com:8443', environment: 'production' }), /güvensiz/);
    assert.throws(() => new BinanceAdapter({ baseUrl: 'http://127.0.0.1:9', environment: 'production' }), /ortamla uyumsuz/);
  });
  withEnv({ BINANCE_ALLOW_LOCAL_BASE_URL: 'true' }, () => {
    assert.doesNotThrow(() => new BinanceAdapter({ baseUrl: 'http://127.0.0.1:9', environment: 'production' }));
    assert.throws(() => new BinanceAdapter({ baseUrl: 'https://evil.example', environment: 'production' }), /ortamla uyumsuz/); // bayrak yalnizca yerel adres icin
  });
});

test('canli mod, yerel test adresi bayragi varken BASLATILAMAZ (diger tum kilitler acik olsa bile)', () => {
  withEnv({ BINANCE_ALLOW_LOCAL_BASE_URL: 'true', ALLOW_PRODUCTION_TRADING: 'true' }, () => {
    const state = store.defaultState();
    state.settings.mode = 'live'; Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
    const ex = { id: 'binance', environment: 'testnet', capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true }, createStopOrder() {}, createTakeProfitOrder() {}, createOcoOrder() {}, cancelOrder() {} };
    const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true });
    assert.throws(() => engine.assertStartAllowed(), /BINANCE_ALLOW_LOCAL_BASE_URL/);
  });
  withEnv({ BINANCE_ALLOW_LOCAL_BASE_URL: undefined, ALLOW_PRODUCTION_TRADING: undefined, BINANCE_ENV: 'testnet', ALLOW_BINANCE_TESTNET_TRADING: 'true', LIVE_TRADING_ENABLED: 'true' }, () => {
    const state = store.defaultState();
    state.settings.mode = 'live'; Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
    const ex = { id: 'binance', environment: 'testnet', capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true }, createStopOrder() {}, createTakeProfitOrder() {}, createOcoOrder() {}, cancelOrder() {} };
    const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true });
    assert.doesNotThrow(() => engine.assertStartAllowed()); // testnet + tum kilitler normal: baslayabilir
  });
});

// ---- 3) Trailing stop: kotumser model + bosluk (gap) kenar durumu ----
test('trailing: mum acilisi eski stop\'un ALTINDAYSA, sonradan zirve yapsa bile dolum ACILISTAN (fix15: 106.7, %18 iyimser)', () => {
  const pos = { entryPrice: 100, stopPrice: 97, highWaterMark: 100 };
  const r = intrabarRiskExit(pos, { t: 0, o: 90, h: 110, l: 88, c: 100 }, { stopLossPct: 3, takeProfitPct: 500, trailingStop: true }, true);
  assert.deepEqual(r, { ref: 90, reason: 'stop-loss' });
});

test('trailing: normal acilista yukselip geri donen mum, YENI zirveye gore stop\'a takilir (kotumser model korunur)', () => {
  const pos = { entryPrice: 100, stopPrice: 97, highWaterMark: 100 };
  const r = intrabarRiskExit(pos, { t: 0, o: 100, h: 110, l: 100, c: 105 }, { stopLossPct: 3, takeProfitPct: 500, trailingStop: true }, true);
  assert.equal(r, null);
  assert.equal(pos.highWaterMark, 110);
});

test('sabit (trailing olmayan) stop davranisi degismedi: bosluk acilistan, normalde stop fiyatindan', () => {
  const P = { stopLossPct: 3, takeProfitPct: 6, trailingStop: false };
  assert.deepEqual(intrabarRiskExit({ entryPrice: 100, stopPrice: 97, highWaterMark: 100 }, { t: 0, o: 90, h: 91, l: 88, c: 89 }, P), { ref: 90, reason: 'stop-loss' });
  assert.deepEqual(intrabarRiskExit({ entryPrice: 100, stopPrice: 97, highWaterMark: 100 }, { t: 0, o: 100, h: 101, l: 96, c: 98 }, P), { ref: 97, reason: 'stop-loss' });
});

// ---- 4) Canli motor: eski sinyal ----
const H = 3600000, T0 = Date.UTC(2026, 9, 2, 0, 0);
const C = (i, p) => ({ t: T0 + i * H, o: p, h: p, l: p, c: p, v: 1 });
async function liveProbe({ minutesAfterOpen, action, withPosition = false }) {
  const state = store.defaultState();
  state.settings.mode = 'live'; Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
  state.pairs = { 'BTC/USDT': { ...state.pairs['BTC/USDT'], enabled: true, budgetPct: 30 } };
  state.live.safeToTrade = true;
  const orders = [];
  const ex = {
    id: 'test', name: 'Test', quoteAssets: ['USDT'], capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { return { USDT: { free: 1000, locked: 0 } }; }, async fetchOpenOrders() { return []; },
    async getOrder(s, id, cid) { return { status: 'FILLED', orderId: 1, clientOrderId: cid, executedQty: 1, origQty: 1, cummulativeQuoteQty: 100 }; },
    async createMarketOrder(s, side, amount, cid) { orders.push(side); return { status: 'FILLED', orderId: orders.length, clientOrderId: cid, executedQty: amount, origQty: amount, cummulativeQuoteQty: amount * 100, symbol: 'BTCUSDT', side: side.toUpperCase() }; },
    async createStopOrder(s, side, amount, stop, limit, cid) { orders.push('stop'); return { status: 'NEW', orderId: 99, clientOrderId: cid, executedQty: 0, origQty: amount, symbol: 'BTCUSDT', side: 'SELL' }; },
    async createOcoOrder(s, side, amount, args) { orders.push('oco'); return { orderListId: 1, listClientOrderId: args.listClientOrderId, orders: [{orderId:99,clientOrderId:args.stopClientOrderId,symbol:'BTCUSDT'},{orderId:100,clientOrderId:args.takeProfitClientOrderId,symbol:'BTCUSDT'}], orderReports: [{orderId:99,clientOrderId:args.stopClientOrderId,symbol:'BTCUSDT',side:'SELL',status:'NEW',executedQty:0,origQty:amount,stopPrice:args.stopPrice},{orderId:100,clientOrderId:args.takeProfitClientOrderId,symbol:'BTCUSDT',side:'SELL',status:'NEW',executedQty:0,origQty:amount,stopPrice:args.takeProfitPrice}]}; },
    async cancelOrder() { return { status: 'CANCELED' }; },
    async fetchCandles() { return Array.from({ length: 12 }, (_, i) => C(i, 100)); }, async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10, tickSize: 0.01 }; }
  };
  const reg = strategies.registry; const id = state.pairs['BTC/USDT'].strategyId; const orig = reg[id];
  reg[id] = { ...orig, evaluate: () => ({ action, reason: 'test sinyali' }) };
  if (withPosition) state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, openedAt: new Date(T0).toISOString(), stopPrice: 97 };
  const now = T0 + 11 * H + minutesAfterOpen * 60000;
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: () => now });
  engine.log = () => {};
  let error = null;
  try { await engine.processPair('BTC/USDT', state.pairs['BTC/USDT'], engine.epoch); } catch (e) { error = e.message; } finally { reg[id] = orig; }
  return { orders, state, error };
}

test('canli: taze ALIM sinyali (mum kapanisindan 1 dk sonra) emir gonderir', async () => {
  const r = await liveProbe({ minutesAfterOpen: 1, action: 'buy' });
  assert.deepEqual(r.orders.slice(0, 2), ['buy', 'stop'], r.error || '');
  assert.equal(r.state.decisions['BTC/USDT'].stale, false);
});

test('canli: ESKI ALIM sinyali (45 dk) GERCEK EMIRE DONUSMEZ, karar eski olarak kaydedilir (fix15: market alim yapiyordu)', async () => {
  const r = await liveProbe({ minutesAfterOpen: 45, action: 'buy' });
  assert.deepEqual(r.orders, []);
  assert.equal(r.state.decisions['BTC/USDT'].stale, true);
  assert.equal(r.state.decisions['BTC/USDT'].action, 'buy');
});

test('canli: ESKI SATIM sinyali riski azalttigi icin yine uygulanir', async () => {
  const r = await liveProbe({ minutesAfterOpen: 45, action: 'sell', withPosition: true });
  assert.ok(r.orders.includes('sell'), `emirler: [${r.orders}] hata: ${r.error}`);
});

// ---- 5) Kod saglik kontrolleri ----
test('liveEngine.js icinde stop() yalnizca BIR kez tanimli (yinelenen tanim sonuncusunu sessizce gecerli kilar)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'liveEngine.js'), 'utf8');
  assert.equal((src.match(/^\s*async stop\(/gm) || []).length, 1);
});

test('canli mod kapisi: simulation (cevrimdisi sahte borsa) baslayabilir, panelden secilebilir hicbir borsa disinda kimlik yok', () => {
  const { registry } = require('../src/exchanges');
  assert.ok(!Object.prototype.hasOwnProperty.call(registry, 'simulation'), 'simulation kayit defterinde olmamali');
  const { SimulatedExchange } = require('../src/simulatedExchange');
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  assert.equal(ex.id, 'simulation');
  const state = store.defaultState();
  state.settings.mode = 'live'; Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true });
  assert.doesNotThrow(() => engine.assertStartAllowed());
});

// ---- 6) .env.example'daki BINANCE_ENV=testnet kagit botu test agina goturmemeli ----
const { resolveBinanceEnvironment } = require('../src/exchanges');
test('kagit modda Binance ortami HER ZAMAN production (BINANCE_ENV=testnet olsa bile gercek piyasa verisi)', () => {
  for (const envValue of [undefined, '', 'production', 'testnet', 'TESTNET']) {
    assert.equal(resolveBinanceEnvironment('paper', envValue), 'production', `paper + ${envValue}`);
    assert.equal(resolveBinanceEnvironment(undefined, envValue), 'production');
  }
  withEnv({ BINANCE_ENV: 'testnet', BINANCE_BASE_URL: undefined }, () => {
    const paperAdapter = createExchange('binance', { environment: resolveBinanceEnvironment('paper', process.env.BINANCE_ENV) });
    assert.equal(paperAdapter.baseUrl, 'https://api.binance.com');
    assert.equal(paperAdapter.environment, 'production');
  });
});

test('canli modda BINANCE_ENV uygulanir (testnet -> test agi adresi), bos ise production', () => {
  assert.equal(resolveBinanceEnvironment('live', 'testnet'), 'testnet');
  assert.equal(resolveBinanceEnvironment('live', 'TESTNET'), 'testnet');
  assert.equal(resolveBinanceEnvironment('live', undefined), 'production');
  withEnv({ BINANCE_BASE_URL: undefined }, () => {
    assert.match(createExchange('binance', { environment: resolveBinanceEnvironment('live', 'testnet') }).baseUrl, /testnet\.binance\.vision/);
  });
});

// ---- 7) Canli mod: Binance TR ayri ve acik bir guvenlik kilidiyle desteklenir ----
test('doğrulama kanıtı olmayan gerçek borsa adaptörleri canlı başlangıçta fail-closed kalır', () => {
  withEnv({ BINANCE_ENV: 'testnet', ALLOW_PRODUCTION_TRADING: undefined, ALLOW_BINANCE_TESTNET_TRADING: undefined, LIVE_TRADING_ENABLED: undefined, BINANCE_ALLOW_LOCAL_BASE_URL: undefined }, () => {
    const paribuState = store.defaultState();
    paribuState.settings.mode = 'live'; Object.assign(paribuState.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
    const paribu = new LiveEngine({ exchange: createExchange('paribu', {}), state: paribuState, store: { save() {} }, allowLive: true });
    withEnv({ ALLOW_PARIBU_TRADING: 'true' }, () => {
      const paribuOk = new LiveEngine({ exchange: createExchange('paribu', {}), state: paribuState, store: { save() {} }, allowLive: true });
      assert.throws(() => paribuOk.assertStartAllowed(), /liveTradingVerified|gerekli API yeteneklerini desteklemiyor|clientOrderId|deterministik|native OCO|OCO/i, 'paribu');
    });

    const btcturkState = store.defaultState();
    btcturkState.settings.mode = 'live'; Object.assign(btcturkState.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
    withEnv({ ALLOW_BTCTURK_TRADING: 'true' }, () => {
      const btcturk = new LiveEngine({ exchange: createExchange('btcturk', {}), state: btcturkState, store: { save() {} }, allowLive: true });
      assert.throws(() => btcturk.assertStartAllowed(), /liveTradingVerified/, 'BTCTurk gerçek sandbox/hesap kanıtı olmadan canlıya açılamaz');
    });
    const trState = store.defaultState();
    trState.settings.mode = 'live'; Object.assign(trState.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
    const tr = new LiveEngine({ exchange: createExchange('binancetr', {}), state: trState, store: { save() {} }, allowLive: true });
    assert.throws(() => tr.assertStartAllowed(), /liveTradingVerified|ALLOW_BINANCE_TR_TRADING/);
    const trState2 = store.defaultState();
    trState2.settings.mode = 'live'; Object.assign(trState2.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
    withEnv({ ALLOW_BINANCE_TR_TRADING: 'true' }, () => {
      const trOk = new LiveEngine({ exchange: createExchange('binancetr', {}), state: trState2, store: { save() {} }, allowLive: true });
      assert.throws(() => trOk.assertStartAllowed(), /liveTradingVerified/, 'Binance TR doğrulama kanıtı olmadan canlıya açılamaz');
    });
    const state = store.defaultState();
    state.settings.mode = 'live'; Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
    const ok = new LiveEngine({ exchange: createExchange('binance', { environment: 'production' }), state, store: { save() {} }, allowLive: true });
    assert.throws(() => ok.assertStartAllowed(), /liveTradingVerified/, 'Doğrulanmamış Binance üretim adaptörü canlı motorda açılamaz');
  });
});
