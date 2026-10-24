// src/execution.js
//
// Backtest (src/backtest/simulator.js) ile KAGIT motorun (src/paperEngine.js)
// ORTAK kullandigi yurutme kurallari. Iki taraf ayni fonksiyonlari cagirdigi icin
// "backtest'te boyle olurdu" ile "kagit islemde boyle oldu" birbirinden kopmaz
// (bkz. test/parity.test.js: ayni veriyi iki tarafa da verip sonuclari karsilastirir).

// Kayma (slippage): alimda fiyat yukari, satimda asagi kayar.
const buyFill = (ref, slipPct) => ref * (1 + slipPct / 100);
const sellFill = (ref, slipPct) => ref * (1 - slipPct / 100);

// Kâr koruma devreye girdikten sonra stop, gerçek maliyetin altına inmez.
//
// Eskiden sabit %0.20 tampon kullanılıyordu; varsayılan komisyon (%0.10) ve kayma (%0.05)
// ile satış maliyeti bunu aşıyordu, yani "break-even" stop gerçekte ~−%0.05 zararla
// satıyordu (komisyon %0.35 olursa −%0.55). Tampon artık pozisyonun AÇILDIĞI andaki
// komisyon ve kaymadan hesaplanır (bkz. breakEvenBufferPct) ve position.breakEvenBufferPct
// alanında saklanır; böylece strateji, paper motor ve backtest aynı değeri kullanır.
//
// Dolum modeli: entryPrice zaten alım kaymasını içerir (entry = ref*(1+slip)).
//   alış maliyeti  = qty * entry * (1 + fee)
//   stop'ta satış  = qty * stop * (1 - slip) * (1 - fee)
//   başabaş        => stop >= entry * (1 + fee) / ((1 - slip) * (1 - fee))
// Üzerine küçük bir güvenlik payı eklenir ki stop tetiklenince net sonuç ≥ 0 olsun.
const BREAKEVEN_BUFFER_PCT = 0.20; // maliyet bilgisi hiç yoksa kullanılan eski varsayılan
const BREAKEVEN_MARGIN_PCT = 0.05; // gerçek maliyetin üzerine eklenen güvenlik payı
const breakEvenBufferPct = (feePct, slippagePct, marginPct = BREAKEVEN_MARGIN_PCT) => {
  const fee = Number(feePct) / 100;
  const slip = Number(slippagePct) / 100;
  const margin = Number(marginPct);
  if (!Number.isFinite(fee) || !Number.isFinite(slip) || fee < 0 || slip < 0 || fee >= 1 || slip >= 1) return BREAKEVEN_BUFFER_PCT;
  const ratio = (1 + fee) / ((1 - slip) * (1 - fee));
  const pct = (ratio - 1) * 100 + (Number.isFinite(margin) && margin >= 0 ? margin : BREAKEVEN_MARGIN_PCT);
  return Number.isFinite(pct) && pct >= 0 ? pct : BREAKEVEN_BUFFER_PCT;
};
const profitProtectionStop = (entryPrice, highWaterMark, stopLossPct, breakEvenActive = true, bufferPct = BREAKEVEN_BUFFER_PCT) => {
  const trailingStop = highWaterMark * (1 - Number(stopLossPct) / 100);
  if (!breakEvenActive) return trailingStop;
  const buffer = Number.isFinite(Number(bufferPct)) && Number(bufferPct) >= 0 ? Number(bufferPct) : BREAKEVEN_BUFFER_PCT;
  const breakEvenFloor = entryPrice * (1 + buffer / 100);
  return Math.max(trailingStop, breakEvenFloor);
};

