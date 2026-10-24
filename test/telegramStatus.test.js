'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { buildStatus, buildDailySummaryData } = require('../src/telegramStatus');

const NOW = Date.UTC(2026, 9, 19, 12, 0); // 15:00 Istanbul

function paperState() {
  const s = store.defaultState();
  s.settings.mode = 'paper';
  s.paper.cashByAsset = { USDT: 50 };
  s.paper.positions = { 'BTC/USDT': { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopPrice: 95, openedAt: '2026-10-19T08:00:00.000Z' } };
  s.paper.lastPrices = { 'BTC/USDT': 110 };
  s.paper.stats = { trades: 4, wins: 3, grossWin: 10, grossLoss: 2, pctSum: 5 };
  s.paper.trades = [{ symbol: 'ETH/USDT', pnl: 3, pnlPct: 3, closedAt: '2026-10-19T09:00:00.000Z', reason: 'tp' }];
  return s;
}
function liveState() {
  const s = store.defaultState();
  s.settings.mode = 'live';
  s.paper.cashByAsset = { USDT: 150 }; // paper verisi canli rapora SIZMAMALI
  s.live.lastBalance = { USDT: { free: 420, locked: 30, total: 450 } };
  s.live.positions = { 'SOL/USDT': { symbol: 'SOL/USDT', quantity: 2, entryPrice: 50, costQuote: 100, stopPrice: 47, stopOrderId: 's1', openedAt: '2026-10-19T07:00:00.000Z' } };
  s.live.lastPrices = { 'SOL/USDT': 55 };
  s.live.stats = { trades: 10, wins: 6, grossWin: 30, grossLoss: 12, realizedPnl: 18 };
  s.live.trades = [
    { symbol: 'ADA/USDT', pnl: -2, pnlPct: -2, closedAt: '2026-10-19T10:00:00.000Z', reason: 'protective stop' },
    { symbol: 'ADA/USDT', pnl: 5, pnlPct: 5, closedAt: '2026-10-18T10:00:00.000Z', reason: 'take-profit' }
  ];
  s.live.startingEquityByQuote = { USDT: 400 };
  s.live.dayStartEquityByQuote = { USDT: 440 };
  s.live.safeToTrade = false; s.live.lockReason = 'User Data Stream bağlı değil';
  s.live.lastReconcileAt = '2026-10-19T11:55:00.000Z';
  return s;
}

test('paper modda eski davranis korunur ve pozisyon detaylari eklenir', () => {
  const st = buildStatus({ state: paperState(), exchange: { quoteAssets: ['USDT'] }, nowMs: NOW });
  assert.equal(st.mode, 'paper'); assert.equal(st.live, false);
  assert.equal(st.cash, 50);
  assert.equal(st.totalEquity, 160);
  assert.equal(st.positions, 1);
  const h = st.holdings[0];
  assert.equal(h.entryPrice, 100); assert.equal(h.lastPrice, 110); assert.equal(h.stopPrice, 95);
  assert.equal(h.unrealizedPnl, 10); assert.ok(Math.abs(h.unrealizedPct - 10) < 1e-9);
  assert.equal(st.stats.trades, 4);
});

test('CANLI modda gercek hesap/pozisyon/islem kayitlari kullanilir; paper verisi sizmaz', () => {
  const engine = { computeEquityByQuote: () => ({}), computeEquity: () => 477, lastTickAt: NOW - 30000 };
  const st = buildStatus({ state: liveState(), exchange: { quoteAssets: ['USDT'] }, engine, nowMs: NOW });
  assert.equal(st.mode, 'live'); assert.equal(st.live, true);
  assert.equal(st.cash, 420, 'kullanilabilir nakit = borsa free bakiyesi (paper 150 degil)');
  assert.equal(st.totalEquity, 477);
  assert.equal(st.holdings.length, 1);
  assert.equal(st.holdings[0].symbol, 'SOL/USDT');
  assert.equal(st.holdings[0].unrealizedPnl, 10);
  assert.equal(st.holdings[0].protected, true);
  assert.equal(st.trades.length, 2);
  assert.equal(st.stats.trades, 10); assert.equal(st.stats.wins, 6);
  assert.equal(st.startingBalance, 400); assert.equal(st.dayStartEquity, 440);
  assert.equal(st.safeToTrade, false); assert.equal(st.lockReason, 'User Data Stream bağlı değil');
  assert.equal(st.lastTickAt, NOW - 30000);
  assert.equal(st.lastReconcileAt, '2026-10-19T11:55:00.000Z');
});

test('canli modda motor ozkaynak veremezse totalEquity tanimsiz kalir (paper degeri uydurulmaz)', () => {
  const st = buildStatus({ state: liveState(), exchange: { quoteAssets: ['USDT'] }, engine: { computeEquityByQuote: () => ({}), computeEquity: () => NaN }, nowMs: NOW });
  assert.equal(st.totalEquity, undefined);
  const st2 = buildStatus({ state: liveState(), exchange: {}, nowMs: NOW });
  assert.equal(st2.totalEquity, undefined);
});

test('canli mod: bakiye henuz okunmadiysa nakit tanimsiz', () => {
  const s = liveState(); s.live.lastBalance = null;
  assert.equal(buildStatus({ state: s, exchange: {} }).cash, undefined);
});

test('gunluk ozet verisi Istanbul takvim gunune gore bugunun islemlerini ve log hatalarini sayar', () => {
  const s = liveState();
  s.log = [
    { t: '2026-10-19T09:30:00.000Z', msg: 'KORUYUCU STOP hatası', level: 'error' },
    { t: '2026-10-19T08:00:00.000Z', msg: 'uyarı', level: 'warn' },
    { t: '2026-10-18T08:00:00.000Z', msg: 'dünkü hata', level: 'error' }
  ];
  s.running = true;
  const d = buildDailySummaryData({ state: s, exchange: {}, engine: { computeEquityByQuote: () => ({}), computeEquity: () => 477 }, nowMs: NOW });
  assert.equal(d.todayTrades, 1); assert.equal(d.todayWins, 0); assert.equal(d.todayPnl, -2);
  assert.equal(d.totalTrades, 10); assert.ok(Math.abs(d.winRate - 60) < 1e-9);
  assert.equal(d.errorCount, 1); assert.equal(d.warnCount, 1); assert.equal(d.lastError, 'KORUYUCU STOP hatası');
  assert.equal(d.equity, 477); assert.equal(d.positions.length, 1);
  assert.equal(d.dayKey, '2026-10-19'); assert.match(d.dayLabel, /^\d{2}\.\d{2}\.\d{2}$/);
});

test('gece yarisi siniri: UTC 21:30 (Istanbul ertesi gun 00:30) islemi ertesi gune sayilir', () => {
  const s = paperState();
  s.paper.trades = [{ symbol: 'X/USDT', pnl: 1, closedAt: '2026-10-19T21:30:00.000Z' }];
  const d = buildDailySummaryData({ state: s, exchange: {}, nowMs: Date.UTC(2026, 9, 19, 12, 0) });
  assert.equal(d.todayTrades, 0);
  const d2 = buildDailySummaryData({ state: s, exchange: {}, nowMs: Date.UTC(2026, 9, 20, 5, 0) });
  assert.equal(d2.todayTrades, 1);
});
