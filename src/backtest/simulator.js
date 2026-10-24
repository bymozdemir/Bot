// src/backtest/simulator.js
//
// Tek parite + tek strateji icin GERCEKCI (ileriye bakmayan) simulasyon.
//
// Kurallar (bilerek muhafazakar):
//  * Sinyal, mum KAPANDIGINDA sadece o ana kadarki KAPANMIS mumlarla uretilir.
//    Emir, bir SONRAKI mumun ACILISINDA dolar (kapanis fiyatindan almak ileriye bakmak olurdu).
//  * Her alim/satim kaymasi (slippage) ve komisyonu odenir; alimda fiyat yukari, satimda asagi kayar.
//  * Stop-loss / take-profit / trailing stop mum ICINDE kontrol edilir (dusuk/yuksek ile).
//    Fiyat stop'un altinda ACILIRSA (bosluk) dolum acilis fiyatindan olur, stop fiyatindan degil.
//    Ayni mumda hem stop hem take-profit mumkunse STOP kabul edilir (kotu senaryo).
//  * Trailing stop icin mum icindeki sira bilinmez: onceki zirve esas alinir (hafif iyimser).
//  * Pozisyon her seferinde ayrilan sermayenin TAMAMIYLA acilir (tek parite, tek pozisyon).
//  * Test sonunda acik pozisyon son kapanistan (maliyetleriyle) kapatilir ve isaretlenir.
//
// Strateji, canli botla AYNI evaluate() fonksiyonu ve AYNI mum penceresi
// uzunlugudur (strategies.candleLimit).

const { candleLimit } = require('../strategies');
const { buyFill, sellFill, intrabarRiskExit, breakEvenBufferPct } = require('../execution');
const { normalizeTimeBarrier } = require('../timeBarrier');
const { equityMetrics, tradeMetrics } = require('./metrics');

function maxDrawdownPct(series, start) {
  let peak = start;
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = (v / peak - 1) * 100;
    if (dd < worst) worst = dd;
  }
  return worst;
}

// Al-tut referansi: ayni maliyetlerle TEK gidis-donus (baslangicta al, sonda sat).
// DCA modulu (dca.js) de ayni referansi kullanir, boylece karsilastirma adil olur.
function buyAndHold(candles, startIndex, capital, feePct, slippagePct) {
  const fee = feePct / 100;
  const slip = slippagePct / 100;
  const last = candles.length - 1;
  const entryFill = candles[startIndex].o * (1 + slip);
  const qty = capital / (entryFill * (1 + fee));
  const final = qty * candles[last].c * (1 - slip) * (1 - fee);
  const series = [];
  for (let i = startIndex; i < candles.length; i++) series.push(qty * candles[i].c * (1 - slip) * (1 - fee));
  return { pct: (final / capital - 1) * 100, maxDrawdownPct: maxDrawdownPct(series, capital) };
}

function barsPerYearOf(candles) {
  const step = candles.length > 1 ? Number(candles[1].t) - Number(candles[0].t) : 0;
  return step > 0 ? (365 * 86400000) / step : 8760;
}

