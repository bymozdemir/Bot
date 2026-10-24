// src/strategies/adxChandelier.js
//
// ADX trend gucu filtresi + Chandelier (ATR) cikisi.
// ALIM : ADX >= adxMin (trend guclu)  VE  kapanis > EMA(emaPeriod)  VE  EMA yukseliyor (slopeBars once)
// SATIM: kapanis < (son `chandelierBars` mumun en yuksek zirvesi - atrMult x ATR)  VEYA  kapanis < EMA
//        VEYA stop-loss (genis)
//
// TEK VARYANT olarak sabitlendi. Varsayilanlar 4h mum icin.

const { ema, atr, adx } = require('../indicators');
const { riskExitFirst } = require('./riskExit');
const { formatPrice } = require('../numberFormat');

const defaultParams = { adxPeriod: 14, adxMin: 25, emaPeriod: 100, slopeBars: 10, chandelierBars: 60, atrPeriod: 14, atrMult: 3, stopLossPct: 8, takeProfitPct: 0, trailingStop: false };

const paramsSchema = [
  { key: 'adxPeriod', label: 'ADX periyodu', type: 'number', min: 5, max: 50, step: 1 },
  { key: 'adxMin', label: 'ADX alt eşik', type: 'number', min: 5, max: 60, step: 1 },
  { key: 'emaPeriod', label: 'EMA periyodu', type: 'number', min: 10, max: 400, step: 1 },
  { key: 'slopeBars', label: 'EMA eğim penceresi (mum)', type: 'number', min: 1, max: 100, step: 1 },
  { key: 'chandelierBars', label: 'Chandelier zirve penceresi (mum)', type: 'number', min: 10, max: 300, step: 1 },
  { key: 'atrPeriod', label: 'ATR periyodu', type: 'number', min: 5, max: 50, step: 1 },
  { key: 'atrMult', label: 'ATR çarpanı', type: 'number', min: 0.5, max: 10, step: 0.1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles(p) { return Math.max(p.adxPeriod * 3, p.emaPeriod + p.slopeBars, p.chandelierBars + p.atrPeriod) + 5; }
const fmtP = formatPrice;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri' };

  const i = candles.length - 1;
  const closes = candles.map((c) => c.c);
  const price = closes[i];
  const e = ema(closes, params.emaPeriod);
  const a = atr(candles, params.atrPeriod)[i];
  if (e[i] === null || e[i - params.slopeBars] === null || a === null) return { action: 'hold', reason: 'gösterge hesaplanamadı', price };

  if (position) {
    let high = -Infinity;
    for (let k = i - params.chandelierBars + 1; k <= i; k++) if (candles[k].h > high) high = candles[k].h;
    const chandelier = high - params.atrMult * a;
    if (price < chandelier) return { action: 'sell', reason: `fiyat ${fmtP(price)} < Chandelier ${fmtP(chandelier)}`, price };
    if (price < e[i]) return { action: 'sell', reason: `fiyat ${fmtP(price)} < EMA${params.emaPeriod} ${fmtP(e[i])}`, price };
    return { action: 'hold', reason: 'pozisyon açık, trend korunuyor', price };
  }

  const adxVal = adx(candles, params.adxPeriod)[i];
  if (adxVal === null) return { action: 'hold', reason: 'ADX hesaplanamadı', price };
  const rising = e[i] > e[i - params.slopeBars];
  if (adxVal >= params.adxMin && price > e[i] && rising) {
    return { action: 'buy', reason: `güçlü trend: ADX ${adxVal.toFixed(1)}, fiyat EMA${params.emaPeriod} üstünde ve EMA yükseliyor`, price };
  }
  return { action: 'hold', reason: `koşullar yok (ADX ${adxVal.toFixed(1)})`, price };
}

module.exports = {
  id: 'adx_chandelier',
  name: 'ADX Trend Gücü + Chandelier Çıkışı',
  description: 'Alım: ADX güçlü, fiyat yükselen EMA üstünde. Satım: ATR tabanlı Chandelier stopu ya da EMA altı.',
  defaultParams, paramsSchema, minCandles, evaluate
};
