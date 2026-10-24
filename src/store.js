// src/store.js
// Cok basit, tek dosyali JSON depolama. Termux'ta native derleme gerektiren
// paketlerden (ornegin better-sqlite3) kacinmak icin bilerek boyle tutuldu.
// Tek kullanicili, dusuk hacimli bir bot icin yeterli. Ilerde gercek bir
// veritabanina gecmek istenirse sadece bu dosya degistirilir.

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./util/atomicWrite');
const { defaultPortfolioPolicy } = require('./portfolioPolicy');
const { defaultExtras } = require('./entryExtras');

// Her kurulum kendi veri kökünü kullanır. Varsayılan ./data; farklı makinelerde
// (ve aynı makinede birden fazla kurulumda) veriler birbirine karışmaz.
const DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

// Bir paritenin varsayilan kaydi. Strateji ve parametreleri disaridan (strategies
// registry'sinden) gelir; burada sadece iskelet var, ciddi mantik yok.
function defaultPair(symbol, strategyId, defaultParams, budgetPct, timeframe) {
  return {
    symbol,
    enabled: true,
    strategyId,
    timeframe,
    budgetPct, // ortak başlangıç/günlük özkaynağın hedef payı; kullanılabilir bakiye ile sınırlanır
    params: { ...defaultParams }, // stratejinin kendi RSI/EMA/stop-loss vb. degerleri, bu paritye ozel
    portfolioClass: 'core' // kullanicinin portfoy kategorisi: core/speculative veya kendi tanimli bucket'i
  };
}

// Sanal kasa. Baslangic bakiyesi settings.paperStartingBalance'tan gelir
// (Sifirla'da yeniden uygulanir).
function defaultPaper(startingBalance = 150, quoteAsset = 'USDT') {
  const bal = Number.isFinite(Number(startingBalance)) && Number(startingBalance) > 0 ? Number(startingBalance) : 150;
  const quote = String(quoteAsset || 'USDT').toUpperCase();
  return {
    startingBalance: bal, // legacy UI/performans alanı
    startingBalanceByAsset: { [quote]: bal }, // aktif quote başına kill-switch başlangıç bakiyesi
    // Per-asset cash ledger. Never treat TRY and USDT as interchangeable.
    cashByAsset: { [quote]: bal },
    cash: bal, // legacy UI/test alias; engine keeps it synchronized with the active quote
    dayStartEquity: bal,
    dayStartEquityByAsset: { [quote]: bal },
    dayKey: null,
    positions: {}, // symbol -> position object
    trades: [], // kapanan islemler, en yeni basta (son 300)
    equityHistory: [],
    lastPrices: {}, // symbol -> son bilinen fiyat (panelde canli K/Z gostermek icin)
    lastSignalT: {}, // symbol -> sinyali degerlendirilen SON KAPANMIS mumun zamani (ayni mum iki kez degerlendirilmesin)
    firstPrices: {}, // symbol -> pariteyi ilk gordugumuz fiyat (panelde al-tut karsilastirmasi icin)
    costs: { fees: 0, slippage: 0 }, // toplam odenen komisyon ve kayma (kasa biriminde)
    stats: { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, pctSum: 0 }, // 300 islem sinirindan bagimsiz ozet
    peakEquity: bal,
    peakEquityByAsset: { [quote]: bal },
    maxDrawdownPct: 0
  };
}

// Canli (Binance Testnet dahil) icin hazir varsayilanlar. Gercek borsada tek islem ust tutari 0 (sinirsiz)
// olamaz; 50 USDT hem Binance min. emir tutarinin (~5-10 USDT) uzerinde hem de ilk testler icin kucuktur.
const DEFAULT_MAX_TRADE_QUOTE = 50;
const DEFAULTS_VERSION = 2;
const LEGACY_TREND_STOP_PCT = 15; // eski trend stratejisi varsayilani (cok genis felaket stopu)

