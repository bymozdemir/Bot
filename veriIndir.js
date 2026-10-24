#!/usr/bin/env node
// veriIndir.js -- SADECE mum verisini indirir (test yapmaz).
// Kullanim:
//   node veriIndir.js                       (varsayilan 10 coin, 1h, 60 ay)
//   node veriIndir.js --symbols BTC/USDT,ETH/USDT --tf 1h --months 60
// Veri data/backtest/veri altina kaydedilir; backtestSegments.js ayni klasoru kullanir.
// Not: --months degeri testte kullanilan toplam aya (varsayilan 24+24+12=60) esit olmali.

const path = require('path');
const { loadCandles, DEFAULT_BASE_URL } = require('./src/backtest/data');

const DEFAULT_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'TRX/USDT', 'LINK/USDT', 'AVAX/USDT'];

function parseArgs(argv) {
  const o = { symbols: DEFAULT_SYMBOLS, tf: '1h', months: 60, refresh: false, baseUrl: process.env.BINANCE_BASE_URL || DEFAULT_BASE_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--refresh') { o.refresh = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} için değer yok.`);
    if (a === '--symbols') o.symbols = v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--tf') o.tf = v;
    else if (a === '--months') o.months = Number(v);
    else if (a === '--base') o.baseUrl = v.replace(/\/+$/, '');
    else throw new Error(`Bilinmeyen seçenek: ${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cacheDir = path.join(__dirname, 'data', 'backtest', 'veri');
  const ok = [];
  const failed = [];
  for (let i = 0; i < o.symbols.length; i++) {
    const symbol = o.symbols[i];
    process.stderr.write(`[${i + 1}/${o.symbols.length}] ${symbol} ${o.tf} ${o.months} ay ... `);
    try {
      const d = await loadCandles({ symbol, interval: o.tf, months: o.months, baseUrl: o.baseUrl, cacheDir, refresh: o.refresh });
      console.error(`tamam (${d.candles.length} mum, boşluk: ${d.gaps || 0})`);
      ok.push(symbol);
    } catch (e) {
      console.error(`HATA: ${e.message}`);
      failed.push(symbol);
    }
  }
  console.error(`\nBaşarılı: ${ok.length}  Başarısız: ${failed.length}${failed.length ? ' -> ' + failed.join(', ') : ''}`);
  if (failed.length) console.error('Başarısız olanlar için aynı komutu tekrar çalıştır; inenler atlanır.');
}

main().catch((e) => { console.error('\nHata: ' + e.message); process.exit(1); });
