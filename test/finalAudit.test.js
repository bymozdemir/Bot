// 1.7.2 son denetim bulgularının regresyon testleri.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const BinanceAdapter = require('../src/exchanges/binance');
const { OrderManager } = require('../src/orderManager');
const { BinanceUserDataStream } = require('../src/userDataStream');
const { atomicWriteFileSync } = require('../src/util/atomicWrite');

const makeStore = () => ({ save() {} });

// ---------- Kullanıcı veri akışı ----------
test('UserDataStream: imza zaman damgası borsa saatine göre düzeltilir ve önce saat eşitlenir', async () => {
  let captured = null; let synced = 0;
  class FakeWS {
    constructor() { this.h = {}; queueMicrotask(() => this.h.open && this.h.open()); }
    on(n, f) { this.h[n] = f; if (n === 'message') queueMicrotask(() => {}); }
    send(v) { const m = JSON.parse(v); queueMicrotask(() => this.h.message(JSON.stringify({ id: m.id, status: 200, result: { subscriptionId: 0 } }))); }
    close() {}
  }
  const exchange = {
    nowMs: () => 1234567890123,
    getUserDataStreamTimestamp: () => 1234567890123,
    async syncTime() { synced++; return 0; },
    createUserDataStreamSignature(p) { captured = p; return { ...p, apiKey: 'k', signature: 's' }; },
    getUserDataWsUrl: () => 'ws://x'
  };
  const s = new BinanceUserDataStream({ exchange, orderManager: { applyExecutionReport() {} }, state: {}, store: makeStore(), WebSocketImpl: FakeWS });
  await s.start();
  assert.equal(captured.timestamp, 1234567890123);
  assert.equal(synced, 1);
  await s.stop();
});

// ---------- Binance adaptörü ----------
test('Binance: -1021 (saat sapması) saat eşitlenip TEK kez yeniden denenir; ikinci -1021 fırlatılır', async () => {
  const real = global.fetch;
  try {
    const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's' });
    let accountCalls = 0; const stamps = [];
    global.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/v3/time') return { ok: true, status: 200, json: async () => ({ serverTime: Date.now() + 120000 }), text: async () => '' };
      accountCalls++; stamps.push(Number(u.searchParams.get('timestamp')));
      if (accountCalls === 1) return { ok: false, status: 400, json: async () => ({ code: -1021, msg: 'Timestamp outside recvWindow' }), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({ balances: [] }), text: async () => '' };
    };
    const r = await ex._signedRequest('GET', '/api/v3/account');
    assert.deepEqual(r, { balances: [] });
    assert.equal(accountCalls, 2);
    assert.ok(Math.abs(ex.nowMs() - (Date.now() + 120000)) < 2000, 'nowMs sunucu saatine yakın olmalı');

    accountCalls = 0;
    global.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/v3/time') return { ok: true, status: 200, json: async () => ({ serverTime: Date.now() }), text: async () => '' };
      accountCalls++;
      return { ok: false, status: 400, json: async () => ({ code: -1021, msg: 'x' }), text: async () => '' };
    };
    await assert.rejects(() => ex._signedRequest('GET', '/api/v3/account'), (e) => e.timestampError === true && /400/.test(e.message));
    assert.equal(accountCalls, 2, 'sonsuz döngü olmamalı');
  } finally { global.fetch = real; }
});

// ---------- Emir yöneticisi / canlı motor ----------
function liveSetup({ getOrderFails = true } = {}) {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.pairs = { 'BTC/USDT': { symbol: 'BTC/USDT', enabled: true, strategyId: 'rsi_ema_macd', timeframe: '1h', budgetPct: 30, params: { stopLossPct: 3, takeProfitPct: 1000, trailingStop: false } } };
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopPrice: 97, stopOrderId: 'stop-old', protectiveMode: 'single-stop', entryOrderId: 'e1' };
  state.liveOrders['stop-old'] = { clientOrderId: 'stop-old', exchangeOrderId: 2, symbol: 'BTC/USDT', side: 'sell', amount: 1, status: 'NEW', meta: { role: 'protective-stop' } };
  const ex = {
    id: 'binance', environment: 'testnet', name: 'T', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { return { USDT: { free: 1000, locked: 0 }, BTC: { free: 0, locked: 1 } }; },
    async fetchOpenOrders() { return [{ orderId: 2, clientOrderId: 'stop-old', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', executedQty: 0 }]; },
    async getOrder() { if (getOrderFails) throw new Error('ağ zaman aşımı'); return { status: 'NEW', orderId: 2, clientOrderId: 'stop-old', symbol: 'BTCUSDT', side: 'SELL', executedQty: 0, origQty: 1 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10, tickSize: 0.01 }; },
    async createStopOrder() { throw new Error('beklenmiyor'); }, async cancelOrder() { throw new Error('beklenmiyor'); },
    async fetchCandles() { return []; }, async fetchTicker() { return { price: 100 }; },
    nowMs: () => 4242424242424
  };
  return { state, ex };
}

test('OrderManager.refreshPending: geçici hata sağlıklı koruyucu stop kaydını UNKNOWN yapmaz', async () => {
  const { state, ex } = liveSetup();
  const om = new OrderManager({ exchange: ex, state, store: makeStore() });
  const r = await om.refreshPending();
  assert.equal(r.failed, 1);
  assert.equal(state.liveOrders['stop-old'].status, 'NEW');
  assert.notEqual(state.liveOrders['stop-old'].uncertain, true);
});

test('LiveEngine: periyodik mutabakatta geçici getOrder hatası botu KİLİTLEMEZ', async () => {
  const { state, ex } = liveSetup();
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true });
  engine.ensureState();
  engine.lastReconcileAt = 0;
  const ok = await engine._reconcileIfDue();
  assert.equal(ok, true);
  assert.equal(state.live.safeToTrade, true);
  assert.equal(state.liveOrders['stop-old'].status, 'NEW');
});

