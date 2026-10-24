// src/strategies/riskExit.js
// Her stratejinin ortak ihtiyaci: pozisyon acikken stop-loss / take-profit /
// trailing stop kontrolu. Stratejiler bunu indikator hesabindan ONCE cagirir
// (riskExitFirst), boylece veri yetersiz ya da indikator henuz hesaplanamamis
// olsa bile acik pozisyonun stop-loss'u ASLA atlanmaz.
//
// position nesnesini yerinde (mutate) gunceller: trailing stop acikken
// highWaterMark yukselir. Bu paperEngine.js'teki position referansiyla
// paylasilir, ayrica kaydetmeye gerek yok.

const { profitProtectionStop, BREAKEVEN_BUFFER_PCT } = require('../execution');

function checkRiskExit(position, price, params) {
  if (!position || !Number.isFinite(price)) return null;
  const trailing = !!params.trailingStop;
  const sl = Number(params.stopLossPct);
  const tp = Number(params.takeProfitPct);

  if (!Number.isFinite(position.highWaterMark)) position.highWaterMark = position.entryPrice;

  const activation = Number.isFinite(tp) && tp > 0
    ? position.entryPrice * (1 + tp / 100)
    : Infinity;
  const wasProfitLocked = trailing || position.highWaterMark >= activation;
  if ((trailing || wasProfitLocked || price >= activation) && price > position.highWaterMark) {
    position.highWaterMark = price;
  }

  let effectiveStop = position.stopPrice;
  const profitLockActive = trailing || position.highWaterMark >= activation;
  if (profitLockActive && Number.isFinite(sl)) {
    const trailingStop = position.highWaterMark * (1 - sl / 100);
    // Tampon pozisyonun acildigi andaki komisyon/kaymadan gelir (yoksa eski %0.20 varsayilani).
    const bufferPct = Number.isFinite(Number(position.breakEvenBufferPct)) && Number(position.breakEvenBufferPct) >= 0 ? Number(position.breakEvenBufferPct) : BREAKEVEN_BUFFER_PCT;
    const breakEvenFloor = position.entryPrice * (1 + bufferPct / 100);
    const naturalBreakEven = trailingStop >= breakEvenFloor;
    const tpBreakEven = Number.isFinite(activation) && position.highWaterMark >= activation;
    const profitStop = profitProtectionStop(position.entryPrice, position.highWaterMark, sl, tpBreakEven || naturalBreakEven, position.breakEvenBufferPct);
    // Shared stop calculation keeps strategy exits and PaperEngine protection aligned.
    effectiveStop = Number.isFinite(effectiveStop) ? Math.max(effectiveStop, profitStop) : profitStop;
  }
  if (Number.isFinite(effectiveStop) && price <= effectiveStop) {
    return { action: 'sell', reason: (profitLockActive && effectiveStop >= position.entryPrice) ? 'profit-protection stop tetiklendi' : 'stop-loss tetiklendi', price };
  }

  // takeProfitPct artık doğrudan satış hedefi değildir. Eşik aşıldığında
  // yüksek fiyat referansı güncellenir ve stopLossPct kadar geri çekilme
  // pozisyonu tamamen kapatır. Stratejinin kendi SAT sinyali ayrıca çalışabilir.
  return null;
}

// Stratejilerin evaluate() fonksiyonunun EN BASINDA cagrilir: mum sayisi
// yetersiz olsa bile son mumun kapanisi ile risk kurallarini kontrol eder.
function riskExitFirst(candles, position, params) {
  if (!position || !Array.isArray(candles) || candles.length === 0) return null;
  return checkRiskExit(position, candles[candles.length - 1].c, params);
}

module.exports = { checkRiskExit, riskExitFirst };
