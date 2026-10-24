#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCandles, monthsToMs, INTERVAL_MS } = require('./src/backtest/data');
const { runBacktest } = require('./src/backtest/simulator');
const strategies = require('./src/strategies');

const CAPITAL = 1000;
const FEE_PCT = 0.1;
const SLIPPAGE_PCT = 0.05;
const DEFAULT_MONTHS = 60;
const DEFAULT_OOS_MONTHS = 4;
const DEFAULT_CONTEXT_MONTHS = 12;

function parseArgs(argv) {
  const opts = {
    months: DEFAULT_MONTHS,
    oosMonths: DEFAULT_OOS_MONTHS,
    contextMonths: DEFAULT_CONTEXT_MONTHS,
    tf: '4h',
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    baseUrl: process.env.BINANCE_BASE_URL || 'https://api.binance.com',
    out: path.join(__dirname, 'data', 'backtest', 'walk-forward'),
    refresh: false
  };

  const takesValue = new Set([
    '--months', '--oos-months', '--context-months', '--tf',
    '--symbols', '--base', '--out'
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--refresh') {
      opts.refresh = true;
      continue;
    }
    if (!takesValue.has(arg)) throw new Error(`Bilinmeyen seçenek: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} için değer gerekli.`);

    if (arg === '--months') opts.months = Number(value);
    else if (arg === '--oos-months') opts.oosMonths = Number(value);
    else if (arg === '--context-months') opts.contextMonths = Number(value);
    else if (arg === '--tf') opts.tf = value;
    else if (arg === '--symbols') opts.symbols = value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--base') opts.baseUrl = value.replace(/\/+$/, '');
    else if (arg === '--out') opts.out = value;
  }

  if (!Number.isFinite(opts.months) || opts.months < 12 || opts.months > 60) {
    throw new Error('--months 12 ile 60 arasında olmalı.');
  }
  if (!Number.isFinite(opts.oosMonths) || opts.oosMonths < 1) {
    throw new Error('--oos-months pozitif olmalı.');
  }
  if (!Number.isFinite(opts.contextMonths) || opts.contextMonths < 1) {
    throw new Error('--context-months pozitif olmalı.');
  }
  if (!INTERVAL_MS[opts.tf]) {
    throw new Error(`Desteklenmeyen mum aralığı: ${opts.tf} (${Object.keys(INTERVAL_MS).join(', ')})`);
  }
  if (!opts.symbols.length) throw new Error('En az bir parite gerekli.');
  return opts;
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : 'n/a';
}

