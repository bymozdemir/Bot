const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { flat, makeEngine, onlyPair, store } = require('./helpers');
const { validateExtrasPatch, normalizeExtras } = require('../src/entryExtras');
const { checkPairFilters } = require('../src/pairFilters');
const { timeBarrierExit } = require('../src/timeBarrier');

const H = 3600000;
function withStrategy(id, evaluate, fn) {
  const reg = strategies.registry; const orig = reg[id];
  reg[id] = { ...orig, evaluate };
  return Promise.resolve(fn()).finally(() => { reg[id] = orig; });
}
const liveCandles = () => flat(300, 100).map((c) => ({ ...c, t: c.t - H })).concat([{ t: Date.now(), o: 100, h: 100, l: 100, c: 100, v: 1 }]);
const makeState = () => { const st = store.defaultState(); st.running = true; onlyPair(st); return st; };
const exchange = () => ({ quoteAssets: ['USDT'], fetchCandles: async () => liveCandles(), fetchSymbolRules: async () => ({ minNotional: 10 }) });

test('varsayilan ayarlarda ek katmanlar kapali ve alim eskisi gibi acilir', async () => {
  const state = makeState();
  assert.equal(state.settings.protections.enabled, false);
  assert.equal(state.settings.pairFilters.enabled, false);
  assert.equal(state.settings.timeBarrier.enabled, false);
  state.paper.trades = [{ symbol: 'BTC/USDT', closedAt: new Date().toISOString(), pnl: -1, pnlPct: -1, reason: 'stop-loss' }];
  const { engine } = makeEngine({ state, exchange: exchange() });
  await withStrategy('rsi_ema_macd', () => ({ action: 'buy', reason: 't', price: 100 }), () => engine.tick());
  assert.equal(Object.keys(state.paper.positions).length, 1);
});

