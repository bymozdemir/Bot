// src/strategies/macdMomentum.js
//
// Sade MACD momentum stratejisi (rsi_ema_macd'den farkli: EMA trend filtresi
// YOK, MACD hem giris hem cikis sinyali icin kullanilir):
// ALIM : MACD histogrami sifirin USTUNE cikar (yukselis momentumu basliyor)
// SATIM: MACD histogrami sifirin ALTINA iner  VEYA  take-profit  VEYA  stop-loss  VEYA  trailing stop

const { macd } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = {
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  stopLossPct: 3,
  takeProfitPct: 6,
  trailingStop: false
};

const paramsSchema = [
  { key: 'macdFast', label: 'MACD hızlı', type: 'number', min: 2, max: 100, step: 1 },
  { key: 'macdSlow', label: 'MACD yavaş', type: 'number', min: 2, max: 200, step: 1 },
  { key: 'macdSignal', label: 'MACD sinyal', type: 'number', min: 2, max: 100, step: 1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · bu kârdan sonra stop yukarı taşınır', type: 'number', min: 0.1, max: 200, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function validate(params) {
  if (params.macdFast >= params.macdSlow) return 'MACD hızlı, MACD yavaştan küçük olmalı.';
  return null;
}

function minCandles(params) {
  return params.macdSlow + 5;
}

function evaluate({ candles, position, params }) {
  // Pozisyon aciksa risk kurallari (stop-loss/take-profit) HER ZAMAN once bakilir,
  // indikatorler hesaplanamasa bile.
  const early = riskExitFirst(candles, position, params);
  if (early) return early;

  if (!candles || candles.length < minCandles(params)) {
    return { action: 'hold', reason: 'yetersiz veri (indikatörler için daha fazla mum lazım)' };
  }

  const closes = candles.map((c) => c.c);
  const i = closes.length - 1;
  const res = macd(closes, params.macdFast, params.macdSlow, params.macdSignal);
  const price = closes[i];
  const histNow = res.histogram[i];
  const histPrev = res.histogram[i - 1];

  if (histNow === null || histPrev === null) {
    return { action: 'hold', reason: 'indikatörler henüz hesaplanamadı', price };
  }

  const crossUp = histPrev <= 0 && histNow > 0;
  const crossDown = histPrev >= 0 && histNow < 0;

  if (!position) {
    if (crossUp) {
      return { action: 'buy', reason: 'MACD histogramı sıfırın üzerine çıktı (yükseliş momentumu)', price };
    }
    return { action: 'hold', reason: `MACD histogram ${histNow.toFixed(6)}`, price };
  }

  if (crossDown) {
    return { action: 'sell', reason: 'MACD histogramı sıfırın altına indi (momentum kayboluyor)', price };
  }

  return { action: 'hold', reason: 'pozisyon açık, momentum sürüyor', price };
}

module.exports = {
  id: 'macd_momentum',
  name: 'MACD Momentum',
  description: 'Alım: MACD histogramı sıfırın üzerine çıkar. Satım: sıfırın altına iner, take-profit, stop-loss ya da trailing stop. Trend filtresi yok, saf momentum.',
  defaultParams,
  paramsSchema,
  minCandles,
  validate,
  evaluate
};
