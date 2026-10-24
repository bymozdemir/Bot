const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { directionality } = require('../src/indicators');
const { rankCandidates, normalizeForager } = require('../src/forager');
const { checkProtections } = require('../src/protections');
const { entryBlock } = require('../src/entryExtras');
const { flat, makeEngine, store } = require('./helpers');

const H = 3600000;
const mk = (vol, rng, n = 60) => Array.from({ length: n }, (_, i) => ({ t: i * H, o: 100, h: 100 + rng, l: 100 - rng, c: 100 + (i % 2 ? 0.1 : -0.1), v: vol }));

test('directionality: surekli yukari +, surekli asagi -, iki yonlu ~0, bozuk veri null', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.01, i));
  const dn = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(0.99, i));
  const zz = Array.from({ length: 80 }, (_, i) => (i % 2 ? 101 : 100));
  assert.ok(directionality(up, 20) > 0.9);
  assert.ok(directionality(dn, 20) < -0.9);
  assert.ok(Math.abs(directionality(zz, 20)) < 0.2);
  assert.equal(directionality(Array(50).fill(100), 20), 0);
  assert.equal(directionality([100, -1, 100], 20), null);
  assert.equal(directionality([1, 2], 20), null);
});

test('forager kapaliyken sira degismez ve budama yok', () => {
  const r = rankCandidates([{ symbol: 'A', candles: mk(1, 1) }, { symbol: 'B', candles: mk(100, 2) }], { enabled: false });
  assert.deepEqual(r.order, ['A', 'B']);
  assert.equal(r.pruned.size, 0);
});

test('forager: hacim+oynaklik skoru siralar, en dusuk hacimli yuzde budanir, verisiz aday sona', () => {
  const r = rankCandidates([
    { symbol: 'A', candles: mk(1, 1) }, { symbol: 'B', candles: mk(100, 2) },
    { symbol: 'C', candles: mk(10, 1.5) }, { symbol: 'D', candles: mk(0.5, 0.2) }, { symbol: 'E', candles: [] }
  ], { enabled: true, volumeDropPct: 25 });
  assert.equal(r.order[0], 'B');
  assert.equal(r.order.at(-1) === 'E' || r.order.at(-1) === 'D', true);
  assert.deepEqual([...r.pruned], ['D']);
  assert.equal(r.order.indexOf('E') > r.order.indexOf('C'), true);
});

test('forager: yonluluk agirligi tek yonlu trendi geriye iter', () => {
  const trend = Array.from({ length: 60 }, (_, i) => { const c = 100 * Math.pow(1.01, i); return { t: i * H, o: c, h: c * 1.001, l: c * 0.999, c, v: 10 }; });
  const choppy = mk(10, 0.1);
  const r = rankCandidates([{ symbol: 'TREND', candles: trend }, { symbol: 'CHOP', candles: choppy }], { enabled: true, weights: { volume: 0, volatility: 0, unilateralness: 1 } });
  assert.deepEqual(r.order, ['CHOP', 'TREND']);
});

test('normalizeForager: bozuk girdi varsayilana duser', () => {
  const n = normalizeForager({ enabled: 1, volumeDropPct: 500, spanBars: 'x', weights: { volume: -1 } });
  assert.equal(n.enabled, false); assert.equal(n.volumeDropPct, 0); assert.equal(n.spanBars, 20); assert.equal(n.weights.volume, 1);
});

