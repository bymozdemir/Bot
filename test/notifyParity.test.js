'use strict';
// Paper/canli bildirim esitligi: paper tick hatasi, canli parite kesintisi, paper durable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-parity-'));
const strategies = require('../src/strategies');
const PaperEngine = require('../src/paperEngine');
const LiveEngine = require('../src/liveEngine');
const store = require('../src/store');
const { createNotifier } = require('../src/notify');

const quiet = (fn) => async (...a) => {
  const log = console.error; const warn = console.warn; const lg = console.log; console.error = () => {}; console.warn = () => {}; console.log = () => {};
  try { return await fn(...a); } finally { console.error = log; console.warn = warn; console.log = lg; }
};
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// ---------------- PAPER ----------------
const H = 3600000;
const T0 = Date.UTC(2026, 8, 30, 0, 0);
const C = (i, o, h, l, c) => ({ t: T0 + i * H, o, h, l, c, v: 1 });
const flat = (n, p) => Array.from({ length: n }, (_, i) => C(i, p, p, p, p));
function paperSetup({ candles, strategy } = {}) {
  const state = store.defaultState();
  state.running = true;
  state.pairs = { 'BTC/USDT': { ...state.pairs['BTC/USDT'], enabled: true, budgetPct: 100 } };
  Object.assign(state.settings, { reserveCashPct: 0, killSwitchLossPct: 0, dailyLossLimitPct: 100 });
  const ctx = { now: T0 + ((candles || flat(11, 100)).length - 1) * H + 30000, msgs: [] };
  const exchange = { quoteAssets: ['USDT'], fetchCandles: async () => candles || flat(11, 100), fetchSymbolRules: async () => ({ minNotional: 10 }) };
  const notifier = { send: async (text, opts = {}) => { ctx.msgs.push({ text, opts }); return {}; }, ping: async () => true };
  const engine = new PaperEngine({ exchange, store: { save() {} }, state, notifier, nowFn: () => ctx.now });
  engine.log = function (msg, level = 'info') { this.state.log.unshift({ t: 'x', msg, level }); };
  const id = state.pairs['BTC/USDT'].strategyId;
  const orig = strategies.registry[id];
  if (strategy) strategies.registry[id] = { ...orig, evaluate: strategy };
  ctx.restore = () => { strategies.registry[id] = orig; };
  return { engine, state, ctx };
}

test('paper: beklenmeyen tick hatasi kritik Telegram mesaji gonderir (canli motorla ayni)', quiet(async () => {
  const { engine, ctx } = paperSetup();
  engine.tick = async () => { throw new Error('boom'); };
  await engine.safeTick();
  ctx.restore();
  assert.equal(ctx.msgs.length, 1);
  assert.match(ctx.msgs[0].text, /Paper tick hatası: boom/);
  assert.equal(ctx.msgs[0].opts.priority, 'critical');
  assert.equal(ctx.msgs[0].opts.key, 'paper-tick-error');
  assert.equal(ctx.msgs[0].opts.minIntervalMs, 300000);
}));

test('paper: ayni tick hatasi 5 dk icinde tekrar tekrar mesaj yagdirmaz (gercek bildirici ile)', quiet(async () => {
  let calls = 0; let t = 1_000_000;
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', NOTIFY_MIN_GAP_MS: '0', BOT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'notify-real-')) }, fetchFn: async () => { calls++; return { ok: true }; }, logger: { warn() {}, log() {} }, now: () => t, sleep: async () => {} });
  const { engine, state } = paperSetup();
  const e2 = new PaperEngine({ exchange: engine.exchange, store: { save() {} }, state, notifier: n, nowFn: () => t });
  e2.log = () => {};
  e2.tick = async () => { throw new Error('boom'); };
  await e2.safeTick(); await e2.safeTick(); await e2.safeTick();
  await settle();
  assert.equal(calls, 1);
  t += 6 * 60000;
  await e2.safeTick(); await settle();
  assert.equal(calls, 2);
}));

