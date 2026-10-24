const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { flat, sleep, makeEngine, onlyPair, store } = require('./helpers');

// Motorun kullandigi strateji kaydini gecici olarak sahte bir karar veren
// stratejiyle degistirir.
function withStrategy(id, evaluate, fn) {
  const reg = strategies.registry;
  const orig = reg[id];
  reg[id] = { ...orig, evaluate };
  const restore = () => { reg[id] = orig; };
  return Promise.resolve(fn()).finally(restore);
}

test('bir paritenin verisi gelmeyen turda equity giris fiyatina SICRAMAZ', async () => {
  const state = store.defaultState();
  state.running = true;
  state.paper.cash = 50;
  state.paper.positions['ETH/USDT'] = { symbol: 'ETH/USDT', entryPrice: 100, quantity: 1, costUSDT: 100, stopPrice: null, highWaterMark: 100 };
  state.paper.lastPrices = { 'ETH/USDT': 60 };
  state.pairs = { 'ETH/USDT': { ...state.pairs['ETH/USDT'], enabled: true } };
  const { engine } = makeEngine({
    state,
    exchange: { quoteAssets: ['USDT'], fetchCandles: async () => { throw new Error('ag hatasi'); }, fetchSymbolRules: async () => ({ minNotional: 10 }) }
  });
  await engine.tick();
  // equityHistory likidasyon degeriyle yazilir (komisyon + kayma dusulur): 50 + 60*(1-0.0005)*(1-0.001).
  // Onemli olan: veri gelmeyen turda pozisyon giris fiyatina (100) SICRAMAZ; son bilinen fiyatla (60) degerlenir.
  const expected = 50 + 60 * (1 - 0.05 / 100) * (1 - 0.1 / 100);
  assert.ok(Math.abs(state.paper.equityHistory.at(-1).equity - expected) < 1e-9, `equity ${state.paper.equityHistory.at(-1).equity} != ${expected}`);
});

test('cakisan iki tick tek pozisyon acar, nakit tek kez duser', async () => {
  const state = store.defaultState();
  state.running = true;
  onlyPair(state);
  const { engine } = makeEngine({
    state,
    exchange: {
      quoteAssets: ['USDT'],
      fetchCandles: async () => { await sleep(20); return flat(300, 100).map((c) => ({ ...c, t: c.t - 3600000 })).concat([{t:Date.now(),o:100,h:100,l:100,c:100,v:1}]); },
      fetchSymbolRules: async () => { await sleep(40); return { minNotional: 10 }; }
    }
  });
  await withStrategy('rsi_ema_macd', () => ({ action: 'buy', reason: 't', price: 100 }), async () => {
    await Promise.all([engine.tick(), engine.tick(), engine.tick()]);
  });
  assert.equal(Object.keys(state.paper.positions).length, 1);
  const spent = 150 - state.paper.cash;
  assert.ok(Math.abs(spent - state.paper.positions['BTC/USDT'].costUSDT) < 1e-9, `nakit ${spent} != maliyet`);
});

test('await sirasinda tryBuy ikinci kez cagrilsa bile cift alim olmaz', async () => {
  const state = store.defaultState();
  onlyPair(state);
  const { engine } = makeEngine({ state, exchange: { quoteAssets: ['USDT'], fetchSymbolRules: async () => { await sleep(20); return { minNotional: 10 }; } } });
  const pair = state.pairs['BTC/USDT'];
  const d = { action: 'buy', reason: 't', price: 100 };
  await Promise.all([engine.tryBuy('BTC/USDT', pair, d, pair.params, 100, 0), engine.tryBuy('BTC/USDT', pair, d, pair.params, 100, 0)]);
  assert.equal(Object.keys(state.paper.positions).length, 1);
  assert.ok(Math.abs(150 - state.paper.cash - state.paper.positions['BTC/USDT'].costUSDT) < 1e-9);
});

test('PASIF pariteyi acik pozisyonu varsa stop-loss izlemeye devam eder', async () => {
  const state = store.defaultState();
  state.running = true;
  const pair = onlyPair(state);
  pair.enabled = false;
  state.paper.cash = 100;
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', entryPrice: 100, quantity: 0.5, costUSDT: 50, stopPrice: 97, highWaterMark: 100, openedAt: 'x' };
  const { engine } = makeEngine({ state, exchange: { quoteAssets: ['USDT'], fetchCandles: async () => flat(300, 90).map((c) => ({ ...c, t: c.t - 3600000 })).concat([{t:Date.now(),o:90,h:90,l:90,c:90,v:1}]), fetchSymbolRules: async () => ({ minNotional: 10 }) } });
  await engine.tick();
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.equal(state.paper.trades.length, 1);
  assert.match(state.paper.trades[0].reason, /stop-loss/);
});

test('pasif ve pozisyonsuz parite hic islenmez', async () => {
  const state = store.defaultState();
  state.running = true;
  const pair = onlyPair(state);
  pair.enabled = false;
  let calls = 0;
  const { engine } = makeEngine({ state, exchange: { quoteAssets: ['USDT'], fetchCandles: async () => { calls++; return flat(300, 100); } } });
  await engine.tick();
  assert.equal(calls, 0);
});

test('closePosition parayi nakde geri dondurur (komisyon haric kaybolmaz)', () => {
  const state = store.defaultState();
  state.paper.cash = 100;
  state.paper.lastPrices = { 'SOL/USDT': 100 };
  state.paper.positions['SOL/USDT'] = { symbol: 'SOL/USDT', entryPrice: 100, quantity: 0.5, costUSDT: 50, openedAt: 'x' };
  const { engine } = makeEngine({ state });
  assert.equal(engine.closePosition('SOL/USDT', 'test'), true);
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.ok(state.paper.cash > 149.9 && state.paper.cash < 150, `cash=${state.paper.cash}`); // 100 + 50*(1-0.001)
  assert.equal(engine.closePosition('YOK/USDT', 'x'), false);
});