test('LiveEngine: varsayılan saat borsa düzeltmeli nowMs() kullanır', () => {
  const { state, ex } = liveSetup();
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true });
  assert.equal(engine.nowFn(), 4242424242424);
});

test('LiveEngine: reschedule() mevcut ve çalışan zamanlayıcıyı yeniler; tick başarıyla bitince nabız atılır', async () => {
  const { state, ex } = liveSetup();
  let pings = 0;
  const notifier = { ping: async () => { pings++; }, send: async () => ({}) };
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, notifier });
  assert.equal(typeof engine.reschedule, 'function');
  const old = setInterval(() => {}, 1e6); engine.timer = old;
  engine.reschedule();
  assert.notEqual(engine.timer, old);
  clearInterval(engine.timer); engine.timer = null;
  state.running = true;
  engine._reconcileIfDue = async () => false; // kilitli tur: süreç yaşıyor, yine de nabız atmalı
  await engine.tick();
  assert.equal(pings, 1);
});

// ---------- Dosya / oturum güvenliği ----------
test('atomicWrite: bozuk mevcut dosya son SAĞLAM .bak yedeğinin üzerine kopyalanmaz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
  const file = path.join(dir, 'state.json');
  atomicWriteFileSync(file, JSON.stringify({ v: 1 }), { backup: true, backupEveryMs: 0 });
  atomicWriteFileSync(file, JSON.stringify({ v: 2 }), { backup: true, backupEveryMs: 0 }); // .bak = v1
  fs.writeFileSync(file, '{"v": 3, bozuk'); // yarım yazma / disk hatası
  atomicWriteFileSync(file, JSON.stringify({ v: 4 }), { backup: true, backupEveryMs: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 4 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auth: bozuk % kodlamalı çerez istisna fırlatmaz (WebSocket upgrade süreci çökertemez)', () => {
  const auth = require('../src/auth');
  assert.equal(auth.sessionFromRequest({ headers: { cookie: 'panel_session=%E0%A4%A; x=1' }, secure: false }), null);
  assert.equal(auth.tokenFromRequest({ headers: { cookie: '__Host-panel_session=%zz' }, secure: true }), null);
});

test('server.js: kullanılan her *Limiter değişkeni tanımlıdır (vaultLimiter ReferenceError regresyonu)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const used = new Set([...src.matchAll(/\b([a-zA-Z]+Limiter)\.(?:blocked|fail|reset)\(/g)].map((m) => m[1]));
  assert.ok(used.size >= 3);
  for (const name of used) assert.match(src, new RegExp(`(?:const|let|var)\\s+${name}\\s*=`), `${name} tanımsız`);
});

test('server.js: canlı ön kontrol para çekme yetkisini sabit true yazmaz, gerçekten sorgular', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(src, /add\('withdrawal'[^)]*,\s*true\s*,\s*'Bot withdrawal/);
  assert.match(src, /fetchApiRestrictions/);
  assert.doesNotMatch(src, /add\('kill'[^)]*,\s*true\s*,/);
});

