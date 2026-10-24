// src/strategies/trendFilter.js
//
// Trend filtresi (klasik "uzun ortalamanin ustunde kal" kurali):
// ALIM : kapanis, SMA(period) x (1 + tampon%) seviyesinin USTUNE cikar  (pozisyon yokken)
// SATIM: kapanis, SMA(period) x (1 - tampon%) seviyesinin ALTINA iner   (pozisyon varken)
//        VEYA stop-loss (genis, felaket korumasi) VEYA take-profit/trailing
//
// Amac getiriyi artirmak degil, dusen piyasada NAKITE gecip buyuk dususlerden kacinmak.
// Tampon (histerezis), fiyat ortalama etrafinda dalgalanirken gereksiz alim-satimi azaltir.
//
// ONEMLI: Bu strateji TEK VARYANT olarak tanimlandi (SMA 200, tampon %1, stop %8). Backtest
// sonuclarini gormeden once sabitlendi; sonradan parametre taramasi yapip "en iyisini" secmek
// gecmise uydurmaktir. Kabul olcutleri src/backtest/criteria.js icindedir.

const { sma } = require('../indicators');
const { riskExitFirst } = require('./riskExit');
const { formatPrice } = require('../numberFormat');

const defaultParams = {
  period: 200,
  bufferPct: 1,
  stopLossPct: 8,
  takeProfitPct: 0, // fiilen kapali: bu strateji cikisi ortalamanin altina inince yapar
  trailingStop: false
};

const paramsSchema = [
  { key: 'period', label: 'SMA periyodu', type: 'number', min: 20, max: 400, step: 1 },
  { key: 'bufferPct', label: 'Tampon (%)', type: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles(params) {
  return params.period + 5;
}

const fmtP = formatPrice;

function evaluate({ candles, position, params }) {
  // Pozisyon aciksa risk kurallari (stop-loss) HER ZAMAN once bakilir.
  const early = riskExitFirst(candles, position, params);
  if (early) return early;

  if (!candles || candles.length < minCandles(params)) {
    return { action: 'hold', reason: 'yetersiz veri (SMA için daha fazla mum lazım)' };
  }

  const closes = candles.map((c) => c.c);
  const i = closes.length - 1;
  const price = closes[i];
  const avg = sma(closes, params.period)[i];
  if (avg === null) return { action: 'hold', reason: 'SMA henüz hesaplanamadı', price };

  const upper = avg * (1 + params.bufferPct / 100);
  const lower = avg * (1 - params.bufferPct / 100);

  if (!position) {
    if (price > upper) {
      return { action: 'buy', reason: `fiyat ${fmtP(price)} > SMA${params.period} üst bandı ${fmtP(upper)}`, price };
    }
    return { action: 'hold', reason: `fiyat ${fmtP(price)} ≤ SMA${params.period} üst bandı ${fmtP(upper)}, nakitte bekle`, price };
  }

  if (price < lower) {
    return { action: 'sell', reason: `fiyat ${fmtP(price)} < SMA${params.period} alt bandı ${fmtP(lower)}`, price };
  }
  return { action: 'hold', reason: `pozisyon açık, fiyat ${fmtP(price)} ≥ alt bant ${fmtP(lower)}`, price };
}

module.exports = {
  id: 'trend_filter',
  name: 'Trend Filtresi (uzun ortalamanın üstünde kal)',
  description: 'Alım: fiyat SMA(periyot) üst bandının üstüne çıkar. Satım: alt bandın altına iner (ya da geniş stop-loss). Düşen piyasada nakde geçmek için; getiriyi artırmayı hedeflemez.',
  defaultParams,
  paramsSchema,
  minCandles,
  evaluate
};
