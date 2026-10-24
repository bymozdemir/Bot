// regime_adx: trend_regime + ek giris sarti ADX >= adxMin (zayif trendte yanlis giris azaltma).
// ALIM : kapanis SMA(period) ust bandi ustunde VE rejim SMA ustunde VE ADX >= adxMin
// SATIM: kapanis SMA(period) alt bandi altinda VEYA rejim alt bandi altinda VEYA stop-loss
// TEK VARYANT, sonuclar gorulmeden sabitlendi (4h icin).
const { adx } = require('../indicators');
const { riskExitFirst } = require('./riskExit');
const { formatPrice } = require('../numberFormat');
const { BASE_PARAMS, BASE_SCHEMA, RISK_SCHEMA, bands } = require('./regimeBase');

const defaultParams = { ...BASE_PARAMS, adxPeriod: 14, adxMin: 20 };
const paramsSchema = [...BASE_SCHEMA,
  { key: 'adxPeriod', label: 'ADX periyodu', type: 'number', min: 5, max: 50, step: 1 },
  { key: 'adxMin', label: 'ADX alt eşik', type: 'number', min: 5, max: 60, step: 1 },
  ...RISK_SCHEMA];
const minCandles = (p) => Math.max(p.period, p.regimePeriod, p.adxPeriod * 3) + 5;
const fmtP = formatPrice;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri' };
  const b = bands(candles, params);
  if (!b) return { action: 'hold', reason: 'SMA hesaplanamadı' };
  if (position) {
    if (b.price < b.lower) return { action: 'sell', reason: `fiyat ${fmtP(b.price)} < SMA${params.period} alt bandı`, price: b.price };
    if (b.price < b.regimeLower) return { action: 'sell', reason: `fiyat ${fmtP(b.price)} < rejim alt bandı`, price: b.price };
    return { action: 'hold', reason: 'pozisyon açık', price: b.price };
  }
  if (b.price > b.upper && b.price > b.regime) {
    const a = adx(candles, params.adxPeriod)[b.i];
    if (a !== null && a >= params.adxMin) return { action: 'buy', reason: `trend+rejim üstünde, ADX ${a.toFixed(1)} ≥ ${params.adxMin}`, price: b.price };
    return { action: 'hold', reason: `trend var ama ADX zayıf (${a === null ? '-' : a.toFixed(1)})`, price: b.price };
  }
  return { action: 'hold', reason: 'giriş koşulu yok', price: b.price };
}

module.exports = { id: 'regime_adx', name: 'Rejim + ADX Filtresi', description: 'Trend+Rejim stratejisi, ek olarak ADX güçlü trend şartı.', defaultParams, paramsSchema, minCandles, evaluate };
