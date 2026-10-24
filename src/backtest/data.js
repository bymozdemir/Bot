// src/backtest/data.js
//
// Binance'ten GECMIS mum verisi indirir (herkese acik uc, API anahtari gerekmez),
// 1000'erlik sayfalarla, ve diske onbellekler. Ayni gun ikinci calistirmada
// internete hic cikmaz.
//
// Kural: henuz KAPANMAMIS mum asla veriye girmez (backtest sadece kapanmis
// mumlarla calisir).

const fs = require('fs');
const path = require('path');
const { fetchWithRetry, sleep } = require('../util/retry');

const DEFAULT_BASE_URL = 'https://api.binance.com';
const INTERVAL_MS = {
  '1m': 60 * 1000, '3m': 3 * 60 * 1000, '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000, '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000, '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000, '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000, '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000
};
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 1000; // Binance klines sayfa ust siniri
const WARMUP_CANDLES = 800; // test penceresinden ONCE indirilen isinma mumu (EMA200 vb. icin)

const toBinanceSymbol = (symbol) => symbol.replace('/', '').toUpperCase();
const monthsToMs = (months) => months * 30.4375 * DAY_MS;

// [startMs, endMs) araligindaki KAPANMIS mumlari sayfa sayfa indirir.
// fetchFn: (url) => Response benzeri ({ ok, status, json(), text() }). Testlerde sahtesi verilir.
async function fetchKlinesRange({ symbol, interval, startMs, endMs, baseUrl = DEFAULT_BASE_URL, fetchFn = fetchWithRetry, pauseMs = 250, nowMs = Date.now() }) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Desteklenmeyen mum aralığı: ${interval} (${Object.keys(INTERVAL_MS).join(', ')})`);

  const byTime = new Map();
  let cursor = startMs;
  let pages = 0;
  while (cursor < endMs) {
    const qs = new URLSearchParams({
      symbol: toBinanceSymbol(symbol),
      interval,
      startTime: String(cursor),
      endTime: String(endMs),
      limit: String(PAGE_LIMIT)
    });
    const res = await fetchFn(`${baseUrl}/api/v3/klines?${qs}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Binance klines başarısız (${res.status}) ${symbol} ${interval}: ${String(body).slice(0, 160)}`);
    }
    const raw = await res.json();
    pages++;
    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const k of raw) {
      const closeTime = Number(k[6]);
      if (closeTime >= nowMs) continue; // henuz kapanmamis (olusuyor)
      byTime.set(k[0], { t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]) });
    }
    const lastOpen = raw[raw.length - 1][0];
    if (lastOpen + step <= cursor) break; // ilerlemiyorsa sonsuz donguye girme
    cursor = lastOpen + step;
    if (raw.length < PAGE_LIMIT) break;
    if (pauseMs) await sleep(pauseMs);
  }

  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) if (candles[i].t - candles[i - 1].t !== step) gaps++;
  return { candles, gaps, pages };
}

function cachePath(cacheDir, symbol, interval, months, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return path.join(cacheDir, `${toBinanceSymbol(symbol)}-${interval}-${months}m-${day}.json`);
}

// Test penceresi = son `months` ay. Pencereden onceki WARMUP_CANDLES mum da indirilir
// (gostergelerin isinmasi icin) ama sonuca sayilmaz: startIndex pencerenin ilk mumunu gosterir.
const CACHE_MAX_AGE_DAYS = 7;

// Ayni coin/aralik/ay icin son CACHE_MAX_AGE_DAYS gun icinde indirilmis en yeni dosyayi bulur.
function findRecentCache(cacheDir, symbol, interval, months, nowMs) {
  try {
    const prefix = `${toBinanceSymbol(symbol)}-${interval}-${months}m-`;
    const limit = nowMs - CACHE_MAX_AGE_DAYS * 86400000;
    let best = null;
    for (const name of fs.readdirSync(cacheDir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const day = name.slice(prefix.length, -5);
      const t = Date.parse(`${day}T00:00:00Z`);
      if (!Number.isFinite(t) || t < limit || t > nowMs + 86400000) continue;
      if (!best || t > best.t) best = { t, file: path.join(cacheDir, name) };
    }
    return best ? best.file : null;
  } catch (e) {
    return null;
  }
}

async function loadCandles({ symbol, interval, months, baseUrl, cacheDir, refresh = false, nowMs = Date.now(), fetchFn, pauseMs }) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Desteklenmeyen mum aralığı: ${interval}`);
  const windowStartMs = nowMs - monthsToMs(months);
  const file = cacheDir ? cachePath(cacheDir, symbol, interval, months, nowMs) : null;
  const readFile = cacheDir && !refresh ? (fs.existsSync(file) ? file : findRecentCache(cacheDir, symbol, interval, months, nowMs)) : null;

  let candles = null;
  let gaps = 0;
  let fromCache = false;
  if (readFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(readFile, 'utf8'));
      if (Array.isArray(cached.candles) && cached.candles.length > 0) {
        candles = cached.candles;
        gaps = cached.gaps || 0;
        fromCache = true;
      }
    } catch (e) {
      /* bozuk onbellek: yeniden indirilir */
    }
  }

  if (!candles) {
    const r = await fetchKlinesRange({
      symbol,
      interval,
      startMs: windowStartMs - WARMUP_CANDLES * step,
      endMs: nowMs,
      baseUrl,
      fetchFn,
      pauseMs,
      nowMs
    });
    candles = r.candles;
    gaps = r.gaps;
    if (file && candles.length > 0) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ symbol, interval, months, fetchedAt: new Date(nowMs).toISOString(), gaps, candles }));
    }
  }

  if (candles.length === 0) throw new Error(`${symbol} ${interval} için hiç mum alınamadı.`);
  let startIndex = candles.findIndex((c) => c.t >= windowStartMs);
  if (startIndex === -1) startIndex = candles.length; // hic pencere verisi yok
  return { candles, startIndex, gaps, fromCache, windowStartMs };
}

module.exports = { fetchKlinesRange, loadCandles, INTERVAL_MS, WARMUP_CANDLES, DEFAULT_BASE_URL, monthsToMs };