test('paper ALIM ve SATIM mesajlari durable gider', quiet(async () => {
  const candles = flat(10, 100).concat([C(10, 105, 106, 104, 105.5)]);
  const { engine, state, ctx } = paperSetup({ candles, strategy: ({ candles: c }) => (c[c.length - 1].t === T0 + 9 * H ? { action: 'buy', reason: 'test alim' } : { action: 'hold', reason: 'b' }) });
  await engine.tick();
  const buy = ctx.msgs.find((x) => /ALIM BTC\/USDT/.test(x.text));
  assert.ok(buy, JSON.stringify(ctx.msgs));
  assert.equal(buy.opts.durable, true);
  const pos = state.paper.positions['BTC/USDT'];
  assert.ok(pos, 'pozisyon acilmali');
  assert.equal(engine.sellAt('BTC/USDT', pos, 120, 'hedef'), true);
  ctx.restore();
  const sell = ctx.msgs.find((x) => /SATIM BTC\/USDT/.test(x.text));
  assert.ok(sell);
  assert.equal(sell.opts.durable, true);
}));

test('paper durable alim mesaji ag hatasinda kaybolmaz, ag gelince gecikmeli gider', quiet(async () => {
  let t = 1_000_000; const bodies = []; let ok = false;
  const fetchFn = async (u, o) => { bodies.push(JSON.parse(o.body)); t += 100; return ok ? { ok: true } : { ok: false, status: 500, json: async () => ({}) }; };
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', NOTIFY_MIN_GAP_MS: '0', BOT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'notify-real-')) }, fetchFn, logger: { warn() {}, log() {} }, now: () => t, sleep: async (ms) => { t += ms; } });
  const candles = flat(10, 100).concat([C(10, 105, 106, 104, 105.5)]);
  const { engine, state, ctx } = paperSetup({ candles, strategy: ({ candles: c }) => (c[c.length - 1].t === T0 + 9 * H ? { action: 'buy', reason: 'test alim' } : { action: 'hold', reason: 'b' }) });
  const e2 = new PaperEngine({ exchange: engine.exchange, store: { save() {} }, state, notifier: n, nowFn: () => ctx.now });
  e2.log = () => {};
  await e2.tick(); await settle(); await new Promise((r) => setTimeout(r, 20));
  ctx.restore();
  assert.equal(n.pendingCount(), 1, 'basarisiz alim mesaji bekleme listesine girmeli');
  ok = true; bodies.length = 0;
  assert.equal(await n.flushPending(), 1);
  assert.match(bodies[0].text, /Gecikmeli bildirim/);
  assert.match(bodies[0].text, /ALIM BTC\/USDT/);
}));


test('kalici kuyruk: yeni notifier sureci bekleyen bildirimi diskten yukler ve gonderir', quiet(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-restart-'));
  let ok = false; const sent = [];
  const env = { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', NOTIFY_MIN_GAP_MS: '0', BOT_DATA_DIR: dataDir };
  const fetchFn = async (u, o) => { sent.push(JSON.parse(o.body)); return ok ? { ok: true } : { ok: false, status: 500, json: async () => ({}) }; };
  const first = createNotifier({ env, fetchFn, logger: { warn() {}, log() {} }, now: () => 2_000_000, sleep: async () => {} });
  await first.send('ALIM BTC/USDT', { durable: true });
  assert.equal(first.pendingCount(), 1, 'ilk surecte bildirim beklemeli');
  const diskFile = path.join(dataDir, 'notify-pending.json');
  assert.equal(JSON.parse(fs.readFileSync(diskFile, 'utf8')).length, 1, 'bekleyen bildirim diske yazilmali');

  // Yeni notifier, yeni surec gibi ayni diske baglanir; bellekteki ilk nesne kullanilmaz.
  ok = true;
  const second = createNotifier({ env, fetchFn, logger: { warn() {}, log() {} }, now: () => 2_001_000, sleep: async () => {} });
  assert.equal(second.pendingCount(), 1, 'yeni surec kuyrugu diskten yuklemeli');
  assert.equal(await second.flushPending(), 1, 'geri yuklenen bildirim gonderilmeli');
  assert.match(sent[sent.length - 1].text, /Gecikmeli bildirim/);
  assert.match(sent[sent.length - 1].text, /ALIM BTC\/USDT/);
  assert.equal(JSON.parse(fs.readFileSync(diskFile, 'utf8')).length, 0, 'gonderimden sonra disk kuyrugu temizlenmeli');
}));

