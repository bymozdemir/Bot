// 1.9.1 guvenlik denetimi duzeltmeleri icin regresyon testleri.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sec191-'));
process.env.BOT_DATA_DIR = TMP;

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const policy = require('../src/portfolioPolicy');
const auth = require('../src/auth');
const vault = require('../src/vault');
const store = require('../src/store');
const PaperEngine = require('../src/paperEngine');
const strategies = require('../src/strategies');
const { assertAllowedUrl } = require('../src/util/hostGuard');
const { acquireInstanceLock } = require('../src/util/instanceLock');

// ---------- portfolioPolicy: prototip anahtarlari ----------
test('politika: constructor/__proto__/toString kova adi olamaz, hasOwn ile aranir', () => {
  for (const k of ['constructor', '__proto__', 'prototype']) assert.equal(policy.isValidBucketKey(k), false, k);
  const p = policy.normalizePortfolioPolicy(JSON.parse('{"maxPositions":3,"reserveCashPct":10,"buckets":{"__proto__":{"label":"x","maxPositions":99,"maxCapitalPct":1},"constructor":{"label":"y"}}}'));
  assert.deepEqual(Object.keys(p.buckets).sort(), ['core', 'speculative']);
  assert.equal(p.buckets.label, undefined);
  // 'constructor' sinifi olan parite sessizce core'a duser ve core limitlerine tabi olur
  assert.equal(policy.pairBucket({ portfolioClass: 'constructor' }, p), 'core');
  assert.equal(policy.pairBucket({ portfolioClass: 'toString' }, p), 'core');
  const r = policy.canOpenPosition({ symbol: 'X', pair: { portfolioClass: 'constructor' }, positions: { A: { costQuote: 950 } }, pairs: { A: { portfolioClass: 'core' } }, policy: { maxPositions: 5, reserveCashPct: 0, buckets: { core: { maxPositions: 0, maxCapitalPct: 10 } } }, equity: 1000, requestedCost: 100 });
  assert.equal(r.ok, false);
});

