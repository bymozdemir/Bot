const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const { SimulatedExchange } = require('../src/simulatedExchange');

function makeStore() { return { saves: 0, save() { this.saves++; } }; }

test('offline simulation: market buy/sell bakiye ve emir defterini tutarlı günceller', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const buy = await ex.createMarketOrder('BTC/USDT', 'buy', 2, 'buy-1');
  assert.equal(buy.status, 'FILLED');
  assert.equal((await ex.fetchBalance()).USDT.free, 800);
  assert.equal((await ex.fetchBalance()).BTC.free, 2);
  const sell = await ex.createMarketOrder('BTC/USDT', 'sell', 2, 'sell-1');
  assert.equal(sell.status, 'FILLED');
  assert.equal((await ex.fetchBalance()).USDT.free, 1000);
  assert.equal((await ex.fetchBalance()).BTC.free, 0);
});

test('offline simulation: bilinmeyen market sonucu ikinci emir göndermez', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.setFailure({ kind: 'market', unknownOutcome: true, httpStatus: 500, message: 'simulated 5xx' });
  const state = store.defaultState();
  const om = new (require('../src/orderManager').OrderManager)({ exchange: ex, state, store: makeStore() });
  const first = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'dup-1' });
  assert.equal(first.status, 'UNKNOWN');
  ex.setFailure(null);
  const second = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'dup-1' });
  assert.equal(second.reused, true);
  assert.equal(second.status, 'UNKNOWN');
});

test('LiveEngine: başarılı mutabakat sonrası tick erken dönmez', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.running = true;
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true });
  let processed = 0;
  engine.processPair = async () => { processed++; };
  engine._checkRiskGate = async () => {};
  await engine.tick();
  assert.equal(state.liveReconciliation.safeToTrade, true);
  assert.equal(processed, Object.keys(state.pairs).length);
});

test('LiveEngine: kısmi satış sonrası kalan miktar yeniden stop ile korunur', async () => {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.pairs['BTC/USDT'].params.stopLossPct = 5;
  state.live.positions['BTC/USDT'] = {
    symbol:'BTC/USDT', quantity:2, entryPrice:100, stopOrderId:'old-stop', entryOrderId:'entry-1'
  };
  const st = makeStore();
  let stopCount = 0;
  const om = {
    async cancel() { return { status:'CANCELED' }; },
    async submitMarket() { return { status:'FILLED', executedQty:1, clientOrderId:'sell-1' }; },
    async submitStop(args) { stopCount++; return { status:'NEW', clientOrderId:'new-stop', ...args }; }
  };
  const ex = new SimulatedExchange({ startingQuote:1000, prices:{'BTC/USDT':100} });
  const engine = new LiveEngine({ exchange:ex, state, store:st, allowLive:true, orderManager:om });
  await engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 100, 'test', engine.epoch);
  assert.equal(state.live.positions['BTC/USDT'].quantity, 1);
  assert.equal(state.live.positions['BTC/USDT'].stopOrderId, 'new-stop');
  assert.equal(stopCount, 1);
  assert.equal(state.live.safeToTrade, false);
});
