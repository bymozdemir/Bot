const test = require('node:test');
const assert = require('assert');
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');

test('redteam5: bozuk killSwitch truthy değer güvenlik kilidini bypass edemez', () => {
  for (const bad of ['x', 0, [], {}, { reason: 123 }, { t: new Date().toISOString() }]) {
    const state = store.defaultState();
    state.running = true;
    state.killSwitch = bad;
    state.paper.positions = {
      'BTC/USDT': {
        symbol: 'BTC/USDT', quantity: 1, entryPrice: 100,
        costQuote: 100, quoteAsset: 'USDT', highWaterMark: 100
      }
    };
    const engine = new PaperEngine({ exchange: { quoteAssets: ['USDT'] }, store: { save() {} }, state });
    engine.ensureState();
    assert.equal(state.running, false);
    assert.equal(typeof state.killSwitch, 'object');
    assert.equal(typeof state.killSwitch.reason, 'string');
  }
  const valid = store.defaultState();
  valid.running = true;
  valid.killSwitch = { t: new Date().toISOString(), reason: 'önceden kilitlenmiş' };
  const e = new PaperEngine({ exchange: { quoteAssets: ['USDT'] }, store: { save() {} }, state: valid });
  e.ensureState();
  assert.equal(valid.running, false);
  assert.equal(valid.killSwitch.reason, 'önceden kilitlenmiş');
});