// state.json eski varsayilanlarla olusturulduysa (defaultsVersion yok) TEK SEFERLIK ve yalnizca eski
// varsayilanin birebir aynisi olan degerleri yeni varsayilana tasir; kullanicinin bilincli ozel degerlerine dokunmaz.
function migrateLiveReadyDefaults(merged, parsedSettings) {
  if (!merged || !merged.settings) return merged;
  if (parsedSettings && Number(parsedSettings.defaultsVersion) >= DEFAULTS_VERSION) return merged;
  const quote = String(merged.settings.quoteAsset || 'USDT').toUpperCase();
  if (quote === 'USDT' && !(Number(merged.settings.maxTradeQuote) > 0)) {
    merged.settings.maxTradeQuote = DEFAULT_MAX_TRADE_QUOTE;
    console.warn(`[store] Varsayılan güncellemesi: işlem başına üst tutar 0 (sınırsız) -> ${DEFAULT_MAX_TRADE_QUOTE} USDT.`);
  }
  const strategies = require('./strategies');
  for (const pair of Object.values(merged.pairs || {})) {
    if (!pair || typeof pair !== 'object' || !pair.params || typeof pair.params !== 'object') continue;
    if (Number(pair.params.stopLossPct) !== LEGACY_TREND_STOP_PCT) continue;
    let def = null;
    try { def = strategies.get(pair.strategyId).defaultParams.stopLossPct; } catch (_) { continue; }
    if (Number.isFinite(def) && def > 0 && def !== LEGACY_TREND_STOP_PCT) {
      pair.params.stopLossPct = def;
      console.warn(`[store] Varsayılan güncellemesi: ${pair.symbol} stop-loss %${LEGACY_TREND_STOP_PCT} -> %${def}.`);
    }
  }
  merged.settings.defaultsVersion = DEFAULTS_VERSION;
  return merged;
}

function defaultState() {
  // circular require'dan kacinmak icin burada gerektiginde ice aktariyoruz
  const strategies = require('./strategies');
  const rsiEmaMacd = strategies.get('rsi_ema_macd');

  const defaultTimeframe = '1h';
  const defaultBudgetPct = 30;
  const defaultSymbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT'];

  const pairs = {};
  for (const symbol of defaultSymbols) {
    pairs[symbol] = defaultPair(symbol, rsiEmaMacd.id, rsiEmaMacd.defaultParams, defaultBudgetPct, defaultTimeframe);
  }

  return {
    createdAt: new Date().toISOString(),
    settings: {
      exchange: 'binance',
      mode: 'paper', // 'paper' | 'live'
      quoteAsset: 'USDT',
      paperStartingBalance: 150,
      maxConcurrentPositions: 3, // portfoy geneli: ayni anda en fazla kac pozisyon
      maxOpenOrders: 12, // Botun sahip olduğu toplam açık emir üst sınırı
      reserveCashPct: 10, // portfoy geneli: hic kullanilmayacak pay
      dailyLossLimitPct: 5, // portfoy geneli: bu orana ulasilinca bot kendini durdurur
      closeOnDailyLoss: true, // gunluk limit asilinca acik pozisyonlari da kapat (yoksa korumasiz kalirlar)
      killSwitchLossPct: 15, // baslangic bakiyesine gore TOPLAM zarar bu orani asarsa: hepsini kapat, botu kilitle (gunluk limitin ~3 kati)
      maxTradeQuote: DEFAULT_MAX_TRADE_QUOTE, // tek islemde en fazla bu kadar (kasa biriminde) alim; gercek borsada 0 (sinirsiz) kabul edilmez
      maxMarketSpreadPct: 0.75, // canlı MARKET emirlerinde izin verilen maksimum bid/ask spreadi
      maxMarketSlippagePct: 0.50, // canlı MARKET emirlerinde order-book üzerinden tahmini maksimum fiyat etkisi
      minMarketDepthCoverage: 1.25, // hedef notionalin order-book'ta en az bu katı görünür derinlik
      paperFeePct: 0.1, // kagit islemde her alim/satim komisyonu (%)
      paperSlippagePct: 0.05, // kagit islemde her alim/satim kaymasi (%), backtest ile ayni varsayilan
      defaultTimeframe,
      defaultBudgetPct,
      defaultsVersion: DEFAULTS_VERSION, // eski state.json dosyalarina tek seferlik varsayilan gecisi icin
      pollSeconds: 60,
      riskDayTimezone: 'Europe/Istanbul',
      portfolioPolicy: defaultPortfolioPolicy(),
      ...defaultExtras() // protections / pairFilters / timeBarrier (hepsi varsayilan kapali)
    },
    pairs, // symbol -> { enabled, strategyId, timeframe, budgetPct, params } -- artik HER PARITENIN KENDI risk ayarlari var
    running: false,
    paper: defaultPaper(150),
    decisions: {}, // symbol -> botun son degerlendirmesi (panelde "son karar" olarak gosterilir)
    killSwitch: null, // { t, reason } -- doluysa bot kilitli, baslatilamaz
    liveOrders: {}, // clientOrderId -> {symbol, side, amount, status, exchangeOrderId, ...}; canli emir defteri
    liveReconciliation: null, // son borsa hesap mutabakati; canli isleme gecis kapisi
    liveRecovery: null, // yeniden baslangicta acik/belirsiz emir kurtarma sonucu
    liveStreamWarning: null, // WebSocket'ten gelen taninmayan emir olayi
    liveStream: { running: false, connected: false, lastEventAt: null },
    live: { positions: {}, balanceBaselineByAsset: null, lastSignalT: {}, lastPrices: {}, lastBalance: null, startingEquity: null, dayKey: null, dayStartEquity: null, dayRealizedPnl: 0, realizedPnl: 0, trades: [], stats: { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, realizedPnl: 0 }, safeToTrade: false, lastReconcileAt: null },
    log: [], // {t, msg, level}
    audit: [], // structured high-value events for explainability/review
    notifyMeta: { lastDailySummaryDay: null, cleanShutdown: null, lastBootAt: null } // bildirim katmani kalici bayraklari (gunluk ozet gunu, temiz kapanis)
  };
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultState(), null, 2));
  }
}

