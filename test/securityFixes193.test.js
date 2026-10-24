// 1.9.3 denetim duzeltmeleri icin birim regresyon testleri.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sec193-'));
process.env.BOT_DATA_DIR = TMP;
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const serverSrc = read('server.js');

const auth = require('../src/auth');
const { BinanceUserDataStream } = require('../src/userDataStream');
const { OrderManager } = require('../src/orderManager');

// ---------- auth: ham upgrade istekleri ----------
test('auth.isSecureRequest: ham upgrade isteginde (req.secure yok) TRUST_PROXY=true ile XFP dikkate alinir', () => {
  const old = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(auth.isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), false, 'guvenilmeyen proxy: baslik yok sayilmali');
    process.env.TRUST_PROXY = 'true';
    assert.equal(auth.isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), true);
    assert.equal(auth.isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }), false);
    assert.equal(auth.isSecureRequest({ secure: false, headers: { 'x-forwarded-proto': 'https' } }), false, 'Express req.secure=false ise baslik yok sayilir');
    assert.equal(auth.isSecureRequest({ secure: true, headers: {} }), true);
    assert.equal(auth.isSecureRequest({ socket: { encrypted: true }, headers: {} }), true);
  } finally { if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old; }
});
test('HTTPS proxy arkasinda ham upgrade istegi __Host- cerezinden oturumu bulur', async () => {
  const old = process.env.TRUST_PROXY; process.env.TRUST_PROXY = 'true';
  try {
    auth.setPassword('cok-guclu-panel-sifresi-1');
    const { token } = await auth.loginAsync('cok-guclu-panel-sifresi-1');
    const req = { headers: { 'x-forwarded-proto': 'https', cookie: `__Host-panel_session=${token}` } };
    assert.ok(auth.sessionFromRequest(req));
  } finally { if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old; }
});

// ---------- auth: async dogrulama ----------
test('auth.loginAsync/reauthenticateAsync dogru calisir, yanlis sifreyi reddeder', async () => {
  auth.setPassword('cok-guclu-panel-sifresi-1');
  assert.equal(await auth.loginAsync('yanlis-sifre-yanlis'), null);
  assert.equal(await auth.loginAsync(['dizi']), null);
  assert.equal(await auth.loginAsync('x'.repeat(1000)), null);
  const s = await auth.loginAsync('cok-guclu-panel-sifresi-1');
  assert.ok(s && s.token);
  assert.equal(await auth.reauthenticateAsync(s.token, 'yanlis-sifre-yanlis'), false);
  assert.equal(await auth.reauthenticateAsync(s.token, 'cok-guclu-panel-sifresi-1'), true);
  assert.equal(await auth.reauthenticateAsync('yok-token', 'cok-guclu-panel-sifresi-1'), false);
});
test('auth: async dogrulama olay dongusunu bloke etmez (sync scrypt alti istekte yuzlerce ms bloke ederdi)', async () => {
  auth.setPassword('cok-guclu-panel-sifresi-1');
  let maxGap = 0; let last = Date.now();
  const timer = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 5);
  await Promise.all(Array.from({ length: 6 }, (_, i) => auth.loginAsync('yanlis-' + i + '-sifre-xx')));
  clearInterval(timer);
  // Paylasilan CI/Termux ortaminda scheduler jitter olabilir; alti seri sync scrypt yine >250ms bloklar.
  assert.ok(maxGap < 250, `olay dongusu ${maxGap}ms bloke oldu`);
});
test('auth: dogrulama kuyrugu dolunca 503 (busy) verir, sistem kilitlenmez', async () => {
  auth.setPassword('cok-guclu-panel-sifresi-1');
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => auth.verifyPasswordAsync('yanlis-' + i + '-sifre-xx', JSON.parse(fs.readFileSync(auth.AUTH_FILE, 'utf8')).password || JSON.parse(fs.readFileSync(auth.AUTH_FILE, 'utf8')))));
  const busy = results.filter((r) => r.status === 'rejected' && r.reason && r.reason.busy).length;
  assert.ok(busy > 0, 'kuyruk siniri hic devreye girmedi');
  assert.ok(results.some((r) => r.status === 'fulfilled'));
});
test('auth: eszamanli oturum sayisi sinirli (en eski atilir)', async () => {
  auth.setPassword('cok-guclu-panel-sifresi-1');
  const first = await auth.loginAsync('cok-guclu-panel-sifresi-1');
  for (let i = 0; i < 25; i++) auth.login('cok-guclu-panel-sifresi-1');
  assert.equal(auth.getSession(first.token), null);
});

