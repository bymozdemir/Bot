'use strict';
// Calisma isaretcisi (nabiz), onceki kapanisin birlestirilmesi, acilis mesajinda kesinti suresi,
// gunluk ozette bekleyen bildirim uyarisi ve hatali sifre uyarisi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntimeMarker, combineShutdown } = require('../src/runtimeMarker');
const { createLoginAlert } = require('../src/loginAlert');
const fmt = require('../src/notifyFormat');
const { createTelegramCommands } = require('../src/telegramCommands');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));

test('runtimeMarker: ilk acilis, temiz kapanis ve ani kesinti ayirt edilir; kesinti suresi son nabizdan hesaplanir', () => {
  const dir = tmp();
  let t = Date.parse('2026-10-18T10:00:00Z');
  const m1 = createRuntimeMarker({ dataDir: dir, nowFn: () => t });
  const b1 = m1.boot();
  assert.equal(b1.previous, null);
  assert.equal(b1.downtimeMs, 0);
  t += 5 * 60000; m1.heartbeat();
  // ani kesinti: markClean cagrilmadan yeni surec
  t += 12 * 60000;
  const m2 = createRuntimeMarker({ dataDir: dir, nowFn: () => t });
  const b2 = m2.boot();
  assert.equal(b2.previous.cleanExit, false);
  assert.equal(b2.previous.lastAliveAt, Date.parse('2026-10-18T10:05:00Z'));
  assert.equal(b2.downtimeMs, 12 * 60000);
  // temiz kapanis
  t += 60000; m2.markClean();
  t += 3 * 3600000;
  const b3 = createRuntimeMarker({ dataDir: dir, nowFn: () => t }).boot();
  assert.equal(b3.previous.cleanExit, true);
  assert.equal(b3.downtimeMs, 3 * 3600000);
});

test('runtimeMarker: bozuk dosya ve yazilamayan klasor botu dusurmez', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'runtime-marker.json'), '{bozuk');
  assert.equal(createRuntimeMarker({ dataDir: dir }).boot().previous, null);
  const bad = createRuntimeMarker({ dataDir: path.join(dir, 'runtime-marker.json', 'x') });
  assert.doesNotThrow(() => { bad.boot(); bad.heartbeat(); bad.markClean(); });
  // boot() cagrilmadan heartbeat/markClean sessizce hicbir sey yapmaz
  const idle = createRuntimeMarker({ dataDir: tmp() });
  assert.doesNotThrow(() => { idle.heartbeat(); idle.markClean(); });
  assert.equal(fs.existsSync(idle.file), false);
});

test('runtimeMarker: dosya 0600 izinle ve gecici dosya birakmadan yazilir', () => {
  const dir = tmp();
  const m = createRuntimeMarker({ dataDir: dir });
  m.boot(); m.heartbeat(); m.markClean();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('runtime-marker')), ['runtime-marker.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
});

test('combineShutdown: biri bile beklenmedik diyorsa beklenmedik; ikisinde de gecmis yoksa ilk acilis', () => {
  assert.equal(combineShutdown('first', null), 'first');
  assert.equal(combineShutdown('clean', null), 'clean', 'isaretci dosyasi yeni eklendi (guncelleme sonrasi ilk acilis)');
  assert.equal(combineShutdown('first', { cleanExit: true }), 'clean', 'state.json silinmis ama isaretci var');
  assert.equal(combineShutdown('clean', { cleanExit: true }), 'clean');
  assert.equal(combineShutdown('unexpected', { cleanExit: true }), 'unexpected');
  assert.equal(combineShutdown('clean', { cleanExit: false }), 'unexpected');
  assert.equal(combineShutdown('first', { cleanExit: false }), 'unexpected');
  assert.equal(combineShutdown('unexpected', null), 'unexpected');
});

const AT = Date.parse('2026-10-20T09:00:00Z');

