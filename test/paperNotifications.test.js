'use strict';
// Paper motor bildirimleri: zengin ALIM/SATIM, durdurma mesaji, oncelikler.
const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');

const H = 3600000;
const T0 = Date.UTC(2026, 8, 30, 0, 0);
const C = (i, o, h, l, c) => ({ t: T0 + i * H, o, h, l, c, v: 1 });
const flat = (n, p) => Array.from({ length: n }, (_, i) => C(i, p, p, p, p));

function setup({ candles, strategy, settings = {}, fetchError = null } = {}) {
  const state = store.defaultState();
  state.running = true;
  state.pairs = { 'BTC/USDT': { ...state.pairs['BTC/USDT'], enabled: true, budgetPct: 100 } };
  Object.assign(state.settings, { reserveCashPct: 0, killSwitchLossPct: 0, dailyLossLimitPct: 100, ...settings });
  const ctx = { candles, now: T0 + (candles.length - 1) * H + 30000, fetchError, msgs: [] };
  const exchange = { quoteAssets: ['USDT'], fetchCandles: async () => { if (ctx.fetchError) throw new Error(ctx.fetchError); return ctx.candles; }, fetchSymbolRules: async () => ({ minNotional: 10 }) };
  const notifier = { send: async (text, opts = {}) => { ctx.msgs.push({ text, opts }); return {}; }, ping: async () => true };
  const engine = new PaperEngine({ exchange, store: { save() {} }, state, notifier, nowFn: () => ctx.now });
  engine.log = function (msg, level = 'info') { this.state.log.unshift({ t: 'x', msg, level }); };
  const id = state.pairs['BTC/USDT'].strategyId;
  const orig = strategies.registry[id];
  if (strategy) strategies.registry[id] = { ...orig, evaluate: strategy };
  ctx.restore = () => { strategies.registry[id] = orig; };
  return { engine, state, ctx };
}

test('paper ALIM mesaji HTML: sembol, miktar, harcanan, kalan, komisyon, sebep ve Istanbul saati', async () => {
  const candles = flat(10, 100).concat([C(10, 105, 106, 104, 105.5)]);
  const { engine, ctx } = setup({ candles, strategy: ({ candles: c }) => (c[c.length - 1].t === T0 + 9 * H ? { action: 'buy', reason: 'test alim' } : { action: 'hold', reason: 'b' }) });
  await engine.tick();
  ctx.restore();
  const m = ctx.msgs.find((x) => /ALIM BTC\/USDT/.test(x.text));
  assert.ok(m, JSON.stringify(ctx.msgs));
  assert.equal(m.opts.html, true);
  assert.match(m.text, /<b>ALIM BTC\/USDT<\/b> @ <code>[\d.]+<\/code>/);
  assert.match(m.text, /Miktar: <code>[\d.]+<\/code> BTC \| Harcanan: <code>[\d.]+<\/code> USDT/);
  assert.match(m.text, /Kalan: <code>[\d.]+<\/code> USDT \| Komisyon: <code>[\d.]+<\/code> USDT/);
  assert.match(m.text, /Sebep: test alim/);
  assert.match(m.text, /🕒 İstanbul: /);
});

test('paper SATIM mesaji: giris/cikis, K/Z %, pozisyon suresi ve sebep', async () => {
  const candles = flat(11, 100);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'b' }) });
  const openedAt = new Date(ctx.now - 5 * 3600000).toISOString();
  state.paper.cashByAsset = { USDT: 0 }; state.paper.cash = 0;
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', strategyId: 'x', entryPrice: 100, quantity: 1, costQuote: 100, costUSDT: 100, quoteAsset: 'USDT', baseAsset: 'BTC', stopPrice: 97, highWaterMark: 100, openedAt, checkedThroughT: T0 + 9 * H };
  const ok = engine.sellAt('BTC/USDT', state.paper.positions['BTC/USDT'], 120, 'hedef');
  ctx.restore();
  assert.equal(ok, true);
  const m = ctx.msgs.find((x) => /SATIM BTC\/USDT/.test(x.text));
  assert.ok(m, JSON.stringify(ctx.msgs));
  assert.match(m.text, /Giriş: <code>100<\/code> → Çıkış: <code>[\d.]+<\/code>/);
  assert.match(m.text, /K\/Z: <b>\+[\d.]+ USDT<\/b> \(\+[\d.]+%\)/);
  assert.match(m.text, /Pozisyon süresi: 5s/);
  assert.match(m.text, /Sebep: hedef/);
  assert.match(m.text, /^🟢/);
});

