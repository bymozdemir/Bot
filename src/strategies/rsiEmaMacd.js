// src/strategies/rsiEmaMacd.js
//
// ALIM : RSI < esik  VE  fiyat > EMA(yavas)
// SATIM: MACD asagi kesisim  VEYA  take-profit  VEYA  stop-loss  VEYA  trailing stop
//
// Her strateji modulu ayni sekli uygular (bkz. strategies/index.js basindaki not):
//   id, name, description, defaultParams, paramsSchema, minCandles(params), evaluate(ctx)

const { ema, rsi, macd } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = {
  rsiPeriod: 14,
  rsiBuyBelow: 30,
  emaSlow: 200,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  stopLossPct: 3,
  takeProfitPct: 6,
  trailingStop: false
};

const paramsSchema = [
  { key: 'rsiPeriod', label: 'RSI periyodu', type: 'number', min: 2, max: 50, step: 1 },
  { key: 'rsiBuyBelow', label: 'RSI alım eşiği', type: 'number', min: 1, max: 99, step: 1 },
  { key: 'emaSlow', label: 'EMA yavaş', type: 'number', min: 10, max: 400, step: 1 },
  { key: 'macdFast', label: 'MACD hızlı', type: 'number', min: 2, max: 100, step: 1 },
  { key: 'macdSlow', label: 'MACD yavaş', type: 'number', min: 2, max: 200, step: 1 },
  { key: 'macdSignal', label: 'MACD sinyal', type: 'number', min: 2, max: 100, step: 1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · bu kârdan sonra stop yukarı taşınır', type: 'number', min: 0.1, max: 200, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

// Panelden gelen parametreler arasi capraz kontrol (bkz. strategies/index.js validateParams)
function validate(params) {
  if (params.macdFast >= params.macdSlow) return 'MACD hızlı, MACD yavaştan küçük olmalı.';
  return null;
}

function minCandles(params) {
  // EMA yakınsaması için yalnızca tek periyotluk pencere yeterli değildir.
  // 4x yavaş EMA, özellikle EMA200 için 800 mum warm-up sağlar.
  return Math.max(params.emaSlow * 4, params.macdSlow * 4) + 10;
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
  const emaSlowArr = ema(closes, params.emaSlow);
  const rsiArr = rsi(closes, params.rsiPeriod);
  const macdRes = macd(closes, params.macdFast, params.macdSlow, params.macdSignal);

  const price = closes[i];
  const rsiNow = rsiArr[i];
  const emaSlowNow = emaSlowArr[i];
  const histNow = macdRes.histogram[i];
  const histPrev = macdRes.histogram[i - 1];

  if (rsiNow === null || emaSlowNow === null || histNow === null || histPrev === null) {
    return { action: 'hold', reason: 'indikatörler henüz hesaplanamadı', price };
  }

  if (!position) {
    const buySignal = rsiNow < params.rsiBuyBelow && price > emaSlowNow;
    if (buySignal) {
      return {
        action: 'buy',
        reason: `RSI ${rsiNow.toFixed(1)} < ${params.rsiBuyBelow} ve fiyat EMA${params.emaSlow} üstünde`,
        price
      };
    }
    return { action: 'hold', reason: `RSI ${rsiNow.toFixed(1)}, EMA${params.emaSlow}=${emaSlowNow.toFixed(4)}`, price };
  }

  const macdCrossDown = histPrev > 0 && histNow <= 0;
  if (macdCrossDown) {
    return { action: 'sell', reason: 'MACD aşağı kesişim', price };
  }

  return { action: 'hold', reason: 'pozisyon açık, koşullar oluşmadı', price };
}

module.exports = {
  id: 'rsi_ema_macd',
  name: 'RSI + EMA + MACD',
  description: 'Alım: RSI eşiğin altında ve fiyat uzun EMA üstünde. Satım: MACD aşağı kesişim, take-profit, stop-loss ya da trailing stop.',
  defaultParams,
  paramsSchema,
  minCandles,
  validate,
  evaluate
};
