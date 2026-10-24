const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { makeEngine, onlyPair } = require('./helpers');
const LiveEngine = require('../src/liveEngine');
const store = require('../src/store');

const M = 60000;
const pol = require('../src/timeframePolicy');
const AGG = 'aggressive_breakout', NORM = 'rsi_ema_macd';
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
test('seçim tablosu: agresif 1-3-5-15-30(+1h/4h), normal 15-30-1h-4h', () => {
  for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '4h']) assert.equal(pol.TABLE[tf].aggressive, true, tf);
  for (const tf of ['1m', '3m', '5m']) assert.equal(pol.TABLE[tf].normal, false, tf);
  for (const tf of ['15m', '30m', '1h', '4h']) assert.equal(pol.TABLE[tf].normal, true, tf);
  assert.deepEqual(pol.describe().map((x) => x.id), pol.ALL_TIMEFRAMES);
});
test('kısa mumlar yalnızca agresif + hızlı kontrol + paper ile kabul edilir', () => {
  for (const tf of ['1m', '3m', '5m']) {
    const ok = { timeframe: tf, strategyId: AGG, pollSeconds: 15, mode: 'paper' };
    assert.equal(pol.timeframeProblem(ok), null, tf);
    assert.match(pol.timeframeProblem({ ...ok, strategyId: NORM }), /Agresif/);
    assert.match(pol.timeframeProblem({ ...ok, pollSeconds: 120 }), /en fazla/);
    assert.match(pol.timeframeProblem({ ...ok, mode: 'live' }), /canlı/);
  }
  assert.equal(pol.maxPollSeconds('1m'), 20);
  assert.equal(pol.maxPollSeconds('3m'), 30);
  assert.equal(pol.maxPollSeconds('5m'), 50);
  assert.equal(pol.maxPollSeconds('15m'), null);
});
test('30m/1h/4h normal ve canlıda sınırsız; bilinmeyen aralık reddedilir', () => {
  for (const tf of ['15m', '30m', '1h', '4h']) assert.equal(pol.timeframeProblem({ timeframe: tf, strategyId: NORM, pollSeconds: 3600, mode: 'live' }), null, tf);
  assert.match(pol.timeframeProblem({ timeframe: '2m', strategyId: AGG, pollSeconds: 15 }), /biri olmalı/);
});
test('3m BTCTurk/Paribu için reddedilir, Binance için kabul edilir', () => {
  const base = { timeframe: '3m', strategyId: AGG, pollSeconds: 15, mode: 'paper' };
  assert.match(pol.timeframeProblem({ ...base, exchangeId: 'btcturk' }), /desteklenmiyor/);
  assert.match(pol.timeframeProblem({ ...base, exchangeId: 'paribu' }), /desteklenmiyor/);
  assert.equal(pol.timeframeProblem({ ...base, exchangeId: 'binance' }), null);
});

function oneMinuteSeries(now, closeAgeMs) {
  // son KAPANMIŞ mum closeAgeMs önce kapandı; ardından oluşan mum var
  const formingT = now - closeAgeMs; // Forming mum acilisini hedef kapanis yasina sabitle; dakika tabanina yuvarlamak 0-60 sn gizli yas ekler.
  const out = [];
  for (let i = 300; i >= 0; i--) { const t = formingT - i * M, c = 100 + (300 - i) * 0.01; out.push({ t, o: c, h: c, l: c, c, v: 1 }); }
  return out;
}

async function runBuy({ pollSeconds, closeAgeMs }) {
  const real = strategies.registry.aggressive_breakout.evaluate;
  strategies.registry.aggressive_breakout.evaluate = () => ({ action: 'buy', reason: 'test', price: 103 });
  try {
    const now = Date.now();
    const { engine, state } = makeEngine({ exchange: { id: 'fake', name: 'F', quoteAssets: ['USDT'], fetchCandles: async () => oneMinuteSeries(now, closeAgeMs), fetchSymbolRules: async () => ({ minNotional: 10 }) } });
    const pair = onlyPair(state);
    Object.assign(pair, { strategyId: 'aggressive_breakout', timeframe: '1m', params: { ...strategies.get('aggressive_breakout').defaultParams } });
    state.settings.pollSeconds = pollSeconds;
    state.running = true;
    await engine.tick();
    return Object.keys(state.paper.positions).length;
  } finally { strategies.registry.aggressive_breakout.evaluate = real; }
}

test('1m mumda taze sinyal (15 sn önce kapanan) alıma dönüşür', async () => {
  assert.equal(await runBuy({ pollSeconds: 15, closeAgeMs: 10000 }), 1);
});
test('1m mumda 90 sn önce kapanan sinyal eski sayılıp atlanır', async () => {
  assert.equal(await runBuy({ pollSeconds: 15, closeAgeMs: 90000 }), 0);
});

test('canlı motor 1m mumla başlatılmaz', async () => withTestnetEnv(async () => {
  const state = store.defaultState(); state.settings.mode = 'live';
  Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
  Object.values(state.pairs).forEach((p, i) => { if (i === 0) { p.timeframe = '1m'; p.strategyId = 'aggressive_breakout'; p.params = { ...strategies.get('aggressive_breakout').defaultParams }; } });
  const ex = { id: 'binance', environment: 'testnet', name: 'T', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    createStopOrder() {}, cancelOrder() {}, fetchOrderBook() {} };
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true });
  await assert.rejects(() => engine.start(), /canlı modda henüz desteklenmiyor/);
}));
