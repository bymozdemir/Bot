// Yeni kagit motor davranislari: kapanmis mumda sinyal, sonraki acilista dolum, mum ici stop,
// eski sinyal, kill switch, gunluk limit, veri kesintisi, lot yuvarlama, son karar kaydi.
const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');

const H = 3600000;
const T0 = Date.UTC(2026, 8, 30, 0, 0); // hizali saat
const C = (i, o, h, l, c) => ({ t: T0 + i * H, o, h, l, c, v: 1 });
const flat = (n, p) => Array.from({ length: n }, (_, i) => C(i, p, p, p, p));

function setup({ candles, nowOffsetMs = 30000, strategy = null, rules = { minNotional: 10 }, settings = {}, pair = {}, fetchError = null } = {}) {
  const state = store.defaultState();
  state.running = true;
  state.pairs = { 'BTC/USDT': { ...state.pairs['BTC/USDT'], enabled: true, budgetPct: 100, ...pair } };
  Object.assign(state.settings, { maxTradeQuote: 0, reserveCashPct: 0, killSwitchLossPct: 0, dailyLossLimitPct: 100, ...settings });
  const ctx = { candles, now: T0 + (candles.length - 1) * H + nowOffsetMs, fetchError, evalCalls: 0, msgs: [] };
  const exchange = {
    quoteAssets: ['USDT'],
    fetchCandles: async () => { if (ctx.fetchError) throw new Error(ctx.fetchError); return ctx.candles; },
    fetchSymbolRules: async () => rules
  };
  const notifier = { send: async (t) => { ctx.msgs.push(t); return {}; }, ping: async () => true };
  const engine = new PaperEngine({ exchange, store: { save() {} }, state, notifier, nowFn: () => ctx.now });
  engine.log = function (msg, level = 'info') { this.state.log.unshift({ t: 'x', msg, level }); };
  const id = state.pairs['BTC/USDT'].strategyId;
  const reg = strategies.registry;
  const orig = reg[id];
  if (strategy) reg[id] = { ...orig, evaluate: (a) => { ctx.evalCalls++; return strategy(a); } };
  ctx.restore = () => { reg[id] = orig; };
  return { engine, state, ctx };
}
const buyWhenClosedIdx = (k) => ({ candles }) => (candles[candles.length - 1].t === T0 + k * H ? { action: 'buy', reason: 'test alim' } : { action: 'hold', reason: 'bekle' });
const pos = (over = {}) => ({ symbol: 'BTC/USDT', strategyId: 'x', entryPrice: 100, quantity: 1, costUSDT: 100, stopPrice: 97, highWaterMark: 100, openedAt: 'x', checkedThroughT: T0 + 9 * H, ...over });

test('sinyal KAPANMIS mumda uretilir, dolum YENI mumun acilisindan (kayma ve komisyonla)', async () => {
  const candles = flat(10, 100).concat([C(10, 105, 106, 104, 105.5)]); // 10 kapali + olusan mum (acilis 105)
  const { engine, state, ctx } = setup({ candles, strategy: buyWhenClosedIdx(9) });
  await engine.tick();
  ctx.restore();
  const p = state.paper.positions['BTC/USDT'];
  assert.ok(p, 'pozisyon acilmadi');
  assert.ok(Math.abs(p.entryPrice - 105 * 1.0005) < 1e-9, `giris ${p.entryPrice}`); // 105.5 (canli) ya da 100 (kapanis) degil
  assert.ok(Math.abs(p.costUSDT - 150) < 1e-9); // butce %100, rezerv 0
  assert.ok(state.paper.cash < 1e-9);
  assert.ok(state.paper.costs.fees > 0 && state.paper.costs.slippage > 0);
  assert.equal(state.decisions['BTC/USDT'].action, 'buy');
  assert.equal(state.decisions['BTC/USDT'].stale, false);
  assert.ok(ctx.msgs.some((m) => /ALIM BTC\/USDT/.test(m)));
});

test('ayni kapanmis mum ikinci kez degerlendirilmez; yeni mum kapaninca yeniden degerlendirilir', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'bekle' }) });
  await engine.tick(); await engine.tick(); await engine.tick();
  assert.equal(ctx.evalCalls, 1);
  ctx.candles = candles.concat([C(11, 100, 100, 100, 100)]); // bir mum daha kapandi
  ctx.now = T0 + 11 * H + 20000;
  await engine.tick();
  ctx.restore();
  assert.equal(ctx.evalCalls, 2);
});

