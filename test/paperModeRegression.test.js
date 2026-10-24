const test = require('node:test');
const assert = require('node:assert/strict');
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');

function candles(price, t = 1000) {
  return Array.from({ length: 3 }, (_, i) => ({ t: t + i * 3600000, o: price, h: price, l: price, c: price, v: 1 }));
}

function make(state, exchange, nowFn) {
  const engine = new PaperEngine({ exchange, store: { save() {} }, state, nowFn: nowFn || (() => Date.now()) });
  engine.log = () => {};
  return engine;
}

test('paper aktif quote, exchange.quoteAssets siralamasindan bagimsiz settings.quoteAsset olur', () => {
  const state = store.defaultState();
  state.settings.quoteAsset = 'USDT';
  const engine = make(state, { quoteAssets: ['TRY', 'USDT'] });
  assert.equal(engine.quoteLabel, 'USDT');
  assert.equal(engine.pairSupported('BTC/USDT'), true);
  assert.equal(engine.pairSupported('BTC/TRY'), false);
});

test('paper TRY/USDT baslangic kasalarini birbirine kopyalamaz', () => {
  const state = store.defaultState();
  state.settings.quoteAsset = 'USDT';
  state.paper.cash = 150;
  state.paper.cashByAsset = { USDT: 150 };
  const engine = make(state, { quoteAssets: ['TRY', 'USDT'] });
  engine.ensureState();
  assert.equal(engine.cashFor('USDT'), 150);
  assert.equal(engine.cashFor('TRY'), 0);
  assert.equal(state.paper.dayStartEquityByAsset.USDT, 150);
});

test('paper yeni gunde day-start equity ilk yeni gun fiyatlariyla sabitlenir', async () => {
  const state = store.defaultState();
  state.running = true;
  state.settings.dailyLossLimitPct = 5;
  state.settings.killSwitchLossPct = 0;
  state.paper.cash = 50;
  state.paper.cashByAsset = { USDT: 50 };
  state.paper.dayKey = '2000-01-01';
  state.paper.dayStartEquity = 150;
  state.paper.dayStartEquityByAsset = { USDT: 150 };
  state.paper.lastPrices = { 'BTC/USDT': 100 };
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quoteAsset: 'USDT', entryPrice: 100, quantity: 1, costQuote: 100, stopPrice: null, highWaterMark: 100 };
  state.pairs = { 'BTC/USDT': { symbol: 'BTC/USDT', enabled: false, strategyId: 'rsi_simple', timeframe: '1h', budgetPct: 30, params: { stopLossPct: 3, takeProfitPct: 1, trailingStop: false } } };
  const now = Date.UTC(2026, 9, 1, 1, 0);
  const engine = make(state, {
    quoteAssets: ['TRY', 'USDT'],
    fetchCandles: async () => candles(80, now - 2 * 3600000)
  }, () => now);
  await engine.tick();
  const expectedDayStart = 50 + 80 * (1 - state.settings.paperSlippagePct / 100) * (1 - state.settings.paperFeePct / 100);
  assert.ok(Math.abs(state.paper.dayStartEquity - expectedDayStart) < 1e-9); // tahmini tasfiye ozkaynak: komisyon + kayma dahil
  assert.equal(state.running, true); // 130 yeni gun baslangici; -%5 degil
});

