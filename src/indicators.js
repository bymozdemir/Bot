// src/indicators.js
// Bagimliliksiz, saf JS indikator hesaplari. Girdi: kapanis fiyatlarinin
// (closes) zaman sirali dizisi, en eski once. Ciktilar da ayni uzunlukta
// dizi olarak donuyor, yetersiz veri olan noktalarda null.

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // ilk EMA degeri, ilk `period` degerin basit ortalamasi
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAvg(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAvg(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAvg(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  // sinyal cizgisi icin sadece dolu (non-null) kisim uzerinden EMA alinir
  const firstValid = macdLine.findIndex((v) => v !== null);
  const signalOut = new Array(values.length).fill(null);
  if (firstValid !== -1) {
    const compact = macdLine.slice(firstValid);
    const compactSignal = ema(compact, signal);
    for (let i = 0; i < compact.length; i++) {
      signalOut[firstValid + i] = compactSignal[i];
    }
  }
  const histogram = values.map((_, i) =>
    macdLine[i] !== null && signalOut[i] !== null ? macdLine[i] - signalOut[i] : null
  );
  return { macdLine, signalLine: signalOut, histogram };
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

// Bollinger Bantlari: orta bant basit hareketli ortalama (SMA), ust/alt bant
// bu ortalamanin standart sapmanin `mult` kati kadar uzagi.
function bollinger(values, period = 20, mult = 2) {
  const middle = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    if (middle[i] === null) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - middle[i];
      sumSq += d * d;
    }
    const stdDev = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + mult * stdDev;
    lower[i] = middle[i] - mult * stdDev;
  }
  return { middle, upper, lower };
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prev = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  });
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let value = sum / period;
  out[period - 1] = value;
  for (let i = period; i < tr.length; i++) {
    value = ((value * (period - 1)) + tr[i]) / period;
    out[i] = value;
  }
  return out;
}

function stochastic(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, candles[j].h); lo = Math.min(lo, candles[j].l); }
    out[i] = hi === lo ? 50 : ((candles[i].c - lo) / (hi - lo)) * 100;
  }
  return out;
}


// Wilder ADX: OHLC verisinden trend gucunu olcer. +DI/-DI ve DX uzerinden
// Wilder yumusatmasi kullanilir; cikti mumlarla ayni uzunluktadir.
function adx(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period * 2) return out;
  const tr = new Array(candles.length).fill(0);
  const plus = new Array(candles.length).fill(0);
  const minus = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    plus[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minus[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const prev = candles[i - 1].c;
    tr[i] = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - prev), Math.abs(candles[i].l - prev));
  }
  let trSum = 0, plusSum = 0, minusSum = 0;
  for (let i = 1; i <= period; i++) { trSum += tr[i]; plusSum += plus[i]; minusSum += minus[i]; }
  const dx = new Array(candles.length).fill(null);
  const calc = (i) => {
    const pdi = trSum === 0 ? 0 : (plusSum / trSum) * 100;
    const mdi = trSum === 0 ? 0 : (minusSum / trSum) * 100;
    const denom = pdi + mdi;
    return denom === 0 ? 0 : (Math.abs(pdi - mdi) / denom) * 100;
  };
  dx[period] = calc(period);
  for (let i = period + 1; i < candles.length; i++) {
    trSum = trSum - trSum / period + tr[i];
    plusSum = plusSum - plusSum / period + plus[i];
    minusSum = minusSum - minusSum / period + minus[i];
    dx[i] = calc(i);
  }
  let first = period;
  let dxSum = 0;
  for (let i = first; i < first + period && i < dx.length; i++) dxSum += dx[i] || 0;
  if (first + period - 1 < dx.length) {
    out[first + period - 1] = dxSum / period;
    for (let i = first + period; i < candles.length; i++) {
      out[i] = ((out[i - 1] * (period - 1)) + (dx[i] || 0)) / period;
    }
  }
  return out;
}

// SuperTrend (ATR bantli trend yonu). dir: 1 yukari trend, -1 asagi trend. line: aktif bant.
// Hummingbot supertrend_v1 controller fikrinden; Wilder ATR (atr() ile ayni) kullanilir.
function supertrend(candles, period = 10, mult = 3) {
  const n = candles.length;
  const line = new Array(n).fill(null);
  const dir = new Array(n).fill(null);
  const a = atr(candles, period);
  let finalUpper = null, finalLower = null, d = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] === null) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const upper = hl2 + mult * a[i];
    const lower = hl2 - mult * a[i];
    if (finalUpper === null) {
      finalUpper = upper; finalLower = lower;
      d = candles[i].c >= hl2 ? 1 : -1;
    } else {
      const prevClose = candles[i - 1].c;
      finalUpper = (upper < finalUpper || prevClose > finalUpper) ? upper : finalUpper;
      finalLower = (lower > finalLower || prevClose < finalLower) ? lower : finalLower;
      if (d === 1 && candles[i].c < finalLower) d = -1;
      else if (d === -1 && candles[i].c > finalUpper) d = 1;
    }
    dir[i] = d;
    line[i] = d === 1 ? finalLower : finalUpper;
  }
  return { line, dir };
}

// Yonluluk (Passivbot "unilateralness"): log getirilerin ustel ortalamasi / karekok(ustel kare ortalamasi).
// Isaretli deger [-1, 1]: +1 surekli yukari, -1 surekli asagi, ~0 iki yonlu/duz. span: mum cinsinden EMA acisi.
// Sifirla baslatilan iki toplayici (Passivbot ile ayni); son ceil(20*span) getiri kullanilir.
function directionality(closes, span = 20) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const a = 2 / (Number(span) + 1);
  if (!(a > 0 && a <= 1)) return null;
  const need = Math.ceil(20 * span) + 1;
  const src = closes.slice(-need);
  let mean = 0, square = 0, n = 0;
  for (let i = 1; i < src.length; i++) {
    if (!(src[i] > 0) || !(src[i - 1] > 0)) return null;
    const r = Math.log(src[i]) - Math.log(src[i - 1]);
    mean += a * (r - mean);
    square += a * (r * r - square);
    n++;
  }
  if (n < 2) return null;
  return square > 0 ? mean / Math.sqrt(square) : 0;
}

module.exports = { ema, rsi, macd, sma, bollinger, atr, stochastic, adx, supertrend, directionality };