test('ESKI sinyal (mum kapanisindan dakikalar sonra) uygulanmaz ama karar kaydedilir', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, nowOffsetMs: 10 * 60000, strategy: buyWhenClosedIdx(9) }); // 10 dk sonra
  await engine.tick();
  ctx.restore();
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.equal(state.decisions['BTC/USDT'].action, 'buy');
  assert.equal(state.decisions['BTC/USDT'].stale, true);
  assert.ok(state.log.some((l) => /eski/.test(l.msg)));
});

test('olusan mumun DUSUGU stop\'u delerse mum kapanmadan cikilir (stop fiyatindan)', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 95, 96)]);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'b' }) });
  state.paper.cash = 0; state.paper.positions['BTC/USDT'] = pos();
  await engine.tick();
  ctx.restore();
  assert.equal(Object.keys(state.paper.positions).length, 0);
  const t = state.paper.trades[0];
  assert.equal(t.reason, 'stop-loss');
  assert.ok(Math.abs(t.exitPrice - 97 * 0.9995) < 1e-9, `cikis ${t.exitPrice}`);
});

test('stop\'un altinda BOSLUKLA acilirsa acilis fiyatindan cikar', async () => {
  const candles = flat(10, 100).concat([C(10, 90, 91, 88, 89)]);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'b' }) });
  state.paper.cash = 0; state.paper.positions['BTC/USDT'] = pos();
  await engine.tick();
  ctx.restore();
  assert.ok(Math.abs(state.paper.trades[0].exitPrice - 90 * 0.9995) < 1e-9);
});

test('kacirilan turlar: kapanmis mumlardaki stop ihlali geriye donuk yakalanir', async () => {
  const cs = flat(11, 100);
  cs[7] = C(7, 100, 100, 94, 99); // bot bu mumda veri alamadi; sonra fiyat toparlandi
  const { engine, state, ctx } = setup({ candles: cs, strategy: () => ({ action: 'hold', reason: 'b' }) });
  state.paper.cash = 0; state.paper.positions['BTC/USDT'] = pos({ checkedThroughT: T0 + 5 * H });
  await engine.tick();
  ctx.restore();
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.equal(state.paper.trades[0].reason, 'stop-loss');
});

test('eski kayitli pozisyon (checkedThroughT yok) gecmis mumlar yuzunden bir anda kapanmaz', async () => {
  const cs = flat(11, 100);
  cs[3] = C(3, 100, 100, 90, 95);
  const { engine, state, ctx } = setup({ candles: cs, strategy: () => ({ action: 'hold', reason: 'b' }) });
  const p = pos(); delete p.checkedThroughT;
  state.paper.cash = 0; state.paper.positions['BTC/USDT'] = p;
  await engine.tick();
  ctx.restore();
  assert.equal(Object.keys(state.paper.positions).length, 1);
});

test('kill switch: toplam zarar limitinde pozisyonlar kapanir, bot kilitlenir, baslatilamaz', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'b' }), settings: { killSwitchLossPct: 25 } });
  state.paper.cash = 30; state.paper.positions['BTC/USDT'] = pos({ quantity: 0.8, costUSDT: 80, entryPrice: 100 }); // 30 + 0.8*100 = 110 (< 150*0.75=112.5)
  await engine.tick();
  ctx.restore();
  assert.equal(state.running, false);
  assert.ok(state.killSwitch && /toplam zarar/.test(state.killSwitch.reason));
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.throws(() => engine.start(), /Kill switch/);
  assert.ok(ctx.msgs.some((m) => /KILL SWITCH/.test(m)));
});

test('kill switch kapali (0) iken ayni zarar botu kilitlemez', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'b' }), settings: { killSwitchLossPct: 0 } });
  state.paper.cash = 60;
  await engine.tick();
  ctx.restore();
  assert.equal(state.running, true);
  assert.equal(state.killSwitch, null);
});

test('closeOnDailyLoss eski ayarı false olsa bile güvenli kapanış zorunludur', async () => {
  const { engine, state } = setup({ candles: flat(10, 100), settings: { closeOnDailyLoss: false } });
  engine.ensureState();
  assert.equal(state.settings.closeOnDailyLoss, true);
});

