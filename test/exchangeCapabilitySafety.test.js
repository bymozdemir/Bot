const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceAdapter = require('../src/exchanges/binance');
const BinanceTrAdapter = require('../src/exchanges/binancetr');
const BtcturkAdapter = require('../src/exchanges/btcturk');
const ParibuAdapter = require('../src/exchanges/paribu');

test('exchange capability matrix does not claim unsupported native OCO/trailing', () => {
  const binance = new BinanceAdapter({});
  const binanceTr = new BinanceTrAdapter({});
  const btcturk = new BtcturkAdapter({});
  const paribu = new ParibuAdapter({});

  assert.equal(binance.capabilities.oco, true);
  assert.equal(binance.capabilities.nativeTrailingOco, true);
  assert.equal(binanceTr.capabilities.oco, true);
  assert.equal(binanceTr.capabilities.nativeTrailingOco, false);
  assert.equal(btcturk.capabilities.oco, false);
  assert.equal(btcturk.capabilities.nativeTrailingOco, false);
  assert.equal(paribu.capabilities.oco, false);
  assert.equal(paribu.capabilities.nativeTrailingOco, false);
});

test('Paribu cannot be treated as deterministic client-order-id recovery until its API contract is verified', () => {
  const paribu = new ParibuAdapter({});
  assert.equal(paribu.capabilities.clientOrderId, false);
  assert.equal(paribu.capabilities.recoveryByFingerprint, false);
});

test('live contract audit fingerprint kurtarmasını tek başına güvenli kimlik saymaz', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'liveContractAudit.js'),
    'utf8'
  );
  assert.match(
    source,
    /const safeIdentity = caps\.clientOrderId === true && caps\.recoveryByFingerprint !== true;/
  );
  assert.doesNotMatch(
    source,
    /const safeIdentity = !!caps\.clientOrderId \|\| !!caps\.recoveryByFingerprint;/
  );
});


test('live contract audit requires explicit verification before printing GREEN', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'liveContractAudit.js')
  ], { encoding: 'utf8' });
  const output = result.stdout || '';
  assert.match(output, /YELLOW binance: code=complete .*verified=NO/);
  assert.match(output, /YELLOW btcturk: code=complete .*verified=NO/);
  assert.match(output, /YELLOW binancetr: code=complete .*verified=NO/);
  assert.match(output, /RED paribu: code=incomplete identity=false/);
  assert.match(output, /RED midas: code=incomplete/);
  assert.doesNotMatch(output, /GREEN (?:binance|btcturk|binancetr):/);
});

test('all real exchange adapters remain explicitly locked until sandbox/real-account evidence exists', () => {
  const { registry } = require('../src/exchanges');
  for (const [id, Adapter] of Object.entries(registry)) {
    const ex = new Adapter();
    assert.equal(ex.capabilities.liveTradingVerified, false, `${id} must fail closed by default`);
  }
});


test('liveTradingVerified eksik/undefined ise LiveEngine ve OrderManager fail-closed davranır', async () => {
  const LiveEngine = require('../src/liveEngine');
  const { OrderManager } = require('../src/orderManager');
  const store = require('../src/store');
  const state = store.defaultState();
  state.settings.mode = 'live';
  const exchange = {
    id: 'binance', name: 'Binance', quoteAssets: ['USDT'],
    capabilities: {
      clientOrderId: true, orderQuery: true, balanceQuery: true,
      openOrdersQuery: true, marketOrderBook: true
      // liveTradingVerified bilerek tanımsız bırakıldı.
    },
    createMarketOrder: async () => { throw new Error('Ağ çağrısı yapılmamalı'); },
    getOrder: async () => null,
    createStopOrder: async () => null,
    cancelOrder: async () => null,
    fetchBalance: async () => ({}),
    fetchOrderBook: async () => ({ bids: [], asks: [] })
  };
  const manager = new OrderManager({ exchange, state, store: { save() {} } });
  assert.throws(() => manager.assertLiveCapability(), /liveTradingVerified=false veya eksik/);
  const engine = new LiveEngine({ exchange, state, store: { save() {} }, allowLive: true });
  assert.throws(() => engine.assertStartAllowed(), /liveTradingVerified=false veya eksik/);
});

test('live contract audit protective stop implementation must be explicit; unknown capability is not GREEN/YELLOW-complete', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'liveContractAudit.js'), 'utf8');
  assert.match(source, /caps\.protectiveStopImplemented === true/);
  const ParibuAdapter = require('../src/exchanges/paribu');
  const MidasAdapter = require('../src/exchanges/midas');
  assert.equal(new ParibuAdapter().capabilities.protectiveStopImplemented, false);
  assert.equal(new MidasAdapter().capabilities.protectiveStopImplemented, false);
});