// Tek bir mum ICINDE stop-loss / take-profit / trailing stop kontrolu.
//  * Fiyat stop'un altinda ACILIRSA (bosluk) dolum acilis fiyatindan olur.
//  * Ayni mumda hem stop hem take-profit mumkunse STOP kabul edilir (kotu senaryo).
//  * Trailing icin mum ici sira bilinmez: onceki zirve (highWaterMark) esas alinir.
// commit=true  -> mum KAPANMIS: zirve (highWaterMark) bu mumun yuksegiyle guncellenir.
// commit=false -> mum hala OLUSUYOR: zirve degistirilmez (mum kapaninca commit ile yeniden bakilir).
// Donus: { ref, reason } (cikis referans fiyati, kayma OLMADAN) ya da null.
function intrabarRiskExit(pos, candle, params, commit = true) {
  const trailing = !!params.trailingStop;
  const sl = Number(params.stopLossPct);
  const tp = Number(params.takeProfitPct);
  if (!Number.isFinite(pos.highWaterMark)) pos.highWaterMark = pos.entryPrice;
  const previousHighWaterMark = pos.highWaterMark;
  const activation = Number.isFinite(tp) && tp > 0
    ? pos.entryPrice * (1 + tp / 100)
    : Infinity;

  // Aynı mumda önce zirveyi görüp sonra yeni stopu çalıştırmak ileriye bakış
  // yaratır. Bu nedenle risk kontrolü önce önceki stop ile yapılır; yeni zirve
  // ancak mumun risk kontrolünden sonra bir sonraki mum için referans olur.
  const profitLockActiveBefore = trailing || previousHighWaterMark >= activation;
  let stopLevel = pos.stopPrice;
  if (profitLockActiveBefore && Number.isFinite(sl)) {
    const trailingLevel = profitProtectionStop(pos.entryPrice, previousHighWaterMark, sl, previousHighWaterMark >= activation, pos.breakEvenBufferPct);
    // Never loosen a tighter initial/strategy-specific stop (for example ATR).
    stopLevel = Number.isFinite(stopLevel) ? Math.max(stopLevel, trailingLevel) : trailingLevel;
  }

  if (Number.isFinite(stopLevel) && candle.l <= stopLevel) {
    const ref = Number.isFinite(candle.o) && candle.o <= stopLevel ? candle.o : stopLevel;
    return { ref, reason: (profitLockActiveBefore && stopLevel >= pos.entryPrice) ? 'profit-protection stop' : 'stop-loss' };
  }

  // Mum güvenli şekilde tamamlandıktan sonra yeni zirveyi kaydet. Bu değer
  // sonraki mumdaki stop seviyesini yükseltir; aynı mumun dibini yeniden taramayız.
  if (commit && Number.isFinite(candle.h) && candle.h > pos.highWaterMark &&
      (trailing || candle.h >= activation || previousHighWaterMark >= activation)) {
    pos.highWaterMark = candle.h;
  }
  return null;
}

function stepDecimals(step) {
  const s = String(step);
  if (s.includes('e-')) {
    const [mant, exp] = s.split('e-');
    return parseInt(exp, 10) + ((mant.split('.')[1] || '').length);
  }
  return (s.split('.')[1] || '').length;
}

