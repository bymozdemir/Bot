'use strict';
// Denetim bulguları (2026-10-14) için regresyon testleri. Her test, düzeltmeden ÖNCE
// gerçek motorda başarısız olan davranışı doğrular.
const test = require('node:test');
const assert = require('node:assert/strict');
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');
const strategies = require('../src/strategies');
const { breakEvenBufferPct, profitProtectionStop, intrabarRiskExit } = require('../src/execution');

const H = 3600000;
const LAST_T = Math.floor(Date.UTC(2026, 9, 14, 12, 0) / H) * H; // saat başı, yeni mum açılışı
const NOW = LAST_T + 30 * 1000; // yeni mum 30 sn önce açıldı (sinyal taze)

// 300 kapanmış mum + yeni açılan (forming) mum
function series(price, forming = {}) {
  const out = [];
  for (let i = 300; i >= 1; i--) out.push({ t: LAST_T - i * H, o: price, h: price, l: price, c: price, v: 1 });
  out.push({ t: LAST_T, o: price, h: price, l: price, c: price, v: 1, ...forming });
  return out;
}

function mkState({ symbols = ['BTC/USDT'], cash = 150, start = 150 } = {}) {
  const s = store.defaultState();
  s.running = true;
  s.settings.quoteAsset = 'USDT';
  s.settings.dailyLossLimitPct = 0;
  s.settings.killSwitchLossPct = 0;
  s.settings.reserveCashPct = 0;
  s.paper.cash = cash;
  s.paper.cashByAsset = { USDT: cash };
  s.paper.startingBalance = start;
  s.paper.startingBalanceByAsset = { USDT: start };
  s.paper.dayStartEquity = start;
  s.paper.dayStartEquityByAsset = { USDT: start };
  const base = Object.values(s.pairs)[0];
  s.pairs = {};
  for (const sym of symbols) s.pairs[sym] = { ...base, symbol: sym, enabled: true, budgetPct: 100, timeframe: '1h' };
  return s;
}

function position(symbol, over = {}) {
  return { symbol, quoteAsset: 'USDT', baseAsset: symbol.split('/')[0], strategyId: 'rsi_simple', entryPrice: 100, quantity: 1, costQuote: 100, costUSDT: 100, stopPrice: 97, highWaterMark: 100, checkedThroughT: LAST_T - H, openedAt: 'x', ...over };
}

function engineFor(state, exchange, opts = {}) {
  const e = new PaperEngine({ exchange: { id: 'fake', name: 'Fake', quoteAssets: ['USDT'], fetchSymbolRules: async () => ({ minNotional: 10 }), ...exchange }, store: opts.store || { save() {} }, state, nowFn: opts.nowFn || (() => NOW) });
  e.log = function (msg, level = 'info') { this.state.log.unshift({ t: 'x', msg, level }); };
  return e;
}

async function withStrategy(action, fn) {
  const state = mkState();
  const strat = strategies.registry[state.pairs['BTC/USDT'].strategyId];
  const old = strat.evaluate;
  strat.evaluate = typeof action === 'function' ? action : () => ({ action, reason: 'test' });
  try { return await fn(); } finally { strat.evaluate = old; }
}

// ---------------------------------------------------------------- 1) sahipsiz pozisyon
test('paritesi silinmiş açık pozisyon hâlâ izlenir: fiyat güncellenir ve stop-loss çalışır', async () => {
  const state = mkState({ symbols: [], cash: 50, start: 150 });
  state.paper.positions['BTC/USDT'] = position('BTC/USDT');
  let fetched = 0;
  const e = engineFor(state, { fetchCandles: async () => { fetched++; return series(100, { o: 100, h: 100, l: 90, c: 92 }); } });
  await e.tick();
  assert.ok(fetched > 0, 'sahipsiz pozisyonun verisi hiç çekilmedi');
  assert.equal(state.paper.positions['BTC/USDT'], undefined, 'stop-loss çalışmadı, pozisyon sahipsiz kaldı');
  assert.equal(state.paper.trades[0].reason, 'stop-loss');
  assert.equal(state.paper.lastPrices['BTC/USDT'], 92);
});

test('sahipsiz pozisyonda strateji sinyali uygulanmaz (yalnızca stop izlenir) ve yeni alım açılmaz', async () => {
  await withStrategy('sell', async () => {
    const state = mkState({ symbols: [], cash: 50, start: 150 });
    state.paper.positions['BTC/USDT'] = position('BTC/USDT');
    const e = engineFor(state, { fetchCandles: async () => series(100) });
    await e.tick();
    assert.ok(state.paper.positions['BTC/USDT'], 'sahipsiz pozisyon strateji SELL sinyaliyle satılmamalı');
    assert.equal(state.paper.lastPrices['BTC/USDT'], 100);
  });
});

