'use strict';
// Canli motor Telegram bildirimleri: borsa stop/TP dolumu, kill switch, kilit/acilis, alim/satim, durdurma.
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const { SimulatedExchange } = require('../src/simulatedExchange');

const NOW = Date.UTC(2026, 9, 2, 12, 0);
const FIXED_NOW = () => NOW;
const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));
function makeStore() { return { save() {} }; }
function makeNotifier() {
  const msgs = [];
  return { msgs, send: async (text, opts = {}) => { msgs.push({ text, opts }); return {}; }, ping: async () => true };
}
function makeExchange() {
  return {
    id: 'binance', environment: 'testnet', name: 'Test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchBalance() { return { USDT: { free: 1000, locked: 0 } }; },
    async fetchOpenOrders() { return []; },
    async getOrder() { return { status: 'FILLED', orderId: 1, clientOrderId: 'x', executedQty: 1, origQty: 1, cummulativeQuoteQty: 100 }; },
    async createMarketOrder(symbol, side, amount, cid) { return { status: 'FILLED', orderId: 1, clientOrderId: cid, executedQty: amount, origQty: amount, cummulativeQuoteQty: amount * 100 }; },
    async createStopOrder(symbol, side, amount, stop, limit, cid) { return { status: 'NEW', orderId: 2, clientOrderId: cid, executedQty: 0, origQty: amount }; },
    async cancelOrder(symbol, orderId) { return { status: 'CANCELED', orderId }; },
    async fetchCandles() { return []; },
    async fetchTicker() { return { price: 100 }; },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10 }; }
  };
}
function liveState(over = {}) {
  const state = store.defaultState();
  state.settings.mode = 'live';
  Object.assign(state.settings, { dailyLossLimitPct: 100, killSwitchLossPct: 0, ...over });
  return state;
}
const stopFill = (over = {}) => ({ symbol: 'BTC/USDT', clientOrderId: 'stop-1', status: 'FILLED', executedQty: 1, quoteQty: 95, netQuoteQty: 95, commissionByAsset: {}, commissionBase: 0, lastExecutionId: 'exec-1', meta: { role: 'protective-stop' }, ...over });

test('borsadaki koruyucu STOP-LOSS dolunca kritik Telegram mesaji gider (K/Z, giris/cikis, sure)', async () => {
  const state = liveState();
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopPrice: 95, stopOrderId: 'stop-1', openedAt: new Date(NOW - 135 * 60000).toISOString() };
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  engine._onOrderUpdate(stopFill());
  await tick();
  assert.equal(state.live.positions['BTC/USDT'], undefined);
  assert.equal(n.msgs.length, 1);
  const m = n.msgs[0];
  assert.match(m.text, /STOP-LOSS TETİKLENDİ BTC\/USDT/);
  assert.match(m.text, /K\/Z: <b>-5\.00 USDT<\/b> \(-5\.00%\)/);
  assert.match(m.text, /Giriş: <code>100<\/code> → Çıkış: <code>95<\/code>/);
  assert.match(m.text, /Pozisyon süresi: 2s 15dk/);
  assert.match(m.text, /Pozisyon kapandı/);
  assert.equal(m.opts.priority, 'critical');
  assert.equal(m.opts.html, true);
});

test('ayni dolum (ayni executionId) iki kez bildirilmez', async () => {
  const state = liveState();
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopOrderId: 'stop-1' };
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  engine._onOrderUpdate(stopFill());
  engine._onOrderUpdate(stopFill());
  await tick();
  assert.equal(n.msgs.filter((x) => /STOP-LOSS/.test(x.text)).length, 1);
});

test('kismi stop dolumu "kismi dolum" ve kalan miktari bildirir', async () => {
  const state = liveState();
  state.liveOrders['stop-1'] = { clientOrderId: 'stop-1', symbol: 'BTC/USDT', side: 'sell', status: 'PARTIALLY_FILLED', exchangeOrderId: 5, meta: { role: 'protective-stop' } };
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopPrice: 95, stopOrderId: 'stop-1', stopExecutedQty: 0, stopCommissionBase: 0, stopNetQuoteQty: 0, stopThirdAssetCommissionQuote: 0, stopExecutionIds: [] };
  state.pairs['BTC/USDT'].params.stopLossPct = 5;
  const n = makeNotifier();
  const ex = makeExchange();
  ex.cancelOrder = async (s, orderId) => ({ status: 'CANCELED', orderId, clientOrderId: 'stop-1', symbol: 'BTCUSDT', side: 'SELL', executedQty: 0.4, origQty: 1, cummulativeQuoteQty: 38 });
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  engine._onOrderUpdate(stopFill({ status: 'PARTIALLY_FILLED', executedQty: 0.4, quoteQty: 38, netQuoteQty: 38, lastExecutionId: 'p-1' }));
  await tick();
  const m = n.msgs.find((x) => /STOP-LOSS/.test(x.text));
  assert.ok(m, 'kismi dolum bildirilmeli');
  assert.match(m.text, /kısmi dolum/);
  assert.match(m.text, /Kalan pozisyon: <code>0\.6<\/code> BTC/);
});

