// Koruma katmani (Freqtrade protections'tan esinlenildi, JS'e sifirdan uyarlandi).
//
// Tasarim: DURUMSUZ. Kilitler ayri bir dosyada saklanmaz; kapanmis islem gecmisinden
// (paper.trades / live.trades) her seferinde yeniden hesaplanir. Boylece yeniden baslatmada
// kilit kaybolmaz ve state.json semasi degismez.
//
// YALNIZCA YENI ALIMLARI engeller. Acik pozisyonlarin stop/cikis akisina dokunmaz.
// Varsayilan: kapali (settings.protections.enabled=false).

const MIN = 60 * 1000;

const DEFAULTS = Object.freeze({
  enabled: false,
  cooldown: { enabled: true, minutes: 60, adverseMinutes: 0, adverseSpanBars: 20, maxMinutes: 24 * 60 },
  stoplossGuard: { enabled: true, tradeLimit: 3, lookbackMinutes: 24 * 60, lockMinutes: 120, requiredProfitPct: 0, onlyPerPair: false },
  maxDrawdown: { enabled: true, tradeLimit: 5, lookbackMinutes: 48 * 60, maxDrawdownPct: 8, lockMinutes: 240 },
  lowProfitPairs: { enabled: false, tradeLimit: 4, lookbackMinutes: 24 * 60, requiredProfitPct: 0, lockMinutes: 360 }
});

const num = (v, fallback, min, max, integer = false) => {
  const x = Number(v);
  if (!Number.isFinite(x) || x < min || x > max || (integer && !Number.isInteger(x))) return fallback;
  return x;
};
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function normalizeProtections(input) {
  const src = obj(input);
  const d = DEFAULTS;
  const cd = obj(src.cooldown), sg = obj(src.stoplossGuard), md = obj(src.maxDrawdown), lp = obj(src.lowProfitPairs);
  return {
    enabled: bool(src.enabled, d.enabled),
    cooldown: {
      enabled: bool(cd.enabled, d.cooldown.enabled),
      minutes: num(cd.minutes, d.cooldown.minutes, 0, 7 * 24 * 60),
      // Adaptif bekleme (Passivbot adaptive entry cooldown fikri): dusus yonlulugu kadar ek dakika. 0 = kapali.
      adverseMinutes: num(cd.adverseMinutes, d.cooldown.adverseMinutes, 0, 7 * 24 * 60),
      adverseSpanBars: num(cd.adverseSpanBars, d.cooldown.adverseSpanBars, 2, 500),
      maxMinutes: num(cd.maxMinutes, d.cooldown.maxMinutes, 1, 30 * 24 * 60)
    },
    stoplossGuard: {
      enabled: bool(sg.enabled, d.stoplossGuard.enabled),
      tradeLimit: num(sg.tradeLimit, d.stoplossGuard.tradeLimit, 1, 1000, true),
      lookbackMinutes: num(sg.lookbackMinutes, d.stoplossGuard.lookbackMinutes, 1, 30 * 24 * 60),
      lockMinutes: num(sg.lockMinutes, d.stoplossGuard.lockMinutes, 1, 30 * 24 * 60),
      requiredProfitPct: num(sg.requiredProfitPct, d.stoplossGuard.requiredProfitPct, -100, 100),
      onlyPerPair: bool(sg.onlyPerPair, d.stoplossGuard.onlyPerPair)
    },
    maxDrawdown: {
      enabled: bool(md.enabled, d.maxDrawdown.enabled),
      tradeLimit: num(md.tradeLimit, d.maxDrawdown.tradeLimit, 1, 1000, true),
      lookbackMinutes: num(md.lookbackMinutes, d.maxDrawdown.lookbackMinutes, 1, 30 * 24 * 60),
      maxDrawdownPct: num(md.maxDrawdownPct, d.maxDrawdown.maxDrawdownPct, 0.1, 100),
      lockMinutes: num(md.lockMinutes, d.maxDrawdown.lockMinutes, 1, 30 * 24 * 60)
    },
    lowProfitPairs: {
      enabled: bool(lp.enabled, d.lowProfitPairs.enabled),
      tradeLimit: num(lp.tradeLimit, d.lowProfitPairs.tradeLimit, 1, 1000, true),
      lookbackMinutes: num(lp.lookbackMinutes, d.lowProfitPairs.lookbackMinutes, 1, 30 * 24 * 60),
      requiredProfitPct: num(lp.requiredProfitPct, d.lowProfitPairs.requiredProfitPct, -100, 100),
      lockMinutes: num(lp.lockMinutes, d.lowProfitPairs.lockMinutes, 1, 30 * 24 * 60)
    }
  };
}

const closedMs = (t) => {
  const ms = Date.parse(t && t.closedAt);
  return Number.isFinite(ms) ? ms : null;
};
const pnlPctOf = (t) => {
  const p = Number(t && t.pnlPct);
  return Number.isFinite(p) ? p : null;
};

// Stop ile kapanan islem mi? Motorlar neden metnini Turkce/Ingilizce karisik yaziyor
// ('stop-loss', 'ATR stop', 'profit-protection stop', borsa stop dolumu...). Zarar sarti ayrica aranir;
// bu yuzden kar koruma stopu (kar ile kapanir) kendiliginden elenir.
const isStopExit = (t) => /stop|kayıp durdur|zarar kes/i.test(String((t && t.reason) || ''));