test('kill switch sahipsiz pozisyonun GÜNCEL fiyatıyla hesap yapar', async () => {
  const state = mkState({ symbols: [], cash: 0, start: 100 });
  state.settings.killSwitchLossPct = 20;
  state.paper.lastPrices['BTC/USDT'] = 100; // eski fiyat: zarar yok görünür
  state.paper.positions['BTC/USDT'] = position('BTC/USDT', { stopPrice: null });
  const e = engineFor(state, { fetchCandles: async () => series(50) });
  await e.tick();
  assert.ok(state.killSwitch, 'güncel fiyat (-%50) kill switch limitini tetiklemeliydi');
  assert.equal(Object.keys(state.paper.positions).length, 0);
});

// ---------------------------------------------------------------- 2) closePosition / closeAll fiyat kuralı
test('closePosition: son fiyat yoksa GİRİŞ fiyatından satmaz', () => {
  const state = mkState();
  state.paper.positions['BTC/USDT'] = position('BTC/USDT');
  state.paper.lastPrices = {};
  const e = engineFor(state, {});
  assert.equal(e.closePosition('BTC/USDT', 'test'), false);
  assert.ok(state.paper.positions['BTC/USDT'], 'pozisyon kapanmamalıydı');
  assert.match(e.lastCloseError, /son fiyat yok/);
  assert.equal(e.closePosition('BTC/USDT', 'test', { allowStale: true }), false, 'allowStale bile fiyatsız satış yapmaz');
});

test('closePosition: eskimiş son fiyattan satmaz; allowStale ile (kullanıcı onayıyla) satar', () => {
  const state = mkState();
  state.paper.positions['BTC/USDT'] = position('BTC/USDT');
  state.paper.lastPrices = { 'BTC/USDT': 120 };
  state.paper.lastPriceT = { 'BTC/USDT': NOW - 3 * H };
  const e = engineFor(state, {});
  assert.equal(e.closePosition('BTC/USDT', 'test'), false);
  assert.match(e.lastCloseError, /eski/);
  assert.ok(state.paper.positions['BTC/USDT']);
  assert.equal(e.closePosition('BTC/USDT', 'test', { allowStale: true }), true);
  assert.equal(state.paper.positions['BTC/USDT'], undefined);
});

test('closePosition: taze fiyatla normal satar', () => {
  const state = mkState();
  state.paper.positions['BTC/USDT'] = position('BTC/USDT');
  state.paper.lastPrices = { 'BTC/USDT': 110 };
  state.paper.lastPriceT = { 'BTC/USDT': NOW - 5000 };
  const e = engineFor(state, {});
  assert.equal(e.closePosition('BTC/USDT', 'test'), true);
  assert.equal(e.lastCloseError, '');
});

test('closeAll: fiyatı olmayan pozisyonu giriş fiyatından satmaz, diğerlerini kapatır', () => {
  const state = mkState({ symbols: ['BTC/USDT', 'ETH/USDT'] });
  state.paper.positions['BTC/USDT'] = position('BTC/USDT');
  state.paper.positions['ETH/USDT'] = position('ETH/USDT');
  state.paper.lastPrices = { 'ETH/USDT': 90 };
  const e = engineFor(state, {});
  assert.equal(e.closeAll('test'), 1);
  assert.ok(state.paper.positions['BTC/USDT'], 'fiyatsız pozisyon giriş fiyatından satılmamalı');
  assert.equal(state.paper.positions['ETH/USDT'], undefined);
  assert.equal(e.lastCloseFailures.length, 1);
});

test('closeAll: bir satışta disk hatası döngüyü kesmez, kalan pozisyonlar denenir', () => {
  const state = mkState({ symbols: ['BTC/USDT', 'ETH/USDT'] });
  state.paper.positions['BTC/USDT'] = position('BTC/USDT');
  state.paper.positions['ETH/USDT'] = position('ETH/USDT');
  state.paper.lastPrices = { 'BTC/USDT': 100, 'ETH/USDT': 100 };
  let calls = 0;
  const e = engineFor(state, {}, { store: { save() { calls++; if (calls === 1) throw new Error('disk dolu'); } } });
  const n = e.closeAll('test');
  assert.equal(n, 1);
  assert.equal(Object.keys(state.paper.positions).length, 1, 'başarısız olan açık kalır, diğeri kapanır');
  assert.equal(e.lastCloseFailures.length, 1);
});

