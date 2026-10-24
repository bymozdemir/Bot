// src/strategies/trendRegime.js
//
// Trend filtresi + UZUN VADELI REJIM filtresi.
// ALIM : kapanis SMA(period) ust bandinin USTUNDE  VE  kapanis SMA(regimePeriod) USTUNDE
//        (yani sadece uzun vadeli yukselis rejiminde alir; dusen piyasada nakitte bekler)
// SATIM: kapanis SMA(period) alt bandinin ALTINA iner  VEYA  SMA(regimePeriod) alt bandinin ALTINA iner
//        VEYA stop-loss (genis, felaket korumasi)
//
// Gerekce: trend_filter 4h backtestinde yukselis doneminde (2023-25) 10/10 coinde kazandirdi
// ama dusus doneminde (2021-23) tum coinlerde zarar etti. Bu strateji o dusus doneminde
// islem acmamayi hedefler.
//
// ONEMLI: Bu strateji TEK VARYANT olarak sabitlendi (backtest sonuclarini gormeden once).
// Varsayilanlar 4h mum icindir: SMA200 ~33 gun, rejim SMA900 ~150 gun.
// NOT: Borsa/simulator stratejiye en fazla 1000 mum verir, bu yuzden rejim periyodu <= 990 olmali.
// 1d mum icin ornek: period 50, regimePeriod 200. Sonradan parametre taramasi gecmise uydurmadir.

const { sma } = require('../indicators');
const { riskExitFirst } = require('./riskExit');
const { formatPrice } = require('../numberFormat');

const defaultParams = {
  period: 200,
  regimePeriod: 900,
  bufferPct: 1,
  stopLossPct: 8,
  takeProfitPct: 0,
  trailingStop: false
};

const paramsSchema = [
  { key: 'period', label: 'Kısa SMA periyodu (mum)', type: 'number', min: 20, max: 400, step: 1 },
  { key: 'regimePeriod', label: 'Rejim SMA periyodu (mum)', type: 'number', min: 50, max: 990, step: 1 },
  { key: 'bufferPct', label: 'Tampon (%)', type: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles(params) {
  return Math.max(params.period, params.regimePeriod) + 5;
}

const fmtP = formatPrice;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;

  if (!candles || candles.length < minCandles(params)) {
    return { action: 'hold', reason: 'yetersiz veri (rejim SMA için daha fazla mum lazım)' };
  }

  const closes = candles.map((c) => c.c);
  const i = closes.length - 1;
  const price = closes[i];
  const avg = sma(closes, params.period)[i];
  const regime = sma(closes, params.regimePeriod)[i];
  if (avg === null || regime === null) return { action: 'hold', reason: 'SMA henüz hesaplanamadı', price };

  const buf = params.bufferPct / 100;
  const upper = avg * (1 + buf);
  const lower = avg * (1 - buf);
  const regimeLower = regime * (1 - buf);

  if (!position) {
    if (price > upper && price > regime) {
      return { action: 'buy', reason: `fiyat ${fmtP(price)} > SMA${params.period} üst bandı ${fmtP(upper)} ve rejim SMA${params.regimePeriod} ${fmtP(regime)} üstünde`, price };
    }
    if (price > upper) {
      return { action: 'hold', reason: `kısa trend yukarı ama fiyat rejim SMA${params.regimePeriod} altında, nakitte bekle`, price };
    }
    return { action: 'hold', reason: `fiyat ${fmtP(price)} ≤ SMA${params.period} üst bandı ${fmtP(upper)}, nakitte bekle`, price };
  }

  if (price < lower) {
    return { action: 'sell', reason: `fiyat ${fmtP(price)} < SMA${params.period} alt bandı ${fmtP(lower)}`, price };
  }
  if (price < regimeLower) {
    return { action: 'sell', reason: `fiyat ${fmtP(price)} < rejim SMA${params.regimePeriod} alt bandı ${fmtP(regimeLower)}`, price };
  }
  return { action: 'hold', reason: `pozisyon açık, trend ve rejim korunuyor (${fmtP(price)})`, price };
}

module.exports = {
  id: 'trend_regime',
  name: 'Trend + Rejim Filtresi (uzun vadeli yükselişte al)',
  description: 'Alım: fiyat hem kısa SMA üst bandının hem uzun vadeli rejim SMA\'nın üstünde. Satım: kısa bandın ya da rejim bandının altına inince (ya da geniş stop-loss). Düşen piyasada nakitte bekler.',
  defaultParams,
  paramsSchema,
  minCandles,
  evaluate
};
