// src/strategies/regimeBase.js  (strateji DEGIL; regime_* stratejilerinin ortak yardimcilari)
const { sma, atr } = require('../indicators');

const BASE_PARAMS = { period: 200, regimePeriod: 900, bufferPct: 1, stopLossPct: 8, takeProfitPct: 0, trailingStop: false };

const BASE_SCHEMA = [
  { key: 'period', label: 'Kısa SMA periyodu (mum)', type: 'number', min: 20, max: 400, step: 1 },
  { key: 'regimePeriod', label: 'Rejim SMA periyodu (mum)', type: 'number', min: 50, max: 990, step: 1 },
  { key: 'bufferPct', label: 'Tampon (%)', type: 'number', min: 0, max: 10, step: 0.1 }
];
const RISK_SCHEMA = [
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function bands(candles, params) {
  const closes = candles.map((c) => c.c);
  const i = closes.length - 1;
  const buf = params.bufferPct / 100;
  const avg = sma(closes, params.period)[i];
  const regime = sma(closes, params.regimePeriod)[i];
  if (avg === null || regime === null) return null;
  return { closes, i, price: closes[i], avg, regime, upper: avg * (1 + buf), lower: avg * (1 - buf), regimeUpper: regime * (1 + buf), regimeLower: regime * (1 - buf) };
}

// Chandelier: son `bars` mumun en yuksek zirvesi - mult x ATR
function chandelier(candles, bars, atrPeriod, mult) {
  const i = candles.length - 1;
  const a = atr(candles, atrPeriod)[i];
  if (a === null) return null;
  let high = -Infinity;
  for (let k = i - bars + 1; k <= i; k++) if (candles[k].h > high) high = candles[k].h;
  return high - mult * a;
}

module.exports = { BASE_PARAMS, BASE_SCHEMA, RISK_SCHEMA, bands, chandelier };