function recent(trades, now, lookbackMinutes) {
  const from = now - lookbackMinutes * MIN;
  const out = [];
  for (const t of Array.isArray(trades) ? trades : []) {
    const ms = closedMs(t);
    if (ms === null || ms < from || ms > now + MIN) continue;
    out.push({ t, ms });
  }
  return out;
}

const lock = (scope, rule, lastCloseMs, lockMinutes, reason) => ({
  blocked: true, scope, rule, until: lastCloseMs + lockMinutes * MIN, reason
});

function maxDrawdownOf(pnls, referenceEquity) {
  // Kumulatif K/Z egrisi uzerinde zirveden dibe en buyuk dusus, referans ozkaynaga oranla (%).
  let cum = 0, peak = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return referenceEquity > 0 ? (maxDd / referenceEquity) * 100 : 0;
}

// symbol: yeni alim dusunulen parite. Donus: { blocked:false } ya da { blocked:true, scope, rule, until, reason }.
// adverseScore: 0..1, sembolun son mumlarindaki dusus yonlulugu (cagiran hesaplar; yoksa 0).
function checkProtections({ trades, symbol, now, config, referenceEquity = 0, adverseScore = 0 }) {
  const cfg = normalizeProtections(config);
  if (!cfg.enabled) return { blocked: false };
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return { blocked: false };
  const locks = [];

  if (cfg.cooldown.enabled && (cfg.cooldown.minutes > 0 || cfg.cooldown.adverseMinutes > 0)) {
    let last = null;
    for (const t of Array.isArray(trades) ? trades : []) {
      if (t.symbol !== symbol) continue;
      const ms = closedMs(t);
      if (ms !== null && (last === null || ms > last)) last = ms;
    }
    if (last !== null) {
      const adv = Math.min(1, Math.max(0, Number(adverseScore) || 0));
      const total = Math.min(cfg.cooldown.maxMinutes, cfg.cooldown.minutes + cfg.cooldown.adverseMinutes * adv);
      locks.push(lock('pair', 'cooldown', last, total, `${symbol}: son çıkıştan sonra ${Math.round(total)} dk bekleme${adv > 0 && cfg.cooldown.adverseMinutes > 0 ? ` (düşüş yönlülüğü ${adv.toFixed(2)})` : ''}`));
    }
  }

  if (cfg.stoplossGuard.enabled) {
    const sg = cfg.stoplossGuard;
    const hits = recent(trades, nowMs, sg.lookbackMinutes).filter(({ t }) => {
      const p = pnlPctOf(t);
      return isStopExit(t) && p !== null && p < sg.requiredProfitPct;
    });
    const pairHits = hits.filter(({ t }) => t.symbol === symbol);
    if (pairHits.length >= sg.tradeLimit) {
      locks.push(lock('pair', 'stoplossGuard', Math.max(...pairHits.map((h) => h.ms)), sg.lockMinutes,
        `${symbol}: ${sg.lookbackMinutes} dk içinde ${pairHits.length} stop-loss`));
    }
    if (!sg.onlyPerPair && hits.length >= sg.tradeLimit) {
      locks.push(lock('global', 'stoplossGuard', Math.max(...hits.map((h) => h.ms)), sg.lockMinutes,
        `Tüm pariteler: ${sg.lookbackMinutes} dk içinde ${hits.length} stop-loss`));
    }
  }

  if (cfg.maxDrawdown.enabled) {
    const md = cfg.maxDrawdown;
    const rows = recent(trades, nowMs, md.lookbackMinutes).sort((a, b) => a.ms - b.ms);
    if (rows.length >= md.tradeLimit) {
      const pnls = rows.map(({ t }) => Number(t.pnl)).filter(Number.isFinite);
      const dd = maxDrawdownOf(pnls, Number(referenceEquity));
      if (dd > md.maxDrawdownPct) {
        locks.push(lock('global', 'maxDrawdown', rows[rows.length - 1].ms, md.lockMinutes,
          `Son ${md.lookbackMinutes} dk işlem drawdown'u %${dd.toFixed(2)} (> %${md.maxDrawdownPct})`));
      }
    }
  }

  if (cfg.lowProfitPairs.enabled) {
    const lp = cfg.lowProfitPairs;
    const rows = recent(trades, nowMs, lp.lookbackMinutes).filter(({ t }) => t.symbol === symbol && pnlPctOf(t) !== null);
    if (rows.length >= lp.tradeLimit) {
      const avg = rows.reduce((s, { t }) => s + pnlPctOf(t), 0) / rows.length;
      if (avg < lp.requiredProfitPct) {
        locks.push(lock('pair', 'lowProfitPairs', Math.max(...rows.map((r) => r.ms)), lp.lockMinutes,
          `${symbol}: son ${rows.length} işlemde ortalama %${avg.toFixed(2)} (< %${lp.requiredProfitPct})`));
      }
    }
  }

  const active = locks.filter((l) => l.until > nowMs).sort((a, b) => b.until - a.until);
  return active.length ? active[0] : { blocked: false };
}

module.exports = { DEFAULTS, normalizeProtections, checkProtections, isStopExit, maxDrawdownOf };
