const test = require('node:test');
const assert = require('node:assert/strict');
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');

function mk() {
  const state = store.defaultState();
  state.settings.mode = 'paper';
  state.settings.reserveCashPct = 0;
  state.settings.maxConcurrentPositions = 3;
  state.settings.dailyLossLimitPct = 100;
  state.settings.killSwitchLossPct = 0;
  state.settings.paperFeePct = 0;
  state.settings.paperSlippagePct = 0;
  const saved = [];
  const fakeStore = { save(s) { saved.push(JSON.parse(JSON.stringify(s))); } };
  const exchange = { id:'fake', name:'Fake', quoteAssets:['USDT'], fetchSymbolRules: async()=>({minNotional:1,stepSize:0,minQty:0}), fetchCandles: async()=>[] };
  const e = new PaperEngine({exchange, store:fakeStore, state, nowFn:()=>Date.parse('2026-10-08T10:00:00Z')});
  return {e,state,saved};
}

test('paper BUY commit diske RAM degisikliginden once yazilir', async () => {
  const {e,state,saved} = mk();
  const pair = state.pairs['BTC/USDT'];
  await e.tryBuy('BTC/USDT', pair, {reason:'durability'}, pair.params, 100, 1000, e.epoch);
  assert.equal(saved.length, 1);
  const durable = saved.at(-1);
  assert.ok(durable.paper.positions['BTC/USDT']);
  assert.equal(durable.paper.positions['BTC/USDT'].quantity, state.paper.positions['BTC/USDT'].quantity);
  assert.ok(durable.paper.cashByAsset.USDT < 150);
});

test('paper SELL commit diske RAM degisikliginden once yazilir', async () => {
  const {e,state,saved} = mk();
  const pair = state.pairs['BTC/USDT'];
  await e.tryBuy('BTC/USDT', pair, {reason:'durability'}, pair.params, 100, 1000, e.epoch);
  const pos = state.paper.positions['BTC/USDT'];
  e.sellAt('BTC/USDT', pos, 110, 'durability-sell');
  const durable = saved.at(-1);
  assert.equal(durable.paper.positions['BTC/USDT'], undefined);
  assert.equal(durable.paper.trades.length, 1);
  assert.equal(durable.paper.cashByAsset.USDT, 154.5);
});

test('risk equity acik pozisyonu komisyon/kayma ile kapatma maliyetini dikkate alir', () => {
  const {e,state} = mk();
  state.paper.cashByAsset.USDT = 0;
  state.paper.positions['BTC/USDT'] = {symbol:'BTC/USDT', quantity:1, entryPrice:100, costQuote:100, quoteAsset:'USDT', baseAsset:'BTC', highWaterMark:100, stopPrice:90};
  state.settings.paperFeePct = 1;
  state.settings.paperSlippagePct = 1;
  const eq = e.liquidationEquity({'BTC/USDT':100});
  assert.equal(eq, 98.01);
});

test('paper bozuk semantik state pozisyonu ve risk ayarini guvenli normalize eder', () => {
  const {e,state} = mk();
  state.settings.dailyLossLimitPct = NaN;
  state.settings.killSwitchLossPct = NaN;
  state.settings.maxConcurrentPositions = NaN;
  state.paper.positions['BTC/USDT'] = {symbol:'BTC/USDT', quantity:-5, entryPrice:0, costQuote:-1};
  state.paper.cashByAsset.USDT = -999;
  e.ensureState();
  assert.equal(state.settings.dailyLossLimitPct, 0);
  assert.equal(state.settings.killSwitchLossPct, 0);
  assert.equal(state.settings.maxConcurrentPositions, 3);
  assert.equal(state.paper.positions['BTC/USDT'], undefined);
  assert.equal(state.paper.cashByAsset.USDT, 0);
});


test('paper BUY komisyonu gerçekleşen notional üzerinden hesaplar ve toplam harcama bütçeyi aşmaz', async () => {
  const {e,state} = mk();
  state.settings.paperFeePct = 1;
  state.settings.paperSlippagePct = 0;
  state.settings.reserveCashPct = 0;
  const pair = state.pairs['BTC/USDT'];
  await e.tryBuy('BTC/USDT', pair, {reason:'fee-accounting'}, pair.params, 100, 1000, e.epoch);
  const pos = state.paper.positions['BTC/USDT'];
  const notional = pos.quantity * pos.entryPrice;
  const expectedFee = notional * 0.01;
  assert.ok(Math.abs(pos.costQuote - (notional + expectedFee)) < 1e-9);
  assert.ok(Math.abs(state.paper.costs.fees - expectedFee) < 1e-9);
  assert.ok(pos.costQuote <= 150 + 1e-9);
  assert.ok(Math.abs(state.paper.cashByAsset.USDT + pos.costQuote - 150) < 1e-9);
});
