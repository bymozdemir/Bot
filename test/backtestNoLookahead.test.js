'use strict';
// İleriye bakma (look-ahead) denetimi. Simülatörün stratejiye verdiği pencere İZLENİR:
//  * i. adımdaki pencerenin son mumu tam olarak i. mum olmalı (i+1. mumu görmemeli),
//  * pencerede gelecekteki zaman damgası olmamalı,
//  * sinyalle açılan işlem, sinyal mumunun DEĞİL bir sonraki mumun AÇILIŞINDA (kayma ile) dolmalı.
// (Eski kırpma yöntemi tek mumluk ileriye bakmayı yakalayamıyordu: bilerek eklenen hata testi geçiyordu.)
const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { runBacktest } = require('../src/backtest/simulator');

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function series(seed, n) {
  const r = rng(seed); const H = 3600000; const t0 = Date.UTC(2025, 0, 1);
  let price = 100; let drift = 0; const out = [];
  for (let i = 0; i < n; i++) {
    if (i % 120 === 0) drift = (r() - 0.5) * 0.004;
    const vol = 0.004 + r() * 0.012;
    const o = price; const c = Math.max(0.01, o * (1 + drift + (r() - 0.5) * 2 * vol));
    out.push({ t: t0 + i * H, o, h: Math.max(o, c) * (1 + r() * vol), l: Math.min(o, c) * (1 - r() * vol), c, v: 100 + r() * 50 });
    price = c;
  }
  return out;
}

for (const id of Object.keys(strategies.registry)) {
  test(`look-ahead yok: ${id} her adımda yalnızca o muma kadarki pencereyi görür`, () => {
    const real = strategies.get(id);
    const candles = series(7, 800);
    const startIndex = 100;
    const seen = [];
    const spy = new Proxy(real, { get(target, prop) { if (prop === 'evaluate') return (arg) => { seen.push(arg.candles.map((c) => c.t)); return target.evaluate(arg); }; return target[prop]; } });
    const res = runBacktest({ candles, startIndex, strategy: spy });
    assert.ok(seen.length >= candles.length - startIndex - 2, `${id}: strateji yeterince çağrılmadı (${seen.length})`);
    seen.forEach((ts, j) => {
      const expectedLast = candles[startIndex + j].t;
      assert.equal(ts[ts.length - 1], expectedLast, `${id}: adım ${j} penceresinin son mumu ${ts[ts.length - 1]}, beklenen ${expectedLast} (ileriye bakma!)`);
      assert.ok(ts.every((t) => t <= expectedLast), `${id}: pencerede gelecekten mum var`);
      assert.ok(ts.every((t, k) => k === 0 || t > ts[k - 1]), `${id}: pencere zaman sırasında değil`);
    });
    // doldurma: her (zorunlu kapanış olmayan) giriş, bir mumun AÇILIŞINDA ve alım kaymasıyla gerçekleşmeli
    const byT = new Map(candles.map((c) => [c.t, c]));
    for (const t of res.tradeList) {
      const open = byT.get(t.openedAt)?.o;
      assert.ok(open > 0, `${id}: giriş zamanı bir mum açılışı değil`);
      assert.ok(Math.abs(t.entryPrice - open * 1.0005) < open * 1e-9, `${id}: giriş fiyatı ${t.entryPrice}, açılış*kayma ${open * 1.0005} olmalı`);
    }
  });
}
