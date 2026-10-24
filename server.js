// server.js
// Botun tek giris noktasi. `node server.js` ile calistirilir (Termux:Boot da
// bunu cagirir). Panel HTTP uzerinden, canli guncellemeler WebSocket
// uzerinden gider.

require('dotenv').config();
require('./src/util/network').applyNetworkDefaults();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./src/store');
// Tüm çalışma çıktısını otomatik olarak data/bot.log dosyasına da kaydet.
require('./src/util/runtimeLogger').install(path.dirname(store.DATA_FILE));
const { quoteEquity } = require('./src/paperValuation');
const { normalizePortfolioPolicy, isValidBucketKey, hasOwn } = require('./src/portfolioPolicy');
const { normalizeExtras, validateExtrasPatch } = require('./src/entryExtras');
const { assertAllowedUrl } = require('./src/util/hostGuard');
const { crossSiteRejection } = require('./src/util/originGuard');
const { createExchange, listExchanges, registry: exchangeRegistry, resolveBinanceEnvironment } = require('./src/exchanges');
const PaperEngine = require('./src/paperEngine');
const LiveEngine = require('./src/liveEngine');
const { BinanceUserDataStream } = require('./src/userDataStream');
const scanner = require('./src/scanner');
const strategies = require('./src/strategies');
const vault = require('./src/vault');
const { createNotifier } = require('./src/notify');
const { createTelegramCommands } = require('./src/telegramCommands');
const { buildStatus, buildDailySummaryData } = require('./src/telegramStatus');
const { createDailySummary } = require('./src/dailySummary');
const notifyFmt = require('./src/notifyFormat');
const { createRuntimeMarker, combineShutdown } = require('./src/runtimeMarker');
const { createLoginAlert } = require('./src/loginAlert');
const auth = require('./src/auth');
const indicators = require('./src/indicators');
const { runBacktest } = require('./src/backtest/simulator');
const { validateCandleSeries } = require('./src/execution');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1'; // varsayilan: sadece bu cihaz; LAN icin HOST=0.0.0.0
const NODE_ENV = process.env.NODE_ENV || 'development';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const ALLOW_INSECURE_PANEL = process.env.ALLOW_INSECURE_PANEL === 'true';
const rawProxyHops = process.env.TRUST_PROXY_HOPS ?? '1';
const TRUST_PROXY_HOPS = Number(rawProxyHops);
if (TRUST_PROXY && (!/^\d+$/.test(String(rawProxyHops)) || !Number.isSafeInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 1 || TRUST_PROXY_HOPS > 5)) {
  console.error('[auth] Güvenlik: TRUST_PROXY=true iken TRUST_PROXY_HOPS 1-5 arasında tam sayı olmalı. Proxy zincirini doğrula.');
  process.exit(1);
}
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOCAL_HOSTS.has(String(HOST)) && !TRUST_PROXY && !ALLOW_INSECURE_PANEL) {
  console.error('[auth] Güvenlik: uzaktan panel erişimi için HTTPS reverse proxy gerekir. HOST=127.0.0.1 kullan veya TRUST_PROXY=true ile güvenilir HTTPS proxy arkasında çalıştır.');
  process.exit(1);
}

const tfPolicy = require('./src/timeframePolicy');
const TIMEFRAMES = tfPolicy.ALL_TIMEFRAMES;
// Mevcut paritelerin en kisitli mum araligina gore izin verilen azami kontrol araligi (sn); sinir yoksa Infinity.
const requiredMaxPoll = () => Math.min(Infinity, ...Object.values(state.pairs || {}).map((p) => tfPolicy.maxPollSeconds(p && p.timeframe)).filter((x) => x !== null));
const SYMBOL_RE = /^[A-Z0-9]{2,20}\/[A-Z0-9]{2,10}$/;

// Ayni veri klasorunde ikinci bir bot sureci calismasin.
try { require('./src/util/instanceLock').acquireInstanceLock(path.dirname(store.DATA_FILE)); }
catch (e) { console.error('[kilit] ' + e.message); process.exit(1); }
const state = store.load();
try { auth.ensureConfigured(); } catch (e) { console.error(`[auth] ${e.message}`); process.exit(1); }

// Bilinmeyen/kaldırılmış borsa kimliğini başka bir borsaya sessizce çevirmek
// yanlış hesap/adaptörle işlem yapılmasına yol açabilir. Güvenli şekilde başlatma.
if (!Object.prototype.hasOwnProperty.call(exchangeRegistry, state.settings.exchange)) {
  console.error(`[baslangic] bilinmeyen borsa "${state.settings.exchange}"; otomatik Binance geçişi yapılmadı. Ayarları düzeltip yeniden başlat.`);
  process.exit(1);
}

// ---- Yardimcilar ----

// WebSocket sunucusu asagida kurulur; ondan once (ornegin motor erken
// bir onUpdate cagirirsa) broadcast'in cokmemesi icin null'a esitlenir.
let wss = null;
function broadcast(payload) {
  if (!wss) return;
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

// Kimlik/session yardimcilari asagidaki HTTP katmaninda tanimlidir.

// ---- Borsa adaptoru ----
// Anahtar kaynagi oncelik sirasi:
//   1) Panelden kasaya kaydedilmis (sifreli, kasa acikken bellekte cozulur)
//   2) .env dosyasi -- SADECE Binance icin (BINANCE_API_KEY baska borsaya ait degil)
// Kagit islem modu ikisine de ihtiyac duymaz, sadece herkese acik uclari kullanir.
function buildExchange() {
  const exchangeId = state.settings.exchange;
  let creds = null;
  try {
    creds = vault.getExchangeKeys(exchangeId);
  } catch (e) {
    console.warn(`[vault] ${exchangeId} anahtarlari cozulemedi: ${e.message}`);
  }
  const envPrefix = {
    binance: 'BINANCE',
    binancetr: 'BINANCE_TR',
    btcturk: 'BTCTURK',
    paribu: 'PARIBU'
  }[exchangeId];
  const prefix = envPrefix || String(exchangeId || '').toUpperCase();
  return createExchange(exchangeId, {
    apiKey: (creds && creds.apiKey) || process.env[`${prefix}_API_KEY`],
    apiSecret: (creds && creds.apiSecret) || process.env[`${prefix}_API_SECRET`],
    // Coinbase Exchange ve OKX/OKX TR API passphrase ister. Kasa (vault) arayüzü henüz passphrase saklamıyor;
    // şimdilik yalnızca ortam değişkeninden okunur (<ADAPTER>_API_PASSPHRASE).
    apiPassphrase: (creds && creds.apiPassphrase) || process.env[`${prefix}_API_PASSPHRASE`],
    environment: exchangeId === 'binance' ? resolveBinanceEnvironment(state.settings.mode, process.env.BINANCE_ENV) : undefined,
    baseUrl: envUrl(exchangeId, 'baseUrl', `${prefix}_BASE_URL`),
    marketBaseUrl: envUrl(exchangeId, 'marketBaseUrl', `${prefix}_MARKET_BASE_URL`),
    privateBaseUrl: envUrl(exchangeId, 'privateBaseUrl', `${prefix}_PRIVATE_BASE_URL`)
  });
}

// Env'den gelen borsa URL'leri imzali istek (API key basligi + imza) tasir: resmi host'lar disinda reddedilir.
// (Binance adaptoru kendi allowlist'ini zaten uygular; BinanceTR'de HICBIR kontrol yoktu.)
const URL_ALLOW = {
  binancetr: { baseUrl: ['binance.tr'], marketBaseUrl: ['binance.me', 'binance.com'] },
  btcturk: { baseUrl: ['btcturk.com'], privateBaseUrl: ['btcturk.com'] },
  paribu: { baseUrl: ['paribu.com'] },
  coinbaseexchange: { baseUrl: ['coinbase.com'] },
  kraken: { baseUrl: ['kraken.com'] },
  bitstamp: { baseUrl: ['bitstamp.net'] },
  okx: { baseUrl: ['okx.com'] },
  okxtr: { baseUrl: ['okx.com'] },
  bybittr: { baseUrl: ['bybit.tr'] }
};
function envUrl(exchangeId, field, envName) {
  const v = process.env[envName];
  if (!v) return undefined;
  const hosts = (URL_ALLOW[exchangeId] || {})[field];
  return hosts ? assertAllowedUrl(v, hosts, envName) : v;
}

const notifier = createNotifier();
let exchange = buildExchange();

function buildEngine(exchangeInstance = exchange) {
  if (state.settings.mode === 'live') {
    const live = new LiveEngine({
      exchange: exchangeInstance, store, state, notifier,
      allowLive: process.env.LIVE_TRADING_ENABLED === 'true',
      onUpdate: (s) => broadcast({ type: 'state', state: publicState(s) })
    });
    if (exchangeInstance.capabilities?.userDataStream) {
      live.stream = new BinanceUserDataStream({
        exchange: exchangeInstance, orderManager: live.orderManager, state, store
      });
    }
    return live;
  }
  return new PaperEngine({
    exchange: exchangeInstance, store, state, notifier,
    onUpdate: (s) => broadcast({ type: 'state', state: publicState(s) })
  });
}
let engine = buildEngine();

// Telegram bildirimleri giden mesajdır; bu ayrı katman /status gibi gelen komutlara yanıt verir.
// Yalnızca .env içindeki TELEGRAM_CHAT_ID yetkilidir ve komutlar salt-okunurdur.
// Gunluk ozet (Istanbul saatiyle her gun bir kez; DAILY_SUMMARY=0 ile kapanir, DAILY_SUMMARY_TIME=HH:MM).
const dailySummary = createDailySummary({
  getData: (nowMs) => ({ ...buildDailySummaryData({ state, exchange, engine, nowMs }), notifyPending: notifier.pendingCount() }),
  notifier, state, store
});
const telegramCommands = createTelegramCommands({
  // Telegram motoru kontrol eder; sunucu ve komut dinleyicisi açık kalır.
  // Bu Paper Final sürümünde Telegram üzerinden canlı mod başlatılamaz.
  startBot: async () => {
    if (state.settings.mode !== 'paper') throw new Error('Telegram üzerinden yalnızca Paper mod başlatılabilir.');
    await engine.start();
    broadcast({ type: 'state', state: publicState(state) });
  },
  stopBot: async (reason) => {
    await engine.stop(reason || 'Telegram komutu', { notify: false }); // /bitir kendi yanitini veriyor
    broadcast({ type: 'state', state: publicState(state) });
  },
  listStrategies: () => Object.values(strategies.registry).map((s) => ({
    id: s.id, name: s.name, description: s.description,
    defaultParams: { ...s.defaultParams }, paramsSchema: s.paramsSchema,
    validate: typeof s.validate === 'function' ? s.validate : undefined
  })),
  timeframes: tfPolicy.ALL_TIMEFRAMES,
  validateTimeframe: ({ timeframe, strategyId }) => tfPolicy.timeframeProblem({
    timeframe, strategyId, pollSeconds: state.settings.pollSeconds,
    mode: state.settings.mode, exchangeId: state.settings.exchange
  }),
  addPair: async ({ symbol, strategyId, timeframe, budgetPct, params }) => {
    if (state.settings.mode !== 'paper') throw new Error('Telegram coin ekleme yalnızca Paper modda kullanılabilir.');
    const norm = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,10}$/.test(norm)) throw new Error('Parite biçimi geçersiz.');
    if (Object.prototype.hasOwnProperty.call(state.pairs, norm)) throw new Error('Bu parite zaten listede.');
    if (!engine.pairSupported(norm)) throw new Error(`${exchange.name} borsasında yalnızca ${exchange.quoteAssets.join('/')} pariteleri destekleniyor.`);
    const strategy = strategies.get(strategyId);
    const normalizedParams = { ...strategy.defaultParams, ...strategies.pickParams(strategyId, params) };
    const paramError = strategies.validateParams(strategyId, normalizedParams);
    if (paramError) throw new Error(paramError);
    if (!TIMEFRAMES.includes(timeframe)) throw new Error(`Geçersiz mum aralığı. Seçenekler: ${TIMEFRAMES.join(', ')}`);
    const tfError = tfPolicy.timeframeProblem({ timeframe, strategyId, pollSeconds: state.settings.pollSeconds, mode: state.settings.mode, exchangeId: state.settings.exchange });
    if (tfError) throw new Error(tfError);
    const maxBudget = Number(state.settings.defaultBudgetPct);
    if (!Number.isFinite(budgetPct) || budgetPct < 1 || budgetPct > Math.min(100, maxBudget)) throw new Error(`Coin bütçe payı 1 ile ${Math.min(100, maxBudget)} arasında olmalı; global ayar değiştirilmedi.`);
    state.pairs[norm] = { symbol: norm, enabled: true, strategyId: strategy.id, timeframe, budgetPct, params: normalizedParams };
    store.save(state);
    broadcast({ type: 'state', state: publicState(state) });
    return { message: 'Global risk ayarları değiştirilmedi; işlem üst sınırı, günlük zarar limiti, kill switch ve açık pozisyon sınırı aynen korunuyor.' };
  },
  // Paper modda coin silme: panel DELETE akisiyla ayni kural (acik pozisyon once son bilinen fiyattan kapatilir;
  // kapanmazsa parite SILINMEZ, pozisyon sahipsiz kalmaz). Eski fiyatla satis icin panelden ?force kullanilir.
  removePair: async ({ symbol }) => {
    if (state.settings.mode !== 'paper') throw new Error('Telegram coin silme yalnızca Paper modda kullanılabilir.');
    const { symbol: norm, pair } = pairFromParam(symbol);
    if (!pair) throw new Error('Parite bulunamadı.');
    let note = 'Global risk ayarları değiştirilmedi.';
    if (state.paper && state.paper.positions && Object.prototype.hasOwnProperty.call(state.paper.positions, norm)) {
      if (typeof engine.closePosition !== 'function') throw new Error(`${norm} için açık pozisyon var ve motor pozisyonu kapatamıyor: parite silinmedi.`);
      let closed = false;
      try {
        closed = engine.closePosition(norm, 'Parite Telegram ile silindi, son bilinen fiyattan kapatıldı', { allowStale: false }) === true;
      } catch (e) {
        closed = false;
        engine.lastCloseError = e.message;
      }
      if (!closed || (state.paper.positions && Object.prototype.hasOwnProperty.call(state.paper.positions, norm))) {
        throw new Error(`${norm} pozisyonu kapatılamadı (${engine.lastCloseError || 'bilinmeyen neden'}); parite silinmedi. Botu çalıştırıp taze fiyat gelince tekrar dene.`);
      }
      note = 'Açık paper pozisyon son bilinen fiyattan kapatıldı, tutar nakde döndü. ' + note;
    }
    delete state.pairs[norm];
    store.save(state);
    broadcast({ type: 'state', state: publicState(state) });
    return { message: note };
  },
  setPairEnabled: async ({ symbol, enabled }) => {
    // Canli modda da calisir: motor her turda state.pairs[...].enabled bayragini okur; enabled=false ve acik pozisyonu
    // olmayan parite atlanir, acik pozisyonu olan parite stop/cikis kurallariyla yonetilmeye devam eder.
    const { pair } = pairFromParam(symbol);
    if (!pair) throw new Error('Parite bulunamadı.');
    pair.enabled = Boolean(enabled);
    store.save(state);
    broadcast({ type: 'state', state: publicState(state) });
    return { message: 'Global risk ayarları değiştirilmedi.' };
  },
  // Canli modda gercek hesap/pozisyon kayitlarindan, paper modda paper defterinden okur (src/telegramStatus.js).
  getStatus: () => buildStatus({ state, exchange, engine }),
  muteNotifications: ({ hours }) => notifier.mute(hours * 3600 * 1000),
  unmuteNotifications: () => notifier.unmute(),
  getNotifyInfo: () => ({
    ...notifier.detail(),
    dailySummary: { enabled: dailySummary.isEnabled(), time: `${String(Math.floor(dailySummary.targetMinute / 60)).padStart(2, '0')}:${String(dailySummary.targetMinute % 60).padStart(2, '0')}` }
  }),
  getDailySummaryText: () => dailySummary.text()
});
telegramCommands.start();

