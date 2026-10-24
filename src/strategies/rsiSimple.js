// src/strategies/rsiSimple.js
//
// Sade RSI ortalamaya donus stratejisi (rsi_ema_macd'den farkli: EMA trend
// filtresi YOK, cikis icin MACD degil yine RSI kullanilir):
// ALIM : RSI, asiri satim esiginin (oversold) ALTINDAN YUKARI kesip toparlanir
// SATIM: RSI, asiri alim esigine (overbought) ulasir  VEYA  take-profit  VEYA  stop-loss  VEYA  trailing stop

const { rsi } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = {
  rsiPeriod: 14,
  oversold: 30,
  overbought: 70,
  stopLossPct: 4,
  takeProfitPct: 6,
  trailingStop: false
};

const paramsSchema = [
  { key: 'rsiPeriod', label: 'RSI periyodu', type: 'number', min: 2, max: 50, step: 1 },
  { key: 'oversold', label: 'Aşırı satım eşiği', type: 'number', min: 1, max: 49, step: 1 },
  { key: 'overbought', label: 'Aşırı alım eşiği', type: 'number', min: 51, max: 99, step: 1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · bu kârdan sonra stop yukarı taşınır', type: 'number', min: 0.1, max: 200, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles(params) {
  return params.rsiPeriod + 5;
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
  const rsiArr = rsi(closes, params.rsiPeriod);
  const price = closes[i];
  const rsiNow = rsiArr[i];
  const rsiPrev = rsiArr[i - 1];

  if (rsiNow === null || rsiPrev === null) {
    return { action: 'hold', reason: 'indikatörler henüz hesaplanamadı', price };
  }

  if (!position) {
    const recoveryCross = rsiPrev < params.oversold && rsiNow >= params.oversold;
    if (recoveryCross) {
      return {
        action: 'buy',
        reason: `RSI ${params.oversold} aşırı satım eşiğini yukarı kesti (toparlanma)`,
        price
      };
    }
    return { action: 'hold', reason: `RSI ${rsiNow.toFixed(1)}`, price };
  }

  if (rsiNow >= params.overbought) {
    return { action: 'sell', reason: `RSI ${params.overbought} aşırı alım eşiğine ulaştı`, price };
  }

  return { action: 'hold', reason: 'pozisyon açık, aşırı alım bölgesinde değil', price };
}

module.exports = {
  id: 'rsi_simple',
  name: 'Sade RSI (ortalamaya dönüş)',
  description: 'Alım: RSI aşırı satımdan toparlanır. Satım: RSI aşırı alıma ulaşır, take-profit, stop-loss ya da trailing stop. EMA trend filtresi yok.',
  defaultParams,
  paramsSchema,
  minCandles,
  evaluate
};