test('kill switch: disk yazımı hata verse de kilit uygulanır ve motor durur', () => {
  const state = mkState();
  state.settings.killSwitchLossPct = 10;
  state.paper.cashByAsset.USDT = 0; state.paper.cash = 0;
  state.paper.startingBalanceByAsset.USDT = 100;
  state.paper.positions['BTC/USDT'] = position('BTC/USDT', { stopPrice: null });
  state.paper.lastPrices = { 'BTC/USDT': 50 };
  state.paper.lastPriceT = { 'BTC/USDT': NOW };
  const e = engineFor(state, {}, { store: { save() { throw new Error('disk hatası'); } } });
  assert.doesNotThrow(() => e.checkLossLimits(e.liquidationEquity(), { freshSince: NOW }));
  assert.ok(state.killSwitch, 'disk hatası kilidi atlatmamalı');
  assert.equal(state.running, false);
});

// ---------------------------------------------------------------- 3) takılan fetch
test('hiç dönmeyen fetchCandles zaman aşımına uğrar; tick tamamlanır ve bot kilitlenmez', async () => {
  const state = mkState();
  state.settings.fetchTimeoutMs = 1000;
  state.paper.positions['BTC/USDT'] = position('BTC/USDT');
  const e = engineFor(state, { fetchCandles: () => new Promise(() => {}) });
  const t0 = Date.now();
  await e.tick();
  assert.ok(Date.now() - t0 < 5000, 'tick takıldı');
  assert.equal(e.busy, false);
  assert.match(state.decisions['BTC/USDT'].error, /zaman aşımı/);
  assert.ok(state.paper.positions['BTC/USDT'], 'veri yokken pozisyon satılmamalı');
  assert.equal(e.entryPauseReason, 'açık pozisyon için piyasa verisi alınamadı');
});

test('takılmış (busy) tick stop() sonrası yeniden başlatmayı engellemez', async () => {
  const state = mkState();
  const e = engineFor(state, { fetchCandles: async () => series(100) });
  e.busy = true; e.busyToken = {}; e.busySince = NOW; // hiç dönmeyen eski tick
  await e.tick();
  assert.equal(state.paper.lastPrices['BTC/USDT'], undefined, 'busy iken yeni tick atlanır');
  e.stop('test');
  state.running = true;
  await e.tick();
  assert.equal(state.paper.lastPrices['BTC/USDT'], 100, 'stop() sonrası tick çalışmalı');
});

test('watchdog: çok uzun süre busy kalan tick serbest bırakılır', async () => {
  const state = mkState();
  const e = engineFor(state, { fetchCandles: async () => series(100) });
  e.busy = true; e.busyToken = {}; e.busySince = NOW - 60 * 1000; // 1 dk: henüz takılmış sayılmaz
  await e.tick();
  assert.equal(state.paper.lastPrices['BTC/USDT'], undefined);
  e.busySince = NOW - 11 * 60 * 1000; // 11 dk: takılmış
  await e.tick();
  assert.equal(state.paper.lastPrices['BTC/USDT'], 100, 'watchdog kilidi serbest bırakmalı');
  assert.ok(state.log.some((l) => /takılmış sayıldı/.test(l.msg)));
});

// ---------------------------------------------------------------- 4) break-even tamponu
test('break-even tamponu komisyon ve kaymadan hesaplanır: stop zarara satmaz', () => {
  for (const [feePct, slipPct] of [[0.1, 0.05], [0.35, 0.05], [0.1, 0], [0.2, 0.2], [0, 0]]) {
    const entry = 100; // entry zaten alım kaymasını içerir
    const bufferPct = breakEvenBufferPct(feePct, slipPct);
    const stop = profitProtectionStop(entry, 100, 3, true, bufferPct);
    const fee = feePct / 100, slip = slipPct / 100;
    const net = stop * (1 - slip) * (1 - fee); // stop'ta satış
    const cost = entry * (1 + fee);
    assert.ok(net >= cost, `fee=${feePct} slip=${slipPct}: net ${net} < maliyet ${cost}`);
  }
  // eski sabit %0.20 varsayılan bu maliyetle zarar ettiriyordu
  const old = profitProtectionStop(100, 100, 3, true);
  assert.ok(old * 0.9995 * 0.999 < 100 * 1.001);
});

test('intrabarRiskExit pozisyonun breakEvenBufferPct değerini kullanır', () => {
  const pos = { entryPrice: 100, highWaterMark: 110, stopPrice: 97, breakEvenBufferPct: 0.81 };
  const hit = intrabarRiskExit(pos, { t: 1, o: 108, h: 108, l: 100.5, c: 101 }, { stopLossPct: 20, takeProfitPct: 3, trailingStop: false }, true);
  assert.ok(hit);
  assert.ok(Math.abs(hit.ref - 100.81) < 1e-9, `ref=${hit.ref}`);
  assert.equal(hit.reason, 'profit-protection stop');
});

