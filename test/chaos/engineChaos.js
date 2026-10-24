'use strict';
// LiveEngine kaos fuzz: acik pozisyon + borsada koruyucu stop; cikis satisi / trailing yenileme / stop tetiklenmesi
// rastgele araya girer. Degismezler: asiri satis yok, hayalet/yetim pozisyon yok, korumasiz acik kapi yok, cift K/Z yok.
const { ChaosExchange, mulberry32 } = require('./chaosExchange');
const store = require('../../src/store');
const LiveEngine = require('../../src/liveEngine');

let clock = Date.UTC(2026, 9, 2, 12, 0);
const NOW = () => clock;
const near = (a, b, eps = 2e-5) => Math.abs(a - b) <= eps;

async function runSeed(seed, opts = {}) {
  const rng = mulberry32(seed);
  const violations = [];
  const fail = (m) => violations.push(`seed=${seed}: ${m}`);
  const ex = new ChaosExchange(rng, { btc: 1, usdt: 1e6, p: Object.assign({ errorProb: 0, unknownProb: 0, staleProb: 0 }, opts.p || {}) });
  let state = store.defaultState();
  state.settings.mode = 'live';
  // Risk modu: gercek limitler acik ve kucuk cuzdan (yanlis degerleme buyuk zarar gibi gorunur). Fiyat sabit: GERCEK zarar yok.
  if (opts.risk) { state.settings.dailyLossLimitPct = 5; state.settings.killSwitchLossPct = 25; ex.balances.USDT.free = 200; }
  else { state.settings.dailyLossLimitPct = 100; state.settings.killSwitchLossPct = 0; }
  state.settings.maxConcurrentPositions = 1; state.settings.reserveCashPct = 0;
  state.live.safeToTrade = true; state.running = true;

  const diskStore = { saved: null, failProb: 0, failures: 0, save(st) {
    // Disk arizasi: yazma hata firlatir ve ESKI kayit diskte kalir.
    if (this.failProb > 0 && rng() < this.failProb) { this.failures++; throw Object.assign(new Error('ENOSPC: yazma basarisiz'), { code: 'ENOSPC' }); }
    this.saved = JSON.stringify(st);
  } };
  // Eski surec: borsa ve disk erisimi cokmede tamamen kesilir (zombi akislar ne emir gonderebilir ne diske yazabilir).
  const proc1 = { dead: false };
  const exView1 = new Proxy(ex, { get(t, prop) { const v = t[prop]; if (typeof v !== 'function') return v; return (...a) => (proc1.dead ? new Promise(() => {}) : v.apply(t, a)); } });
  const store1 = { save(st) { if (!proc1.dead) diskStore.save(st); } };
  let engine = new LiveEngine({ exchange: exView1, state, store: store1, allowLive: true, nowFn: NOW });
  engine.killRetryDelayMs = 0;
  if (opts.onEngine) opts.onEngine({ engine, ex, state });
  ex.deliver = (ev) => { try { engine.orderManager.applyExecutionReport(ev); } catch (e) { fail(`WS istisna: ${e.message}`); } };

  const action = opts.riskLoss ? 'risk' : ['sell', 'sell', 'trail', 'buy', 'buy'][Math.floor(rng() * 5)];
  clock = Date.UTC(2026, 9, 2, 12, 0);
  let pos = null;
  if (action !== 'buy') {
    // Kurulum (hatasiz): pozisyon + borsada acik koruyucu stop
    const entryCid = `entry-${seed}`;
    state.liveOrders[entryCid] = { clientOrderId: entryCid, symbol: 'BTC/USDT', side: 'buy', status: 'FILLED', exchangeOrderId: 1, executedQty: 1, netExecutedQty: 1, quoteQty: 100, amount: 1 };
    const stopCid = `stop-${seed}`;
    const stopRec = await engine.orderManager.submitStop({ symbol: 'BTC/USDT', side: 'sell', amount: 1, stopPrice: 95, limitPrice: 94, clientOrderId: stopCid, meta: { role: 'protective-stop', entryClientOrderId: entryCid } });
    if (stopRec.status !== 'NEW') return { violations, skipped: true };
    state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, openedAt: '2026-10-02T10:00:00.000Z', entryOrderId: entryCid, stopOrderId: stopCid, stopPrice: 95, highWaterMark: 100, stopExecutionIds: [] };
    pos = state.live.positions['BTC/USDT'];
  } else {
    ex.balances.BTC.free = 0;
    state.settings.maxTradeQuote = 100; state.pairs['BTC/USDT'].budgetPct = 100; state.pairs['BTC/USDT'].enabled = true;
  }

  state.live.lastPrices['BTC/USDT'] = 100;
  if (opts.riskLoss) {
    // Baslangic ozsermayesi normal fiyatta kaydedilir (gercek motor da ilk turda boyle yapar).
    state.live.lastBalance = (await engine.reconciler.reconcile()).balances;
    state.settings.riskDayTimezone = 'UTC';
    await engine._checkRiskGate();
    if (state.killSwitch) return { violations, skipped: true };
  }   // gercek motor her turda son fiyati kaydeder (harness'te mum yok)
  diskStore.save(state);   // kurulum durumu diskte
  // DEGISMEZ: borsaya giden HER emrin clientOrderId'si, gonderimden ONCE diske yazilmis olmali (yoksa cokme sonrasi emir yetim kalir).
  ex.onCreate = (cid, kind) => { if (!(diskStore.saved || '').includes(`"${cid}"`)) fail(`${kind} emri (${cid}) diske YAZILMADAN borsaya gönderildi`); };
  if (opts.diskFail) diskStore.failProb = opts.diskFail;
  Object.assign(ex.p, { errorProb: 0.06, unknownProb: 0.05, staleProb: 0.3, dropProb: 0.1, dupProb: 0.2, injectProb: 0.5 }, opts.p || {});
  ex.onAwait = () => {
    if (ex.chance(0.25)) ex.advanceRandom();       // stop borsada tetiklenir / dolar
    ex.pump(1 + Math.floor(rng() * 3));
  };

  // Cokme: rastgele bir bekleme noktasinda surec olur. O ana kadar DISKE yazilan durum kalir; teslim edilmemis
  // WS olaylari ve calismakta olan akis kaybolur. Yeni bir motor kayitli durumdan toparlanir.
  let crashed = false;
  let persistedKillSwitch = false;
  let unprotectedAfterKill = false;
  let crashSignal = new Promise(() => {});
  if (opts.crash) {
    crashSignal = new Promise((resolve) => {
      ex.crashCountdown = 1 + Math.floor(rng() * 45);
      ex.onCrash = () => { crashed = true; proc1.dead = true; resolve(); };
    });
  }
  const flow = (async () => {
    try {
      if (action === 'buy') await engine.buy('BTC/USDT', state.pairs['BTC/USDT'], { stopLossPct: 5 }, 100, 'sinyal', engine.epoch);
      else if (action === 'risk') { ex.price = 40; state.live.lastPrices['BTC/USDT'] = 40; state.running = true; await engine._checkRiskGate(); }
      else if (action === 'sell') await engine.sell('BTC/USDT', pos, 100, 'strateji-cikis', engine.epoch);
      else await engine._syncTrailingStop('BTC/USDT', pos, { stopLossPct: 5, trailingStop: true }, 130);
    } catch (e) { /* beklenen: fail-closed hatalar */ }
  })();
  await Promise.race([flow, crashSignal]);

  if (opts.crash) {
    ex.crashCountdown = undefined; ex.onCrash = null;
    // Akis sorunsuz bittiyse de surec simdi oluyor (temiz yeniden baslatma da test edilir).
    proc1.dead = true;                     // eski surecin tum bekleyen akislari sonsuza dek asili kalir
    ex.gen = (ex.gen || 0) + 1;
    ex.pending.length = 0;                 // surec kapaliyken gelen WS olaylari kayboldu
    diskStore.failProb = 0;                // yeniden baslatma: disk sorunu giderildi
    state = JSON.parse(diskStore.saved);   // YALNIZCA diske yazilan durum
    if (opts.onRestart) opts.onRestart({ state, ex });
    persistedKillSwitch = !!state.killSwitch;
    engine = new LiveEngine({ exchange: ex, state, store: diskStore, allowLive: true, nowFn: NOW });
    engine.killRetryDelayMs = 0;
    if (opts.onEngine2) opts.onEngine2({ engine, state, ex });
    ex.onAwait = () => { if (ex.chance(0.2)) ex.advanceRandom(); ex.pump(1 + Math.floor(rng() * 3)); };
    ex.deliver = (ev) => { try { engine.orderManager.applyExecutionReport(ev); } catch (e) { fail(`WS istisna: ${e.message}`); } };
    Object.assign(ex.p, { errorProb: 0, unknownProb: 0, staleProb: 0, injectProb: 0 });
    try {
      const rec = await engine.recovery.recover();
      state.live.safeToTrade = rec.safeToTrade === true;
      state.running = true;
    } catch (e) { fail(`yeniden başlatma kurtarması istisna: ${e.message}`); state.running = true; }
  }

  diskStore.failProb = 0;   // toparlanma: disk sorunu giderildi
  // Toparlanma: kalan WS (kayiplı), sonra REST yenileme + mutabakat (ag saglam)
  ex.flushAll({ lossy: true });
  Object.assign(ex.p, { errorProb: 0, unknownProb: 0, staleProb: 0, injectProb: 0 });
  let safe = false;
  for (let i = 0; i < 6; i++) {
    clock += 120000; engine.lastReconcileAt = 0;
    try { await engine.tick(); } catch (e) { /* tick hatasi sonraki turda tekrar denenir */ }
    await Promise.all([...engine.stopUpdateLocks.values()]);
    ex.flushAll({ lossy: false });
  }
  safe = state.live.safeToTrade === true;

  if (opts.inspect) await opts.inspect({ engine, state, ex });
  // ---- DEGISMEZLER ----
  if (opts.riskLoss) {
    // KILL SWITCH KILIDI: bir kez devreye girdiyse (diske yazildiysa) cokme/mutabakat sonrasi kapi KENDILIGINDEN acilmamali.
    if (state.killSwitch && state.live.safeToTrade === true) fail('kill switch devrede ama canlı işlem kapısı AÇIK');
    if (persistedKillSwitch && !state.killSwitch) fail('kalıcı kill switch yeniden başlatmadan sonra kayboldu');
    // Acil kapanis: pozisyon ya kapanmis ya da borsada ACIK stopla korunuyor olmali; kapi acik degilse yine de korumasiz birakilmamali.
    const lp = state.live.positions['BTC/USDT'];
    if (lp && state.killSwitch) {
      const st = lp.stopOrderId && ex.byCid.get(lp.stopOrderId);
      const protectedNow = st && (st.status === 'NEW' || st.status === 'PARTIALLY_FILLED');
      if (!protectedNow) unprotectedAfterKill = true;
    }
  }
  if (opts.risk && !opts.riskLoss && state.killSwitch) fail(`YANLIŞ kill switch (fiyat sabit, gerçek zarar yok): ${state.killSwitch.reason}`);
  for (const ms of ex.marketSells) {
    if (ms.stopFilledAtCall) fail(`market satış GÖNDERİLDİ ama koruyucu stop zaten gerçekleşmişti (aşırı satış girişimi) amount=${ms.amount} free=${ms.freeAtCall}`);
    else if (ms.amount > ms.freeAtCall + 1e-9) fail(`market satış miktarı serbest bakiyeyi aşıyor: amount=${ms.amount} free=${ms.freeAtCall} locked=${ms.lockedAtCall}`);
  }
  const lockReason = !safe ? String(state.live.lockReason || state.live.reconciliation?.reason || state.liveReconciliation?.reason || 'bilinmiyor').slice(0, 80) : null;
  const truthBtc = ex.balances.BTC.free + ex.balances.BTC.locked;
  const local = state.live.positions['BTC/USDT'];
  const lq = local ? Number(local.quantity) : 0;
  const lastTradesQty = (state.live.trades || []).reduce((a, t) => a + Number(t.quantity || t.qty || 0), 0);
  if (safe) {
    if (!near(lq, truthBtc, 1.5e-4)) fail(`kapı AÇIK ama yerel miktar borsayla uyuşmuyor: yerel=${lq} borsa=${truthBtc} (${action})`);
    if (local && lq > 0) {
      const stopRecNow = state.liveOrders[local.stopOrderId];
      const tr = stopRecNow && ex.byCid.get(local.stopOrderId);
      if (!local.stopOrderId || !tr || !(tr.status === 'NEW' || tr.status === 'PARTIALLY_FILLED')) fail(`kapı AÇIK, açık pozisyon var ama borsada AÇIK koruyucu stop yok (stop=${local.stopOrderId} durum=${tr && tr.status})`);
    }
  }
  const soldTruth = [...ex.orders.values()].filter((o) => o.side === 'sell').reduce((a, o) => a + o.exec, 0);
  if (soldTruth > 1 + 1e-9) fail(`borsada 1'den fazla satış gerçekleşti: ${soldTruth}`);
  if (lastTradesQty > 1 + 1e-6) fail(`yerel defterde çift sayım: kayıtlı satılan=${lastTradesQty}`);
  if (!local && safe && truthBtc > 1.5e-4) fail(`yetim bakiye: pozisyon silindi, kapı açık, borsada ${truthBtc} BTC var`);
  if (local && lq > 0 && truthBtc <= 1e-9 && safe) fail(`hayalet pozisyon: borsada BTC yok ama yerel ${lq}, kapı açık`);
  return { violations, action, locked: !safe && !state.killSwitch, lockReason, crashed, killed: !!state.killSwitch, unprotectedAfterKill };
}

