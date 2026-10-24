const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFileSync, renameWithRetry } = require('../src/util/atomicWrite');
const LiveEngine = require('../src/liveEngine');
const { plainDecimal } = require('../src/execution');
const store = require('../src/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bot-aw-'));
async function withTestnetEnv(fn) {
  const keys = ['BINANCE_ENV', 'ALLOW_BINANCE_TESTNET_TRADING', 'LIVE_TRADING_ENABLED', 'BINANCE_ALLOW_LOCAL_BASE_URL', 'ALLOW_PRODUCTION_TRADING'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.BINANCE_ENV = 'testnet';
  process.env.ALLOW_BINANCE_TESTNET_TRADING = 'true';
  process.env.LIVE_TRADING_ENABLED = 'true';
  delete process.env.BINANCE_ALLOW_LOCAL_BASE_URL;
  delete process.env.ALLOW_PRODUCTION_TRADING;
  try { return await fn(); } finally { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}

test('atomicWrite: dosyayı yazar, .tmp artığı bırakmaz', () => {
  const d = tmpDir(); const f = path.join(d, 'a.json');
  atomicWriteFileSync(f, '{"x":1}');
  atomicWriteFileSync(f, '{"x":2}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"x":2}');
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('.tmp')), []);
});

test('atomicWrite: yedek (.bak) önceki sağlam içeriği tutar', () => {
  const d = tmpDir(); const f = path.join(d, 'b.json');
  atomicWriteFileSync(f, '{"v":1}', { backup: true, backupEveryMs: 0 });
  atomicWriteFileSync(f, '{"v":2}', { backup: true, backupEveryMs: 0 });
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), '{"v":1}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":2}');
});

test('atomicWrite: Windows tarzı geçici EPERM rename hatasında tekrar dener', () => {
  const d = tmpDir(); const f = path.join(d, 'c.json'); const tmp = f + '.t';
  fs.writeFileSync(f, 'old'); fs.writeFileSync(tmp, 'new');
  const real = fs.renameSync; let calls = 0;
  fs.renameSync = (a, b) => { if (++calls < 3) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return real(a, b); };
  try { renameWithRetry(tmp, f); } finally { fs.renameSync = real; }
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  assert.ok(calls >= 3);
});

test('atomicWrite: rename kalıcı başarısızsa eski hedefi korur ve atomik olmayan kopyaya düşmez', () => {
  const d = tmpDir(); const f = path.join(d, 'd.json'); const tmp = f + '.t';
  fs.writeFileSync(f, 'old'); fs.writeFileSync(tmp, 'new');
  const real = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  try { assert.throws(() => renameWithRetry(tmp, f, 2), /EPERM/); } finally { fs.renameSync = real; }
  assert.equal(fs.readFileSync(f, 'utf8'), 'old', 'başarısız yazma sağlam eski statei bozmamalı');
  assert.equal(fs.existsSync(tmp), false);
});

test('plainDecimal: üstel gösterim ve kayan nokta artığı üretmez', () => {
  assert.equal(plainDecimal(1e-7), '0.0000001');
  assert.equal(plainDecimal(0.1 + 0.2), '0.3');
  assert.equal(plainDecimal(12), '12');
});

function liveEngineFor(settings) {
  const state = store.defaultState();
  Object.assign(state.settings, { mode: 'live' }, settings);
  const ex = {
    id: 'binance', environment: 'testnet', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    createStopOrder() {}, createTakeProfitOrder() {}, createOcoOrder() {}, cancelOrder() {}, fetchOrderBook() {}
  };
  return new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true });
}

test('canlı başlatma: gerçek borsada risk limitleri 0 ise reddedilir', async () => withTestnetEnv(async () => {
  assert.throws(() => liveEngineFor({ maxTradeQuote: 0, killSwitchLossPct: 10, dailyLossLimitPct: 3 }).assertStartAllowed(), /maxTradeQuote/);
  assert.throws(() => liveEngineFor({ maxTradeQuote: 20, killSwitchLossPct: 0, dailyLossLimitPct: 3 }).assertStartAllowed(), /killSwitchLossPct/);
  assert.throws(() => liveEngineFor({ maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 0 }).assertStartAllowed(), /dailyLossLimitPct|geçersiz/);
  assert.doesNotThrow(() => liveEngineFor({ maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 }).assertStartAllowed());
}));

test('başarısız çıkış (sell) sinyali muma tüketilmiş sayılmaz', async () => {
  const eng = liveEngineFor({ maxTradeQuote: 20, killSwitchLossPct: 10, dailyLossLimitPct: 3 });
  eng.ensureState();
  const t0 = Date.UTC(2026, 9, 2, 8, 0);
  const candles = Array.from({ length: 300 }, (_, i) => ({ t: t0 - (300 - i) * 3600e3, o: 100, h: 100, l: 100, c: 100, v: 1 }));
  eng.exchange.fetchCandles = async () => candles;
  eng.exchange.fetchTicker = async () => ({ price: 100 });
  eng.nowFn = () => candles[candles.length - 1].t + 3600e3 + 5000;
  eng.state.pairs = { 'BTC/USDT': { symbol: 'BTC/USDT', enabled: true, strategyId: 'rsi_ema_macd', timeframe: '1h', budgetPct: 10, params: {} } };
  eng.state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopOrderId: null };
  const strategies = require('../src/strategies');
  const orig = strategies.get('rsi_ema_macd').evaluate;
  strategies.get('rsi_ema_macd').evaluate = () => ({ action: 'sell', reason: 'test' });
  eng.sell = async () => { throw new Error('ağ hatası'); };
  try {
    await assert.rejects(() => eng.processPair('BTC/USDT', eng.state.pairs['BTC/USDT'], eng.epoch), /ağ hatası/);
    assert.equal(eng.state.live.lastSignalT['BTC/USDT'], undefined);
  } finally { strategies.get('rsi_ema_macd').evaluate = orig; }
});

test('store: bozuk state.json varsa .bak yedeğinden devam eder', () => {
  const d = tmpDir();
  const prev = process.env.BOT_DATA_DIR; process.env.BOT_DATA_DIR = d;
  delete require.cache[require.resolve('../src/store')];
  const st = require('../src/store');
  try {
    const s = st.defaultState(); s.killSwitch = { t: 'x', reason: 'test-kill' };
    fs.writeFileSync(st.DATA_FILE + '.bak', JSON.stringify(s));
    fs.writeFileSync(st.DATA_FILE, '{bozuk json');
    const loaded = st.load();
    assert.equal(loaded.killSwitch.reason, 'test-kill');
  } finally {
    if (prev === undefined) delete process.env.BOT_DATA_DIR; else process.env.BOT_DATA_DIR = prev;
    delete require.cache[require.resolve('../src/store')];
  }
});

test('atomicWrite: fsync başarısızsa eski dosyayı korur, hatayı gizlemez ve tmp bırakmaz', () => {
  const d = tmpDir(); const f = path.join(d, 'durable.json');
  fs.writeFileSync(f, '{"old":true}');
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = () => { const e = new Error('simulated disk sync failure'); e.code = 'EIO'; throw e; };
  try {
    assert.throws(() => atomicWriteFileSync(f, '{"new":true}'), /simulated disk sync failure/);
  } finally { fs.fsyncSync = realFsync; }
  assert.equal(fs.readFileSync(f, 'utf8'), '{"old":true}');
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('.tmp-')), []);
});