// Adaptoru yeniden kurar (borsa degisti, kasa acildi/kilitlendi, anahtar kaydedildi...).
// Kilitlenince bellekteki cozulmus anahtarlar da adaptorden atilir.
// - Calisan KAGIT motoru korunur: yalnizca adaptor degisir (kasa acma/kilitleme/anahtar kaydi botu durdurmaz).
// - Calisan CANLI motorun altindaki adaptor degistirilemez; bu islemler ONCE reddedilir (yari uygulanmaz).
function assertCanSwapAdapter() {
  if (state.running && state.settings.mode === 'live') {
    const err = new Error('Canlı motor çalışırken kasa, anahtar veya borsa değiştirilemez. Önce botu durdur.');
    err.status = 409;
    throw err;
  }
}
function refreshExchange() {
  assertCanSwapAdapter();

  const nextExchange = buildExchange();

  if (state.running) {
    engine.exchange = nextExchange;
    engine.symbolRulesCache = {};
    exchange = nextExchange;
    return;
  }

  const nextEngine = buildEngine(nextExchange);

  exchange = nextExchange;
  engine = nextEngine;
}

// ---- HTTP ----
const app = express();
app.disable('x-powered-by');
// 'true' = tum zincire guven = X-Forwarded-For'u istemci taklit eder (hiz siniri/IP kaydi atlatilir).
// Bunun yerine TAM OLARAK N proxy'ye guvenilir (varsayilan 1): req.ip, guvenilir proxy'nin ekledigi adrestir.
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY_HOPS);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
  if (auth.isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: '256kb' }));

function makeLimiter(max, windowMs, maxKeys = 5000) {
  const hits = new Map();
  const recent = (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length) hits.set(key, arr); else hits.delete(key);
    return arr;
  };
  // Sahte/doner IP'lerle sinirsiz anahtar birikip bellegi doldurmasin: sinira gelince en eski anahtar atilir,
  // ayrica periyodik olarak suresi dolan kayitlar temizlenir.
  const sweep = setInterval(() => { for (const k of [...hits.keys()]) recent(k); }, Math.max(30000, Math.min(windowMs, 5 * 60 * 1000)));
  if (sweep.unref) sweep.unref();
  return {
    blocked: (key) => recent(key).length >= max,
    fail: (key) => {
      if (!hits.has(key) && hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      const arr = recent(key); arr.push(Date.now()); hits.set(key, arr);
    },
    reset: (key) => hits.delete(key),
    retryAfterSec: (key) => { const arr = recent(key); return arr.length ? Math.ceil((arr[0] + windowMs - Date.now()) / 1000) : 1; }
  };
}

const loginLimiter = makeLimiter(8, 10 * 60 * 1000);
const reauthLimiter = makeLimiter(8, 10 * 60 * 1000);
const vaultLimiter = makeLimiter(8, 10 * 60 * 1000);
// Borsaya dis istek ureten uclar (mum/backtest/tarayici/analiz/preflight) canli botla AYNI IP API kotasini paylasir;
// kontrolsuz cagri IP yasagina (HTTP 418/429) ve canli emirlerin bozulmasina yol acabilir.
const expensiveLimiter = makeLimiter(60, 60 * 1000);
const preflightLimiter = makeLimiter(6, 60 * 1000);
// Başarılı canlı geçiş ön kontrolü için tek kullanımlık, kısa ömürlü onay anahtarları.
const livePreflightTokens = new Map();
function expensiveOk(req, res, limiter = expensiveLimiter) {
  const key = 'x:' + (auth.tokenFromRequest(req) || 'anon');
  if (limiter.blocked(key)) { tooMany(res, limiter, key, 'Çok sık istek. Birkaç saniye bekle.'); return false; }
  limiter.fail(key);
  return true;
}
// Ters proxy (TRUST_PROXY) arkasinda socket adresi hep proxy'nin IP'sidir: tek kotu niyetli istemci herkesi
// kilitleyebilirdi. Guvenilir proxy varsa Express'in cozdugu istemci IP'si kullanilir.
let warnedProxyHeader = false;
const clientKey = (req) => {
  // TRUST_PROXY kapalıyken X-Forwarded-For geliyorsa muhtemelen ters proxy arkasındasın: tüm istemciler proxy IP'si
  // altında TEK giriş-deneme kovasını paylaşır (biri herkesi kilitleyebilir). Bir kez uyar.
  if (!TRUST_PROXY && !warnedProxyHeader && req.headers && req.headers['x-forwarded-for']) {
    warnedProxyHeader = true;
    console.warn('[server] X-Forwarded-For alındı ama TRUST_PROXY kapalı: giriş hız sınırı tüm istemciler için tek kovada. Ters proxy kullanıyorsan TRUST_PROXY ayarla (docs/NETWORK.md).');
  }
  return (TRUST_PROXY && req.ip) || (req.socket && req.socket.remoteAddress) || 'unknown';
};

function sameOrigin(req, origin) {
  try {
    const u = new URL(origin);
    const proto = auth.isSecureRequest(req) ? 'https:' : 'http:';
    // req.get yalnizca Express istek akisinda vardir; ham 'upgrade' (WebSocket) isteginde TANIMSIZDIR.
    return u.protocol === proto && u.host === String((req.headers && req.headers.host) || '');
  } catch (e) { return false; }
}
function isStateChanging(req) { return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method); }
function requireRecentAuth(req, res) {
  const session = req.authSession || auth.sessionFromRequest(req);
  if (auth.isRecentlyAuthenticated(session)) { req.authSession = session; return true; }
  res.status(428).json({ error: 'Güvenlik nedeniyle yeniden doğrulama gerekli.', reauthRequired: true });
  return false;
}

