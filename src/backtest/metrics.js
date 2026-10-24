// Backtest degerlendirme metrikleri (Jesse metrics/monte_carlo/significance_test fikirlerinden esinlenildi).
// Hepsi saf fonksiyon; rastgelelik tohumlu (mulberry32), yani ayni girdi ayni sonucu verir.

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function barReturns(equity) {
  const r = [];
  for (let i = 1; i < equity.length; i++) {
    const a = equity[i - 1], b = equity[i];
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0) r.push(b / a - 1);
  }
  return r;
}

function maxDrawdownFraction(equity) {
  let peak = -Infinity, dd = 0;
  for (const v of equity) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd;
}

// equity: mum basina ozkaynak. barsPerYear: yillik mum sayisi (1h => 8760).
function equityMetrics(equity, { barsPerYear = 8760 } = {}) {
  const r = barReturns(equity);
  const out = { sharpe: null, sortino: null, calmar: null, ulcerIndex: null, cvar95Pct: null, omega: null, cagrPct: null };
  if (r.length < 2) return out;
  const m = mean(r), sd = stdev(r);
  const ann = Math.sqrt(barsPerYear);
  if (sd > 0) out.sharpe = (m / sd) * ann;
  const downside = Math.sqrt(mean(r.map((x) => (x < 0 ? x * x : 0))));
  if (downside > 0) out.sortino = (m / downside) * ann;

  const first = equity.find(Number.isFinite), lastV = equity[equity.length - 1];
  const years = r.length / barsPerYear;
  // Cok kisa pencerede yillandirma anlamsiz (CAGR patlar): en az ~36 gun gerekir.
  if (first > 0 && lastV > 0 && years >= 0.1) {
    out.cagrPct = (Math.pow(lastV / first, 1 / years) - 1) * 100;
    const dd = maxDrawdownFraction(equity);
    if (dd > 0) out.calmar = (out.cagrPct / 100) / dd;
  }
  // Ulcer index: zirveden dususlerin (%) karesel ortalamasinin karekoku.
  let peak = -Infinity, sq = 0, cnt = 0;
  for (const v of equity) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    const d = peak > 0 ? ((v - peak) / peak) * 100 : 0;
    sq += d * d; cnt++;
  }
  out.ulcerIndex = cnt ? Math.sqrt(sq / cnt) : null;
  // CVaR %95: en kotu %5 mum getirisinin ortalamasi (negatifse zarar).
  const sorted = [...r].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(sorted.length * 0.05));
  out.cvar95Pct = mean(sorted.slice(0, k)) * 100;
  const gains = r.reduce((s, x) => s + Math.max(x, 0), 0), losses = r.reduce((s, x) => s + Math.max(-x, 0), 0);
  out.omega = losses > 0 ? gains / losses : null;
  return out;
}

function tradeMetrics(trades) {
  const pcts = trades.map((t) => Number(t.pnlPct)).filter(Number.isFinite);
  const wins = pcts.filter((x) => x > 0), losses = pcts.filter((x) => x <= 0);
  let streak = 0, maxLossStreak = 0;
  for (const x of pcts) { if (x <= 0) { streak++; maxLossStreak = Math.max(maxLossStreak, streak); } else streak = 0; }
  const avgWin = mean(wins), avgLoss = Math.abs(mean(losses));
  return {
    count: pcts.length,
    expectancyPct: pcts.length ? mean(pcts) : null,
    avgWinPct: wins.length ? avgWin : null,
    avgLossPct: losses.length ? -avgLoss : null,
    payoffRatio: wins.length && losses.length && avgLoss > 0 ? avgWin / avgLoss : null,
    maxConsecutiveLosses: maxLossStreak
  };
}

// Islem getirilerini (pnlPct) yerine koyarak yeniden orneklendirir; islem sirasi/kombinasyonu sans faktorunu olcer.
// Tam sermaye ile bilesik getiri varsayar (backtest ile ayni: pozisyon basina tum nakit).
function monteCarlo(tradePcts, { runs = 1000, seed = 12345, ruinDrawdownPct = 30 } = {}) {
  const t = tradePcts.map(Number).filter(Number.isFinite);
  if (t.length < 5) return { ok: false, reason: `Monte Carlo için en az 5 işlem gerekir (var: ${t.length}).` };
  const rnd = mulberry32(seed);
  const finals = [], dds = [];
  let lossRuns = 0, ruinRuns = 0;
  for (let r = 0; r < runs; r++) {
    let eq = 1, peak = 1, dd = 0;
    for (let i = 0; i < t.length; i++) {
      eq *= 1 + t[Math.floor(rnd() * t.length)] / 100;
      if (eq > peak) peak = eq;
      dd = Math.max(dd, (peak - eq) / peak);
    }
    finals.push((eq - 1) * 100); dds.push(dd * 100);
    if (eq < 1) lossRuns++;
    if (dd * 100 >= ruinDrawdownPct) ruinRuns++;
  }
  finals.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  return {
    ok: true, runs, trades: t.length, seed,
    returnPct: { p5: percentile(finals, 0.05), p50: percentile(finals, 0.5), p95: percentile(finals, 0.95) },
    maxDrawdownPct: { p50: percentile(dds, 0.5), p95: percentile(dds, 0.95), p99: percentile(dds, 0.99) },
    probLossPct: (lossRuns / runs) * 100,
    probDrawdownExceedsPct: (ruinRuns / runs) * 100,
    ruinDrawdownPct
  };
}

// "Ortalama islem getirisi sans eseri mi?" Sifir ortalamaya kaydirilmis bootstrap ile tek tarafli p-degeri.
function significance(tradePcts, { runs = 5000, seed = 777 } = {}) {
  const t = tradePcts.map(Number).filter(Number.isFinite);
  if (t.length < 10) return { ok: false, reason: `Anlamlılık testi için en az 10 işlem gerekir (var: ${t.length}).` };
  const obs = mean(t), sd = stdev(t);
  const centered = t.map((x) => x - obs);
  const rnd = mulberry32(seed);
  let ge = 0;
  for (let r = 0; r < runs; r++) {
    let s = 0;
    for (let i = 0; i < t.length; i++) s += centered[Math.floor(rnd() * t.length)];
    if (s / t.length >= obs) ge++;
  }
  const p = (ge + 1) / (runs + 1);
  return {
    ok: true, trades: t.length, meanTradePct: obs,
    tStat: sd > 0 ? obs / (sd / Math.sqrt(t.length)) : null,
    pValue: p,
    verdict: p < 0.05 ? 'anlamlı (p<0.05): ortalama kâr şansa bağlanamıyor' : 'anlamsız: sonuç şans eseri olabilir'
  };
}

module.exports = { equityMetrics, tradeMetrics, monteCarlo, significance, mulberry32, percentile };