test('paper motor: açılan pozisyona maliyet tabanlı tampon yazılır; eski kayıt ensureState ile tamamlanır', async () => {
  await withStrategy('buy', async () => {
    const state = mkState();
    state.settings.paperFeePct = 0.35;
    const e = engineFor(state, { fetchCandles: async () => series(100, { o: 100, h: 100, l: 100, c: 100 }) });
    await e.tick();
    const p = state.paper.positions['BTC/USDT'];
    assert.ok(p, 'pozisyon açılmadı');
    assert.ok(Math.abs(p.breakEvenBufferPct - breakEvenBufferPct(0.35, 0.05)) < 1e-12);
    assert.ok(p.breakEvenBufferPct > 0.7, `tampon ${p.breakEvenBufferPct}`);

    const legacy = mkState();
    legacy.paper.positions['BTC/USDT'] = position('BTC/USDT'); // breakEvenBufferPct yok
    const e2 = engineFor(legacy, {});
    e2.ensureState();
    assert.ok(legacy.paper.positions['BTC/USDT'].breakEvenBufferPct > 0.2);
  });
});

// ---------------------------------------------------------------- 5) bozuk sembol
test('sembolde / yoksa ya da parite kaydı null ise tur çökmez; diğer pozisyonlar izlenir', async () => {
  const state = mkState({ symbols: ['BTC/USDT'], cash: 50, start: 150 });
  state.pairs['BTCUSDT'] = { ...state.pairs['BTC/USDT'], symbol: 'BTCUSDT' };
  state.pairs['NULL/USDT'] = null;
  state.paper.positions['BTC/USDT'] = position('BTC/USDT');
  const e = engineFor(state, { fetchCandles: async () => series(100, { o: 100, h: 100, l: 90, c: 92 }) });
  await assert.doesNotReject(() => e.tick());
  assert.equal(state.paper.positions['BTC/USDT'], undefined, 'bozuk kayıt BTC/USDT stop izlemesini durdurdu');
  assert.equal(e.pairSupported('BTCUSDT'), false);
  assert.equal(e.pairSupported(undefined), false);
});

// ---------------------------------------------------------------- 6) başarısız satışta sinyal kaybolmaz
test('SELL sinyali uygulanamazsa pozisyon açık kalır ve sinyal bir sonraki turda yeniden denenir', async () => {
  await withStrategy('sell', async () => {
    const state = mkState({ cash: 50, start: 150 });
    state.paper.positions['BTC/USDT'] = position('BTC/USDT', { stopPrice: null });
    const e = engineFor(state, { fetchCandles: async () => series(100) });
    const realSell = e.sellAt.bind(e);
    let fail = true;
    e.sellAt = (...args) => (fail ? false : realSell(...args));
    await e.tick();
    assert.ok(state.paper.positions['BTC/USDT'], 'satış başarısızken pozisyon silinmemeli');
    assert.notEqual(state.paper.lastSignalT['BTC/USDT'], LAST_T - H, 'başarısız satış sinyali tüketilmemeli');
    fail = false;
    await e.tick();
    assert.equal(state.paper.positions['BTC/USDT'], undefined, 'sinyal yeniden denenip satılmalıydı');
  });
});

test('mum içi stop satışı başarısız olursa checkedThroughT ilerlemez (mum yeniden taranır)', async () => {
  const state = mkState({ cash: 50, start: 150 });
  state.paper.positions['BTC/USDT'] = position('BTC/USDT', { checkedThroughT: LAST_T - 3 * H });
  const closedWithDrop = series(100);
  closedWithDrop[closedWithDrop.length - 2] = { t: LAST_T - H, o: 100, h: 100, l: 90, c: 92, v: 1 };
  const e = engineFor(state, { fetchCandles: async () => closedWithDrop });
  const realSell = e.sellAt.bind(e);
  let fail = true;
  e.sellAt = (...args) => (fail ? false : realSell(...args));
  await e.tick();
  assert.ok(state.paper.positions['BTC/USDT']);
  assert.equal(state.paper.positions['BTC/USDT'].checkedThroughT, LAST_T - 2 * H, 'stop vuran mum (LAST_T-1H) taranmış sayılmamalı: bir önceki mumda kalır');
  fail = false;
  await e.tick();
  assert.equal(state.paper.positions['BTC/USDT'], undefined);
});

