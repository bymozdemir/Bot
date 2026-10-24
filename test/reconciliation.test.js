const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountReconciler, normalizeBalances } = require('../src/reconciliation');

function store() { return { saves: 0, save() { this.saves++; } }; }
function exchange(overrides = {}) {
  return {
    id: 'test',
    capabilities: { balanceQuery: true, openOrdersQuery: true },
    async fetchBalance() { return { USDT: { free: 100, locked: 0 }, BTC: { free: 1, locked: 0 } }; },
    async fetchOpenOrders() { return []; },
    ...overrides
  };
}

test('bakiye normalleştirilir ve toplam hesaplanır', () => {
  assert.deepEqual(normalizeBalances({ USDT: { free: '90', locked: '10' } }), {
    USDT: { free: 90, locked: 10, total: 100 }
  });
});

test('temiz hesap mutabakatı canlı işleme geçişine izin verir', async () => {
  const state = { liveOrders: {} }, st = store();
  const r = await new AccountReconciler({ exchange: exchange(), state, store: st }).reconcile();
  assert.equal(r.safeToTrade, true);
  assert.equal(r.balances.USDT.total, 100);
  assert.equal(r.orphanOpenOrders.length, 0);
  assert.equal(state.liveReconciliation.safeToTrade, true);
});

test('çözülmemiş yerel emir varsa canlı işleme izin vermez', async () => {
  const state = { liveOrders: { c1: { clientOrderId: 'c1', symbol: 'BTC/USDT', status: 'UNKNOWN' } } }, st = store();
  const r = await new AccountReconciler({ exchange: exchange(), state, store: st }).reconcile();
  assert.equal(r.safeToTrade, false);
  assert.equal(r.unknownLocalOrders.length, 1);
});

test('borsadaki tanınmayan açık emir canlı işleme izin vermez', async () => {
  const state = { liveOrders: {} }, st = store();
  const ex = exchange({ async fetchOpenOrders() { return [{ orderId: 77, clientOrderId: 'external', symbol: 'BTCUSDT', side: 'sell', status: 'NEW', executedQty: 0 }]; } });
  const r = await new AccountReconciler({ exchange: ex, state, store: st }).reconcile();
  assert.equal(r.safeToTrade, false);
  assert.equal(r.orphanOpenOrders.length, 1);
});

test('bakiye sorgusu başarısızsa canlı işleme izin verilmez', async () => {
  const state = { liveOrders: {} }, st = store();
  const ex = exchange({ async fetchBalance() { throw new Error('network'); } });
  const r = await new AccountReconciler({ exchange: ex, state, store: st }).reconcile();
  assert.equal(r.safeToTrade, false);
  assert.match(r.errors[0], /network/);
});

test('açık emir sorgusu desteklenmiyorsa güvenli geçiş reddedilir', async () => {
  const state = { liveOrders: {} }, st = store();
  const ex = exchange({ capabilities: { balanceQuery: true, openOrdersQuery: false } });
  const r = await new AccountReconciler({ exchange: ex, state, store: st }).reconcile();
  assert.equal(r.safeToTrade, false);
  assert.match(r.errors[0], /Açık emir sorgulama/);
});


test('kendi açık koruyucu stop emri mutabakatı bozmaz', async () => {
  const state = { liveOrders: { stop1: { clientOrderId: 'stop1', exchangeOrderId: 9, symbol: 'BTC/USDT', status: 'NEW' } } }, st = store();
  const ex = exchange({ async fetchOpenOrders() { return [{ orderId: 9, clientOrderId: 'stop1', symbol: 'BTCUSDT', side: 'sell', status: 'NEW', executedQty: 0 }]; } });
  const r = await new AccountReconciler({ exchange: ex, state, store: st }).reconcile();
  assert.equal(r.safeToTrade, true);
  assert.equal(r.unknownLocalOrders.length, 0);
});

test('yerel pozisyon borsadaki base bakiyeden büyükse güvenli geçiş reddedilir', async () => {
  const state = {
    liveOrders: {},
    live: { positions: { 'BTC/USDT': { symbol: 'BTC/USDT', quantity: 2 } } },
    pairs: { 'BTC/USDT': {} }
  }, st = store();
  const ex = exchange({ async fetchBalance() { return { USDT: { free: 100, locked: 0 }, BTC: { free: 1, locked: 0 } }; } });
  const r = await new AccountReconciler({ exchange: ex, state, store: st }).reconcile();
  assert.equal(r.safeToTrade, false);
  assert.equal(r.balanceMismatches[0].reason, 'position_balance_shortfall');
});

test('borsadaki yönetilen varlık yerel pozisyondan fazla ise güvenli geçiş reddedilir', async () => {
  const state = {
    liveOrders: {},
    live: { positions: { 'BTC/USDT': { symbol: 'BTC/USDT', quantity: 1, costQuote: 100 } } },
    pairs: { 'BTC/USDT': {} }
  };
  const st = store();
  const ex = exchange({ async fetchBalance() { return { USDT: { free: 100, locked: 0 }, BTC: { free: 2, locked: 0 } }; } });
  const r = await new AccountReconciler({ exchange: ex, state, store: st }).reconcile();
  assert.equal(r.safeToTrade, false);
  assert.ok(r.balanceMismatches.some((x) => x.reason === 'unexpected_asset_balance'));
});

