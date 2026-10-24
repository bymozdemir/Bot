const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { runBacktest } = require('../src/backtest/simulator');
const { aggregate, formatSummary, formatDetail } = require('../src/backtest/report');

const H = 3600000;
const C = (i, o, h, l, c) => ({ t: i * H, o, h, l, c, v: 1 });
const flatC = (n, p) => Array.from({ length: n }, (_, i) => C(i, p, p, p, p));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ZERO = { feePct: 0, slippagePct: 0, capital: 1000 };

// script(ctx, idx) -> karar. idx = kacinci evaluate cagrisi.
function fake(script, defaults = { stopLossPct: 3, takeProfitPct: 6, trailingStop: false }) {
  let calls = 0;
  return { id: 'fake', defaultParams: defaults, minCandles: () => 1, evaluate: (ctx) => script(ctx, calls++) || { action: 'hold', reason: 'bekle' } };
}
const lastT = (ctx) => ctx.candles[ctx.candles.length - 1].t;
// i. mumun kapanisinda al
const buyAtIdx = (k) => (ctx) => (lastT(ctx) === k * H && !ctx.position ? { action: 'buy', reason: 'test alim' } : null);

function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function walk(n, seed = 1, start = 100, sigma = 0.012) {
  const r = rng(seed); const out = []; let prev = start;
  for (let i = 0; i < n; i++) {
    const z = (r() + r() + r() + r() - 2) * 1.7; const o = prev; const c = o * Math.exp(sigma * z + 0.0002);
    out.push(C(i, o, Math.max(o, c) * (1 + r() * 0.004), Math.min(o, c) * (1 - r() * 0.004), c)); prev = c;
  }
  return out;
}

test('emir, sinyalin geldigi mumun DEGIL bir sonraki mumun ACILISINDA dolar (ileriye bakma yok)', () => {
  const candles = flatC(6, 100);
  candles[2] = C(2, 120, 120, 120, 120); // sinyalden sonraki mum 120'den aciliyor
  candles[3] = C(3, 120, 120, 120, 120); candles[4] = C(4, 120, 120, 120, 120); candles[5] = C(5, 120, 120, 120, 120);
  const r = runBacktest({ candles, strategy: fake(buyAtIdx(1)), ...ZERO });
  assert.equal(r.tradeList[0].entryPrice, 120); // 100 (kapanis) degil
});

test('strateji her adimda SADECE o ana kadarki mumlari gorur', () => {
  const candles = walk(50);
  let expected = 0; let seen = 0;
  const strat = fake((ctx) => {
    assert.equal(lastT(ctx), expected * H, 'gelecekteki muma bakildi');
    assert.ok(ctx.candles.every((c) => c.t <= expected * H));
    expected++; seen++;
  });
  runBacktest({ candles, strategy: strat, ...ZERO });
  assert.equal(seen, candles.length - 1); // son mumda sinyal uretilmez
});

test('komisyon ve kayma: alimda fiyat yukari, satimda asagi; maliyet formulu dogru', () => {
  const r = runBacktest({ candles: flatC(6, 100), strategy: fake(buyAtIdx(1)), feePct: 0.1, slippagePct: 0.05, capital: 1000 });
  const t = r.tradeList[0];
  near(t.entryPrice, 100.05);
  near(t.exitPrice, 99.95);
  assert.equal(t.forced, true);
  assert.match(t.reason, /test sonu/);
  near(r.finalEquity, (1000 / (100.05 * 1.001)) * 99.95 * 0.999, 1e-6);
  assert.ok(r.returnPct < 0);
  assert.ok(r.feesPct > 0 && r.slippagePct > 0);
});

test('maliyetsiz ve sabit fiyatta sermaye korunur; hic islem yoksa metrikler guvenli', () => {
  const r = runBacktest({ candles: flatC(20, 100), strategy: fake(() => null), ...ZERO });
  assert.equal(r.finalEquity, 1000);
  assert.equal(r.trades, 0);
  assert.equal(r.winRatePct, null);
  assert.equal(r.profitFactor, null);
  assert.equal(r.exposurePct, 0);
  assert.equal(r.maxDrawdownPct, 0);
});

function stopScenario(afterEntryCandle) {
  const candles = [C(0, 100, 100, 100, 100), C(1, 100, 100, 100, 100), C(2, 100, 100, 100, 100), afterEntryCandle, C(4, 100, 100, 100, 100), C(5, 100, 100, 100, 100)];
  return runBacktest({ candles, strategy: fake(buyAtIdx(1)), ...ZERO });
}

