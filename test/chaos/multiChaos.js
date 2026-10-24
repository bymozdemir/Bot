'use strict';
// Coklu sembol kaosu: BTC ve ETH pozisyonlari AYNI ANDA, her biri kendi akisiyla (satis / trailing / hicbiri) ve
// rastgele stop tetiklenmeleriyle calisir. Paylasilan durum (kapi, kilitler, mutabakat) uzerinden cakisma aranir.
const { ChaosExchange, mulberry32 } = require('./chaosExchange');
const store = require('../../src/store');
const LiveEngine = require('../../src/liveEngine');

let clock = Date.UTC(2026, 9, 2, 12, 0);
const NOW = () => clock;
const near = (a, b, eps = 1.5e-4) => Math.abs(a - b) <= eps;
const SYMS = [['BTC/USDT', 'BTC', 'BTCUSDT'], ['ETH/USDT', 'ETH', 'ETHUSDT']];

async function runSeed(seed, opts = {}) {
  const rng = mulberry32(seed);
  const violations = [];
  const fail = (m) => violations.push(`seed=${seed}: ${m}`);
  const ex = new ChaosExchange(rng, { btc: 1, eth: 1, usdt: 1e6, p: { errorProb: 0, unknownProb: 0, staleProb: 0, ...(opts.p || {}) } });
  const state = store.defaultState();
  state.settings.mode = 'live'; state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0;
  state.settings.maxConcurrentPositions = 2; state.settings.reserveCashPct = 0;
  state.live.safeToTrade = true; state.running = true;
  const disk = { saved: null, save(st) { this.saved = JSON.stringify(st); } };
  const proc1 = { dead: false };
  const view1 = new Proxy(ex, { get(t, k) { const v = t[k]; if (typeof v !== 'function') return v; return (...a) => (proc1.dead ? new Promise(() => {}) : v.apply(t, a)); } });
  let engine = new LiveEngine({ exchange: view1, state, store: { save(st) { if (!proc1.dead) disk.save(st); } }, allowLive: true, nowFn: NOW });
  engine.killRetryDelayMs = 0;
  let cur = state;
  ex.deliver = (ev) => { try { engine.orderManager.applyExecutionReport(ev); } catch (e) { fail(`WS istisna: ${e.message}`); } };
  ex.onCreate = (cid, kind) => { if (!(disk.saved || '').includes(`"${cid}"`)) fail(`${kind} emri (${cid}) diske YAZILMADAN gönderildi`); };

  const pos = {};
  for (const [sym, base] of SYMS) {
    const entryCid = `entry-${base}-${seed}`; const stopCid = `stop-${base}-${seed}`;
    state.liveOrders[entryCid] = { clientOrderId: entryCid, symbol: sym, side: 'buy', status: 'FILLED', exchangeOrderId: 1, executedQty: 1, netExecutedQty: 1, quoteQty: 100, amount: 1 };
    const rec = await engine.orderManager.submitStop({ symbol: sym, side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94, clientOrderId: stopCid, meta: { role: 'protective-stop', entryClientOrderId: entryCid } });
    if (rec.status !== 'NEW') return { violations, skipped: true };
    state.live.positions[sym] = { symbol: sym, quantity: 1, entryPrice: 100, costQuote: 100, openedAt: '2026-10-02T10:00:00.000Z', entryOrderId: entryCid, stopOrderId: stopCid, stopPrice: 95, highWaterMark: 100, stopExecutionIds: [] };
    state.live.lastPrices[sym] = 100;
    pos[sym] = state.live.positions[sym];
  }
  disk.save(state);
  Object.assign(ex.p, { errorProb: 0.06, unknownProb: 0.05, staleProb: 0.3, dropProb: 0.1, dupProb: 0.2, injectProb: 0.5 }, opts.p || {});
  ex.onAwait = () => { if (ex.chance(0.25)) ex.advanceRandom(); ex.pump(1 + Math.floor(rng() * 3)); };

  let crashed = false; let crashSignal = new Promise(() => {});
  if (opts.crash) crashSignal = new Promise((resolve) => { ex.crashCountdown = 1 + Math.floor(rng() * 60); ex.onCrash = () => { crashed = true; proc1.dead = true; resolve(); }; });

  const act = async ([sym]) => {
    const kind = ['sell', 'trail', 'none'][Math.floor(rng() * 3)];
    try {
      if (kind === 'sell') await engine.sell(sym, pos[sym], 100, 'strateji-cikis', engine.epoch);
      else if (kind === 'trail') await engine._syncTrailingStop(sym, pos[sym], { stopLossPct: 5, trailingStop: true }, 130);
    } catch (e) { /* fail-closed hatalar beklenir */ }
  };
  await Promise.race([Promise.all(SYMS.map(act)), crashSignal]);

  if (opts.crash) {
    ex.crashCountdown = undefined; ex.onCrash = null; proc1.dead = true; ex.gen = (ex.gen || 0) + 1; ex.pending.length = 0;
    cur = JSON.parse(disk.saved);
    engine = new LiveEngine({ exchange: ex, state: cur, store: disk, allowLive: true, nowFn: NOW });
    engine.killRetryDelayMs = 0;
    ex.deliver = (ev) => { try { engine.orderManager.applyExecutionReport(ev); } catch (e) { fail(`WS istisna: ${e.message}`); } };
    Object.assign(ex.p, { errorProb: 0, unknownProb: 0, staleProb: 0, injectProb: 0 });
    try { const r = await engine.recovery.recover(); cur.live.safeToTrade = r.safeToTrade === true; cur.running = true; } catch (e) { fail(`kurtarma istisna: ${e.message}`); cur.running = true; }
  }

  ex.flushAll({ lossy: true });
  Object.assign(ex.p, { errorProb: 0, unknownProb: 0, staleProb: 0, injectProb: 0 });
  for (let i = 0; i < 6; i++) {
    clock += 120000; engine.lastReconcileAt = 0;
    try { await engine.tick(); } catch (e) { /* sonraki tur */ }
    await Promise.all([...engine.stopUpdateLocks.values()]);
    ex.flushAll({ lossy: false });
  }
  const safe = cur.live.safeToTrade === true;

  // ---- DEGISMEZLER (sembol basina) ----
  for (const ms of ex.marketSells) {
    if (ms.stopFilledAtCall) fail(`${ms.sym}: market satış GÖNDERİLDİ ama koruyucu stop zaten gerçekleşmişti`);
    else if (ms.amount > ms.freeAtCall + 1e-9) fail(`${ms.sym}: market satış miktarı serbest bakiyeyi aşıyor: ${ms.amount} > ${ms.freeAtCall}`);
  }
  for (const [sym, base] of SYMS) {
    const truth = ex.balances[base].free + ex.balances[base].locked;
    const local = cur.live.positions[sym]; const lq = local ? Number(local.quantity) : 0;
    const sold = [...ex.orders.values()].filter((o) => o.sym === sym.replace('/', '') && o.side === 'sell').reduce((a, o) => a + o.exec, 0);
    if (sold > 1 + 1e-9) fail(`${sym}: borsada 1'den fazla satış: ${sold}`);
    if (safe) {
      if (!near(lq, truth)) fail(`${sym}: kapı AÇIK ama yerel=${lq} borsa=${truth}`);
      if (local && lq > 0) {
        const tr = local.stopOrderId && ex.byCid.get(local.stopOrderId);
        if (!tr || !(tr.status === 'NEW' || tr.status === 'PARTIALLY_FILLED')) fail(`${sym}: kapı AÇIK, açık pozisyon var ama açık koruyucu stop yok`);
      }
    }
    // Sembol karismasi: baska sembolun emri bu sembolun kaydina islenmemeli
    for (const o of Object.values(cur.liveOrders)) {
      if (o.symbol === sym && o.exchangeOrderId && ex.orders.get(Number(o.exchangeOrderId)) && ex.orders.get(Number(o.exchangeOrderId)).sym !== sym.replace('/', '')) fail(`${sym}: kayıt başka sembolün emrine bağlı (${o.clientOrderId})`);
    }
  }
  return { violations, locked: !safe, lockReason: !safe ? String(cur.live.lockReason || 'bilinmiyor').slice(0, 80) : null, crashed };
}