test('bozuk yerel pozisyon quantity/costQuote verisi canlı geçişi engeller', async () => {
  const { AccountReconciler } = require('../src/reconciliation');
  const ex = {
    id:'test', capabilities:{openOrdersQuery:true},
    async fetchBalance(){ return { USDT:{free:1000,locked:0}, BTC:{free:1,locked:0} }; },
    async fetchOpenOrders(){ return []; }
  };
  const state = {
    pairs:{'BTC/USDT':{}},
    live:{positions:{'BTC/USDT':{symbol:'BTC/USDT',quantity:NaN,costQuote:100}},},
    liveOrders:{}
  };
  const store = { save(){} };
  const r = await new AccountReconciler({exchange:ex,state,store}).reconcile();
  assert.equal(r.safeToTrade, false);
  assert.ok(r.balanceMismatches.some(x => x.reason === 'invalid_local_position'));
});

test('recovery: açık pozisyonun borsada olmayan koruyucu stopu canlı kapısını kapatır', async () => {
  const { SimulatedExchange } = require('../src/simulatedExchange');
  const ex = new SimulatedExchange({ startingQuote: 900, prices: { 'BTC/USDT': 100 } });
  ex.balances.BTC = { free: 1, locked: 0 };
  const state = {
    liveOrders: {
      'stop-closed': { clientOrderId: 'stop-closed', exchangeOrderId: 77, symbol: 'BTC/USDT', side: 'sell', status: 'CANCELED', meta: { role: 'protective-stop' } }
    },
    live: { positions: { 'BTC/USDT': { symbol: 'BTC/USDT', quantity: 1, costQuote: 100, stopOrderId: 'stop-closed' } } }
  };
  const store = { save() {} };
  const rec = new AccountReconciler({ exchange: ex, state, store });
  const r = await rec.reconcile();
  assert.equal(r.safeToTrade, false);
  assert.ok(r.errors.some((e) => e.includes('Koruyucu stop açık değil')));
});

test('recovery: açık pozisyon + canlı stop birlikteyken güvenli kalır', async () => {
  const { SimulatedExchange } = require('../src/simulatedExchange');
  const ex = new SimulatedExchange({ startingQuote: 900, prices: { 'BTC/USDT': 100 } });
  ex.balances.BTC = { free: 1, locked: 0 };
  ex.orders.set('stop-open', { orderId: 77, clientOrderId: 'stop-open', symbol: 'BTC/USDT', side: 'sell', status: 'NEW', executedQty: 0, origQty: 1, stopPrice: 95, price: 94.5 });
  const state = {
    liveOrders: {
      'stop-open': { clientOrderId: 'stop-open', exchangeOrderId: 77, symbol: 'BTC/USDT', side: 'sell', status: 'NEW', meta: { role: 'protective-stop' } }
    },
    live: { positions: { 'BTC/USDT': { symbol: 'BTC/USDT', quantity: 1, costQuote: 100, stopOrderId: 'stop-open' } } }
  };
  const store = { save() {} };
  const rec = new AccountReconciler({ exchange: ex, state, store });
  const r = await rec.reconcile();
  assert.equal(r.safeToTrade, true);
});

test('boş, yanlış biçimli veya negatif borsa bakiyesi fail-closed reddedilir', () => {
  for (const value of [null, undefined, '100', [], { USDT: null }, { USDT: { free: -1, locked: 2 } }, { USDT: { free: 1, locked: -2 } }, { USDT: { free: Number.MAX_VALUE, locked: Number.MAX_VALUE } }]) {
    assert.throws(() => normalizeBalances(value), /bakiye|Bakiye|Geçersiz/);
  }
});


test('bozuk açık emir kaydı mutabakatı güvenli sayamaz', async () => {
  const state = { liveOrders: {} }, st = store();
  const ex = exchange({ async fetchOpenOrders() { return [{ symbol: 'BTC/USDT', side: 'sell', status: 'NEW' }]; } });
  const r = await new AccountReconciler({ exchange: ex, state, store: st }).reconcile();
  assert.equal(r.safeToTrade, false);
  assert.ok(r.errors.some((e) => e.includes('kimlik/sembol/durum doğrulamasını')));
});

test('NaN veya negatif yerel dust bakiyesi mutabakatı güvenli sayamaz', async () => {
  for (const dust of [NaN, Infinity, -0.1, 'not-a-number']) {
    const state = { liveOrders: {}, pairs: { 'BTC/USDT': {} }, live: { positions: {}, dustByAsset: { BTC: dust } } };
    const ex = exchange({ async fetchBalance() { return { USDT: { free: 100, locked: 0 }, BTC: { free: 0, locked: 0 } }; } });
    const r = await new AccountReconciler({ exchange: ex, state, store: store() }).reconcile();
    assert.equal(r.safeToTrade, false, `dust=${String(dust)}`);
    assert.ok(r.balanceMismatches.some((m) => m.reason === 'invalid_local_dust'));
  }
});