// ---------------------------------------------------------------- 7) veri kesintisi
test('veri kesintisinde limit aşılırsa taze fiyatlı pozisyon kapanır, verisiz pozisyon eski fiyattan satılmaz ve motor durmaz', async () => {
  const state = mkState({ symbols: ['BTC/USDT', 'ETH/USDT'], cash: 0, start: 200 });
  state.settings.killSwitchLossPct = 50;
  state.paper.positions['BTC/USDT'] = position('BTC/USDT', { stopPrice: null });
  state.paper.positions['ETH/USDT'] = position('ETH/USDT', { stopPrice: null });
  state.paper.lastPrices = { 'BTC/USDT': 100, 'ETH/USDT': 10 };
  state.paper.lastPriceT = { 'BTC/USDT': NOW - 60000, 'ETH/USDT': NOW - 60000 };
  const e = engineFor(state, { fetchCandles: async (symbol) => { if (symbol === 'ETH/USDT') throw new Error('ağ kesildi'); return series(10); } });
  await e.tick();
  assert.equal(state.paper.positions['BTC/USDT'], undefined, 'taze fiyatlı pozisyon kapanmalı');
  assert.ok(state.paper.positions['ETH/USDT'], 'verisiz pozisyon eski fiyattan satılmamalı');
  assert.equal(state.running, true, 'verisiz pozisyon varken motor durdurulmamalı (stop izlemesi sürmeli)');
  assert.ok(state.log.some((l) => l.level === 'error' && /pozisyon açık/.test(l.msg)), 'kesintide limit aşımı sessiz kalmamalı');
});

test('kesintiden sonra geri dönük stop taraması son taranan muma kadar yeterli mum ister', async () => {
  const state = mkState();
  state.paper.positions['BTC/USDT'] = position('BTC/USDT', { checkedThroughT: LAST_T - 400 * H });
  let askedLimit = 0;
  const e = engineFor(state, { fetchCandles: async (_s, _tf, limit) => { askedLimit = limit; return series(100); } });
  await e.tick();
  assert.ok(askedLimit >= 402, `limit ${askedLimit}: kesinti penceresi kapsanmıyor`);
});

// ---------------------------------------------------------------- 8) iyimser dolum (isteğe bağlı mod)
test('paperConservativeFill=true: alım açılış ile gözlenen fiyatın KÖTÜSÜNDEN dolar; varsayılan backtest ile aynı (açılış)', async () => {
  await withStrategy('buy', async () => {
    const forming = { o: 100, h: 101.5, l: 100, c: 101 };
    const normal = mkState();
    await engineFor(normal, { fetchCandles: async () => series(100, forming) }).tick();
    const conservative = mkState();
    conservative.settings.paperConservativeFill = true;
    await engineFor(conservative, { fetchCandles: async () => series(100, forming) }).tick();
    const a = normal.paper.positions['BTC/USDT'], b = conservative.paper.positions['BTC/USDT'];
    assert.ok(a && b);
    assert.ok(Math.abs(a.entryPrice - 100 * 1.0005) < 1e-9, `varsayılan giriş ${a.entryPrice}`);
    assert.ok(Math.abs(b.entryPrice - 101 * 1.0005) < 1e-9, `muhafazakâr giriş ${b.entryPrice}`);
  });
});

// ---------------------------------------------------------------- 9) store: bozuk state.json
test('store.load: state.json bozuk ve yedek yoksa bot KILITLİ başlar (kill switch kaydı sessizce silinmez)', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const run = (dir) => JSON.parse(execFileSync(process.execPath, ['-e', "const s=require('./src/store').load();console.log(JSON.stringify({k:s.killSwitch,r:s.running,m:s.settings.mode}))"], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, BOT_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botstore-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{bozuk');
  const a = run(dir);
  assert.ok(a.k && /yedek yok/.test(a.k.reason), 'kilit konmadı');
  assert.equal(a.r, false);
  // geçerli JSON ama durum değil ("null"): sessizce varsayılana dönmemeli
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'botstore-'));
  fs.writeFileSync(path.join(dir2, 'state.json'), 'null');
  assert.ok(run(dir2).k, '"null" içerikli state.json kilitsiz varsayılana döndü');
  // sağlam .bak varsa onunla devam edilir, kilit eklenmez
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'botstore-'));
  fs.writeFileSync(path.join(dir3, 'state.json'), '{bozuk');
  fs.writeFileSync(path.join(dir3, 'state.json.bak'), JSON.stringify({ settings: { mode: 'paper' }, killSwitch: null }));
  assert.equal(run(dir3).k, null);
});