// Kimlik dogrulama: API ve WebSocket server-side session ister. Statik dosyalar
// acik kalabilir; hassas veri ve emir API'leri acilmaz. Oturum tokeni rastgele,
// HttpOnly ve SameSite=Strict'tir; HTTPS arkasinda __Host- + Secure kullanilir.
function tooMany(res, limiter, key, msg) {
  const wait = typeof limiter.retryAfterSec === 'function' ? limiter.retryAfterSec(key) : 600;
  res.setHeader('Retry-After', String(Math.max(1, wait)));
  return res.status(429).json({ error: msg });
}
function rejectCrossSite(req, res) {
  const r = crossSiteRejection(req, sameOrigin);
  if (!r) return false;
  res.status(r.status).json({ error: r.error });
  return true;
}
// Panele hatali sifre girisi: son 10 dakikadaki sayiyla tek uyari (10 dakikada en fazla bir mesaj).
const notifyLoginFailure = createLoginAlert({ notifier });

app.post('/api/login', async (req, res) => {
  if (rejectCrossSite(req, res)) return;
  const key = clientKey(req);
  if (loginLimiter.blocked(key)) return tooMany(res, loginLimiter, key, 'Çok fazla giriş denemesi. Birkaç dakika sonra tekrar dene.');
  // Deneme dogrulamadan ONCE sayilir: aksi halde paralel istek patlamasi sayac artmadan limiti asardi (async dogrulama).
  loginLimiter.fail(key);
  try {
    const result = await auth.loginAsync(req.body && req.body.password);
    if (!result) { notifyLoginFailure(); return res.status(401).json({ error: 'Şifre hatalı.', authRequired: true }); }
    loginLimiter.reset(key);
    auth.setSessionCookie(res, req, result.token);
    return res.json({ ok: true, session: auth.status() });
  } catch (e) {
    if (e && e.busy) { loginLimiter.reset(key); res.setHeader('Retry-After', '5'); return res.status(503).json({ error: e.message }); }
    return res.status(503).json({ error: e.message, setupRequired: true });
  }
});