// Miktari borsanin adim (stepSize) degerine ASAGI yuvarlar. step yoksa dokunmaz.
function roundDownToStep(qty, step) {
  if (!Number.isFinite(qty) || qty < 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return qty;
  const decimals = stepDecimals(step);
  let n = Math.floor(qty / step + 1e-9);
  let rounded = Number((n * step).toFixed(decimals));
  // The epsilon above repairs binary representation of exact multiples (0.3 / 0.1),
  // but must never turn a genuinely smaller budget into a larger order quantity.
  while (n > 0 && rounded > qty) {
    n--;
    rounded = Number((n * step).toFixed(decimals));
  }
  return rounded;
}

// Borsaya giden miktar/fiyat degerlerini DUZ ondalik yazi olarak biçimler.
// JS, 1e-7 gibi kucuk sayilari ussel gosterimle ("1e-7") ve kayan nokta artiklarini
// ("0.30000000000000004") yazdirir; Binance bunlari "precision" hatasiyla reddeder.
// Miktarlar borsa adimina onceden ASAGI yuvarlanmis olmalidir; burada yalnizca gosterim duzeltilir.
function plainDecimal(value, maxDecimals = 8) {
  // Exchange fields must be positive decimal strings. Do not round quantities
  // upward or coerce missing/boolean/hex values into plausible order values.
  const isDecimalString = typeof value === 'string'
    && value.trim() !== ''
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim());
  if (!(typeof value === 'number' || isDecimalString)) {
    throw new Error(`Geçersiz sayı: ${value}`);
  }
  if (!Number.isInteger(maxDecimals) || maxDecimals < 0 || maxDecimals > 100) {
    throw new RangeError('maxDecimals 0 ile 100 arasında tam sayı olmalı.');
  }

  // Number is used only to reject NaN/Infinity/non-positive input. Formatting
  // itself is performed on decimal text: toFixed() rounds first and can carry
  // into the retained digits, defeating a later slice/truncation.
  const numeric = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Geçersiz sayı: ${value}`);
  }

  const raw = String(typeof value === 'number' ? value : value.trim()).toLowerCase();
  const [mantissa, exponentText] = raw.split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const unsigned = mantissa.replace(/^[+]/, '');
  const dot = unsigned.indexOf('.');
  const decimalPosition = (dot === -1 ? unsigned.length : dot) + exponent;
  const digits = unsigned.replace('.', '');
  let integer;
  let fraction;
  if (decimalPosition <= 0) {
    integer = '0';
    fraction = '0'.repeat(-decimalPosition) + digits;
  } else if (decimalPosition >= digits.length) {
    integer = digits + '0'.repeat(decimalPosition - digits.length);
    fraction = '';
  } else {
    integer = digits.slice(0, decimalPosition);
    fraction = digits.slice(decimalPosition);
  }

  integer = integer.replace(/^0+(?=\d)/, '') || '0';
  fraction = fraction.slice(0, maxDecimals).replace(/0+$/, '');
  const result = fraction ? `${integer}.${fraction}` : integer;
  if (!result || !/[1-9]/.test(result)) {
    throw new Error(`Sayı ondalık hassasiyetle sıfıra düşüyor: ${value}`);
  }
  return result;
}

// Mum listesini "kapanmis" ve "olusan (forming)" olarak ayirir. Mum araligi, son mumlar
// arasindaki farktan (medyan) bulunur: boylece adaptor istenenden farkli aralik dondurse
// bile (ornegin BTCTurk gunluk mum) dogru calisir.
function timeframeMs(timeframe) {
  const m = String(timeframe || '').match(/^(\d+)(m|h|d|w)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'm' ? 60e3 : unit === 'h' ? 3600e3 : unit === 'd' ? 86400e3 : 604800e3;
  return n * mult;
}

function splitCandles(candles, now, timeframe = '') {
  const n = candles.length;
  if (n < 2) return { closed: candles.slice(), forming: null, step: timeframeMs(timeframe) || null };
  // Prefer the explicitly configured interval. Inferring it from recent timestamp
  // deltas is unsafe when an exchange omits a candle: a 2x gap can make an old
  // candle look like the currently-forming candle and distort signal freshness.
  const expected = timeframeMs(timeframe);
  const diffs = [];
  for (let i = Math.max(1, n - 5); i < n; i++) {
    const delta = Number(candles[i].t) - Number(candles[i - 1].t);
    if (Number.isFinite(delta) && delta > 0) diffs.push(delta);
  }
  diffs.sort((a, b) => a - b);
  const inferred = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null;
  const step = expected || inferred;
  const last = candles[n - 1];
  const lastOpen = Number(last && last.t);
  const forming = Number.isFinite(lastOpen) && step > 0 && lastOpen + step > now ? last : null;
  return { closed: forming ? candles.slice(0, -1) : candles, forming, step };
}


function validateCandleSeries(candles, timeframe = '') {
  if (!Array.isArray(candles)) throw new Error('Candle cevabı dizi değil.');
  let previous = -Infinity;
  const expected = timeframeMs(timeframe);
  let step = null;
  let minDelta = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i] || {};
    const t = Number(c.t), o = Number(c.o), h = Number(c.h), l = Number(c.l), close = Number(c.c), v = Number(c.v);
    if (![t,o,h,l,close,v].every(Number.isFinite)) throw new Error(`Geçersiz candle sayısal verisi (index ${i}).`);
    if (!(t >= 0) || (i > 0 && t <= previous)) throw new Error(`Candle timestamp sırası geçersiz (index ${i}).`);
    if (i > 0) {
      const d = t - previous;
      if (!(d > 0)) throw new Error(`Candle aralığı geçersiz (index ${i}).`);
      if (d < minDelta) minDelta = d;
      if (expected > 0) {
        // Eksik mum (bakım / işlem yok) mum süresinin TAM KATIDIR: kabul edilir. Hizasız aralık reddedilir.
        if (Math.abs(d - Math.round(d / expected) * expected) > Math.max(1000, expected * 0.001)) throw new Error(`Candle aralığı tutarsız (index ${i}).`);
      } else {
        if (step === null) step = d;
        else if (Math.abs(d - step) > Math.max(1, step * 0.001)) throw new Error(`Candle aralığı tutarsız (index ${i}).`);
      }
    }
    if (!(h >= o && h >= close && h >= l && l <= o && l <= close && h >= l && v >= 0)) throw new Error(`OHLCV invariant ihlali (index ${i}).`);
    previous = t;
  }
  // En az bir ardışık çift tam mum süresi olmalı; aksi halde borsa yanlış timeframe döndürmüştür.
  if (expected > 0 && Number.isFinite(minDelta) && Math.abs(minDelta - expected) > Math.max(1000, expected * 0.001)) {
    throw new Error(`Borsa yanlış timeframe döndürdü: beklenen ${timeframe}, ölçülen ${minDelta}ms.`);
  }
  return candles;
}

module.exports = { buyFill, sellFill, intrabarRiskExit, roundDownToStep, splitCandles, timeframeMs, plainDecimal, validateCandleSeries, BREAKEVEN_BUFFER_PCT, BREAKEVEN_MARGIN_PCT, breakEvenBufferPct, profitProtectionStop };
