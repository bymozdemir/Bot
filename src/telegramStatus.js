'use strict';
// src/telegramStatus.js
//
// Telegram komutlari (/durum, /bakiye, /rapor, /islemler, /pozisyonlar ...) ve gunluk ozet icin durum olusturucu.
// MOD FARKINDA: paper modda paper defterinden, CANLI modda gercek hesap/pozisyon kayitlarindan (state.live) okur.
// Eskiden bu veri her zaman state.paper'dan geliyordu; canli modda yanlis (paper) rakamlar gosteriliyordu.
// Saf fonksiyonlar: yan etkisi yok, test edilebilir.

const { istanbulDayKey, formatIstanbulTime } = require('./istanbulTime');

const fin = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };

function holdingFrom(symbol, p, price, fallbackQuote) {
  const quantity = Number(p.quantity);
  const costQuote = fin(p.costQuote ?? p.costUSDT);
  const px = Number(price);
  const marketValue = Number.isFinite(px) && px > 0 ? quantity * px : undefined;
  const unrealizedPnl = marketValue !== undefined && costQuote !== undefined ? marketValue - costQuote : undefined;
  return {
    symbol,
    baseAsset: String(p.baseAsset || symbol.split('/')[0] || '').toUpperCase(),
    quantity,
    costQuote,
    quoteAsset: String(p.quoteAsset || symbol.split('/')[1] || fallbackQuote).toUpperCase(),
    marketValue,
    entryPrice: fin(p.entryPrice),
    lastPrice: Number.isFinite(px) && px > 0 ? px : undefined,
    stopPrice: fin(p.stopPrice),
    openedAt: p.openedAt || undefined,
    unrealizedPnl,
    unrealizedPct: unrealizedPnl !== undefined && costQuote > 0 ? (unrealizedPnl / costQuote) * 100 : undefined,
    protected: p.stopOrderId ? true : undefined
  };
}

