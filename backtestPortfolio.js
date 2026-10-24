#!/usr/bin/env node
// backtestPortfolio.js -- PORTFOY duzeyinde backtest: tum coinler ortak kasadan, botun gercek kurallariyla
// (kasa payi, nakit rezervi, ayni anda en fazla N pozisyon). Tek coine tum sermayeyi koyan
// backtestSegments.js'den farki budur. Kronolojik 3 parca: EGITIM -> DOGRULAMA -> OOS.
//
// Kullanim:
//   node backtestPortfolio.js                                  (10 coin, 4h, trend_regime + 3 karsilastirma)
//   node backtestPortfolio.js --strategies trend_regime --maxpos 3 --budget 10
//   node backtestPortfolio.js --symbols BTC/USDT,ETH/USDT,SOL/USDT --tf 4h
//
// Veri: backtestSegments.js / veriIndir.js ile ayni onbellek (data/backtest/veri). Ayni mum aralığı ve
// ay sayısı (varsayilan 24+24+12 = 60) ile indirilmis olmali.

const fs = require('fs');
const path = require('path');
const strategies = require('./src/strategies');
const { loadCandles, DEFAULT_BASE_URL, monthsToMs } = require('./src/backtest/data');
const { runPortfolioBacktest } = require('./src/backtest/portfolioSimulator');

const DEFAULT_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'TRX/USDT', 'LINK/USDT', 'AVAX/USDT'];

function parseArgs(argv) {
  const o = { symbols: DEFAULT_SYMBOLS, tf: '4h', split: [24, 24, 12], feePct: 0.1, slippagePct: 0.05, capital: 1000, budgetPct: 10, reserveCashPct: 10, maxPos: 5, strategies: ['trend_regime', 'trend_filter', 'regime_adx', 'regime_strict'], baseUrl: process.env.BINANCE_BASE_URL || DEFAULT_BASE_URL, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--refresh') { o.refresh = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} için değer yok.`);
    if (a === '--symbols') o.symbols = v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--tf') o.tf = v;
    else if (a === '--split') o.split = v.split(',').map(Number);
    else if (a === '--fee') o.feePct = Number(v);
    else if (a === '--slip') o.slippagePct = Number(v);
    else if (a === '--capital') o.capital = Number(v);
    else if (a === '--budget') o.budgetPct = Number(v);
    else if (a === '--reserve') o.reserveCashPct = Number(v);
    else if (a === '--maxpos') o.maxPos = Number(v);
    else if (a === '--strategies') o.strategies = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--base') o.baseUrl = v.replace(/\/+$/, '');
    else throw new Error(`Bilinmeyen seçenek: ${a}`);
  }
  if (o.split.length !== 3 || o.split.some((x) => !(x > 0))) throw new Error('--split üç pozitif sayı olmalı, örn. 24,24,12');
  for (const id of o.strategies) strategies.get(id);
  return o;
}