test('stop-loss mum icinde tetiklenir ve STOP fiyatindan dolar', () => {
  const t = stopScenario(C(3, 100, 101, 96, 98)).tradeList[0];
  assert.equal(t.reason, 'stop-loss');
  near(t.exitPrice, 97);
  near(t.pnlPct, -3);
});

test('stop\'un altinda BOSLUKLA acilirsa dolum acilis fiyatindan olur (stop fiyatindan degil)', () => {
  const t = stopScenario(C(3, 90, 91, 88, 89)).tradeList[0];
  near(t.exitPrice, 90);
  near(t.pnlPct, -10);
});

test('take-profit artık çıkış değildir; %6 eşiği kâr korumayı aktive eder', () => {
  const a = stopScenario(C(3, 100, 110, 107, 105)).tradeList[0];
  assert.equal(a.forced, false);
  assert.equal(a.reason, 'profit-protection stop');
  near(a.exitPrice, 100);
  const b = stopScenario(C(3, 108, 110, 107, 109)).tradeList[0];
  assert.equal(b.forced, false);
  assert.equal(b.reason, 'profit-protection stop');
  near(b.exitPrice, 100);
});

test('ayni mumda hem stop hem take-profit mumkunse STOP kabul edilir (kotu senaryo)', () => {
  const t = stopScenario(C(3, 100, 110, 95, 100)).tradeList[0];
  assert.equal(t.reason, 'stop-loss');
  near(t.exitPrice, 97);
});

test('pozisyonun acildigi mumda da stop calisir', () => {
  const candles = [C(0, 100, 100, 100, 100), C(1, 100, 100, 100, 100), C(2, 100, 100, 94, 95), C(3, 95, 95, 95, 95)];
  const t = runBacktest({ candles, strategy: fake(buyAtIdx(1)), ...ZERO }).tradeList[0];
  assert.equal(t.reason, 'stop-loss');
  assert.equal(t.bars, 0);
});

test('strateji satis sinyali: bir sonraki acilistan cikar', () => {
  const strat = fake((ctx) => {
    if (lastT(ctx) === 1 * H && !ctx.position) return { action: 'buy', reason: 'al' };
    if (lastT(ctx) === 3 * H && ctx.position) return { action: 'sell', reason: 'MACD asagi' };
    return null;
  }, { stopLossPct: 50, takeProfitPct: 500, trailingStop: false });
  const candles = [C(0, 100, 100, 100, 100), C(1, 100, 100, 100, 100), C(2, 100, 102, 100, 101), C(3, 101, 104, 101, 103), C(4, 105, 106, 104, 105), C(5, 105, 105, 105, 105)];
  const r = runBacktest({ candles, strategy: strat, ...ZERO });
  assert.equal(r.tradeList[0].reason, 'MACD asagi');
  near(r.tradeList[0].exitPrice, 105); // sinyal mumunun kapanisi (103) degil
  near(r.returnPct, 5);
});

test('trailing stop zirveyi izler', () => {
  const candles = [C(0, 100, 100, 100, 100), C(1, 100, 100, 100, 100), C(2, 100, 100, 100, 100), C(3, 100, 110, 105, 108), C(4, 108, 109, 106, 107), C(5, 107, 107, 107, 107)];
  const strat = fake(buyAtIdx(1), { stopLossPct: 3, takeProfitPct: 50, trailingStop: true });
  const t = runBacktest({ candles, strategy: strat, ...ZERO }).tradeList[0];
  assert.equal(t.reason, 'profit-protection stop');
  near(t.exitPrice, 106.7); // 110 * 0.97
});

test('al-tut referansi ve maksimum dusus dogru', () => {
  const candles = [C(0, 100, 100, 100, 100), C(1, 100, 120, 100, 120), C(2, 120, 120, 60, 60), C(3, 60, 90, 60, 90)];
  const r = runBacktest({ candles, strategy: fake(() => null), ...ZERO });
  near(r.buyHoldPct, -10);
  near(r.buyHoldMaxDrawdownPct, -50);
  // maliyetli al-tut: tek gidis-donus
  const c2 = flatC(10, 100);
  const r2 = runBacktest({ candles: c2, strategy: fake(() => null), feePct: 0.1, slippagePct: 0.05, capital: 1000 });
  near(r2.buyHoldPct, ((1 / (1.0005 * 1.001)) * 0.9995 * 0.999 - 1) * 100, 1e-9);
});