test('gunluk zarar limiti: bot durduğunda korumasız pozisyon bırakılmaz', async () => {
  for (const closeOn of [true, false]) {
    const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
    const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'b' }), settings: { dailyLossLimitPct: 5, closeOnDailyLoss: closeOn } });
    state.paper.dayKey = engine.getRiskDayKey(ctx.now);
    state.paper.dayStartEquity = 150;
    state.paper.cash = 91; state.paper.positions['BTC/USDT'] = pos({ quantity: 0.5, costUSDT: 50, entryPrice: 100 }); // 91 + 50 = 141 (-6%)
    await engine.tick();
    ctx.restore();
    assert.equal(state.running, false, `closeOn=${closeOn}`);
    assert.equal(Object.keys(state.paper.positions).length, 0, `closeOn=${closeOn}`);
    assert.equal(state.killSwitch, null);
  }
});

test('veri kesintisi: 3 tur sonra TEK uyari, gelince "geri geldi"; hata alani temizlenir', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'bekle' }), fetchError: 'fetch failed' });
  for (let i = 0; i < 6; i++) await engine.tick();
  assert.equal(ctx.msgs.filter((m) => /Veri akışı kesildi/.test(m)).length, 1);
  assert.match(state.decisions['BTC/USDT'].error, /fetch failed/);
  ctx.fetchError = null;
  await engine.tick();
  ctx.restore();
  assert.ok(ctx.msgs.some((m) => /geri geldi/.test(m)));
  assert.equal(state.decisions['BTC/USDT'].error, undefined);
});

test('veri kesintisi uyarisi: acik pozisyon varsa stop izlenemedigini soyler', async () => {
  const { engine, state, ctx } = setup({ candles: flat(11, 100), strategy: () => ({ action: 'hold', reason: 'b' }), fetchError: 'zaman asimi' });
  state.paper.positions['BTC/USDT'] = pos();
  for (let i = 0; i < 3; i++) await engine.tick();
  ctx.restore();
  assert.ok(ctx.msgs.some((m) => /stop-loss/.test(m) && /kesildi/.test(m)));
});

test('lot yuvarlama: miktar stepSize\'in kati, maliyet butceyi asmaz; minQty altinda alim atlanir', async () => {
  const candles = flat(10, 100).concat([C(10, 123.4567, 130, 120, 125)]);
  const a = setup({ candles, strategy: buyWhenClosedIdx(9), rules: { minNotional: 10, stepSize: 0.01, minQty: 0.01 } });
  await a.engine.tick();
  a.ctx.restore();
  const p = a.state.paper.positions['BTC/USDT'];
  assert.ok(p);
  assert.ok(Math.abs(p.quantity * 100 - Math.round(p.quantity * 100)) < 1e-9, `miktar ${p.quantity}`);
  assert.ok(p.costUSDT <= 150 + 1e-9);

  const b = setup({ candles: flat(10, 100).concat([C(10, 83000, 83000, 83000, 83000)]), strategy: buyWhenClosedIdx(9), rules: { minNotional: 10, stepSize: 1, minQty: 1 } });
  await b.engine.tick();
  b.ctx.restore();
  assert.equal(Object.keys(b.state.paper.positions).length, 0);
  assert.ok(b.state.log.some((l) => /minimum lot/.test(l.msg)));
});

test('minimum emir degeri komisyon dusulduktan sonra da saglanir', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, strategy: buyWhenClosedIdx(9), rules: { minNotional: 10 }, pair: { budgetPct: 1 } }); // butce 1.5 USDT < 10
  await engine.tick();
  ctx.restore();
  const p = state.paper.positions['BTC/USDT'];
  assert.ok(p, 'minimuma yukseltilip alinmaliydi');
  assert.ok(p.quantity * p.entryPrice >= 10, `emir degeri ${p.quantity * p.entryPrice}`);
});

test('islem basina ust tutar (maxTradeQuote) uygulanir', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, strategy: buyWhenClosedIdx(9), settings: { maxTradeQuote: 20 } });
  await engine.tick();
  ctx.restore();
  assert.ok(state.paper.positions['BTC/USDT'].costUSDT <= 20 + 1e-9);
});

test('istatistik, maliyet, en yuksek dusus ve ilk fiyat kaydi tutulur', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, strategy: buyWhenClosedIdx(9) });
  await engine.tick();
  assert.equal(state.paper.firstPrices['BTC/USDT'], 100);
  state.paper.lastPrices['BTC/USDT'] = 110;
  engine.closePosition('BTC/USDT', 'test');
  ctx.restore();
  assert.equal(state.paper.stats.trades, 1);
  assert.equal(state.paper.stats.wins, 1);
  assert.ok(state.paper.stats.grossWin > 0);
  assert.ok(state.paper.costs.fees > 0);
  assert.equal(state.paper.trades.length, 1);
});

