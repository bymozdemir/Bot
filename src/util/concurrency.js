'use strict';

/**
 * Run async work with a fixed upper bound on in-flight tasks. Results retain
 * input order even when tasks complete out of order. On failure, wait for all
 * already-started work to settle before rejecting so callers do not continue
 * a tick while background workers are still mutating its state.
 */
async function mapWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');
  const limit = Number(concurrency);
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('concurrency must be a positive integer');
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError;
  let hasError = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      if (hasError) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!hasError) { firstError = error; hasError = true; }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (hasError) throw firstError;
  return results;
}

module.exports = { mapWithConcurrency };