function fmtNum(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function date(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Bilesik getiri YALNIZCA ayni paritenin ardisik foldlari arasinda hesaplanir. Farkli paritelerin
// sonuclarini tek zincirde carpmak (BTC fold1 x ETH fold1 x ...) anlamsiz bir sayi uretir.
// Pariteler esit agirlikli kabul edilir: sonuc, parite basina bilesik getirilerin ortalamasidir.
function groupBySymbol(results) {
  const groups = new Map();
  for (const row of results) {
    const key = row.symbol === undefined ? '_' : row.symbol;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) rows.sort((a, b) => (a.fold ?? 0) - (b.fold ?? 0));
  return groups;
}

function compoundChain(rows, field) {
  return (rows.reduce((equity, row) => equity * (1 + row[field] / 100), CAPITAL) / CAPITAL - 1) * 100;
}

function compound(results, field) {
  const groups = [...groupBySymbol(results).values()];
  if (!groups.length) return 0;
  return groups.reduce((sum, rows) => sum + compoundChain(rows, field), 0) / groups.length;
}

function compoundPerSymbol(results, field) {
  const out = {};
  for (const [symbol, rows] of groupBySymbol(results)) out[symbol] = compoundChain(rows, field);
  return out;
}

function summarize(results) {
  const positive = results.filter(row => row.returnPct > 0).length;
  const beatBuyHold = results.filter(row => row.returnPct > row.buyHoldPct).length;
  const avgReturn = results.length ? results.reduce((sum, row) => sum + row.returnPct, 0) / results.length : null;
  const avgBuyHold = results.length ? results.reduce((sum, row) => sum + row.buyHoldPct, 0) / results.length : null;
  const trades = results.reduce((sum, row) => sum + row.trades, 0);
  const worstFoldDrawdown = results.length ? Math.min(...results.map(row => row.maxDrawdownPct)) : null;

  return {
    resultCount: results.length,
    positive,
    beatBuyHold,
    positiveRatePct: results.length ? (positive / results.length) * 100 : null,
    beatBuyHoldRatePct: results.length ? (beatBuyHold / results.length) * 100 : null,
    avgReturnPct: avgReturn,
    avgBuyHoldPct: avgBuyHold,
    compoundedReturnPct: compound(results, 'returnPct'),
    compoundedBuyHoldPct: compound(results, 'buyHoldPct'),
    compoundedReturnBySymbol: compoundPerSymbol(results, 'returnPct'),
    compoundedBuyHoldBySymbol: compoundPerSymbol(results, 'buyHoldPct'),
    totalTrades: trades,
    worstFoldDrawdownPct: worstFoldDrawdown
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const strategy = strategies.get('trend_filter');
  const params = {
    period: 200,
    bufferPct: 1,
    stopLossPct: 15,
    takeProfitPct: 0,
    trailingStop: false
  };

  console.log('');
  console.log('============================================================');
  console.log('TREND V1 — FIXED ROLLING OOS');
  console.log('============================================================');
  console.log(`Timeframe       : ${opts.tf}`);
  console.log(`Veri             : son ${opts.months} ay`);
  console.log(`OOS blok         : ${opts.oosMonths} ay`);
  console.log(`Context          : ${opts.contextMonths} ay`);
  console.log(`Pariteler        : ${opts.symbols.join(', ')}`);
  console.log(`Sermaye          : ${CAPITAL}`);
  console.log(`Komisyon         : %${FEE_PCT}`);
  console.log(`Kayma            : %${SLIPPAGE_PCT}`);
  console.log('Trend V1         : SMA200 / buffer %1 / SL %15 / TP kapalı');
  console.log('Parametre optimizasyonu: YOK');
  console.log('');

  const nowMs = Date.now();
  const windowStartMs = nowMs - monthsToMs(opts.months);
  const contextMs = monthsToMs(opts.contextMonths);
  const stepMs = monthsToMs(opts.oosMonths);
  const datasets = new Map();

  for (const symbol of opts.symbols) {
    console.error(`Veri hazırlanıyor: ${symbol} ${opts.tf}`);
    const data = await loadCandles({
      symbol,
      interval: opts.tf,
      months: opts.months,
      baseUrl: opts.baseUrl,
      cacheDir: path.join(opts.out, 'veri'),
      refresh: opts.refresh
    });
    datasets.set(symbol, data);
    console.error(`  ${data.candles.length} mum | startIndex=${data.startIndex} | gaps=${data.gaps}`);
  }

  const folds = [];
  let foldStart = windowStartMs + contextMs;
  let fold = 1;
  while (foldStart < nowMs) {
    const foldEnd = Math.min(foldStart + stepMs, nowMs);
    if (foldEnd <= foldStart) break;
    folds.push({ fold, startMs: foldStart, endMs: foldEnd });
    fold += 1;
    foldStart = foldEnd;
  }

  // Son fold yeterince uzun degilse (OOS blogunun yarisindan kisa) gurultu uretir: dusurulur.
  while (folds.length > 1 && (folds[folds.length - 1].endMs - folds[folds.length - 1].startMs) < stepMs * 0.5) {
    const dropped = folds.pop();
    console.error(`Kısa son fold atlandı: ${date(dropped.startMs)} → ${date(dropped.endMs)}`);
  }

  console.log(`Fold sayısı: ${folds.length}`);
  console.log('');

  const results = [];

  for (const currentFold of folds) {
    console.log('------------------------------------------------------------');
    console.log(`FOLD ${currentFold.fold}: ${date(currentFold.startMs)} -> ${date(currentFold.endMs)}`);
    console.log('------------------------------------------------------------');

    for (const symbol of opts.symbols) {
      const data = datasets.get(symbol);
      const startIndex = data.candles.findIndex(c => c.t >= currentFold.startMs);
      const endIndexFound = data.candles.findIndex(c => c.t >= currentFold.endMs);
      const endIndex = endIndexFound >= 0 ? endIndexFound : data.candles.length;

      if (startIndex < 0 || startIndex >= endIndex) {
        console.log(`${symbol.padEnd(10)} OOS verisi yok`);
        continue;
      }

      // Geçmiş mumlar yalnızca indikatör bağlamıdır; performans startIndex'ten ölçülür.
      const candles = data.candles.slice(0, endIndex);
      const result = runBacktest({
        candles,
        startIndex,
        strategy,
        params,
        capital: CAPITAL,
        feePct: FEE_PCT,
        slippagePct: SLIPPAGE_PCT
      });

      const row = {
        fold: currentFold.fold,
        symbol,
        timeframe: opts.tf,
        oosStart: result.startT,
        oosEnd: result.endT,
        candlesTested: result.candlesTested,
        returnPct: result.returnPct,
        buyHoldPct: result.buyHoldPct,
        maxDrawdownPct: result.maxDrawdownPct,
        buyHoldMaxDrawdownPct: result.buyHoldMaxDrawdownPct,
        trades: result.trades,
        winRatePct: result.winRatePct,
        profitFactor: result.profitFactor,
        avgTradePct: result.avgTradePct,
        worstTradePct: result.worstTradePct,
        exposurePct: result.exposurePct,
        feesPct: result.feesPct,
        slippagePct: result.slippagePct
      };
      results.push(row);

      console.log(
        `${symbol.padEnd(10)} OOS ${date(result.startT)}→${date(result.endT)} | ` +
        `Trend ${fmtPct(result.returnPct).padStart(9)} | ` +
        `B&H ${fmtPct(result.buyHoldPct).padStart(9)} | ` +
        `DD ${fmtPct(result.maxDrawdownPct).padStart(9)} | ` +
        `Trades ${String(result.trades).padStart(3)} | PF ${fmtNum(result.profitFactor)}`
      );
    }
    console.log('');
  }

  const summary = summarize(results);

  console.log('============================================================');
  console.log('FINAL ROLLING OOS');
  console.log('============================================================');
  console.log(`OOS fold/parite sonuçları : ${summary.resultCount}`);
  console.log(`Pozitif sonuç             : ${summary.positive}/${summary.resultCount} (${fmtPct(summary.positiveRatePct)})`);
  console.log(`B&H'yi geçen              : ${summary.beatBuyHold}/${summary.resultCount} (${fmtPct(summary.beatBuyHoldRatePct)})`);
  console.log(`Ortalama OOS getiri       : ${fmtPct(summary.avgReturnPct)}`);
  console.log(`Ortalama B&H              : ${fmtPct(summary.avgBuyHoldPct)}`);
  console.log(`Bileşik Trend OOS (parite ort.): ${fmtPct(summary.compoundedReturnPct)}`);
  console.log(`Bileşik B&H (parite ort.)      : ${fmtPct(summary.compoundedBuyHoldPct)}`);
  console.log(`Toplam OOS işlem          : ${summary.totalTrades}`);
  console.log(`En kötü fold DD            : ${fmtPct(summary.worstFoldDrawdownPct)}`);
  console.log('');
  console.log('Kurallar: parametre seçimi yok; OOS sonucu sonraki foldu değiştirmez.');
  console.log('Simulator: mevcut runBacktest() ile aynı execution/maliyet modeli.');

  fs.mkdirSync(opts.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(opts.out, `trend-v1-walk-forward-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({
    generatedAt: new Date().toISOString(),
    strategy: 'trend_filter',
    params,
    options: {
      months: opts.months,
      oosMonths: opts.oosMonths,
      contextMonths: opts.contextMonths,
      timeframe: opts.tf,
      symbols: opts.symbols,
      capital: CAPITAL,
      feePct: FEE_PCT,
      slippagePct: SLIPPAGE_PCT
    },
    folds,
    results,
    summary
  }, null, 2));
  console.log(`JSON kaydı: ${file}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\nHATA: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, summarize };