// ---------- server.js statik kontroller ----------
test('server: sameOrigin ham upgrade istegi icin req.headers.host kullanir (req.get yok)', () => {
  const fn = serverSrc.slice(serverSrc.indexOf('function sameOrigin'));
  assert.match(fn.slice(0, 600), /req\.headers && req\.headers\.host/);
  assert.doesNotMatch(fn.slice(0, 600), /req\.get\('host'\)/);
});
test('server: login/reauth async, deneme dogrulamadan ONCE sayilir, Retry-After verir', () => {
  assert.match(serverSrc, /app\.post\('\/api\/login', async/);
  assert.match(serverSrc, /auth\.loginAsync/);
  assert.match(serverSrc, /auth\.reauthenticateAsync/);
  assert.match(serverSrc, /loginLimiter\.fail\(key\);\s*\n\s*try \{\s*\n\s*const result = await/);
  assert.match(serverSrc, /Retry-After/);
});
test('server: /api yanitlari no-store; WS maxPayload kucuk, istemci sayisi sinirli; maxConnections yok', () => {
  assert.match(serverSrc, /setHeader\('Cache-Control', 'no-store'\)/);
  assert.match(serverSrc, /maxPayload: 1024/);
  assert.match(serverSrc, /MAX_WS_CLIENTS = 16/);
  assert.doesNotMatch(serverSrc, /server\.maxConnections\s*=/);
  assert.match(serverSrc, /server\.headersTimeout = 10000/);
});
test('server: borsa URL env degerleri (BinanceTR dahil) allowlist ile dogrulanir', () => {
  assert.match(serverSrc, /binancetr: \{ baseUrl: \['binance\.tr'\]/);
  assert.match(serverSrc, /envUrl\(exchangeId, 'baseUrl'/);
  assert.doesNotMatch(serverSrc, /baseUrl: process\.env\[`\$\{prefix\}_BASE_URL`\]/);
});
test('server: kasa anahtari uzunluk/karakter siniri; politika en fazla 20 kategori; pahali uclar sinirli', () => {
  assert.match(serverSrc, /8-512 karakter/);
  assert.match(serverSrc, /En fazla 20 portföy kategorisi/);
  for (const r of ['/api/live/preflight', '/api/backtest/quick', '/api/candles', '/api/scanner', '/api/analytics']) {
    const i = serverSrc.indexOf(`app.get('${r}'`);
    assert.ok(i > 0, r);
    assert.match(serverSrc.slice(i, i + 200), /expensiveOk\(req, res/, r);
  }
});

// ---------- dagitim dosyalari ----------
test('systemd: sistem unit root olarak calismaz (User=%i yok), sandbox direktifleri var', () => {
  const u = read('systemd/crypto-bot.service');
  assert.doesNotMatch(u.split('\n').filter((l) => !l.startsWith('#')).join('\n'), /User=%i/);
  assert.match(u, /^User=cryptobot$/m);
  for (const d of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'CapabilityBoundingSet=', 'RestrictAddressFamilies=', 'ReadWritePaths=/opt/crypto-bot/data']) assert.ok(u.includes(d), d);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'systemd/crypto-bot.user.service')));
});
test('compose: konteyner sertlestirilmis', () => {
  const c = read('docker-compose.yml');
  for (const d of ['read_only: true', 'cap_drop:', 'no-new-privileges:true', 'pids_limit']) assert.ok(c.includes(d), d);
});

// ---------- OrderManager: prototip anahtarli clientOrderId ----------
test('OrderManager: __proto__/constructor clientOrderId mevcut emir sayilmaz ve kaydedilmez', () => {
  const state = { liveOrders: {}, live: {}, settings: {} };
  const om = new OrderManager({ exchange: {}, state, store: { save() {} } });
  assert.equal(om.get('__proto__'), null);
  assert.equal(om.get('constructor'), null);
  assert.throws(() => om._record('__proto__', { status: 'NEW' }), /Geçersiz clientOrderId/);
  const r = om.applyExecutionReport({ e: 'executionReport', c: '__proto__', i: 1, s: 'BTCUSDT', X: 'FILLED', z: '1', q: '1', Z: '100' });
  assert.equal(r.handled, false);
  assert.equal(Object.getPrototypeOf(state.liveOrders), Object.prototype);
});

// ---------- User Data Stream zaman asimlari ----------
test('UDS: abonelik yaniti gelmezse zaman asimina ugrar ve connecting kilitlenmez', async () => {
  class SilentWS { constructor() { this.h = {}; this.terminated = false; queueMicrotask(() => this.h.open && this.h.open()); } on(n, f) { this.h[n] = f; } send() {} close() { this.h.close && this.h.close(); } terminate() { this.terminated = true; this.close(); } }
  const exchange = { createUserDataStreamSignature: () => ({ apiKey: 'K', timestamp: 1, recvWindow: 5000, signature: 'S' }), getUserDataWsUrl: () => 'wss://test' };
  const stream = new BinanceUserDataStream({ exchange, orderManager: { applyExecutionReport() {} }, state: {}, store: { save() {} }, WebSocketImpl: SilentWS, nowFn: () => 1, connectionRefreshMs: 0, subscribeTimeoutMs: 50, reconnectMs: 100000 });
  await assert.rejects(stream.start(), /zaman aşımı/);
  assert.equal(stream.connecting, false);
  await stream.stop();
});

test('kurulum betikleri .env ve data/ iznini sikilastirir; store data/ klasorunu 0700 olusturur', () => {
  for (const f of ['scripts/setup-vps.sh', 'scripts/setup-local.sh']) {
    const c = read(f);
    assert.match(c, /umask 077/, f);
    assert.match(c, /chmod 600 \.env/, f);
    assert.match(c, /chmod 700 data/, f);
  }
  assert.match(read('src/store.js'), /mkdirSync\(DATA_DIR, \{ recursive: true, mode: 0o700 \}\)/);
});