function load() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // `null`, `[]`, sayi gibi gecerli JSON ama durum olmayan icerik sessizce varsayilana donmesin: yedek yoluna git.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('state.json geçerli bir durum nesnesi değil');
    // Eksik alanlari varsayilanlarla tamamla (surum guncellemesi sonrasi icin)
    const merged = deepMerge(defaultState(), parsed);
    // ONEMLI: "pairs" bir veri haritasi, sablon degil. deepMerge varsayilan
    // objedeki anahtarlari (BTC/USDT, ETH/USDT ...) her zaman doldurur; bu da
    // kullanicinin sildigi bir paritenin yeniden baslatinca geri gelmesine yol
    // acar. Kullanici dosyasinda "pairs" varsa, oldugu gibi kullan.
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'pairs')) {
      merged.pairs = parsed.pairs;
    }
    // Shadow mode was removed from this paper-focused build. Older state.json
    // files may still request it; normalize to paper rather than silently
    // starting PaperEngine while the persisted/UI mode says "shadow".
    if (merged.settings && merged.settings.mode === 'shadow') {
      merged.settings.mode = 'paper';
      console.warn('[store] Eski shadow modu paper moduna geçirildi; eski shadow kayıtları state içinde korunuyor.');
    }
    // A stopped engine cannot continue monitoring stop-losses. Migrate the legacy
    // opt-out setting to the only safe behavior before either Paper or Live starts.
    if (merged.settings) merged.settings.closeOnDailyLoss = true;
    return migrateLiveReadyDefaults(merged, parsed.settings);
  } catch (e) {
    console.error('[store] state.json okunamadi:', e.message);
    // Bozuk dosyayi ezmeden once yedekle: paper gecmisi elle kurtarilabilsin.
    try {
      const backup = `${DATA_FILE}.bozuk-${Date.now()}`;
      fs.copyFileSync(DATA_FILE, backup);
      console.error('[store] bozuk dosya yedeklendi:', backup);
    } catch (copyErr) {
      console.error('[store] yedek alinamadi:', copyErr.message);
    }
    // Son saglam yedekten (state.json.bak) devam etmeyi dene: varsayilana donmek canli pozisyon /
    // emir defterini ve KILL SWITCH kaydini silerdi.
    try {
      const bak = JSON.parse(fs.readFileSync(DATA_FILE + '.bak', 'utf8'));
      console.error('[store] state.json.bak yedeginden devam ediliyor.');
      const mergedBak = deepMerge(defaultState(), bak);
      if (bak && Object.prototype.hasOwnProperty.call(bak, 'pairs')) mergedBak.pairs = bak.pairs;
      // .bak en fazla dakikada bir yenilenir: bozulan state.json'daki SON emirler/pozisyonlar bu yedekte olmayabilir.
      // Canli islem ihtimali varsa (canli mod, canli kayit veya LIVE_TRADING_ENABLED) bot KILITLI baslar; borsa hesabi
      // elle kontrol edilmeden yeni emir gonderilmez. Yalnizca paper kullanimda yedekten devam edilir.
      const liveRelated = !!(
        (mergedBak.settings && mergedBak.settings.mode === 'live') ||
        Object.keys(mergedBak.liveOrders || {}).length > 0 ||
        Object.keys((mergedBak.live && mergedBak.live.positions) || {}).length > 0 ||
        process.env.LIVE_TRADING_ENABLED === 'true'
      );
      if (liveRelated && !mergedBak.killSwitch) {
        mergedBak.killSwitch = { t: new Date().toISOString(), reason: 'state.json bozuktu; en fazla ~1 dk eski state.json.bak yedeğinden devam edildi. Son emirler/pozisyonlar yedekte olmayabilir: borsa hesabını (açık emir, bakiye) kontrol edip kilidi elle kaldır.' };
      }
      return migrateLiveReadyDefaults(mergedBak, bak && bak.settings);
    } catch (_) { /* yedek de yok/bozuk */ }
    console.error('[store] yedek de kullanilamadi, varsayilana donuluyor.');
    // Varsayilana donmek acik pozisyon/emir defterini VE kill switch kaydini silerdi; bot kilitsiz, temiz bir
    // state ile calismaya baslardi. Kayip olasiligi kullaniciya acikca gosterilsin diye bot KILITLI baslar.
    const fresh = defaultState();
    fresh.killSwitch = { t: new Date().toISOString(), reason: 'state.json okunamadı ve yedek yok: önceki durum (açık pozisyon, emir defteri, kill switch kaydı) kaybolmuş olabilir. Borsa hesabını kontrol edip kilidi elle kaldır.' };
    return fresh;
  }
}

