// src/strategies/donchianRegime.js
//
// Donchian kirilimi (Turtle tarzi) + uzun vadeli REJIM filtresi.
// ALIM : kapanis, onceki `entryBars` mumun en yuksek zirvesini gecer  VE  kapanis SMA(regimePeriod) ustunde
// SATIM: kapanis, onceki `exitBars` mumun en dusuk dibinin altina iner  VEYA  stop-loss (genis)
//
// TEK VARYANT olarak sabitlendi (backtest sonuclarini gormeden once). Varsayilanlar 4h mum icin:
// giris 120 mum (~20 gun), cikis 60 mum (~10 gun), rejim 900 mum (~150 gun).
// Not: stratejiye en fazla 1000 mum verilir, tum periyotlar < 990 olmali.

const { sma } = require('../indicators');
const { riskExitFirst } = require('./riskExit');
const { formatPrice } = require('../numberFormat');

const defaultParams = { entryBars: 120, exitBars: 60, regimePeriod: 900, stopLossPct: 8, takeProfitPct: 0, trailingStop: false };

const paramsSchema = [
  { key: 'entryBars', label: 'Giriş kırılım penceresi (mum)', type: 'number', min: 5, max: 500, step: 1 },
  { key: 'exitBars', label: 'Çıkış penceresi (mum)', type: 'number', min: 5, max: 500, step: 1 },
  { key: 'regimePeriod', label: 'Rejim SMA periyodu (mum)', type: 'number', min: 50, max: 990, step: 1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles(p) { return Math.max(p.entryBars, p.exitBars, p.regimePeriod) + 5; }
const fmtP = formatPrice;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri' };

  const n = candles.length;
  const i = n - 1;
  const price = candles[i].c;

  if (position) {
    let low = Infinity;
    for (let k = i - params.exitBars; k < i; k++) if (candles[k].l < low) low = candles[k].l;
    if (price < low) return { action: 'sell', reason: `fiyat ${fmtP(price)} < son ${params.exitBars} mum dibi ${fmtP(low)}`, price };
    return { action: 'hold', reason: 'pozisyon açık, Donchian çıkışı yok', price };
  }

  let high = -Infinity;
  for (let k = i - params.entryBars; k < i; k++) if (candles[k].h > high) high = candles[k].h;
  const regime = sma(candles.map((c) => c.c), params.regimePeriod)[i];
  if (regime === null) return { action: 'hold', reason: 'rejim SMA hesaplanamadı', price };
  if (price > high && price > regime) {
    return { action: 'buy', reason: `KIRILIM: fiyat ${fmtP(price)} > son ${params.entryBars} mum zirvesi ${fmtP(high)}, rejim SMA${params.regimePeriod} üstünde`, price };
  }
  return { action: 'hold', reason: price > high ? 'kırılım var ama rejim SMA altında, nakitte bekle' : 'kırılım yok', price };
}

module.exports = {
  id: 'donchian_regime',
  name: 'Donchian Kırılımı + Rejim Filtresi',
  description: 'Alım: fiyat son N mumun zirvesini geçer ve uzun vadeli SMA üstünde. Satım: son M mumun dibinin altına iner. Düşen piyasada nakitte bekler.',
  defaultParams, paramsSchema, minCandles, evaluate
};