// ---------- server.js statik kontroller ----------
test('server: pair rotalari hasOwn + SYMBOL_RE kullanir, __proto__ parite sayilmaz', () => {
  assert.match(serverSrc, /function pairFromParam/);
  assert.doesNotMatch(serverSrc, /decodeURIComponent\(req\.params\.symbol\)/);
  assert.match(serverSrc, /hasOwnProperty\.call\(state\.pairs, symbol\)/);
});
test('server: canli modda portfolioPolicy de yeniden dogrulama ister; kill switch/maxTrade 0 yapilamaz', () => {
  assert.match(serverSrc, /LIVE_RISK_KEYS = \[[^\]]*'portfolioPolicy'/);
  assert.match(serverSrc, /effectiveMode === 'live' && \(effectiveKillSwitch === 0 \|\| effectiveMaxTradeQuote === 0\)/);
});
test('server: /api/health kimliksiz (Docker HEALTHCHECK) ama ayrintilar oturumlu', () => {
  assert.match(serverSrc, /req\.path === '\/health'/);
  assert.match(serverSrc, /if \(!authed\) return res\.status\(healthy \? 200 : 503\)\.json\(\{ ok: healthy, service: 'al-sat-bot' \}\)/);
});
test('server: WebSocket upgrade Origin kontrolu yapar; trust proxy hop sayisiyla sinirli', () => {
  assert.match(serverSrc, /req\.headers\.origin && !sameOrigin\(req, req\.headers\.origin\)/);
  assert.doesNotMatch(serverSrc, /app\.set\('trust proxy', true\)/);
});
test('server: duz maxConcurrentPositions yamasi politikaya yansitilir', () => {
  assert.match(serverSrc, /clean\.maxConcurrentPositions !== undefined \|\| clean\.reserveCashPct !== undefined/);
});
test('server: CSV hucreleri formul enjeksiyonuna karsi etkisizlestirilir', () => {
  assert.match(serverSrc, /typeof v === 'string' && \/\^\[=\+/);
});
test('compose.vps: port yalnizca loopback', () => {
  const c = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.vps.yml'), 'utf8');
  assert.match(c, /"127\.0\.0\.1:8787:8787"/);
  assert.doesNotMatch(c, /^\s*-\s*"8787:8787"/m);
});

// ---------- auth ----------
test('auth: x-forwarded-proto basligi taklit edilerek Secure karari etkilenemez', () => {
  const req = { secure: false, headers: { 'x-forwarded-proto': 'https' } };
  assert.equal(auth.isSecureRequest(req), false);
  assert.equal(auth.isSecureRequest({ secure: true, headers: {} }), true);
});
test('auth: HTTPS istekte cıplak panel_session cerezi kabul edilmez (cookie tossing)', () => {
  const secureReq = { secure: true, headers: { cookie: 'panel_session=attacker' } };
  assert.equal(auth.tokenFromRequest(secureReq), null);
  assert.equal(auth.tokenFromRequest({ secure: true, headers: { cookie: '__Host-panel_session=ok' } }), 'ok');
  assert.equal(auth.tokenFromRequest({ secure: false, headers: { cookie: '__Host-panel_session=x' } }), null);
});

// ---------- vault ----------
test('vault: 12 karakterden kisa ana sifre reddedilir, kasa guclu KDF ile olusur', () => {
  vault.lock();
  assert.throws(() => vault.unlock('kisa123'), /en az 12/);
  assert.equal(vault.unlock('cok-uzun-ana-sifre-1').created, true);
  const f = JSON.parse(fs.readFileSync(path.join(TMP, 'credentials.enc.json'), 'utf8'));
  assert.ok(f.kdf && f.kdf.N >= 131072);
});
test('vault: anahtar kaydet/oku, yanlis sifre reddi, silince .bak icinde de kalmaz', () => {
  vault.saveExchangeKeys('binance', 'KEY-A', 'SECRET-A');
  vault.saveExchangeKeys('btcturk', 'KEY-B', 'SECRET-B');
  assert.deepEqual(vault.getExchangeKeys('binance'), { apiKey: 'KEY-A', apiSecret: 'SECRET-A' });
  vault.lock();
  assert.throws(() => vault.unlock('yanlis-sifre-123456'), /hatalı/);
  vault.unlock('cok-uzun-ana-sifre-1');
  vault.removeExchangeKeys('binance');
  assert.equal(vault.getExchangeKeys('binance'), null);
  const bak = path.join(TMP, 'credentials.enc.json.bak');
  assert.equal(fs.existsSync(bak), false, 'silinen anahtarin sifreli kopyasi .bak icinde kalmamali');
});
test('vault: AAD sayesinde bir borsanin sifreli anahtari baska borsaya tasinamaz', () => {
  const file = path.join(TMP, 'credentials.enc.json');
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  f.exchanges.paribu = f.exchanges.btcturk; // tasima saldirisi
  fs.writeFileSync(file, JSON.stringify(f));
  assert.throws(() => vault.getExchangeKeys('paribu'), /çözülemedi/);
  assert.deepEqual(vault.getExchangeKeys('btcturk'), { apiKey: 'KEY-B', apiSecret: 'SECRET-B' });
});
test('vault: eski (zayif KDF, AAD yok) kasa dogru sifreyle acilir ve otomatik yukseltilir', () => {
  vault.lock();
  const file = path.join(TMP, 'credentials.enc.json');
  fs.rmSync(file, { force: true });
  const pass = 'eski-kasa-sifresi-99';
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pass, salt, 32); // eski varsayilan parametreler
  const enc = (t) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const d = Buffer.concat([c.update(t, 'utf8'), c.final()]); return { iv: iv.toString('base64'), data: d.toString('base64'), tag: c.getAuthTag().toString('base64') }; };
  fs.writeFileSync(file, JSON.stringify({ salt: salt.toString('base64'), canary: enc('al-sat-vault-ok'), exchanges: { binance: { apiKey: enc('OLD-K'), apiSecret: enc('OLD-S'), savedAt: 'x' } } }));
  assert.equal(vault.unlock(pass).created, false);
  assert.deepEqual(vault.getExchangeKeys('binance'), { apiKey: 'OLD-K', apiSecret: 'OLD-S' });
  const up = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(up.kdf && up.kdf.N >= 131072, 'KDF yukseltilmeli');
  vault.lock();
  assert.equal(vault.unlock(pass).created, false);
  assert.deepEqual(vault.getExchangeKeys('binance'), { apiKey: 'OLD-K', apiSecret: 'OLD-S' });
  vault.lock();
});