app.post('/api/reauth', async (req, res) => {
  if (rejectCrossSite(req, res)) return;
  const key = clientKey(req);
  if (reauthLimiter.blocked(key)) return tooMany(res, reauthLimiter, key, 'Çok fazla yeniden doğrulama denemesi.');
  const session = auth.sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Oturum süresi doldu.', authRequired: true });
  reauthLimiter.fail(key);
  try {
    if (!(await auth.reauthenticateAsync(auth.tokenFromRequest(req), req.body && req.body.password))) {
      return res.status(401).json({ error: 'Şifre hatalı.', reauthRequired: true });
    }
  } catch (e) {
    if (e && e.busy) { reauthLimiter.reset(key); res.setHeader('Retry-After', '5'); return res.status(503).json({ error: e.message }); }
    return res.status(500).json({ error: 'Yeniden doğrulama başarısız.' });
  }
  reauthLimiter.reset(key);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (rejectCrossSite(req, res)) return;
  const session = auth.sessionFromRequest(req);
  // Tokeni request'ten cikarmak icin auth module cookie okumasini kullanir.
  if (session) {
    auth.logout(auth.tokenFromRequest(req));
  }
  auth.clearSessionCookie(res, req);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (req.path === '/ping' || req.path === '/login' || req.path === '/health') return next();
  const session = auth.sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Panel oturumu gerekli.', authRequired: true });
  req.authSession = session;
  // SameSite=Strict + Origin kontrolu birlikte CSRF savunmasi saglar.
  if (isStateChanging(req) && req.path !== '/reauth') {
    if (rejectCrossSite(req, res)) return;
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function publicState(s) {
  // All panel/API equity views use the same estimated liquidation valuation.
  // TRY and USDT remain separate ledgers; open positions include exit fee/slippage.
  const cashByAsset = s.paper?.cashByAsset || {};
  const positions = s.paper?.positions || {};
  const lastPrices = s.paper?.lastPrices || {};
  const quotes = new Set(Object.keys(cashByAsset).map((q) => String(q).toUpperCase()));
  for (const [symbol, pos] of Object.entries(positions)) quotes.add(String(pos?.quoteAsset || String(symbol).split('/')[1] || '').toUpperCase());
  const feeRate = Math.max(0, Number(s.settings?.paperFeePct) || 0) / 100;
  const slippagePct = Math.max(0, Number(s.settings?.paperSlippagePct) || 0);
  const paperEquityByAsset = {};
  for (const quote of quotes) {
    if (!quote) continue;
    paperEquityByAsset[quote] = quoteEquity({ quote, cashByAsset, positions, lastPrices, feeRate, slippagePct, liquidation: true, fallbackQuote: quote });
  }
  const quoteAssets = Object.keys(paperEquityByAsset).map((x) => String(x).toUpperCase());
  const uniqueQuotes = [...new Set(quoteAssets)];
  return {
    settings: s.settings,
    pairs: s.pairs,
    running: s.running,
    paper: s.paper,
    log: s.log.slice(0, 100),
    audit: (s.audit || []).slice(0, 100),
    exchanges: listExchanges(),
    strategies: strategies.list(),
    timeframes: tfPolicy.describe(),
    vault: vault.status(),
    decisions: s.decisions || {},
    killSwitch: s.killSwitch || null,
    live: s.live || null,
    liveReconciliation: s.liveReconciliation || null,
    liveRecovery: s.liveRecovery || null,
    liveStream: s.liveStream || null,
    notify: notifier.status(),
    notifyDetail: notifier.detail(),
    paperEquityByAsset,
    quoteAssets: exchange.quoteAssets || [],
    // Birden fazla quote varsa tek bir para birimi etiketi kullanmak yanıltıcıdır.
    quoteAsset: uniqueQuotes.length === 1 ? uniqueQuotes[0] : 'MULTI'
  };
}

app.get('/api/state', (req, res) => {
  res.json(publicState(state));
});

app.post('/api/control', async (req, res) => {
  const { action } = req.body || {};
  if ((action === 'start' && state.settings.mode === 'live') || action === 'ack_kill' || action === 'reset') {
    if (!requireRecentAuth(req, res)) return;
  }
  try {
    if (action === 'start') {
      await engine.start(); // canlı modda recovery tamamlanmadan dönmez
    } else if (action === 'ack_kill') {
      if (!state.killSwitch) return res.status(400).json({ error: 'Kill switch devrede değil.' });
      // Canlı modda kill-switch kağıt bakiyesine değil, GERÇEK hesabın başlangıç özkaynağına göre
      // değerlendirilir; aksi halde kağıt bakiyesiyle kıyaslanan anlamsız bir yüzde kilidi yanlışlıkla açardı.
      let lossPct = 0;
      if (state.settings.mode === 'live') {
        const q = String(state.settings.quoteAsset || 'USDT').toUpperCase();
        const startEq = Number(state.live?.startingEquityByQuote?.[q]);
        const eq = Number(engine.computeEquity(q));
        if (!Number.isFinite(eq)) {
          return res.status(400).json({ error: 'Canlı özkaynak okunamadı; kill switch kilidi kaldırılmadı. Önce hesap mutabakatını başarıyla tamamla.' });
        }
        lossPct = startEq > 0 ? -((eq / startEq - 1) * 100) : 0;
      } else {
        const quote = String(state.settings.quoteAsset || 'USDT').toUpperCase();
        const start = Number(state.paper.startingBalanceByAsset?.[quote] ?? state.paper.startingBalance);
        const eq = typeof engine.liquidationEquity === 'function' ? engine.liquidationEquity(state.paper.lastPrices) : engine.computeEquity();
        lossPct = start > 0 ? -((eq / start - 1) * 100) : 0;
      }
      const limit = Number(state.settings.killSwitchLossPct);
      if (limit > 0 && lossPct >= limit) {
        return res.status(400).json({ error: `Toplam zarar hâlâ limitin üstünde (%${lossPct.toFixed(1)} / limit %${limit}). Önce limiti artır ya da hesabı sıfırla.` });
      }
      state.killSwitch = null;
      if (state.settings.mode !== 'live' && Object.prototype.hasOwnProperty.call(engine, 'lastTickAt')) engine.lastTickAt = null;
      engine.log('Kill switch kilidi kaldırıldı.');
      store.save(state);
    } else if (action === 'stop') {
      await engine.stop('Kullanıcı durdurdu.');
    } else if (action === 'reset') {
      // Sadece kagit hesabi (bakiye, pozisyonlar, islemler, log) sifirlanir.
      // Ayarlar ve pariteler korunur -- aksi halde secili borsa da varsayilana donerdi.
      await engine.stop('Sıfırlama için durduruldu.');
      state.paper = store.defaultPaper(state.settings.paperStartingBalance, state.settings.quoteAsset);
      state.log = [];
      state.decisions = {};
      // Canli modda kill switch YALNIZCA 'ack_kill' ile (gercek ozkaynak kontrolu sonrasi) kaldirilir;
      // 'reset' kagit hesabini sifirlar, gercek hesabin zarar kilidini sessizce acmamali.
      if (state.settings.mode !== 'live') state.killSwitch = null;
      engine.symbolRulesCache = {};
      engine.throttle = {};
      engine.log('Kağıt hesabı sıfırlandı.');
      store.save(state);
    } else {
      return res.status(400).json({ error: 'Bilinmeyen aksiyon' });
    }
    broadcast({ type: 'state', state: publicState(state) });
    res.json({ ok: true });
  } catch (e) {
    res.status(/Kill switch/.test(e.message) ? 400 : 500).json({ error: e.message });
  }
});

// ---- Portfoy geneli ayarlar (beyaz liste + aralik dogrulamasi) ----
const SETTING_RULES = {
  maxConcurrentPositions: { label: 'Aynı anda maks. pozisyon', min: 1, max: 100, int: true },
  reserveCashPct: { label: 'Hiç kullanılmayacak pay (%)', min: 0, max: 90 },
  dailyLossLimitPct: { label: 'Günlük zarar limiti (%)', min: 0.1, max: 100 },
  pollSeconds: { label: 'Kontrol sıklığı (sn)', min: 15, max: 3600, int: true },
  defaultBudgetPct: { label: 'Varsayılan bütçe payı (%)', min: 1, max: 100 },
  paperStartingBalance: { label: 'Başlangıç bakiyesi', min: 1, max: 1e9 },
  killSwitchLossPct: { label: 'Kill switch (toplam zarar %)', min: 0, max: 100 }, // 0 = kapali; pozitif deger en az %0.1
  maxTradeQuote: { label: 'İşlem başına üst tutar', min: 0, max: 1e9 }, // 0 = sinirsiz; pozitif tutar en az 1 kasa birimi
  paperFeePct: { label: 'Komisyon (%)', min: 0, max: 5 },
  paperSlippagePct: { label: 'Kayma (%)', min: 0, max: 5 }
};

function validatePortfolioPolicyPatch(raw) {
  if (raw === undefined) return { ok:true };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error:'portfolioPolicy bir nesne olmalı.' };
  const n=(v,label,min,max,int=false)=>{ if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(int&&!Number.isInteger(v))) return `${label}: geçersiz.`; return null; };
  const e1=n(raw.maxPositions,'maxPositions',1,50,true); if(e1)return {error:e1};
  const e2=n(raw.reserveCashPct,'reserveCashPct',0,90); if(e2)return {error:e2};
  if (raw.reserveCashPct > 0 && raw.reserveCashPct < 0.1) return { error: 'reserveCashPct: 0 veya en az 0.1 olmalı.' };
  if(raw.buckets!==undefined && (!raw.buckets || typeof raw.buckets!=='object'||Array.isArray(raw.buckets))) return {error:'portfolioPolicy.buckets nesne olmalı.'};
  if(Object.keys(raw.buckets||{}).length>20) return {error:'En fazla 20 portföy kategorisi tanımlanabilir.'};
  for(const [key,b] of Object.entries(raw.buckets||{})){
    if(!isValidBucketKey(key)) return {error:`Portföy kategorisi geçersiz: ${key}`};
    if(!b||typeof b!=='object'||Array.isArray(b)) return {error:`${key}: kategori ayarı nesne olmalı.`};
    if(b.label!==undefined && (typeof b.label!=='string'||!b.label.trim()||b.label.length>40)) return {error:`${key}: label geçersiz.`};
    const a=n(b.maxPositions,`${key}.maxPositions`,0,100,true); if(a)return {error:a};
    const c=n(b.maxCapitalPct,`${key}.maxCapitalPct`,0,100); if(c)return {error:c};
  }
  return {ok:true, value:normalizePortfolioPolicy(raw)};
}

function validateSettingsPatch(patch) {
  const clean = {};
  const policyCheck = validatePortfolioPolicyPatch(patch.portfolioPolicy);
  if (policyCheck.error) return { error: policyCheck.error };
  if (policyCheck.value) clean.portfolioPolicy = policyCheck.value;
  const extrasCheck = validateExtrasPatch(patch, state.settings);
  if (extrasCheck.error) return { error: extrasCheck.error };
  Object.assign(clean, extrasCheck.value);
  if (patch.mode !== undefined) {
    if (!['paper','live'].includes(patch.mode)) return { error: 'mode paper veya live olmalı.' };
    clean.mode = patch.mode;
  }
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = patch[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${rule.label}: geçerli bir sayı gir.` };
    if (v < rule.min || v > rule.max) return { error: `${rule.label}: ${rule.min} ile ${rule.max} arasında olmalı.` };
    if (rule.int && !Number.isInteger(v)) return { error: `${rule.label}: tam sayı olmalı.` };
    // Zero has an explicit meaning for these settings; tiny positive values do not.
    if (key === 'killSwitchLossPct' && v > 0 && v < 0.1) return { error: `${rule.label}: 0 (kapalı) veya en az 0.1 olmalı.` };
    if (key === 'maxTradeQuote' && v > 0 && v < 1) return { error: `${rule.label}: 0 (sınırsız) veya en az 1 kasa birimi olmalı.` };
    if (key === 'reserveCashPct' && v > 0 && v < 0.1) return { error: `${rule.label}: 0 veya en az 0.1 olmalı.` };
    clean[key] = v;
  }
  if (patch.closeOnDailyLoss !== undefined) {
    if (typeof patch.closeOnDailyLoss !== 'boolean') return { error: 'closeOnDailyLoss true/false olmalı.' };
    clean.closeOnDailyLoss = true; // Güvenli duruş için pozisyonlar kapatılır; false artık desteklenmiyor.
  }
  if (patch.riskDayTimezone !== undefined) {
    let ok = typeof patch.riskDayTimezone === 'string' && patch.riskDayTimezone.length > 0 && patch.riskDayTimezone.length <= 64;
    if (ok) {
      try { new Intl.DateTimeFormat('en-CA', { timeZone: patch.riskDayTimezone }); } catch (e) { ok = false; }
    }
    if (!ok) return { error: 'Saat dilimi geçerli bir IANA adı olmalı (örn. Europe/Istanbul, UTC).' };
    clean.riskDayTimezone = patch.riskDayTimezone;
  }
  if (patch.pollSeconds !== undefined && Number(patch.pollSeconds) > requiredMaxPoll()) return { error: `Kısa mum aralığı kullanan parite var: kontrol sıklığı en fazla ${requiredMaxPoll()} sn olabilir.` };
  if (patch.mode === 'live') {
    for (const p of Object.values(state.pairs || {})) { const e = tfPolicy.timeframeProblem({ timeframe: p.timeframe, strategyId: p.strategyId, pollSeconds: 15, mode: 'live' }); if (e) return { error: `${p.symbol}: canlı moda geçmeden önce mum aralığını değiştir (${e})` }; }
  }
  if (patch.exchange !== undefined) {
    for (const p of Object.values(state.pairs || {})) { const e = tfPolicy.timeframeProblem({ timeframe: p.timeframe, strategyId: p.strategyId, pollSeconds: 15, exchangeId: patch.exchange }); if (e && /desteklenmiyor/.test(e)) return { error: `${p.symbol}: ${e}` }; }
  }
  if (patch.defaultTimeframe !== undefined) {
    if (!TIMEFRAMES.includes(patch.defaultTimeframe)) return { error: `Mum aralığı şunlardan biri olmalı: ${TIMEFRAMES.join(', ')}` };
    if (!tfPolicy.TABLE[patch.defaultTimeframe].normal) return { error: 'Varsayılan mum aralığı normal stratejilerle de kullanılabilir olmalı; kısa aralıklar yalnızca Agresif Kırılım paritesinde tek tek seçilir.' };
    clean.defaultTimeframe = patch.defaultTimeframe;
  }
  if (patch.exchange !== undefined) {
    if (typeof patch.exchange !== 'string' || !Object.prototype.hasOwnProperty.call(exchangeRegistry, patch.exchange)) {
      return { error: `Bilinmeyen borsa. Desteklenenler: ${Object.keys(exchangeRegistry).join(', ')}` };
    }
    clean.exchange = patch.exchange;
  }
  if (patch.quoteAsset !== undefined) {
    if (typeof patch.quoteAsset !== 'string' || !/^[A-Z0-9]{2,10}$/i.test(patch.quoteAsset)) return { error: 'quoteAsset geçersiz.' };
    clean.quoteAsset = patch.quoteAsset.toUpperCase();
  }
  const effectiveMode = clean.mode !== undefined ? clean.mode : state.settings.mode;
  const effectiveExchange = clean.exchange !== undefined ? clean.exchange : state.settings.exchange;
  if (effectiveMode === 'live' && !Object.prototype.hasOwnProperty.call(exchangeRegistry, effectiveExchange)) return { error: 'Canlı mod için geçerli bir borsa seçilmelidir.' };
  return { clean };
}

app.post('/api/settings', (req, res) => {
  const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { error, clean } = validateSettingsPatch(patch);
  if (error) return res.status(400).json({ error });
  if ((clean.mode === 'live' || clean.exchange !== undefined) && !requireRecentAuth(req, res)) return;
  // Canlı modda risk limitlerini gevşetmek/değiştirmek de yeniden doğrulama ister.
  const LIVE_RISK_KEYS = ['maxConcurrentPositions', 'reserveCashPct', 'dailyLossLimitPct', 'closeOnDailyLoss', 'killSwitchLossPct', 'maxTradeQuote', 'portfolioPolicy', 'protections', 'pairFilters', 'timeBarrier', 'forager'];
  if (state.settings.mode === 'live' && LIVE_RISK_KEYS.some((k) => clean[k] !== undefined) && !requireRecentAuth(req, res)) return;
  // Canlı mod invariantlarını isteğin uygulanmasından SONRAKİ etkin ayarlara göre denetle.
  // Aksi halde paper -> live geçişiyle aynı istekte sıfır limitler ayarlanarak mevcut-mod kontrolü aşılabilir.
  const effectiveMode = clean.mode !== undefined ? clean.mode : state.settings.mode;
  const effectiveKillSwitch = clean.killSwitchLossPct !== undefined
    ? clean.killSwitchLossPct : state.settings.killSwitchLossPct;
  const effectiveMaxTradeQuote = clean.maxTradeQuote !== undefined
    ? clean.maxTradeQuote : state.settings.maxTradeQuote;
  if (effectiveMode === 'live' && (effectiveKillSwitch === 0 || effectiveMaxTradeQuote === 0)) {
    return res.status(400).json({ error: 'Canlı modda kill switch (toplam zarar %) ve işlem başına üst tutar 0 (kapalı/sınırsız) yapılamaz.' });
  }
  const hasLivePositions = Object.keys((state.live && state.live.positions) || {}).length > 0;
  if (clean.quoteAsset !== undefined && clean.quoteAsset !== state.settings.quoteAsset && (state.running || hasLivePositions || Object.keys(state.paper.positions || {}).length > 0)) {
    return res.status(400).json({ error: 'Bot çalışırken ya da açık pozisyon varken kasa birimi (quote) değiştirilemez.' });
  }

  const exchangeChanged = clean.exchange !== undefined && clean.exchange !== state.settings.exchange;
  const modeChanged = clean.mode !== undefined && clean.mode !== state.settings.mode;
  if (modeChanged && clean.mode === 'live') {
    const token = typeof patch.livePreflightToken === 'string' ? patch.livePreflightToken : '';
    const expiresAt = livePreflightTokens.get(token);
    livePreflightTokens.delete(token); // token her durumda tek kullanımlık
    if (!token || !expiresAt || expiresAt < Date.now()) {
      return res.status(428).json({ error: 'Canlı moda geçiş için önce onay kutusunu işaretleyip güncel güvenlik ön kontrolünü başarıyla tamamla.' });
    }
  }
  if ((exchangeChanged || modeChanged) && state.running) {
    return res.status(400).json({ error: 'Bot çalışırken borsa veya çalışma modu değiştirilemez. Önce botu durdur.' });
  }
  if (exchangeChanged && (hasLivePositions || Object.keys(state.paper.positions).length > 0)) {
    // Sanal bakiye tek havuz ve tek kasa birimi (USDT/TRY) cinsinden tutuluyor.
    return res.status(400).json({ error: 'Açık pozisyon varken borsa değiştirilemez. Pozisyonların kapanmasını bekle ya da hesabı sıfırla.' });
  }

  // Politika tek gercek kaynak: duz alan yamalari politikaya yansitilir (eskiden sessizce eziliyordu).
  if (!clean.portfolioPolicy && (clean.maxConcurrentPositions !== undefined || clean.reserveCashPct !== undefined)) {
    const cur = normalizePortfolioPolicy(state.settings.portfolioPolicy);
    if (clean.maxConcurrentPositions !== undefined) cur.maxPositions = clean.maxConcurrentPositions;
    if (clean.reserveCashPct !== undefined) cur.reserveCashPct = Math.min(90, clean.reserveCashPct);
    clean.portfolioPolicy = normalizePortfolioPolicy(cur);
  }
  const settingsBackup = { ...state.settings };
  // Tek aktif kasa modu: TRY ve USDT aynı anda bütçelenmez. Borsa değişince
  // mevcut kasa birimi desteklenmiyorsa güvenli şekilde ilk desteklenen quote seçilir.
  // Adaptör kurucusu da hata verebilir; ayarlar henüz değiştirilmeden bunu kontrollü yanıtla.
  if (exchangeChanged) {
    try {
      const Cls = exchangeRegistry[clean.exchange];
      const tmp = new Cls();
      const requested = String(clean.quoteAsset || state.settings.quoteAsset || '').toUpperCase();
      if (!tmp.quoteAssets?.includes(requested)) clean.quoteAsset = String(tmp.quoteAssets?.[0] || requested).toUpperCase();
    } catch (e) {
      return res.status(e.status || 400).json({ error: `Borsa ayarları hazırlanamadı: ${e.message}` });
    }
  }
  Object.assign(state.settings, clean);
  state.settings.portfolioPolicy = normalizePortfolioPolicy(state.settings.portfolioPolicy);
  state.settings.maxConcurrentPositions = state.settings.portfolioPolicy.maxPositions;
  state.settings.reserveCashPct = state.settings.portfolioPolicy.reserveCashPct;
  normalizeExtras(state.settings);

  if (exchangeChanged || modeChanged) {
    try {
      refreshExchange();
    } catch (e) {
      Object.assign(state.settings, settingsBackup); // yari uygulanmis ayar birakma
      return res.status(e.status || 400).json({ error: e.message });
    }
    // Yeni borsada islem gormeyen kasa birimli (ornegin USDT) pariteleri pasife al.
    const disabled = [];
    for (const pair of Object.values(state.pairs)) {
      if (pair.enabled && !engine.pairSupported(pair.symbol)) {
        pair.enabled = false;
        disabled.push(pair.symbol);
      }
    }
    engine.log(`Borsa değişti: ${exchange.name}.` + (disabled.length ? ` Kasa birimi uymayan pariteler pasife alındı: ${disabled.join(', ')}` : ''), disabled.length ? 'warn' : 'info');
  }
  if (clean.pollSeconds !== undefined && typeof engine.reschedule === 'function') engine.reschedule();

  store.save(state);
  broadcast({ type: 'state', state: publicState(state) });
  res.json({ ok: true, settings: state.settings });
});

// ---- Pariteler: her biri kendi stratejisi + kendi parametreleriyle ----

app.post('/api/pairs', (req, res) => {
  if (!requireRecentAuth(req, res)) return;
  const { symbol, strategyId } = req.body || {};
  if (typeof symbol !== 'string' || !symbol.trim()) return res.status(400).json({ error: 'symbol gerekli' });
  const norm = symbol.toUpperCase().trim();
  if (!SYMBOL_RE.test(norm)) return res.status(400).json({ error: 'Parite biçimi BAZ/KASA olmalı (örn. AVAX/USDT).' });
  if (state.pairs[norm]) return res.status(400).json({ error: 'Bu parite zaten listede.' });
  if (!engine.pairSupported(norm)) {
    return res.status(400).json({ error: `${exchange.name} borsasında sadece ${exchange.quoteAssets.join('/')} paritesi işlem görüyor.` });
  }

  let strategy;
  try {
    strategy = strategies.get(strategyId || 'rsi_ema_macd');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  state.pairs[norm] = {
    symbol: norm,
    enabled: true,
    strategyId: strategy.id,
    timeframe: state.settings.defaultTimeframe,
    budgetPct: state.settings.defaultBudgetPct,
    params: { ...strategy.defaultParams }
  };
  store.save(state);
  broadcast({ type: 'state', state: publicState(state) });
  res.json({ ok: true, pair: state.pairs[norm] });
});

// Bir paritenin stratejisini, parametrelerini, butcesini ya da acik/kapali
// durumunu gunceller. Strateji degisirse parametreler YENI stratejinin
// varsayilanlarina sifirlanir. Once HEPSI dogrulanir, sonra uygulanir
// (yarim guncelleme olmaz).
// Express req.params'i zaten cozer; ikinci decode URIError ile 500 uretiyordu.
// state.pairs['__proto__'] / 'constructor' gibi prototip anahtarlari ASLA parite sayilmaz.
function pairFromParam(raw) {
  const symbol = String(raw || '').toUpperCase();
  if (!SYMBOL_RE.test(symbol) || !Object.prototype.hasOwnProperty.call(state.pairs, symbol)) return { symbol, pair: null };
  return { symbol, pair: state.pairs[symbol] };
}

app.patch('/api/pairs/:symbol', (req, res) => {
  if (!requireRecentAuth(req, res)) return;
  const { symbol, pair } = pairFromParam(req.params.symbol);
  if (!pair) return res.status(404).json({ error: 'Parite bulunamadı.' });
  const patch = req.body && typeof req.body === 'object' ? req.body : {};

  // Canlı modda açık pozisyonu olan paritenin strateji/parametre/mum aralığı değiştirilemez:
  // borsadaki koruyucu stop eski parametrelerle kuruludur, yerel mantık ile borsa emri ayrışırdı.
  const hasOpenLivePosition = state.settings.mode === 'live' && !!(state.live && state.live.positions && state.live.positions[symbol]);
  const hasOpenPaperPosition = state.settings.mode !== 'live' && !!(state.paper && state.paper.positions && state.paper.positions[symbol]);
  const riskConfigChanged = (patch.strategyId !== undefined && patch.strategyId !== pair.strategyId) || patch.params !== undefined || patch.timeframe !== undefined;
  if (riskConfigChanged && (hasOpenLivePosition || hasOpenPaperPosition)) {
    const modeLabel = hasOpenLivePosition ? 'canlı' : 'Paper';
    return res.status(409).json({ error: `Bu paritede açık ${modeLabel} pozisyon var; strateji, parametre veya mum aralığı pozisyon kapanana kadar değiştirilemez.` });
  }

  let strategyId = pair.strategyId;
  let params = pair.params;
  let paramsChanged = false;

  try {
    if (patch.strategyId && patch.strategyId !== pair.strategyId) {
      const strategy = strategies.get(patch.strategyId);
      strategyId = strategy.id;
      params = { ...strategy.defaultParams };
      paramsChanged = true;
    }
    if (patch.params !== undefined) {
      if (typeof patch.params !== 'object' || patch.params === null || Array.isArray(patch.params)) {
        return res.status(400).json({ error: 'params bir nesne olmalı.' });
      }
      params = { ...strategies.get(strategyId).defaultParams, ...params, ...strategies.pickParams(strategyId, patch.params) };
      paramsChanged = true;
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (paramsChanged) {
    const err = strategies.validateParams(strategyId, params);
    if (err) return res.status(400).json({ error: err });
  }
  if (patch.budgetPct !== undefined) {
    if (typeof patch.budgetPct !== 'number' || !Number.isFinite(patch.budgetPct) || patch.budgetPct < 1 || patch.budgetPct > 100) {
      return res.status(400).json({ error: 'Bütçe payı 1 ile 100 arasında bir sayı olmalı.' });
    }
  }
  if (patch.timeframe !== undefined && !TIMEFRAMES.includes(patch.timeframe)) {
    return res.status(400).json({ error: `Mum aralığı şunlardan biri olmalı: ${TIMEFRAMES.join(', ')}` });
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled true/false olmalı.' });
  }
  {
    const effTf = patch.timeframe !== undefined ? patch.timeframe : pair.timeframe;
    const fastErr = tfPolicy.timeframeProblem({ timeframe: effTf, strategyId, pollSeconds: state.settings.pollSeconds, mode: state.settings.mode, exchangeId: state.settings.exchange });
    if (fastErr) return res.status(400).json({ error: fastErr });
  }
  if (patch.portfolioClass !== undefined) {
    if (typeof patch.portfolioClass !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(patch.portfolioClass)) return res.status(400).json({ error: 'portfolioClass geçersiz.' });
    const policy = normalizePortfolioPolicy(state.settings.portfolioPolicy);
    if (!isValidBucketKey(patch.portfolioClass) || !hasOwn(policy.buckets, patch.portfolioClass)) return res.status(400).json({ error: `Bilinmeyen portföy kategorisi: ${patch.portfolioClass}` });
  }

  pair.strategyId = strategyId;
  pair.params = params;
  if (patch.budgetPct !== undefined) pair.budgetPct = patch.budgetPct;
  if (patch.timeframe !== undefined) pair.timeframe = patch.timeframe;
  if (patch.enabled !== undefined) pair.enabled = patch.enabled;
  if (patch.portfolioClass !== undefined) pair.portfolioClass = patch.portfolioClass;

  store.save(state);
  broadcast({ type: 'state', state: publicState(state) });
  res.json({ ok: true, pair });
});

app.delete('/api/pairs/:symbol', (req, res) => {
  if (!requireRecentAuth(req, res)) return;
  const { symbol, pair: existingPair } = pairFromParam(req.params.symbol);
  if (!existingPair) return res.status(404).json({ error: 'Parite bulunamadı.' });
  if (state.settings.mode === 'live') {
    // CANLI modda gercek pozisyonu olan parite silinemez: kayit silinirse pozisyon ve borsadaki stop emri
    // sahipsiz kalir. Once pozisyonun kapanmasi (strateji satisi / stop) beklenmeli ya da borsadan elle kapatilmali.
    if (state.live && state.live.positions && Object.prototype.hasOwnProperty.call(state.live.positions, symbol)) {
      return res.status(409).json({ error: `${symbol} için açık GERÇEK pozisyon var: parite silinemez. Önce pozisyon kapanmalı (ya da borsadan elle kapat), sonra sil.` });
    }
  } else {
    // Kagit modda acik pozisyon varsa once son bilinen fiyattan kapatilir: parasi nakde doner, kaybolmaz.
    // closePosition sonucu KONTROL EDILIR: satis basarisiz olursa (fiyat yok / eski fiyat / reddedilen satis)
    // parite SILINMEZ; aksi halde pozisyon sahipsiz kalirdi. ?force=true: kullanici acikca "eski son fiyattan
    // sat" derse eskimis (ama mevcut) fiyat kabul edilir; fiyat hic yoksa yine satilmaz.
    if (state.paper && state.paper.positions && Object.prototype.hasOwnProperty.call(state.paper.positions, symbol)) {
      if (typeof engine.closePosition !== 'function') {
        return res.status(409).json({ error: `${symbol} için açık pozisyon var ve motor pozisyonu kapatamıyor: parite silinmedi.` });
      }
      const force = ['1', 'true'].includes(String(req.query?.force || '').toLowerCase());
      let closed = false;
      try {
        closed = engine.closePosition(symbol, 'Parite listeden silindi, son bilinen fiyattan kapatıldı', { allowStale: force }) === true;
      } catch (e) {
        closed = false;
        engine.lastCloseError = e.message;
      }
      if (!closed || (state.paper.positions && Object.prototype.hasOwnProperty.call(state.paper.positions, symbol))) {
        const why = engine.lastCloseError || 'bilinmeyen neden';
        return res.status(409).json({ error: `${symbol} pozisyonu kapatılamadı (${why}); parite silinmedi, pozisyon izlenmeye devam ediyor. Botu çalıştırıp taze fiyat gelince tekrar dene; ya da son bilinen fiyattan satmayı kabul ediyorsan ?force=true ile dene.` });
      }
    }
  }
  delete state.pairs[symbol];
  store.save(state);
  broadcast({ type: 'state', state: publicState(state) });
  res.json({ ok: true });
});

// ---- Grafik verisi (herkese acik mum verisi; emir/anahtar gerekmez) ----
// ---- Teknik analiz / risk merkezi ----
app.get('/api/analytics', async (req, res) => {
  if (!expensiveOk(req, res)) return;
  const symbol = String(req.query.symbol || '').toUpperCase();
  const timeframe = String(req.query.timeframe || state.settings.defaultTimeframe);
  const limit = Math.min(500, Math.max(80, parseInt(req.query.limit, 10) || 240));
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'Parite biçimi BAZ/KASA olmalı.' });
  if (!TIMEFRAMES.includes(timeframe)) return res.status(400).json({ error: `Mum aralığı şunlardan biri olmalı: ${TIMEFRAMES.join(', ')}` });
  if (!engine.pairSupported(symbol)) return res.status(400).json({ error: `${exchange.name} borsasında bu kasa birimi işlem görmüyor.` });
  try {
    const candles = validateCandleSeries(await exchange.fetchCandles(symbol, timeframe, limit), timeframe);
    if (candles.length < 50) throw new Error('Analiz için en az 50 geçerli mum gerekli.');
    const closes = candles.map(c => c.c);
    const ema20 = indicators.ema(closes, 20), ema50 = indicators.ema(closes, 50), ema200 = indicators.ema(closes, 200);
    const rsi = indicators.rsi(closes, 14), macd = indicators.macd(closes), bb = indicators.bollinger(closes, 20, 2), atr = indicators.atr(candles, 14), stoch = indicators.stochastic(candles, 14);
    const i = candles.length - 1;
    const d = state.decisions?.[symbol] || null;
    const pos = state.paper.positions?.[symbol] || null;
    const price = closes[i];
    const risk = pos ? {
      entry: pos.entryPrice, stop: pos.stopPrice ?? null,
      stopDistancePct: pos.stopPrice ? Math.abs((price-pos.stopPrice)/price)*100 : null,
      unrealized: (price-pos.entryPrice)*pos.quantity,
      unrealizedPct: ((price-pos.entryPrice)/pos.entryPrice)*100
    } : null;
    const trend = ema50[i] != null ? (price > ema50[i] && (!ema200[i] || price > ema200[i]) ? 'bullish' : price < ema50[i] && (!ema200[i] || price < ema200[i]) ? 'bearish' : 'neutral') : 'neutral';
    res.json({ ok:true, symbol, timeframe, candles, indicators:{ema20,ema50,ema200,rsi,macd,bb,atr,stoch}, snapshot:{price,trend,rsi:rsi[i],macd:macd.macdLine[i],macdSignal:macd.signalLine[i],macdHistogram:macd.histogram[i],atr:atr[i],stoch:stoch[i],bbUpper:bb.upper[i],bbMiddle:bb.middle[i],bbLower:bb.lower[i]}, decision:d, positionRisk:risk });
  } catch (e) { res.status(502).json({ error:'Analiz verisi alınamadı: '+e.message }); }
});

app.get('/api/live/preflight', async (req, res) => {
  if (!expensiveOk(req, res, preflightLimiter)) return;
  const forTransition = req.query.forTransition === '1' && state.settings.mode === 'paper';
  let checkExchange = exchange;
  if (forTransition) {
    // Canlı hedef adaptörünü mevcut ayarları kalıcı değiştirmeden kur; preflight paper hesabında kalır.
    const previousMode = state.settings.mode;
    try { state.settings.mode = 'live'; checkExchange = buildExchange(); }
    catch (e) { return res.status(400).json({ ok: false, safe: false, checks: [{ id: 'adapter', label: 'Canlı adaptör hazırlanıyor', ok: false, detail: e.message }] }); }
    finally { state.settings.mode = previousMode; }
  }
  const checks = []; const add = (id, label, ok, detail) => checks.push({ id, label, ok: Boolean(ok), detail: detail || '' });
  const st = state.settings;
  add('mode', 'Canlı moda geçiş hedefi', st.mode === 'live' || forTransition, `aktif: ${st.mode}${forTransition ? ' · geçiş ön kontrolü' : ''}`);
  add('flag', 'Canlı emir güvenlik bayrağı', process.env.LIVE_TRADING_ENABLED === 'true', process.env.LIVE_TRADING_ENABLED === 'true' ? 'açık' : 'LIVE_TRADING_ENABLED=true gerekli');
  add('tls', 'TLS doğrulaması açık', process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? 'NODE_TLS_REJECT_UNAUTHORIZED=0: canlı mod başlamaz' : 'doğrulama aktif');
  let keys = null; try { keys = vault.getExchangeKeys(st.exchange); } catch (e) { /* kasa kilitli */ }
  const hasKeys = Boolean((keys && keys.apiKey) || checkExchange.apiKey) && Boolean((keys && keys.apiSecret) || checkExchange.apiSecret);
  add('keys', 'API key/secret', hasKeys, hasKeys ? 'anahtar mevcut' : 'anahtar yok veya kasa kilitli');
  // Risk limitleri: motorun başlatma kuralıyla AYNI koşullar (0 = sınırsız gerçek borsada kabul edilmez).
  const riskMissing = [];
  if (!(Number(st.maxTradeQuote) > 0)) riskMissing.push('işlem başına üst tutar');
  if (!(Number(st.killSwitchLossPct) > 0)) riskMissing.push('kill switch');
  if (!(Number(st.dailyLossLimitPct) > 0)) riskMissing.push('günlük zarar limiti');
  if (!(Number(st.reserveCashPct) >= 0 && Number(st.reserveCashPct) < 100)) riskMissing.push('rezerv payı');
  add('risk', 'Risk limitleri tanımlı', riskMissing.length === 0, riskMissing.length ? `eksik/geçersiz: ${riskMissing.join(', ')}` : `işlem üst tutarı ${st.maxTradeQuote}, kill switch %${st.killSwitchLossPct}, günlük limit %${st.dailyLossLimitPct}`);
  add('kill', 'Kill switch kilidi yok', !state.killSwitch, state.killSwitch ? `kilitli: ${state.killSwitch.reason}` : 'devrede değil');
  if (hasKeys) {
    try { const b = await checkExchange.fetchBalance(); add('balance', 'Bakiye okunuyor', !!b, 'private balance yanıtı alındı'); } catch (e) { add('balance', 'Bakiye okunuyor', false, e.message); }
    try { const o = await checkExchange.fetchOpenOrders([]); add('orders', 'Açık emirler okunuyor', Array.isArray(o), Array.isArray(o) ? `${o.length} açık emir` : 'yanıt geçersiz'); } catch (e) { add('orders', 'Açık emirler okunuyor', false, e.message); }
    // Para çekme yetkisi GERÇEKTEN sorgulanır (eskiden sabit "kapalı" gösterilirdi).
    const isTestnet = checkExchange.id === 'binance' && String(checkExchange.environment || 'production') !== 'production';
    if (isTestnet) {
      add('withdrawal', 'Para çekme yetkisi kapalı', true, 'testnet: gerçek para yok, kontrol gerekmiyor');
    } else if (typeof checkExchange.fetchApiRestrictions === 'function') {
      try {
        const r = await checkExchange.fetchApiRestrictions();
        add('withdrawal', 'Para çekme yetkisi kapalı', r.enableWithdrawals !== true, r.enableWithdrawals === true ? 'AÇIK — anahtarı yalnızca okuma + spot işlem yetkisiyle yeniden oluştur' : 'kapalı');
        add('ip', 'API anahtarı IP kısıtlı', r.ipRestrict === true, r.ipRestrict === true ? 'kısıtlı' : 'kısıtlama yok (öneri: yalnızca sunucu IP’sine kısıtla)');
      } catch (e) { add('withdrawal', 'Para çekme yetkisi kapalı', false, `doğrulanamadı: ${e.message}. Borsa panelinden elle teyit et.`); }
    } else {
      add('withdrawal', 'Para çekme yetkisi kapalı', false, 'bot bu borsada yetkileri sorgulayamıyor; borsa panelinden elle teyit et');
    }
    if (typeof checkExchange.syncTime === 'function') {
      try { const off = await checkExchange.syncTime(); add('clock', 'Saat farkı', Math.abs(off) < 60000, `${off} ms (bot otomatik düzeltir; yine de sistem saatini senkronize tut)`); } catch (e) { add('clock', 'Saat farkı', false, e.message); }
    }
  } else {
    add('balance', 'Bakiye okunuyor', false, 'API anahtarı olmadan test edilemez');
    add('orders', 'Açık emirler okunuyor', false, 'API anahtarı olmadan test edilemez');
    add('withdrawal', 'Para çekme yetkisi kapalı', false, 'API anahtarı olmadan doğrulanamaz');
  }
  const safe = checks.every((x) => x.ok);
  let transitionToken = null;
  if (safe && forTransition) {
    // Kısa ömürlü tek kullanımlık token; istemci preflight sonucunu atlayarak LIVE'e geçemez.
    transitionToken = crypto.randomBytes(32).toString('hex');
    livePreflightTokens.set(transitionToken, Date.now() + 60_000);
    for (const [key, expires] of livePreflightTokens) if (expires < Date.now()) livePreflightTokens.delete(key);
    while (livePreflightTokens.size > 100) livePreflightTokens.delete(livePreflightTokens.keys().next().value);
  }
  res.json({ ok: true, safe, exchange: checkExchange.name, environment: checkExchange.environment || null, checks, ...(transitionToken ? { transitionToken } : {}) });
});

app.get('/api/risk', (req, res) => {
  const p = state.paper || {}; const lp = p.lastPrices || {};
  const quote = String(state.settings.quoteAsset || 'USDT').toUpperCase();
  const cash = Math.max(0, Number(p.cashByAsset?.[quote]) || 0);
  const relevantPositions = Object.entries(p.positions || {}).filter(([s,pos]) => String(pos.quoteAsset || String(s).split('/')[1] || quote).toUpperCase() === quote);
  const exposure = relevantPositions.reduce((sum,[s,pos])=>{ const cached=Number(lp[s]); const entry=Number(pos.entryPrice||0); const px=Number.isFinite(cached)&&cached>0?cached:entry, qty=Number(pos.quantity||0); return px>0&&qty>0&&Number.isFinite(px)&&Number.isFinite(qty)?sum+qty*px:sum; },0);
  const equity = quoteEquity({ quote, cashByAsset: p.cashByAsset || {}, positions: p.positions || {}, lastPrices: lp, feeRate: Math.max(0, Number(state.settings.paperFeePct) || 0) / 100, slippagePct: Math.max(0, Number(state.settings.paperSlippagePct) || 0), liquidation: true, fallbackQuote: quote });
  const start = Number(p.startingBalanceByAsset?.[quote] ?? p.startingBalance) || 1;
  const dayStart=Number(p.dayStartEquityByAsset?.[quote] ?? p.dayStartEquity)||equity;
  const peak = Number(p.peakEquityByAsset?.[quote] ?? p.peakEquity)||equity; const drawdown=peak>0?((equity/peak)-1)*100:0;
  const st=p.stats||{}; const losses=Number(st.grossLoss)||0; const wins=Number(st.grossWin)||0;
  res.json({ok:true,mode:state.settings.mode,quote,equity,cash,startingBalance:start,returnPct:(equity/start-1)*100,dayPnlPct:dayStart?((equity/dayStart)-1)*100:0,drawdownPct:drawdown,maxDrawdownPct:p.maxDrawdownPct||0,exposure,exposurePct:equity?exposure/equity*100:0,positions:Object.keys(p.positions||{}).length,maxPositions:state.settings.maxConcurrentPositions,winRate:st.trades?st.wins/st.trades*100:null,profitFactor:losses?wins/losses:null,avgTradePct:st.trades?st.pctSum/st.trades:null,costs:p.costs||{fees:0,slippage:0},killSwitch:state.killSwitch||null,dailyLimitPct:state.settings.dailyLossLimitPct});
});

app.get('/api/backtest/quick', async (req,res)=>{
  if (!expensiveOk(req, res)) return;
  const symbol=String(req.query.symbol||'BTC/USDT').toUpperCase(); const timeframe=String(req.query.timeframe||'1h'); const strategyId=String(req.query.strategy||state.pairs[symbol]?.strategyId||'rsi_ema_macd');
  const limit=Math.min(1000,Math.max(200,parseInt(req.query.limit,10)||600));
  const capital = req.query.capital === undefined ? 1000 : Number(req.query.capital);
  const feePct = req.query.fee === undefined ? 0.1 : Number(req.query.fee);
  const slippagePct = req.query.slip === undefined ? 0.05 : Number(req.query.slip);
  if(!SYMBOL_RE.test(symbol)||!TIMEFRAMES.includes(timeframe)) return res.status(400).json({error:'Geçersiz parite veya mum aralığı.'});
  if (!(capital > 0) || !Number.isFinite(capital) || !(feePct >= 0 && feePct <= 5) || !Number.isFinite(feePct) || !(slippagePct >= 0 && slippagePct <= 5) || !Number.isFinite(slippagePct)) return res.status(400).json({error:'Sermaye pozitif; komisyon ve kayma %0-5 arasında olmalı.'});
  if (!engine.pairSupported(symbol)) return res.status(400).json({error:`${exchange.name} borsasında bu kasa birimi işlem görmüyor.`});
  try { const strategy=strategies.get(strategyId); const candles=validateCandleSeries(await exchange.fetchCandles(symbol,timeframe,limit), timeframe); if(candles.length < strategy.minCandles(strategy.defaultParams)+2) throw new Error('Backtest için yeterli geçerli mum yok.'); const startIndex=Math.max(strategy.minCandles(strategy.defaultParams)+1,50); const result=runBacktest({candles,startIndex,strategy,params:strategy.defaultParams,capital,feePct,slippagePct}); res.json({ok:true,symbol,timeframe,strategy:strategyId,candles:candles.length,result}); }
  catch(e){res.status(502).json({error:'Backtest çalıştırılamadı: '+e.message});}
});

app.get('/api/candles', async (req, res) => {
  if (!expensiveOk(req, res)) return;
  const symbol = String(req.query.symbol || '').toUpperCase();
  const timeframe = String(req.query.timeframe || state.settings.defaultTimeframe);
  const limit = Math.min(500, Math.max(20, parseInt(req.query.limit, 10) || 200));
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'Parite biçimi BAZ/KASA olmalı.' });
  if (!TIMEFRAMES.includes(timeframe)) return res.status(400).json({ error: `Mum aralığı şunlardan biri olmalı: ${TIMEFRAMES.join(', ')}` });
  if (!engine.pairSupported(symbol)) return res.status(400).json({ error: `${exchange.name} borsasında bu kasa birimi işlem görmüyor.` });
  try {
    const candles = await exchange.fetchCandles(symbol, timeframe, limit);
    res.json({ ok: true, symbol, timeframe, candles });
  } catch (e) {
    res.status(502).json({ error: 'Mum verisi alınamadı: ' + e.message });
  }
});

// ---- Islem gecmisi CSV (son 300 islem) ----
const csvCell = (v) => {
  let t = String(v ?? '');
  // Excel/Sheets formul enjeksiyonu: metin hucreleri = + - @ TAB CR ile basliyorsa etkisizlestir (sayilar etkilenmez).
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
app.get('/api/trades.csv', (req, res) => {
  const head = ['parite', 'acilis', 'kapanis', 'giris_fiyati', 'cikis_fiyati', 'miktar', 'kar_zarar', 'kar_zarar_yuzde', 'neden'];
  const rows = [...state.paper.trades].reverse().map((t) =>
    [t.symbol, t.openedAt, t.closedAt, t.entryPrice, t.exitPrice, t.quantity, t.pnl, t.pnlPct, t.reason].map(csvCell).join(',')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="islemler.csv"');
  res.end('\ufeff' + [head.join(','), ...rows].join('\n') + '\n');
});

app.post('/api/notify/test', async (req, res) => {
  if (!requireRecentAuth(req, res)) return;
  const st = notifier.status();
  if (!st.telegram && !st.termux) {
    return res.status(400).json({ error: 'Hiçbir bildirim kanalı ayarlı değil (.env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID ya da NOTIFY_TERMUX=1).' });
  }
  const r = await notifier.send('✅ AL-SAT test bildirimi: çalışıyor.');
  const failed = Object.entries(r).filter(([, ok]) => ok === false).map(([k]) => k);
  if (failed.length) return res.status(502).json({ error: `Gönderilemedi: ${failed.join(', ')}. Terminaldeki [bildirim] uyarısına bak.` });
  res.json({ ok: true, channels: Object.keys(r) });
});

app.get('/api/scanner', async (req, res) => {
  if (!expensiveOk(req, res)) return;
  try {
    const raw = req.query.minVolume;
    const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
    const minVolume = Number.isFinite(n) && n >= 0 ? n : undefined;
    const results = await scanner.scan(exchange, { minVolume });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(502).json({ error: 'Tarayıcı verisi alınamadı: ' + e.message });
  }
});

// ---- Kasa (şifreli API anahtarı saklama) ----

function knownExchange(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(exchangeRegistry, id);
}

app.get('/api/vault/status', (req, res) => {
  res.json(vault.status());
});

app.post('/api/vault/unlock', (req, res) => {
  if (!requireRecentAuth(req, res)) return;
  const key = clientKey(req);
  if (vaultLimiter.blocked(key)) {
    return res.status(429).json({ error: 'Çok fazla hatalı deneme. Birkaç dakika sonra tekrar dene.' });
  }
  try {
    assertCanSwapAdapter();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  const { passphrase } = req.body || {};
  let result;
  try {
    result = vault.unlock(typeof passphrase === 'string' ? passphrase : '');
  } catch (e) {
    vaultLimiter.fail(key); // yalnizca gercekten yanlis sifre/bozuk dosya yanlis-deneme sayilir
    return res.status(400).json({ error: e.message });
  }
  vaultLimiter.reset(key);
  try {
    refreshExchange(); // acilan kasadaki anahtarlari aktif borsa adaptorune yukle
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  broadcast({ type: 'state', state: publicState(state) });
  res.json({ ok: true, ...result, status: vault.status() });
});

app.post('/api/vault/lock', (req, res) => {
  if (!requireRecentAuth(req, res)) return;
  try {
    assertCanSwapAdapter();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  vault.lock();
  refreshExchange(); // bellekteki cozulmus anahtarlar adaptorden de atilsin
  broadcast({ type: 'state', state: publicState(state) });
  res.json({ ok: true, status: vault.status() });
});

app.post('/api/vault/keys', (req, res) => {
  if (!requireRecentAuth(req, res)) return;
  const { exchange: exchangeId, apiKey, apiSecret, apiPassphrase } = req.body || {};
  if (!knownExchange(exchangeId)) return res.status(400).json({ error: 'Geçerli bir borsa seç.' });
  if (typeof apiKey !== 'string' || typeof apiSecret !== 'string') {
    return res.status(400).json({ error: 'API key ve secret gerekli.' });
  }
  // Gercek borsa anahtarlari kisa, yazdirilabilir ASCII'dir. Sinirsiz boyut kasa dosyasini 1 MiB okuma sinirinin
  // uzerine cikarip kasayi kendi kendine kilitleyebilirdi.
  const keyOk = (v) => v.trim().length >= 8 && v.trim().length <= 512 && /^[\x21-\x7e]+$/.test(v.trim());
  if (!keyOk(apiKey) || !keyOk(apiSecret)) {
    return res.status(400).json({ error: 'API key/secret 8-512 karakter, boşluksuz ve yazdırılabilir ASCII olmalı.' });
  }
  const needsPassphrase = ['coinbaseexchange', 'okx', 'okxtr'].includes(exchangeId);
  const passOk = typeof apiPassphrase === 'string' && keyOk(apiPassphrase.replace(/ /g, '_')) && apiPassphrase.length <= 512;
  if (needsPassphrase && !passOk) return res.status(400).json({ error: 'Bu borsa için API passphrase gerekli (8-512 karakter, yazdırılabilir ASCII).' });
  if (!needsPassphrase && apiPassphrase) return res.status(400).json({ error: 'Bu borsa API passphrase kullanmaz.' });
  try {
    if (exchangeId === state.settings.exchange) assertCanSwapAdapter();
    vault.saveExchangeKeys(exchangeId, apiKey.trim(), apiSecret.trim(), needsPassphrase ? apiPassphrase : null);
    if (exchangeId === state.settings.exchange) refreshExchange(); // aktif borsa icin adaptoru hemen yenile
    broadcast({ type: 'state', state: publicState(state) });
    res.json({ ok: true, status: vault.status() });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.delete('/api/vault/keys/:exchange', (req, res) => {
  if (!requireRecentAuth(req, res)) return;
  const exchangeId = req.params.exchange;
  if (!knownExchange(exchangeId)) return res.status(400).json({ error: 'Bilinmeyen borsa.' });
  try {
    if (exchangeId === state.settings.exchange) assertCanSwapAdapter();
    vault.removeExchangeKeys(exchangeId);
    if (exchangeId === state.settings.exchange) refreshExchange();
    broadcast({ type: 'state', state: publicState(state) });
    res.json({ ok: true, status: vault.status() });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/health', (req, res) => {
  const healthy = Boolean(state) && Boolean(engine);
  // Kimliksiz cagri (Docker HEALTHCHECK, uptime izleyici) sadece durum bilgisini gorur.
  let authed = false;
  try { authed = Boolean(auth.sessionFromRequest(req)); } catch (e) { authed = false; }
  if (!authed) return res.status(healthy ? 200 : 503).json({ ok: healthy, service: 'al-sat-bot' });
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    service: 'al-sat-bot',
    version: require('./package.json').version,
    environment: NODE_ENV,
    mode: state.settings.mode,
    running: Boolean(state.running),
    exchange: state.settings.exchange,
    time: new Date().toISOString()
  });
});

// Gecersiz JSON govdesi vb. icin HTML yerine JSON hata dondur.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Sunucu hatası' });
});

const onListening = () => {
  console.log(`AL-SAT paneli hazir: http://localhost:${PORT}`);
  console.log(`[ortam] ${NODE_ENV} | HOST=${HOST} | PORT=${PORT} | mode=${state.settings.mode}`);
  console.log('[auth] Panel server-side oturum ile korunuyor.');
};
const server = HOST ? app.listen(PORT, HOST, onListening) : app.listen(PORT, onListening);
// Yavas-istek (slowloris) savunmasi: basliklar/istek kisa surede gelmeli; bosta kalan baglantilar kapanir.
// NOT: maxConnections BILEREK konmadi: dusuk bir ust sinir, yarim acik baglantilarla meşru istekleri de reddettirir
// (denendi: 400 yarim baglanti panele erisimi tamamen kesti). Bunun yerine bosta/yarim baglantilar hizla kapatilir.
server.headersTimeout = 10000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.connectionsCheckingInterval = 2000;
server.on('error', (err) => {
  console.error(`[sunucu] dinlenemedi (port ${PORT}): ${err.message}`);
  process.exit(1);
});

// ---- WebSocket (canli guncellemeler) ----
// noServer + elle 'upgrade': el sikisma asamasinda cerez kontrol edilir, yani
// sifreli panelde yetkisiz baglanti hic kabul edilmez.
// Sunucu istemciden mesaj BEKLEMEZ: maxPayload kucuk tutulur (varsayilan 100 MiB idi; 60 MB'lik tek mesaj RSS'yi ~130 MB sisirdi).
const MAX_WS_CLIENTS = 16;
wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    /* gecersiz url */
  }
  if (pathname !== '/ws') return socket.destroy();
  // Cross-site WebSocket hijacking: tarayici Origin gonderiyorsa panelin kendi origin'i olmali.
  if (req.headers.origin && !sameOrigin(req, req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  // Bozuk cerez basligi burada istisna firlatip SURECI cokertmemeli.
  let authed = false;
  try { authed = Boolean(auth.sessionFromRequest(req)); } catch (e) { authed = false; }
  if (!authed) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  if (wss.clients.size >= MAX_WS_CLIENTS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.on('error', () => {});
  ws.on('message', () => { try { ws.close(1008, 'mesaj kabul edilmez'); } catch (e) { /* yoksay */ } });
  ws.send(JSON.stringify({ type: 'state', state: publicState(state) }));
});

// ---- Cokmeye karsi dayaniklilik ----
// Beklenmeyen bir hata botu sessizce cokertip telefon uzerinde fark
// edilmeden durmasin diye: durumu kaydet, logla, sonra surecten cik.
// start-bot.sh'teki "while true" dongusu (bkz. README) surucyu birkac
// saniye icinde otomatik yeniden baslatir; paper durumu diskte oldugu icin
// (state.json) kaldigi yerden devam eder.
function crashSafeExit(label, err) {
  console.error(`[${label}]`, err);
  try {
    state.log.unshift({ t: new Date().toISOString(), msg: `Beklenmeyen hata (${label}): ${err.message}`, level: 'error' });
    store.save(state);
  } catch (saveErr) {
    console.error('[crashSafeExit] durum kaydedilemedi:', saveErr);
  }
  // Bildirim gondermeyi en fazla 3 sn bekle, sonra cik (while-true dongusu yeniden baslatir).
  Promise.race([notifier.send(`💥 Bot çöktü ve yeniden başlatılacak: ${err.message}`, { key: 'crash', minIntervalMs: 60000, priority: 'critical' }), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(1));
}
process.on('uncaughtException', (err) => crashSafeExit('uncaughtException', err));
process.on('unhandledRejection', (err) => crashSafeExit('unhandledRejection', err instanceof Error ? err : new Error(String(err))));

let exiting = false;
function gracefulExit(signal) {
  if (exiting) return; // ikinci sinyalde (Ctrl+C iki kez) tekrar mesaj atma
  exiting = true;
  telegramCommands.stop().catch(() => {});
  dailySummary.stop();
  console.log(`\n${signal} alindi, durum kaydediliyor...`);
  try {
    // Temiz kapanis isareti: bir sonraki acilista "beklenmedik kapanis" uyarisi cikmasin.
    state.notifyMeta = state.notifyMeta && typeof state.notifyMeta === 'object' ? state.notifyMeta : {};
    state.notifyMeta.cleanShutdown = true;
    store.save(state);
  } catch (e) {
    console.error('[kapanis] durum kaydedilemedi:', e.message);
  }
  try { runtimeMarker.markClean(); } catch (e) { /* isaretci yazilamazsa kapanis yine de tamamlanir */ }
  // Kapanis bildirimi en fazla 2,5 sn beklenir; sonra cik.
  const openPositions = Object.keys((state.settings.mode === 'live' ? state.live?.positions : state.paper?.positions) || {});
  Promise.race([
    notifier.send(notifyFmt.processShutdown({ signal, mode: state.settings.mode, openPositions, at: Date.now() }), { key: 'shutdown', minIntervalMs: 30000, priority: 'normal', html: true }),
    new Promise((r) => setTimeout(r, 2500))
  ]).catch(() => {}).finally(() => process.exit(0));
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

// Motoru EN SON baslat: broadcast/wss ve tum yollar hazir olduktan sonra.
// (Eskiden bu satir wss tanimlanmadan calisip, bot "calisiyor" durumundayken
// yeniden baslatilinca ReferenceError ile cokuyordu.)
// Onceki oturum nasil kapandi? (state.notifyMeta.cleanShutdown yalnizca SIGINT/SIGTERM'de true yazilir)
const bootMeta = (state.notifyMeta && typeof state.notifyMeta === 'object') ? state.notifyMeta : (state.notifyMeta = {});
// Iki bagimsiz kayit birlestirilir: state.json bayragi + runtime-marker.json (son nabiz = kesinti suresi).
const runtimeMarker = createRuntimeMarker({ dataDir: path.dirname(store.DATA_FILE) });
const markerBoot = runtimeMarker.boot();
const stateShutdown = !bootMeta.lastBootAt ? 'first' : (bootMeta.cleanShutdown === true ? 'clean' : 'unexpected');
const previousShutdown = combineShutdown(stateShutdown, markerBoot.previous);
bootMeta.cleanShutdown = false;
bootMeta.lastBootAt = new Date().toISOString();
try { store.save(state); } catch (e) { console.error('[baslangic] bildirim bayragi kaydedilemedi:', e.message); }
const autoResumeAtBoot = Boolean(state.running && !state.killSwitch);

if (state.running && !state.killSwitch) {
  // Sunucu yeniden baslatildiysa (ornegin telefon yeniden acildiysa) ve bot
  // calisir durumda birakilmissa otomatik devam et.
  // Baslatma basarisiz olursa (ornegin canli mod kosullari saglanmiyor) "calisiyor" bayragi diskte
  // yanlis kalmasin; kullaniciya da haber ver.
  const bootFail = (e) => {
    console.error('[baslangic] bot baslatilamadi:', e.message);
    state.running = false;
    try { store.save(state); } catch (saveErr) { console.error('[baslangic] durum kaydedilemedi:', saveErr.message); }
    notifier.send(`⚠ Bot açılışta başlatılamadı: ${e.message}`, { key: 'boot-fail', minIntervalMs: 60000, priority: 'critical' }).catch(() => {});
  };
  try {
    Promise.resolve(engine.start()).catch(bootFail);
  } catch (e) {
    bootFail(e);
  }
} else if (state.running && state.killSwitch) {
  state.running = false; // kilitliyken "calisiyor" gorunmesin
  store.save(state);
}

// Acilis bildirimi: onceki kapanis beklenmedikse (cokme/elektrik/kill) sesli ve uyarili gider.
{
  const bootPositions = Object.keys((state.settings.mode === 'live' ? state.live?.positions : state.paper?.positions) || {});
  notifier.send(notifyFmt.bootMessage({
    mode: state.settings.mode, exchange: state.settings.exchange, running: Boolean(state.running), autoResumed: autoResumeAtBoot,
    previousShutdown, lastAliveAt: markerBoot.previous ? markerBoot.previous.lastAliveAt : null,
    openPositions: bootPositions, killSwitch: Boolean(state.killSwitch), at: Date.now()
  }), { key: 'boot', minIntervalMs: 30000, priority: previousShutdown === 'unexpected' ? 'critical' : 'normal', html: true }).catch(() => {});
  dailySummary.start();
  // Dakikada bir: "hala yasiyorum" nabzi (kesinti suresi icin) + internet gelince bekleyen kritik mesajlari gonder.
  setInterval(() => {
    try { runtimeMarker.heartbeat(); } catch (e) { /* yut */ }
    notifier.flushPending().catch(() => {});
  }, 60000).unref();
}