// Atomik yazma: once .tmp dosyasina yaz, sonra rename et. Yarida kesilen bir
// yazma (ornegin elektrik kesintisi) state.json'u bozmasin diye.
function save(state) {
  ensureFile();
  atomicWriteFileSync(DATA_FILE, JSON.stringify(state, null, 2), { backup: true, mode: 0o600 });
}

// JSON.parse '__proto__' anahtarini SAHIP OLUNAN ozellik olarak uretir; out[k] = ... atamasi bu durumda
// birlestirilen nesnenin prototipini degistirirdi. Ayrilmis anahtarlar hic tasinmaz.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, override) {
  if (Array.isArray(base)) return override !== undefined ? override : base;
  if (typeof base === 'object' && base !== null) {
    const out = { ...base };
    for (const k of Object.keys(base)) {
      if (RESERVED_KEYS.has(k)) continue;
      if (override && Object.prototype.hasOwnProperty.call(override, k)) {
        out[k] = deepMerge(base[k], override[k]);
      }
    }
    // override'daki fazladan anahtarlari da koru (ornegin dinamik pozisyonlar)
    if (override && typeof override === 'object') {
      for (const k of Object.keys(override)) {
        if (RESERVED_KEYS.has(k)) continue;
        if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = override[k];
      }
    }
    return out;
  }
  return override !== undefined ? override : base;
}

module.exports = { load, save, defaultState, defaultPaper, DATA_FILE };
