// Otomatik strateji kombinasyon tarayicisi icin deterministik sinyal stratejisi.
// Buy kosullari AND olarak birlesir; exit kosullari OR olarak uygulanir.
const { ema, sma, rsi, macd, bollinger, stochastic, atr, adx } = require('../indicators');
const { riskExitFirst } = require('../strategies/riskExit');

function buildStrategy(candidate) {
  const maxPeriod = Math.max(...candidate.conditions.map(c => Number(c.period || c.slow || c.long || c.rsiPeriod || 14)), Number(candidate.risk?.stopLossPct ? 1 : 1));
  const defaultParams = {
    stopLossPct: candidate.risk.stopLossPct,
    takeProfitPct: candidate.risk.takeProfitPct,
    trailingStop: !!candidate.risk.trailingStop
  };
  return {
    id: candidate.id,
    name: candidate.name,
    description: candidate.name,
    defaultParams,
    paramsSchema: [],
    minCandles: () => Math.max(50, Math.min(900, maxPeriod + 20)),
    evaluate({ candles, position, params }) {
      const early = riskExitFirst(candles, position, params);
      if (early) return early;
      if (!candles || candles.length < this.minCandles(params)) return { action: 'hold', reason: 'warmup' };
      const closes = candles.map(c => c.c);
      const i = closes.length - 1;
      // Aynı indikatör/parametre kombinasyonu bir aday içinde yalnızca bir kez hesaplanır.
      // getSeries diziyi, get ise son mumdaki değeri döndürür.
      const values = Object.create(null);
      const getSeries = (key, fn) => { if (!Object.hasOwn(values, key)) values[key] = fn(); return values[key]; };
      const get = (key, fn) => getSeries(key, fn)[i];
      const cond = candidate.conditions;
      const pass = cond.every(c => evaluateCondition(c, candles, closes, i, get, getSeries));
      if (!position && pass) return { action: 'buy', reason: `kombinasyon: ${cond.map(c=>c.label).join(' + ')}`, price: closes[i] };
      if (position) {
        const exit = candidate.exit;
        if (exit === 'macd_down') {
          const m = macd(closes, exitParams(candidate).fast, exitParams(candidate).slow, exitParams(candidate).signal);
          if (m.histogram[i - 1] > 0 && m.histogram[i] <= 0) return { action:'sell', reason:'MACD aşağı kesişim', price:closes[i] };
        } else if (exit === 'rsi_overbought') {
          const r = rsi(closes, candidate.exitRsiPeriod || 14)[i];
          if (r !== null && r >= (candidate.exitRsi || 70)) return { action:'sell', reason:'RSI aşırı alım', price:closes[i] };
        } else if (exit === 'bb_middle') {
          const b = bollinger(closes, candidate.exitBbPeriod || 20, candidate.exitBbMult || 2);
          if (b.middle[i] !== null && closes[i] >= b.middle[i]) return { action:'sell', reason:'Bollinger orta banda dönüş', price:closes[i] };
        }
      }
      return { action: 'hold', reason: position ? 'pozisyon açık' : 'koşullar sağlanmadı', price: closes[i] };
    }
  };
}

function exitParams(candidate) { return candidate.exitMacd || { fast:12, slow:26, signal:9 }; }

function evaluateCondition(c, candles, closes, i, get, getSeries) {
  switch (c.type) {
    case 'rsi_oversold': {
      const r = get(`rsi:${c.period}`, () => rsi(closes,c.period));
      const series = getSeries(`rsi:${c.period}`, () => rsi(closes, c.period));
      const prev = i > 0 ? series[i-1] : null;
      return c.cross ? (prev !== null && prev < c.level && r !== null && r >= c.level) : (r !== null && r < c.level);
    }
    case 'rsi_recover': {
      const a=getSeries(`rsi:${c.period}`, () => rsi(closes,c.period)); return a[i-1] !== null && a[i-1] < c.level && a[i] >= c.level;
    }
    case 'ema_trend': {
      const a=getSeries(`ema:${c.period}`, () => ema(closes,c.period)); return a[i] !== null && closes[i] > a[i]*(1+c.bufferPct/100);
    }
    case 'ema_cross': {
      const f=getSeries(`ema:${c.fast}`, () => ema(closes,c.fast)), s=getSeries(`ema:${c.slow}`, () => ema(closes,c.slow)); return f[i-1] !== null && s[i-1] !== null && f[i-1] <= s[i-1] && f[i] > s[i];
    }
    case 'macd_up': {
      const m=getSeries(`macd:${c.fast}:${c.slow}:${c.signal}`, () => macd(closes,c.fast,c.slow,c.signal)); return m.histogram[i-1] !== null && m.histogram[i] !== null && m.histogram[i-1] <= 0 && m.histogram[i] > 0;
    }
    case 'bb_lower': {
      const b=getSeries(`bb:${c.period}:${c.mult}`, () => bollinger(closes,c.period,c.mult)); return b.lower[i] !== null && closes[i] < b.lower[i];
    }
    case 'bb_recover': {
      const b=getSeries(`bb:${c.period}:${c.mult}`, () => bollinger(closes,c.period,c.mult)); return i>0 && b.lower[i-1] !== null && closes[i-1] < b.lower[i-1] && b.lower[i] !== null && closes[i] >= b.lower[i];
    }
    case 'stoch_oversold': {
      const s=getSeries(`stoch:${c.period}`, () => stochastic(candles,c.period)); return s[i] !== null && s[i] < c.level;
    }
    case 'atr_range': {
      const a=getSeries(`atr:${c.period}`, () => atr(candles,c.period)); return a[i] !== null && a[i]/closes[i] >= c.minPct/100;
    }
    case 'price_sma': {
      const a=getSeries(`sma:${c.period}`, () => sma(closes,c.period)); return a[i] !== null && closes[i] > a[i]*(1+c.bufferPct/100);
    }
    case 'adx_min': {
      const a=getSeries(`adx:${c.period}`, () => adx(candles,c.period)); return a[i] !== null && a[i] >= c.level;
    }
    default: return false;
  }
}

module.exports = { buildStrategy };
