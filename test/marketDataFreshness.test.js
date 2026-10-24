const test = require('node:test');
const assert = require('node:assert/strict');
const { splitCandles } = require('../src/execution');

const H = 60 * 60 * 1000;
const candle = (t, c = 100) => ({ t, o: c, h: c, l: c, c, v: 1 });

test('splitCandles uses configured timeframe when recent candles contain a gap', () => {
  const now = 10 * H + 30 * 60 * 1000;
  // 08:00 candle is missing. The 09:00 candle is closed at 10:30.
  // Inferring interval from [1h, 2h] can choose 2h and misclassify it as forming.
  const candles = [candle(6 * H), candle(7 * H), candle(9 * H)];
  const result = splitCandles(candles, now, '1h');

  assert.equal(result.step, H);
  assert.equal(result.forming, null);
  assert.equal(result.closed.length, 3);
});

test('splitCandles still identifies the current candle with explicit timeframe', () => {
  const now = 10 * H + 30 * 60 * 1000;
  const candles = [candle(8 * H), candle(9 * H), candle(10 * H)];
  const result = splitCandles(candles, now, '1h');

  assert.equal(result.step, H);
  assert.equal(result.forming.t, 10 * H);
  assert.equal(result.closed.length, 2);
});

test('splitCandles keeps backward-compatible interval inference when timeframe is omitted', () => {
  const now = 10 * H + 30 * 60 * 1000;
  const candles = [candle(8 * H), candle(9 * H), candle(10 * H)];
  const result = splitCandles(candles, now);

  assert.equal(result.forming.t, 10 * H);
  assert.equal(result.closed.length, 2);
});
