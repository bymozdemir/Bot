const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { intrabarRiskExit, roundDownToStep } = require('../src/execution');
const { SimulatedExchange } = require('../src/simulatedExchange');
const { OrderManager, TERMINAL } = require('../src/orderManager');
const { AccountReconciler } = require('../src/reconciliation');
const { LiveRecovery } = require('../src/liveRecovery');

function mulberry32(seed) {
  return function rand() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function candles(seed, n = 240) {
  const r = mulberry32(seed);
  let p = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const shock = (r() - 0.5) * 0.12;
    const o = p;
    const c = Math.max(0.01, o * (1 + shock));
    const h = Math.max(o, c) * (1 + r() * 0.025);
    const l = Math.min(o, c) * (1 - r() * 0.025);
    out.push({ t: i * 3600000, o, h, l, c, v: 1000 + r() * 10000 });
    p = c;
  }
  return out;
}

test('stres testi: 5 strateji x 100 rastgele piyasa serisi NaN/exception üretmez', () => {
  for (const s of strategies.list()) {
    const strategy = strategies.get(s.id);
    const params = { ...strategy.defaultParams };
    assert.equal(strategies.validateParams(s.id, params), null);
    for (let seed = 1; seed <= 100; seed++) {
      const cs = candles(seed * 997 + s.id.length);
      for (let i = Math.max(50, strategy.warmup || 50); i < cs.length; i++) {
        const pos = i % 37 === 0 ? { entryPrice: cs[i - 1].c, highWaterMark: cs[i - 1].c, stopPrice: cs[i - 1].c * 0.95 } : null;
        const d = strategy.evaluate({ candles: cs.slice(0, i + 1), position: pos, params });
        assert.ok(['buy', 'sell', 'hold'].includes(d.action), `${s.id} seed=${seed} action=${d.action}`);
      }
    }
  }
});

test('risk stres testi: 50000 rastgele mumda stop hesapları sonlu kalır', () => {
  const r = mulberry32(123456);
  const pos = { entryPrice: 100, highWaterMark: 100, stopPrice: 95 };
  const params = { trailingStop: true, stopLossPct: 5, takeProfitPct: 20 };
  for (let i = 0; i < 50000; i++) {
    const center = Math.max(0.01, 100 * Math.exp((r() - 0.5) * 4));
    const o = center * (0.9 + r() * 0.2);
    const h = Math.max(o, center) * (1 + r() * 0.1);
    const l = Math.max(0.000001, Math.min(o, center) * (1 - r() * 0.1));
    const result = intrabarRiskExit(pos, { o, h, l, c: center }, params, true);
    assert.ok(Number.isFinite(pos.highWaterMark));
    if (result) assert.ok(Number.isFinite(result.ref) && result.ref > 0);
  }
});

test('yuvarlama stres testi: step kurallarında miktar negatif/NaN olmaz ve step altına çıkmaz', () => {
  const steps = [1, 0.1, 0.01, 0.001, 0.000001, 0.00001, 0.25];
  const r = mulberry32(42);
  for (const step of steps) {
    for (let i = 0; i < 10000; i++) {
      const q = r() * 1e9;
      const x = roundDownToStep(q, step);
      assert.ok(Number.isFinite(x) && x >= 0);
      assert.ok(x <= q + Math.max(1e-8, Math.abs(q) * 1e-15));
      const units = Math.round(x / step);
      assert.ok(Math.abs(x - units * step) <= Math.max(1e-8, Math.abs(x) * 1e-15, step * 1e-8));
    }
  }
});

test('fault injection: bilinmeyen market sonucu sonrası recovery ikinci emir göndermez', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const state = { liveOrders: {}, liveReconciliation: null, liveRecovery: null };
  const store = { save: () => {} };
  const om = new OrderManager({ exchange: ex, state, store });
  ex.setFailure({ kind: 'market', unknownOutcome: true, httpStatus: 500, message: 'simulated 500' });
  const first = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'fault-1' });
  assert.equal(first.status, 'UNKNOWN');
  const second = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'fault-1' });
  assert.equal(second.reused, true);
  assert.equal(ex.orders.size, 0);
});

test('fault injection: balance/openOrders arızasında recovery güvenli geçişi reddeder', async () => {
  const ex = new SimulatedExchange({ startingQuote: 1000, prices: { 'BTC/USDT': 100 } });
  const state = { liveOrders: {}, liveReconciliation: null, liveRecovery: null };
  const store = { save: () => {} };
  const om = new OrderManager({ exchange: ex, state, store });
  const rec = new AccountReconciler({ exchange: ex, state, store });
  const recovery = new LiveRecovery({ orderManager: om, reconciler: rec, state, store });
  ex.setFailure({ kind: 'balance', message: 'balance down' });
  const r1 = await recovery.recover();
  assert.equal(r1.safeToTrade, false);
  ex.setFailure({ kind: 'openOrders', message: 'orders down' });
  const r2 = await recovery.recover();
  assert.equal(r2.safeToTrade, false);
});

