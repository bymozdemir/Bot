'use strict';
// Bağımsız denetim (2026-10-17) bulgularının regresyon testleri:
// LIVE-001, STATE-001, STATE-002, ORDER-002, SEC-001, SEC-002.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixes-'));
process.env.BOT_DATA_DIR = dataDir;
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const { OrderManager } = require('../src/orderManager');
const { fetchWithRetry } = require('../src/util/retry');
const { crossSiteRejection } = require('../src/util/originGuard');

const FIXED_NOW = () => Date.UTC(2026, 9, 2, 12, 0);
const quiet = (fn) => async (...a) => {
  const log = console.error; const warn = console.warn; console.error = () => {}; console.warn = () => {};
  try { return await fn(...a); } finally { console.error = log; console.warn = warn; }
};
function resetData() { for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f), { force: true, recursive: true }); }

// ---------- STATE-001 / STATE-002 ----------
test('STATE-001: bozuk state.json + canlı kayıtlı .bak => bot KILITLI başlar', quiet(async () => {
  resetData();
  const bak = store.defaultState();
  bak.liveOrders = { 'trade-old': { clientOrderId: 'trade-old', symbol: 'BTC/USDT', side: 'buy', status: 'FILLED' } };
  fs.writeFileSync(store.DATA_FILE + '.bak', JSON.stringify(bak));
  fs.writeFileSync(store.DATA_FILE, '{"settings": {"mo');
  const s = store.load();
  assert.ok(s.killSwitch && /state\.json bozuktu/.test(s.killSwitch.reason), 'kill switch kurulmalı');
  assert.ok(s.liveOrders['trade-old'], 'yedekteki kayıtlar korunur');
}));

test('STATE-001: LIVE_TRADING_ENABLED=true iken paper-only .bak da KILITLI başlar; paper-only ve canlı kapalıysa devam eder', quiet(async () => {
  resetData();
  const prev = process.env.LIVE_TRADING_ENABLED;
  try {
    const bak = store.defaultState();
    fs.writeFileSync(store.DATA_FILE + '.bak', JSON.stringify(bak));
    fs.writeFileSync(store.DATA_FILE, 'bozuk');
    process.env.LIVE_TRADING_ENABLED = 'true';
    assert.ok(store.load().killSwitch, 'canlı kapı açıkken kilit gerekli');
    fs.writeFileSync(store.DATA_FILE, 'bozuk');
    delete process.env.LIVE_TRADING_ENABLED;
    assert.equal(store.load().killSwitch, null, 'yalnız paper: yedekten kilitsiz devam');
  } finally {
    if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED; else process.env.LIVE_TRADING_ENABLED = prev;
  }
}));

test('STATE-002: state.json içindeki __proto__ anahtarı birleştirilen nesnenin prototipini değiştirmez', quiet(async () => {
  resetData();
  fs.writeFileSync(store.DATA_FILE, '{"settings":{"__proto__":{"polluted":"yes"}},"__proto__":{"polluted2":"yes"}}');
  const s = store.load();
  assert.equal(s.polluted2, undefined);
  assert.equal(s.settings.polluted, undefined);
  assert.equal(({}).polluted, undefined);
}));

// ---------- SEC-001 ----------
function serve(handler) {
  return new Promise((resolve) => {
    const hits = { n: 0 };
    const srv = http.createServer((req, res) => { hits.n++; handler(req, res); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, url: `http://127.0.0.1:${srv.address().port}/x` }));
  });
}

test('SEC-001: sınırı aşan gövde reddedilir, tekrar denenmez; POST için sonuç BELİRSİZ işaretlenir', async () => {
  const { srv, hits, url } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    (function w() { while (sent < 2 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', w); } res.end('{}'); })();
  });
  try {
    await assert.rejects(() => fetchWithRetry(url, {}, { retries: 2, timeoutMs: 5000, backoffMs: 1, maxBytes: 256 * 1024 }), (e) => e.code === 'RESPONSE_TOO_LARGE' && !e.unknownOutcome);
    assert.equal(hits.n, 1, 'aşırı büyük gövde tekrar denenmemeli');
    await assert.rejects(() => fetchWithRetry(url, { method: 'POST' }, { retries: 0, timeoutMs: 5000, maxBytes: 256 * 1024 }), (e) => e.code === 'RESPONSE_TOO_LARGE' && e.unknownOutcome === true);
  } finally { srv.close(); }
});

test('SEC-001: Content-Length sınırı aşıyorsa gövde okunmadan reddedilir; normal gövde okunur', async () => {
  const big = await serve((req, res) => { res.writeHead(200, { 'content-length': String(5 * 1024 * 1024) }); res.write('x'); setTimeout(() => res.destroy(), 200); });
  const ok = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ a: 1 })); });
  try {
    await assert.rejects(() => fetchWithRetry(big.url, {}, { retries: 0, timeoutMs: 5000, maxBytes: 1024 * 1024 }), (e) => e.code === 'RESPONSE_TOO_LARGE');
    const res = await fetchWithRetry(ok.url, {}, { retries: 0, timeoutMs: 5000, maxBytes: 1024 * 1024 });
    assert.deepEqual(await res.json(), { a: 1 });
  } finally { big.srv.close(); ok.srv.close(); }
});

