// KAGIT MOTOR = BACKTEST. Ayni mum verisini ayni anda iki tarafa da veriyoruz:
//  * backtest: tum seriyi bir seferde simule eder
//  * kagit motor: seriyi mum mum "canli" gibi (her turda bir mum daha, olusan mumla) gorur
// Islem listeleri (giris/cikis fiyati, neden, zaman) BIREBIR ayni cikmali.
const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');
const { runBacktest } = require('../src/backtest/simulator');

const H = 3600000;
const T0 = Date.UTC(2026, 0, 1, 0, 0);

function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// drift: mum basina egilim; pullbackProb: yukselis icinde 10 mumluk geri cekilme baslatma olasiligi
// (RSI'yi asiri satima cekip secici stratejileri -ornegin rsi_ema_macd- tetikler)
function walk(n, seed, sigma, drift = 0, pullbackProb = 0, pullbackDrift = -0.009) {
  const r = rng(seed); const out = []; let prev = 100; let pb = 0;
  for (let i = 0; i < n; i++) {
    const z = (r() + r() + r() + r() - 2) * 1.7; const o = prev * (1 + (r() - 0.5) * 0.004);
    if (pb === 0 && r() < pullbackProb) pb = 10;
    const dip = pb > 0 ? pullbackDrift : 0;
    if (pb > 0) pb--;
    const c = o * Math.exp(sigma * z + drift + dip);
    out.push({ t: T0 + i * H, o, h: Math.max(o, c) * (1 + r() * 0.006), l: Math.min(o, c) * (1 - r() * 0.006), c, v: 1 });
    prev = c;
  }
  return out;
}

async function replay(strategyId, candles, startIndex, params) {
  const state = store.defaultState();
  state.running = true;
  state.pairs = { 'BTC/USDT': { symbol: 'BTC/USDT', enabled: true, strategyId, timeframe: '1h', budgetPct: 100, params } };
  Object.assign(state.settings, { maxTradeQuote: 0, reserveCashPct: 0, maxConcurrentPositions: 1, dailyLossLimitPct: 100, killSwitchLossPct: 0, paperFeePct: 0.1, paperSlippagePct: 0.05, pollSeconds: 60 });
  state.paper = store.defaultPaper(1000);
  let k = 0;
  const exchange = {
    quoteAssets: ['USDT'],
    fetchCandles: async (sym, tf, limit) => candles.slice(Math.max(0, k + 1 - limit), k + 1), // k. mum "olusan"
    fetchSymbolRules: async () => ({ minNotional: 0.0001, stepSize: 0, minQty: 0 })
  };
  const engine = new PaperEngine({ exchange, store: { save() {} }, state, nowFn: () => candles[k].t + 30000 });
  engine.log = () => {};
  for (k = startIndex + 1; k < candles.length; k++) await engine.tick();
  return state;
}

for (const strategyId of ['rsi_ema_macd', 'ema_cross', 'bollinger_reversion', 'macd_momentum', 'rsi_simple', 'trend_filter', 'trend_filter_v2']) {
  test(`eslesme: ${strategyId} kagit motor == backtest (islem listesi birebir)`, async () => {
    const strat = strategies.get(strategyId);
    let totalTrades = 0;
    for (const [seed, sigma, drift, pbProb, pbDrift] of [[11, 0.02, 0, 0], [12, 0.03, 0, 0], [13, 0.015, 0, 0], [14, 0.008, 0.004, 0.03, -0.009], [15, 0.006, 0.004, 0.03, -0.007], [16, 0.01, 0.005, 0.05, -0.008]]) {
      const candles = walk(900, seed, sigma, drift, pbProb, pbDrift);
      const startIndex = 350;
      const params = { ...strat.defaultParams };
      const bt = runBacktest({ candles, startIndex, strategy: strat, params, capital: 1000, feePct: 0.1, slippagePct: 0.05 });
      const state = await replay(strategyId, candles, startIndex, params);

      const btClosed = bt.tradeList.filter((t) => !t.forced);
      const btForced = bt.tradeList.find((t) => t.forced);
      const paper = [...state.paper.trades].reverse();
      const ctx = `${strategyId} seed ${seed}`;

      assert.equal(paper.length, btClosed.length, `${ctx}: islem sayisi`);
      paper.forEach((t, i) => {
        const b = btClosed[i];
        assert.ok(Math.abs(t.entryPrice - b.entryPrice) < 1e-9 * b.entryPrice, `${ctx} #${i}: giris ${t.entryPrice} != ${b.entryPrice}`);
        assert.ok(Math.abs(t.exitPrice - b.exitPrice) < 1e-9 * b.exitPrice, `${ctx} #${i}: cikis ${t.exitPrice} != ${b.exitPrice}`);
        assert.ok(Math.abs(t.pnl - b.pnl) < 1e-6, `${ctx} #${i}: pnl ${t.pnl} != ${b.pnl}`);
        assert.equal(t.reason, b.reason, `${ctx} #${i}: neden`);
        assert.equal(Date.parse(t.openedAt) - 30000, b.openedAt, `${ctx} #${i}: acilis zamani`);
        assert.equal(Date.parse(t.closedAt) - 30000, b.closedAt, `${ctx} #${i}: kapanis zamani`);
      });
      // Test sonunda acik kalan pozisyon: backtest zorla kapatir, kagit motorda acik gorunur.
      const open = state.paper.positions['BTC/USDT'];
      assert.equal(!!open, !!btForced, `${ctx}: son acik pozisyon`);
      if (open) assert.ok(Math.abs(open.entryPrice - btForced.entryPrice) < 1e-9 * open.entryPrice, `${ctx}: acik pozisyon girisi`);
      totalTrades += paper.length + (open ? 1 : 0);
    }
    assert.ok(totalTrades > 0, `${strategyId}: test hic islem uretmedi, anlamsiz`);
  });
}
