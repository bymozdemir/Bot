const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const PaperEngine = require('../src/paperEngine');
const { OrderManager } = require('../src/orderManager');
const ParibuAdapter = require('../src/exchanges/paribu');

test('paper kasa TRY ve USDT yi ayrı ledger olarak tutar', () => {
  const state = store.defaultState();
  state.paper.cashByAsset = { TRY: 1000, USDT: 500 };
  state.paper.cash = 500;
  state.paper._legacyCashMirror = 500;
  state.paper.positions = {
    'BTC/TRY': { symbol:'BTC/TRY', baseAsset:'BTC', quoteAsset:'TRY', quantity:0.01, entryPrice:100000 },
    'ETH/USDT': { symbol:'ETH/USDT', baseAsset:'ETH', quoteAsset:'USDT', quantity:1, entryPrice:2000 }
  };
  state.paper.lastPrices = { 'BTC/TRY': 110000, 'ETH/USDT': 2100 };
  const engine = new PaperEngine({ exchange:{quoteAssets:['TRY','USDT']}, store:{save(){}}, state });
  const eq = engine.computeEquityByQuote();
  assert.ok(Math.abs(eq.TRY - (1000 + 0.01 * 110000 * (1 - 0.0005) * (1 - 0.001))) < 1e-9);
  assert.ok(Math.abs(eq.USDT - (500 + 2100 * (1 - 0.0005) * (1 - 0.001))) < 1e-9);
  assert.equal(engine.cashFor('TRY'), 1000);
  assert.equal(engine.cashFor('USDT'), 500);
});

test('Paribu fingerprint kurtarma güvenli canlı emir kimliği yerine kullanılamaz', () => {
  const ex = new ParibuAdapter({});
  assert.equal(ex.capabilities.recoveryByFingerprint, false);
  // Bu test yalnızca clientOrderId eksikliğini izole eder; gerçek adaptörün bayrağı false kalır.
  ex.capabilities.liveTradingVerified = true;
  assert.equal(ex.capabilities.clientOrderId, false);
  const state = store.defaultState(); state.settings.mode = 'live';
  const manager = new OrderManager({ exchange: ex, state, store:{save(){}} });
  assert.throws(() => manager.assertLiveCapability(), /clientOrderId|deterministik/i);
});

test('live emir bütçesi exchange.quoteAssets[0] değil paritenin quote varlığını seçer', () => {
  const LiveEngine = require('../src/liveEngine');
  const state = store.defaultState();
  state.settings.mode = 'live';
  const ex = { id:'btcturk', name:'BTCTurk', quoteAssets:['TRY','USDT'], capabilities:{}, fetchBalance:async()=>({}) };
  const engine = new LiveEngine({ exchange:ex, state, store:{save(){}}, allowLive:true });
  assert.equal(engine.quoteAsset('BTC/USDT'), 'USDT');
  assert.equal(engine.quoteAsset('BTC/TRY'), 'TRY');
});
