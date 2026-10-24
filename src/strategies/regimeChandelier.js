// regime_chandelier: trend_regime girisi, cikis ATR tabanli Chandelier stopu (kari daha uzun tasima denemesi).
// ALIM : kapanis SMA(period) ust bandi ustunde VE rejim SMA ustunde VE kapanis son entryBars mum zirvesini gecer
//        (taze kirilim sarti: Chandelier cikisindan hemen sonra ayni trende yeniden girip komisyon yakmasin)
// SATIM: kapanis < (son chandelierBars mum zirvesi - atrMult x ATR) VEYA rejim alt bandi altinda VEYA stop-loss
// TEK VARYANT (4h icin). NOT: entryBars sarti, gercek veride sonuc gorulmeden ONCE eklendi; sentetik denemede
// Chandelier cikisi + durum bazli giris ayni trende surekli yeniden giris yapip asiri islem uretti.
const { riskExitFirst } = require('./riskExit');
const { formatPrice } = require('../numberFormat');
const { BASE_PARAMS, BASE_SCHEMA, RISK_SCHEMA, bands, chandelier } = require('./regimeBase');

const defaultParams = { ...BASE_PARAMS, chandelierBars: 60, atrPeriod: 14, atrMult: 3, entryBars: 20 };
const paramsSchema = [...BASE_SCHEMA,
  { key: 'chandelierBars', label: 'Chandelier zirve penceresi (mum)', type: 'number', min: 10, max: 300, step: 1 },
  { key: 'atrPeriod', label: 'ATR periyodu', type: 'number', min: 5, max: 50, step: 1 },
  { key: 'atrMult', label: 'ATR çarpanı', type: 'number', min: 0.5, max: 10, step: 0.1 },
  { key: 'entryBars', label: 'Taze kırılım penceresi (mum)', type: 'number', min: 2, max: 300, step: 1 },
  ...RISK_SCHEMA];
const minCandles = (p) => Math.max(p.period, p.regimePeriod, p.chandelierBars + p.atrPeriod, p.entryBars) + 5;
const fmtP = formatPrice;

function evaluate({ candles, position, params }) {
  const early = riskExitFirst(candles, position, params);
  if (early) return early;
  if (!candles || candles.length < minCandles(params)) return { action: 'hold', reason: 'yetersiz veri' };
  const b = bands(candles, params);
  if (!b) return { action: 'hold', reason: 'SMA hesaplanamadı' };
  if (position) {
    const ch = chandelier(candles, params.chandelierBars, params.atrPeriod, params.atrMult);
    if (ch !== null && b.price < ch) return { action: 'sell', reason: `fiyat ${fmtP(b.price)} < Chandelier ${fmtP(ch)}`, price: b.price };
    if (b.price < b.regimeLower) return { action: 'sell', reason: `fiyat ${fmtP(b.price)} < rejim alt bandı`, price: b.price };
    return { action: 'hold', reason: 'pozisyon açık', price: b.price };
  }
  if (b.price > b.upper && b.price > b.regime) {
    let high = -Infinity;
    for (let k = b.i - params.entryBars; k < b.i; k++) if (candles[k].h > high) high = candles[k].h;
    if (b.price > high) return { action: 'buy', reason: `taze kırılım (${params.entryBars} mum zirvesi ${fmtP(high)}), trend+rejim üstünde`, price: b.price };
    return { action: 'hold', reason: 'trend var ama taze kırılım yok', price: b.price };
  }
  return { action: 'hold', reason: 'giriş koşulu yok', price: b.price };
}

module.exports = { id: 'regime_chandelier', name: 'Rejim + Chandelier Çıkışı', description: 'Trend+Rejim girişi, ATR tabanlı Chandelier çıkışı.', defaultParams, paramsSchema, minCandles, evaluate };
