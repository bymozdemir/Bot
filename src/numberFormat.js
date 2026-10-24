'use strict';

// UI/log formatting only. Never use these strings in calculations or comparisons.
function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });
  if (a >= 1) return n.toFixed(4).replace(/\.?0+$/, '');
  // Preserve at least 8 decimal places, and enough extra places to show tiny tokens.
  const decimals = Math.min(30, Math.max(8, Math.ceil(-Math.log10(a)) + 6));
  return n.toFixed(decimals).replace(/\.?0+$/, '');
}

function formatQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  // Keep small token amounts visible; significant digits avoid long meaningless tails.
  return n.toLocaleString('en-US', {
    useGrouping: true,
    maximumSignificantDigits: 12,
    maximumFractionDigits: 30
  });
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(8).replace(/\.?0+$/, '') : String(value);
}

module.exports = { formatPrice, formatQuantity, formatMoney };