test('isinma mumlari sonuca sayilmaz: startIndex oncesi islem/ getiri yok', () => {
  const candles = walk(400, 3);
  const seenBefore = [];
  const strat = fake((ctx) => { seenBefore.push(ctx.candles.length); return null; });
  const r = runBacktest({ candles, startIndex: 300, strategy: strat, ...ZERO });
  assert.equal(r.candlesTested, 100);
  assert.equal(r.startT, candles[300].t);
  assert.equal(seenBefore.length, 99);
  assert.equal(seenBefore[0], 300, 'pencere candleLimit (300) uzunlugunda ve startIndex oncesi (isinma) mumlari icermeli');
});

test('5 gercek strateji: rastgele yuruyuste tutarlilik (NaN yok, kasa kimligi, yariler)', () => {
  for (const seed of [1, 2, 3]) {
    const candles = walk(600, seed, 100, 0.02);
    for (const s of strategies.list()) {
      const strat = strategies.get(s.id);
      const r = runBacktest({ candles, startIndex: 400, strategy: strat, params: strat.defaultParams, capital: 1000, feePct: 0.1, slippagePct: 0.05 });
      for (const k of ['returnPct', 'buyHoldPct', 'maxDrawdownPct', 'buyHoldMaxDrawdownPct', 'exposurePct', 'firstHalfPct', 'secondHalfPct', 'feesPct', 'slippagePct', 'finalEquity']) {
        assert.ok(Number.isFinite(r[k]), `${s.id} seed ${seed}: ${k}=${r[k]}`);
      }
      const sumPnl = r.tradeList.reduce((a, t) => a + t.pnl, 0);
      near(r.finalEquity, 1000 + sumPnl, 1e-6); // kasa kimligi: nakit zinciri tutarli
      near((1 + r.firstHalfPct / 100) * (1 + r.secondHalfPct / 100), 1 + r.returnPct / 100, 1e-9);
      assert.ok(r.maxDrawdownPct <= 0 && r.maxDrawdownPct >= -100);
      assert.ok(r.exposurePct >= 0 && r.exposurePct <= 100);
      assert.ok(r.tradeList.every((t) => t.closedAt >= t.openedAt && t.exitPrice > 0));
      // Ayni girdi -> ayni cikti
      const again = runBacktest({ candles, startIndex: 400, strategy: strat, params: strat.defaultParams, capital: 1000, feePct: 0.1, slippagePct: 0.05 });
      assert.deepEqual(again, r);
    }
  }
});

test('rapor: ozet dar ekrana sigar, al-tut ve uyarilar var', () => {
  const rows = [];
  for (const symbol of ['BTC/USDT', 'ETH/USDT']) for (const strategyId of ['rsi_ema_macd', 'ema_cross']) {
    const candles = walk(600, symbol === 'BTC/USDT' ? 5 : 6);
    const strat = strategies.get(strategyId);
    rows.push({ timeframe: '1h', symbol, strategyId, ...runBacktest({ candles, startIndex: 400, strategy: strat, params: strat.defaultParams }) });
  }
  const agg = aggregate(rows);
  assert.equal(agg['1h'].symbols.length, 2);
  assert.equal(Object.keys(agg['1h'].strategies).length, 2);
  const text = formatSummary({ startT: 0, endT: 182 * 86400000, days: 182, capital: 1000, feePct: 0.1, slippagePct: 0.05, symbols: ['BTC/USDT', 'ETH/USDT'], gaps: 0 }, agg);
  assert.match(text, /BACKTEST ÖZETİ/);
  assert.match(text, /=== 1h mumlar/);
  assert.match(text, /al-tut/);
  assert.match(text, /optimizasyon yok/);
  for (const line of text.split('\n')) assert.ok(line.length <= 46, `satir cok uzun (${line.length}): ${line}`);
  assert.match(formatDetail(rows), /Ayrıntı 1h/);
});


test('ATR/stratejiye özel başlangıç stop mesafesi backtest pozisyonuna aktarılır', () => {
  const candles = flatC(6, 100);
  candles[2] = C(2, 100, 100.5, 97.4, 99);
  const strat = fake((ctx, call) => call === 1 && !ctx.position
    ? { action: 'buy', reason: 'ATR test', suggestedStopDistance: 2.5 }
    : null);
  const r = runBacktest({ candles, strategy: strat, ...ZERO });
  assert.equal(r.tradeList.length, 1);
  assert.equal(r.tradeList[0].exitPrice, 97.5);
  assert.match(r.tradeList[0].reason, /stop/i);
});
