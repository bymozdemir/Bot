// Parite giris filtreleri (Freqtrade pairlist filtrelerinden esinlendi). Yalniz YENI ALIMI engeller.
// Yalnizca mum verisini kullanir (ticker sadece fiyat veriyor; spread filtresi bu nedenle yok).
// Varsayilan: kapali (settings.pairFilters.enabled=false).

const { atr } = require('./indicators');

const DEFAULTS = Object.freeze({
  enabled: false,
  minCandles: 100,           // yas filtresi: en az bu kadar kapanmis mum
  minQuoteVolume24h: 0,      // son 24 saat yaklasik quote hacmi (0 = kapali)
  minAtrPct: 0,              // ATR/fiyat % alt siniri (0 = kapali): olu pariteleri eler
  maxAtrPct: 0,              // ATR/fiyat % ust siniri (0 = kapali): asiri oynak pariteleri eler
  atrPeriod: 14,
  maxRangePct: 0,            // son rangeBars mumdaki (en yuksek-en dusuk)/en dusuk % ust siniri (0 = kapali)
  rangeBars: 48
});

const n = (v, fb, min, max, integer = false) => {
  const x = Number(v);
  return Number.isFinite(x) && x >= min && x <= max && (!integer || Number.isInteger(x)) ? x : fb;
};

function normalizePairFilters(input) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const d = DEFAULTS;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    minCandles: n(s.minCandles, d.minCandles, 0, 5000, true),
    minQuoteVolume24h: n(s.minQuoteVolume24h, d.minQuoteVolume24h, 0, 1e15),
    minAtrPct: n(s.minAtrPct, d.minAtrPct, 0, 100),
    maxAtrPct: n(s.maxAtrPct, d.maxAtrPct, 0, 100),
    atrPeriod: n(s.atrPeriod, d.atrPeriod, 2, 200, true),
    maxRangePct: n(s.maxRangePct, d.maxRangePct, 0, 10000),
    rangeBars: n(s.rangeBars, d.rangeBars, 2, 5000, true)
  };
}

// closedCandles: kapanmis mumlar. timeframeMs: mum suresi (ms).
function checkPairFilters({ closedCandles, timeframeMs, config }) {
  const cfg = normalizePairFilters(config);
  if (!cfg.enabled) return { ok: true };
  const c = Array.isArray(closedCandles) ? closedCandles : [];
  if (c.length < cfg.minCandles) return { ok: false, rule: 'age', reason: `yeterli geçmiş yok (${c.length}/${cfg.minCandles} mum)` };
  const last = c[c.length - 1];
  const px = Number(last && last.c);
  if (!(px > 0)) return { ok: false, rule: 'data', reason: 'son mum fiyatı geçersiz' };

  if (cfg.minQuoteVolume24h > 0 && Number(timeframeMs) > 0) {
    const bars = Math.max(1, Math.round(86400000 / timeframeMs));
    let vol = 0;
    for (const k of c.slice(-bars)) vol += Number(k.c) * Number(k.v);
    if (!(vol >= cfg.minQuoteVolume24h)) return { ok: false, rule: 'volume', reason: `24s hacim ${Math.round(vol)} < ${cfg.minQuoteVolume24h}` };
  }
  if (cfg.minAtrPct > 0 || cfg.maxAtrPct > 0) {
    const a = atr(c, cfg.atrPeriod);
    const v = a[a.length - 1];
    if (v == null) return { ok: false, rule: 'volatility', reason: 'ATR hesaplanamadı' };
    const pct = (v / px) * 100;
    if (cfg.minAtrPct > 0 && pct < cfg.minAtrPct) return { ok: false, rule: 'volatility', reason: `ATR %${pct.toFixed(2)} < %${cfg.minAtrPct} (çok durgun)` };
    if (cfg.maxAtrPct > 0 && pct > cfg.maxAtrPct) return { ok: false, rule: 'volatility', reason: `ATR %${pct.toFixed(2)} > %${cfg.maxAtrPct} (çok oynak)` };
  }
  if (cfg.maxRangePct > 0) {
    const w = c.slice(-cfg.rangeBars);
    let hi = -Infinity, lo = Infinity;
    for (const k of w) { hi = Math.max(hi, k.h); lo = Math.min(lo, k.l); }
    const range = lo > 0 ? ((hi - lo) / lo) * 100 : Infinity;
    if (range > cfg.maxRangePct) return { ok: false, rule: 'rangeStability', reason: `${w.length} mum aralığı %${range.toFixed(1)} > %${cfg.maxRangePct}` };
  }
  return { ok: true };
}

module.exports = { DEFAULTS, normalizePairFilters, checkPairFilters };
