#!/usr/bin/env node
// backtest.js -- stratejileri GECMIS verilerde dener (gercek para/emir yok).
//
// Kullanim:
//   node backtest.js                      # 5 parite, 1h+4h, son 6 ay, tum stratejiler
//   node backtest.js --tf 4h --months 3
//   node backtest.js --symbols BTC/USDT,ETH/USDT --strategies ema_cross,rsi_simple
//   node backtest.js --detail             # parite/strateji bazinda ayrinti da yazdir
//   node backtest.js --tf 4h,1d --sens   # maliyet duyarliligi (brut/dusuk/varsayilan/yuksek)
//   node backtest.js --months 60 --check # --check sabit 24 aylık kabul ölçütlerini ayrıca raporlar
//   node backtest.js --no-dca             # DCA referansini tablodan cikar (varsayilan: dahil, haftalik)
//   node backtest.js --dca-days 14        # DCA alim araligi (gun)
//   node backtest.js --refresh            # onbellegi yoksay, verileri yeniden indir
//   node backtest.js --base https://data-api.binance.vision   # alternatif (yalnizca piyasa verisi) adres
//
//   node backtest.js --risk               # Sharpe/Sortino/Calmar + Monte Carlo + anlamlilik (p-degeri)
// Secenekler: --fee 0.1  --slip 0.05  --capital 1000  --out klasor
// Cikti: ekrana ozet + data/backtest/ altina ozet (.txt) ve tum ayrintilar (.json).

const fs = require('fs');
const path = require('path');
const strategies = require('./src/strategies');
const store = require('./src/store');
const { loadCandles, INTERVAL_MS, DEFAULT_BASE_URL } = require('./src/backtest/data');
const { runBacktest } = require('./src/backtest/simulator');
const { runDca, DCA_ID } = require('./src/backtest/dca');
const { aggregate, formatSummary, formatDetail, formatSensitivity, formatCriteria, formatRisk } = require('./src/backtest/report');
const { evaluateCriteria, CRITERIA_VERSION, REQUIRED_MONTHS } = require('./src/backtest/criteria');

const SYMBOL_RE = /^[A-Z0-9]{2,20}\/[A-Z0-9]{2,10}$/;

// --sens: ayni sinyaller bu komisyon/kayma senaryolariyla tekrar kosulur.
// Gercek komisyon oranini kendi borsa hesabindan teyit et; buradaki degerler varsayimdir.
const SENS_SCENARIOS = [
  { label: 'brüt', feePct: 0, slippagePct: 0 },
  { label: 'düşük', feePct: 0.075, slippagePct: 0.02 },
  { label: 'vars.', feePct: 0.1, slippagePct: 0.05 },
  { label: 'yüksek', feePct: 0.2, slippagePct: 0.1 }
];

