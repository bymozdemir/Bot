const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { supertrend } = require('../src/indicators');

const H = 3600000;
const mk = (closes, vol = 1) => closes.map((c, i) => ({ t: i * H, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c) * 1.002, l: Math.min(c, i ? closes[i - 1] : c) * 0.998, c, v: typeof vol === 'function' ? vol(i) : vol }));

test('supertrend gostergesi: yukselen seri yukari, dusen seri asagi yon', () => {
  const up = mk(Array.from({ length: 80 }, (_, i) => 100 + i));
  const dn = mk(Array.from({ length: 80 }, (_, i) => 200 - i));
  assert.equal(supertrend(up, 10, 3).dir.at(-1), 1);
  assert.equal(supertrend(dn, 10, 3).dir.at(-1), -1);
  assert.equal(supertrend(up.slice(0, 5), 10, 3).dir.at(-1), null);
});

test('supertrend stratejisi: dusus sonrasi yukari donuste alim, geri donuste satim', () => {
  const s = strategies.get('supertrend');
  const p = { ...s.defaultParams };
  const closes = [...Array.from({ length: 60 }, (_, i) => 200 - i), ...Array.from({ length: 40 }, (_, i) => 140 + i * 2.5)];
  let buyAt = -1;
  for (let i = 40; i <= closes.length; i++) {
    const d = s.evaluate({ candles: mk(closes.slice(0, i)), position: null, params: p });
    if (d.action === 'buy') { buyAt = i; break; }
  }
  assert.ok(buyAt > 60, `donus sonrasi alim bekleniyordu, i=${buyAt}`);
  const pos = { entryPrice: 150, quantity: 1, highWaterMark: 150, stopPrice: null };
  const down = [...closes, ...Array.from({ length: 30 }, (_, i) => 240 - i * 6)];
  let sold = false;
  for (let i = closes.length; i <= down.length; i++) {
    const d = s.evaluate({ candles: mk(down.slice(0, i)), position: { ...pos }, params: p });
    if (d.action === 'sell') { sold = true; break; }
  }
  assert.ok(sold);
});

test('dip_analyser: asiri satim + yesil donus + hacim -> alim; hacim yoksa veya cokus varsa hayir', () => {
  const s = strategies.get('dip_analyser');
  const p = { ...s.defaultParams, maxBelowSmaPct: 0 };
  const base = Array.from({ length: 230 }, () => 100);
  const fall = Array.from({ length: 12 }, (_, i) => 100 - (i + 1) * 1.4);
  const closes = [...base, ...fall, fall.at(-1) + 1.5];
  const spike = (i) => (i === closes.length - 1 ? 10 : 1);
  const c = mk(closes, spike);
  assert.equal(s.evaluate({ candles: c, position: null, params: p }).action, 'buy');
  assert.equal(s.evaluate({ candles: mk(closes, 1), position: null, params: p }).action, 'hold'); // hacim patlamasi yok
  assert.equal(s.evaluate({ candles: c, position: null, params: { ...p, maxBelowSmaPct: 1 } }).action, 'hold'); // cokus korumasi
  assert.equal(s.validate({ ...p, rsiOversold: 60, rsiExit: 50 }) !== null, true);
});

test('dip_analyser: acik pozisyonda stop her zaman once calisir, RSI toparlaninca satar', () => {
  const s = strategies.get('dip_analyser');
  const closes = Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 3) * 8);
  const pos = { entryPrice: 200, quantity: 1, highWaterMark: 200, stopPrice: 190 };
  const d = s.evaluate({ candles: mk(closes), position: pos, params: s.defaultParams });
  assert.equal(d.action, 'sell'); // fiyat girisin cok altinda -> stop-loss
  assert.equal(s.evaluate({ candles: mk(closes.slice(0, 10)), position: null, params: s.defaultParams }).action, 'hold'); // yetersiz veri
});

test('yeni stratejiler kayitli ve semalari tam', () => {
  for (const id of ['supertrend', 'dip_analyser']) {
    const s = strategies.get(id);
    for (const f of s.paramsSchema) assert.ok(f.key in s.defaultParams, `${id}.${f.key} varsayilanda yok`);
    assert.equal(strategies.validateParams(id, { ...s.defaultParams }), null);
  }
});