// ---------- SEC-002 ----------
test('SEC-002: cross-site isteği (login/reauth/logout dahil) ortak kuralla reddedilir', () => {
  const same = (req, origin) => origin === 'http://localhost:3000';
  assert.equal(crossSiteRejection({ headers: {} }, same), null);
  assert.equal(crossSiteRejection({ headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' } }, same), null);
  assert.equal(crossSiteRejection({ headers: { origin: 'https://evil.example' } }, same).status, 403);
  assert.equal(crossSiteRejection({ headers: { 'sec-fetch-site': 'cross-site' } }, same).status, 403);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const route of ["app.post('/api/login'", "app.post('/api/reauth'", "app.post('/api/logout'"]) {
    const i = src.indexOf(route);
    assert.ok(i > 0, `${route} bulunamadı`);
    assert.ok(/rejectCrossSite\(req, res\)/.test(src.slice(i, i + 200)), `${route} cross-site kontrolü yapmıyor`);
  }
});

// ---------- ORDER-002 ----------
function exchangeFor(overrides = {}, caps = {}) {
  return {
    id: 'binance', name: 'Test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true, ...caps },
    async createMarketOrder(symbol, side, amount, cid) { return { orderId: 1, clientOrderId: cid, side: side.toUpperCase(), symbol: 'BTCUSDT', status: 'FILLED', origQty: amount, executedQty: amount, cummulativeQuoteQty: amount * 100, fills: [] }; },
    async createStopOrder(symbol, side, amount, stop, limit, cid) { return { orderId: 2, clientOrderId: cid, side: 'SELL', symbol: 'BTCUSDT', status: 'NEW', origQty: amount, executedQty: 0 }; },
    async getOrder() { return {}; },
    async fetchTicker() { return { price: 100 }; },
    ...overrides
  };
}
const mkOm = (ex) => new OrderManager({ exchange: ex, state: { liveOrders: {} }, store: { save() {} } });

test('ORDER-002: yanıt sembolü istenenle uyuşmazsa (doğrulayan adaptörde) emir UNKNOWN olur', async () => {
  const ex = exchangeFor({ async createMarketOrder(s, side, amount, cid) { return { orderId: 1, clientOrderId: cid, side: 'BUY', symbol: 'DOGEUSDT', status: 'FILLED', origQty: amount, executedQty: amount, cummulativeQuoteQty: 1 }; } }, { verifiesResponseSymbol: true });
  const r = await mkOm(ex).submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 0.001 });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.uncertain, true);
  assert.match(r.error.message, /tutarsız/);
});

test('ORDER-002: istenenden fazla dolum bildiren yanıt UNKNOWN olur; eşit miktar ve eşleşen sembol geçer', async () => {
  const bad = exchangeFor({ async createMarketOrder(s, side, amount, cid) { return { orderId: 1, clientOrderId: cid, side: 'BUY', symbol: 'BTCUSDT', status: 'FILLED', origQty: amount, executedQty: 9999, cummulativeQuoteQty: 1 }; } });
  assert.equal((await mkOm(bad).submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 0.001 })).status, 'UNKNOWN');
  const good = await mkOm(exchangeFor({}, { verifiesResponseSymbol: true })).submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 0.001 });
  assert.equal(good.status, 'FILLED');
});

test('ORDER-002: kasa tutarıyla verilen market ALIŞ (marketBuyUsesQuote) miktar kontrolünden muaf', async () => {
  const ex = exchangeFor({ async createMarketOrder(s, side, amount, cid) { return { orderId: 1, clientOrderId: cid, side: 'BUY', status: 'FILLED', origQty: 0.5, executedQty: 0.5, cummulativeQuoteQty: amount }; } }, { marketBuyUsesQuote: true });
  ex.marketBuyUsesQuote = true;
  const r = await mkOm(ex).submitMarket({ symbol: 'BTC/TRY', side: 'buy', amount: 100 });
  assert.equal(r.status, 'FILLED');
});

