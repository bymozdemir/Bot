// src/strategies/trendFilterV2.js
// Trend V2: EMA trend + ADX trend-strength + RSI pullback recovery.
// Amaç: yatay piyasadaki gereksiz işlemleri azaltırken güçlü yükseliş trendlerini
// daha erken yakalamak. Sinyal yalnızca kapanmış mumda üretilir.

const { ema, rsi, atr, adx } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = {
  fastEma: 50,
  slowEma: 200,
  adxPeriod: 14,
  adxMin: 25,
  rsiPeriod: 14,
  rsiTrigger: 50,
  atrPeriod: 14,
  atrStopMult: 2,
  stopLossPct: 8,
  takeProfitPct: 0,
  trailingStop: false
};

const paramsSchema = [
  { key: 'fastEma', label: 'Hızlı EMA', type: 'number', min: 10, max: 100, step: 1 },
  { key: 'slowEma', label: 'Yavaş EMA', type: 'number', min: 100, max: 400, step: 1 },
  { key: 'adxPeriod', label: 'ADX periyodu', type: 'number', min: 5, max: 50, step: 1 },
  { key: 'adxMin', label: 'Minimum ADX', type: 'number', min: 5, max: 60, step: 0.5 },
  { key: 'rsiPeriod', label: 'RSI periyodu', type: 'number', min: 5, max: 50, step: 1 },
  { key: 'rsiTrigger', label: 'RSI dönüş seviyesi', type: 'number', min: 30, max: 70, step: 1 },
  { key: 'atrPeriod', label: 'ATR periyodu', type: 'number', min: 5, max: 50, step: 1 },
  { key: 'atrStopMult', label: 'ATR stop katsayısı', type: 'number', min: 0.5, max: 6, step: 0.1 },
  { key: 'stopLossPct', label: 'Acil stop-loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function minCandles(params) {
  return Math.max(params.slowEma + 5, params.adxPeriod * 3 + 5, params.atrPeriod + 5, params.rsiPeriod + 5);
}

function validate(params) {
  if (!(params.fastEma < params.slowEma)) return 'Hızlı EMA, yavaş EMA\'dan küçük olmalı.';
  return null;
}

const fmt = (v) => Number.isFinite(v) ? v.toFixed(v >= 1000 ? 0 : v >= 1 ? 2 : 5) : '-';

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri (Trend V2 için daha fazla mum lazım)' };

  const closes = candles.map(c => c.c);
  const i = closes.length - 1;
  const fast = ema(closes, params.fastEma);
  const slow = ema(closes, params.slowEma);
  const r = rsi(closes, params.rsiPeriod);
  const strength = adx(candles, params.adxPeriod);
  const a = atr(candles, params.atrPeriod);
  if ([fast[i], slow[i], r[i], strength[i], a[i]].some(v => v === null || !Number.isFinite(v))) {
    return { action: 'hold', reason: 'Trend V2 göstergeleri henüz hazır değil', price: closes[i] };
  }

  const prevRsi = r[i - 1];
  const upTrend = closes[i] > slow[i] && fast[i] > slow[i] && strength[i] >= params.adxMin;
  const pullbackRecovery = Number.isFinite(prevRsi) && prevRsi <= params.rsiTrigger && r[i] > params.rsiTrigger;
  const price = closes[i];

  if (!position) {
    if (upTrend && pullbackRecovery) {
      return { action: 'buy', reason: `EMA${params.fastEma}>EMA${params.slowEma}, ADX ${fmt(strength[i])}, RSI ${fmt(prevRsi)}→${fmt(r[i])}; ATR ${fmt(a[i])}`, price };
    }
    return { action: 'hold', reason: `trend=${upTrend ? 'güçlü' : 'zayıf'}, ADX ${fmt(strength[i])}, RSI ${fmt(r[i])}`, price };
  }

  // Trend bozulması ana çıkıştır. ATR tabanlı close-stop, strateji seviyesinde
  // ek korumadır; simülatör/paper motorundaki acil stop bundan bağımsız çalışır.
  const atrStop = position.entryPrice - params.atrStopMult * a[i];
  if (price <= atrStop) {
    return { action: 'sell', reason: `ATR stop: fiyat ${fmt(price)} <= ${fmt(atrStop)}`, price };
  }
  if (price < slow[i] || fast[i] < slow[i]) {
    return { action: 'sell', reason: `trend bozuldu: EMA${params.fastEma} ${fmt(fast[i])} < EMA${params.slowEma} ${fmt(slow[i])}`, price };
  }
  return { action: 'hold', reason: `trend açık, ADX ${fmt(strength[i])}, EMA${params.fastEma}>EMA${params.slowEma}`, price };
}

module.exports = {
  id: 'trend_filter_v2',
  name: 'Trend V2 (EMA + ADX + RSI + ATR)',
  description: 'EMA50/200 yönü, ADX trend gücü ve RSI dönüşüyle giriş; trend bozulması ve ATR tabanlı çıkış. Parametreler varsayılan olarak sabittir; otomatik optimizasyon yapılmaz.',
  defaultParams,
  paramsSchema,
  minCandles,
  validate,
  evaluate
};