test('bootMessage: lastAliveAt verilince son aktif zaman ve kesinti/kapali kalma suresi yazilir', () => {
  const last = AT - (95 * 60000);
  const unexpected = fmt.bootMessage({ mode: 'paper', exchange: 'binance', running: true, previousShutdown: 'unexpected', lastAliveAt: last, at: AT });
  assert.match(unexpected, /Son aktif: .* \| kesinti ≈ 1s 35dk/);
  const clean = fmt.bootMessage({ mode: 'paper', exchange: 'binance', running: false, previousShutdown: 'clean', lastAliveAt: last, at: AT });
  assert.match(clean, /Son aktif: .* \| kapalı kalma: 1s 35dk/);
});

test('bootMessage: ilk acilista veya lastAliveAt yoksa "Son aktif" satiri cikmaz (eski cikti ayni kalir)', () => {
  assert.doesNotMatch(fmt.bootMessage({ mode: 'paper', previousShutdown: 'first', lastAliveAt: AT - 60000, at: AT }), /Son aktif/);
  assert.doesNotMatch(fmt.bootMessage({ mode: 'paper', previousShutdown: 'clean', at: AT }), /Son aktif/);
  assert.doesNotMatch(fmt.bootMessage({ mode: 'paper', previousShutdown: 'clean', lastAliveAt: null, at: AT }), /Son aktif/);
});

const SUMMARY = { mode: 'paper', running: true, quoteAsset: 'USDT', dayLabel: '20.10.26', todayTrades: 0, todayWins: 0, todayPnl: 0, totalTrades: 0, winRate: 0, positions: [], errorCount: 0, warnCount: 0 };

test('gunluk ozet: bekleyen kritik bildirim varsa uyari satiri, yoksa yok', () => {
  assert.match(fmt.dailySummary({ ...SUMMARY, notifyPending: 2 }), /Gönderilemeyen kritik bildirim bekliyor: 2/);
  assert.doesNotMatch(fmt.dailySummary({ ...SUMMARY, notifyPending: 0 }), /Gönderilemeyen/);
  assert.doesNotMatch(fmt.dailySummary(SUMMARY), /Gönderilemeyen/);
});

test('/ayarlar: bekleyen kritik bildirim sayisi gosterilir', async () => {
  const requests = [];
  const fetchFn = async (url, opts) => { requests.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }; };
  const mk = (info) => createTelegramCommands({
    env: { TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: '42' }, fetchFn, logger: { log() {}, warn() {} },
    getStatus: () => ({ mode: 'paper', exchange: 'binance', quoteAsset: 'USDT', settings: {}, pairs: {} }), getNotifyInfo: () => info
  });
  const say = async (bot, text) => { await bot.processUpdate({ message: { chat: { id: 42 }, text } }); return requests.at(-1); };
  assert.match((await say(mk({ telegram: true, pending: 3 }), '/ayarlar')).text, /3 kritik bildirim bekliyor/);
  assert.doesNotMatch((await say(mk({ telegram: true, pending: 0 }), '/ayarlar')).text, /kritik bildirim bekliyor/);
});

test('hatali sifre uyarisi: ayni 10 dakikada tek mesaj, sayac son 10 dakikayi sayar, bildirim hatasi akisi bozmaz', async () => {
  const sent = [];
  let t = 1_700_000_000_000;
  const seenKeys = new Map();
  // notifier.send'in key/minIntervalMs davranisini taklit eden kucuk sahte
  const notifier = {
    send: async (text, opts) => {
      const last = seenKeys.get(opts.key);
      if (last !== undefined && t - last < opts.minIntervalMs) return { skipped: true };
      seenKeys.set(opts.key, t);
      sent.push({ text, opts });
      return { telegram: true };
    }
  };
  const alert = createLoginAlert({ notifier, now: () => t });
  await alert(); t += 1000; await alert(); t += 1000; await alert();
  assert.equal(sent.length, 1, '10 dakikada tek mesaj');
  assert.match(sent[0].text, /Panele hatalı şifre denemesi \(son 10 dk: 1\)/);
  assert.equal(sent[0].opts.priority, 'normal');
  t += 11 * 60000; // pencere doldu: eski denemeler sayilmaz
  await alert();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /son 10 dk: 1\)/);

  const boom = createLoginAlert({ notifier: { send: async () => { throw new Error('ag yok'); } } });
  await assert.doesNotReject(boom());
  const none = createLoginAlert({});
  await assert.doesNotReject(none());
});