// ---------- LIVE-001 ----------
function liveHarness({ entryStatus, getOrderStatus }) {
  const calls = { market: 0, stop: 0 };
  const held = { BTC: 0 };
  const ex = {
    id: 'binance', environment: 'testnet', name: 'Test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { const b = { USDT: { free: 1000, locked: 0 } }; if (held.BTC) b.BTC = { free: held.BTC, locked: 0 }; return b; },
    async fetchOpenOrders() { return []; },
    async getOrder(symbol, id, cid) { return { status: getOrderStatus, orderId: 1, clientOrderId: cid, side: 'BUY', executedQty: getOrderStatus === 'FILLED' ? 0.2 : 0, origQty: 0.2, cummulativeQuoteQty: getOrderStatus === 'FILLED' ? 20 : 0 }; },
    async createMarketOrder(symbol, side, amount, cid) { calls.market++; return { status: entryStatus, orderId: 1, clientOrderId: cid, side: 'BUY', executedQty: entryStatus === 'FILLED' ? amount : 0, origQty: amount, cummulativeQuoteQty: entryStatus === 'FILLED' ? amount * 100 : 0 }; },
    async createStopOrder(symbol, side, amount, stop, limit, cid) { calls.stop++; return { status: 'NEW', orderId: 2, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async cancelOrder(symbol, orderId) { return { status: 'CANCELED', orderId }; },
    async fetchCandles() { return []; },
    async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10, tickSize: 0.01 }; }
  };
  const state = store.defaultState();
  state.settings.mode = 'live';
  Object.assign(state.settings, { maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
  state.live.safeToTrade = true; state.running = true;
  const sym = 'BTC/USDT';
  state.pairs[sym] = { ...(state.pairs[sym] || {}), enabled: true, budgetPct: 10, params: { stopLossPct: 2 } };
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true, nowFn: FIXED_NOW });
  return { engine, state, calls, held, sym };
}

test('LIVE-001: market alış NEW dönerse ve borsa da NEW diyorsa canlı işlem KİLİTLENİR (sessiz çıkış yok)', quiet(async () => {
  const { engine, state, calls, sym } = liveHarness({ entryStatus: 'NEW', getOrderStatus: 'NEW' });
  await assert.rejects(() => engine.buy(sym, state.pairs[sym], { stopLossPct: 2 }, 100, 'test', engine.epoch), /terminal duruma ulaşmadı/);
  assert.equal(state.live.safeToTrade, false);
  assert.equal(calls.market, 1);
  assert.equal(Object.keys(state.live.positions).length, 0);
}));

test('LIVE-001: NEW dönen alış sonradan dolarsa pozisyon kaydedilir ve koruyucu stop KURULUR', quiet(async () => {
  const { engine, state, calls, held, sym } = liveHarness({ entryStatus: 'NEW', getOrderStatus: 'NEW' });
  await assert.rejects(() => engine.buy(sym, state.pairs[sym], { stopLossPct: 2 }, 100, 'test', engine.epoch));
  const cid = Object.keys(state.liveOrders)[0];
  // geç dolum: WebSocket / REST yenileme emri FILLED yapar, coin hesaba geçer
  held.BTC = 0.2;
  engine.orderManager._recordExchangeResponse(cid, { ...state.liveOrders[cid], status: 'FILLED', executedQty: 0.2, quoteQty: 20, netExecutedQty: 0.2, netQuoteQty: 20 });
  assert.equal(Object.keys(state.live.positions).length, 0, 'olay tek başına pozisyon üretmez');
  const changed = await engine._adoptFilledEntries();
  assert.equal(changed, true);
  const pos = state.live.positions[sym];
  assert.ok(pos, 'pozisyon kurulmalı');
  assert.ok(pos.stopOrderId, 'koruyucu stop kurulmalı');
  assert.equal(calls.stop, 1);
  assert.equal(calls.market, 1, 'ikinci alış gönderilmemeli');
  // ikinci çağrı aynı girişi yeniden değerlendirmez / ikinci stop kurmaz
  assert.equal(await engine._adoptFilledEntries(), false);
  assert.equal(calls.stop, 1);
}));

test('LIVE-001: NEW dönen alış borsada hemen FILLED çıkıyorsa normal akışla pozisyon + stop kurulur', quiet(async () => {
  const { engine, state, calls, sym } = liveHarness({ entryStatus: 'NEW', getOrderStatus: 'FILLED' });
  await engine.buy(sym, state.pairs[sym], { stopLossPct: 2 }, 100, 'test', engine.epoch);
  assert.ok(state.live.positions[sym], 'pozisyon kaydı');
  assert.equal(calls.stop, 1);
  assert.equal(calls.market, 1);
}));
