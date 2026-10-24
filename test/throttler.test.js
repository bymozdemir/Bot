const test = require('node:test');
const assert = require('node:assert/strict');
const { WeightedThrottler, ThrottleError, weightFor } = require('../src/util/throttler');

function fakeClock() {
  let t = 1000;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test('butce icindeki istekler beklemeden gecer', async () => {
  const c = fakeClock();
  const th = new WeightedThrottler({ maxWeight: 10, intervalMs: 1000, nowFn: c.now, sleepFn: c.sleep });
  for (let i = 0; i < 5; i++) await th.acquire(2);
  assert.equal(th.used(), 10);
  assert.equal(th.stats.waited, 0);
});

test('butce dolunca pencere kayana kadar bekler (sahte saatle)', async () => {
  const c = fakeClock();
  const th = new WeightedThrottler({ maxWeight: 4, intervalMs: 1000, nowFn: c.now, sleepFn: c.sleep });
  await th.acquire(2); c.advance(100); await th.acquire(2);
  const before = c.now();
  await th.acquire(2); // ilk girdinin dusmesini bekler (~900 ms)
  assert.ok(c.now() - before >= 900 && c.now() - before <= 1000, `beklenen ~900ms, gecen ${c.now() - before}`);
  assert.equal(th.stats.waited, 1);
});

test('maxWaitMs asilirsa THROTTLE_WAIT hatasi, butce tuketilmez', async () => {
  const c = fakeClock();
  const th = new WeightedThrottler({ maxWeight: 2, intervalMs: 60000, nowFn: c.now, sleepFn: c.sleep });
  await th.acquire(2);
  await assert.rejects(() => th.acquire(2, { maxWaitMs: 1000 }), (e) => e instanceof ThrottleError && e.code === 'THROTTLE_WAIT' && e.retryAfterMs > 1000);
  assert.equal(th.used(), 2);
});

test('butceden agir istek ve gecersiz agirlik aninda reddedilir', async () => {
  const th = new WeightedThrottler({ maxWeight: 5, intervalMs: 1000 });
  await assert.rejects(() => th.acquire(6), { code: 'THROTTLE_TOO_HEAVY' });
  await assert.rejects(() => th.acquire(0), { code: 'THROTTLE_BAD_WEIGHT' });
  assert.throws(() => new WeightedThrottler({ maxWeight: 0 }));
});

test('esanli istekler FIFO sirasiyla servis edilir', async () => {
  const c = fakeClock();
  const th = new WeightedThrottler({ maxWeight: 2, intervalMs: 1000, nowFn: c.now, sleepFn: c.sleep });
  const order = [];
  await Promise.all([1, 2, 3, 4].map((n) => th.acquire(2).then(() => order.push(n))));
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('weightFor: bilinen uc noktalar ve varsayilan', () => {
  assert.equal(weightFor('/api/v3/klines'), 2);
  assert.equal(weightFor('/api/v3/depth'), 5);
  assert.equal(weightFor('/api/v3/bilinmeyen'), 2);
});