// ---------- 1.8.2: kurtarma / koruma / kilit ----------
const LiveEngine2 = require('../src/liveEngine');
function recEngine({ balances = { USDT: { free: 1000, locked: 0 } }, stopStatus = 'REJECTED' } = {}) {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.pairs = { 'BTC/USDT': { symbol: 'BTC/USDT', enabled: true, strategyId: 'rsi_ema_macd', timeframe: '1h', budgetPct: 30, params: { stopLossPct: 3, takeProfitPct: 0, trailingStop: false } } };
  const calls = { stop: [], market: [], cancel: [] };
  const ex = {
    id: 'binance', environment: 'testnet', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, oco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchSymbolRules() { return { stepSize: 0.001, marketStepSize: 0.001, minQty: 0.001, minNotional: 10, tickSize: 0.01 }; },
    async createStopOrder(s, side, amt, stop, limit, cid) { calls.stop.push({ amt, stop }); return { status: stopStatus, orderId: 9, clientOrderId: cid, executedQty: 0, origQty: amt }; },
    async createMarketOrder(s, side, amt, cid) { calls.market.push({ side, amt }); return { status: 'FILLED', orderId: 11, clientOrderId: cid, executedQty: amt, origQty: amt, cummulativeQuoteQty: amt * 95, fills: [] }; },
    async cancelOrder(s, id) { calls.cancel.push(id); return { status: 'CANCELED', orderId: id, executedQty: 0 }; },
    async fetchBalance() { return balances; }, async fetchOpenOrders() { return []; },
    async getOrder() { throw new Error('yok'); },
    async fetchTicker() { return { price: 95 }; }, async fetchCandles() { return []; }
  };
  const engine = new LiveEngine2({ exchange: ex, state, store: makeStore(), allowLive: true });
  engine.ensureState();
  return { state, ex, engine, calls };
}
const entryRec = (over = {}) => ({ clientOrderId: 'entry-1', exchangeOrderId: 1, symbol: 'BTC/USDT', side: 'buy', status: 'FILLED', executedQty: 1, netExecutedQty: 1, quoteQty: 100, netQuoteQty: 100, commissionByAsset: {}, commissionTotal: 0, meta: { role: 'entry' }, ...over });
const bal = (btc) => ({ balances: { USDT: { free: 1000, locked: 0, total: 1000 }, BTC: { free: btc, locked: 0, total: btc } }, openOrders: [] });

test('Recovery: TAMAMLANMIŞ al-sat sonrası hayalet pozisyon KURULMAZ (giriş + bağlı çıkış emri)', async () => {
  const { state, engine, calls } = recEngine();
  state.liveOrders['entry-1'] = entryRec();
  state.liveOrders['exit-1'] = { clientOrderId: 'exit-1', symbol: 'BTC/USDT', side: 'sell', status: 'FILLED', executedQty: 1, netExecutedQty: 1, quoteQty: 101, meta: { role: 'exit', entryOrderId: 'entry-1' } };
  const r = await engine._repairRecoveredState({ account: bal(0) });
  assert.equal(r.changed, false);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
  assert.equal(calls.stop.length, 0);
});

test('Recovery: koruyucu stop dolarak kapanmış giriş de hayalet pozisyon üretmez', async () => {
  const { state, engine } = recEngine();
  state.liveOrders['entry-1'] = entryRec();
  state.liveOrders['stop-1'] = { clientOrderId: 'stop-1', symbol: 'BTC/USDT', side: 'sell', status: 'FILLED', executedQty: 1, meta: { role: 'protective-stop', entryClientOrderId: 'entry-1' } };
  const r = await engine._repairRecoveredState({ account: bal(0) });
  assert.equal(r.changed, false);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
});

test('Recovery: hesapta coin yoksa (elle satılmış) kayıtlı giriş pozisyon olarak kurulmaz', async () => {
  const { state, engine, calls } = recEngine();
  state.liveOrders['entry-1'] = entryRec();
  const r = await engine._repairRecoveredState({ account: bal(0) });
  assert.equal(r.changed, false);
  assert.equal(state.live.positions['BTC/USDT'], undefined);
  assert.equal(calls.stop.length, 0);
});

test('Recovery: gerçekten açık (satılmamış, hesapta mevcut) giriş yeniden kurulur ve korunur', async () => {
  const { state, engine, calls } = recEngine({ stopStatus: 'NEW' });
  state.liveOrders['entry-1'] = entryRec();
  const r = await engine._repairRecoveredState({ account: bal(1) });
  assert.equal(r.changed, true);
  const pos = state.live.positions['BTC/USDT'];
  assert.ok(pos && Math.abs(pos.quantity - 1) < 1e-12);
  assert.equal(calls.stop.length, 1);
  assert.ok(pos.stopOrderId);
});

test('Recovery: kısmen satılmış girişte yalnızca KALAN miktar kurulur (maliyet orantılı)', async () => {
  const { state, engine } = recEngine({ stopStatus: 'NEW' });
  state.liveOrders['entry-1'] = entryRec();
  state.liveOrders['exit-1'] = { clientOrderId: 'exit-1', symbol: 'BTC/USDT', side: 'sell', status: 'PARTIALLY_FILLED', executedQty: 0.4, meta: { role: 'exit', entryOrderId: 'entry-1' } };
  await engine._repairRecoveredState({ account: bal(0.6) });
  const pos = state.live.positions['BTC/USDT'];
  assert.ok(Math.abs(pos.quantity - 0.6) < 1e-9);
  assert.ok(Math.abs(pos.costQuote - 60) < 1e-9);
});

