// src/strategies/supertrend.js  (Hummingbot supertrend_v1 controller fikrinden)
// ALIM : SuperTrend yonu asagidan yukariya doner (kapanis ust bandi asar)
// SATIM: yon yukaridan asagiya doner VEYA stop-loss / kar koruma / trailing (riskExitFirst)
const { supertrend, atr } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = { atrPeriod: 10, mult: 3, minAtrPct: 0, stopLossPct: 6, takeProfitPct: 0, trailingStop: false };

const paramsSchema = [
  { key: 'atrPeriod', label: 'ATR periyodu', type: 'number', min: 3, max: 100, step: 1 },
  { key: 'mult', label: 'ATR çarpanı', type: 'number', min: 0.5, max: 10, step: 0.1 },
  { key: 'minAtrPct', label: 'Min ATR % (durgun piyasa filtresi, 0=kapalı)', type: 'number', min: 0, max: 20, step: 0.1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

const minCandles = (p) => p.atrPeriod * 3 + 5;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri' };
  const i = candles.length - 1;
  const price = candles[i].c;
  const st = supertrend(candles, params.atrPeriod, params.mult);
  if (st.dir[i] === null || st.dir[i - 1] === null) return { action: 'hold', reason: 'SuperTrend henüz hesaplanamadı', price };
  const flipUp = st.dir[i - 1] === -1 && st.dir[i] === 1;
  const flipDown = st.dir[i - 1] === 1 && st.dir[i] === -1;
  if (!position) {
    if (flipUp) {
      if (params.minAtrPct > 0) {
        const a = atr(candles, params.atrPeriod)[i];
        if (a === null || (a / price) * 100 < params.minAtrPct) return { action: 'hold', reason: 'SuperTrend yukarı döndü ama ATR çok düşük (durgun)', price };
      }
      return { action: 'buy', reason: `SuperTrend yukarı döndü (bant ${st.line[i].toPrecision(6)})`, price };
    }
    return { action: 'hold', reason: 'SuperTrend dönüşü yok', price };
  }
  if (flipDown) return { action: 'sell', reason: 'SuperTrend aşağı döndü', price };
  return { action: 'hold', reason: 'pozisyon açık, trend yukarı', price };
}

module.exports = {
  id: 'supertrend',
  name: 'SuperTrend (ATR bant trend dönüşü)',
  description: 'Alım: SuperTrend yukarı döner. Satım: aşağı dönüş, stop-loss, kâr koruma ya da trailing stop.',
  defaultParams, paramsSchema, minCandles, evaluate
};
