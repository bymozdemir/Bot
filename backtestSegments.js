#!/usr/bin/env node
// backtestSegments.js -- 8 stratejiyi (varsayilan parametrelerle) kronolojik 3 parcada dener:
//   EGITIM (en eski) -> DOGRULAMA -> OOS (en yeni, hic secimde kullanilmaz)
//
// Kullanim:
//   node backtestSegments.js --symbol BTC/USDT --tf 1h
//   node backtestSegments.js --symbol ETH/USDT --tf 4h --split 24,24,12
//   node backtestSegments.js --symbol BTC/USDT --tf 1h --strategies bollinger_reversion,ema_cross
//
// Veri: toplam ay = split toplami (varsayilan 24+24+12 = 60). Binance'ten indirilir,
// data/backtest/veri altina onbelleklenir (ayni gun tekrar calistirmada internete cikmaz).

const fs = require('fs');
const path = require('path');
const strategies = require('./src/strategies');
const { loadCandles, DEFAULT_BASE_URL, monthsToMs } = require('./src/backtest/data');
const { runBacktest } = require('./src/backtest/simulator');

function parseArgs(argv) {
  const o = { symbol: 'BTC/USDT', tf: '1h', split: [24, 24, 12], feePct: 0.1, slippagePct: 0.05, capital: 1000, strategies: Object.keys(strategies.registry), baseUrl: process.env.BINANCE_BASE_URL || DEFAULT_BASE_URL, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--refresh') { o.refresh = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} için değer yok.`);
    if (a === '--symbol') o.symbol = v.toUpperCase();
    else if (a === '--tf') o.tf = v;
    else if (a === '--split') o.split = v.split(',').map(Number);
    else if (a === '--fee') o.feePct = Number(v);
    else if (a === '--slip') o.slippagePct = Number(v);
    else if (a === '--capital') o.capital = Number(v);
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

// segments: [{name, startMs, endMs}] -> her biri icin {startIdx, endIdx} bulur.
function sliceBounds(candles, seg) {
  const startIdx = candles.findIndex((c) => c.t >= seg.startMs);
  if (startIdx === -1) return null;
  let endIdx = candles.findIndex((c) => c.t >= seg.endMs);
  if (endIdx === -1) endIdx = candles.length;
  if (endIdx - startIdx < 50) return null; // parca icin yeterli veri yok
  return { startIdx, endIdx };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const totalMonths = o.split[0] + o.split[1] + o.split[2];
  const cacheDir = path.join(__dirname, 'data', 'backtest', 'veri');
  console.error(`Veri indiriliyor/okunuyor: ${o.symbol} ${o.tf} son ${totalMonths} ay ...`);
  const data = await loadCandles({ symbol: o.symbol, interval: o.tf, months: totalMonths, baseUrl: o.baseUrl, cacheDir, refresh: o.refresh });
  const { candles, windowStartMs } = data;
  console.error(`${candles.length} mum yüklendi.`);

  const names = ['EĞİTİM', 'DOĞRULAMA', 'OOS'];
  let cursor = windowStartMs;
  const segs = o.split.map((m, i) => {
    const seg = { name: names[i], months: m, startMs: cursor, endMs: cursor + monthsToMs(m) };
    cursor = seg.endMs;
    return seg;
  });
  const bounds = segs.map((s) => sliceBounds(candles, s));

  const rows = [];
  let bhRow = null;
  for (const id of o.strategies) {
    const strat = strategies.get(id);
    const res = bounds.map((b) => {
      if (!b) return null;
      return runBacktest({ candles: candles.slice(0, b.endIdx), startIndex: b.startIdx, strategy: strat, params: strat.defaultParams, capital: o.capital, feePct: o.feePct, slippagePct: o.slippagePct });
    });
    rows.push({ id, res });
    if (!bhRow) bhRow = res;
  }

  const lines = [];
  const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  lines.push(`${o.symbol} ${o.tf} | komisyon %${o.feePct} + kayma %${o.slippagePct} | parametreler: varsayılan`);
  segs.forEach((s, i) => lines.push(`  ${s.name}: ${fmtDate(s.startMs)} → ${fmtDate(s.endMs)} (${s.months} ay)${bounds[i] ? '' : '  [VERİ YOK/YETERSİZ]'}`));
  lines.push('');
  lines.push(pad('strateji', 22) + names.map((n) => pad(n + ' %', 14)).join('') + names.map((n) => pad(n + ' işl', 14)).join('') + pad('OOS maxDD%', 11) + 'sonuç');
  lines.push('-'.repeat(22 + 42 + 42 + 11 + 12));
  const verdicts = [];
  for (const r of rows) {
    const ret = r.res.map((x) => (x ? x.returnPct : null));
    const trd = r.res.map((x) => (x ? x.trades : null));
    const oos = r.res[2];
    const valid = r.res[1];
    let verdict = '';
    if (valid && oos) {
      const enough = (valid.trades + oos.trades) >= 10;
      verdict = !enough ? 'az işlem' : (valid.returnPct > 0 && oos.returnPct > 0 ? 'DOĞR+OOS pozitif' : 'elenir');
    } else verdict = 'veri eksik';
    verdicts.push({ id: r.id, verdict });
    lines.push(pad(r.id, 22) + ret.map((x) => pad(f(x), 14)).join('') + trd.map((x) => pad(x === null ? '-' : x, 14)).join('') + pad(f(oos && oos.maxDrawdownPct), 11) + verdict);
  }
  const bh = bhRow;
  lines.push('-'.repeat(22 + 42 + 42 + 11 + 12));
  lines.push(pad('AL-TUT (referans)', 22) + bh.map((x) => pad(f(x && x.buyHoldPct), 14)).join('') + pad('', 42) + pad(f(bh[2] && bh[2].buyHoldMaxDrawdownPct), 11));
  lines.push('');
  lines.push('Not: Al-tut her parçada kendi başına hesaplanır. Bir strateji al-tut\'u geçmese bile max düşüşü belirgin azaltıyorsa değerli olabilir.');
  lines.push('Not: Hiçbir sonuç kâr garantisi değildir; sadece geçmişte tutarlı olup olmadığını gösterir.');

  const text = lines.join('\n');
  console.log('\n' + text);

  const outDir = path.join(__dirname, 'data', 'backtest');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const base = `segment-${o.symbol.replace('/', '')}-${o.tf}-${stamp}`;
  fs.writeFileSync(path.join(outDir, base + '.txt'), text + '\n');
  fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify({ options: o, segments: segs, verdicts, results: rows.map((r) => ({ id: r.id, segments: r.res.map((x) => x && { returnPct: x.returnPct, buyHoldPct: x.buyHoldPct, maxDrawdownPct: x.maxDrawdownPct, trades: x.trades, winRatePct: x.winRatePct, profitFactor: x.profitFactor, avgTradePct: x.avgTradePct }) })) }, null, 1));
  console.error(`\nKaydedildi: data/backtest/${base}.txt`);
}

main().catch((e) => {
  console.error('\nHata: ' + e.message);
  process.exit(1);
});
