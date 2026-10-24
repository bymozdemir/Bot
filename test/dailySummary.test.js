'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailySummary, parseTime } = require('../src/dailySummary');
const fmt = require('../src/notifyFormat');

const quiet = { warn() {}, log() {} };
const at = (d, h, m) => Date.UTC(2026, 9, d, h - 3, m); // Istanbul saati -> UTC ms
const data = () => ({ mode: 'paper', running: true, killSwitch: false, quoteAsset: 'USDT', dayLabel: '19.10.26', todayTrades: 2, todayWins: 1, todayPnl: 1.5, equity: 151.5, dayStartEquity: 150, startingBalance: 150, totalTrades: 5, winRate: 60, positions: [], errorCount: 0, warnCount: 0 });

function make({ env = {}, results = [{ telegram: true }], statusOverride } = {}) {
  let now = at(19, 10, 0);
  const sent = [];
  const saves = [];
  const state = { notifyMeta: { lastDailySummaryDay: null } };
  const notifier = {
    status: () => statusOverride || { telegram: true, termux: false },
    send: async (text, opts) => { sent.push({ text, opts }); return results[Math.min(sent.length - 1, results.length - 1)]; }
  };
  const ds = createDailySummary({ getData: data, notifier, state, store: { save: () => saves.push(1) }, env, nowFn: () => now, logger: quiet });
  return { ds, sent, saves, state, setNow: (v) => { now = v; } };
}

test('parseTime: gecerli HH:MM okunur, gecersiz deger 23:55 varsayilanina duser', () => {
  assert.equal(parseTime('21:30'), 21 * 60 + 30);
  assert.equal(parseTime('7:05'), 7 * 60 + 5);
  assert.equal(parseTime('25:00'), 23 * 60 + 55);
  assert.equal(parseTime('abc'), 23 * 60 + 55);
  assert.equal(parseTime(undefined), 23 * 60 + 55);
});

test('hedef saatten once gonderilmez; hedef saatte bir kez gonderilir ve ayni gun tekrarlanmaz', async () => {
  const { ds, sent, state, saves, setNow } = make();
  assert.equal(await ds.tick(), false);
  setNow(at(19, 23, 54)); assert.equal(await ds.tick(), false);
  setNow(at(19, 23, 55)); assert.equal(await ds.tick(), true);
  assert.equal(sent.length, 1);
  assert.equal(state.notifyMeta.lastDailySummaryDay, '2026-10-19');
  assert.equal(saves.length, 1);
  assert.equal(sent[0].opts.priority, 'quiet'); assert.equal(sent[0].opts.html, true);
  assert.match(sent[0].text, /GÜNLÜK ÖZET/);
  setNow(at(19, 23, 58)); assert.equal(await ds.tick(), false);
  assert.equal(sent.length, 1);
});

test('ertesi gun yeniden gonderilir; yeniden baslatma (kalici gun bilgisi) ayni gun ikinci ozet uretmez', async () => {
  const a = make();
  a.setNow(at(19, 23, 56)); await a.ds.tick();
  a.setNow(at(20, 23, 56)); assert.equal(await a.ds.tick(), true);
  assert.equal(a.sent.length, 2);
  // "yeniden baslatma": ayni state ile yeni zamanlayici
  const b = make();
  b.state.notifyMeta.lastDailySummaryDay = '2026-10-19';
  b.setNow(at(19, 23, 59)); assert.equal(await b.ds.tick(), false);
  assert.equal(b.sent.length, 0);
});

test('hedef saatten sonra acilan bot o gunun ozetini yine de gonderir (catch-up)', async () => {
  const { ds, sent, setNow } = make();
  setNow(at(19, 23, 58));
  assert.equal(await ds.tick(), true);
  assert.equal(sent.length, 1);
});

test('DAILY_SUMMARY=0 kapatir; DAILY_SUMMARY_TIME ozel saat verir', async () => {
  const off = make({ env: { DAILY_SUMMARY: '0' } });
  off.setNow(at(19, 23, 59)); assert.equal(await off.ds.tick(), false);
  assert.equal(off.ds.isEnabled(), false); assert.equal(off.ds.start(), false);
  const custom = make({ env: { DAILY_SUMMARY_TIME: '21:00' } });
  custom.setNow(at(19, 20, 59)); assert.equal(await custom.ds.tick(), false);
  custom.setNow(at(19, 21, 0)); assert.equal(await custom.ds.tick(), true);
  assert.equal(custom.ds.targetMinute, 21 * 60);
});

test('gonderim basarisizsa gun tamamlanmis sayilmaz ve sinirli sayida yeniden denenir', async () => {
  const { ds, sent, state, setNow } = make({ results: [{ telegram: false }, { telegram: false }, { telegram: true }] });
  setNow(at(19, 23, 56));
  assert.equal(await ds.tick(), false);
  assert.equal(state.notifyMeta.lastDailySummaryDay, null);
  assert.equal(await ds.tick(), false);
  assert.equal(await ds.tick(), true);
  assert.equal(sent.length, 3);
  const dead = make({ results: [{ telegram: false }] });
  dead.setNow(at(19, 23, 56));
  for (let i = 0; i < 10; i++) await dead.ds.tick();
  assert.equal(dead.sent.length, 4, 'gunde en fazla 4 deneme');
});

test('hic bildirim kanali yoksa ozet "gonderildi" sayilir (sonsuz deneme yok)', async () => {
  const { ds, state, setNow } = make({ results: [{}], statusOverride: { telegram: false, termux: false } });
  setNow(at(19, 23, 56));
  assert.equal(await ds.tick(), true);
  assert.equal(state.notifyMeta.lastDailySummaryDay, '2026-10-19');
});

test('ozet verisi uretilemezse tick hata firlatmaz', async () => {
  const state = { notifyMeta: {} };
  const ds = createDailySummary({ getData: () => { throw new Error('bozuk'); }, notifier: { status: () => ({ telegram: true }), send: async () => ({ telegram: true }) }, state, store: { save() {} }, nowFn: () => at(19, 23, 56), logger: quiet });
  assert.equal(await ds.tick(), false);
});

test('notifyFormat.dailySummary: acik pozisyon, hata sayisi, kill switch/kilit ve HTML escape', () => {
  const d = { ...data(), mode: 'live', killSwitch: true, safeToTrade: false, positions: [{ symbol: 'SOL/USDT', unrealizedPct: -1.234, stopPrice: 47 }], errorCount: 2, warnCount: 1, lastError: 'hata <b>x</b> & y', lastTickAt: at(19, 23, 50) };
  const t = fmt.dailySummary(d);
  assert.match(t, /GÜNLÜK ÖZET<\/b> — 19\.10\.26 \(CANLI\)/);
  assert.match(t, /kill switch AÇIK/); assert.match(t, /🔒 kilitli/);
  assert.match(t, /• SOL\/USDT: -1\.23% \| stop 47/);
  assert.match(t, /2 hata, 1 uyarı — son hata: hata &lt;b&gt;x&lt;\/b&gt; &amp; y/);
  assert.match(t, /Son kontrol: /);
  const empty = fmt.dailySummary(data());
  assert.match(empty, /Açık pozisyon yok/); assert.doesNotMatch(empty, /Bugünkü log/);
  // her satirda acilan etiket ayni satirda kapanir (bolunebilirlik)
  for (const line of t.split('\n')) assert.equal((line.match(/<b>/g) || []).length, (line.match(/<\/b>/g) || []).length, line);
});
