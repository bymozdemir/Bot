const test = require('node:test');
const assert = require('node:assert/strict');
const { mapWithConcurrency } = require('../src/util/concurrency');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('bounded concurrency never exceeds the configured worker count and preserves result order', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency([40, 10, 20, 5, 15], 2, async (ms, index) => {
    active++; maxActive = Math.max(maxActive, active);
    await delay(ms);
    active--;
    return index * 10;
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(results, [0, 10, 20, 30, 40]);
});

test('bounded concurrency waits for in-flight work to settle before rejecting', async () => {
  let completed = 0;
  await assert.rejects(() => mapWithConcurrency([0, 1, 2], 2, async (n) => {
    await delay(n === 0 ? 5 : 20);
    completed++;
    if (n === 0) throw new Error('expected failure');
    return n;
  }), /expected failure/);
  assert.equal(completed, 2);
});

test('bounded concurrency validates its inputs', async () => {
  await assert.rejects(() => mapWithConcurrency([], 0, async () => {}), /positive integer/);
  await assert.rejects(() => mapWithConcurrency({}, 1, async () => {}), /array/);
});
