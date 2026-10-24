'use strict';
// Bildirim bosluklari: durable mesaj, stop kurulamayinca alim mesaji, kurtarmayla kurulan pozisyon mesaji.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-durable-'));
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const fmt = require('../src/notifyFormat');
const { createNotifier } = require('../src/notify');

const quiet = (fn) => async (...a) => {
  const log = console.error; const warn = console.warn; const lg = console.log; console.error = () => {}; console.warn = () => {}; console.log = () => {};
  try { return await fn(...a); } finally { console.error = log; console.warn = warn; console.log = lg; }
};

function failingNotifier(env = {}) {
  let t = 1_000_000; const bodies = []; let ok = false;
  const fetchFn = async (url, o) => { bodies.push(JSON.parse(o.body)); t += 100; return ok ? { ok: true } : { ok: false, status: 500, json: async () => ({}) }; };
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', NOTIFY_MIN_GAP_MS: '0', ...env }, fetchFn, logger: { warn() {}, log() {} }, now: () => t, sleep: async (ms) => { t += ms; } });
  return { n, bodies, heal: () => { ok = true; } };
}

test('durable mesaj 4 kez denenir ve basarisizsa bekleme listesine girer; durable olmayan normal mesaj 2 denemede kaybolur', async () => {
  const a = failingNotifier();
  await a.n.send('ALIM A', { priority: 'normal', durable: true });
  assert.equal(a.bodies.length, 4);
  assert.equal(a.n.pendingCount(), 1);
  const b = failingNotifier();
  await b.n.send('ALIM B', { priority: 'normal' });
  assert.equal(b.bodies.length, 2);
  assert.equal(b.n.pendingCount(), 0);
});

test('durable mesaj ag gelince gecikmeli gonderilir; sessiz modda sessiz kalir', async () => {
  const a = failingNotifier();
  a.n.mute(3600_000);
  await a.n.send('SATIM X', { priority: 'normal', durable: true });
  assert.equal(a.n.pendingCount(), 1);
  a.heal(); a.bodies.length = 0;
  assert.equal(await a.n.flushPending(), 1);
  assert.match(a.bodies[0].text, /Gecikmeli bildirim/);
  assert.equal(a.bodies[0].disable_notification, true);
  // kritik bekleyen mesaj sessiz modda bile sesli kalir
  const c = failingNotifier(); c.n.mute(3600_000);
  await c.n.send('STOP', { priority: 'critical' });
  c.heal(); c.bodies.length = 0; await c.n.flushPending();
  assert.equal(c.bodies[0].disable_notification, undefined);
});

test('quiet mesaj durable olsa da bekletilmez', async () => {
  const a = failingNotifier();
  await a.n.send('OZET', { priority: 'quiet', durable: true });
  assert.equal(a.bodies.length, 1);
  assert.equal(a.n.pendingCount(), 0);
});

test('liveBuy: stopFailed ve recovered metni', () => {
  const t = fmt.liveBuy({ symbol: 'BTC/USDT', avgPrice: 100, quantity: 1, quoteSpent: 100, stopPrice: null, stopFailed: true, recovered: true, at: 0 });
  assert.match(t, /GEÇ DOLUM \/ KURTARMA/);
  assert.match(t, /KURULAMADI/);
  assert.doesNotMatch(t, /fiyat belirlenemedi/);
});

const NOW = Date.UTC(2026, 9, 2, 12, 0);
function mkNotifier() { const msgs = []; return { msgs, send: async (text, opts = {}) => { msgs.push({ text, opts }); return {}; }, ping: async () => true }; }
function ex(over = {}) {
  return {
    id: 'binance', environment: 'testnet', name: 'Test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { return { USDT: { free: 1000, locked: 0 } }; },
    async fetchOpenOrders() { return []; },
    async getOrder(s, id, cid) { return { status: 'FILLED', orderId: 1, clientOrderId: cid, executedQty: 1, origQty: 1, cummulativeQuoteQty: 100 }; },
    async createMarketOrder(s, side, amount, cid) { return { orderId: 101, clientOrderId: cid, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: String(amount), executedQty: String(amount), cummulativeQuoteQty: String(amount * 100), fills: [] }; },
    async createStopOrder(s, side, amount, stop, limit, cid) { return { status: 'NEW', orderId: 2, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async cancelOrder(s, orderId) { return { status: 'CANCELED', orderId }; },
    async fetchCandles() { return []; },
    async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10, tickSize: 0.01 }; },
    ...over
  };
}
function liveState() {
  const state = store.defaultState();
  state.settings.mode = 'live';
  Object.assign(state.settings, { dailyLossLimitPct: 100, killSwitchLossPct: 0, maxConcurrentPositions: 1, reserveCashPct: 0, maxTradeQuote: 1000 });
  state.live.safeToTrade = true;
  return state;
}

