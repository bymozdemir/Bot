// Forager (Passivbot forager.md fikrinden): sinirli pozisyon slotlarini HANGI paritelerin dolduracagini sirala.
// 1) Dusuk hacimli adaylari buda (yalniz YENI ALIMI engeller), 2) kalanlari agirlikli skorla sirala.
// Motor, bu sirayla parite isler: yuksek skorlu parite, slot sinirina takilmadan once alim yapma hakkini alir.
// Mum ZAMAN DILIMI parite basina farkli olabilir; EMA acisi mum cinsindendir. Varsayilan: kapali.

const { directionality } = require('./indicators');

const DEFAULTS = Object.freeze({
  enabled: false,
  volumeDropPct: 0,                 // en dusuk hacimli bu % aday yeni alimdan elenir (0 = budama yok)
  spanBars: 20,                     // hacim/oynaklik/yonluluk EMA acisi (mum)
  weights: { volume: 1, volatility: 1, unilateralness: 0 }
});

const nn = (v, fb, min, max) => { const x = Number(v); return Number.isFinite(x) && x >= min && x <= max ? x : fb; };

function normalizeForager(input) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const w = s.weights && typeof s.weights === 'object' && !Array.isArray(s.weights) ? s.weights : {};
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULTS.enabled,
    volumeDropPct: nn(s.volumeDropPct, DEFAULTS.volumeDropPct, 0, 90),
    spanBars: nn(s.spanBars, DEFAULTS.spanBars, 2, 500),
    weights: {
      volume: nn(w.volume, DEFAULTS.weights.volume, 0, 100),
      volatility: nn(w.volatility, DEFAULTS.weights.volatility, 0, 100),
      unilateralness: nn(w.unilateralness, DEFAULTS.weights.unilateralness, 0, 100)
    }
  };
}

function emaLast(values, span) {
  const a = 2 / (span + 1);
  let e = null;
  for (const v of values) { if (!Number.isFinite(v)) continue; e = e === null ? v : e + a * (v - e); }
  return e;
}

function features(candles, span) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const tail = candles.slice(-Math.ceil(span * 5) - 1);
  const vol = emaLast(tail.map((c) => Number(c.c) * Number(c.v)), span);
  const rng = emaLast(tail.map((c) => (c.l > 0 && c.h >= c.l ? Math.log(c.h / c.l) : NaN)), span);
  const dir = directionality(candles.map((c) => Number(c.c)), span);
  if (vol === null || rng === null) return null;
  return { volume: vol, volatility: rng, unilateralness: dir === null ? null : Math.abs(dir) };
}

function norm(map, key, higherBetter) {
  const vals = [...map.values()].map((f) => f[key]).filter((x) => Number.isFinite(x));
  if (!vals.length) return () => 0;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  return (x) => {
    if (!Number.isFinite(x)) return 0;
    if (hi === lo) return 0.5;
    const z = (x - lo) / (hi - lo);
    return higherBetter ? z : 1 - z;
  };
}

// candidates: [{ symbol, candles }]. Donus: { order: [symbol...] (iyiden kotuye), pruned: Set, scores: Map }
function rankCandidates(candidates, config) {
  const cfg = normalizeForager(config);
  const scores = new Map(), pruned = new Set();
  if (!cfg.enabled) return { order: candidates.map((c) => c.symbol), pruned, scores };
  const feats = new Map();
  for (const c of candidates) { const f = features(c.candles, cfg.spanBars); if (f) feats.set(c.symbol, f); }

  if (cfg.volumeDropPct > 0 && feats.size >= 2) {
    const byVol = [...feats.entries()].sort((a, b) => a[1].volume - b[1].volume);
    const drop = Math.floor((byVol.length * cfg.volumeDropPct) / 100);
    for (let i = 0; i < drop; i++) pruned.add(byVol[i][0]);
  }
  const survivors = new Map([...feats].filter(([s]) => !pruned.has(s)));
  const nVol = norm(survivors, 'volume', true), nVola = norm(survivors, 'volatility', true), nUni = norm(survivors, 'unilateralness', false);
  const w = cfg.weights;
  for (const [sym, f] of survivors) {
    scores.set(sym, w.volume * nVol(f.volume) + w.volatility * nVola(f.volatility) + w.unilateralness * nUni(f.unilateralness));
  }
  const rank = (s) => (scores.has(s) ? scores.get(s) : -Infinity); // verisi/ozelligi olmayan sona
  const order = candidates.map((c) => c.symbol).sort((a, b) => rank(b) - rank(a));
  return { order, pruned, scores };
}

module.exports = { DEFAULTS, normalizeForager, rankCandidates, features };
