const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderManager } = require('../src/orderManager');

function memStore() { return { save() {} }; }

function makeManager() {
  const state = { liveOrders: {
    'mc-1': {
      clientOrderId: 'mc-1', symbol: 'BTC/USDT', side: 'buy', status: 'NEW',
      executedQty: 0, quoteQty: 0, commission: { total: 0, byAsset: {} },
      commissionByAsset: {}, seenExecutionIds: []
    }
  }};
  const exchange = { capabilities: { clientOrderId: true, orderQuery: true } };
  return { om: new OrderManager({ exchange, state, store: memStore() }), state };
}

function event(x) {
  return {
    e:'executionReport', c:'mc-1', i:77, s:x.s || 'BTCUSDT', S:'BUY',
    X:x.X, z:String(x.z), Z:String(x.Z), q:'1', I:x.I, E:x.E, N:x.N || 'USDT', n:String(x.n || 0)
  };
}

function oracleStatus(events) {
  let status = 'NEW';
  let qty = 0;
  for (const e of events) {
    const next = e.X;
    const q = Number(e.z);
    if (q > qty) {
      qty = q;
      if (next === 'FILLED') status = 'FILLED';
      else if (status !== 'FILLED' && (next === 'PARTIALLY_FILLED' || next === 'NEW')) status = next;
      else if (status === 'NEW' && next === 'CANCELED') status = 'CANCELED';
    } else {
      if (status !== 'FILLED' && next === 'FILLED') status = 'FILLED';
      else if (status === 'NEW' && (next === 'CANCELED' || next === 'EXPIRED' || next === 'REJECTED')) status = next;
    }
  }
  return { status, qty };
}

function permute(arr) {
  const out = [];
  function rec(prefix, rest) {
    if (!rest.length) { out.push(prefix); return; }
    for (let i=0;i<rest.length;i++) rec(prefix.concat(rest[i]), rest.slice(0,i).concat(rest.slice(i+1)));
  }
  rec([], arr);
  return out;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (1664525*s + 1013904223) >>> 0) / 4294967296);
}

test('model checker: tüm 6 olay permütasyonlarında miktar/durum/komisyon monotonluğu korunur', () => {
  const base = [
    event({X:'PARTIALLY_FILLED', z:.2, Z:20, I:1, E:1000, n:.002}),
    event({X:'PARTIALLY_FILLED', z:.6, Z:60, I:2, E:1100, n:.004}),
    event({X:'FILLED', z:1, Z:100, I:3, E:1200, n:.006}),
    event({X:'PARTIALLY_FILLED', z:.6, Z:60, I:2, E:1100, n:.004}),
    event({X:'NEW', z:0, Z:0, I:4, E:900, n:0}),
    event({X:'FILLED', z:1, Z:100, I:3, E:1200, n:.006})
  ];
  for (const p of permute(base)) {
    const {om,state} = makeManager();
    for (const e of p) om.applyExecutionReport(e);
    const o = state.liveOrders['mc-1'];
    const oracle = oracleStatus(p);
    assert.equal(o.status, oracle.status);
    assert.equal(o.executedQty, oracle.qty);
    assert.equal(o.quoteQty, Math.max(...p.map(e => Number(e.Z))));
    assert.equal(o.commissionByAsset.USDT, .012);
    assert.equal(o.seenExecutionIds.length, 4);
  }
});

test('model checker: 20000 rastgele olay sırası ve duplicate kombinasyonu', () => {
  const r = rng(0xC0FFEE);
  const statuses = ['NEW','PARTIALLY_FILLED','PARTIALLY_FILLED','FILLED','CANCELED'];
  for (let trial=0; trial<20000; trial++) {
    const events = [];
    let maxQty = 0, maxQuote = 0;
    const unique = new Map();
    const count = 4 + Math.floor(r()*9);
    for (let i=0;i<count;i++) {
      const id = 1 + Math.floor(r()*7);
      const q = id === 7 ? 1 : Number((r()*0.95).toFixed(6));
      const z = Math.max(maxQty, q);
      const Z = Math.max(maxQuote, z*100);
      const X = statuses[Math.floor(r()*statuses.length)];
      const n = Number(((id * 0.0007) % 0.01).toFixed(6));
      const e = event({X,z,Z,I:id,E:Math.floor(r()*100000),n});
      events.push(e);
      maxQty = Math.max(maxQty,z); maxQuote = Math.max(maxQuote,Z);
      unique.set(String(id), n);
    }
    // Shuffle without changing the underlying event set.
    for (let i=events.length-1;i>0;i--) { const j=Math.floor(r()*(i+1)); [events[i],events[j]]=[events[j],events[i]]; }
    const {om,state} = makeManager();
    for (const e of events) om.applyExecutionReport(e);
    const o = state.liveOrders['mc-1'];
    assert.ok(Number.isFinite(o.executedQty) && o.executedQty >= 0);
    assert.ok(Number.isFinite(o.quoteQty) && o.quoteQty >= 0);
    assert.equal(o.executedQty, maxQty);
    assert.equal(o.quoteQty, maxQuote);
    const expectedCommission = [...unique.values()].reduce((a,b)=>a+b,0);
    assert.ok(Math.abs(o.commissionByAsset.USDT - expectedCommission) < 1e-12);
    assert.equal(new Set(o.seenExecutionIds).size, o.seenExecutionIds.length);
    assert.ok(['NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','REJECTED'].includes(o.status));
  }
});