test('eski state.json (yeni alanlar yok) sorunsuz calisir ve alanlar tamamlanir', async () => {
  const candles = flat(10, 100).concat([C(10, 100, 100, 100, 100)]);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'b' }) });
  for (const k of ['startingBalance', 'lastSignalT', 'firstPrices', 'costs', 'stats', 'peakEquity', 'maxDrawdownPct']) delete state.paper[k];
  delete state.decisions; delete state.killSwitch;
  await engine.tick();
  ctx.restore();
  assert.equal(state.paper.startingBalance, 150);
  assert.ok(state.paper.lastSignalT['BTC/USDT']);
  assert.equal(state.killSwitch, null);
  assert.equal(state.running, true);
});

test('olusan mum yoksa (adaptor sadece kapanmis mum dondurur) yeni sinyal son kapanistan DOLDURULMAZ', async () => {
  const candles = flat(10, 100); // sonraki mum acilmadi: hepsi kapali
  const { engine, state, ctx } = setup({ candles, nowOffsetMs: H + 30000, strategy: buyWhenClosedIdx(9) });
  await engine.tick();
  ctx.restore();
  assert.equal(Object.keys(state.paper.positions).length, 0);
});


test('eski piyasa mumları yeni fiyat gibi kaydedilmez ve açık pozisyonda yeni risk açılmaz', async () => {
  const candles = flat(10, 100);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'buy', reason: 'stale-market-test' }) });
  ctx.now = T0 + 20 * H; // veri 10 saatten eski; 1h timeframe için güvenli sınırı aşıyor
  state.paper.lastPrices['BTC/USDT'] = 80;
  state.paper.cash = 0;
  state.paper.positions['BTC/USDT'] = pos({ entryPrice: 90, quantity: 1, costUSDT: 90 });
  await engine.tick();
  ctx.restore();
  assert.equal(state.paper.lastPrices['BTC/USDT'], 80, 'eski kapanış son bilinen fiyatı ezmemeli');
  assert.equal(Object.keys(state.paper.positions).length, 1, 'veri eskiliği sahte dolum üretmemeli');
  assert.match(state.decisions['BTC/USDT'].error, /piyasa verisi eski/);
  assert.match(engine.entryPauseReason, /piyasa verisi alınamadı/);
});

test('gelecek zaman damgalı piyasa serisi reddedilir', async () => {
  const candles = flat(10, 100);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'buy', reason: 'future-market-test' }) });
  ctx.now = candles[candles.length - 1].t + 30_000;
  ctx.candles = candles.map((c) => ({ ...c, t: c.t + 20 * 60_000 }));
  await engine.tick();
  ctx.restore();
  assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.match(state.decisions['BTC/USDT'].error, /zaman damgası.*ileride/);
});


test('gün değişiminde eski pozisyon fiyatı günlük başlangıcı sıfırlamaz ve sahte zarar limiti çalıştırmaz', async () => {
  const candles = flat(10, 100);
  const { engine, state, ctx } = setup({ candles, strategy: () => ({ action: 'hold', reason: 'stale-rollover-test' }) });
  ctx.now = T0 + 20 * H; // mumlar eskimiş, gün anahtarı da değişmiş olur
  state.paper.dayKey = '2026-09-30';
  state.paper.dayStartEquity = 100;
  state.paper.dayStartEquityByAsset = { USDT: 100 };
  state.settings.dailyLossLimitPct = 5;
  state.settings.closeOnDailyLoss = true;
  state.paper.cash = 0;
  state.paper.lastPrices['BTC/USDT'] = 10;
  state.paper.positions['BTC/USDT'] = pos({ entryPrice: 100, quantity: 1, costUSDT: 100 });
  await engine.tick();
  ctx.restore();
  assert.equal(state.paper.dayKey, '2026-09-30', 'veri eksikken günlük rollover ertelenmeli');
  assert.equal(state.paper.dayStartEquity, 100, 'eski fiyattan günlük başlangıç değiştirilmemeli');
  assert.equal(state.running, true, 'eski fiyat günlük limit tetiklememeli');
  assert.equal(Object.keys(state.paper.positions).length, 1, 'eski fiyatla sahte kapama yapılmamalı');
});
