// regime_pullback: yukselis rejiminde geri cekilmede al.
// ALIM : kapanis rejim SMA ust bandi ustunde VE RSI(rsiPeriod) rsiLevel'i ASAGIDAN YUKARI keser
// SATIM: kapanis rejim alt bandi altina iner VEYA stop-loss (cikis yalnizca rejim bozulunca)
// TEK VARYANT, sonuclar gorulmeden sabitlendi (4h icin).
const { rsi } = require('../indicators');
const { riskExitFirst } = require('./riskExit');
const { formatPrice } = require('../numberFormat');
const { BASE_PARAMS, BASE_SCHEMA, RISK_SCHEMA, bands } = require('./regimeBase');

const defaultParams = { ...BASE_PARAMS, rsiPeriod: 14, rsiLevel: 40 };
const paramsSchema = [...BASE_SCHEMA,
  { key: 'rsiPeriod', label: 'RSI periyodu', type: 'number', min: 2, max: 50, step: 1 },
  { key: 'rsiLevel', label: 'RSI alım eşiği (yukarı kesişim)', type: 'number', min: 10, max: 60, step: 1 },
  ...RISK_SCHEMA];
const minCandles = (p) => Math.max(p.regimePeriod, p.period, p.rsiPeriod * 3) + 5;
const fmtP = formatPrice;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri' };
  const b = bands(candles, params);
  if (!b) return { action: 'hold', reason: 'SMA hesaplanamadı' };
  if (position) {
    if (b.price < b.regimeLower) return { action: 'sell', reason: `fiyat ${fmtP(b.price)} < rejim alt bandı`, price: b.price };
    return { action: 'hold', reason: 'pozisyon açık, rejim sağlam', price: b.price };
  }
  if (b.price > b.regimeUpper) {
    const r = rsi(b.closes, params.rsiPeriod);
    const now = r[b.i], prev = r[b.i - 1];
    if (now !== null && prev !== null && prev < params.rsiLevel && now >= params.rsiLevel) {
      return { action: 'buy', reason: `GERİ ÇEKİLME: RSI ${params.rsiLevel} eşiğini yukarı kesti, rejim üstünde`, price: b.price };
    }
  }
  return { action: 'hold', reason: 'giriş koşulu yok', price: b.price };
}

module.exports = { id: 'regime_pullback', name: 'Rejim + Geri Çekilme Alımı', description: 'Yükseliş rejiminde RSI geri çekilmesinden dönüşte alır, rejim bozulunca satar.', defaultParams, paramsSchema, minCandles, evaluate };
