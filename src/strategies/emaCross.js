// src/strategies/emaCross.js
//
// Basit trend takibi:
// ALIM : hizli EMA, yavas EMA'yi YUKARI keser
// SATIM: hizli EMA, yavas EMA'yi ASAGI keser  VEYA  take-profit  VEYA  stop-loss  VEYA  trailing stop
//
// Bu dosya, strateji altyapisinin gercekten eklenebilir oldugunu gostermek
// icin var: yeni bir strateji eklemek sadece bu sekilde bir dosya yazip
// strategies/index.js'e kaydetmekten ibaret, panel ya da motor kodu
// degismiyor.

const { ema } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = {
  emaFast: 20,
  emaSlow: 50,
  stopLossPct: 4,
  takeProfitPct: 8,
  trailingStop: false
};

const paramsSchema = [
  { key: 'emaFast', label: 'EMA hızlı', type: 'number', min: 2, max: 200, step: 1 },
  { key: 'emaSlow', label: 'EMA yavaş', type: 'number', min: 5, max: 400, step: 1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · bu kârdan sonra stop yukarı taşınır', type: 'number', min: 0.1, max: 200, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function validate(params) {
  if (params.emaFast >= params.emaSlow) return 'EMA hızlı, EMA yavaştan küçük olmalı.';
  return null;
}

function minCandles(params) {
  return params.emaSlow + 5;
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
  const fast = ema(closes, params.emaFast);
  const slow = ema(closes, params.emaSlow);
  const price = closes[i];

  if (fast[i] === null || slow[i] === null || fast[i - 1] === null || slow[i - 1] === null) {
    return { action: 'hold', reason: 'indikatörler henüz hesaplanamadı', price };
  }

  const crossUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
  const crossDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];

  if (!position) {
    if (crossUp) {
      return { action: 'buy', reason: `EMA${params.emaFast}, EMA${params.emaSlow}'yi yukarı kesti`, price };
    }
    return { action: 'hold', reason: 'kesişim yok', price };
  }

  if (crossDown) {
    return { action: 'sell', reason: `EMA${params.emaFast}, EMA${params.emaSlow}'yi aşağı kesti`, price };
  }

  return { action: 'hold', reason: 'pozisyon açık, kesişim yok', price };
}

module.exports = {
  id: 'ema_cross',
  name: 'EMA Kesişimi (basit trend takibi)',
  description: 'Alım: hızlı EMA yavaş EMAyı yukarı keser. Satım: aşağı kesişim, take-profit, stop-loss ya da trailing stop.',
  defaultParams,
  paramsSchema,
  minCandles,
  validate,
  evaluate
};
