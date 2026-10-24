// src/strategies/trendVote.js
//
// Oylama (ensemble): trend_filter, donchian_regime ve tsmom'un SINYALLERINI birlestirir.
// ALIM : en az `minVotes` strateji (varsayilan 3 uzerinden 2) kendi giris kosulunu sagliyorsa
// SATIM: en az `minVotes` strateji kendi cikis kosulunu veriyorsa  VEYA  stop-loss
// Alt stratejiler kendi VARSAYILAN parametreleriyle calisir; sadece sinyal olarak kullanilir
// (alt stratejilerin stop-loss'u devre disi, tek stop bu stratejinin stopLossPct'idir).
//
// Onceden tanimlanmis TEK kombinasyon: backtest sonuclarina gore uyarlanmadi.

const trendFilter = require('./trendFilter');
const donchianRegime = require('./donchianRegime');
const tsmom = require('./tsmom');
const { riskExitFirst } = require('./riskExit');

const SUBS = [trendFilter, donchianRegime, tsmom];
const NO_STOP = { stopLossPct: 100, takeProfitPct: 0, trailingStop: false };

const defaultParams = { minVotes: 2, stopLossPct: 8, takeProfitPct: 0, trailingStop: false };

const paramsSchema = [
  { key: 'minVotes', label: 'Gerekli oy sayısı (3 üzerinden)', type: 'number', min: 1, max: 3, step: 1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles() { return Math.max(...SUBS.map((s) => s.minCandles(s.defaultParams))); }

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles()) return { action: 'hold', reason: 'yetersiz veri' };
  const price = candles[candles.length - 1].c;
  const need = params.minVotes;

  if (!position) {
    const votes = SUBS.filter((s) => s.evaluate({ candles, position: null, params: { ...s.defaultParams, ...NO_STOP } }).action === 'buy');
    if (votes.length >= need) return { action: 'buy', reason: `OYLAMA: ${votes.length}/3 alım (${votes.map((s) => s.id).join(', ')})`, price };
    return { action: 'hold', reason: `oy yetersiz (${votes.length}/3)`, price };
  }

  const view = { entryPrice: position.entryPrice, quantity: position.quantity };
  const sells = SUBS.filter((s) => s.evaluate({ candles, position: { ...view }, params: { ...s.defaultParams, ...NO_STOP } }).action === 'sell');
  if (sells.length >= need) return { action: 'sell', reason: `OYLAMA: ${sells.length}/3 satım (${sells.map((s) => s.id).join(', ')})`, price };
  return { action: 'hold', reason: `pozisyon açık, satım oyu ${sells.length}/3`, price };
}

module.exports = {
  id: 'trend_vote',
  name: 'Trend Oylaması (3 stratejiden 2)',
  description: 'Trend filtresi, Donchian kırılımı ve zaman serisi momentumundan en az ikisi aynı yönü gösterirse işlem yapar.',
  defaultParams, paramsSchema, minCandles, evaluate
};