const f = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '  -  ' : x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const totalMonths = o.split[0] + o.split[1] + o.split[2];
  const cacheDir = path.join(__dirname, 'data', 'backtest', 'veri');
  const loaded = {};
  for (const symbol of o.symbols) {
    console.error(`Veri okunuyor: ${symbol} ${o.tf} ${totalMonths} ay ...`);
    loaded[symbol] = await loadCandles({ symbol, interval: o.tf, months: totalMonths, baseUrl: o.baseUrl, cacheDir, refresh: o.refresh });
  }

  // Tum coinleri ortak zaman araligina esitle (portfoy simulatoru mumlarin birebir hizali olmasini ister).
  const firstT = Math.max(...o.symbols.map((s) => loaded[s].candles[0].t));
  const lastT = Math.min(...o.symbols.map((s) => loaded[s].candles[loaded[s].candles.length - 1].t));
  const datasets = {};
  for (const s of o.symbols) datasets[s] = { candles: loaded[s].candles.filter((c) => c.t >= firstT && c.t <= lastT) };
  const len = datasets[o.symbols[0]].candles.length;
  for (const s of o.symbols) {
    const cs = datasets[s].candles;
    if (cs.length !== len || cs[0].t !== datasets[o.symbols[0]].candles[0].t) {
      throw new Error(`${s}: mum zamanları diğer coinlerle hizalı değil. Çözüm: aynı gün tekrar indir: node veriIndir.js --refresh --tf ${o.tf}`);
    }
  }
  const candles0 = datasets[o.symbols[0]].candles;
  const windowStartMs = Math.max(...o.symbols.map((s) => loaded[s].windowStartMs));
  console.error(`${len} hizalı mum, ${o.symbols.length} coin.`);

  const names = ['EĞİTİM', 'DOĞRULAMA', 'OOS'];
  let cursor = windowStartMs;
  const segs = o.split.map((m, i) => {
    const seg = { name: names[i], months: m, startMs: cursor, endMs: cursor + monthsToMs(m) };
    cursor = seg.endMs;
    return seg;
  });
  const bounds = segs.map((seg) => {
    const startIdx = candles0.findIndex((c) => c.t >= seg.startMs);
    if (startIdx === -1) return null;
    let endIdx = candles0.findIndex((c) => c.t >= seg.endMs);
    if (endIdx === -1) endIdx = candles0.length;
    return endIdx - startIdx < 50 ? null : { startIdx, endIdx };
  });

  const rows = [];
  let bhRes = null;
  for (const id of o.strategies) {
    const strat = strategies.get(id);
    const res = bounds.map((b) => (b ? runPortfolioBacktest({
      datasets, symbols: o.symbols, startIndex: b.startIdx, endIndex: b.endIdx - 1, strategy: strat, params: strat.defaultParams,
      capital: o.capital, feePct: o.feePct, slippagePct: o.slippagePct, reserveCashPct: o.reserveCashPct, maxConcurrentPositions: o.maxPos, budgetPct: o.budgetPct
    }) : null));
    rows.push({ id, res });
    if (!bhRes) bhRes = res;
  }

  const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  const lines = [];
  lines.push(`PORTFÖY ${o.symbols.length} coin ${o.tf} | kasa payı %${o.budgetPct}, rezerv %${o.reserveCashPct}, en fazla ${o.maxPos} pozisyon | komisyon %${o.feePct} + kayma %${o.slippagePct}`);
  segs.forEach((s, i) => lines.push(`  ${s.name}: ${fmtDate(s.startMs)} → ${fmtDate(s.endMs)} (${s.months} ay)${bounds[i] ? '' : '  [VERİ YOK]'}`));
  lines.push('');
  lines.push(pad('strateji', 22) + names.map((n) => pad(n + ' %', 14)).join('') + names.map((n) => pad(n + ' işl', 15)).join('') + pad('OOS maxDD%', 11) + pad('en çok açık', 12) + '5 yıl %');
  lines.push('-'.repeat(22 + 42 + 45 + 11 + 12 + 8));
  for (const r of rows) {
    const ret = r.res.map((x) => (x ? x.returnPct : null));
    const trd = r.res.map((x) => (x ? x.trades : null));
    const comp = ret.every((x) => x !== null) ? (ret.reduce((a, x) => a * (1 + x / 100), 1) - 1) * 100 : null;
    const peak = Math.max(...r.res.map((x) => (x ? x.peakOpenPositions : 0)));
    lines.push(pad(r.id, 22) + ret.map((x) => pad(f(x), 14)).join('') + trd.map((x) => pad(x === null ? '-' : x, 15)).join('') + pad(f(r.res[2] && r.res[2].maxDrawdownPct), 11) + pad(peak, 12) + f(comp));
  }
  // Referans: coinlerin esit agirlikli al-tut ortalamasi (yeniden dengeleme yok, komisyon dahil).
  const bhAvg = bhRes.map((x) => {
    if (!x) return null;
    const v = Object.values(x.buyHoldBySymbol).filter((y) => Number.isFinite(y));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
  const bhComp = bhAvg.every((x) => x !== null) ? (bhAvg.reduce((a, x) => a * (1 + x / 100), 1) - 1) * 100 : null;
  lines.push('-'.repeat(22 + 42 + 45 + 11 + 12 + 8));
  lines.push(pad('AL-TUT (eşit ağırlık)', 22) + bhAvg.map((x) => pad(f(x), 14)).join('') + pad('', 45) + pad('', 11) + pad('', 12) + f(bhComp));
  lines.push('');
  lines.push('Not: "5 yıl %" üç dönemin getirilerinin birleşiminden yaklaşık hesaplanır.');
  lines.push('Not: Getiriler toplam portföy sermayesi üzerindendir; kasa payı %' + o.budgetPct + ' olduğu için tek tek coin sonuçlarından çok daha küçük görünür.');
  lines.push('Not: Hiçbir sonuç kâr garantisi değildir.');
  const text = lines.join('\n');
  console.log('\n' + text);

  const outDir = path.join(__dirname, 'data', 'backtest');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  fs.writeFileSync(path.join(outDir, `portfoy-${o.tf}-${stamp}.txt`), text + '\n');
  console.error(`\nKaydedildi: data/backtest/portfoy-${o.tf}-${stamp}.txt`);
}

main().catch((e) => { console.error('\nHata: ' + e.message); process.exit(1); });
