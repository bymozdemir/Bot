'use strict';
// Bekleyen KRITIK mesajlar: internet yokken kaybolmaz, baglanti gelince "gecikmeli" olarak gider.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier } = require('../src/notify');

const quiet = { warn() {}, log() {}, error() {} };
const ENV = { TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: '42', NOTIFY_MIN_GAP_MS: '0' };
const CRIT = { priority: 'critical' };

// st.down: ag yok; st.status: HTTP hata kodu; st.failAt: yalnizca bu (1 tabanli) cagrilar hata alir
function netMake(extraEnv = {}) {
  const st = { down: false, status: 0, calls: [], sleeps: [] };
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    st.calls.push(body);
    if (st.down) throw new Error('ENOTFOUND');
    if (st.status) return { ok: false, status: st.status, json: async () => ({ description: 'Bad Request: chat not found' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  let t = 1_700_000_000_000;
  const n = createNotifier({
    env: { ...ENV, ...extraEnv }, fetchFn: fn, logger: quiet, now: () => t,
    sleep: async (ms) => { st.sleeps.push(ms); }
  });
  return { n, st, advance: (ms) => { t += ms; } };
}

test('kritik mesaj tum denemelerde basarisiz olursa bellekte bekler; ag gelince once o gider', async () => {
  const { n, st, advance } = netMake();
  st.down = true;
  const r = await n.send('KİLİT AÇILDI?', CRIT);
  assert.equal(r.telegram, false);
  assert.equal(st.calls.length, 4, 'kritik: 4 deneme');
  assert.equal(n.pendingCount(), 1);
  assert.equal(n.detail().pending, 1);

  st.down = false; st.calls.length = 0; advance(20000);
  const r2 = await n.send('yeni mesaj');
  assert.equal(r2.telegram, true);
  assert.equal(n.pendingCount(), 0);
  assert.equal(st.calls.length, 2);
  assert.match(st.calls[0].text, /^⏱ Gecikmeli bildirim \(olay: /);
  assert.match(st.calls[0].text, /KİLİT AÇILDI\?/);
  assert.equal(st.calls[1].text, 'yeni mesaj');
});

test('normal ve quiet mesajlar basarisiz olunca BEKLETILMEZ (yalnizca kritikler)', async () => {
  const { n, st } = netMake();
  st.down = true;
  await n.send('normal');
  await n.send('rutin', { priority: 'quiet' });
  assert.equal(n.pendingCount(), 0);
});

test('HTML kritik mesaj bekletilir ve gecikmeli gonderimde de HTML olarak gider', async () => {
  const { n, st, advance } = netMake();
  st.down = true;
  await n.send('<b>KILL SWITCH</b>', { ...CRIT, html: true });
  assert.equal(n.pendingCount(), 1);
  st.down = false; st.calls.length = 0; advance(20000);
  assert.equal(await n.flushPending(), 1);
  assert.equal(st.calls[0].parse_mode, 'HTML');
  assert.match(st.calls[0].text, /<b>KILL SWITCH<\/b>/);
  assert.equal(st.calls[0].disable_notification, undefined, 'gecikmeli kritik de sesli');
});

test('kalici hata (yanlis chat/token: HTTP 400/401/403) kritik mesaji bekletmez', async () => {
  const { n, st } = netMake();
  st.status = 403;
  const r = await n.send('KRİTİK', CRIT);
  assert.equal(r.telegram, false);
  assert.equal(st.calls.length, 1, 'kalici hatada tekrar denenmez');
  assert.equal(n.pendingCount(), 0);
});

test('bekleyen mesaj sonradan kalici hata alirsa kuyruktan atilir (sonsuza kadar denenmez)', async () => {
  const { n, st, advance } = netMake();
  st.down = true;
  await n.send('A', CRIT);
  assert.equal(n.pendingCount(), 1);
  st.down = false; st.status = 403; advance(20000);
  assert.equal(await n.flushPending(), 0);
  assert.equal(n.pendingCount(), 0);
});

test('uzun kritik mesaj yarida kesilirse yalnizca gitmeyen parcalar bekletilir (giden parca tekrarlanmaz)', async () => {
  const text = Array.from({ length: 400 }, (_, i) => `satır ${i} ${'c'.repeat(30)}`).join('\n');
  const calls = [];
  let sendCount = 0;
  let failFrom = 2; // 2. istekten itibaren ag yok
  const fetchFn = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    sendCount += 1;
    if (sendCount >= failFrom) throw new Error('ENOTFOUND');
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const n = createNotifier({ env: ENV, fetchFn, logger: quiet, sleep: async () => {} });
  const r = await n.send(text, CRIT);
  assert.equal(r.telegram, false);
  assert.match(calls[0].text, /^\(1\/\d+\) /, 'ilk parca gitti');
  assert.ok(n.pendingCount() >= 1, 'gitmeyen parcalar bekliyor');

  failFrom = Infinity; calls.length = 0;
  await n.flushPending();
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((c) => !/\(1\/\d+\)/.test(c.text)), 'ilk parca tekrar gonderilmemeli');
  assert.equal(n.pendingCount(), 0);
});

test('ag yokken her mesajdan once kuyruk tekrar denenmez (15 sn geri cekilme)', async () => {
  const { n, st, advance } = netMake();
  st.down = true;
  await n.send('A', CRIT);
  assert.equal(st.calls.length, 4);
  st.calls.length = 0;
  await n.send('B', CRIT); // henuz basarisiz flush yok: flush denenir (1) + 4 deneme
  const afterFirst = st.calls.length;
  assert.ok(afterFirst >= 5);
  st.calls.length = 0;
  await n.send('C', CRIT); // 15 sn dolmadi: yalnizca 4 deneme
  assert.equal(st.calls.length, 4);
  advance(16000);
  st.calls.length = 0;
  await n.send('D', CRIT); // sure doldu: flush yeniden denenir (+1)
  assert.equal(st.calls.length, 5);
});

test('bekleyen kuyruk 20 ile sinirlidir (en eski duser); flushPending sirayla bosaltir', async () => {
  const { n, st } = netMake();
  st.down = true;
  for (let i = 0; i < 25; i++) await n.send(`kritik ${i}`, CRIT);
  assert.equal(n.pendingCount(), 20);
  st.down = false; st.calls.length = 0;
  const sent = await n.flushPending();
  assert.equal(sent, 20);
  assert.match(st.calls[0].text, /kritik 5$/, 'ilk 5 mesaj (0-4) dusmus olmali');
  assert.match(st.calls[19].text, /kritik 24$/);
  assert.equal(n.pendingCount(), 0);
});

test('flushPending ag yokken kuyrugu korur ve hata firlatmaz; bos kuyrukta 0 doner', async () => {
  const { n, st } = netMake();
  assert.equal(await n.flushPending(), 0);
  st.down = true;
  await n.send('A', CRIT);
  assert.equal(await n.flushPending(), 0);
  assert.equal(n.pendingCount(), 1);
});

test('Telegram ayarli degilse hicbir sey bekletilmez; send hata firlatmaz', async () => {
  const none = createNotifier({ env: {}, logger: quiet });
  assert.deepEqual(await none.send('a', CRIT), {});
  assert.equal(none.pendingCount(), 0);
  assert.equal(await none.flushPending(), 0);
});

test('status() sozlesmesi degismez; detail() pending alanini ekler', () => {
  const { n } = netMake();
  assert.deepEqual(n.status(), { telegram: true, termux: false, healthcheck: false });
  assert.equal(n.detail().pending, 0);
});