test('paper zararli SATIM 🔴 ile baslar', async () => {
  const { engine, state, ctx } = setup({ candles: flat(11, 100), strategy: () => ({ action: 'hold', reason: 'b' }) });
  state.paper.cashByAsset = { USDT: 0 }; state.paper.cash = 0;
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', strategyId: 'x', entryPrice: 100, quantity: 1, costQuote: 100, costUSDT: 100, quoteAsset: 'USDT', baseAsset: 'BTC', stopPrice: 97, highWaterMark: 100, openedAt: new Date(ctx.now - 600000).toISOString(), checkedThroughT: T0 + 9 * H };
  engine.sellAt('BTC/USDT', state.paper.positions['BTC/USDT'], 90, 'stop');
  ctx.restore();
  const m = ctx.msgs.find((x) => /SATIM BTC\/USDT/.test(x.text));
  assert.match(m.text, /^🔴/);
  assert.match(m.text, /\(-[\d.]+%\)/);
});

test('stop(): calisiyorsa "Bot durduruldu" bildirir (acik paper pozisyon uyarisiyla); notify:false ve tekrar durdurma sessiz', async () => {
  const { engine, state, ctx } = setup({ candles: flat(11, 100) });
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, costUSDT: 100 };
  engine.stop('Kullanıcı durdurdu.');
  assert.equal(ctx.msgs.length, 1);
  assert.match(ctx.msgs[0].text, /<b>Bot durduruldu<\/b>/);
  assert.match(ctx.msgs[0].text, /Sebep: Kullanıcı durdurdu\./);
  assert.match(ctx.msgs[0].text, /Açık pozisyon: BTC\/USDT/);
  assert.match(ctx.msgs[0].text, /stop-loss'u bot çalışmadığı sürece izlenmez/);
  engine.stop('yine');
  assert.equal(ctx.msgs.length, 1, 'zaten durmus motor tekrar bildirmez');
  state.running = true;
  engine.stop('sessiz', { notify: false });
  assert.equal(ctx.msgs.length, 1);
});

test('kill switch mesaji kritik oncelikli ve ayrica "Bot durduruldu" mesaji atilmaz', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'b' }), settings: { killSwitchLossPct: 25 } });
  state.paper.cash = 30;
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', strategyId: 'x', entryPrice: 100, quantity: 0.8, costUSDT: 80, stopPrice: 97, highWaterMark: 100, openedAt: 'x', checkedThroughT: T0 + 9 * H };
  await engine.tick();
  ctx.restore();
  const ks = ctx.msgs.find((x) => /KILL SWITCH/.test(x.text));
  assert.ok(ks);
  assert.equal(ks.opts.priority, 'critical');
  assert.equal(ctx.msgs.filter((x) => /Bot durduruldu/.test(x.text)).length, 0);
});

test('veri kesintisi uyarisi kritik, "geri geldi" rutin (quiet) oncelikli', async () => {
  const { engine, ctx } = setup({ candles: flat(11, 100), strategy: () => ({ action: 'hold', reason: 'b' }), fetchError: 'fetch failed' });
  for (let i = 0; i < 4; i++) await engine.tick();
  ctx.fetchError = null;
  await engine.tick();
  ctx.restore();
  assert.equal(ctx.msgs.find((x) => /Veri akışı kesildi/.test(x.text)).opts.priority, 'critical');
  assert.equal(ctx.msgs.find((x) => /geri geldi/.test(x.text)).opts.priority, 'quiet');
});