function buildStatus({ state, exchange, engine, nowMs = Date.now() } = {}) {
  const settings = state.settings || {};
  const mode = String(settings.mode || 'paper').toLowerCase();
  const live = mode === 'live';
  const quoteAsset = String(settings.quoteAsset || 'USDT').toUpperCase();
  const common = {
    mode, live, running: Boolean(state.running),
    killSwitch: Boolean(state.killSwitch), killSwitchReason: state.killSwitch?.reason || null,
    exchange: settings.exchange || 'bilinmiyor', quoteAsset,
    settings: {
      defaultBudgetPct: Number(settings.defaultBudgetPct), pollSeconds: Number(settings.pollSeconds),
      dailyLossLimitPct: fin(settings.dailyLossLimitPct), killSwitchLossPct: fin(settings.killSwitchLossPct),
      maxConcurrentPositions: fin(settings.maxConcurrentPositions), reserveCashPct: fin(settings.reserveCashPct),
      maxTradeQuote: fin(settings.maxTradeQuote), maxOpenOrders: fin(settings.maxOpenOrders),
      closeOnDailyLoss: settings.closeOnDailyLoss, paperFeePct: fin(settings.paperFeePct),
      paperSlippagePct: fin(settings.paperSlippagePct), maxMarketSpreadPct: fin(settings.maxMarketSpreadPct),
      maxMarketSlippagePct: fin(settings.maxMarketSlippagePct), riskDayTimezone: settings.riskDayTimezone || 'Europe/Istanbul',
      timeframe: settings.defaultTimeframe
    },
    pairs: state.pairs, quoteAssets: (exchange && exchange.quoteAssets) || [],
    lastTickAt: engine && Number.isFinite(Number(engine.lastTickAt)) ? Number(engine.lastTickAt) : null,
    recentLog: Array.isArray(state.log) ? state.log.slice(0, 200) : [],
    nowMs
  };

  if (!live) {
    const paper = state.paper || {};
    const cash = fin(paper.cashByAsset && paper.cashByAsset[quoteAsset]);
    const lastPrices = paper.lastPrices || {};
    const holdings = Object.entries(paper.positions || {}).filter(([, p]) => Number(p && p.quantity) > 0)
      .map(([symbol, p]) => holdingFrom(symbol, p, lastPrices[symbol], quoteAsset));
    const totalEquity = cash !== undefined ? cash + holdings.reduce((sum, h) => {
      if (h.quoteAsset !== quoteAsset) return sum;
      const v = h.marketValue !== undefined ? h.marketValue : (h.costQuote !== undefined ? h.costQuote : 0);
      return sum + v;
    }, 0) : undefined;
    return {
      ...common, cash, holdings, totalEquity, positions: holdings.length,
      trades: Array.isArray(paper.trades) ? paper.trades.slice(0, 300) : [],
      stats: paper.stats || {},
      startingBalance: Number(paper.startingBalanceByAsset && paper.startingBalanceByAsset[quoteAsset] != null ? paper.startingBalanceByAsset[quoteAsset] : paper.startingBalance),
      dayStartEquity: fin(paper.dayStartEquityByAsset && paper.dayStartEquityByAsset[quoteAsset]),
      safeToTrade: undefined, lockReason: null
    };
  }

  // ---- CANLI: gercek hesap / gercek pozisyon kayitlari ----
  const lv = state.live || {};
  const bal = (lv.lastBalance && lv.lastBalance[quoteAsset]) || null;
  const cash = bal ? fin(bal.free ?? bal.total) : undefined;
  const lastPrices = lv.lastPrices || {};
  const holdings = Object.entries(lv.positions || {}).filter(([, p]) => Number(p && p.quantity) > 0)
    .map(([symbol, p]) => holdingFrom(symbol, p, lastPrices[symbol], quoteAsset));
  let totalEquity;
  if (engine && typeof engine.computeEquityByQuote === 'function' && typeof engine.computeEquity === 'function') {
    try { totalEquity = fin(engine.computeEquity(quoteAsset)); } catch (_) { totalEquity = undefined; }
  }
  const stats = lv.stats || {};
  return {
    ...common, cash, holdings, totalEquity, positions: holdings.length,
    trades: Array.isArray(lv.trades) ? lv.trades.slice(0, 300) : [],
    stats: { trades: stats.trades || 0, wins: stats.wins || 0, grossWin: stats.grossWin || 0, grossLoss: stats.grossLoss || 0 },
    startingBalance: fin((lv.startingEquityByQuote && lv.startingEquityByQuote[quoteAsset]) ?? lv.startingEquity),
    dayStartEquity: fin(lv.dayStartEquityByQuote && lv.dayStartEquityByQuote[quoteAsset]),
    safeToTrade: lv.safeToTrade === true,
    lockReason: lv.lockReason || null,
    lastReconcileAt: lv.lastReconcileAt || null
  };
}

// Gunluk ozet verisi (Istanbul takvim gunu). Metin notifyFormat.dailySummary icinde olusur.
function buildDailySummaryData({ state, exchange, engine, nowMs = Date.now() } = {}) {
  const st = buildStatus({ state, exchange, engine, nowMs });
  const dayKey = istanbulDayKey(nowMs);
  const today = st.trades.filter((t) => t && t.closedAt && istanbulDayKey(Date.parse(t.closedAt)) === dayKey);
  const todayPnl = today.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  const todayWins = today.filter((t) => Number(t.pnl) > 0).length;
  const total = Number(st.stats.trades) || 0;
  const wins = Number(st.stats.wins) || 0;
  const todayLogs = st.recentLog.filter((e) => e && e.t && istanbulDayKey(Date.parse(e.t)) === dayKey);
  const errors = todayLogs.filter((e) => e.level === 'error');
  const warns = todayLogs.filter((e) => e.level === 'warn');
  return {
    mode: st.mode, running: st.running, killSwitch: st.killSwitch, safeToTrade: st.safeToTrade,
    quoteAsset: st.quoteAsset, dayLabel: formatIstanbulTime(nowMs).split(' ')[0] || dayKey, dayKey,
    lastTickAt: st.lastTickAt,
    todayTrades: today.length, todayWins, todayPnl,
    equity: st.totalEquity, dayStartEquity: st.dayStartEquity, startingBalance: st.startingBalance,
    totalTrades: total, winRate: total > 0 ? (wins / total) * 100 : 0,
    positions: st.holdings,
    errorCount: errors.length, warnCount: warns.length, lastError: errors[0] ? errors[0].msg : null
  };
}

module.exports = { buildStatus, buildDailySummaryData };