test('koruyucu TAKE-PROFIT dolunca "TAKE-PROFIT GERCEKLESTI" mesaji gider', async () => {
  const state = liveState();
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, tpOrderId: 'tp-1', tpPrice: 110, stopOrderId: null };
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  engine._onOrderUpdate({ symbol: 'BTC/USDT', clientOrderId: 'tp-1', status: 'FILLED', executedQty: 1, quoteQty: 110, netQuoteQty: 110, commissionByAsset: {}, commissionBase: 0, lastExecutionId: 'tp-exec', meta: { role: 'protective-tp' } });
  await tick();
  const m = n.msgs.find((x) => /TAKE-PROFIT GERÇEKLEŞTİ BTC\/USDT/.test(x.text));
  assert.ok(m, `mesajlar: ${JSON.stringify(n.msgs.map((x) => x.text))}`);
  assert.match(m.text, /K\/Z: <b>\+10\.00 USDT<\/b> \(\+10\.00%\)/);
});

test('canli market satis tam kapanista SATIM mesaji: giris/cikis, K/Z %, sure, sebep', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  ex.balances.BTC = { free: 1, locked: 0 };
  const state = liveState({ maxConcurrentPositions: 1, reserveCashPct: 0 });
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, openedAt: new Date(NOW - 3 * 3600000).toISOString(), entryOrderId: 'e1', stopOrderId: null };
  state.live.dayKey = '2026-10-02'; state.live.dayStartEquity = 1000;
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  ex.setPrice('BTC/USDT', 110);
  await engine.sell('BTC/USDT', state.live.positions['BTC/USDT'], 110, 'hedef fiyat', engine.epoch);
  const m = n.msgs.find((x) => /CANLI SATIM BTC\/USDT/.test(x.text));
  assert.ok(m);
  assert.match(m.text, /K\/Z: <b>\+10\.00 USDT<\/b> \(\+10\.00%\)/);
  assert.match(m.text, /Pozisyon süresi: 3s/);
  assert.match(m.text, /Sebep: hedef fiyat/);
  assert.doesNotMatch(m.text, /KISMİ/);
  assert.equal(m.opts.html, true);
});

test('canli alim mesaji miktar, harcanan, stop ve sebebi icerir', async () => {
  const state = liveState({ maxConcurrentPositions: 1, reserveCashPct: 0, maxTradeQuote: 1000 });
  state.live.safeToTrade = true;
  const ex = makeExchange();
  ex.createMarketOrder = async (symbol, side, amount, cid) => ({ orderId: 101, clientOrderId: cid, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: String(amount), executedQty: String(amount), cummulativeQuoteQty: String(amount * 100), fills: [] });
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5, takeProfitPct: 8, trailingStop: true }, 100, 'RSI aşırı satım', engine.epoch);
  const m = n.msgs.find((x) => /CANLI ALIM BTC\/USDT/.test(x.text));
  assert.ok(m, JSON.stringify(n.msgs.map((x) => x.text)));
  assert.match(m.text, /Fiyat: <code>100<\/code> \| Miktar: <code>[\d.]+<\/code> BTC/);
  assert.match(m.text, /Harcanan: <code>[\d.]+<\/code> USDT/);
  assert.match(m.text, /Koruyucu stop: <code>95<\/code> \(-5\.00%\) \| trailing AÇIK/);
  assert.match(m.text, /Kâr koruma eşiği: %8/);
  assert.match(m.text, /Sebep: RSI aşırı satım/);
  assert.match(m.opts.key, /^live-buy:BTC\/USDT:/);
});

test('canli gunluk zarar limiti Telegram\'a kritik mesaj atar; pozisyon kapatma sonucu da bildirilir', async () => {
  const ex = makeExchange();
  const state = liveState({ dailyLossLimitPct: 5, closeOnDailyLoss: false });
  state.running = true;
  state.live.startingEquity = 1000; state.live.dayStartEquity = 1000; state.live.dayRealizedPnl = 0;
  state.live.lastBalance = { USDT: { free: 900, locked: 0, total: 900 } };
  state.live.positions = { 'BTC/USDT': { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100 } };
  state.live.lastPrices = { 'BTC/USDT': 0 };
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: ex, state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  state.live.dayKey = engine.getRiskDayKey();
  await engine._checkRiskGate();
  assert.ok(state.killSwitch);
  const first = n.msgs.find((x) => /GÜNLÜK ZARAR LİMİTİ AŞILDI/.test(x.text));
  assert.ok(first, JSON.stringify(n.msgs.map((x) => x.text)));
  assert.equal(first.opts.priority, 'critical');
  assert.match(first.text, /Sebep: canlı USDT günlük zarar limiti aşıldı/);
  assert.match(first.text, /Kapatılacak pozisyon: 1 \(BTC\/USDT\)/);
  assert.ok(n.msgs.some((x) => /Kill switch sonucu/.test(x.text)), 'kapatma sonucu da bildirilmeli');
  assert.equal(n.msgs.filter((x) => /Bot durduruldu|Canlı bot durduruldu/.test(x.text)).length, 0, 'risk durdurmasi ikinci kez "durduruldu" demez');
});

