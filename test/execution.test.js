const test = require('node:test');
const assert = require('node:assert/strict');
const { buyFill, sellFill, intrabarRiskExit, roundDownToStep, splitCandles } = require('../src/execution');

const H = 3600000;
const C = (i, o, h, l, c) => ({ t: i * H, o, h, l, c, v: 1 });
const pos = (over = {}) => ({ entryPrice: 100, stopPrice: 97, highWaterMark: 100, ...over });

test('kayma: alimda yukari, satimda asagi', () => {
  assert.equal(buyFill(100, 0.05), 100.05);
  assert.equal(sellFill(100, 0.05), 99.95);
  assert.equal(buyFill(100, 0), 100);
});

test('roundDownToStep: adima asagi yuvarlar, kayan nokta hatasi yapmaz', () => {
  assert.equal(roundDownToStep(0.123456, 0.001), 0.123);
  assert.equal(roundDownToStep(1.999, 1), 1);
  assert.equal(roundDownToStep(0.3, 0.1), 0.3); // 0.3/0.1 = 2.9999999999999996 tuzagi
  assert.equal(roundDownToStep(0.29999999995, 0.1), 0.2); // tolerans bütçeyi aşan miktar üretmemeli
  assert.equal(roundDownToStep(-1, 0.1), 0);
  assert.equal(roundDownToStep(12.3456789, 0.00000001), 12.3456789);
  assert.equal(roundDownToStep(5.5, 0), 5.5); // adim yoksa dokunma
  assert.equal(roundDownToStep(5.5, undefined), 5.5);
  assert.equal(roundDownToStep(0.0004, 0.001), 0);
});

test('intrabarRiskExit: commit=false zirveyi degistirmez, commit=true gunceller', () => {
  const params = { stopLossPct: 3, takeProfitPct: 50, trailingStop: true };
  const p = pos();
  assert.equal(intrabarRiskExit(p, C(1, 100, 110, 105, 108), params, false), null);
  assert.equal(p.highWaterMark, 100);
  assert.equal(intrabarRiskExit(p, C(1, 100, 110, 108, 109), params, true), null);
  assert.equal(p.highWaterMark, 110);
  assert.equal(p.highWaterMark, 110);
});

test('intrabarRiskExit: stop, bosluk, take-profit, ayni mumda stop oncelikli', () => {
  const params = { stopLossPct: 3, takeProfitPct: 6, trailingStop: false };
  assert.deepEqual(intrabarRiskExit(pos(), C(1, 100, 101, 96, 98), params), { ref: 97, reason: 'stop-loss' });
  assert.deepEqual(intrabarRiskExit(pos(), C(1, 90, 91, 88, 89), params), { ref: 90, reason: 'stop-loss' });
  const locked = pos();
  assert.deepEqual(intrabarRiskExit(locked, C(1, 100, 110, 107, 109), params), null);
  assert.ok(Math.abs(locked.highWaterMark - 110) < 1e-9);
  assert.deepEqual(intrabarRiskExit(locked, C(2, 109, 109, 107, 108), params), null);
  assert.deepEqual(intrabarRiskExit(locked, C(3, 108, 108, 106.5, 106.5), params), { ref: 106.7, reason: 'profit-protection stop' });
  assert.equal(intrabarRiskExit(pos(), C(1, 100, 110, 95, 100), params).reason, 'stop-loss');
  assert.equal(intrabarRiskExit(pos(), C(1, 100, 101, 99, 100), params), null);
});

test('intrabarRiskExit: stopPrice null/eksik parametre cokmez', () => {
  assert.equal(intrabarRiskExit(pos({ stopPrice: null }), C(1, 100, 101, 50, 60), { trailingStop: false }), null);
  assert.equal(intrabarRiskExit(pos({ highWaterMark: undefined }), C(1, 100, 101, 99, 100), { stopLossPct: 3, trailingStop: true }), null);
});

test('splitCandles: olusan mumu ayirir', () => {
  const cs = [C(0, 1, 1, 1, 1), C(1, 1, 1, 1, 1), C(2, 1, 1, 1, 1)];
  const a = splitCandles(cs, 2 * H + 30000); // 3. mum henuz kapanmadi
  assert.equal(a.closed.length, 2);
  assert.equal(a.forming.t, 2 * H);
  assert.equal(a.step, H);
  const b = splitCandles(cs, 3 * H + 1); // hepsi kapali
  assert.equal(b.closed.length, 3);
  assert.equal(b.forming, null);
});

test('splitCandles: veri boslugu ve farkli aralik (gunluk mum) dogru calisir', () => {
  const cs = [C(0, 1, 1, 1, 1), C(1, 1, 1, 1, 1), C(2, 1, 1, 1, 1), C(4, 1, 1, 1, 1), C(5, 1, 1, 1, 1)]; // 3. mum eksik
  assert.equal(splitCandles(cs, 5 * H + 10).step, H); // medyan boslugu yutar
  const daily = [0, 1, 2, 3].map((i) => ({ t: i * 24 * H, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const r = splitCandles(daily, 3 * 24 * H + 5 * H); // 4. gunluk mum 5 saattir aciyor
  assert.equal(r.forming.t, 3 * 24 * H);
  assert.equal(r.closed.length, 3);
});

test('splitCandles: tek mum / bos liste cokmez', () => {
  assert.equal(splitCandles([C(0, 1, 1, 1, 1)], 1).forming, null);
  assert.deepEqual(splitCandles([], 1).closed, []);
});


test('intrabarRiskExit: trailing stop ayni mumdaki yeni zirveyi muhafazakar sekilde kullanir', () => {
  const params = { stopLossPct: 3, takeProfitPct: 50, trailingStop: true };
  const p = pos();
  const hit = intrabarRiskExit(p, C(1, 100, 110, 105, 106), params, true);
  assert.equal(p.highWaterMark, 110);
  assert.equal(hit, null);
  assert.equal(p.highWaterMark, 110);
});


test('intrabar trailing, TP aktivasyonu olmadan %0.20 basamakta başabaşa kilitlenmez', () => {
  const p = pos({ highWaterMark: 100 });
  const params = { stopLossPct: 4, takeProfitPct: 5, trailingStop: true };
  assert.equal(intrabarRiskExit(p, C(1,100,100.21,100.15,100.20), params), null);
  assert.equal(p.highWaterMark, 100.21);
  assert.ok(Math.abs(p.highWaterMark * 0.96 - 96.2016) < 1e-9);
});

test('intrabar kâr koruma TP sonrası başabaş altına düşmez', () => {
  const p = pos();
  const params = { stopLossPct: 8, takeProfitPct: 5, trailingStop: false };
  assert.equal(intrabarRiskExit(p, C(1,100,105,100.3,104), params), null);
  assert.equal(p.highWaterMark, 105);
  assert.deepEqual(intrabarRiskExit(p, C(2,104,104,100.2,101), params), { ref: 100.2, reason: 'profit-protection stop' });
});
