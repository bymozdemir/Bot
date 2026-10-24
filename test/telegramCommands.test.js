'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramCommands } = require('../src/telegramCommands');

function make(env = { TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: '42' }, overrides = {}) {
  const requests = [];
  const fetchFn = async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: [] }) };
  };
  const status = { mode: 'paper', running: true, killSwitch: false, exchange: 'binance', quoteAsset: 'USDT', cash: 150, positions: 1 };
  const actions = { startBot: async () => { status.running = true; }, stopBot: async () => { status.running = false; }, ...overrides };
  const bot = createTelegramCommands({ env, fetchFn, logger: { log() {}, warn() {} }, getStatus: () => status, ...actions });
  return { bot, requests, status };
}

test('Telegram /status yanıt verir ve yalnızca izinli chat kimliğine', async () => {
  const { bot, requests } = make();
  assert.equal(await bot.processUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/status' } }), true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/bot123:ABC\/sendMessage$/);
  assert.equal(requests[0].body.chat_id, '42');
  assert.match(requests[0].body.text, /Bot: ÇALIŞIYOR/);
  assert.match(requests[0].body.text, /150\.00 USDT/);
  assert.match(requests[0].body.text, /Kontrol zamanı \(İstanbul\): \d{2}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}/);
  assert.equal(await bot.processUpdate({ update_id: 2, message: { chat: { id: 99 }, text: '/status' } }), false);
  assert.equal(requests.length, 1);
});

test('Telegram /start ve /help komutları yardım verir, bilinmeyen komut yok sayılır', async () => {
  const { bot, requests } = make();
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/start' } }), true);
  assert.match(requests[0].body.text, /\/basla/);
  assert.match(requests[0].body.text, /\/bitir/);
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/other' } }), false);
  assert.equal(requests.length, 1);
});

test('token veya chat ID yoksa Telegram komutları etkinleştirilmez', () => {
  assert.equal(make({ TELEGRAM_BOT_TOKEN: 'x' }).bot.configured(), false);
});


test('Telegram /bitir motoru durdurur ama komut yanıtlayıcısı erişilebilir kalır', async () => {
  const { bot, requests, status } = make();
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/bitir' } }), true);
  assert.equal(status.running, false);
  assert.match(requests.at(-1).body.text, /Telegram komut dinleyicisi açık kalıyor/);
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/durum' } }), true);
  assert.match(requests.at(-1).body.text, /Bot: DURDU/);
});

test('Telegram /basla Paper motorunu başlatır; live modda reddeder', async () => {
  const { bot, requests, status } = make();
  status.running = false;
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/basla' } }), true);
  assert.equal(status.running, true);
  assert.match(requests.at(-1).body.text, /başlatma isteği başarıyla/);

  const live = make(undefined, { getStatus: () => ({ mode: 'live', running: false }) });
  assert.equal(await live.bot.processUpdate({ message: { chat: { id: 42 }, text: '/basla' } }), true);
  assert.match(live.requests.at(-1).body.text, /yalnızca Paper mod/);
});


test('Telegram /bakiye nakit, coin miktarı, güncel değer ve maliyeti gösterir', async () => {
  const { bot, requests } = make(undefined, {
    getStatus: () => ({ mode: 'paper', quoteAsset: 'USDT', cash: 127.97, totalEquity: 150,
      holdings: [{ symbol: 'PEPE/USDT', baseAsset: 'PEPE', quantity: 3007500, marketValue: 12.03, costQuote: 12, quoteAsset: 'USDT' }] })
  });
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/bakiye' } }), true);
  const reply = requests.at(-1).body.text;
  assert.match(reply, /Kullanılabilir nakit: 127.97 USDT/);
  assert.match(reply, /PEPE: 3007500 PEPE/);
  assert.match(reply, /güncel değer: 12.03 USDT/);
  assert.match(reply, /maliyet: 12 USDT/);
  assert.match(reply, /Tahmini toplam özkaynak: 150 USDT/);
});

