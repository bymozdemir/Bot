const { roundDownToStep } = require('./execution');

function validateMarketOrder({ rules, side, amount, price }) {
  const r = rules || {};
  const qty = Number(amount);
  const px = Number(price);
  const errors = [];
  if (!(qty > 0) || !Number.isFinite(qty)) errors.push('quantity');
  if (!(px > 0) || !Number.isFinite(px)) errors.push('price');
  const step = Number(r.marketStepSize || r.stepSize || 0);
  const minQty = Number(r.marketMinQty || r.minQty || 0);
  const maxQty = Number(r.marketMaxQty || r.maxQty || 0);
  if (step > 0 && Math.abs(qty - roundDownToStep(qty, step)) > Math.max(1e-12, step * 1e-9)) errors.push('stepSize');
  if (minQty > 0 && qty + 1e-12 < minQty) errors.push('minQty');
  if (maxQty > 0 && qty - 1e-12 > maxQty) errors.push('maxQty');
  const notional = qty * px;
  const minNotional = Number(r.minNotional || 0);
  const maxNotional = Number(r.maxNotional || 0);
  if (minNotional > 0 && r.minNotionalAppliesToMarket !== false && notional + 1e-9 < minNotional) errors.push('minNotional');
  if (maxNotional > 0 && r.maxNotionalAppliesToMarket !== false && notional - 1e-9 > maxNotional) errors.push('maxNotional');
  if (r.minPrice > 0 && px < Number(r.minPrice)) errors.push('minPrice');
  if (r.maxPrice > 0 && px > Number(r.maxPrice)) errors.push('maxPrice');
  const pr = r.priceRange || {};
  if (r.referencePrice > 0) {
    const ref = Number(r.referencePrice);
    const up = String(side).toLowerCase() === 'buy' ? Number(pr.bidMultiplierUp || 0) : Number(pr.askMultiplierUp || 0);
    const down = String(side).toLowerCase() === 'buy' ? Number(pr.bidMultiplierDown || 0) : Number(pr.askMultiplierDown || 0);
    if (up > 0 && px > ref * up) errors.push('priceRangeUp');
    if (down > 0 && px < ref * down) errors.push('priceRangeDown');
  }
  return { ok: errors.length === 0, errors, notional };
}

module.exports = { validateMarketOrder };
