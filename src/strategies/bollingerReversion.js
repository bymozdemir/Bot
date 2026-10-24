// src/strategies/bollingerReversion.js
//
// Bollinger Bantlari ile ortalamaya donus (mean reversion):
// ALIM : fiyat ALT banda deger ya da altina iner (asiri satilmis gorunur)
// SATIM: fiyat ORTA banda (hareketli ortalamaya) doner  VEYA  take-profit  VEYA  stop-loss  VEYA  trailing stop
//
// RSI/EMA/MACD'den TAMAMEN farkli bir indikator (oynaklik bantlari) kullanir.

const { bollinger } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = {
  period: 20,
  stdDevMult: 2,
  stopLossPct: 3,
  takeProfitPct: 5,
  trailingStop: false
};

const paramsSchema = [
  { key: 'period', label: 'Bant periyodu', type: 'number', min: 5, max: 100, step: 1 },
  { key: 'stdDevMult', label: 'Standart sapma çarpanı', type: 'number', min: 0.5, max: 4, step: 0.1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · bu kârdan sonra stop yukarı taşınır', type: 'number', min: 0.1, max: 200, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles(params) {
  return params.period + 5;
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
  const bands = bollinger(closes, params.period, params.stdDevMult);
  const price = closes[i];

  if (bands.lower[i] === null || bands.middle[i] === null) {
    return { action: 'hold', reason: 'indikatörler henüz hesaplanamadı', price };
  }

  if (!position) {
    if (price <= bands.lower[i]) {
      return {
        action: 'buy',
        reason: `Fiyat alt Bollinger bandına (${bands.lower[i].toFixed(4)}) değdi/altına indi`,
        price
      };
    }
    return { action: 'hold', reason: `alt bant ${bands.lower[i].toFixed(4)}, fiyat ${price.toFixed(4)}`, price };
  }

  if (price >= bands.middle[i]) {
    return { action: 'sell', reason: 'Fiyat orta banda (hareketli ortalamaya) döndü', price };
  }

  return { action: 'hold', reason: 'pozisyon açık, ortalamaya dönüş bekleniyor', price };
}

module.exports = {
  id: 'bollinger_reversion',
  name: 'Bollinger Bantları (ortalamaya dönüş)',
  description: 'Alım: fiyat alt Bollinger bandına değer. Satım: fiyat orta banda döner, take-profit, stop-loss ya da trailing stop.',
  defaultParams,
  paramsSchema,
  minCandles,
  evaluate
};