test('cooldown acikken yakin zamanda kapanan paritede alim engellenir ve karar kaydina yazilir', async () => {
  const state = makeState();
  state.settings.protections = { enabled: true, cooldown: { enabled: true, minutes: 60 }, stoplossGuard: { enabled: false }, maxDrawdown: { enabled: false } };
  state.paper.trades = [{ symbol: 'BTC/USDT', closedAt: new Date().toISOString(), pnl: 1, pnlPct: 1, reason: 'sinyal' }];
  const { engine } = makeEngine({ state, exchange: exchange() });
  await withStrategy('rsi_ema_macd', () => ({ action: 'buy', reason: 't', price: 100 }), () => engine.tick());
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.match(state.decisions['BTC/USDT'].blockedBy, /koruma kilidi \(cooldown/);
});

test('cooldown suresi gectiyse alim yapilir', async () => {
  const state = makeState();
  state.settings.protections = { enabled: true, cooldown: { enabled: true, minutes: 60 } };
  state.paper.trades = [{ symbol: 'BTC/USDT', closedAt: new Date(Date.now() - 3 * H).toISOString(), pnl: 1, pnlPct: 1, reason: 'sinyal' }];
  const { engine } = makeEngine({ state, exchange: exchange() });
  await withStrategy('rsi_ema_macd', () => ({ action: 'buy', reason: 't', price: 100 }), () => engine.tick());
  assert.equal(Object.keys(state.paper.positions).length, 1);
});

test('parite filtresi: yetersiz gecmis (yas) alimi engeller', async () => {
  const state = makeState();
  state.settings.pairFilters = { enabled: true, minCandles: 5000 };
  const { engine } = makeEngine({ state, exchange: exchange() });
  await withStrategy('rsi_ema_macd', () => ({ action: 'buy', reason: 't', price: 100 }), () => engine.tick());
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.match(state.decisions['BTC/USDT'].blockedBy, /parite filtresi \(age\)/);
});

test('zaman bariyeri: strateji tutsa bile suresi dolmus ve hedefe ulasmamis pozisyon kapanir', async () => {
  const state = makeState();
  state.settings.timeBarrier = { enabled: true, maxHoldBars: 10, minProfitPct: 0.5 };
  state.paper.cash = 50;
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', entryPrice: 100, quantity: 1, costUSDT: 100, costQuote: 100, stopPrice: null, highWaterMark: 100, openedAt: new Date(Date.now() - 50 * H).toISOString() };
  const { engine } = makeEngine({ state, exchange: exchange() });
  await withStrategy('rsi_ema_macd', () => ({ action: 'hold', reason: 'bekle', price: 100 }), () => engine.tick());
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.match(state.paper.trades[0].reason, /zaman bariyeri/);
});

test('zaman bariyeri kapaliyken ayni pozisyon acik kalir', async () => {
  const state = makeState();
  state.paper.cash = 50;
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', entryPrice: 100, quantity: 1, costUSDT: 100, costQuote: 100, stopPrice: null, highWaterMark: 100, openedAt: new Date(Date.now() - 50 * H).toISOString() };
  const { engine } = makeEngine({ state, exchange: exchange() });
  await withStrategy('rsi_ema_macd', () => ({ action: 'hold', reason: 'bekle', price: 100 }), () => engine.tick());
  assert.equal(Object.keys(state.paper.positions).length, 1);
});

test('timeBarrierExit: kar hedefine ulasmis pozisyon cikmaz; gecersiz girdi null', () => {
  const closed = Array.from({ length: 20 }, (_, i) => ({ t: 1000 + i * H, c: 100 }));
  const pos = { openedAt: new Date(1000).toISOString(), entryPrice: 100 };
  const cfg = { enabled: true, maxHoldBars: 10, minProfitPct: 1 };
  assert.equal(timeBarrierExit({ position: pos, closedCandles: closed, price: 103, config: cfg }), null);
  assert.ok(timeBarrierExit({ position: pos, closedCandles: closed, price: 100, config: cfg }));
  assert.equal(timeBarrierExit({ position: { openedAt: 'x', entryPrice: 100 }, closedCandles: closed, price: 100, config: cfg }), null);
});

test('checkPairFilters: hacim ve volatilite kurallari', () => {
  const c = Array.from({ length: 200 }, (_, i) => ({ t: i * H, o: 100, h: 101, l: 99, c: 100, v: 10 }));
  assert.equal(checkPairFilters({ closedCandles: c, timeframeMs: H, config: { enabled: true, minQuoteVolume24h: 1e9 } }).rule, 'volume');
  assert.equal(checkPairFilters({ closedCandles: c, timeframeMs: H, config: { enabled: true, minAtrPct: 5 } }).rule, 'volatility');
  assert.equal(checkPairFilters({ closedCandles: c, timeframeMs: H, config: { enabled: true, maxAtrPct: 0.5 } }).rule, 'volatility');
  assert.equal(checkPairFilters({ closedCandles: c, timeframeMs: H, config: { enabled: true, minQuoteVolume24h: 100, minAtrPct: 0.1, maxAtrPct: 10 } }).ok, true);
  assert.equal(checkPairFilters({ closedCandles: c, timeframeMs: H, config: { enabled: false, minCandles: 99999 } }).ok, true);
});

test('validateExtrasPatch: kismi yama mevcut ayarlarla birlesir, tip hatasi acik hata verir', () => {
  const cur = normalizeExtras({}); 
  const ok = validateExtrasPatch({ protections: { enabled: true, cooldown: { minutes: 30 } } }, cur);
  assert.equal(ok.value.protections.enabled, true);
  assert.equal(ok.value.protections.cooldown.minutes, 30);
  assert.equal(ok.value.protections.cooldown.enabled, true); // mevcut alan korunur
  assert.match(validateExtrasPatch({ protections: 'evet' }, cur).error, /nesne/);
  assert.match(validateExtrasPatch({ timeBarrier: { maxHoldBars: 'on' } }, cur).error, /timeBarrier\.maxHoldBars/);
  assert.match(validateExtrasPatch({ pairFilters: { minAtrPct: NaN } }, cur).error, /sayı/);
  assert.deepEqual(validateExtrasPatch({}, cur).value, {});
});

test('eski state.json (yeni ayar anahtarlari yok) sorunsuz yuklenir ve varsayilanlar kapali kalir', async () => {
  const state = makeState();
  for (const k of ['protections', 'pairFilters', 'timeBarrier', 'forager']) delete state.settings[k];
  const { engine } = makeEngine({ state, exchange: exchange() });
  await withStrategy('rsi_ema_macd', () => ({ action: 'buy', reason: 't', price: 100 }), () => engine.tick());
  assert.equal(Object.keys(state.paper.positions).length, 1);
  assert.equal(state.settings.protections.enabled, false);
  assert.equal(state.settings.forager.enabled, false);
});