test('finansal muhasebe stres testi: 10000 rastgele alış/satış ve komisyon kombinasyonu sonlu ve tutarlı', () => {
  const { netBaseReceived, netQuoteFlow, realizedPnl, proportionalCostBasis } = require('../src/financial');
  const r = mulberry32(987654321);
  const assets = ['USDT', 'BTC', 'BNB'];
  for (let i = 0; i < 10000; i++) {
    const grossQty = 0.000001 + r() * 100;
    const grossQuote = grossQty * (1 + r() * 100000);
    const side = r() < 0.5 ? 'buy' : 'sell';
    const baseFee = r() * grossQty * 0.005;
    const quoteFee = r() * grossQuote * 0.002;
    const thirdFee = r() * 0.01;
    const commission = { total: baseFee + quoteFee + thirdFee, byAsset: { BTC: baseFee, USDT: quoteFee, BNB: thirdFee } };
    const netBase = netBaseReceived(side, grossQty, 'BTC', commission);
    const netQuote = netQuoteFlow(side, grossQuote, 'USDT', commission);
    assert.ok(Number.isFinite(netBase) && netBase >= 0);
    assert.ok(Number.isFinite(netQuote) && netQuote >= 0);
    if (side === 'buy') assert.ok(netBase <= grossQty + 1e-12);
    if (side === 'sell') assert.equal(netBase, grossQty);

    const position = { quantity: grossQty, costQuote: grossQuote * (0.5 + r()) };
    const sold = grossQty * r();
    const basis = proportionalCostBasis(position, sold);
    const pnl = realizedPnl(position, sold, netQuote * r());
    assert.ok(Number.isFinite(basis) && basis >= 0 && basis <= position.costQuote + 1e-9);
    assert.ok(Number.isFinite(pnl.pnl));
    assert.ok(Math.abs(pnl.costBasis - basis) < 1e-12 * Math.max(1, basis));
  }
  assert.deepEqual(assets, ['USDT', 'BTC', 'BNB']);
});

test('fault injection: borsa emri gerçekten uygulayıp 5xx dönerse recovery emri tekrar göndermez', async () => {
  const ex = new SimulatedExchange({ startingQuote:1000, prices:{'BTC/USDT':100} });
  const state = { liveOrders:{} };
  const store = { save(){} };
  const om = new OrderManager({exchange:ex,state,store});
  ex.setFailure({kind:'market', executeBeforeError:true, unknownOutcome:true, httpStatus:500, message:'executed then 500'});
  const first = await om.submitMarket({symbol:'BTC/USDT',side:'buy',amount:1,clientOrderId:'exec-then-500'});
  assert.equal(first.status,'UNKNOWN');
  assert.equal(ex.balances.USDT.free,900);
  assert.equal(ex.balances.BTC.free,1);
  const reconciled = await om.reconcile('exec-then-500');
  assert.equal(reconciled.status,'FILLED');
  assert.equal(ex.orders.size,1);
  assert.equal(ex.balances.USDT.free,900);
  assert.equal(ex.balances.BTC.free,1);
});

test('fault injection: stop emri yaratılıp cevap kaybolursa tekrar stop oluşturulmaz', async () => {
  const ex = new SimulatedExchange({startingQuote:1000, prices:{'BTC/USDT':100}});
  const state = {liveOrders:{}};
  const store={save(){}};
  const om=new OrderManager({exchange:ex,state,store});
  ex.setFailure({kind:'stop',executeBeforeError:true,unknownOutcome:true,httpStatus:500,message:'stop created then 500'});
  const first=await om.submitStop({symbol:'BTC/USDT',side:'sell',amount:1,stopPrice:95,limitPrice:94.5,clientOrderId:'stop-unknown'});
  assert.equal(first.status,'UNKNOWN');
  assert.equal(ex.orders.size,1);
  const again=await om.submitStop({symbol:'BTC/USDT',side:'sell',amount:1,stopPrice:95,limitPrice:94.5,clientOrderId:'stop-unknown'});
  assert.equal(again.reused,true);
  assert.equal(ex.orders.size,1);
  const r=await om.reconcile('stop-unknown');
  assert.equal(r.status,'NEW');
});

test('fault injection: iptal gerçekten yapılır ama cevap kaybolursa emir tekrar iptal edilmez', async () => {
  const ex=new SimulatedExchange({startingQuote:1000,prices:{'BTC/USDT':100}});
  const state={liveOrders:{}}; const store={save(){}};
  const om=new OrderManager({exchange:ex,state,store});
  const stop=await om.submitStop({symbol:'BTC/USDT',side:'sell',amount:1,stopPrice:95,limitPrice:94.5,clientOrderId:'cancel-unknown'});
  ex.setFailure({kind:'cancel',executeBeforeError:true,unknownOutcome:true,httpStatus:500,message:'cancelled then 500'});
  const c=await om.cancel('cancel-unknown');
  assert.equal(c.status,'UNKNOWN');
  assert.equal(ex.orders.get(stop.clientOrderId).status,'CANCELED');
  const r=await om.reconcile('cancel-unknown');
  assert.equal(r.status,'CANCELED');
});

test('fault injection: market emir kısmi dolup bağlantı koparsa kalan miktar ikinci emir olarak gönderilmez', async () => {
  const ex=new SimulatedExchange({startingQuote:1000,prices:{'BTC/USDT':100}});
  const state={liveOrders:{}}; const store={save(){}};
  const om=new OrderManager({exchange:ex,state,store});
  ex.setFailure({kind:'market',partialPct:40,executeBeforeError:true,unknownOutcome:true,httpStatus:500,message:'partial then disconnect'});
  const first=await om.submitMarket({symbol:'BTC/USDT',side:'buy',amount:1,clientOrderId:'partial-disconnect'});
  assert.equal(first.status,'UNKNOWN');
  assert.equal(ex.balances.USDT.free,960);
  assert.equal(ex.balances.BTC.free,0.4);
  const r=await om.reconcile('partial-disconnect');
  assert.equal(r.status,'PARTIALLY_FILLED');
  assert.equal(r.executedQty,0.4);
  assert.equal(ex.orders.size,1);
});
