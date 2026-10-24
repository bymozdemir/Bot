// src/strategies/tsmom.js
//
// Zaman serisi momentumu (time-series momentum): bir coinin KENDI gecmis getirisi pozitifse tut.
// ALIM : son `lookbackBars` mumdaki getiri > entryPct (%)
// SATIM: bu getiri < exitPct (%)   VEYA  stop-loss (genis)
// entryPct > exitPct: iki esik arasi bolge gereksiz alim-satimi azaltir (histerezis).
//
// TEK VARYANT olarak sabitlendi. Varsayilanlar 4h mum icin: 540 mum ~ 90 gun.
// 1d mum icin ornek: lookbackBars 90.

const { riskExitFirst } = require('./riskExit');
const { formatPrice } = require('../numberFormat');

const defaultParams = { lookbackBars: 540, entryPct: 5, exitPct: 0, stopLossPct: 8, takeProfitPct: 0, trailingStop: false };

const paramsSchema = [
  { key: 'lookbackBars', label: 'Geriye bakış (mum)', type: 'number', min: 10, max: 990, step: 1 },
  { key: 'entryPct', label: 'Alım eşiği: getiri (%)', type: 'number', min: -50, max: 200, step: 0.5 },
  { key: 'exitPct', label: 'Satım eşiği: getiri (%)', type: 'number', min: -50, max: 200, step: 0.5 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles(p) { return p.lookbackBars + 5; }
const fmtP = formatPrice;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri' };

  const i = candles.length - 1;
  const price = candles[i].c;
  const past = candles[i - params.lookbackBars].c;
  const ret = (price / past - 1) * 100;

  if (!position) {
    if (ret > params.entryPct) return { action: 'buy', reason: `MOMENTUM: son ${params.lookbackBars} mum getirisi %${ret.toFixed(1)} > %${params.entryPct}`, price };
    return { action: 'hold', reason: `momentum yetersiz (%${ret.toFixed(1)})`, price };
  }
  if (ret < params.exitPct) return { action: 'sell', reason: `momentum bozuldu: getiri %${ret.toFixed(1)} < %${params.exitPct} (${fmtP(price)})`, price };
  return { action: 'hold', reason: `pozisyon açık, getiri %${ret.toFixed(1)}`, price };
}

module.exports = {
  id: 'tsmom',
  name: 'Zaman Serisi Momentumu',
  description: 'Alım: son N mumdaki getiri eşiğin üstünde. Satım: getiri eşiğin altına iner. Coinin kendi trendini izler.',
  defaultParams, paramsSchema, minCandles, evaluate
};