// ---------- paper motoru ----------
const H = 3600000;
const quiet = (e) => { e.log = function (m, l = 'info') { this.state.log.unshift({ msg: m, level: l }); }; return e; };
const mkEngine = (state, exchange, nowFn) => quiet(new PaperEngine({ exchange, store: { save() {} }, state, nowFn }));

test('paper: saglikli turlardan sonra da saat-geri korumasi calisir (lastTickAt sifirlanmaz)', async () => {
  const T0 = Date.UTC(2026, 9, 1);
  const c = (i) => ({ t: T0 + i * H, o: 100, h: 100, l: 100, c: 100, v: 1 });
  const s = store.defaultState(); s.running = true; s.settings.dailyLossLimitPct = 100; s.settings.killSwitchLossPct = 0;
  s.pairs = { 'BTC/USDT': s.pairs['BTC/USDT'] };
  let now = T0 + 400 * H;
  const e = mkEngine(s, { quoteAssets: ['USDT'], fetchCandles: async () => Array.from({ length: 300 }, (_, i) => c(i + 100)), fetchSymbolRules: async () => ({ minNotional: 10 }) }, () => now);
  await e.tick();
  assert.notEqual(e.lastTickAt, null);
  now -= H;
  await e.tick();
  assert.equal(s.running, false);
  assert.match(s.killSwitch.reason, /saati geriye/);
});

test('paper: min-notional yukseltmesi kategori sermaye sinirini asamaz', async () => {
  const s = store.defaultState(); s.paper = store.defaultPaper(1000); s.settings.paperStartingBalance = 1000;
  s.settings.portfolioPolicy = { maxPositions: 5, reserveCashPct: 0, buckets: { core: { label: 'Ana', maxPositions: 0, maxCapitalPct: 0.5 }, speculative: { label: 'S', maxPositions: 0, maxCapitalPct: 100 } } };
  s.settings.reserveCashPct = 0; s.settings.maxConcurrentPositions = 5;
  s.pairs = { 'BTC/USDT': { ...s.pairs['BTC/USDT'], budgetPct: 0.4, portfolioClass: 'core' } };
  const e = mkEngine(s, { quoteAssets: ['USDT'], fetchSymbolRules: async () => ({ minNotional: 10, stepSize: 0 }) }, () => Date.now());
  e.ensureState();
  await e.tryBuy('BTC/USDT', s.pairs['BTC/USDT'], { reason: 't' }, { stopLossPct: 3 }, 100, 1, e.epoch);
  assert.equal(s.paper.positions['BTC/USDT'], undefined);
});

test('paper: gunluk zarar limiti asilmisken ve kill switch aktifken yeni giris acilmaz', async () => {
  const mk = () => {
    const s = store.defaultState(); s.paper = store.defaultPaper(1000);
    s.paper.dayStartEquity = 1000; s.paper.dayStartEquityByAsset = { USDT: 1000 }; s.paper.cashByAsset = { USDT: 900 }; s.paper.cash = 900;
    s.paper.dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
    s.settings.dailyLossLimitPct = 5; s.pairs = { 'BTC/USDT': { ...s.pairs['BTC/USDT'], budgetPct: 30 } };
    return s;
  };
  const ex = { quoteAssets: ['USDT'], fetchSymbolRules: async () => ({ minNotional: 10, stepSize: 0 }) };
  let s = mk(); let e = mkEngine(s, ex, () => Date.now()); e.ensureState();
  await e.tryBuy('BTC/USDT', s.pairs['BTC/USDT'], { reason: 't' }, { stopLossPct: 3 }, 100, 1, e.epoch);
  assert.equal(s.paper.positions['BTC/USDT'], undefined, 'gunluk limit asilmisken alim yapilmamali');
  s = mk(); s.settings.dailyLossLimitPct = 0; s.killSwitch = { t: 'x', reason: 'test' }; e = mkEngine(s, ex, () => Date.now()); e.ensureState();
  await e.tryBuy('BTC/USDT', s.pairs['BTC/USDT'], { reason: 't' }, { stopLossPct: 3 }, 100, 1, e.epoch);
  assert.equal(s.paper.positions['BTC/USDT'], undefined, 'kill switch aktifken alim yapilmamali');
});