function runBacktest({ candles, startIndex = 0, strategy, params = {}, capital = 1000, feePct = 0.1, slippagePct = 0.05, timeBarrier = null }) {
  const tb = normalizeTimeBarrier(timeBarrier);
  const n = candles.length;
  if (n === 0 || startIndex >= n) throw new Error('Backtest için test penceresinde yeterli mum yok.');
  const fee = feePct / 100;
  const slip = slippagePct / 100;
  const p = { ...strategy.defaultParams, ...params };
  const limit = candleLimit(strategy, p);

  let cash = capital;
  let pos = null;
  let pending = null;
  let feesPaid = 0;
  let slipCost = 0;
  let barsInPos = 0;
  const trades = [];
  const equity = new Array(n - startIndex);

  const openPos = (ref, i, reason, suggestedStopDistance) => {
    const fill = buyFill(ref, slippagePct);
    const quantity = cash / (fill * (1 + fee));
    const feeAmt = quantity * fill * fee;
    feesPaid += feeAmt;
    slipCost += (fill - ref) * quantity;
    const sl = Number(p.stopLossPct);
    pos = {
      entryPrice: fill,
      quantity,
      cost: cash,
      stopPrice: (() => {
        const pctStop = Number.isFinite(sl) ? fill * (1 - sl / 100) : null;
        const distance = Number(suggestedStopDistance);
        const strategyStop = Number.isFinite(distance) && distance > 0 ? fill - distance : null;
        return Number.isFinite(pctStop) && Number.isFinite(strategyStop) ? Math.max(pctStop, strategyStop) : (Number.isFinite(pctStop) ? pctStop : strategyStop);
      })(),
      highWaterMark: fill,
      breakEvenBufferPct: breakEvenBufferPct(fee * 100, slippagePct),
      openedIndex: i,
      openedAt: candles[i].t,
      reason
    };
    cash = 0;
  };

  const closePos = (ref, i, reason, forced = false) => {
    const fill = sellFill(ref, slippagePct);
    const gross = pos.quantity * fill;
    const feeAmt = gross * fee;
    const net = gross - feeAmt;
    feesPaid += feeAmt;
    slipCost += (ref - fill) * pos.quantity;
    const pnl = net - pos.cost;
    trades.push({
      openedAt: pos.openedAt,
      closedAt: candles[i].t,
      entryPrice: pos.entryPrice,
      exitPrice: fill,
      pnl,
      pnlPct: (pnl / pos.cost) * 100,
      bars: i - pos.openedIndex,
      reason,
      forced
    });
    cash = net;
    pos = null;
  };

  for (let i = startIndex; i < n; i++) {
    const c = candles[i];

    // 1) Onceki kapanista verilen emir, bu mumun ACILISINDA dolar.
    if (pending) {
      if (pending.action === 'buy' && !pos) openPos(c.o, i, pending.reason, pending.suggestedStopDistance);
      else if (pending.action === 'sell' && pos) closePos(c.o, i, pending.reason);
      pending = null;
    }

    // 2) Mum ici risk kontrolu (stop / take-profit / trailing) -- kagit motorla ORTAK fonksiyon.
    if (pos) {
      const hit = intrabarRiskExit(pos, c, p, true);
      if (hit) closePos(hit.ref, i, hit.reason);
    }

    // 3) Kapanista degerleme.
    if (pos) barsInPos++;
    equity[i - startIndex] = pos ? pos.quantity * c.c * (1 - slip) * (1 - fee) : cash;

    // 4) Kapanista strateji sinyali -> emir bir sonraki mumun acilisinda dolar.
    if (i < n - 1) {
      const windowCandles = candles.slice(Math.max(0, i + 1 - limit), i + 1);
      const view = pos ? { entryPrice: pos.entryPrice, quantity: pos.quantity, stopPrice: pos.stopPrice, highWaterMark: pos.highWaterMark, breakEvenBufferPct: pos.breakEvenBufferPct } : null;
      const d = strategy.evaluate({ candles: windowCandles, position: view, params: p });
      if (d.action === 'buy' && !pos) pending = { action: 'buy', reason: d.reason, suggestedStopDistance: d.suggestedStopDistance };
      else if (d.action === 'sell' && pos) pending = { action: 'sell', reason: d.reason };
      else if (pos && tb.enabled) {
        // Zaman bariyeri: strateji tutmayi seciyorsa, sure dolmus ve kar hedefi tutmamissa bir sonraki acilista cik.
        const held = i - pos.openedIndex + 1;
        const pnlPctNow = (c.c / pos.entryPrice - 1) * 100;
        if (held >= tb.maxHoldBars && pnlPctNow < tb.minProfitPct) pending = { action: 'sell', reason: `zaman bariyeri: ${held} mum, K/Z %${pnlPctNow.toFixed(2)}` };
      }
    }
  }

  const last = n - 1;
  if (pos) closePos(candles[last].c, last, 'test sonu (açık pozisyon kapatıldı)', true);
  equity[last - startIndex] = cash;

  // ---- Al-tut referansi (ayni maliyetlerle tek gidis-donus) ----
  const first = candles[startIndex];
  const bh = buyAndHold(candles, startIndex, capital, feePct, slippagePct);

  // ---- Metrikler ----
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const mid = Math.max(1, Math.floor(equity.length / 2));
  const midEq = equity[mid - 1];
  const bars = n - startIndex;

  return {
    candlesTested: bars,
    startT: first.t,
    endT: candles[last].t,
    capital,
    finalEquity: cash,
    returnPct: (cash / capital - 1) * 100,
    buyHoldPct: bh.pct,
    maxDrawdownPct: maxDrawdownPct(equity, capital),
    buyHoldMaxDrawdownPct: bh.maxDrawdownPct,
    trades: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgTradePct: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null,
    worstTradePct: trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : null,
    exposurePct: (barsInPos / bars) * 100,
    firstHalfPct: (midEq / capital - 1) * 100,
    secondHalfPct: (cash / midEq - 1) * 100,
    feesPct: (feesPaid / capital) * 100,
    slippagePct: (slipCost / capital) * 100,
    metrics: {
      ...equityMetrics(equity, { barsPerYear: barsPerYearOf(candles) }),
      ...tradeMetrics(trades)
    },
    tradeList: trades
  };
}

module.exports = { runBacktest, buyAndHold, maxDrawdownPct };
