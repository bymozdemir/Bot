'use strict';
// Canli (Binance Testnet dahil) icin hazir varsayilanlar: varsayilan ayarlar canli gecis/baslatma
// kapilarini TAKMAMALI; strateji varsayilanlari makul stop mesafesi tasimali; eski state.json tek
// seferlik ve yalnizca eski varsayilanla birebir ayni degerler icin guncellenmeli.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../src/store');
const strategies = require('../src/strategies');
const LiveEngine = require('../src/liveEngine');
const { crossSiteRejection } = require('../src/util/originGuard');

test('varsayilan ayarlar canli risk kapilarini gecer (maxTradeQuote/kill switch/gunluk limit > 0)', () => {
  const s = store.defaultState().settings;
  assert.ok(Number(s.maxTradeQuote) > 0, 'maxTradeQuote 0 olamaz');
  assert.ok(Number(s.killSwitchLossPct) > 0);
  assert.ok(Number(s.dailyLossLimitPct) > 0);
  assert.ok(Number(s.reserveCashPct) >= 0 && Number(s.reserveCashPct) < 100);
  assert.ok(s.maxTradeQuote >= 10, 'Binance min. emir tutarinin altina dusmemeli');
  assert.ok(s.killSwitchLossPct >= 2 * s.dailyLossLimitPct, 'kill switch gunluk limitin en az 2 kati olmali (ayni gun kilitlenmesin)');
  assert.ok(s.killSwitchLossPct <= 25, 'toplam zarar limiti asiri genis olmamali');
  const state = store.defaultState();
  state.settings.mode = 'live';
  const engine = new LiveEngine({ exchange: { id: 'binance', capabilities: {} }, state, store: { save() {} }, allowLive: true });
  engine.ensureState();
  assert.deepEqual(engine._validateRiskSettings(), []);
});

test('varsayilan portfoy: bütçeler, rezerv ve pozisyon sayisi %100\'u asmaz', () => {
  const st = store.defaultState();
  const s = st.settings;
  const deployable = Math.min(s.maxConcurrentPositions * s.defaultBudgetPct, 100 - s.reserveCashPct);
  assert.ok(s.maxConcurrentPositions * s.defaultBudgetPct + s.reserveCashPct <= 100);
  assert.ok(deployable > 0);
});

test('tum stratejilerin varsayilanlari gecerli; stop %0.1-10 araliginda; kar esigi stoptan kucuk degil', () => {
  for (const [id, s] of Object.entries(strategies.registry)) {
    assert.equal(strategies.validateParams(id, s.defaultParams), null, id);
    const sl = Number(s.defaultParams.stopLossPct);
    const tp = Number(s.defaultParams.takeProfitPct);
    assert.ok(sl >= 0.1 && sl <= 10, `${id}: varsayilan stop %${sl} makul degil (0.1-10)`);
    assert.ok(!(tp > 0) || tp >= sl, `${id}: kar esigi %${tp} stoptan (%${sl}) kucuk`);
    if (s.defaultParams.trailingStop) assert.ok(sl > 0, `${id}: trailing stop icin stopLossPct > 0 gerekli`);
    const need = s.minCandles(s.defaultParams) + 1;
    assert.ok(need <= 1000, `${id}: ${need} mum gerekir`);
  }
});

test('varsayilan paritelerin parametreleri strateji varsayilanlariyla birebir ayni', () => {
  const st = store.defaultState();
  for (const p of Object.values(st.pairs)) {
    assert.deepEqual(p.params, strategies.get(p.strategyId).defaultParams, p.symbol);
  }
});

function loadWith(settingsOverride, pairs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const st = store.defaultState();
  delete st.settings.defaultsVersion;
  Object.assign(st.settings, settingsOverride);
  st.pairs = pairs;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
  const r = spawnSync(process.execPath, ['-e', "const s=require('./src/store').load();process.stdout.write(JSON.stringify({s:s.settings,p:s.pairs}));"], {
    cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, BOT_DATA_DIR: dir }, encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const mkPair = (symbol, strategyId, over = {}) => ({ symbol, enabled: true, strategyId, timeframe: '1h', budgetPct: 30, portfolioClass: 'core', params: { ...strategies.get(strategyId).defaultParams, ...over } });

test('eski state.json: maxTradeQuote 0 -> 50, yalniz birebir eski %15 stop -> yeni varsayilan, ozel degerler korunur', () => {
  const out = loadWith({ maxTradeQuote: 0, quoteAsset: 'USDT' }, {
    'A/USDT': mkPair('A/USDT', 'trend_filter', { stopLossPct: 15 }),
    'B/USDT': mkPair('B/USDT', 'trend_filter', { stopLossPct: 12 }),
    'C/USDT': mkPair('C/USDT', 'rsi_ema_macd', { stopLossPct: 15 })
  });
  assert.equal(out.s.maxTradeQuote, 50);
  assert.equal(out.s.defaultsVersion, 2);
  assert.equal(out.p['A/USDT'].params.stopLossPct, 8);
  assert.equal(out.p['B/USDT'].params.stopLossPct, 12, 'bilincli ozel deger degismemeli');
  assert.equal(out.p['C/USDT'].params.stopLossPct, 3, 'stratejinin yeni varsayilanina tasinir (eski 15 zaten kullanici denemesi)');
});

test('eski state.json: kullanici pozitif maxTradeQuote belirlediyse dokunulmaz; USDT disi kasada atanmaz', () => {
  assert.equal(loadWith({ maxTradeQuote: 120 }, {}).s.maxTradeQuote, 120);
  assert.equal(loadWith({ maxTradeQuote: 0, quoteAsset: 'TRY' }, {}).s.maxTradeQuote, 0);
});

test('gecis tek seferlik: defaultsVersion=2 olan dosyada kullanici 0 yaparsa geri 50 yapilmaz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig2-'));
  const st = store.defaultState();
  st.settings.maxTradeQuote = 0;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/store').load().settings.maxTradeQuote));"], {
    cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, BOT_DATA_DIR: dir }, encoding: 'utf8'
  });
  assert.equal(r.stdout, '0');
});

test('originGuard: Origin yokken yabanci/gecersiz Referer reddedilir, panelin kendi Referer\'i ve Referer\'siz istek gecer', () => {
  const same = (req, o) => o === 'http://127.0.0.1:8787';
  assert.equal(crossSiteRejection({ headers: { referer: 'http://evil.com/x' } }, same).status, 403);
  assert.equal(crossSiteRejection({ headers: { referer: 'not a url' } }, same).status, 403);
  assert.equal(crossSiteRejection({ headers: { referer: 'http://127.0.0.1:8787.evil.com/' } }, same).status, 403);
  assert.equal(crossSiteRejection({ headers: { referer: 'http://127.0.0.1:8787/panel' } }, same), null);
  assert.equal(crossSiteRejection({ headers: {} }, same), null);
  assert.equal(crossSiteRejection({ headers: { origin: 'http://127.0.0.1:8787', referer: 'http://evil.com/' } }, same), null);
});
