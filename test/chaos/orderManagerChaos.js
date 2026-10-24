'use strict';
// OrderManager kaos fuzz: rastgele (gecikmeli/tekrarli/kayip/sirasiz) olay akisi altinda degismezler.
const { ChaosExchange, mulberry32 } = require('./chaosExchange');
const { OrderManager } = require('../../src/orderManager');

const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
const near = (a, b, eps = 1e-7) => Math.abs(Number(a) - Number(b)) <= eps * Math.max(1, Math.abs(Number(b)));

async function runSeed(seed, opts = {}) {
  const rng = mulberry32(seed);
  const ex = new ChaosExchange(rng, { btc: 10, usdt: 1e6, p: opts.p });
  const state = { liveOrders: {} };
  const violations = [];
  const last = {};
  const fail = (msg) => violations.push(`seed=${seed}: ${msg}`);

  const om = new OrderManager({
    exchange: ex, state, store: { save() {} },
    onOrderUpdate: (o) => {
      const prev = last[o.clientOrderId];
      if (prev) {
        if (Number(o.executedQty || 0) < Number(prev.executedQty || 0) - 1e-12) fail(`executedQty geriledi ${prev.executedQty} -> ${o.executedQty} (${prev.status}->${o.status})`);
        if (Number(o.quoteQty || 0) < Number(prev.quoteQty || 0) - 1e-12) fail(`quoteQty geriledi ${prev.quoteQty} -> ${o.quoteQty}`);
        if (TERMINAL.has(prev.status) && !TERMINAL.has(o.status)) fail(`terminal durumdan geri dönüş ${prev.status} -> ${o.status}`);
        if (prev.status === 'FILLED' && o.status !== 'FILLED') fail(`FILLED ezildi -> ${o.status}`);
      }
      last[o.clientOrderId] = { status: o.status, executedQty: o.executedQty, quoteQty: o.quoteQty };
    }
  });
  ex.deliver = (ev) => { try { om.applyExecutionReport(ev); } catch (e) { fail(`applyExecutionReport istisna: ${e.message}`); } };
  ex.onAwait = () => {
    if (ex.chance(0.5)) ex.advanceRandom();
    ex.pump(1 + Math.floor(rng() * 3));
  };

  const kind = ['market-buy', 'market-sell', 'stop'][Math.floor(rng() * 3)];
  const cid = `c-${seed}`;
  const amount = 1;
  try {
    if (kind === 'market-buy') await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount, clientOrderId: cid });
    else if (kind === 'market-sell') await om.submitMarket({ symbol: 'BTC/USDT', side: 'sell', amount, clientOrderId: cid });
    else await om.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount, stopPrice: 95, limitPrice: 94, clientOrderId: cid });
  } catch (e) { fail(`submit istisna: ${e.message}`); }

  const steps = 4 + Math.floor(rng() * 10);
  for (let i = 0; i < steps; i++) {
    const r = rng();
    try {
      if (r < 0.25) ex.advanceRandom();
      else if (r < 0.5) ex.pump(1 + Math.floor(rng() * 3));
      else if (r < 0.7) { if (om.get(cid) && ex.byCid.get(cid)) await om.cancel(cid); }
      else if (r < 0.9) { if (om.get(cid)) await om.reconcile(cid, { markUnknownOnError: rng() < 0.5 }); }
      else if (om.get(cid)) await om.refreshPending();
    } catch (e) {
      // beklenen: iptal reddi / ag hatasi. Yakalanmayan hata degismez ihlali degildir ama kayit tutarli kalmali.
    }
  }

  // Son: kalan WS olaylari (bir kismi kayip), sonra son mutabakat (REST dogru ve ag saglam).
  ex.flushAll({ lossy: true });
  ex.p.errorProb = 0; ex.p.staleProb = 0; ex.p.injectProb = 0;
  const rec = om.get(cid);
  const truth = ex.byCid.get(cid);
  if (!truth) return { violations, kind, skipped: true };
  if (!rec) { fail('kayit yok'); return { violations, kind }; }

  let final = rec;
  try { final = await om.reconcile(cid); } catch (e) { fail(`son reconcile istisna: ${e.message}`); }

  if (final.status !== truth.status) fail(`SON DURUM yanlış: yerel=${final.status} borsa=${truth.status} (${kind})`);
  if (!near(final.executedQty, truth.exec)) fail(`SON executedQty yanlış: yerel=${final.executedQty} borsa=${truth.exec} (${kind}, durum=${truth.status})`);
  if (!near(final.quoteQty, truth.quote)) fail(`SON quoteQty yanlış: yerel=${final.quoteQty} borsa=${truth.quote}`);
  // Komisyon: borsanin gercek toplam komisyonu
  const trueFees = {};
  for (const f of truth.fills) trueFees[f.asset] = (trueFees[f.asset] || 0) + f.commission;
  const gotFees = final.commissionByAsset || {};
  for (const [asset, v] of Object.entries(trueFees)) {
    if (!near(gotFees[asset] || 0, v, 1e-6)) fail(`KOMİSYON yanlış ${asset}: yerel=${gotFees[asset] || 0} borsa=${v} (durum=${truth.status})`);
  }
  for (const [asset, v] of Object.entries(gotFees)) {
    if (!(asset in trueFees) && Number(v) > 1e-12) fail(`KOMİSYON hayalet varlık ${asset}=${v}`);
  }
  // Net miktar tutarliligi (alisla base komisyonu dusulmeli)
  if (final.side === 'buy') {
    const expectNet = Math.max(0, truth.exec - (trueFees.BTC || 0));
    if (!near(final.netExecutedQty, expectNet, 1e-6)) fail(`netExecutedQty yanlış: yerel=${final.netExecutedQty} beklenen=${expectNet}`);
  }
  return { violations, kind };
}

async function runMany(from, count, opts) {
  const all = [];
  const stats = { kinds: {}, ran: 0 };
  for (let s = from; s < from + count; s++) {
    const r = await runSeed(s, opts);
    stats.ran++; stats.kinds[r.kind] = (stats.kinds[r.kind] || 0) + 1;
    all.push(...r.violations);
  }
  return { violations: all, stats };
}

module.exports = { runSeed, runMany };

if (require.main === module) {
  const from = Number(process.argv[2] || 1), count = Number(process.argv[3] || 500);
  runMany(from, count, { p: JSON.parse(process.env.CHAOS_P || '{}') }).then(({ violations, stats }) => {
    const byType = {};
    for (const v of violations) { const k = v.replace(/seed=\d+: /, '').replace(/[-0-9.e]+/g, '#').slice(0, 70); (byType[k] = byType[k] || []).push(v); }
    console.log(JSON.stringify(stats));
    for (const [k, arr] of Object.entries(byType)) console.log(`${arr.length}x  ${k}\n     örnek: ${arr[0]}`);
    console.log(violations.length ? `İHLAL: ${violations.length}` : 'TEMİZ');
    process.exit(violations.length ? 1 : 0);
  });
}
