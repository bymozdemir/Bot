const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRiskExit } = require('../src/strategies/riskExit');
const { intrabarRiskExit } = require('../src/execution');

test('shared risk exit does not loosen a tighter strategy-specific stop', () => {
  const pos = { entryPrice: 100, stopPrice: 99, highWaterMark: 100, quantity: 1 };
  const result = checkRiskExit(pos, 98.5, { stopLossPct: 3, trailingStop: true, takeProfitPct: 0 });
  assert.equal(result?.action, 'sell');
  assert.equal(result?.price, 98.5);
});

test('intrabar risk exit honors a tighter initial stop even before trailing rises', () => {
  const pos = { entryPrice: 100, stopPrice: 99, highWaterMark: 100, quantity: 1 };
  const result = intrabarRiskExit(pos, { o: 100, h: 100.2, l: 98.5, c: 99 }, { stopLossPct: 3, trailingStop: true, takeProfitPct: 0 }, false);
  assert.equal(result?.ref, 99);
});