function parseArgs(argv) {
  const opts = {
    symbols: Object.keys(store.defaultState().pairs),
    tf: ['1h', '4h'],
    months: 6,
    strategies: strategies.list().map((s) => s.id),
    feePct: 0.1,
    slippagePct: 0.05,
    capital: 1000,
    baseUrl: process.env.BINANCE_BASE_URL || DEFAULT_BASE_URL,
    refresh: false,
    detail: false,
    sens: false,
    check: false,
    dca: true,
    dcaDays: 7,
    out: path.join(__dirname, 'data', 'backtest')
  };
  const takesValue = new Set(['--dca-days', '--symbols', '--tf', '--months', '--strategies', '--fee', '--slip', '--capital', '--base', '--out']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--refresh') opts.refresh = true;
    else if (a === '--detail') opts.detail = true;
    else if (a === '--sens') opts.sens = true;
    else if (a === '--no-dca') opts.dca = false;
    else if (a === '--check') opts.check = true;
    else if (a === '--risk') opts.risk = true;
    else if (takesValue.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} için bir değer gerekli.`);
      if (a === '--symbols') opts.symbols = v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (a === '--tf') opts.tf = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (a === '--strategies') opts.strategies = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (a === '--months') opts.months = Number(v);
      if (a === '--dca-days') opts.dcaDays = Number(v);
      if (a === '--fee') opts.feePct = Number(v);
      if (a === '--slip') opts.slippagePct = Number(v);
      if (a === '--capital') opts.capital = Number(v);
      if (a === '--base') opts.baseUrl = v.replace(/\/+$/, '');
      if (a === '--out') opts.out = v;
    } else {
      throw new Error(`Bilinmeyen seçenek: ${a}`);
    }
  }
  if (!Number.isFinite(opts.months) || opts.months < 1 || opts.months > 60) throw new Error('--months 1 ile 60 arasında olmalı.');
  if (!Number.isFinite(opts.feePct) || opts.feePct < 0 || opts.feePct > 5) throw new Error('--fee 0 ile 5 arasında olmalı (yüzde).');
  if (!Number.isFinite(opts.slippagePct) || opts.slippagePct < 0 || opts.slippagePct > 5) throw new Error('--slip 0 ile 5 arasında olmalı (yüzde).');
  if (!Number.isFinite(opts.capital) || opts.capital <= 0) throw new Error('--capital pozitif bir sayı olmalı.');
  if (!Number.isFinite(opts.dcaDays) || opts.dcaDays < 1 || opts.dcaDays > 90) throw new Error('--dca-days 1 ile 90 arasında olmalı.');
  for (const t of opts.tf) if (!INTERVAL_MS[t]) throw new Error(`Desteklenmeyen mum aralığı: ${t} (${Object.keys(INTERVAL_MS).join(', ')})`);
  for (const s of opts.symbols) if (!SYMBOL_RE.test(s)) throw new Error(`Parite biçimi BAZ/KASA olmalı: ${s}`);
  for (const id of opts.strategies) strategies.get(id); // bilinmiyorsa anlasilir hata firlatir
  if (!opts.symbols.length || !opts.tf.length || !opts.strategies.length) throw new Error('Parite, mum aralığı ve strateji boş olamaz.');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cacheDir = path.join(opts.out, 'veri');
  const results = [];
  let gaps = 0;
  let startT = Infinity;
  let endT = 0;

  console.error(`Veri: ${opts.baseUrl} | ${opts.symbols.length} parite x ${opts.tf.join(',')} | son ${opts.months} ay`);
  for (const tf of opts.tf) {
    for (const symbol of opts.symbols) {
      const label = `${symbol} ${tf}`;
      let data;
      try {
        data = await loadCandles({ symbol, interval: tf, months: opts.months, baseUrl: opts.baseUrl, cacheDir, refresh: opts.refresh });
      } catch (e) {
        throw new Error(
          `${label} verisi alınamadı: ${e.message}\n` +
            'Ağı denemek için: curl -sS -i --max-time 10 ' + opts.baseUrl + '/api/v3/ping\n' +
            'Ana adres engelliyse: node backtest.js --base https://data-api.binance.vision'
        );
      }
      gaps += data.gaps;
      console.error(`  ${label}: ${data.candles.length} mum (${data.fromCache ? 'önbellek' : 'indirildi'}), test penceresi ${data.candles.length - data.startIndex} mum`);

      for (const id of opts.strategies) {
        const strategy = strategies.get(id);
        const r = runBacktest({
          candles: data.candles,
          startIndex: data.startIndex,
          strategy,
          params: strategy.defaultParams,
          capital: opts.capital,
          feePct: opts.feePct,
          slippagePct: opts.slippagePct
        });
        if (opts.sens) {
          r.sens = SENS_SCENARIOS.map((sc) => {
            const x = runBacktest({ candles: data.candles, startIndex: data.startIndex, strategy, params: strategy.defaultParams, capital: opts.capital, feePct: sc.feePct, slippagePct: sc.slippagePct });
            return { returnPct: x.returnPct, buyHoldPct: x.buyHoldPct, maxDrawdownPct: x.maxDrawdownPct, trades: x.trades };
          });
        }
        startT = Math.min(startT, r.startT);
        endT = Math.max(endT, r.endT);
        results.push({ timeframe: tf, symbol, strategyId: id, ...r });
      }

      // DCA referansi (strateji degil, yatirim yontemi): ayni tabloda yan yana gorunur.
      if (opts.dca) {
        const dcaArgs = { candles: data.candles, startIndex: data.startIndex, intervalDays: opts.dcaDays, capital: opts.capital };
        const r = runDca({ ...dcaArgs, feePct: opts.feePct, slippagePct: opts.slippagePct });
        if (opts.sens) {
          r.sens = SENS_SCENARIOS.map((sc) => {
            const x = runDca({ ...dcaArgs, feePct: sc.feePct, slippagePct: sc.slippagePct });
            return { returnPct: x.returnPct, buyHoldPct: x.buyHoldPct, maxDrawdownPct: x.maxDrawdownPct, trades: x.trades };
          });
        }
        startT = Math.min(startT, r.startT);
        endT = Math.max(endT, r.endT);
        results.push({ timeframe: tf, symbol, strategyId: DCA_ID, ...r });
      }
    }
  }

  const meta = {
    startT,
    endT,
    days: Math.round((endT - startT) / 86400000),
    capital: opts.capital,
    feePct: opts.feePct,
    slippagePct: opts.slippagePct,
    symbols: opts.symbols,
    gaps
  };
  const agg = aggregate(results);
  let text = formatSummary(meta, agg);
  if (opts.detail) text += '\n' + formatDetail(results);
  if (opts.sens) text += '\n\n' + formatSensitivity(results, SENS_SCENARIOS);
  if (opts.risk) text += '\n\n' + formatRisk(results);
  if (opts.check) text += '\n\n' + formatCriteria(evaluateCriteria(results), opts.months, CRITERIA_VERSION, REQUIRED_MONTHS);

  fs.mkdirSync(opts.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const txtFile = path.join(opts.out, `ozet-${stamp}.txt`);
  const jsonFile = path.join(opts.out, `sonuc-${stamp}.json`);
  fs.writeFileSync(txtFile, text + '\n');
  fs.writeFileSync(jsonFile, JSON.stringify({ meta, options: { ...opts }, aggregate: agg, criteria: opts.check ? evaluateCriteria(results) : undefined, results }, null, 1));

  console.log('\n' + text);
  console.error(`\nKaydedildi: ${txtFile}\n            ${jsonFile}`);
}

main().catch((e) => {
  console.error('\nHata: ' + e.message);
  process.exit(1);
});
