'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isBinanceSpotTestnetOptIn } = require('../src/util/binanceTestnetGate');
const { OrderManager } = require('../src/orderManager');

const allowedEnv = {
  BINANCE_ENV: 'testnet',
  ALLOW_BINANCE_TESTNET_TRADING: 'true',
  LIVE_TRADING_ENABLED: 'true'
};

test('Binance Spot Testnet requires all explicit opt-ins and official hostname', () => {
  const ex = { id: 'binance', environment: 'testnet', baseUrl: 'https://testnet.binance.vision', capabilities: {} };
  assert.equal(isBinanceSpotTestnetOptIn(ex, allowedEnv), true);
  assert.equal(isBinanceSpotTestnetOptIn(ex, { ...allowedEnv, LIVE_TRADING_ENABLED: 'false' }), false);
  assert.equal(isBinanceSpotTestnetOptIn(ex, { ...allowedEnv, ALLOW_BINANCE_TESTNET_TRADING: 'false' }), false);
  assert.equal(isBinanceSpotTestnetOptIn(ex, { ...allowedEnv, BINANCE_ENV: 'production' }), false);
  assert.equal(isBinanceSpotTestnetOptIn({ ...ex, environment: 'production' }, allowedEnv), false);
  assert.equal(isBinanceSpotTestnetOptIn({ ...ex, baseUrl: 'https://api.binance.com' }, allowedEnv), false);
  assert.equal(isBinanceSpotTestnetOptIn({ ...ex, baseUrl: 'https://testnet.binance.vision.attacker.invalid' }, allowedEnv), false);
  assert.equal(isBinanceSpotTestnetOptIn({ ...ex, baseUrl: 'http://testnet.binance.vision' }, allowedEnv), false);
  assert.equal(isBinanceSpotTestnetOptIn({ ...ex, baseUrl: 'https://testnet.binance.vision/private' }, allowedEnv), false);
  assert.equal(isBinanceSpotTestnetOptIn({ ...ex, baseUrl: 'https://user:pass@testnet.binance.vision' }, allowedEnv), false);
  assert.equal(isBinanceSpotTestnetOptIn({ ...ex, baseUrl: 'https://testnet.binance.vision:8443' }, allowedEnv), false);
  assert.equal(isBinanceSpotTestnetOptIn({ ...ex, id: 'binancetr' }, allowedEnv), false);
});

test('OrderManager permits unverified adapter only with explicit Binance Spot Testnet opt-in', () => {
  const exchange = {
    id: 'binance', name: 'Binance', environment: 'testnet', baseUrl: 'https://testnet.binance.vision',
    capabilities: { liveTradingVerified: false, clientOrderId: true, orderQuery: true },
    createMarketOrder() {}, getOrder() {}
  };
  const manager = new OrderManager({ exchange, state: { liveOrders: {} }, store: { save() {} } });
  const original = { ...process.env };
  try {
    Object.assign(process.env, allowedEnv);
    assert.doesNotThrow(() => manager.assertLiveCapability());
    process.env.ALLOW_BINANCE_TESTNET_TRADING = 'false';
    assert.throws(() => manager.assertLiveCapability(), /liveTradingVerified=false/);
  } finally {
    for (const key of ['BINANCE_ENV', 'ALLOW_BINANCE_TESTNET_TRADING', 'LIVE_TRADING_ENABLED']) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
});

test('LiveEngine refuses Testnet startup unless the dedicated opt-in is complete', () => {
  const LiveEngine = require('../src/liveEngine');
  const store = require('../src/store');
  const exchange = {
    id: 'binance', name: 'Binance', environment: 'testnet', baseUrl: 'https://testnet.binance.vision',
    capabilities: { liveTradingVerified: false, clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, nativeTrailingOco: true, marketOrderBook: true },
    createMarketOrder() {}, getOrder() {}, createStopOrder() {}, cancelOrder() {}
  };
  const state = store.defaultState(); state.settings.mode = 'live';
  const engine = new LiveEngine({ exchange, state, store: { save() {} }, allowLive: true });
  const keys = ['BINANCE_ENV', 'ALLOW_BINANCE_TESTNET_TRADING', 'LIVE_TRADING_ENABLED'];
  const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    process.env.BINANCE_ENV = 'testnet';
    process.env.ALLOW_BINANCE_TESTNET_TRADING = 'false';
    process.env.LIVE_TRADING_ENABLED = 'true';
    assert.throws(() => engine.assertStartAllowed(), /ALLOW_BINANCE_TESTNET_TRADING=true/);
  } finally {
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