async function runMany(from, count, opts) {
  const all = []; const stats = { ran: 0, skipped: 0, crashes: 0, lockedAfterRecovery: 0, lockReasons: {} };
  for (let s = from; s < from + count; s++) {
    const r = await runSeed(s, opts);
    if (r.skipped) { stats.skipped++; continue; }
    stats.ran++; if (r.crashed) stats.crashes++;
    if (r.locked) { stats.lockedAfterRecovery++; stats.lockReasons[r.lockReason] = (stats.lockReasons[r.lockReason] || 0) + 1; }
    all.push(...r.violations);
  }
  return { violations: all, stats };
}
module.exports = { runSeed, runMany };

if (require.main === module) {
  const from = Number(process.argv[2] || 1), count = Number(process.argv[3] || 300);
  runMany(from, count, { p: JSON.parse(process.env.CHAOS_P || '{}'), crash: process.env.CRASH === '1' }).then(({ violations, stats }) => {
    const byType = {};
    for (const v of violations) { const k = v.replace(/seed=\d+: /, '').replace(/[-0-9.e]+/g, '#').replace(/\(.*$/, '').slice(0, 90); (byType[k] = byType[k] || []).push(v); }
    console.log(JSON.stringify(stats));
    for (const [k, arr] of Object.entries(byType)) console.log(`${arr.length}x  ${k}\n     örnek: ${arr[0]}`);
    console.log(violations.length ? `İHLAL: ${violations.length}` : 'TEMİZ');
    process.exit(violations.length ? 1 : 0);
  });
}
