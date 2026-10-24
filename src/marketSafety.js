// Canli market emirleri icin public order-book on kontrolu.
// Bu kontrol bir garantili fill fiyatı degildir: emir gonderildikten sonra
// defter degisebilir. Amaci kotu spread / yetersiz derinlik / buyuk tahmini
// price impact durumlarinda emri daha gondermeden reddetmektir.

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

function normalizeLevels(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(x => Array.isArray(x) ? [n(x[0]), n(x[1])] : [n(x.price), n(x.quantity ?? x.qty ?? x.amount)])
    .filter(([p,q]) => p > 0 && q > 0);
}

function estimate(book, side, { baseQty = 0, quoteQty = 0, marketBuyUsesQuote = false } = {}) {
  const asks = normalizeLevels(book?.asks).sort((a,b)=>a[0]-b[0]);
  const bids = normalizeLevels(book?.bids).sort((a,b)=>b[0]-a[0]);
  if (!asks.length || !bids.length) throw new Error('order book bid/ask verisi bos.');
  const bestBid = bids[0][0], bestAsk = asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spreadPct = mid > 0 ? (bestAsk - bestBid) / mid * 100 : Infinity;
  const levels = String(side).toLowerCase() === 'buy' ? asks : bids;
  const targetBase = String(side).toLowerCase() === 'buy' && marketBuyUsesQuote ? null : n(baseQty);
  const targetQuote = String(side).toLowerCase() === 'buy' && marketBuyUsesQuote ? n(quoteQty) : null;
  if (!(targetBase > 0 || targetQuote > 0)) throw new Error('market safety hedef miktari gecersiz.');

  let remainingBase = targetBase;
  let remainingQuote = targetQuote;
  let filledBase = 0, spentQuote = 0;
  for (const [price, qty] of levels) {
    if (remainingBase !== null) {
      const take = Math.min(qty, remainingBase);
      filledBase += take; spentQuote += take * price; remainingBase -= take;
      if (remainingBase <= 1e-12) break;
    } else {
      const takeBase = Math.min(qty, remainingQuote / price);
      filledBase += takeBase; spentQuote += takeBase * price; remainingQuote -= takeBase * price;
      if (remainingQuote <= 1e-9) break;
    }
  }
  const targetNotional = targetQuote !== null ? targetQuote : targetBase * (String(side).toLowerCase() === 'buy' ? bestAsk : bestBid);
  const availableNotional = levels.reduce((sum,[p,q]) => sum + p*q, 0);
  const coverage = targetNotional > 0 ? availableNotional / targetNotional : 0;
  const filledTarget = targetBase !== null ? filledBase / targetBase : (targetQuote > 0 ? spentQuote / targetQuote : 0);
  if (filledTarget < 0.999999) throw new Error(`order book derinligi yetersiz (coverage=${coverage.toFixed(2)}x).`);
  const avgPrice = filledBase > 0 ? spentQuote / filledBase : 0;
  const impactPct = String(side).toLowerCase() === 'buy'
    ? (avgPrice / bestAsk - 1) * 100
    : (1 - avgPrice / bestBid) * 100;
  return { bestBid, bestAsk, mid, spreadPct, avgPrice, impactPct, filledBase, spentQuote, coverage };
}

function checkMarketOrderSafety({ book, side, baseQty, quoteQty, marketBuyUsesQuote, maxSpreadPct = 0.75, maxSlippagePct = 0.50, minDepthCoverage = 1.25 }) {
  const e = estimate(book, side, { baseQty, quoteQty, marketBuyUsesQuote });
  const errors = [];
  if (!(e.spreadPct >= 0) || e.spreadPct > maxSpreadPct) errors.push(`spread %${e.spreadPct.toFixed(4)} > izin %${maxSpreadPct}`);
  if (!(e.impactPct >= 0) || e.impactPct > maxSlippagePct) errors.push(`tahmini market etkisi %${e.impactPct.toFixed(4)} > izin %${maxSlippagePct}`);
  if (!(e.coverage >= minDepthCoverage)) errors.push(`derinlik ${e.coverage.toFixed(2)}x < ${minDepthCoverage}x`);
  return { ok: errors.length === 0, errors, ...e };
}

module.exports = { checkMarketOrderSafety, estimate };
