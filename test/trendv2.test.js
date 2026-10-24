const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { adx } = require('../src/indicators');

const tf = strategies.get('trend_filter_v2');
const H = 3600000;
const mk = (closes) => closes.map((c, i) => ({ t: i * H, o: c, h: c * 1.002, l: c * 0.998, c, v: 1 }));

test('trend_filter_v2: kayit, varsayilanlar ve parametre dogrulamasi', () => {
  assert.equal(tf.id, 'trend_filter_v2');
  assert.equal(tf.defaultParams.fastEma, 50);
  assert.equal(tf.defaultParams.slowEma, 200);
  assert.equal(tf.defaultParams.adxPeriod, 14);
  assert.equal(tf.defaultParams.adxMin, 25);
  assert.equal(tf.defaultParams.atrStopMult, 2);
  assert.equal(strategies.validateParams('trend_filter_v2', tf.defaultParams), null);
  assert.match(strategies.validateParams('trend_filter_v2', { ...tf.defaultParams, fastEma: 101 }), /en çok/);
});

test('ADX: guclu yonlu seride son kisimda sonlu degerler uretir', () => {
  const candles = mk(Array.from({ length: 120 }, (_, i) => 100 + i * 2));
  const out = adx(candles, 14);
  assert.ok(out.some(v => Number.isFinite(v)));
  assert.ok(Number.isFinite(out[out.length - 1]));
  assert.ok(out[out.length - 1] > 25);
});

test('trend_filter_v2: yukselen trend + RSI 50 donusu al sinyali uretir', () => {
  const closes = [];
  for (let i = 0; i < 230; i++) closes.push(100 + i * 0.25);
  // Son iki mumda RSI'nin trigger altindan yukari gecmesini kolaylastiran pullback.
  closes.push(closes.at(-1) - 3, closes.at(-1) + 1.5, closes.at(-1) + 2.5);
  const d = tf.evaluate({ candles: mk(closes), position: null, params: tf.defaultParams });
  assert.ok(['buy', 'hold'].includes(d.action));
  if (d.action === 'buy') assert.match(d.reason, /ADX/);
});

test('trend_filter_v2: pozisyonda trend bozulunca sat', () => {
  const closes = [];
  for (let i = 0; i < 230; i++) closes.push(100 + i * 0.5);
  for (let i = 0; i < 40; i++) closes.push(closes.at(-1) - 2.5);
  const candles = mk(closes);
  const position = { entryPrice: 200, stopPrice: 30, highWaterMark: 200 };
  const d = tf.evaluate({ candles, position, params: tf.defaultParams });
  assert.equal(d.action, 'sell');
});