test('Telegram coin ekleme: hazır indikatör varsayılanları korunur, yalnızca strateji/mum/bütçe/trailing stop seçilir ve onay beklenir', async () => {
  const added = [];
  const strategy = {
    id: 'demo', name: 'Demo strateji', description: 'Test',
    defaultParams: { rsiBuyBelow: 30, trailingStop: false },
    paramsSchema: [
      { key: 'rsiBuyBelow', label: 'RSI alım eşiği', type: 'number', min: 1, max: 99, step: 1 },
      { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
    ],
    validate: (p) => p.rsiBuyBelow > 50 ? 'RSI eşiği test üst sınırını aşıyor.' : null
  };
  const { bot, requests } = make(undefined, {
    getStatus: () => ({ mode: 'paper', running: true, settings: { defaultBudgetPct: 30, pollSeconds: 60 }, pairs: {}, quoteAssets: ['USDT'] }),
    listStrategies: () => [strategy], timeframes: ['15m', '1h'],
    validateTimeframe: () => null,
    addPair: async (pair) => { added.push(pair); return { message: 'Global risk sabit.' }; }
  });
  const send = async (text) => bot.processUpdate({ message: { chat: { id: 42 }, text } });
  await send('/coin_ekle PEPE/USDT');
  assert.equal(added.length, 0);
  await send('1');
  await send('1h');
  await send('10');
  await send('evet');
  assert.equal(added.length, 0, 'özet onaylanana kadar kayıt yok');
  assert.match(requests.at(-1).body.text, /COIN AYAR ÖZETİ/);
  assert.match(requests.at(-1).body.text, /hazır varsayılanlar/);
  assert.match(requests.at(-1).body.text, /Bütçe payı: %10/);
  assert.match(requests.at(-1).body.text, /Trailing stop: AÇIK/);
  assert.doesNotMatch(requests.at(-1).body.text, /işlem saatleri|alım saati/i);
  await send('/onayla');
  assert.equal(added.length, 1);
  assert.equal(added[0].symbol, 'PEPE/USDT');
  assert.equal(added[0].params.rsiBuyBelow, 30, 'indikatörün kodda tanımlı varsayılanı korunmalı');
  assert.equal(added[0].params.trailingStop, true);
  assert.equal(added[0].budgetPct, 10);
  assert.match(requests.at(-1).body.text, /Paper listesine eklendi/);
});

test('Telegram coin ekleme: iptal ve canlı modda reddetme güvenli', async () => {
  const added = [];
  const strategy = { id: 'demo', name: 'Demo', description: '', defaultParams: {}, paramsSchema: [] };
  const common = { listStrategies: () => [strategy], timeframes: ['1h'], validateTimeframe: () => null, addPair: async (p) => added.push(p) };
  const { bot, requests } = make(undefined, {
    ...common,
    getStatus: () => ({ mode: 'paper', running: false, settings: { defaultBudgetPct: 30 }, pairs: {}, quoteAssets: ['USDT'] })
  });
  await bot.processUpdate({ message: { chat: { id: 42 }, text: '/coin_ekle BTC/USDT' } });
  await bot.processUpdate({ message: { chat: { id: 42 }, text: '/iptal' } });
  assert.equal(added.length, 0);
  assert.match(requests.at(-1).body.text, /iptal edildi/);

  const live = make(undefined, { ...common, getStatus: () => ({ mode: 'live', settings: { defaultBudgetPct: 30 }, pairs: {}, quoteAssets: ['USDT'] }) });
  await live.bot.processUpdate({ message: { chat: { id: 42 }, text: '/coin_ekle BTC/USDT' } });
  assert.match(live.requests.at(-1).body.text, /yalnızca Paper modda/);
  assert.equal(added.length, 0);
});

test('Telegram coin ekleme: bütçe payı varsayılan üst sınırını aşamaz', async () => {
  const strategy = { id: 'demo', name: 'Demo', description: '', defaultParams: {}, paramsSchema: [] };
  const { bot, requests } = make(undefined, {
    getStatus: () => ({ mode: 'paper', settings: { defaultBudgetPct: 20 }, pairs: {}, quoteAssets: ['USDT'] }),
    listStrategies: () => [strategy], timeframes: ['1h'], validateTimeframe: () => null,
    addPair: async () => { throw new Error('olmamalı'); }
  });
  const send = async (text) => bot.processUpdate({ message: { chat: { id: 42 }, text } });
  await send('/coin_ekle BTC/USDT');
  await send('1');
  await send('1h');
  await send('25');
  assert.match(requests.at(-1).body.text, /1 ile 20 arasında/);
});

// ---- coin silme, durdurma/açma, liste, işlem geçmişi, rapor ----
function makeCoinMgmt({ mode = 'paper', holdings = [], pairs, removePair, setPairEnabled, extra = {} } = {}) {
  const removed = [];
  const toggled = [];
  const pairList = pairs || {
    'BTC/USDT': { enabled: true, strategyId: 'trend_regime', timeframe: '4h', budgetPct: 10 },
    'PEPE/USDT': { enabled: false, strategyId: 'trend_filter', timeframe: '4h', budgetPct: 10 }
  };
  const { bot, requests } = make(undefined, {
    getStatus: () => ({ mode, running: true, quoteAsset: 'USDT', settings: { defaultBudgetPct: 30 }, pairs: pairList, holdings, quoteAssets: ['USDT'], ...extra }),
    removePair: removePair || (async (a) => { removed.push(a); return { message: 'Global risk ayarları değiştirilmedi.' }; }),
    setPairEnabled: setPairEnabled || (async (a) => { toggled.push(a); return { message: 'Tamam.' }; })
  });
  const send = async (text) => bot.processUpdate({ message: { chat: { id: 42 }, text } });
  return { bot, requests, send, removed, toggled, last: () => requests.at(-1).body.text };
}

test('Telegram /coin_sil önce onay ister, /onayla ile siler', async () => {
  const t = makeCoinMgmt();
  await t.send('/coin_sil PEPE/USDT');
  assert.equal(t.removed.length, 0, 'onaydan önce silinmemeli');
  assert.match(t.last(), /henüz silinmedi/);
  assert.match(t.last(), /Açık pozisyon yok/);
  await t.send('/onayla');
  assert.deepEqual(t.removed, [{ symbol: 'PEPE/USDT' }]);
  assert.match(t.last(), /PEPE\/USDT Paper listesinden silindi/);
  await t.send('/onayla');
  assert.equal(t.removed.length, 1, 'ikinci /onayla tekrar silmemeli');
});

test('Telegram /coin_sil açık pozisyonu uyarır, /iptal silmez', async () => {
  const t = makeCoinMgmt({ holdings: [{ symbol: 'PEPE/USDT', baseAsset: 'PEPE', quantity: 1000, costQuote: 15 }] });
  await t.send('/coin_sil pepe/usdt');
  assert.match(t.last(), /Açık paper pozisyon var/);
  assert.match(t.last(), /son bilinen fiyattan kapatılır/);
  await t.send('/iptal');
  assert.match(t.last(), /iptal edildi/);
  await t.send('/onayla');
  assert.equal(t.removed.length, 0);
});

test('Telegram /coin_sil hatalı, listede olmayan ve canlı modda güvenli', async () => {
  const t = makeCoinMgmt();
  await t.send('/coin_sil');
  assert.match(t.last(), /Parite biçimi hatalı/);
  await t.send('/coin_sil PEPE');
  assert.match(t.last(), /Parite biçimi hatalı/);
  await t.send('/coin_sil XYZ/USDT');
  assert.match(t.last(), /listede değil/);
  await t.send('/onayla');
  assert.equal(t.removed.length, 0);
  const live = makeCoinMgmt({ mode: 'live' });
  await live.send('/coin_sil PEPE/USDT');
  assert.match(live.last(), /yalnızca Paper modda/);
  await live.send('/onayla');
  assert.equal(live.removed.length, 0);
});

test('Telegram /coin_sil silme başarısız olursa hata söyler ve bekleyen onayı temizler', async () => {
  const t = makeCoinMgmt({ removePair: async () => { throw new Error('pozisyon kapatılamadı'); } });
  await t.send('/coin_sil PEPE/USDT');
  await t.send('/onayla');
  assert.match(t.last(), /Coin silinemedi: pozisyon kapatılamadı/);
  await t.send('/onayla');
  assert.match(t.last(), /Onaylanacak tamamlanmış ayar bulunmuyor/);
});

test('Telegram /coin_ekle bekleyen silme onayını iptal eder', async () => {
  const t = makeCoinMgmt();
  await t.send('/coin_sil PEPE/USDT');
  await t.send('/coin_ekle BTC/USDT');
  await t.send('/iptal');
  await t.send('/onayla');
  assert.equal(t.removed.length, 0);
});

test('Telegram /coinler listeler, /coin_durdur ve /coin_ac çağırır', async () => {
  const t = makeCoinMgmt({ holdings: [{ symbol: 'BTC/USDT', quantity: 0.1 }] });
  await t.send('/coinler');
  assert.match(t.last(), /TAKİP EDİLEN COİNLER \(2\)/);
  assert.match(t.last(), /BTC\/USDT — trend_regime, 4h, bütçe %10 — ▶ aktif \| açık pozisyon var/);
  assert.match(t.last(), /PEPE\/USDT — trend_filter, 4h, bütçe %10 — ⏸ durduruldu/);
  await t.send('/coin_durdur BTC/USDT');
  await t.send('/coin_ac PEPE/USDT');
  assert.deepEqual(t.toggled, [{ symbol: 'BTC/USDT', enabled: false }, { symbol: 'PEPE/USDT', enabled: true }]);
  await t.send('/coin_durdur XYZ/USDT');
  assert.match(t.last(), /listede değil/);
  await t.send('/coin_ac');
  assert.match(t.last(), /Parite biçimi hatalı/);
  assert.equal(t.toggled.length, 2);
});

test('Telegram CANLI modda /coin_durdur onaysız çalışır ve açık pozisyonu KAPATMAZ', async () => {
  const live = makeCoinMgmt({ mode: 'live', holdings: [{ symbol: 'BTC/USDT', quantity: 0.1 }] });
  await live.send('/coin_durdur BTC/USDT');
  assert.deepEqual(live.toggled, [{ symbol: 'BTC/USDT', enabled: false }]);
  assert.match(live.last(), /yeni alım yapılmaz/);
  assert.match(live.last(), /Pozisyon KAPATILMAZ/);
  await live.send('/coin_durdur XYZ/USDT');
  assert.match(live.last(), /listede değil/);
  assert.equal(live.toggled.length, 1);
});

test('Telegram CANLI modda /coin_ac (riski artırır) önce onay ister; /onayla ile açılır, /iptal ile vazgeçilir', async () => {
  const live = makeCoinMgmt({ mode: 'live' });
  await live.send('/coin_ac PEPE/USDT');
  assert.match(live.last(), /CANLI MOD/);
  assert.match(live.last(), /henüz açılmadı/);
  assert.equal(live.toggled.length, 0, 'onaydan önce hiçbir şey değişmemeli');
  await live.send('/iptal');
  assert.equal(live.bot.getPendingEnable(), null);
  await live.send('/onayla');
  assert.equal(live.toggled.length, 0, 'iptal sonrası /onayla bir şey açmamalı');
  await live.send('/coin_ac PEPE/USDT');
  await live.send('/onayla');
  assert.deepEqual(live.toggled, [{ symbol: 'PEPE/USDT', enabled: true }]);
  assert.match(live.last(), /yeniden aktif/);
  await live.send('/onayla');                                   // tek kullanımlık
  assert.equal(live.toggled.length, 1);
});

test('Telegram CANLI modda /coin_ac onayı zaman aşımına uğrar', async () => {
  const live = makeCoinMgmt({ mode: 'live' });
  await live.send('/coin_ac PEPE/USDT');
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try { await live.send('/onayla'); } finally { Date.now = realNow; }
  assert.equal(live.toggled.length, 0);
  assert.match(live.last(), /süresi doldu/);
});

test('Telegram paper modda /coin_ac onaysız çalışmaya devam eder (davranış değişmedi)', async () => {
  const t = makeCoinMgmt({ mode: 'paper' });
  await t.send('/coin_ac PEPE/USDT');
  assert.deepEqual(t.toggled, [{ symbol: 'PEPE/USDT', enabled: true }]);
});

test('Telegram /islemler ve /rapor paper kayıtlarından özet verir', async () => {
  const trades = [
    { symbol: 'SOL/USDT', pnl: -0.31, pnlPct: -2.08, reason: 'stop-loss', closedAt: '2026-10-13T22:00:00.000Z' },
    { symbol: 'XRP/USDT', pnl: 0.07, pnlPct: 0.45, reason: 'MACD', closedAt: '2026-10-13T23:00:00.000Z' }
  ];
  const t = makeCoinMgmt({ extra: { trades, stats: { trades: 2, wins: 1, grossWin: 0.07, grossLoss: 0.31, pctSum: -1.63 }, startingBalance: 150, totalEquity: 149.5, positions: 1 } });
  await t.send('/islemler');
  assert.match(t.last(), /SON 2 KAPANAN İŞLEM/);
  assert.match(t.last(), /🔴 SOL\/USDT: -2\.08% \(-0\.31 USDT\)/);
  assert.match(t.last(), /🟢 XRP\/USDT: \+0\.45% \(\+0\.07 USDT\)/);
  await t.send('/islemler 1');
  assert.doesNotMatch(t.last(), /XRP\/USDT/);
  await t.send('/rapor');
  assert.match(t.last(), /Başlangıç bakiyesi: 150 USDT/);
  assert.match(t.last(), /Toplam getiri: -0\.33%/);
  assert.match(t.last(), /Kazanma oranı: %50\.0 \(1\/2\)/);
  assert.match(t.last(), /Kâr faktörü: 0\.23/);
  const empty = makeCoinMgmt();
  await empty.send('/islemler');
  assert.match(empty.last(), /Henüz kapanmış işlem yok/);
  await empty.send('/rapor');
  assert.match(empty.last(), /Kapanan işlem: 0/);
});

test('Telegram yardım yeni komutları listeler; yetkisiz chat yanıt almaz', async () => {
  const t = makeCoinMgmt();
  await t.send('/yardim');
  for (const c of ['/coin_sil', '/coin_durdur', '/coin_ac', '/coinler', '/islemler', '/rapor']) assert.match(t.last(), new RegExp(c));
  const before = t.requests.length;
  assert.equal(await t.bot.processUpdate({ message: { chat: { id: 99 }, text: '/coin_sil PEPE/USDT' } }), false);
  assert.equal(t.requests.length, before);
  assert.equal(t.removed.length, 0);
});
