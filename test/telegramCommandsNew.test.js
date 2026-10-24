'use strict';
// Yeni Telegram komutlari ve canli-farkinda yanitlar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramCommands } = require('../src/telegramCommands');

const env = { TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: '42' };
const NOW = Date.UTC(2026, 9, 19, 12, 0);

function make({ status = {}, deps = {}, failHtml = false } = {}) {
  const requests = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    if (failHtml && body.parse_mode) return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
  };
  const st = { mode: 'paper', running: true, killSwitch: false, exchange: 'binance', quoteAsset: 'USDT', cash: 150, positions: 0, holdings: [], settings: {}, recentLog: [], ...status };
  const bot = createTelegramCommands({
    env, fetchFn, logger: { log() {}, warn() {} }, getStatus: () => st,
    startBot: async () => { st.running = true; }, stopBot: async () => { st.running = false; }, ...deps
  });
  const say = async (text) => { await bot.processUpdate({ message: { chat: { id: 42 }, text } }); return requests.at(-1); };
  return { bot, requests, st, say };
}

test('/pozisyonlar paper: giris, guncel fiyat, K/Z, stop ve sure gosterilir', async () => {
  const { say } = make({ status: { positions: 1, holdings: [{ symbol: 'BTC/USDT', baseAsset: 'BTC', quoteAsset: 'USDT', quantity: 0.5, entryPrice: 100, lastPrice: 110, unrealizedPnl: 5, unrealizedPct: 10, stopPrice: 95, openedAt: new Date(Date.now() - 90 * 60000).toISOString() }] } });
  const r = await say('/pozisyonlar');
  assert.equal(r.parse_mode, 'HTML');
  assert.match(r.text, /AÇIK POZİSYONLAR \(1\) — PAPER/);
  assert.match(r.text, /<b>BTC\/USDT<\/b>: <code>0\.5<\/code> BTC/);
  assert.match(r.text, /Giriş <code>100<\/code> → Şimdi <code>110<\/code> \(\+10\.00%, \+5\.00 USDT\) 🟢/);
  assert.match(r.text, /Stop <code>95<\/code> \(-13\.6%\)/);
  assert.match(r.text, /Süre 1s 30dk/);
  assert.match(r.text, /Toplam açık K\/Z: <b>\+5\.00 USDT<\/b>/);
  assert.doesNotMatch(r.text, /borsada stop emri/);
});

test('/pozisyonlar canli: korumali ve korumasiz pozisyonu ayirir; pozisyon yoksa bunu soyler', async () => {
  const { say } = make({ status: { mode: 'live', holdings: [
    { symbol: 'SOL/USDT', baseAsset: 'SOL', quoteAsset: 'USDT', quantity: 2, entryPrice: 50, lastPrice: 55, unrealizedPnl: 10, unrealizedPct: 10, protected: true },
    { symbol: 'ADA/USDT', baseAsset: 'ADA', quoteAsset: 'USDT', quantity: 10, entryPrice: 1, unrealizedPnl: undefined }
  ] } });
  const r = await say('/pozisyonlar');
  assert.match(r.text, /CANLI/);
  assert.match(r.text, /🛡 borsada stop emri var/);
  assert.match(r.text, /⚠ stop emri kaydı yok/);
  const empty = await make({}).say('/pozisyonlar');
  assert.match(empty.text, /Açık pozisyon yok/);
});

test('/loglar: varsayilan 10, "hata" yalniz hata/uyari, sayi en fazla 25, HTML kacirilir', async () => {
  const recentLog = Array.from({ length: 40 }, (_, i) => ({ t: new Date(NOW - i * 60000).toISOString(), msg: i === 3 ? 'hata <x> & y' : `kayıt ${i}`, level: i % 5 === 3 ? 'error' : i % 5 === 4 ? 'warn' : 'info' }));
  const { say } = make({ status: { recentLog } });
  const def = await say('/loglar');
  assert.match(def.text, /SON 10 LOG/);
  assert.equal(def.text.split('\n').filter((l) => /^[🔴🟡⚪]/u.test(l)).length, 10);
  assert.match(def.text, /hata &lt;x&gt; &amp; y/);
  const err = await say('/loglar hata');
  assert.match(err.text, /yalnızca hata\/uyarı/);
  assert.ok(err.text.split('\n').filter((l) => /^[🔴🟡⚪]/u.test(l)).every((l) => /^[🔴🟡]/u.test(l)));
  const many = await say('/loglar 100');
  assert.match(many.text, /SON 25 LOG/);
  const none = await make({ status: { recentLog: [{ t: 'x', msg: 'bilgi', level: 'info' }] } }).say('/loglar hata');
  assert.match(none.text, /Kayıtlı hata\/uyarı yok/);
});

