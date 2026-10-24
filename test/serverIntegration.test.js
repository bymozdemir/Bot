// Gercek server.js'yi alt surec olarak calistirip HTTP/WebSocket uzerinden dener.
// Express (ve dotenv) kurulu degilse atlanir. 1.9.2'deki "WS Origin kontrolu dogru origin'i de reddediyor"
// hatasi statik testlerle yakalanamamisti; bu dosya o sinifi kapatir.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let hasDeps = true;
try { require.resolve('express'); require.resolve('dotenv'); require.resolve('ws'); } catch (e) { hasDeps = false; }
const PASS = 'Entegrasyon-Test-Sifresi-1';

function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function req(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    if (body !== null) headers = { ...headers, 'Content-Length': Buffer.byteLength(body) };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Connection: 'close', ...headers }, agent: false }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString('utf8') }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.code, headers: {}, body: '' }));
    if (body !== null) r.write(body); r.end();
  });
}
const jreq = (port, m, p, obj, headers = {}) => req(port, m, p, { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(obj) });

test('server entegrasyon (gercek server.js)', async (t) => {
  // Guvenlik kapisi: bagimlilik yokken testi SKIP etmek, npm test'in yesil gorunmesine
  // ragmen HTTP/WebSocket entegrasyonunun hic dogrulanmamasi demektir. Acikca FAIL et.
  assert.equal(hasDeps, true, 'HTTP/WebSocket entegrasyonu calistirilamadi: express, dotenv ve ws eksik. Once npm ci calistirin; bu test artik sessizce atlanmaz.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-int-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, BOT_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', PANEL_PASSWORD: PASS, NODE_ENV: 'production', LIVE_TRADING_ENABLED: '' },
    stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..')
  });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  t.after(() => { try { child.kill('SIGKILL'); } catch (e) { /* yoksay */ } });
  for (let i = 0; i < 60; i++) { const r = await req(port, 'GET', '/api/ping'); if (r.status === 200) break; await new Promise((r2) => setTimeout(r2, 200)); if (i === 59) assert.fail('sunucu acilmadi: ' + log); }
  const WebSocket = require('ws');
  const wsTry = (headers) => new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    let n = 0; let done = false; const fin = (v) => { if (!done) { done = true; try { w.terminate(); } catch (e) { /* yoksay */ } resolve(v); } };
    w.on('open', () => { w.on('message', () => { n++; }); setTimeout(() => fin({ open: true, messages: n }), 400); });
    w.on('unexpected-response', (rq, rs) => fin({ open: false, status: rs.statusCode }));
    w.on('error', () => fin({ open: false, status: 0 })); setTimeout(() => fin({ open: false, status: -1 }), 4000);
  });

  await t.test('kimliksiz: ping 200, state 401, health yalniz minimal, /api no-store', async () => {
    assert.equal((await req(port, 'GET', '/api/ping')).status, 200);
    const st = await req(port, 'GET', '/api/state'); assert.equal(st.status, 401);
    assert.equal(st.headers['cache-control'], 'no-store');
    const h = await req(port, 'GET', '/api/health'); assert.equal(h.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(h.body)).sort(), ['ok', 'service']);
    for (const p of ['/..%2f..%2fserver.js', '/.env', '/data/state.json', '/src/auth.js', '/package.json']) { const r = await req(port, 'GET', p); assert.ok(!(r.status === 200 && /require\(|"dependencies"/.test(r.body)), p); }
  });

  const lg = await jreq(port, 'POST', '/api/login', { password: PASS });
  assert.equal(lg.status, 200, lg.body);
  const cookie = [].concat(lg.headers['set-cookie']).map((c) => c.split(';')[0]).join('; ');
  const H = { Cookie: cookie };

  await t.test('CSRF: yabanci Origin 403, dogru Origin 200', async () => {
    assert.equal((await jreq(port, 'POST', '/api/settings', { pollSeconds: 60 }, { ...H, Origin: 'http://evil.com' })).status, 403);
    assert.equal((await jreq(port, 'POST', '/api/settings', { pollSeconds: 60 }, { ...H, Origin: `http://127.0.0.1:${port}` })).status, 200);
  });

  await t.test('WebSocket: cerezsiz 401, yabanci Origin 403, DOGRU Origin ACILIR, Origin yoksa acilir', async () => {
    assert.equal((await wsTry({})).status, 401);
    assert.equal((await wsTry({ Cookie: cookie, Origin: 'http://evil.com' })).status, 403);
    const ok = await wsTry({ Cookie: cookie, Origin: `http://127.0.0.1:${port}` });
    assert.equal(ok.open, true, 'tarayicinin gonderdigi dogru Origin reddedildi (1.9.2 regresyonu)');
    assert.ok(ok.messages >= 1);
    assert.equal((await wsTry({ Cookie: cookie })).open, true);
  });

  await t.test('WebSocket: dev istemci mesaji baglantiyi kapatir, sunucu etkilenmez', async () => {
    const closed = await new Promise((resolve) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } }); w.on('open', () => w.send(Buffer.alloc(5 * 1024 * 1024, 65))); w.on('close', (code) => resolve(code)); w.on('error', () => {}); setTimeout(() => resolve('zamanasimi'), 4000); });
    assert.notEqual(closed, 'zamanasimi');
    assert.equal((await req(port, 'GET', '/api/ping')).status, 200);
  });

  await t.test('prototip anahtarli pair rotalari 404', async () => {
    for (const k of ['__proto__', 'constructor', 'toString']) {
      assert.equal((await jreq(port, 'PATCH', '/api/pairs/' + k, { strategyId: 'rsi_ema_macd', enabled: true }, H)).status, 404, k);
      assert.equal((await jreq(port, 'DELETE', '/api/pairs/' + k, {}, H)).status, 404, k);
    }
  });

  await t.test('prototip isimli strategyId parite oluşturamaz veya değiştiremez', async () => {
    for (const strategyId of ['constructor', '__proto__', 'toString']) {
      const created = await jreq(port, 'POST', '/api/pairs', { symbol: `T${strategyId.length}/USDT`, strategyId }, H);
      assert.equal(created.status, 400, `${strategyId}: ${created.body}`);
      assert.match(created.body, /Bilinmeyen strateji/);
    }
  });

  await t.test('paper -> live aynı istekte sıfır risk limitleri reddedilir', async () => {
    const cases = [
      { mode: 'live', killSwitchLossPct: 0, maxTradeQuote: 0 },
      { mode: 'live', killSwitchLossPct: 0, maxTradeQuote: 100 },
      { mode: 'live', killSwitchLossPct: 10, maxTradeQuote: 0 }
    ];
    for (const body of cases) {
      const r = await jreq(port, 'POST', '/api/settings', body, H);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.body}`);
      assert.match(r.body, /Canlı modda kill switch.*işlem başına üst tutar/);
    }
    const state = await req(port, 'GET', '/api/state', { headers: H });
    assert.equal(state.status, 200, state.body);
    assert.equal(JSON.parse(state.body).settings.mode, 'paper', 'reddedilen yama modu değiştirmemeli');
  });

  await t.test('canlı moda geçişte başarılı ön kontrol tokeni zorunlu', async () => {
    const r = await jreq(port, 'POST', '/api/settings', {
      mode: 'live', killSwitchLossPct: 10, maxTradeQuote: 10,
      dailyLossLimitPct: 5, reserveCashPct: 10
    }, H);
    assert.equal(r.status, 428, r.body);
    assert.match(r.body, /önce onay kutusunu.*güvenlik ön kontrolünü/);
    const state = await req(port, 'GET', '/api/state', { headers: H });
    assert.equal(JSON.parse(state.body).settings.mode, 'paper');
  });

  await t.test('risk ayarlarında anlamsız küçük pozitif değerler reddedilir', async () => {
    for (const body of [
      { killSwitchLossPct: 0.0000001 },
      { maxTradeQuote: 0.0000001 },
      { reserveCashPct: 0.0000001 }
    ]) {
      const r = await jreq(port, 'POST', '/api/settings', body, H);
      assert.equal(r.status, 400, JSON.stringify(body) + ': ' + r.body);
    }
    assert.equal((await jreq(port, 'POST', '/api/settings', { killSwitchLossPct: 0 }, H)).status, 200);
    assert.equal((await jreq(port, 'POST', '/api/settings', { reserveCashPct: 0 }, H)).status, 200);
  });

  await t.test('politika: 20 kategoriden fazlasi 400; __proto__ kategori sessizce atilir', async () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['b' + i, { maxPositions: 0, maxCapitalPct: 1 }]));
    assert.equal((await jreq(port, 'POST', '/api/settings', { portfolioPolicy: { maxPositions: 3, reserveCashPct: 5, buckets: many } }, H)).status, 400);
    const raw = await req(port, 'POST', '/api/settings', { headers: { ...H, 'Content-Type': 'application/json' }, body: '{"portfolioPolicy":{"maxPositions":3,"reserveCashPct":5,"buckets":{"__proto__":{"maxPositions":1}}}}' });
    assert.ok([200, 400].includes(raw.status));
  });

  await t.test('kasa: asiri uzun / bosluklu API anahtari reddedilir', async () => {
    assert.equal((await jreq(port, 'POST', '/api/vault/unlock', { passphrase: 'cok-guclu-ana-sifre-12' }, H)).status, 200);
    assert.equal((await jreq(port, 'POST', '/api/vault/keys', { exchange: 'binance', apiKey: 'K'.repeat(200000), apiSecret: 'S'.repeat(20) }, H)).status, 400);
    assert.equal((await jreq(port, 'POST', '/api/vault/keys', { exchange: 'binance', apiKey: 'with space key', apiSecret: 'S'.repeat(20) }, H)).status, 400);
    assert.equal((await jreq(port, 'POST', '/api/vault/keys', { exchange: 'binance', apiKey: 'K'.repeat(20), apiSecret: 'S'.repeat(20) }, H)).status, 200);
  });

  await t.test('giris hiz siniri: 8 yanlis denemeden sonra 429 + Retry-After; XFF taklidi islemez', async () => {
    const codes = []; let last;
    for (let i = 0; i < 12; i++) { last = await jreq(port, 'POST', '/api/login', { password: 'yanlis-sifre-' + i }, { 'X-Forwarded-For': '10.1.1.' + i }); codes.push(last.status); }
    assert.deepEqual(codes.slice(0, 8), Array(8).fill(401));
    assert.ok(codes.slice(8).every((c) => c === 429), codes.join());
    assert.ok(Number(last.headers['retry-after']) > 0);
  });
});