test('paper yeni gunde ilk alim eski gunun dayStart degerini kullanmaz', async () => {
  const strategies = require('../src/strategies');
  const state = store.defaultState();
  state.running = true;
  state.settings.dailyLossLimitPct = 100;
  state.settings.killSwitchLossPct = 0;
  state.settings.reserveCashPct = 0;
  state.settings.maxConcurrentPositions = 3;
  state.paper.cash = 50;
  state.paper.cashByAsset = { USDT: 50 };
  state.paper.dayKey = '2000-01-01';
  state.paper.dayStartEquity = 150;
  state.paper.dayStartEquityByAsset = { USDT: 150 };
  state.paper.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quoteAsset: 'USDT', entryPrice: 100, quantity: 1, costQuote: 100, stopPrice: 97, highWaterMark: 100, checkedThroughT: 0 };
  state.pairs = {
    'BTC/USDT': { symbol: 'BTC/USDT', enabled: false, strategyId: 'rsi_simple', timeframe: '1h', budgetPct: 30, params: { stopLossPct: 3, takeProfitPct: 1, trailingStop: false } },
    'ETH/USDT': { symbol: 'ETH/USDT', enabled: true, strategyId: 'rsi_simple', timeframe: '1h', budgetPct: 30, params: { stopLossPct: 3, takeProfitPct: 1, trailingStop: false } }
  };
  const original = strategies.registry.rsi_simple;
  strategies.registry.rsi_simple = { ...original, evaluate: () => ({ action: 'buy', reason: 'test buy' }) };
  const now = Date.UTC(2026, 9, 1, 1, 0);
  const mk = (price) => Array.from({ length: 3 }, (_, i) => ({ t: now - 2 * 3600000 + i * 3600000, o: price, h: price, l: price, c: price, v: 1 }));
  const engine = make(state, {
    quoteAssets: ['USDT'],
    fetchCandles: async (symbol) => mk(symbol === 'BTC/USDT' ? 80 : 100),
    fetchSymbolRules: async () => ({ minNotional: 1, stepSize: 0, minQty: 0 })
  }, () => now);
  try {
    await engine.tick();
  } finally {
    strategies.registry.rsi_simple = original;
  }
  const expectedDayStart = 50 + 80 * (1 - state.settings.paperSlippagePct / 100) * (1 - state.settings.paperFeePct / 100);
  assert.ok(Math.abs(state.paper.dayStartEquity - expectedDayStart) < 1e-9);
  assert.ok(state.paper.positions['ETH/USDT']);
  assert.ok(Math.abs(state.paper.positions['ETH/USDT'].costQuote - expectedDayStart * 0.3) < 1e-9, `cost=${state.paper.positions['ETH/USDT'].costQuote}`);
});

test('paper budgetPct ortak gunluk equity hedefidir; 30/30/30 siraya bagli olarak 30/21/14.7 olmaz', async () => {
  const state = store.defaultState();
  state.paper = store.defaultPaper(1000);
  state.settings.maxTradeQuote = 0; // bu test yalniz budgetPct dagilimini olcer, islem ust tutarini degil
  state.settings.reserveCashPct = 10;
  state.settings.maxConcurrentPositions = 3;
  const engine = make(state, { quoteAssets: ['USDT'], fetchSymbolRules: async () => ({ minNotional: 1, stepSize: 0, minQty: 0 }) });
  const pair = { enabled: true, strategyId: 'rsi_simple', budgetPct: 30, params: { stopLossPct: 3, takeProfitPct: 6, trailingStop: false } };
  const params = pair.params;
  await engine.tryBuy('BTC/USDT', pair, { reason: 't' }, params, 100, 1);
  await engine.tryBuy('ETH/USDT', pair, { reason: 't' }, params, 100, 1);
  await engine.tryBuy('SOL/USDT', pair, { reason: 't' }, params, 100, 1);
  const costs = ['BTC/USDT','ETH/USDT','SOL/USDT'].map(s => state.paper.positions[s].costQuote);
  assert.ok(costs.every(v => Math.abs(v - 300) < 1e-9), `costs=${costs.join(',')}`);
  assert.ok(Math.abs(state.paper.cash - 100) < 1e-9, `cash=${state.paper.cash}`);
});

test('paper trailing stop %6 aktivasyonundan once break-even tabanini zorla uygulamaz', () => {
  const state = store.defaultState();
  const engine = make(state, { quoteAssets: ['USDT'] });
  const pos = { entryPrice: 100, highWaterMark: 105, stopPrice: 97 };
  engine.syncProtectionStop(pos, { stopLossPct: 3, takeProfitPct: 6, trailingStop: true });
  assert.ok(Math.abs(pos.stopPrice - 101.85) < 1e-9, `stop=${pos.stopPrice}`);
});

test('paper profit protection stopPrice state ile motorun efektif stop seviyesini esler', () => {
  const state = store.defaultState();
  const engine = make(state, { quoteAssets: ['USDT'] });
  const pos = { entryPrice: 100, highWaterMark: 106, stopPrice: 97 };
  engine.syncProtectionStop(pos, { stopLossPct: 3, takeProfitPct: 6, trailingStop: false });
  assert.ok(Math.abs(pos.stopPrice - 102.82) < 1e-9, `stop=${pos.stopPrice}`);
});

