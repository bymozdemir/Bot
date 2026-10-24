const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('varsayılan durum paper modunda başlar ve shadow alanı içermez', () => {
  const s = store.defaultState();
  assert.equal(s.settings.mode, 'paper');
  assert.equal(s.shadow, undefined);
  assert.deepEqual(s.paper.positions, {});
});
