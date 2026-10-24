// regime_strict: trend_regime + donchian_regime + tsmom sinyallerinin UCU DE alim derse alir (3/3);
// satim icin 3 stratejiden en az ikisi satim derse (2/3) satar. Az ama secici islem hedefi.
// Alt stratejiler kendi varsayilanlariyla ve stop-loss'suz calisir; tek stop bu stratejinin stopLossPct'idir.
const trendRegime = require('./trendRegime');
const donchianRegime = require('./donchianRegime');
const tsmom = require('./tsmom');
const { riskExitFirst } = require('./riskExit');

const SUBS = [trendRegime, donchianRegime, tsmom];
const NO_STOP = { stopLossPct: 100, takeProfitPct: 0, trailingStop: false };
const defaultParams = { stopLossPct: 8, takeProfitPct: 0, trailingStop: false };
const paramsSchema = [
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];
const minCandles = () => Math.max(...SUBS.map((s) => s.minCandles(s.defaultParams)));

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles()) return { action: 'hold', reason: 'yetersiz veri' };
  const price = candles[candles.length - 1].c;
  if (!position) {
    const buys = SUBS.filter((s) => s.evaluate({ candles, position: null, params: { ...s.defaultParams, ...NO_STOP } }).action === 'buy');
    if (buys.length === 3) return { action: 'buy', reason: 'SIKI OYLAMA: 3/3 alım', price };
    return { action: 'hold', reason: `oy yetersiz (${buys.length}/3)`, price };
  }
  const view = { entryPrice: position.entryPrice, quantity: position.quantity };
  const sells = SUBS.filter((s) => s.evaluate({ candles, position: { ...view }, params: { ...s.defaultParams, ...NO_STOP } }).action === 'sell');
  if (sells.length >= 2) return { action: 'sell', reason: `SIKI OYLAMA: ${sells.length}/3 satım`, price };
  return { action: 'hold', reason: `pozisyon açık, satım oyu ${sells.length}/3`, price };
}

module.exports = { id: 'regime_strict', name: 'Rejim Sıkı Oylama (3/3 al, 2/3 sat)', description: 'Üç trend stratejisinin üçü de alım derse alır, ikisi satım derse satar.', defaultParams, paramsSchema, minCandles, evaluate };