test('paper: await sirasinda parite silinirse yetim pozisyon acilmaz', async () => {
  const s = store.defaultState(); s.paper = store.defaultPaper(1000);
  s.pairs = { 'BTC/USDT': { ...s.pairs['BTC/USDT'], budgetPct: 30 } };
  const pair = s.pairs['BTC/USDT'];
  const e = mkEngine(s, { quoteAssets: ['USDT'], fetchSymbolRules: async () => { delete s.pairs['BTC/USDT']; return { minNotional: 1, stepSize: 0 }; } }, () => Date.now());
  e.ensureState();
  await e.tryBuy('BTC/USDT', pair, { reason: 't' }, { stopLossPct: 3 }, 100, 1, e.epoch);
  assert.equal(s.paper.positions['BTC/USDT'], undefined);
});

// ---------- strateji, hostGuard, kilit ----------
test('strateji: borsanin verebildigi mum sayisini asan periyotlar reddedilir', () => {
  const id = 'rsi_ema_macd';
  const params = { ...strategies.get(id).defaultParams, emaSlow: 400 };
  assert.match(strategies.validateParams(id, params) || '', /mum gerektiriyor/);
  assert.equal(strategies.validateParams(id, strategies.get(id).defaultParams), null);
});
test('hostGuard: izinli host gecer, yabanci host/http/kullanici bilgisi reddedilir', () => {
  assert.doesNotThrow(() => assertAllowedUrl('https://api.btcturk.com/api/v1', ['btcturk.com'], 'X'));
  assert.throws(() => assertAllowedUrl('https://api.btcturk.com.evil.io/api/v1', ['btcturk.com'], 'X'), /izin verilen/);
  assert.throws(() => assertAllowedUrl('http://api.btcturk.com', ['btcturk.com'], 'X'), /izin verilen/);
  assert.throws(() => assertAllowedUrl('https://u:p@api.btcturk.com', ['btcturk.com'], 'X'), /kullanıcı bilgisi/);
  assert.throws(() => assertAllowedUrl('ws://ws-api.binance.com', ['binance.com'], 'X', { protocols: ['wss:'] }), /izin verilen/);
});
test('instanceLock: canlı ve farklı host kilitlerini reddeder; aynı hosttaki ölü PID kilidini güvenle devralır', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  const a = acquireInstanceLock(dir, { pid: process.pid, host: os.hostname() });
  assert.throws(() => acquireInstanceLock(dir, { pid: 999999, host: os.hostname() }), /kilitli/);
  a.release();
  fs.writeFileSync(path.join(dir, 'bot.lock'), JSON.stringify({ pid: 2147483000, host: os.hostname(), token: 'old' }));
  const recovered = acquireInstanceLock(dir, { pid: process.pid, host: os.hostname() });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bot.lock'), 'utf8')).token, recovered.token);
  recovered.release();
  fs.writeFileSync(path.join(dir, 'bot.lock'), JSON.stringify({ pid: 1, host: 'another-container', token: 'foreign' }));
  assert.throws(() => acquireInstanceLock(dir, { pid: 999999, host: os.hostname() }), /başka host\/container/);
  fs.rmSync(path.join(dir, 'bot.lock'));
  const b = acquireInstanceLock(dir, { pid: process.pid, host: os.hostname() });
  b.release();
});