test('Recovery: satışta base coin komisyonu kalan miktardan düşülür', async () => {
  const { state, engine } = recEngine({ stopStatus: 'NEW' });
  state.liveOrders['entry-1'] = entryRec();
  state.liveOrders['exit-1'] = { clientOrderId: 'exit-1', symbol: 'BTC/USDT', side: 'sell', status: 'PARTIALLY_FILLED', executedQty: 0.4, commissionByAsset: { BTC: 0.01 }, meta: { role: 'exit', entryOrderId: 'entry-1' } };
  await engine._repairRecoveredState({ account: bal(0.59) });
  const pos = state.live.positions['BTC/USDT'];
  assert.ok(Math.abs(pos.quantity - 0.59) < 1e-9);
  assert.ok(Math.abs(pos.costQuote - 59) < 1e-9);
});

test('Koruma: fiyat stop seviyesinin altındaysa ve stop yoksa piyasadan çıkış yapılır (korumasız bekleme yok)', async () => {
  const { state, engine, calls } = recEngine({ stopStatus: 'REJECTED' });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopPrice: 97, stopOrderId: null, protectiveMode: 'single-stop', entryOrderId: 'entry-1' };
  await engine._ensurePositionProtection();
  assert.equal(calls.stop.length, 0, 'stop denemesi anlamsız: fiyat zaten altında');
  assert.equal(calls.market.length, 1);
  assert.equal(calls.market[0].side, 'sell');
  assert.equal(state.live.positions['BTC/USDT'], undefined);
});

test('Kâr koruma: stop yalnızca en az %0.25 iyileşiyorsa taşınır (sürekli iptal/yeniden kurma yok)', async () => {
  const { state, engine, calls } = recEngine({ stopStatus: 'NEW' });
  const params = { stopLossPct: 3, takeProfitPct: 6, trailingStop: false };
  state.liveOrders['stop-old'] = { clientOrderId: 'stop-old', exchangeOrderId: 2, symbol: 'BTC/USDT', side: 'sell', amount: 1, status: 'NEW', meta: { role: 'protective-stop' } };
  const pos = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, highWaterMark: 110, stopPrice: 106.7, stopOrderId: 'stop-old', protectiveMode: 'single-stop', entryOrderId: 'entry-1' };
  state.live.positions['BTC/USDT'] = pos;
  await engine._syncTrailingStop('BTC/USDT', pos, params, 110.1); // yeni stop ~106.79: iyileşme %0.08
  assert.equal(calls.cancel.length, 0);
  assert.equal(pos.stopOrderId, 'stop-old');
  await engine._syncTrailingStop('BTC/USDT', pos, params, 115); // yeni stop ~111.55: iyileşme %4.5
  assert.equal(calls.cancel.length, 1);
  assert.notEqual(pos.stopOrderId, 'stop-old');
  assert.ok(pos.stopPrice > 111);
});

test('Mutabakat temiz geçince eski kilit nedeni ve kritik uyarı temizlenir', async () => {
  const { state, engine } = recEngine();
  state.live.lockReason = 'eski neden'; state.live.criticalAlert = { type: 'X', message: 'm' }; state.live.stopReplacementError = { symbol: 'BTC/USDT' };
  engine.lastReconcileAt = 0;
  await engine._reconcileIfDue();
  assert.equal(state.live.safeToTrade, true);
  assert.equal(state.live.lockReason, null);
  assert.equal(state.live.criticalAlert, null);
  assert.equal(state.live.stopReplacementError, null);
});

test('retry: HTTP 418 (IP yasağı) yeniden denenmez, 429 denenir', async () => {
  const { fetchWithRetry } = require('../src/util/retry');
  const real = global.fetch;
  try {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 418, headers: { get: () => '1' }, text: async () => '' }; };
    const r = await fetchWithRetry('https://x.invalid', {}, { retries: 2, timeoutMs: 1000, backoffMs: 1 });
    assert.equal(r.status, 418); assert.equal(calls, 1);
    calls = 0;
    global.fetch = async () => { calls++; return { ok: calls > 1, status: calls > 1 ? 200 : 429, headers: { get: () => '0' }, text: async () => '' }; };
    const r2 = await fetchWithRetry('https://x.invalid', {}, { retries: 2, timeoutMs: 1000, backoffMs: 1 });
    assert.equal(r2.status, 200); assert.equal(calls, 2);
  } finally { global.fetch = real; }
});