test('/ayarlar: risk limitleri, bildirim kanallari, sessiz mod ve gunluk ozet saati', async () => {
  const { say } = make({
    status: { mode: 'live', settings: { pollSeconds: 60, dailyLossLimitPct: 5, killSwitchLossPct: 25, maxConcurrentPositions: 3, reserveCashPct: 10, maxTradeQuote: 0, maxOpenOrders: 12, timeframe: '1h' }, pairs: { 'BTC/USDT': { enabled: true }, 'ETH/USDT': { enabled: false } } },
    deps: { getNotifyInfo: () => ({ telegram: true, termux: false, healthcheck: true, muted: true, mutedUntil: NOW, dailySummary: { enabled: true, time: '23:55' }, channels: { telegram: { failures: 3 } } }) }
  });
  const r = await say('/ayarlar');
  assert.match(r.text, /AYARLAR \(salt-okunur\) — CANLI/);
  assert.match(r.text, /Günlük zarar limiti: 5% \| Kill switch \(toplam zarar\): 25%/);
  assert.match(r.text, /İşlem üst sınırı: sınırsız \| Açık emir üst sınırı: 12/);
  assert.match(r.text, /Takip edilen coin: 2 \(aktif 1\)/);
  assert.match(r.text, /Telegram ✅ \| Termux ❌ \| Nabız \(healthcheck\) ✅/);
  assert.match(r.text, /Sessiz mod: AÇIK/);
  assert.match(r.text, /Günlük özet: açık, her gün 23:55/);
  assert.match(r.text, /Telegram bildirim gönderimi son zamanlarda 3 kez başarısız/);
});

test('/sessiz: saat verir, durum gosterir, kapatir; gecersiz degeri reddeder; kritik uyarilar sesli kalir', async () => {
  const calls = [];
  let muted = null;
  const deps = {
    muteNotifications: ({ hours }) => { calls.push(hours); muted = NOW + hours * 3600000; return muted; },
    unmuteNotifications: () => { calls.push('unmute'); muted = null; },
    getNotifyInfo: () => ({ muted: Boolean(muted), mutedUntil: muted })
  };
  const { say } = make({ deps });
  let r = await say('/sessiz');
  assert.deepEqual(calls, [2]);
  assert.match(r.text, /Sessiz mod 2 saat açık/);
  assert.match(r.text, /KRİTİK uyarılar .* yine sesli/);
  r = await say('/sessiz 0,5');
  assert.deepEqual(calls, [2, 0.5]);
  r = await say('/sessiz durum');
  assert.match(r.text, /Sessiz mod AÇIK, bitiş:/);
  r = await say('/sessiz kapat');
  assert.deepEqual(calls.at(-1), 'unmute');
  assert.match(r.text, /Sessiz mod kapatıldı/);
  r = await say('/sessiz durum');
  assert.match(r.text, /Sessiz mod kapalı/);
  for (const bad of ['0', '99', 'abc', '-3']) {
    const before = calls.length;
    r = await say(`/sessiz ${bad}`);
    assert.match(r.text, /Kullanım: \/sessiz/);
    assert.equal(calls.length, before, `${bad} icin sessiz mod acilmamali`);
  }
  const nodeps = await make({}).say('/sessiz');
  assert.match(nodeps.text, /kullanılamıyor/);
});

test('/ozet gunluk ozeti HTML olarak gonderir; uretilemezse hata mesaji verir', async () => {
  const ok = await make({ deps: { getDailySummaryText: async () => '📅 <b>GÜNLÜK ÖZET</b>\nx' } }).say('/ozet');
  assert.equal(ok.parse_mode, 'HTML'); assert.match(ok.text, /GÜNLÜK ÖZET/);
  const bad = await make({ deps: { getDailySummaryText: async () => { throw new Error('veri yok'); } } }).say('/ozet');
  assert.match(bad.text, /Özet oluşturulamadı: veri yok/);
  assert.match((await make({}).say('/özet')).text, /kullanılamıyor/);
});