async function runMany(from, count, opts) {
  const all = []; const stats = { ran: 0, skipped: 0, crashes: 0, killed: 0, unprotectedAfterKill: 0, actions: {}, lockedAfterRecovery: 0, lockReasons: {} };
  for (let s = from; s < from + count; s++) {
    const r = await runSeed(s, opts);
    if (r.skipped) { stats.skipped++; continue; }
    stats.ran++; if (r.crashed) stats.crashes++; if (r.killed) stats.killed++; if (r.unprotectedAfterKill) stats.unprotectedAfterKill++; stats.actions[r.action] = (stats.actions[r.action] || 0) + 1;
    if (r.locked) { stats.lockedAfterRecovery++; stats.lockReasons[r.lockReason] = (stats.lockReasons[r.lockReason] || 0) + 1; }
    all.push(...r.violations);
  }
  return { violations: all, stats };
}
module.exports = { runSeed, runMany };

if (require.main === module) {
  const from = Number(process.argv[2] || 1), count = Number(process.argv[3] || 300);
  runMany(from, count, { p: JSON.parse(process.env.CHAOS_P || '{}'), crash: process.env.CRASH === '1', diskFail: Number(process.env.DISKFAIL || 0), risk: process.env.RISK === '1' || process.env.RISKLOSS === '1', riskLoss: process.env.RISKLOSS === '1' }).then(({ violations, stats }) => {
    const byType = {};
    for (const v of violations) { const k = v.replace(/seed=\d+: /, '').replace(/[-0-9.e]+/g, '#').replace(/\(stop=.*$/, '').slice(0, 90); (byType[k] = byType[k] || []).push(v); }
    console.log(JSON.stringify(stats));
    for (const [k, arr] of Object.entries(byType)) console.log(`${arr.length}x  ${k}\n     örnek: ${arr[0]}`);
    console.log(violations.length ? `İHLAL: ${violations.length}` : 'TEMİZ');
    process.exit(violations.length ? 1 : 0);
  });
}