test('stop() sonrasi askidaki tick state\'e islem yazmaz', async () => {
  const state = store.defaultState();
  state.running = true;
  onlyPair(state);
  const { engine } = makeEngine({ state, exchange: { quoteAssets: ['USDT'], fetchCandles: async () => { await sleep(30); return flat(300, 100); }, fetchSymbolRules: async () => ({ minNotional: 10 }) } });
  await withStrategy('rsi_ema_macd', () => ({ action: 'buy', reason: 't', price: 100 }), async () => {
    const t = engine.tick();
    await sleep(5);
    engine.stop('test');
    await t;
  });
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.equal(state.paper.cash, 150);
});

test('mum siniri uzun EMA icin otomatik artar (300 sabit degil)', async () => {
  const state = store.defaultState();
  state.running = true;
  const pair = onlyPair(state);
  pair.params.emaSlow = 240; // 400 artik reddedilir: 1610 mum gerektirir, borsa tek cagrida en fazla 1000 verir (eskiden sessizce hic islem yapmazdi)
  let asked = 0;
  const { engine } = makeEngine({ state, exchange: { quoteAssets: ['USDT'], fetchCandles: async (s, tf, limit) => { asked = limit; return flat(limit, 100); } } });
  await engine.tick();
  assert.ok(asked >= 245, `istenen mum: ${asked}`);
  assert.ok(asked <= 1000);
});

test('gecersiz butce payi (NaN) nakdi bozmaz', async () => {
  const state = store.defaultState();
  const pair = onlyPair(state);
  pair.budgetPct = undefined;
  const { engine } = makeEngine({ state });
  await engine.tryBuy('BTC/USDT', pair, { action: 'buy', reason: 't' }, pair.params, 100, 0);
  assert.equal(state.paper.cash, 150);
  assert.equal(Object.keys(state.paper.positions).length, 0);
});

test('gunluk zarar limiti asilinca durur; limit 0/NaN ise yanlis tetiklenmez', async () => {
  const mk = (limit) => {
    const state = store.defaultState();
    state.running = true;
    state.settings.dailyLossLimitPct = limit;
    state.settings.killSwitchLossPct = 0; // bu testte sadece GUNLUK limit sinaniyor
    state.paper.dayStartEquity = 150;
    state.paper.cash = 100; // %33 dusus
    state.pairs = {};
    const made = makeEngine({ state });
    state.paper.dayKey = made.engine.getRiskDayKey(); // motorun KENDI gun hesabiyla (saat dilimine bagli degil)
    return made;
  };
  const a = mk(5); await a.engine.tick(); assert.equal(a.state.running, false);
  const b = mk(0); await b.engine.tick(); assert.equal(b.state.running, true);
  const c = mk(NaN); await c.engine.tick(); assert.equal(c.state.running, true);
});

test('gun basi referansi islemlerden ONCE ayarlanir', async () => {
  const state = store.defaultState();
  state.running = true;
  state.pairs = {};
  state.paper.dayKey = '2000-01-01';
  state.paper.dayStartEquity = 9999;
  const { engine } = makeEngine({ state });
  await engine.tick();
  assert.equal(state.paper.dayStartEquity, 150);
});

test('borsada desteklenmeyen kasa birimi atlanir ve ayni uyari tekrarlanmaz', async () => {
  const state = store.defaultState();
  state.running = true;
  onlyPair(state, 'BTC/USDT');
  let fetched = 0;
  const { engine } = makeEngine({ state, exchange: { name: 'TRY-borsa', quoteAssets: ['TRY'], fetchCandles: async () => { fetched++; return flat(300, 1); } } });
  await engine.tick();
  await engine.tick();
  await engine.tick();
  assert.equal(fetched, 0);
  assert.equal(state.log.filter((l) => /desteklenmiyor/.test(l.msg)).length, 1);
});

test('tekrarlayan ag hatasi log\'u doldurmaz (kisitli loglama)', async () => {
  const state = store.defaultState();
  state.running = true;
  onlyPair(state);
  const { engine } = makeEngine({ state, exchange: { quoteAssets: ['USDT'], fetchCandles: async () => { throw new Error('zaman asimi'); } } });
  for (let i = 0; i < 5; i++) await engine.tick();
  assert.equal(state.log.filter((l) => /işlenemedi/.test(l.msg)).length, 1);
});

test('start(): onUpdate senkron cagrilsa bile hata yok, zamanlayici kurulur, stop() temizler', () => {
  const state = store.defaultState();
  state.pairs = {};
  let updates = 0;
  const { engine } = makeEngine({ state, onUpdate: () => { updates++; } });
  engine.start();
  assert.ok(engine.timer);
  assert.ok(updates >= 1);
  engine.stop('test');
  assert.equal(engine.timer, null);
});

test('reschedule: calisiyorsa zamanlayiciyi yeniler, durmusken baslatmaz', () => {
  const state = store.defaultState();
  state.pairs = {};
  const { engine } = makeEngine({ state });
  engine.reschedule();
  assert.equal(engine.timer, null);
  engine.start();
  const first = engine.timer;
  state.settings.pollSeconds = 30;
  engine.reschedule();
  assert.notEqual(engine.timer, first);
  engine.stop('test');
});

test('defaultPaper baslangic bakiyesini uygular, gecersizse 150', () => {
  assert.equal(store.defaultPaper(500).cash, 500);
  assert.equal(store.defaultPaper(500).dayStartEquity, 500);
  assert.equal(store.defaultPaper(-5).cash, 150);
  assert.equal(store.defaultPaper(NaN).cash, 150);
});
