// src/strategies/dipAnalyser.js  (OctoBot "dip analyser" modu fikrinden)
// Dusus sonrasi toparlanma: asiri satim (RSI) + hacim patlamasi + dipten donus mumu.
// ALIM : RSI <= rsiOversold, son mum yesil (kapanis > acilis), hacim >= volMult x ortalama,
//        ve fiyat uzun SMA'nin maxBelowSmaPct'den fazla ALTINDA degil (cokus/dusen bicak korumasi)
// SATIM: RSI >= rsiExit VEYA stop-loss / kar koruma / trailing (riskExitFirst)
const { rsi, sma } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = {
  rsiPeriod: 14, rsiOversold: 30, rsiExit: 55,
  volPeriod: 20, volMult: 1.5,
  trendPeriod: 200, maxBelowSmaPct: 15,
  stopLossPct: 5, takeProfitPct: 0, trailingStop: false
};

const paramsSchema = [
  { key: 'rsiPeriod', label: 'RSI periyodu', type: 'number', min: 2, max: 100, step: 1 },
  { key: 'rsiOversold', label: 'RSI aşırı satım eşiği', type: 'number', min: 5, max: 50, step: 1 },
  { key: 'rsiExit', label: 'RSI çıkış eşiği', type: 'number', min: 40, max: 90, step: 1 },
  { key: 'volPeriod', label: 'Hacim ortalama periyodu', type: 'number', min: 5, max: 200, step: 1 },
  { key: 'volMult', label: 'Hacim çarpanı (0=kapalı)', type: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'trendPeriod', label: 'Uzun SMA periyodu', type: 'number', min: 20, max: 400, step: 1 },
  { key: 'maxBelowSmaPct', label: 'SMA altı azami uzaklık % (0=kapalı)', type: 'number', min: 0, max: 80, step: 1 },
  { key: 'stopLossPct', label: 'Stop-Loss (%)', type: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'takeProfitPct', label: 'Kâr koruma eşiği (%) · 0 = kapalı', type: 'number', min: 0, max: 5000, step: 0.1 },
  { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
];

function validate(p) {
  if (p.rsiOversold >= p.rsiExit) return 'RSI aşırı satım eşiği, çıkış eşiğinden küçük olmalı.';
  return null;
}
const minCandles = (p) => Math.max(p.trendPeriod, p.volPeriod, p.rsiPeriod * 3) + 5;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri' };
  const i = candles.length - 1;
  const last = candles[i];
  const price = last.c;
  const r = rsi(candles.map((c) => c.c), params.rsiPeriod)[i];
  if (r === null || r === undefined) return { action: 'hold', reason: 'RSI henüz hesaplanamadı', price };

  if (position) {
    if (r >= params.rsiExit) return { action: 'sell', reason: `RSI ${r.toFixed(1)} >= ${params.rsiExit} (toparlandı)`, price };
    return { action: 'hold', reason: `pozisyon açık, RSI ${r.toFixed(1)}`, price };
  }
  if (r > params.rsiOversold) return { action: 'hold', reason: `RSI ${r.toFixed(1)} aşırı satımda değil`, price };
  if (!(last.c > last.o)) return { action: 'hold', reason: 'dipten dönüş mumu (yeşil) yok', price };
  if (params.volMult > 0) {
    const avgVol = sma(candles.map((c) => c.v), params.volPeriod)[i - 1]; // son mum haric ortalama
    if (avgVol === null || !(last.v >= params.volMult * avgVol)) return { action: 'hold', reason: 'hacim patlaması yok', price };
  }
  if (params.maxBelowSmaPct > 0) {
    const trend = sma(candles.map((c) => c.c), params.trendPeriod)[i];
    if (trend !== null && price < trend * (1 - params.maxBelowSmaPct / 100)) return { action: 'hold', reason: `fiyat SMA${params.trendPeriod}'in %${params.maxBelowSmaPct}'den fazla altında (çöküş koruması)`, price };
  }
  return { action: 'buy', reason: `dip alımı: RSI ${r.toFixed(1)}, yeşil dönüş mumu, hacim onaylı`, price };
}

module.exports = {
  id: 'dip_analyser',
  name: 'Dip Analiz (aşırı satım + hacim + dönüş mumu)',
  description: 'Alım: RSI aşırı satım, yeşil dönüş mumu, hacim patlaması ve çöküş koruması. Satım: RSI toparlanması, stop-loss ya da trailing.',
  defaultParams, paramsSchema, minCandles, validate, evaluate
};