test('normal alim: mesaj durable gider (stop kuruldu)', quiet(async () => {
  const state = liveState(); const n = mkNotifier();
  const e = new LiveEngine({ exchange: ex(), state, store: { save() {} }, allowLive: true, nowFn: () => NOW, notifier: n });
  await e.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5, takeProfitPct: 8 }, 100, 'test', e.epoch);
  const m = n.msgs.filter((x) => /CANLI ALIM/.test(x.text));
  assert.equal(m.length, 1);
  assert.equal(m[0].opts.durable, true);
  assert.match(m[0].text, /Koruyucu stop: <code>95<\/code>/);
}));

test('koruyucu stop KURULAMAZSA alim mesaji yine gider (uyarili) ve hata yine firlar', quiet(async () => {
  const state = liveState(); const n = mkNotifier();
  const e = new LiveEngine({ exchange: ex({ async createStopOrder() { return { status: 'REJECTED', orderId: 0 }; } }), state, store: { save() {} }, allowLive: true, nowFn: () => NOW, notifier: n });
  await assert.rejects(() => e.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5, takeProfitPct: 8 }, 100, 'test', e.epoch));
  const m = n.msgs.filter((x) => /CANLI ALIM/.test(x.text));
  assert.equal(m.length, 1, JSON.stringify(n.msgs.map((x) => x.text)));
  assert.match(m[0].text, /KURULAMADI/);
  assert.equal(state.live.safeToTrade, false);
}));

test('kurtarmayla (gec dolum) pozisyona cevrilen alim icin bildirim gider; ikinci cagri tekrar bildirmez', quiet(async () => {
  const held = { BTC: 0 };
  const state = liveState(); state.running = true;
  const sym = 'BTC/USDT';
  state.pairs[sym] = { ...(state.pairs[sym] || {}), enabled: true, budgetPct: 10, params: { stopLossPct: 2 } };
  const n = mkNotifier();
  const exch = ex({
    async fetchBalance() { const b = { USDT: { free: 1000, locked: 0 } }; if (held.BTC) b.BTC = { free: held.BTC, locked: 0 }; return b; },
    async getOrder(s, id, cid) { return { status: 'NEW', orderId: 1, clientOrderId: cid, side: 'BUY', executedQty: 0, origQty: 0.2, cummulativeQuoteQty: 0 }; },
    async createMarketOrder(s, side, amount, cid) { return { status: 'NEW', orderId: 1, clientOrderId: cid, side: 'BUY', executedQty: 0, origQty: amount, cummulativeQuoteQty: 0 }; }
  });
  const e = new LiveEngine({ exchange: exch, state, store: { save() {} }, allowLive: true, nowFn: () => NOW, notifier: n });
  await assert.rejects(() => e.buy(sym, state.pairs[sym], { stopLossPct: 2 }, 100, 'test', e.epoch));
  assert.equal(n.msgs.filter((x) => /CANLI ALIM/.test(x.text)).length, 0, 'terminal olmayan alimda henuz alim mesaji yok');
  const cid = Object.keys(state.liveOrders)[0];
  held.BTC = 0.2;
  e.orderManager._recordExchangeResponse(cid, { ...state.liveOrders[cid], status: 'FILLED', executedQty: 0.2, quoteQty: 20, netExecutedQty: 0.2, netQuoteQty: 20 });
  assert.equal(await e._adoptFilledEntries(), true);
  const m = n.msgs.filter((x) => /CANLI ALIM/.test(x.text));
  assert.equal(m.length, 1, JSON.stringify(n.msgs.map((x) => x.text)));
  assert.match(m[0].text, /GEÇ DOLUM \/ KURTARMA/);
  assert.match(m[0].text, /Koruyucu stop: <code>/);
  assert.equal(m[0].opts.durable, true);
  assert.equal(await e._adoptFilledEntries(), false);
  assert.equal(n.msgs.filter((x) => /CANLI ALIM/.test(x.text)).length, 1);
}));
