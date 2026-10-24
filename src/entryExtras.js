// Giris/cikis ek katmanlari icin ortak yardimcilar: ayar normalizasyonu, sunucu dogrulamasi ve motor kapilari.
// Uc ozellik (hepsi varsayilan KAPALI): protections (kilitler), pairFilters (parite filtreleri), timeBarrier (zaman cikisi).
const { normalizeProtections, checkProtections, DEFAULTS: PROT_DEFAULTS } = require('./protections');
const { normalizePairFilters, checkPairFilters, DEFAULTS: FILTER_DEFAULTS } = require('./pairFilters');
const { normalizeTimeBarrier, timeBarrierExit, DEFAULTS: TB_DEFAULTS } = require('./timeBarrier');
const { normalizeForager, rankCandidates } = require('./forager');
const { directionality } = require('./indicators');

const KEYS = ['protections', 'pairFilters', 'timeBarrier', 'forager'];

function defaultExtras() {
  return {
    protections: normalizeProtections({}),
    pairFilters: normalizePairFilters({}),
    timeBarrier: normalizeTimeBarrier({}),
    forager: normalizeForager({})
  };
}

function normalizeExtras(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  settings.protections = normalizeProtections(settings.protections);
  settings.pairFilters = normalizePairFilters(settings.pairFilters);
  settings.timeBarrier = normalizeTimeBarrier(settings.timeBarrier);
  settings.forager = normalizeForager(settings.forager);
  return settings;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Sunucu yamasi dogrulamasi: tip hatasi sessizce varsayilana dusmesin, acik hata donsun.
function validateExtrasPatch(patch, current = {}) {
  const value = {};
  for (const key of KEYS) {
    if (patch[key] === undefined) continue;
    if (!isObj(patch[key])) return { error: `${key} bir nesne olmalı.` };
    const check = (obj, path) => {
      for (const [k, v] of Object.entries(obj)) {
        const here = `${path}.${k}`;
        if (isObj(v)) { const e = check(v, here); if (e) return e; }
        else if (typeof v === 'number') { if (!Number.isFinite(v)) return `${here} geçerli bir sayı olmalı.`; }
        else if (typeof v !== 'boolean') return `${here} sayı veya true/false olmalı.`;
      }
      return null;
    };
    const e = check(patch[key], key);
    if (e) return { error: e };
    const base = isObj(current[key]) ? current[key] : {};
    const merged = { ...base, ...patch[key] };
    for (const sub of Object.keys(patch[key])) {
      if (isObj(patch[key][sub])) merged[sub] = { ...(isObj(base[sub]) ? base[sub] : {}), ...patch[key][sub] };
    }
    value[key] = merged;
  }
  const norm = {};
  if (value.protections) norm.protections = normalizeProtections(value.protections);
  if (value.pairFilters) norm.pairFilters = normalizePairFilters(value.pairFilters);
  if (value.timeBarrier) norm.timeBarrier = normalizeTimeBarrier(value.timeBarrier);
  if (value.forager) norm.forager = normalizeForager(value.forager);
  return { ok: true, value: norm };
}

// Yeni alim kapisi. Engellenirse { reason } doner, serbestse null.
function entryBlock({ settings, trades, symbol, now, closedCandles, timeframeMs, referenceEquity, foragerPruned }) {
  const protCfg = normalizeProtections(settings && settings.protections);
  let adverseScore = 0;
  if (protCfg.enabled && protCfg.cooldown.enabled && protCfg.cooldown.adverseMinutes > 0 && Array.isArray(closedCandles)) {
    const d = directionality(closedCandles.map((c) => Number(c.c)), protCfg.cooldown.adverseSpanBars);
    adverseScore = d === null ? 0 : Math.max(0, -d); // yalnizca DUSUS yonlulugu cezalandirilir
  }
  const prot = checkProtections({ trades, symbol, now, config: protCfg, referenceEquity, adverseScore });
  if (prot.blocked) {
    return { reason: `koruma kilidi (${prot.rule}/${prot.scope}): ${prot.reason}`, until: prot.until, rule: prot.rule };
  }
  const f = checkPairFilters({ closedCandles, timeframeMs, config: settings && settings.pairFilters });
  if (!f.ok) return { reason: `parite filtresi (${f.rule}): ${f.reason}`, rule: f.rule };
  if (foragerPruned && typeof foragerPruned.has === 'function' && foragerPruned.has(symbol)) {
    return { reason: `forager: düşük hacimli aday (alt %${normalizeForager(settings && settings.forager).volumeDropPct}) yeni alımdan elendi`, rule: 'forager' };
  }
  return null;
}

// Parite isleme sirasi: forager aciksa skora gore, degilse girdi sirasi. Donus: { order, pruned }.
function foragerPlan(settings, candidates) {
  const r = rankCandidates(candidates, settings && settings.forager);
  return { order: r.order, pruned: r.pruned, scores: r.scores };
}

module.exports = { KEYS, defaultExtras, normalizeExtras, validateExtrasPatch, entryBlock, foragerPlan, timeBarrierExit, PROT_DEFAULTS, FILTER_DEFAULTS, TB_DEFAULTS };
