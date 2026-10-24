// src/backtest/report.js
// Sonuclari ozetler. Telefonda (dar Termux ekrani) okunabilsin diye tablolar ~45 karakter genisliginde.

const SHORT = {
  rsi_ema_macd: 'RSI+EMA+MACD',
  ema_cross: 'EMA kesişimi',
  bollinger_reversion: 'Bollinger',
  macd_momentum: 'MACD momentum',
  rsi_simple: 'Sade RSI',
  trend_filter: 'Trend (SMA)',
  trend_filter_v2: 'Trend V2',
  dca_weekly: 'DCA haftalık'
};
const shortName = (id) => SHORT[id] || String(id).slice(0, 13);
const baseSym = (s) => s.split('/')[0];
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');
const day = (t) => new Date(t).toISOString().slice(0, 10);
const WIDTH = 46; // dar telefon ekrani (Termux dikey) icin

// Kelimeleri bolmeden satirlara boler.
function wrap(text, width = WIDTH) {
  const lines = [];
  let cur = '';
  for (const word of String(text).split(' ')) {
    if (cur && (cur + ' ' + word).length > width) { lines.push(cur); cur = word; }
    else cur = cur ? cur + ' ' + word : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

// results: [{ timeframe, symbol, strategyId, ...metrics }]
function aggregate(results) {
  const out = {};
  for (const tf of [...new Set(results.map((r) => r.timeframe))]) {
    const inTf = results.filter((r) => r.timeframe === tf);
    const symbols = [...new Set(inTf.map((r) => r.symbol))];
    // Al-tut, stratejiden bagimsizdir: her parite icin bir kez al.
    const bh = symbols.map((s) => inTf.find((r) => r.symbol === s));
    const strategies = {};
    for (const id of [...new Set(inTf.map((r) => r.strategyId))]) {
      const rows = inTf.filter((r) => r.strategyId === id);
      strategies[id] = {
        pairs: rows.length,
        avgReturnPct: avg(rows.map((r) => r.returnPct)),
        avgMaxDrawdownPct: avg(rows.map((r) => r.maxDrawdownPct)),
        trades: rows.reduce((s, r) => s + r.trades, 0),
        beatBuyHold: rows.filter((r) => r.returnPct > r.buyHoldPct).length,
        positivePairs: rows.filter((r) => r.returnPct > 0).length,
        bothHalvesPositive: rows.filter((r) => r.firstHalfPct > 0 && r.secondHalfPct > 0).length,
        avgCostsPct: avg(rows.map((r) => r.feesPct + r.slippagePct)),
        avgExposurePct: avg(rows.map((r) => r.exposurePct))
      };
    }
    out[tf] = {
      symbols,
      buyHold: { avgReturnPct: avg(bh.map((r) => r.buyHoldPct)), avgMaxDrawdownPct: avg(bh.map((r) => r.buyHoldMaxDrawdownPct)) },
      strategies
    };
  }
  return out;
}

function formatSummary(meta, agg) {
  const L = [];
  L.push('BACKTEST ÖZETİ');
  L.push(`Dönem: ${day(meta.startT)} → ${day(meta.endT)} (${meta.days} gün)`);
  L.push(`Sermaye ${meta.capital}, komisyon %${meta.feePct}, kayma %${meta.slippagePct}`);
  L.push('(komisyon ve kayma her yönde ödenir)');
  wrap(`Parite: ${meta.symbols.map(baseSym).join(' ')}`).forEach((l) => L.push(l));
  L.push('Sinyal kapanmış mumda, emir sonraki açılışta.');
  const lowTradeStrategies = new Set();

  for (const [tf, block] of Object.entries(agg)) {
    L.push('');
    L.push(`=== ${tf} mumlar (${block.symbols.length} parite) ===`);
    L.push('strateji       getiri  maxDD  işlem  >AT');
    for (const [id, s] of Object.entries(block.strategies)) {
      L.push(`${shortName(id).padEnd(13)} ${pct(s.avgReturnPct).padStart(7)} ${pct(s.avgMaxDrawdownPct, 0).padStart(6)} ${String(s.trades).padStart(5)}  ${s.beatBuyHold}/${s.pairs}`);
      if (s.trades < 30) lowTradeStrategies.add(shortName(id));
    }
    L.push(`${'al-tut'.padEnd(13)} ${pct(block.buyHold.avgReturnPct).padStart(7)} ${pct(block.buyHold.avgMaxDrawdownPct, 0).padStart(6)}`);
  }

  L.push('');
  L.push('getiri, maxDD: pariteler ortalaması.');
  L.push('>AT: al-tut\'u geçen parite sayısı.');
  L.push('Varsayılan parametreler, optimizasyon yok.');
  if (lowTradeStrategies.size) wrap(`Az işlem (<30), sonuç zayıf: ${[...lowTradeStrategies].join(', ')}`).forEach((l) => L.push(l));
  if (meta.gaps > 0) L.push(`Uyarı: veride ${meta.gaps} mum boşluğu var.`);
  return L.join('\n');
}


// --risk: strateji basina risk/anlamlilik raporu. Islemler pariteler arasi havuzlanir (tek strateji = tek satir).
function formatRisk(results, { runs = 1000 } = {}) {
  const { monteCarlo, significance } = require('./metrics');
  const L = [];
  L.push('RİSK VE ANLAMLILIK (islemler pariteler arasi havuzlanmis)');
  L.push('strateji       işl  Sharpe Sortino Calmar Ulcer  beklenti  MC-zarar%  MC-DD95  p-değeri');
  const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));
  for (const tf of [...new Set(results.map((r) => r.timeframe))]) {
    L.push(`--- ${tf} ---`);
    const ids = [...new Set(results.filter((r) => r.timeframe === tf).map((r) => r.strategyId))];
    for (const id of ids) {
      const rows = results.filter((r) => r.timeframe === tf && r.strategyId === id && r.metrics);
      if (!rows.length) continue;
      const avg = (k) => { const v = rows.map((r) => r.metrics[k]).filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const pcts = rows.flatMap((r) => (r.tradeList || []).map((t) => t.pnlPct));
      const mc = monteCarlo(pcts, { runs });
      const sig = significance(pcts, { runs: Math.max(runs, 2000) });
      L.push(`${shortName(id).padEnd(13)} ${String(pcts.length).padStart(4)} ${f(avg('sharpe')).padStart(7)} ${f(avg('sortino')).padStart(7)} ${f(avg('calmar')).padStart(6)} ${f(avg('ulcerIndex'), 1).padStart(6)} ${f(pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null).padStart(8)}% ${(mc.ok ? f(mc.probLossPct, 1) : '-').padStart(9)} ${(mc.ok ? f(mc.maxDrawdownPct.p95, 1) : '-').padStart(8)} ${(sig.ok ? f(sig.pValue, 3) : '-').padStart(9)}`);
    }
  }
  L.push('');
  L.push('Sharpe/Sortino/Calmar: pariteler ortalaması. MC-zarar%: işlem sırası/kombinasyonu şansla değiştirilince zarar bitirme olasılığı.');
  L.push('MC-DD95: Monte Carlo maxDD %95. p-değeri < 0.05 ise ortalama işlem kârı şansa bağlanamaz; az işlemde (<30) güvenme.');
  return L.join('\n');
}

function formatDetail(results) {
  const L = [];
  for (const tf of [...new Set(results.map((r) => r.timeframe))]) {
    L.push('');
    L.push(`--- Ayrıntı ${tf} ---`);
    L.push('parite strateji       getiri    AT   maxDD işl   1.yarı  2.yarı');
    for (const r of results.filter((x) => x.timeframe === tf)) {
      L.push(
        `${baseSym(r.symbol).padEnd(6)} ${shortName(r.strategyId).padEnd(13)} ${pct(r.returnPct).padStart(7)} ${pct(r.buyHoldPct, 0).padStart(6)} ${pct(r.maxDrawdownPct, 0).padStart(6)} ${String(r.trades).padStart(3)} ${pct(r.firstHalfPct).padStart(8)} ${pct(r.secondHalfPct).padStart(7)}`
      );
    }
  }
  return L.join('\n');
}

// Maliyet duyarlilik tablosu: ayni sinyaller, farkli komisyon/kayma senaryolari.
// "brut" (maliyetsiz) sutunu, sinyalin KENDISINDE kenar olup olmadigini gosterir.
// scenarios: [{ label, feePct, slippagePct }]; her sonucun .sens dizisi bu sirayla {returnPct, buyHoldPct} tutar.
function formatSensitivity(results, scenarios) {
  const L = [];
  L.push('MALİYET DUYARLILIĞI (getiri, pariteler ort.)');
  wrap(scenarios.map((sc) => `${sc.label}: %${sc.feePct}+%${sc.slippagePct}`).join(' · ')).forEach((l) => L.push(l));
  for (const tf of [...new Set(results.map((r) => r.timeframe))]) {
    const inTf = results.filter((r) => r.timeframe === tf && r.sens);
    if (!inTf.length) continue;
    L.push('');
    L.push(`=== ${tf} ===`);
    L.push('strateji      ' + scenarios.map((sc) => sc.label.padStart(8)).join(''));
    for (const id of [...new Set(inTf.map((r) => r.strategyId))]) {
      const rows = inTf.filter((r) => r.strategyId === id);
      L.push(shortName(id).padEnd(13) + ' ' + scenarios.map((_, i) => pct(avg(rows.map((r) => r.sens[i].returnPct))).padStart(8)).join(''));
    }
    const symbols = [...new Set(inTf.map((r) => r.symbol))];
    const bhRows = symbols.map((s) => inTf.find((r) => r.symbol === s));
    L.push('al-tut'.padEnd(13) + ' ' + scenarios.map((_, i) => pct(avg(bhRows.map((r) => r.sens[i].buyHoldPct))).padStart(8)).join(''));
  }
  L.push('');
  L.push('brüt ≈ maliyetsiz sinyal getirisi. brüt de');
  L.push('negatifse stratejinin sinyalinde kenar yok.');
  return L.join('\n');
}

// Kabul olcutu tablosu (bkz. criteria.js). months, calistirmanin ay sayisi.
function formatCriteria(evaluation, months, criteriaVersion, requiredMonths) {
  const L = [];
  L.push(`KABUL ÖLÇÜTLERİ (sürüm ${criteriaVersion}, ${requiredMonths} ay)`);
  if (months !== requiredMonths) L.push(`Not: ölçütler ${requiredMonths} aylık çalıştırma için; bu: ${months} ay.`);
  for (const [tf, block] of Object.entries(evaluation)) {
    L.push('');
    L.push(`=== ${tf} ===`);
    L.push('strateji      K1 K2 K3 K4 K5 K6 sonuç');
    for (const [id, e] of Object.entries(block)) {
      const mk = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'].map((c) => (e.k[c] ? '✓ ' : '✗ ')).join(' ');
      const verdict = e.G && e.R ? 'ADAY G+R' : e.G ? 'ADAY G' : e.R ? 'ADAY R' : '-';
      L.push(`${shortName(id).padEnd(13)} ${mk} ${verdict}`);
    }
  }
  L.push('');
  wrap('K1 ≥%60 parite artıda · K2 iki yarı da artıda · K3 ≥50 işlem · K4 düşüş ≤ al-tut düşüşünün yarısı · K5 getiri ≥ al-tut getirisinin yarısı · K6 ≥10 işlem').forEach((l) => L.push(l));
  L.push('G = K1+K2+K3+K4 (getiri odaklı)');
  L.push('R = K1+K4+K5+K6 (risk azaltıcı)');
  const cands = [];
  for (const [tf, block] of Object.entries(evaluation)) for (const [id, e] of Object.entries(block)) if (e.candidate) cands.push(`${shortName(id)} ${tf}`);
  const combos = Object.values(evaluation).reduce((n, block) => n + Object.keys(block).length, 0);
  L.push('');
  wrap(cands.length ? `ADAY: ${cands.join(', ')}` : 'ADAY YOK: hiçbir strateji ölçütleri sağlamadı.').forEach((l) => L.push(l));
  wrap(`ŞANS UYARISI: ${combos} kombinasyon denendi. Rastgele veride bile bir kısmı ölçütleri tutturabilir; aday çıkması kenar olduğunu göstermez.`).forEach((l) => L.push(l));
  wrap('Aday = ileriye dönük kağıt sınama hakkı, kanıt değil.').forEach((l) => L.push(l));
  return L.join('\n');
}

module.exports = { aggregate, formatSummary, formatDetail, formatSensitivity, formatCriteria, formatRisk, shortName };