test('adaptif cooldown: dusus yonlulugu bekleme suresini uzatir, ust sinirla kisitlanir', () => {
  const NOW = Date.parse('2026-10-24T12:00:00Z');
  const trades = [{ symbol: 'BTC/USDT', pnl: 1, pnlPct: 1, reason: 'sinyal', closedAt: new Date(NOW - 70 * 60000).toISOString() }];
  const cfg = { enabled: true, cooldown: { enabled: true, minutes: 60, adverseMinutes: 120, maxMinutes: 150 }, stoplossGuard: { enabled: false }, maxDrawdown: { enabled: false } };
  assert.equal(checkProtections({ trades, symbol: 'BTC/USDT', now: NOW, config: cfg, adverseScore: 0 }).blocked, false); // 70 dk > 60
  const r = checkProtections({ trades, symbol: 'BTC/USDT', now: NOW, config: cfg, adverseScore: 1 });
  assert.equal(r.blocked, true);
  assert.equal(r.until, NOW - 70 * 60000 + 150 * 60000); // 60+120=180 -> maxMinutes 150
  assert.match(r.reason, /düşüş yönlülüğü/);
});

test('entryBlock: dusen trendde adaptif cooldown devreye girer, yukselende girmez; forager budamasi engeller', () => {
  const now = Date.now();
  const down = Array.from({ length: 80 }, (_, i) => { const c = 100 * Math.pow(0.99, i); return { t: i * H, o: c, h: c, l: c, c, v: 1 }; });
  const up = Array.from({ length: 80 }, (_, i) => { const c = 100 * Math.pow(1.01, i); return { t: i * H, o: c, h: c, l: c, c, v: 1 }; });
  const settings = { protections: { enabled: true, cooldown: { enabled: true, minutes: 10, adverseMinutes: 600 }, stoplossGuard: { enabled: false }, maxDrawdown: { enabled: false } }, forager: { enabled: true, volumeDropPct: 20 } };
  const trades = [{ symbol: 'X/USDT', pnl: 1, pnlPct: 1, reason: 'sinyal', closedAt: new Date(now - 60 * 60000).toISOString() }];
  assert.ok(entryBlock({ settings, trades, symbol: 'X/USDT', now, closedCandles: down, timeframeMs: H }));
  assert.equal(entryBlock({ settings, trades, symbol: 'X/USDT', now, closedCandles: up, timeframeMs: H }), null);
  assert.match(entryBlock({ settings, trades: [], symbol: 'Y/USDT', now, closedCandles: up, timeframeMs: H, foragerPruned: new Set(['Y/USDT']) }).reason, /forager/);
});

function withStrategy(id, evaluate, fn) {
  const reg = strategies.registry; const orig = reg[id];
  reg[id] = { ...orig, evaluate };
  return Promise.resolve(fn()).finally(() => { reg[id] = orig; });
}
const liveSeries = (vol) => flat(300, 100).map((c) => ({ ...c, t: c.t - H, v: vol, h: 101, l: 99 })).concat([{ t: Date.now(), o: 100, h: 100, l: 100, c: 100, v: vol }]);

async function runTwoPairs(foragerEnabled) {
  const state = store.defaultState();
  state.running = true;
  const base = Object.values(state.pairs)[0];
  state.pairs = { 'AAA/USDT': { ...base, symbol: 'AAA/USDT', enabled: true }, 'BBB/USDT': { ...base, symbol: 'BBB/USDT', enabled: true } };
  state.settings.maxConcurrentPositions = 1;
  state.settings.forager = { enabled: foragerEnabled, weights: { volume: 1, volatility: 0, unilateralness: 0 } };
  const ex = { quoteAssets: ['USDT'], fetchCandles: async (sym) => liveSeries(sym.startsWith('BBB') ? 1000 : 1), fetchSymbolRules: async () => ({ minNotional: 10 }) };
  const { engine } = makeEngine({ state, exchange: ex });
  await withStrategy(base.strategyId, () => ({ action: 'buy', reason: 't', price: 100 }), () => engine.tick());
  return Object.keys(state.paper.positions);
}

test('paper motor: tek slotta forager yuksek hacimli pariteye oncelik verir; kapaliyken girdi sirasi', async () => {
  assert.deepEqual(await runTwoPairs(false), ['AAA/USDT']);
  assert.deepEqual(await runTwoPairs(true), ['BBB/USDT']);
});
