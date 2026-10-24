// Aggressive momentum/breakout profile. Research-only until it passes OOS and paper parity.
// Uses CLOSED candles only; position exits still go through the shared riskExit guard.
const { ema, rsi, atr, adx } = require('../indicators');
const { riskExitFirst } = require('./riskExit');

const defaultParams = {
  breakoutPeriod: 20,
  trendEma: 50,
  rsiPeriod: 14,
  rsiMin: 52,
  rsiMax: 76,
  adxPeriod: 14,
  adxMin: 18,
  volumePeriod: 20,
  volumeMult: 1.25,
  atrPeriod: 14,
  atrStopMult: 2.2,
  stopLossPct: 3,
  takeProfitPct: 0,
  trailingStop: true
};
const paramsSchema = [
  { key:'breakoutPeriod', label:'Kırılım penceresi', type:'number', min:5, max:100, step:1 },
  { key:'trendEma', label:'Trend EMA', type:'number', min:10, max:200, step:1 },
  { key:'rsiPeriod', label:'RSI periyodu', type:'number', min:5, max:40, step:1 },
  { key:'rsiMin', label:'RSI alt sınır', type:'number', min:30, max:70, step:1 },
  { key:'rsiMax', label:'RSI üst sınır', type:'number', min:55, max:90, step:1 },
  { key:'adxPeriod', label:'ADX periyodu', type:'number', min:5, max:40, step:1 },
  { key:'adxMin', label:'Minimum ADX', type:'number', min:5, max:50, step:1 },
  { key:'volumePeriod', label:'Hacim ortalaması', type:'number', min:5, max:100, step:1 },
  { key:'volumeMult', label:'Hacim çarpanı', type:'number', min:1, max:5, step:0.1 },
  { key:'atrPeriod', label:'ATR periyodu', type:'number', min:5, max:40, step:1 },
  { key:'atrStopMult', label:'ATR stop katsayısı', type:'number', min:0.5, max:5, step:0.1 },
  { key:'stopLossPct', label:'Acil stop-loss (%)', type:'number', min:0.1, max:10, step:0.1 },
  { key:'takeProfitPct', label:'Kâr koruma eşiği (%) · 0 = kapalı', type:'number', min:0, max:5000, step:0.1 },
  { key:'trailingStop', label:'Trailing stop', type:'boolean' }
];
function minCandles(p) { return Math.max(p.breakoutPeriod + 2, p.trendEma + 2, p.rsiPeriod + 2, p.adxPeriod * 2 + 2, p.volumePeriod + 2, p.atrPeriod + 2); }
function validate(p) {
  if (p.rsiMin >= p.rsiMax) return 'RSI alt sınırı üst sınırından küçük olmalı.';
  return null;
}
function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!Array.isArray(candles) || candles.length < minCandles(params)) return { action:'hold', reason:'Agresif kırılım için yetersiz veri' };
  const i = candles.length - 1, closes = candles.map(c => c.c);
  const trend = ema(closes, params.trendEma)[i];
  const strength = adx(candles, params.adxPeriod)[i];
  const momentum = rsi(closes, params.rsiPeriod)[i];
  const volatility = atr(candles, params.atrPeriod)[i];
  const volumes = candles.map(c => Number(c.v));
  const volNow = volumes[i];
  const priorVolumes = volumes.slice(i - params.volumePeriod, i);
  const avgVol = priorVolumes.every(Number.isFinite) ? priorVolumes.reduce((a,b)=>a+b,0) / priorVolumes.length : NaN;
  const priorHigh = Math.max(...candles.slice(i - params.breakoutPeriod, i).map(c => c.h));
  const price = closes[i];
  if (![trend,strength,momentum,volatility,avgVol,volNow,priorHigh,price].every(Number.isFinite) || avgVol <= 0) return { action:'hold', reason:'Agresif kırılım göstergeleri hazır değil', price };
  if (!position) {
    const pass = price > priorHigh && price > trend && strength >= params.adxMin && momentum >= params.rsiMin && momentum <= params.rsiMax && volNow >= avgVol * params.volumeMult;
    return pass
      ? { action:'buy', reason:`KIRILIM: fiyat önceki ${params.breakoutPeriod} mum zirvesini geçti; EMA${params.trendEma} üstü, ADX ${strength.toFixed(1)}, RSI ${momentum.toFixed(1)}, hacim ${(volNow/avgVol).toFixed(2)}x`, price, suggestedStopPrice:Math.max(price * (1-params.stopLossPct/100), price-params.atrStopMult*volatility), suggestedStopDistance:price-Math.max(price * (1-params.stopLossPct/100), price-params.atrStopMult*volatility) }
      : { action:'hold', reason:`Kırılım bekleniyor; ADX ${strength.toFixed(1)}, RSI ${momentum.toFixed(1)}, hacim ${(volNow/avgVol).toFixed(2)}x`, price };
  }
  const atrStop = position.entryPrice - params.atrStopMult * volatility;
  if (price <= atrStop) return { action:'sell', reason:`ATR stop: ${price.toPrecision(8)} <= ${atrStop.toPrecision(8)}`, price };
  if (price < trend) return { action:'sell', reason:`Momentum bozuldu: fiyat EMA${params.trendEma} altına indi`, price };
  return { action:'hold', reason:'Kırılım pozisyonu korunuyor; ortak stop/kâr koruma kontrolü etkin', price };
}
module.exports = { id:'aggressive_breakout', name:'Agresif Kırılım (EMA + RSI + ADX + Hacim + ATR)', description:'Daha sık momentum/kırılım fırsatları arar. Daha yüksek kayıp riski taşır; kâr garantisi yoktur. Canlı kullanımdan önce OOS ve paper test gerekir.', defaultParams, paramsSchema, minCandles, validate, evaluate };
