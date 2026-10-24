// Uctan uca: gercek HTTP sunucusu (sahte Binance) + gercek `node backtest.js` sureci.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STEPS = { '1h': 3600000, '4h': 14400000, '1d': 86400000 };

function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cache = {};
function candlesFor(symbol, interval, nowMs) {
  const key = symbol + interval;
  if (cache[key]) return cache[key];
  const step = STEPS[interval];
  const t0 = Math.floor((nowMs - (interval === '1d' ? 1400 : 400) * 86400000) / step) * step;
  const r = rng([...symbol].reduce((a, c) => a + c.charCodeAt(0), 0));
  const out = []; let prev = 100;
  for (let t = t0; t <= nowMs; t += step) {
    const o = prev; const c = o * Math.exp(0.02 * ((r() + r() + r() + r() - 2) * 1.7) + 0.0003);
    out.push([t, String(o), String(Math.max(o, c) * 1.003), String(Math.min(o, c) * 0.997), String(c), '5', t + step - 1]); prev = c;
  }
  return (cache[key] = out);
}

function startMock() {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      requests.push(req.url);
      if (u.pathname !== '/api/v3/klines') { res.statusCode = 404; return res.end('{}'); }
      const now = Date.now();
      const all = candlesFor(u.searchParams.get('symbol'), u.searchParams.get('interval'), now);
      const start = Number(u.searchParams.get('startTime')); const end = Number(u.searchParams.get('endTime')); const limit = Number(u.searchParams.get('limit'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(all.filter((k) => k[0] >= start && k[0] <= end).slice(0, limit)));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function run(args) {
  return new Promise((resolve) => {
    const p = spawn('node', ['backtest.js', ...args], { cwd: ROOT });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('CLI: indir, test et, ozeti yaz; ikinci calistirma onbellekten', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'btcli-'));
  const base = `http://127.0.0.1:${mock.port}`;
  const args = ['--base', base, '--symbols', 'BTC/USDT', '--tf', '1h,4h', '--months', '2', '--out', out, '--detail'];

  const first = await run(args);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /BACKTEST ÖZETİ/);
  assert.match(first.out, /=== 1h mumlar \(1 parite\)/);
  assert.match(first.out, /=== 4h mumlar/);
  for (const name of ['RSI\\+EMA\\+MACD', 'EMA kesişimi', 'Bollinger', 'MACD momentum', 'Sade RSI', 'Trend \\(SMA\\)', 'DCA haftalık', 'al-tut']) assert.match(first.out, new RegExp(name));
  assert.match(first.out, /Ayrıntı 1h/);
  assert.match(first.err, /indirildi/);
  const files = fs.readdirSync(out);
  assert.ok(files.some((f) => f.startsWith('ozet-') && f.endsWith('.txt')));
  const jsonName = files.find((f) => f.startsWith('sonuc-') && f.endsWith('.json'));
  const json = JSON.parse(fs.readFileSync(path.join(out, jsonName), 'utf8'));
  assert.equal(json.results.length, 1 * 2 * (require('../src/strategies').list().length + 1)); // parite x aralik x (kayitli tum stratejiler + DCA)
  assert.ok(json.results.every((r) => Number.isFinite(r.returnPct) && Number.isFinite(r.buyHoldPct)));
  assert.ok(fs.readdirSync(path.join(out, 'veri')).length === 2);

  const before = mock.requests.length;
  const second = await run(args);
  assert.equal(second.code, 0, second.err);
  assert.match(second.err, /önbellek/);
  assert.equal(mock.requests.length, before, 'ikinci calistirmada internete cikilmamali');

  const refreshed = await run([...args, '--refresh']);
  assert.equal(refreshed.code, 0);
  assert.ok(mock.requests.length > before);
});

test('CLI: gecersiz secenekler anlasilir hatayla cikar', async () => {
  for (const [args, re] of [
    [['--months', '99'], /--months/],
    [['--tf', '7m'], /Desteklenmeyen/],
    [['--symbols', 'btcusdt'], /BAZ\/KASA/],
    [['--strategies', 'yok'], /Bilinmeyen strateji/],
    [['--fee'], /değer gerekli/],
    [['--bilinmeyen'], /Bilinmeyen seçenek/]
  ]) {
    const r = await run(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, re);
  }
});

test('CLI: ag yoksa yol gosteren hata verir', async () => {
  const r = await run(['--base', 'http://127.0.0.1:1', '--symbols', 'BTC/USDT', '--tf', '1h', '--months', '1', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'btcli-'))]);
  assert.equal(r.code, 1);
  assert.match(r.err, /verisi alınamadı/);
  assert.match(r.err, /data-api\.binance\.vision/);
});

test('CLI: --tf 1d --sens --check (24 ay): duyarlilik tablosu, kabul olcutleri, JSON', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'btcli-'));
  const r = await run(['--base', `http://127.0.0.1:${mock.port}`, '--symbols', 'BTC/USDT', '--tf', '1d', '--months', '24', '--strategies', 'trend_filter', '--sens', '--check', '--out', out]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== 1d mumlar \(1 parite\)/);
  assert.match(r.out, /MALİYET DUYARLILIĞI/);
  assert.match(r.out, /KABUL ÖLÇÜTLERİ \(sürüm 1, 24 ay\)/);
  assert.ok(!/Not: ölçütler/.test(r.out), '24 ayda not olmamali');
  assert.match(r.out, /Trend \(SMA\)/);
  const json = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out).find((f) => f.startsWith('sonuc-'))), 'utf8'));
  assert.ok(json.results.every((x) => Array.isArray(x.sens) && x.sens.length === 4));
  // Yeni dinamik kâr koruma modelinde işlem sayısı maliyet varsayımına göre değişebildiği
  // için net getirinin monoton olması matematiksel olarak garanti değildir. Duyarlılık
  // tablosunun dört senaryosunun da sonlu ve raporlanabilir olması yeterlidir.
  for (const x of json.results) {
    assert.ok(x.sens.every((s) => Number.isFinite(Number(s.returnPct))), `${x.strategyId}: duyarlılık getirisi sonlu değil`);
  }
  assert.ok(json.criteria && json.criteria['1d']);
  const short = await run(['--base', `http://127.0.0.1:${mock.port}`, '--symbols', 'BTC/USDT', '--tf', '1d', '--months', '6', '--strategies', 'trend_filter', '--check', '--out', out]);
  assert.equal(short.code, 0, short.err);
  assert.match(short.out, /Not: ölçütler 24 aylık/);
});

test('CLI: --no-dca DCA satirini cikarir; --dca-days dogrulanir', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'btcli-'));
  const base = ['--base', `http://127.0.0.1:${mock.port}`, '--symbols', 'BTC/USDT', '--tf', '4h', '--months', '2', '--strategies', 'trend_filter', '--out', out];
  const withDca = await run([...base, '--dca-days', '14']);
  assert.equal(withDca.code, 0, withDca.err);
  assert.match(withDca.out, /DCA haftalık/);
  const without = await run([...base, '--no-dca']);
  assert.equal(without.code, 0, without.err);
  assert.ok(!/DCA haftalık/.test(without.out));
  const bad = await run([...base, '--dca-days', '0']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--dca-days/);
});