test('canli toplam zarar kill switch mesaji ozkaynak ve baslangic ozkaynagini gosterir', async () => {
  const state = liveState({ killSwitchLossPct: 20 });
  state.running = true;
  state.live.startingEquityByQuote = { USDT: 1000 }; state.live.startingEquity = 1000;
  state.live.lastBalance = { USDT: { free: 700, locked: 0, total: 700 } };
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  state.live.dayKey = engine.getRiskDayKey();
  state.live.dayStartEquityByQuote = { USDT: 700 };
  await engine._checkRiskGate();
  const m = n.msgs.find((x) => /KILL SWITCH \(toplam zarar\)/.test(x.text));
  assert.ok(m);
  assert.match(m.text, /Özkaynak: <code>700<\/code> USDT \(başlangıç: 1000\)/);
  assert.match(m.text, /Açık pozisyon yok/);
});

async function runTick(engine, { gate }) {
  engine._reconcileIfDue = async () => {};
  engine._adoptFilledEntries = async () => {};
  engine._ensurePositionProtection = async () => {};
  engine._checkRiskGate = async () => { gate(); };
  await engine.tick();
}

test('kilitlenince sebebi yazan 🔒 mesaji; kilit kalkinca 🔓 mesaji gider', async () => {
  const state = liveState();
  state.running = true; state.live.safeToTrade = true;
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopOrderId: 's' };
  const n = makeNotifier();
  let t = NOW;
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: () => t, notifier: n });
  engine._wasSafe = true;
  await runTick(engine, { gate: () => { state.live.safeToTrade = false; state.live.lockReason = 'Koruyucu stop borsada açık değil: BTC/USDT'; } });
  const lock = n.msgs.find((x) => /CANLI İŞLEM KİLİTLENDİ/.test(x.text));
  assert.ok(lock, JSON.stringify(n.msgs.map((x) => x.text)));
  assert.match(lock.text, /Sebep: Koruyucu stop borsada açık değil: BTC\/USDT/);
  assert.match(lock.text, /Açık pozisyon: BTC\/USDT/);
  assert.equal(lock.opts.priority, 'critical');
  t += 12 * 60000;
  await runTick(engine, { gate: () => { state.live.safeToTrade = true; } });
  const unlock = n.msgs.find((x) => /kilidi kalktı/.test(x.text));
  assert.ok(unlock);
  assert.match(unlock.text, /Kilit süresi: ~12 dk/);
});

test('kilit sebebi lockReason yoksa mutabakat hatalarindan ozetlenir; kill switch varken ayrica 🔒 atilmaz', async () => {
  const state = liveState();
  state.running = true; state.live.safeToTrade = true;
  state.liveReconciliation = { safeToTrade: false, errors: ['Yönetilen varlık bakiyesi yerel pozisyon defteriyle uyuşmuyor.'] };
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  engine._wasSafe = true;
  await runTick(engine, { gate: () => { state.live.safeToTrade = false; } });
  assert.match(n.msgs[0].text, /Sebep: mutabakat: Yönetilen varlık bakiyesi/);

  const state2 = liveState();
  state2.running = true; state2.live.safeToTrade = true; state2.killSwitch = { t: 'x', reason: 'zarar' };
  const n2 = makeNotifier();
  const engine2 = new LiveEngine({ exchange: makeExchange(), state: state2, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n2 });
  engine2._wasSafe = true;
  await runTick(engine2, { gate: () => { state2.live.safeToTrade = false; } });
  assert.equal(n2.msgs.length, 0, 'kill switch kendi mesajini gonderir, ikinci kilit mesaji gereksiz');
});

test('canli stop(): calisiyorsa bildirir (acik pozisyon uyarisiyla), notify:false ve zaten durmussa sessiz', async () => {
  const state = liveState();
  state.running = true;
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100 };
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  await engine.stop('Kullanıcı durdurdu.');
  assert.equal(n.msgs.length, 1);
  assert.match(n.msgs[0].text, /Canlı bot durduruldu/);
  assert.match(n.msgs[0].text, /Açık pozisyon: BTC\/USDT/);
  assert.match(n.msgs[0].text, /borsadaki stop emirleri yerinde kalır/);
  await engine.stop('tekrar');
  assert.equal(n.msgs.length, 1, 'zaten durmus motor tekrar bildirmez');
  state.running = true;
  await engine.stop('sessiz', { notify: false });
  assert.equal(n.msgs.length, 1);
});

test('mesajlardaki dinamik metin HTML-escape edilir (sebep icinde < & olsa da etiket bozulmaz)', async () => {
  const state = liveState();
  state.running = true; state.live.safeToTrade = true;
  state.live.lockReason = 'hata <script> & "x"';
  const n = makeNotifier();
  const engine = new LiveEngine({ exchange: makeExchange(), state, store: makeStore(), allowLive: true, nowFn: FIXED_NOW, notifier: n });
  engine._wasSafe = true;
  await runTick(engine, { gate: () => { state.live.safeToTrade = false; } });
  assert.match(n.msgs[0].text, /hata &lt;script&gt; &amp; "x"/);
  assert.doesNotMatch(n.msgs[0].text, /<script>/);
});