// ---------------- CANLI ----------------
const NOW = Date.UTC(2026, 9, 2, 12, 0);
function liveSetup({ position = null } = {}) {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.live.safeToTrade = true; state.running = true;
  state.pairs = { 'BTC/USDT': { ...(state.pairs['BTC/USDT'] || {}), enabled: true, budgetPct: 10, params: { stopLossPct: 5 } } }; // tek parite: sayimlar net olsun
  if (position) state.live.positions['BTC/USDT'] = position;
  const msgs = [];
  const notifier = { send: async (text, opts = {}) => { msgs.push({ text, opts }); return {}; }, ping: async () => true };
  const exchange = { id: 'binance', environment: 'testnet', name: 'T', quoteAssets: ['USDT'], capabilities: {} };
  const e = new LiveEngine({ exchange, state, store: { save() {} }, allowLive: true, nowFn: () => NOW, notifier });
  for (const m of ['_reconcileIfDue', '_adoptFilledEntries', '_adoptFilledExits', '_ensurePositionProtection', '_checkRiskGate']) e[m] = async () => {};
  const ctl = { fail: true, err: 'ECONNRESET veri alinamadi' };
  e.processPair = async () => { if (ctl.fail) throw new Error(ctl.err); };
  return { e, state, msgs, ctl };
}

test('canli: parite 3 tur ust uste islenemezse TEK kritik uyari; tekrar tekrar mesaj yok; duzelince quiet bilgi', quiet(async () => {
  const { e, msgs, ctl } = liveSetup();
  await e.tick(); await e.tick(); await settle();
  assert.equal(msgs.length, 0, '2 tur henuz uyari vermez');
  await e.tick(); await settle();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /BTC\/USDT: 3 tur üst üste işlenemedi \(ECONNRESET veri alinamadi\)/);
  assert.match(msgs[0].text, /yeni alım\/çıkış kararı verilmiyor/);
  assert.equal(msgs[0].opts.priority, 'critical');
  assert.equal(msgs[0].opts.key, 'live-pair-outage:BTC/USDT');
  await e.tick(); await e.tick(); await settle();
  assert.equal(msgs.length, 1, 'ayni kesinti icin ikinci uyari yok');
  ctl.fail = false;
  await e.tick(); await settle();
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].text, /✅ BTC\/USDT: parite işleme yeniden çalışıyor/);
  assert.equal(msgs[1].opts.priority, 'quiet');
  await e.tick(); await settle();
  assert.equal(msgs.length, 2, 'duzeldikten sonra tekrar bilgi yok');
}));

test('canli: araya giren basarili tur sayaci sifirlar (kesintisiz 3 tur sart)', quiet(async () => {
  const { e, msgs, ctl } = liveSetup();
  await e.tick(); await e.tick();
  ctl.fail = false; await e.tick();
  ctl.fail = true; await e.tick(); await e.tick(); await settle();
  assert.equal(msgs.length, 0);
  await e.tick(); await settle();
  assert.equal(msgs.length, 1);
}));

test('canli: acik pozisyonlu paritede mesaj, borsadaki stop durumuna gore dogru sozu soyler', quiet(async () => {
  const a = liveSetup({ position: { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopPrice: 95, stopOrderId: 's1', openedAt: new Date(NOW).toISOString() } });
  for (let i = 0; i < 3; i++) await a.e.tick();
  await settle();
  assert.match(a.msgs[0].text, /borsadaki koruyucu stop yerinde/);
  const b = liveSetup({ position: { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopPrice: null, stopOrderId: null, openedAt: new Date(NOW).toISOString() } });
  for (let i = 0; i < 3; i++) await b.e.tick();
  await settle();
  assert.match(b.msgs[0].text, /kayıtlı koruyucu stop YOK/);
}));

test('canli: parite devre disi birakilirsa ust uste hata sayaci temizlenir', quiet(async () => {
  const { e, state, msgs } = liveSetup();
  await e.tick(); await e.tick();
  state.pairs['BTC/USDT'].enabled = false;
  await e.tick();
  state.pairs['BTC/USDT'].enabled = true;
  await e.tick(); await e.tick(); await settle();
  assert.equal(msgs.length, 0, 'devre disi birakma sayaci sifirlamali');
  assert.equal(e.pairFailStreak.size, 1);
  e.pairFailStreak.clear();
}));