test('/durum /bakiye /rapor CANLI modda canli etiketleri ve kilit bilgisini gosterir', async () => {
  const live = { mode: 'live', running: true, cash: 420, totalEquity: 477, positions: 1, safeToTrade: false, lockReason: 'User Data Stream bağlı değil', lastTickAt: NOW - 20000, lastReconcileAt: '2026-10-19T11:55:00.000Z',
    holdings: [{ symbol: 'SOL/USDT', baseAsset: 'SOL', quoteAsset: 'USDT', quantity: 2, marketValue: 110, costQuote: 100 }], stats: { trades: 10, wins: 6, grossWin: 30, grossLoss: 12 }, startingBalance: 400 };
  const { say } = make({ status: live });
  let r = await say('/durum');
  assert.match(r.text, /Canlı nakit \(kullanılabilir\): 420\.00 USDT/);
  assert.match(r.text, /Tahmini özkaynak: 477 USDT/);
  assert.match(r.text, /Canlı işlem kapısı: KİLİTLİ — User Data Stream bağlı değil/);
  assert.match(r.text, /Son kontrol turu \(İstanbul\)/);
  assert.doesNotMatch(r.text, /Paper nakit/);
  r = await say('/bakiye');
  assert.match(r.text, /CANLI BAKİYE \/ VARLIKLAR/);
  assert.match(r.text, /borsa bakiyesi ve botun canlı pozisyon kayıtlarından/);
  assert.match(r.text, /son mutabakat: /);
  r = await say('/rapor');
  assert.match(r.text, /CANLI RAPOR/);
  assert.match(r.text, /Canlı hesabın gerçekleşen işlemleri/);
  const open = await make({ status: { ...live, safeToTrade: true } }).say('/durum');
  assert.match(open.text, /Canlı işlem kapısı: AÇIK \(güvenli\)/);
  const paper = await make({}).say('/durum');
  assert.match(paper.text, /Paper nakit: 150\.00 USDT/);
});

test('uzun yanit 4096 siniri icin bolunur (cok coinli /coinler listesi)', async () => {
  const pairs = {};
  for (let i = 0; i < 160; i++) pairs[`COIN${i}/USDT`] = { symbol: `COIN${i}/USDT`, enabled: true, strategyId: 'rsi_ema_macd', timeframe: '1h', budgetPct: 5, params: { stopLossPct: 3, takeProfitPct: 6 } };
  const { say, requests } = make({ status: { pairs } });
  await say('/coinler');
  assert.ok(requests.length >= 2, `parca sayisi ${requests.length}`);
  for (const q of requests) assert.ok(q.text.length <= 4010);
  assert.match(requests[0].text, /^\(1\/\d+\) /);
});

test('Telegram HTML etiketini reddederse yanit etiketsiz duz metin olarak yeniden gonderilir', async () => {
  const { say, requests } = make({ failHtml: true, status: { positions: 0 } });
  await say('/pozisyonlar');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].parse_mode, 'HTML');
  assert.equal(requests[1].parse_mode, undefined);
  assert.doesNotMatch(requests[1].text, /<b>|<code>/);
  assert.match(requests[1].text, /AÇIK POZİSYONLAR/);
});

test('/bitir canlida acik pozisyon varsa borsadaki stop emirleri uyarisini ekler', async () => {
  const { say } = make({ status: { mode: 'live', running: true, positions: 1 } });
  const r = await say('/bitir');
  assert.match(r.text, /borsadaki stop emirleri yerinde kalır ama bot artık izlemiyor/);
  const paper = await make({ status: { positions: 1 } }).say('/bitir');
  assert.doesNotMatch(paper.text, /borsadaki stop/);
});

test('yardim yeni komutlari listeler; yetkisiz chat yeni komutlara yanit alamaz', async () => {
  const { say, bot, requests } = make({});
  const h = await say('/yardim');
  for (const c of ['/pozisyonlar', '/loglar', '/ayarlar', '/ozet', '/sessiz']) assert.match(h.text, new RegExp(c));
  const n = requests.length;
  assert.equal(await bot.processUpdate({ message: { chat: { id: 7 }, text: '/sessiz 5' } }), false);
  assert.equal(await bot.processUpdate({ message: { chat: { id: 7 }, text: '/pozisyonlar' } }), false);
  assert.equal(requests.length, n);
});
