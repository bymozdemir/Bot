'use strict';

// Single source of truth for Paper mark-to-market and estimated liquidation equity.
// Values are always isolated by quote asset; never add TRY and USDT together.
function quoteOf(symbol, position, fallback = 'USDT') {
  return String(position?.quoteAsset || String(symbol || '').split('/')[1] || fallback).toUpperCase();
}
function markToMarketByQuote({ cashByAsset = {}, positions = {}, lastPrices = {}, fallbackQuote = 'USDT' } = {}) {
  const out = {};
  for (const [asset, amount] of Object.entries(cashByAsset || {})) {
    const n = Number(amount);
    out[String(asset).toUpperCase()] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  for (const [symbol, pos] of Object.entries(positions || {})) {
    const quote = quoteOf(symbol, pos, fallbackQuote);
    const cachedPrice = Number(lastPrices?.[symbol]);
    const entryPrice = Number(pos?.entryPrice);
    const price = Number.isFinite(cachedPrice) && cachedPrice > 0 ? cachedPrice : entryPrice;
    const qty = Number(pos?.quantity);
    if (!(price > 0) || !(qty > 0) || !Number.isFinite(price) || !Number.isFinite(qty)) continue;
    out[quote] = (out[quote] || 0) + qty * price;
  }
  return out;
}
function quoteEquity({ quote, cashByAsset = {}, positions = {}, lastPrices = {}, feeRate = 0, slippagePct = 0, liquidation = false, fallbackQuote = 'USDT' } = {}) {
  const q = String(quote || fallbackQuote).toUpperCase();
  const rawCash = Number(cashByAsset?.[q]);
  let total = Number.isFinite(rawCash) && rawCash > 0 ? rawCash : 0;
  const fee = Number.isFinite(Number(feeRate)) && Number(feeRate) >= 0 ? Number(feeRate) : 0;
  const slip = Number.isFinite(Number(slippagePct)) && Number(slippagePct) >= 0 ? Number(slippagePct) / 100 : 0;
  for (const [symbol, pos] of Object.entries(positions || {})) {
    if (quoteOf(symbol, pos, q) !== q) continue;
    const cachedPrice = Number(lastPrices?.[symbol]);
    const entryPrice = Number(pos?.entryPrice);
    const price = Number.isFinite(cachedPrice) && cachedPrice > 0 ? cachedPrice : entryPrice;
    const qty = Number(pos?.quantity);
    if (!(price > 0) || !(qty > 0) || !Number.isFinite(price) || !Number.isFinite(qty)) continue;
    total += qty * (liquidation ? price * (1 - slip) * (1 - fee) : price);
  }
  return Number.isFinite(total) && total >= 0 ? total : 0;
}
module.exports = { quoteOf, markToMarketByQuote, quoteEquity };