test('paper quote değişimi başka kasadaki parayı kopyalamaz ve geçersiz TRY risk tabanıyla bot başlamaz', () => {
  const state = store.defaultState();
  state.paper.cash = 150;
  state.paper.cashByAsset = { USDT: 150 };
  state.paper.dayStartEquityByAsset = { USDT: 150 };
  state.settings.quoteAsset = 'TRY';
  const engine = make(state, { quoteAssets: ['TRY', 'USDT'] });
  engine.ensureState();
  assert.equal(engine.cashFor('TRY'), 0);
  assert.equal(engine.cashFor('USDT'), 150);
  assert.equal(state.paper.dayStartEquityByAsset.TRY, 0);
  assert.match(engine.riskBaselineError(), /başlangıç risk tabanı/);
  assert.throws(() => engine.start(), /Paper bot başlatılmadı:.*başlangıç risk tabanı/);
  assert.equal(state.running, false);
  assert.equal(engine.timer, null);

  state.settings.quoteAsset = 'USDT';
  const engine2 = make(state, { quoteAssets: ['TRY', 'USDT'] });
  engine2.ensureState();
  assert.equal(engine2.cashFor('USDT'), 150);
  assert.equal(engine2.cashFor('TRY'), 0);
  assert.equal(engine2.riskBaselineError(), '');
});

test('paper sıfır TRY öz sermayesi ve eski pozitif risk tabanlarıyla başlamaz', () => {
  const state = store.defaultState();
  state.settings.quoteAsset = 'TRY';
  state.paper.cash = 0;
  state.paper.cashByAsset = { TRY: 0, USDT: 150 };
  state.paper.startingBalanceByAsset = { TRY: 150, USDT: 150 };
  state.paper.dayStartEquityByAsset = { TRY: 150, USDT: 150 };
  state.paper.positions = {};

  const engine = make(state, { quoteAssets: ['TRY', 'USDT'] });

  assert.equal(engine.cashFor('TRY'), 0);
  assert.match(engine.riskBaselineError(), /mevcut öz sermaye/);
  assert.throws(
    () => engine.start(),
    /Paper bot başlatılmadı:.*mevcut öz sermaye/
  );
  assert.equal(state.running, false);
  assert.equal(engine.timer, null);
});

test('paper geçerli başlangıç bakiyesi olsa da sıfır günlük risk tabanıyla başlamaz', () => {
  const state = store.defaultState();
  state.settings.quoteAsset = 'USDT';
  state.paper.startingBalanceByAsset = { USDT: 150 };
  state.paper.dayStartEquityByAsset = { USDT: 0 };
  const engine = make(state, { quoteAssets: ['USDT'] });
  assert.match(engine.riskBaselineError(), /günlük risk tabanı/);
  assert.throws(() => engine.start(), /Paper bot başlatılmadı:.*günlük risk tabanı/);
  assert.equal(state.running, false);
  assert.equal(engine.timer, null);
});

test('paper gün değişiminde sıfır equity günlük risk tabanını sıfırlamaz', () => {
  const state = store.defaultState();
  state.settings.quoteAsset = 'USDT';
  state.paper.cash = 0;
  state.paper.cashByAsset = { USDT: 0 };
  state.paper.startingBalanceByAsset = { USDT: 150 };
  state.paper.dayStartEquity = 150;
  state.paper.dayStartEquityByAsset = { USDT: 150 };
  state.paper.dayKey = '2000-01-01';
  const engine = make(state, { quoteAssets: ['USDT'] }, () => Date.UTC(2026, 9, 12, 12));
  engine.rolloverDayIfNeeded(0);
  assert.equal(state.paper.dayKey, '2000-01-01');
  assert.equal(state.paper.dayStartEquityByAsset.USDT, 150);
});


test('paper: acik pozisyon verisi izlenemiyorsa yeni pozisyon acilmaz', async () => {
  const state = store.defaultState();
  state.settings.quoteAsset = 'USDT';
  state.paper.cash = 150;
  state.paper.cashByAsset = { USDT: 150 };
  const engine = make(state, { quoteAssets: ['USDT'] });
  engine.entryPauseReason = 'açık pozisyon için piyasa verisi alınamadı';
  const beforeCash = engine.cashFor('USDT');
  await engine.tryBuy(
    'ETH/USDT',
    { symbol: 'ETH/USDT', enabled: true, budgetPct: 30, strategyId: 'rsi_simple' },
    { action: 'buy', reason: 'test' },
    { stopLossPct: 3, takeProfitPct: 6, trailingStop: false },
    100,
    123,
    engine.epoch
  );
  assert.equal(engine.cashFor('USDT'), beforeCash);
  assert.equal(state.paper.positions['ETH/USDT'], undefined);
});
