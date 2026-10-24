const test = require('node:test');
const assert = require('node:assert/strict');
const { roundDownToStep } = require('../src/execution');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');

function rng(seed) {
  let x = seed >>> 0;
  return () => (x = Math.imul(1664525, x) + 1013904223 >>> 0) / 4294967296;
}

function makeEngine({ balance = 100000, rules, maxTradeQuote = 1000, budgetPct = 100, price = 100 } = {}) {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.settings.maxConcurrentPositions = 1;
  state.settings.reserveCashPct = 0;
  state.settings.maxTradeQuote = maxTradeQuote;
  state.settings.dailyLossLimitPct = 100;
  state.settings.killSwitchLossPct = 100;
  state.live.safeToTrade = true;
  const calls = { market: 0, stop: 0, amount: null };
  const exchange = {
    id: 'test', name: 'Test', quoteAssets: ['USDT'],
    async fetchBalance() { return { USDT: { free: balance, locked: 0, total: balance } }; },
    async fetchSymbolRules() { return rules; },
  };
  const orderManager = {
    async submitMarket({ amount }) {
      calls.market++; calls.amount = amount;
      return { status: 'FILLED', clientOrderId: `buy-${calls.market}`, executedQty: amount, quoteQty: amount * price };
    },
    async submitStop({ amount }) {
      calls.stop++;
      return { status: 'NEW', clientOrderId: `stop-${calls.stop}`, executedQty: 0 };
    },
    get(clientOrderId) { return { status: 'NEW', clientOrderId, executedQty: 0 }; }
  };
  const engine = new LiveEngine({ exchange, state, store: { save() {} }, orderManager, allowLive: true });
  return { engine, state, calls, pairCfg: { budgetPct }, price };
}

test('price shock: 10,000 rastgele fiyat/step kombinasyonunda miktar maxTradeQuote ve maxQtyyi asmaz', () => {
  const next = rng(0xC0FFEE);
  const steps = [1e-8, 1e-7, 1e-6, 0.000001, 0.00001, 0.0001, 0.001, 0.01, 0.1, 1, 5, 10];
  for (let i = 0; i < 10000; i++) {
    const price = 10 ** (-8 + next() * 16);
    const spend = 10 ** (-4 + next() * 8);
    const step = steps[Math.floor(next() * steps.length)];
    const maxQty = 10 ** (-4 + next() * 8);
    const raw = Math.min(spend / price, maxQty);

    const qty = roundDownToStep(raw, step);
    assert.ok(Number.isFinite(qty) && qty >= 0);
    assert.ok(qty <= raw + Math.max(step, 1e-15));
    assert.ok(qty <= maxQty || raw <= maxQty + step || qty === 0 || qty <= maxQty + step);
    assert.ok(qty * price <= spend + Math.max(price * step, 1e-12));
  }
});

test('live buy: çok yüksek fiyat/çok düşük fiyat miktarı güvenli şekilde sınırlar', async () => {
  for (const price of [1e-8, 0.000001, 0.01, 1, 100, 100000, 1e8]) {
    const rules = { stepSize: 0.001, marketStepSize: 0.001, minQty: 0.001, marketMinQty: 0.001, maxQty: 1000, marketMaxQty: 1000, minNotional: 10, tickSize: 0.01 };
    const { engine, state, calls, pairCfg } = makeEngine({ rules, price, maxTradeQuote: 100 });
    // Üçüncü taraf komisyonu olmadan BUY sonucu doğrudan stop kurulumuna kadar gider.
    await engine.buy('BTC/USDT', pairCfg, { stopLossPct: 5 }, price, 'shock', engine.epoch);
    if (calls.market) {
      assert.ok(calls.amount <= 1000 + 1e-12);
      assert.ok(calls.amount * price <= 100 + Math.max(price * rules.marketStepSize, 1e-9));
      assert.ok(state.live.positions['BTC/USDT']);
    }
  }
});

test('live buy: minNotional ile maxTradeQuote çelişirse emir gönderilmez', async () => {
  const rules = { stepSize: 0.001, marketStepSize: 0.001, minQty: 0.001, marketMinQty: 0.001, maxQty: 1000, marketMaxQty: 1000, minNotional: 10, tickSize: 0.01 };
  const { engine, calls } = makeEngine({ rules, price: 100, maxTradeQuote: 5 });
  await engine.buy('BTC/USDT', { budgetPct: 100 }, { stopLossPct: 5 }, 100, 'conflict', engine.epoch);
  assert.equal(calls.market, 0);
});

test('live buy: MARKET_LOT_SIZE maxQty aşılırsa emir gönderilmez', async () => {
  const rules = { stepSize: 0.001, marketStepSize: 0.001, minQty: 0.001, marketMinQty: 0.001, maxQty: 1000, marketMaxQty: 0.5, minNotional: 10, tickSize: 0.01 };
  const { engine, calls } = makeEngine({ rules, price: 10, maxTradeQuote: 100 });
  await engine.buy('BTC/USDT', { budgetPct: 100 }, { stopLossPct: 5 }, 10, 'maxqty', engine.epoch);
  assert.equal(calls.market, 0);
});

test('live buy: fiyat geçersizse emir gönderilmez', async () => {
  const rules = { stepSize: 0.001, marketStepSize: 0.001, minQty: 0.001, marketMinQty: 0.001, maxQty: 1000, marketMaxQty: 1000, minNotional: 10, tickSize: 0.01 };
  for (const price of [0, -1, NaN, Infinity, -Infinity]) {
    const { engine, calls } = makeEngine({ rules, price: 100, maxTradeQuote: 100 });
    await engine.buy('BTC/USDT', { budgetPct: 100 }, { stopLossPct: 5 }, price, 'badprice', engine.epoch);
    assert.equal(calls.market, 0, `price=${price}`);
  }
});
