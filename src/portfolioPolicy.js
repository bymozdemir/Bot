// User-defined portfolio policy. No fixed "5+5" (or similar) portfolio is assumed.
// A pair belongs to a user-selected bucket (core/speculative by default), and each
// bucket can independently cap position count and capital share. Zero = unlimited.
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const BUCKET_KEY_RE = /^[a-zA-Z0-9_-]{1,32}$/;
// Prototype zinciri anahtarlari (constructor, __proto__ ...) kova adi olamaz.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isValidBucketKey = (k) => typeof k === 'string' && BUCKET_KEY_RE.test(k) && !RESERVED_KEYS.has(k);

function defaultPortfolioPolicy() {
  return {
    maxPositions: 3,
    reserveCashPct: 10,
    buckets: {
      core: { label: 'Ana', maxPositions: 0, maxCapitalPct: 100 },
      speculative: { label: 'Spekülatif', maxPositions: 0, maxCapitalPct: 100 }
    }
  };
}

function normalizePortfolioPolicy(input) {
  const d = defaultPortfolioPolicy();
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const n = (v, fallback, min, max, integer=false) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < min || x > max || (integer && !Number.isInteger(x))) return fallback;
    return x;
  };
  const out = {
    maxPositions: n(src.maxPositions, d.maxPositions, 1, 100, true),
    reserveCashPct: n(src.reserveCashPct, d.reserveCashPct, 0, 90),
    buckets: {}
  };
  const buckets = src.buckets && typeof src.buckets === 'object' && !Array.isArray(src.buckets) ? src.buckets : {};
  for (const key of Object.keys({...d.buckets, ...buckets})) {
    if (!isValidBucketKey(key)) continue; // __proto__ / constructor gibi anahtarlar sessizce atilir
    const b = hasOwn(buckets, key) && buckets[key] && typeof buckets[key] === 'object' ? buckets[key] : {};
    const base = hasOwn(d.buckets, key) ? d.buckets[key] : { label: key, maxPositions: 0, maxCapitalPct: 100 };
    out.buckets[key] = {
      label: typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0,40) : base.label,
      maxPositions: n(b.maxPositions, base.maxPositions, 0, 100, true),
      maxCapitalPct: n(b.maxCapitalPct, base.maxCapitalPct, 0, 100)
    };
  }
  return out;
}

function pairBucket(pair, policy) {
  const key = String(pair?.portfolioClass || 'core').trim() || 'core';
  if (!hasOwn(policy.buckets, key)) return 'core';
  return key;
}

function portfolioExposureByBucket(positions, pairs, bucketKey, policy) {
  let total = 0, count = 0;
  for (const [symbol, pos] of Object.entries(positions || {})) {
    if (pairBucket(pairs?.[symbol], policy) !== bucketKey) continue;
    const cost = Number(pos?.costQuote ?? pos?.costUSDT ?? (Number(pos?.quantity)*Number(pos?.entryPrice)));
    if (Number.isFinite(cost) && cost > 0) total += cost;
    count++;
  }
  return { total, count };
}

function canOpenPosition({ symbol, pair, positions, pairs, policy, equity, requestedCost }) {
  const p = normalizePortfolioPolicy(policy);
  const bucket = pairBucket(pair, p);
  const b = p.buckets[bucket];
  const openCount = Object.keys(positions || {}).length;
  if (openCount >= p.maxPositions) return { ok:false, reason:'portföy maksimum açık pozisyon sınırı dolu', bucket };
  const current = portfolioExposureByBucket(positions, pairs, bucket, p);
  if (b.maxPositions > 0 && current.count >= b.maxPositions) return { ok:false, reason:`${b.label} grubu maksimum pozisyon sınırı dolu`, bucket };
  const cost = Number(requestedCost);
  if (!(cost > 0) || !(Number(equity) > 0)) return { ok:false, reason:'geçersiz portföy tutarı', bucket };
  if (b.maxCapitalPct > 0 && current.total + cost > Number(equity) * b.maxCapitalPct / 100 + 1e-9) {
    return { ok:false, reason:`${b.label} grubu sermaye üst sınırı aşılır`, bucket };
  }
  return { ok:true, bucket };
}

module.exports = { isValidBucketKey, hasOwn, defaultPortfolioPolicy, normalizePortfolioPolicy, pairBucket, portfolioExposureByBucket, canOpenPosition };
