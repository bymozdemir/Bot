// Finansal muhasebe yardımcıları.
// Amaç: borsadan gelen gross dolum ile hesabın gerçekten kullanılabilir
// miktarını birbirinden ayırmak.

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// commissionTotal yalnizca tek varlikta anlamlidir. Farkli varlik miktarlarini
// (ornegin BTC + USDT) toplamak parasal bir toplam degildir; coklu varlikta null doner.
function commissionTotalForSingleAsset(byAsset = {}) {
  const entries = Object.entries(byAsset).filter(([, amount]) => safeNum(amount) > 0);
  if (entries.length === 0) return 0;
  if (entries.length > 1) return null;
  return safeNum(entries[0][1]);
}

function aggregateCommissions(fills = [], existing = {}) {
  const byAsset = { ...(existing.byAsset || {}) };
  for (const fill of fills || []) {
    const amount = safeNum(fill?.commission, NaN);
    if (!Number.isFinite(amount) || amount < 0) continue;
    const asset = String(fill?.commissionAsset || '').toUpperCase();
    if (!asset) continue;
    byAsset[asset] = safeNum(byAsset[asset]) + amount;
  }
  return { total: commissionTotalForSingleAsset(byAsset), byAsset };
}

function addExecutionCommission(existing, asset, amount) {
  const byAsset = { ...(existing?.byAsset || {}) };
  const a = String(asset || '').toUpperCase();
  const n = safeNum(amount, NaN);
  if (!a || !Number.isFinite(n) || n < 0) return { total: commissionTotalForSingleAsset(byAsset), byAsset };
  byAsset[a] = safeNum(byAsset[a]) + n;
  return { total: commissionTotalForSingleAsset(byAsset), byAsset };
}

function commissionInAsset(commission, asset) {
  return safeNum(commission?.byAsset?.[String(asset || '').toUpperCase()]);
}

function nonPairCommissionAssets(commission, baseAsset, quoteAsset) {
  const base = String(baseAsset || '').toUpperCase();
  const quote = String(quoteAsset || '').toUpperCase();
  return Object.entries(commission?.byAsset || {})
    .filter(([asset, amount]) => asset !== base && asset !== quote && safeNum(amount) > 0)
    .map(([asset, amount]) => ({ asset, amount: safeNum(amount) }));
}

function quoteValueOfAsset(amount, assetToQuotePrice, quoteToAssetPrice) {
  const n = Math.max(0, safeNum(amount));
  if (n <= 0) return 0;
  const direct = Number(assetToQuotePrice);
  if (Number.isFinite(direct) && direct > 0) return n * direct;
  const inverse = Number(quoteToAssetPrice);
  if (Number.isFinite(inverse) && inverse > 0) return n / inverse;
  return null;
}

function totalThirdAssetCommission(commission, baseAsset, quoteAsset, prices = {}) {
  const items = nonPairCommissionAssets(commission, baseAsset, quoteAsset);
  let total = 0;
  for (const item of items) {
    const v = quoteValueOfAsset(item.amount, prices?.[item.asset]?.direct, prices?.[item.asset]?.inverse);
    if (v === null) return { complete: false, value: null, items };
    total += v;
  }
  return { complete: true, value: total, items };
}

// Alışta base komisyonu, hesabın eline geçen kullanılabilir coin miktarını azaltır.
function netBaseReceived(side, grossExecutedQty, baseAsset, commission) {
  const gross = Math.max(0, safeNum(grossExecutedQty));
  if (String(side).toLowerCase() !== 'buy') return gross;
  return Math.max(0, gross - commissionInAsset(commission, baseAsset));
}

// Satışta pozisyon muhasebesi gross executedQty üzerinden yapılır: satılan coin
// miktarı budur. Base komisyonu ayrıca komisyon varlığı olarak kaydedilir.
function positionReductionOnSell(grossExecutedQty, baseCommission = 0) {
  return Math.max(0, safeNum(grossExecutedQty) + Math.max(0, safeNum(baseCommission)));
}

function netQuoteFlow(side, grossQuoteQty, quoteAsset, commission) {
  const gross = Math.max(0, safeNum(grossQuoteQty));
  const quoteFee = commissionInAsset(commission, quoteAsset);
  if (String(side).toLowerCase() === 'buy') return gross + quoteFee;
  if (String(side).toLowerCase() === 'sell') return Math.max(0, gross - quoteFee);
  return gross;
}

function proportionalCostBasis(position, soldQty) {
  const qty = Math.max(0, safeNum(position?.quantity));
  const cost = Math.max(0, safeNum(position?.costQuote));
  const sold = Math.min(qty, Math.max(0, safeNum(soldQty)));
  if (!(qty > 0) || !(sold > 0)) return 0;
  return cost * (sold / qty);
}

function realizedPnl(position, positionOutflowQty, netQuoteProceeds) {
  const costBasis = proportionalCostBasis(position, positionOutflowQty);
  const proceeds = Math.max(0, safeNum(netQuoteProceeds));
  return { proceeds, costBasis, pnl: proceeds - costBasis };
}

module.exports = {
  safeNum,
  commissionTotalForSingleAsset,
  aggregateCommissions,
  addExecutionCommission,
  commissionInAsset,
  nonPairCommissionAssets,
  quoteValueOfAsset,
  totalThirdAssetCommission,
  netBaseReceived,
  positionReductionOnSell,
  netQuoteFlow,
  proportionalCostBasis,
  realizedPnl
};
