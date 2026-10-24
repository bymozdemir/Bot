// src/paperEngine.js
//
// KAGIT ISLEM motoru. Gercek borsa fiyatlarini okur (public API, anahtar gerekmez)
// ama emirleri borsaya GONDERMEZ -- hepsi state.paper icinde simule edilir.
//
// Islem kurallari backtest ile AYNIDIR (src/execution.js ortak):
//  * Strateji sinyali sadece KAPANMIS mumla, mum kapandiktan sonra BIR KEZ uretilir.
//  * Emir, yeni mumun ACILIS fiyatindan (kayma ve komisyonla) dolar.
//  * Stop-loss / take-profit / trailing stop, mumun yuksek/dusuguyle MUM ICINDE kontrol edilir;
//    bot kontrol turlari arasinda bir sey kacirirsa (ag kesintisi) kapanan mumlar geriye donuk taranir.
//  * Cok eski (ornegin bot kapaliyken kapanmis) sinyaller UYGULANMAZ.
//
// Canli faza gecerken bu dosyanin yerine gercek emir gonderen bir liveEngine.js yazilacak;
// strategies/*, execution.js, exchange adaptoru ve state modeli DEGISMEYECEK.

const strategies = require('./strategies');
const { formatPrice, formatQuantity, formatMoney } = require('./numberFormat');
const fmt = require('./notifyFormat');
const { buyFill, sellFill, intrabarRiskExit, roundDownToStep, splitCandles, timeframeMs, validateCandleSeries, profitProtectionStop, breakEvenBufferPct } = require('./execution');
const { normalizePortfolioPolicy, canOpenPosition } = require('./portfolioPolicy');
const { normalizeExtras, entryBlock, timeBarrierExit, foragerPlan } = require('./entryExtras');
const { quoteEquity } = require('./paperValuation');
const { mapWithConcurrency } = require('./util/concurrency');

const FALLBACK_MIN_NOTIONAL = 10; // rules cekilemezse guvenli varsayim
const WARN_THROTTLE_MS = 10 * 60 * 1000; // ayni uyari 10 dk'da bir loglanir
const OUTAGE_TICKS = 3; // bu kadar tur ust uste veri gelmezse "veri akisi kesildi" uyarisi
const DEFAULT_FETCH_TIMEOUT_MS = 20 * 1000; // tek bir borsa cagrisi (mum / kural) bu sureyi asamaz
const iso = (ms) => new Date(ms).toISOString();

const observedPrice = (price, lastClosed) => (Number.isFinite(Number(price)) && Number(price) > 0 ? Number(price) : Number(lastClosed && lastClosed.c));

class PaperEngine {
  constructor({ exchange, store, state, onUpdate, notifier, nowFn }) {
    this.exchange = exchange;
    this.store = store; // { load, save }
    this.state = state;
    this.onUpdate = onUpdate || (() => {});
    this.notifier = notifier || null;
    this.nowFn = nowFn || (() => Date.now());
    this.symbolRulesCache = {};
    this.timer = null;
    this.busy = false; // bir tick suruyorken ikincisi baslamasin (cift alim onlemi)
    this.busyToken = null; // busy'yi YALNIZCA onu acan tick kapatir (stop() sonrasi eski tick yeni turun kilidini bozmasin)
    this.busySince = null;
    this.lastCloseError = ''; // closePosition son basarisizlik nedeni (server DELETE akisi okur)
    this.lastCloseFailures = []; // closeAll'da kapatilamayan pozisyonlar
    this.epoch = 0; // stop/sifirla olunca artar; eski (askida kalan) tick'ler vazgecer
    this.throttle = {};
    this.outageStreak = 0;
    this.outageAlerted = false;
    this.lastTickAt = null; // monotonic clock guard
    this.entryPauseReason = ''; // tick-local circuit breaker: never add exposure while an open position is unmonitored
    // Bounded parallelism shortens multi-symbol market-data collection without
    // allowing an unbounded request burst. Defaults to 4; clamp env override to 1..8.
    const requestedConcurrency = Number(process.env.MARKET_DATA_CONCURRENCY || process.env.PAPER_MARKET_DATA_CONCURRENCY || 4);
    this.marketDataConcurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(8, Math.floor(requestedConcurrency))) : 4;
  }

  get quoteLabel() {
    const configured = String(this.state?.settings?.quoteAsset || '').toUpperCase();
    const supported = (this.exchange.quoteAssets || []).map((q) => String(q).toUpperCase());
    if (configured && (!supported.length || supported.includes(configured))) return configured;
    return supported[0] || configured || 'USDT';
  }

  quoteAsset(symbol) {
    const parts = String(symbol || '').toUpperCase().split('/');
    return parts.length === 2 && parts[1] ? parts[1] : this.quoteLabel;
  }

  _syncLegacyCash(quote) {
    const p = this.state.paper;
    p.cashByAsset = p.cashByAsset || {};
    p._legacyCashMirror = Number.isFinite(Number(p._legacyCashMirror)) ? Number(p._legacyCashMirror) : null;
    const legacy = Number(p.cash);
    if (Number.isFinite(legacy) && ((p._legacyCashMirror !== null && legacy !== p._legacyCashMirror) ||
        (p._legacyCashMirror === null && Number.isFinite(Number(p.cashByAsset[quote])) && legacy !== Number(p.cashByAsset[quote])))) {
      p.cashByAsset[quote] = legacy;
    }
    if (!Number.isFinite(Number(p.cashByAsset[quote]))) p.cashByAsset[quote] = 0;
    p.cash = Number(p.cashByAsset[quote]);
    p._legacyCashMirror = p.cash;
  }

  cashFor(quote) {
    const q = String(quote || this.quoteLabel).toUpperCase();
    this._syncLegacyCash(q);
    return Number(this.state.paper.cashByAsset[q] || 0);
  }

  setCash(quote, value) {
    const q = String(quote || this.quoteLabel).toUpperCase();
    this.state.paper.cashByAsset = this.state.paper.cashByAsset || {};
    this.state.paper.cashByAsset[q] = Number(value) || 0;
    if (q === this.quoteLabel) {
      this.state.paper.cash = this.state.paper.cashByAsset[q];
      this.state.paper._legacyCashMirror = this.state.paper.cash;
    }
  }

  computeEquityByQuote(lastPrices = this.state.paper.lastPrices || {}) {
    const p = this.state.paper;
    const quotes = new Set(Object.keys(p.cashByAsset || {}).map(x => String(x).toUpperCase()));
    for (const [symbol, pos] of Object.entries(p.positions || {})) quotes.add(String(pos.quoteAsset || this.quoteAsset(symbol)).toUpperCase());
    quotes.add(this.quoteLabel);
    const out = {};
    for (const quote of quotes) out[quote] = quoteEquity({ quote, cashByAsset: p.cashByAsset || {}, positions: p.positions || {}, lastPrices, feeRate: this.feeRate, slippagePct: this.slipPct, liquidation: true, fallbackQuote: quote });
    return out;
  }

  // Tek bir borsa cagrisi icin ust sure. Hic donmeyen bir fetch tick'i (ve busy kilidini) sonsuza
  // kadar tutmasin: bu sure dolunca cagri hata sayilir, pozisyon icin "veri alinamadi" yolu isler.
  get fetchTimeoutMs() {
    const v = Number(this.state?.settings?.fetchTimeoutMs);
    return Number.isFinite(v) && v >= 1000 && v <= 120000 ? v : DEFAULT_FETCH_TIMEOUT_MS;
  }

  // Elle kapatma / kapatma sirasinda son fiyat bundan eskiyse eski fiyattan satis yapilmaz.
  get maxPriceAgeMs() {
    const pollMs = Math.max(15, Number(this.state?.settings?.pollSeconds) || 60) * 1000;
    return Math.max(3 * pollMs, 3 * 60 * 1000);
  }

  // Bir tick bu sureden uzun "busy" kalirsa takilmis sayilir ve serbest birakilir.
  get tickWatchdogMs() {
    const pollMs = Math.max(15, Number(this.state?.settings?.pollSeconds) || 60) * 1000;
    return Math.max(10 * 60 * 1000, 5 * pollMs);
  }

  _withTimeout(fn, label) {
    const ms = this.fetchTimeoutMs;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} zaman aşımı (${Math.round(ms / 1000)} sn)`)), ms);
    });
    return Promise.race([Promise.resolve().then(fn), timeout]).finally(() => clearTimeout(timer));
  }

  pairSupported(symbol) {
    const quotes = this.exchange.quoteAssets;
    if (!quotes || !quotes.length) return true;
    // Bozuk kayit ("BTCUSDT" gibi / yok) tek basina tum turu cokertmesin: desteklenmiyor say.
    const parts = String(symbol ?? '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const quote = parts[1].toUpperCase();
    const active = String(this.state.settings.quoteAsset || this.quoteLabel).toUpperCase();
    return quotes.includes(quote) && quote === active;
  }

  get feeRate() {
    const v = Number(this.state.settings.paperFeePct);
    return Number.isFinite(v) && v >= 0 ? v / 100 : 0.001;
  }

  get slipPct() {
    const v = Number(this.state.settings.paperSlippagePct);
    return Number.isFinite(v) && v >= 0 ? v : 0.05;
  }

  log(msg, level = 'info') {
    const line = { t: new Date().toISOString(), msg, level };
    this.state.log.unshift(line);
    this.state.log = this.state.log.slice(0, 200);
    console.log(`[${level}] ${msg}`);
    this.state.audit = this.state.audit || [];
    this.state.audit.unshift({ t: line.t, type: 'log', level, msg });
    this.state.audit = this.state.audit.slice(0, 500);
  }

  // Ayni hata her turda (60 sn) tekrar tekrar loglanip log'u doldurmasin.
  logThrottled(key, msg, level = 'warn') {
    const now = Number(this.nowFn());
    const last = this.throttle[key];
    if (last && last.msg === msg && now - last.t < WARN_THROTTLE_MS) return;
    this.throttle[key] = { msg, t: now };
    this.log(msg, level);
  }

  notify(text, opts) {
    if (!this.notifier || typeof this.notifier.send !== 'function') return;
    // Bildirim hatasi islem motorunu durdurmamali; ancak sessizce de kaybolmamali.
    // Telegram gonderimi basarisizsa sonuc / hata / bekleyen kuyruk sayisi yerel log'a yazilir.
    let sending;
    try { sending = this.notifier.send(text, opts); }
    catch (err) {
      const message = String(err && err.message || err).replace(/[\r\n]+/g, ' ').slice(0, 180);
      this.log(`[bildirim] bildirim göndericisi hata verdi: ${message}`, 'warn');
      return;
    }
    Promise.resolve(sending).then((result) => {
      if (!result || result.telegram !== false) return;
      let detail = null;
      try { detail = typeof this.notifier.detail === 'function' ? this.notifier.detail() : null; } catch (_) { /* yalnizca tanilama */ }
      const tg = detail && detail.channels && detail.channels.telegram;
      const pending = Number.isFinite(Number(detail && detail.pending)) ? Number(detail.pending) : null;
      const error = String(tg && tg.lastError || 'hata ayrintisi yok').replace(/[\r\n]+/g, ' ').slice(0, 180);
      const event = String(text).match(/(?:ALIM|SATIM)\s+([A-Z0-9/_-]+)/i);
      this.log(`[bildirim] Telegram teslim edilemedi${event ? ` (${event[0]})` : ''}; bekleyen=${pending === null ? '?' : pending}; hata=${error}`, 'warn');
    }).catch((err) => {
      const message = String(err && err.message || err).replace(/[\r\n]+/g, ' ').slice(0, 180);
      this.log(`[bildirim] bildirim göndericisi hata verdi: ${message}`, 'warn');
    });
  }

  persist() {
    this.store.save(this.state);
    this.onUpdate(this.state);
  }

  // Paper islemlerinde kalici commit'i RAM degisikliginden once yapariz.
  // Boylece process, SIGKILL veya telefon/Termux kapanmasi tam islem aninda
  // gelirse state.json eski duruma donmez: atomicWrite yeni state'i zaten
  // diske commit etmis olur. JSON state dusuk hacimli oldugu icin burada
  // kontrollu deep-clone kabul edilebilir.
  commitPaperMutation(mutator) {
    const candidate = JSON.parse(JSON.stringify(this.state));
    mutator(candidate);
    this.store.save(candidate);
    const adopt = (target, source) => {
      if (!target || !source || typeof target !== 'object' || typeof source !== 'object' || Array.isArray(target) || Array.isArray(source)) return source;
      for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(source, key)) delete target[key];
      for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
          adopt(target[key], value);
        } else {
          target[key] = value;
        }
      }
      return target;
    };
    adopt(this.state, candidate);
    this.onUpdate(this.state);
  }

  liquidationEquity(lastPrices = this.state.paper.lastPrices || {}) {
    return Number(this.computeEquityByQuote(lastPrices)[this.quoteLabel] || 0);
  }

  // Eski surumlerden kalan state.json'da yeni alanlar yoksa tamamla.
  ensureState() {
    const st = this.state;
    const p = st.paper;
    st.decisions = st.decisions || {};
    // Kill-switch is a security boundary, not a free-form truthy flag.
    // A tampered/recovered state containing e.g. "x" must not bypass the
    // later orphan-position guard by making `!st.killSwitch` false. Invalid
    // values are converted into a structured lock and every valid lock forces
    // the engine to remain stopped.
    if (st.killSwitch === undefined) st.killSwitch = null;
    if (st.killSwitch !== null && (typeof st.killSwitch !== 'object' || Array.isArray(st.killSwitch) || typeof st.killSwitch.reason !== 'string' || !st.killSwitch.reason.trim())) {
      st.killSwitch = { t: iso(this.nowFn()), reason: 'geçersiz kill-switch state tespit edildi; güvenlik nedeniyle Paper kilitlendi' };
      st.running = false;
    }
    if (st.killSwitch) st.running = false;
    if (!(p.startingBalance > 0)) p.startingBalance = Number(st.settings.paperStartingBalance) || 150;
    if (!p.cashByAsset || typeof p.cashByAsset !== 'object' || Array.isArray(p.cashByAsset)) p.cashByAsset = {};
    if (!p.startingBalanceByAsset || typeof p.startingBalanceByAsset !== 'object' || Array.isArray(p.startingBalanceByAsset)) p.startingBalanceByAsset = {};
    const activeQuote = this.quoteLabel;
    let initializedActiveQuote = false;
    if (!(Number(p.cashByAsset[activeQuote]) >= 0)) {
      // Eski tek-kasa state'lerinde cashByAsset boşsa `cash` aktif kasanın kaynağıdır.
      // Ancak başka bir quote ledger'ı zaten varsa, aktif quote değişimini otomatik
      // olarak para taşıma işlemi saymayız: TRY ve USDT birbirinin bakiyesi değildir.
      // Böylece USDT -> TRY -> USDT geçişi aynı başlangıç parasını iki kez yaratamaz.
      const hasAnyLedger = Object.keys(p.cashByAsset).length > 0;
      p.cashByAsset[activeQuote] = hasAnyLedger
        ? 0
        : (Number.isFinite(Number(p.cash)) ? Number(p.cash) : p.startingBalance);
      initializedActiveQuote = true;
    }
    if (initializedActiveQuote) {
      // Yeni quote'a otomatik para taşınmadığını legacy mirror'a da yaz.
      p.cash = Number(p.cashByAsset[activeQuote] || 0);
      p._legacyCashMirror = p.cash;
    }
    this._syncLegacyCash(activeQuote);
    const currentQuoteEquity = () => quoteEquity({ quote: activeQuote, cashByAsset: p.cashByAsset || {}, positions: p.positions || {}, lastPrices: p.lastPrices || {}, feeRate: this.feeRate, slippagePct: this.slipPct, liquidation: true, fallbackQuote: activeQuote });
    if (!Number.isFinite(Number(p.startingBalanceByAsset[activeQuote])) || Number(p.startingBalanceByAsset[activeQuote]) < 0) p.startingBalanceByAsset[activeQuote] = currentQuoteEquity();
    if (!p.dayStartEquityByAsset || typeof p.dayStartEquityByAsset !== 'object' || Array.isArray(p.dayStartEquityByAsset)) p.dayStartEquityByAsset = {};
    const existingDayStart = Number(p.dayStartEquityByAsset[activeQuote]);
    if (!Number.isFinite(existingDayStart) || existingDayStart < 0) p.dayStartEquityByAsset[activeQuote] = currentQuoteEquity();
    p.dayStartEquity = Number(p.dayStartEquityByAsset[activeQuote] || 0);
    // Diskteki state kullanici tarafindan elle degistirilmis olabilir. JSON olarak
    // parse edilmesi tek basina guvenli oldugu anlamina gelmez; risk/pozisyon
    // alanlarini motor kullanmadan once semantik olarak normalize ediyoruz.
    const numericSettings = [
      ['maxConcurrentPositions', 3, 1, 100], ['maxOpenOrders', 12, 1, 1000],
      ['reserveCashPct', 10, 0, 90], ['dailyLossLimitPct', 0, 0, 100],
      ['killSwitchLossPct', 0, 0, 100], ['maxTradeQuote', 0, 0, 1e12],
      ['paperFeePct', 0.1, 0, 5], ['paperSlippagePct', 0.05, 0, 5],
      ['pollSeconds', 60, 15, 86400]
    ];
    for (const [key, fallback, min, max] of numericSettings) {
      const n = Number(st.settings[key]);
      st.settings[key] = Number.isFinite(n) && n >= min && n <= max ? n : fallback;
    }
    // A stopped engine cannot keep monitoring protective stops. Never allow the legacy toggle to leave positions unprotected.
    st.settings.closeOnDailyLoss = true;
    st.settings.portfolioPolicy = normalizePortfolioPolicy(st.settings.portfolioPolicy);
    normalizeExtras(st.settings);
    // Legacy scalar settings remain authoritative for backward-compatible direct state/test edits;
    // API/UI writes keep them synchronized with the policy.
    if (Number.isFinite(Number(st.settings.maxConcurrentPositions))) st.settings.portfolioPolicy.maxPositions = Number(st.settings.maxConcurrentPositions);
    if (Number.isFinite(Number(st.settings.reserveCashPct))) st.settings.portfolioPolicy.reserveCashPct = Number(st.settings.reserveCashPct);
    for (const [asset, value] of Object.entries(p.cashByAsset)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) delete p.cashByAsset[asset];
      else p.cashByAsset[asset] = n;
    }
    if (!p.positions || typeof p.positions !== 'object' || Array.isArray(p.positions)) p.positions = {};
    for (const [symbol, pos] of Object.entries(p.positions)) {
      const qty = Number(pos?.quantity);
      const entry = Number(pos?.entryPrice);
      const cost = Number(pos?.costQuote ?? pos?.costUSDT);
      const valid = pos && pos.symbol === symbol && qty > 0 && Number.isFinite(qty) &&
        entry > 0 && Number.isFinite(entry) && cost > 0 && Number.isFinite(cost);
      if (!valid) {
        delete p.positions[symbol];
        continue;
      }
      pos.quantity = qty; pos.entryPrice = entry; pos.costQuote = cost;
      pos.costUSDT = cost;
      pos.quoteAsset = String(pos.quoteAsset || this.quoteAsset(symbol)).toUpperCase();
      pos.baseAsset = String(pos.baseAsset || symbol.split('/')[0]).toUpperCase();
      if (!Number.isFinite(Number(pos.highWaterMark)) || Number(pos.highWaterMark) < entry) pos.highWaterMark = entry;
      // Break-even tamponu komisyon+kaymadan gelir (eski kayitlarda yoktu: sabit %0.20 zararla satiyordu).
      if (!Number.isFinite(Number(pos.breakEvenBufferPct)) || Number(pos.breakEvenBufferPct) < 0) pos.breakEvenBufferPct = breakEvenBufferPct(this.feeRate * 100, this.slipPct);
      if (pos.stopPrice !== null && (!Number.isFinite(Number(pos.stopPrice)) || Number(pos.stopPrice) <= 0)) pos.stopPrice = null;
    }
    if (!p.trades || !Array.isArray(p.trades)) p.trades = [];
    if (!p.equityHistory || !Array.isArray(p.equityHistory)) p.equityHistory = [];
    if (!p.lastPrices || typeof p.lastPrices !== 'object' || Array.isArray(p.lastPrices)) p.lastPrices = {};
    if (!p.lastPriceT || typeof p.lastPriceT !== 'object' || Array.isArray(p.lastPriceT)) p.lastPriceT = {}; // symbol -> son fiyatin alindigi zaman (ms)
    if (!p.lastSignalT || typeof p.lastSignalT !== 'object' || Array.isArray(p.lastSignalT)) p.lastSignalT = {};
    if (!p.firstPrices || typeof p.firstPrices !== 'object' || Array.isArray(p.firstPrices)) p.firstPrices = {};
    p.costs = p.costs && typeof p.costs === 'object' ? p.costs : { fees: 0, slippage: 0 };
    p.stats = p.stats && typeof p.stats === 'object' ? p.stats : { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, pctSum: 0 };
    if (!p.peakEquityByAsset || typeof p.peakEquityByAsset !== 'object' || Array.isArray(p.peakEquityByAsset)) p.peakEquityByAsset = {};
    if (!Number.isFinite(Number(p.peakEquityByAsset[activeQuote])) || Number(p.peakEquityByAsset[activeQuote]) <= 0) p.peakEquityByAsset[activeQuote] = this.computeEquity();
    p.peakEquity = Number(p.peakEquityByAsset[activeQuote]) || this.computeEquity();
    if (!Number.isFinite(p.maxDrawdownPct)) p.maxDrawdownPct = 0;
    if (!st.settings.riskDayTimezone) st.settings.riskDayTimezone = 'Europe/Istanbul';

    // Paper mode currently operates with ONE active quote ledger. If a position
    // from another quote survives a manual/disk-level quote switch, never let it
    // disappear from risk accounting. Lock the engine instead of trading with an
    // incomplete equity view. The UI/API already blocks this path for normal use;
    // this is the engine-level last line of defence for tampered/recovered state.
    const active = this.quoteLabel;
    const orphanQuotes = Object.entries(p.positions || {})
      .filter(([, pos]) => String(pos?.quoteAsset || this.quoteAsset(pos?.symbol)).toUpperCase() !== active)
      .map(([symbol]) => symbol);
    if (orphanQuotes.length > 0 && !st.killSwitch) {
      st.killSwitch = {
        t: iso(this.nowFn()),
        reason: `aktif quote ${active} ile uyumsuz açık pozisyon: ${orphanQuotes.join(', ')}`
      };
      st.running = false;
    }
  }

  // Paritesi silinmiş ama hâlâ açık olan pozisyon için yalnızca-risk izleme kaydı.
  _orphanPairCfg(symbol, pos) {
    return { symbol, enabled: false, orphan: true, strategyId: pos?.strategyId, timeframe: this.state.settings.defaultTimeframe, budgetPct: 0, params: {} };
  }

  _schedule() {
    if (this.timer) clearInterval(this.timer);
    const intervalMs = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
    this.timer = setInterval(() => this.safeTick(), intervalMs);
  }

  reschedule() {
    if (this.timer) this._schedule();
  }

  safeTick() {
    return this.tick().catch((e) => {
      this.log('Tick hatası: ' + e.message, 'error');
      // Canlı motorla aynı davranış: beklenmeyen tur hatası sessiz kalmasın (5 dk'da en fazla bir mesaj).
      this.notify(`🚨 Paper tick hatası: ${e.message}`, { key: 'paper-tick-error', minIntervalMs: 5 * 60000, priority: 'critical' });
    });
  }

  riskBaselineError() {
    const paper = this.state.paper || {};
    const quote = this.quoteLabel;
    const start = Number(paper.startingBalanceByAsset?.[quote]);
    const dayStart = Number(paper.dayStartEquityByAsset?.[quote]);

    if (!Number.isFinite(start) || start <= 0) {
      return `Aktif kasa ${quote} için geçerli başlangıç risk tabanı yok. Paper hesabını sıfırla.`;
    }
    if (!Number.isFinite(dayStart) || dayStart <= 0) {
      return `Aktif kasa ${quote} için geçerli günlük risk tabanı yok. Paper hesabını sıfırla.`;
    }

    const equity = this.computeEquity();
    if (!Number.isFinite(equity) || equity <= 0) {
      return `Aktif kasa ${quote} için geçerli mevcut öz sermaye yok. Paper bot başlatılmadı.`;
    }

    return '';
  }

  start() {
    if (this.timer) return;
    if (this.state.settings.mode !== 'paper') {
      throw new Error('Bu sürüm yalnızca paper trading destekliyor; canlı işlem motoru henüz etkin değil.');
    }

    // Başlatmadan önce state'i normalize et ve risk tabanını doğrula.
    this.ensureState();

    if (this.state.killSwitch) {
      throw new Error(`Kill switch devrede (${this.state.killSwitch.reason}). Önce hesabı sıfırla ya da limiti gevşetip kilidi kaldır.`);
    }

    const baselineError = this.riskBaselineError();
    if (baselineError) {
      this.state.running = false;
      this.persist();
      throw new Error(`Paper bot başlatılmadı: ${baselineError}`);
    }

    this.state.running = true;
    this.log('Bot başlatıldı (kağıt işlem modu).');
    this.notify('▶ Bot başlatıldı (kağıt işlem).', { key: 'start', minIntervalMs: 60000, priority: 'quiet' });
    this.persist();
    this._schedule();
    this.safeTick(); // ilk turu hemen at
  }

  // opts.notify=false: durdurma zaten ayri bir bildirimle duyurulduysa (kill switch, gunluk limit, Telegram /bitir) tekrar mesaj atma.
  stop(reason = 'Kullanıcı durdurdu.', { notify = true } = {}) {
    const wasRunning = this.state.running === true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.epoch++; // askidaki tick varsa sonuclarini state'e yazmasin
    // Takilmis (hic donmeyen) bir tick busy'yi tutuyorsa yeniden baslatma da calismazdi: kilidi birak.
    this.busy = false;
    this.busyToken = null;
    this.state.running = false;
    this.log('Bot durduruldu: ' + reason);
    this.persist();
    if (notify && wasRunning) {
      this.notify(fmt.engineStopped({ mode: 'paper', reason, openPositions: Object.keys(this.state.paper?.positions || {}), at: this.nowFn() }), { key: 'stopped', minIntervalMs: 30000, priority: 'critical', durable: true, html: true });
    }
  }

  async getSymbolRules(symbol) {
    if (this.symbolRulesCache[symbol]) return this.symbolRulesCache[symbol];
    try {
      const rules = await this._withTimeout(() => this.exchange.fetchSymbolRules(symbol), `${symbol} kuralları`);
      this.symbolRulesCache[symbol] = rules;
      return rules;
    } catch (e) {
      this.logThrottled(`rules:${symbol}`, `${symbol} kuralları alınamadı, varsayılan kullanılıyor (${e.message})`);
      return { minNotional: FALLBACK_MIN_NOTIONAL, stepSize: 0, minQty: 0 };
    }
  }

  getRiskDayKey(ms = this.nowFn()) {
    const tz = this.state.settings.riskDayTimezone || 'Europe/Istanbul';
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  rolloverDayIfNeeded(equity) {
    const todayKey = this.getRiskDayKey();
    if (this.state.paper.dayKey !== todayKey) {
      const byQuote = this.computeEquityByQuote();
      const suppliedEquity = Number(equity);
      const computedEquity = Number(byQuote[this.quoteLabel]);
      const dayStart = Number.isFinite(suppliedEquity) && suppliedEquity > 0
        ? suppliedEquity
        : computedEquity;

      // Sıfır/geçersiz equity yeni günlük risk tabanı olamaz.
      // Eski tabanı koru; sonraki turda tekrar dene.
      if (!Number.isFinite(dayStart) || dayStart <= 0) return;

      byQuote[this.quoteLabel] = dayStart;
      this.state.paper.dayKey = todayKey;
      this.state.paper.dayStartEquityByAsset = { ...byQuote };
      this.state.paper.dayStartEquity = dayStart;
    }
  }

  // Pozisyonlar EN SON BILINEN fiyatlarla degerlenir; bir turda veri gelmezse
  // pozisyon giris fiyatina "sicramaz".
  computeEquity(lastPrices = this.state.paper.lastPrices || {}) {
    this._syncLegacyCash(this.quoteLabel);
    const byQuote = this.computeEquityByQuote(lastPrices);
    const primary = this.quoteLabel;
    return Number(byQuote[primary] || 0);
  }

  async tick() {
    if (!this.state.running) return;
    if (this.busy) {
      // onceki tur bitmedi (yavas ag), bu turu atla -- ama sonsuza kadar degil.
      const stuckMs = Number(this.nowFn()) - Number(this.busySince);
      if (!(Number.isFinite(stuckMs) && stuckMs > this.tickWatchdogMs)) return;
      this.log(`Önceki tur ${Math.round(stuckMs / 60000)} dk'dır bitmedi; takılmış sayıldı, kilit serbest bırakıldı.`, 'error');
      this.epoch++; // takili tick sonunda dönerse state'e yazmasın
      this.busy = false;
      this.busyToken = null;
    }
    const token = {};
    this.busyToken = token;
    this.busy = true;
    this.busySince = this.nowFn();
    const epoch = this.epoch;
    try {
      await this._tick(epoch);
    } finally {
      if (this.busyToken === token) { this.busy = false; this.busyToken = null; }
    }
  }

  async _tick(epoch) {
    this.ensureState();
    if (this.state.killSwitch) {
      // ensureState may have discovered a tampered/recovered state that cannot be
      // represented safely in the active quote. Persist the lock before returning.
      this.persist();
      return;
    }
    const now = this.nowFn();
    if (!Number.isFinite(Number(now))) throw new Error('Geçersiz sistem zamanı.');
    if (this.lastTickAt !== null && now < this.lastTickAt - 2 * 60 * 1000) {
      this.state.running = false;
      this.state.killSwitch = { t: iso(now), reason: 'sistem saati geriye gitti; güvenlik nedeniyle Paper durduruldu' };
      this.persist();
      return;
    }
    this.lastTickAt = now;
    const lastPrices = {};
    const jobs = [];
    this.entryPauseReason = '';
    let attempted = 0;
    let failed = 0;
    let failedWithPosition = false;

    // 1) Önce bu turun bütün piyasa verisini topluyoruz. Böylece gün değişiminde
    // dayStart equity, ilk işlenen paritenin değil bütün mevcut fiyatların toplamı olur.
    const workList = Object.entries(this.state.pairs || {});
    // Pariteye bağlı olmayan açık pozisyon da izlenir. Eskiden döngü yalnızca state.pairs'i
    // gezdiği için paritesi silinmiş bir pozisyonun stop-loss'u çalışmıyor, fiyatı
    // güncellenmiyor ve kill switch eski fiyatla hesap yapıyordu.
    for (const [symbol, pos] of Object.entries(this.state.paper.positions || {})) {
      if (!(this.state.pairs || {})[symbol]) workList.push([symbol, this._orphanPairCfg(symbol, pos)]);
    }

    await mapWithConcurrency(workList, this.marketDataConcurrency, async ([symbol, pairCfg]) => {
      let strategy;
      let params;
      let riskOnly = pairCfg?.orphan === true; // true: yalnızca risk çıkışları (stop) izlenir, strateji sinyali uygulanmaz
      try {
        if (!pairCfg || typeof pairCfg !== 'object') throw new Error('parite kaydı geçersiz');
        const hasPosition = !!this.state.paper.positions[symbol];
        if (!pairCfg.enabled && !hasPosition) return;

        if (!this.pairSupported(symbol) && !hasPosition) {
          this.logThrottled(`quote:${symbol}`, `${symbol}: kasa birimi aktif borsada (${this.exchange.name || this.exchange.id}) desteklenmiyor, atlanıyor.`);
          return;
        }

        try {
          strategy = strategies.get(pairCfg.strategyId);
        } catch (e) {
          if (!hasPosition) throw e;
          // Strateji kaydı bozuk ama açık pozisyon var: stop'u izlemeye devam et (sinyal uygulanmaz).
          this.logThrottled(`strategy:${symbol}`, `${symbol}: ${e.message}; açık pozisyon yalnızca stop ile izleniyor.`);
          strategy = Object.values(strategies.registry)[0];
          riskOnly = true;
        }
        params = { ...strategy.defaultParams, ...(riskOnly ? {} : (pairCfg.params || {})) };
        const paramError = strategies.validateParams(strategy.id, params);
        if (paramError) {
          if (!hasPosition) {
            this.logThrottled(`params:${symbol}`, `${symbol}: geçersiz strateji parametreleri, işlem atlandı (${paramError})`);
            return;
          }
          this.logThrottled(`params:${symbol}`, `${symbol}: geçersiz strateji parametreleri (${paramError}); açık pozisyon yalnızca stop ile izleniyor.`);
          params = { ...strategy.defaultParams };
          riskOnly = true;
        }
      } catch (e) {
        // Tek bir bozuk kayıt diğer pozisyonların izlenmesini durdurmasın.
        this.logThrottled(`entry:${symbol}`, `${symbol}: kayıt işlenemedi, atlandı (${e.message})`);
        if (this.state.paper.positions[symbol]) { attempted++; failed++; failedWithPosition = true; }
        return;
      }

      attempted++;
      try {
        const timeframe = pairCfg.timeframe || this.state.settings.defaultTimeframe;
        let limit = Math.min(1000, strategies.candleLimit(strategy, params) + 1);
        // Veri kesintisinden sonra geriye dönük stop taraması, son taranan mumdan bu yana
        // geçen BÜTÜN mumları görmeli; yoksa kesinti sırasında oluşan stop tetiği kaçar.
        const openPos = this.state.paper.positions[symbol];
        const tfMs = timeframeMs(timeframe);
        if (openPos && tfMs > 0 && Number(openPos.checkedThroughT) > 0) {
          const needed = Math.ceil((now - Number(openPos.checkedThroughT)) / tfMs) + 2;
          if (needed > 1000) this.logThrottled(`gap:${symbol}`, `${symbol}: son stop taramasından bu yana ${needed} mum geçti; borsadan en fazla 1000 mum alınabilir, en eski kısım taranamayabilir.`, 'error');
          limit = Math.min(1000, Math.max(limit, needed));
        }
        const candles = await this._withTimeout(() => this.exchange.fetchCandles(symbol, timeframe, limit), `${symbol} mum verisi`);

        if (!Array.isArray(candles) || candles.length > 1200) {
          throw new Error('Borsa geçersiz veya beklenenden büyük mum listesi döndürdü.');
        }
        validateCandleSeries(candles, timeframe);
        // Yapısal olarak geçerli mumlar bile borsanın önbelleğinde kalmış olabilir.
        // Eski/gelecek zaman damgalı veriyi yeni fiyat gibi kullanmak equity ve zarar
        // limitlerini yanıltabilir; böyle bir seriyi tümüyle reddedip son fiyatı koru.
        const latestCandle = candles[candles.length - 1];
        if (latestCandle) {
          const timeframeDuration = timeframeMs(timeframe);
          const pollMs = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
          const maxDataAgeMs = Math.max(2 * (timeframeDuration || 0), 5 * pollMs, 5 * 60 * 1000);
          const futureToleranceMs = Math.max(5 * 60 * 1000, 2 * pollMs);
          const ageMs = now - Number(latestCandle.t);
          if (ageMs > maxDataAgeMs) {
            throw new Error(`piyasa verisi eski (${Math.round(ageMs / 60000)} dk; sınır ${Math.round(maxDataAgeMs / 60000)} dk)`);
          }
          if (ageMs < -futureToleranceMs) {
            throw new Error('piyasa verisinin zaman damgası sistem zamanından ileride');
          }
        }

        if (epoch !== this.epoch) return;
        if (pairCfg.orphan === true) {
          // Bu arada parite yeniden eklendiyse bir sonraki tur normal parite olarak işler.
          if (this.state.pairs[symbol] || !this.state.paper.positions[symbol]) { attempted--; return; }
        } else if (this.state.pairs[symbol] !== pairCfg) { attempted--; return; }
        if (!candles.length) throw new Error('borsa boş mum listesi döndürdü');

        const price = candles[candles.length - 1].c;
        lastPrices[symbol] = price;
        if (this.state.paper.firstPrices[symbol] === undefined) this.state.paper.firstPrices[symbol] = price;
        jobs.push({ symbol, pairCfg, strategy, params, candles, price, timeframe, riskOnly });
      } catch (e) {
        if (epoch !== this.epoch) return;
        failed++;
        if (this.state.paper.positions[symbol]) failedWithPosition = true;
        const d = this.state.decisions[symbol] || (this.state.decisions[symbol] = { action: 'hold', reason: 'ilk değerlendirme bekleniyor' });
        d.error = `veri alınamadı: ${e.message}`;
        d.checkedAt = iso(now);
        this.logThrottled(`tick:${symbol}`, `${symbol} işlenemedi: ${e.message}`);
      }
    });

    if (epoch !== this.epoch) return;

    const paper = this.state.paper;
    paper.lastPrices = { ...paper.lastPrices, ...lastPrices };
    paper.lastPriceT = paper.lastPriceT || {};
    for (const symbol of Object.keys(lastPrices)) paper.lastPriceT[symbol] = Number(now);

    // Gün başlangıcı, bütün başarılı veri akışı toplandıktan sonra sabitlenir.
    // Böylece gece oluşan fiyat hareketi yeni günün zararına yazılmaz ve ilk
    // yeni-gün BUY kararı da doğru gün başlangıcı bütçesini kullanır.
    const equity = this.computeEquity(paper.lastPrices);
    // Gün değişiminde bir açık pozisyonun fiyatı alınamadıysa eski mark-to-market
    // değerini yeni günün başlangıç bakiyesi diye sabitleme. Veri geri geldiğinde
    // rollover yeniden denenir.
    if (!failedWithPosition) this.rolloverDayIfNeeded(equity);

    // 2) Açık pozisyonları önce işle: bir pozisyonun verisi/işlenmesi bozuksa
    // aynı turda daha sonra yeni risk açılmasını engelleyebiliriz.
    // Forager (opsiyonel): yeni alim adaylarini skora gore sirala; sonraki kararli siralama acik pozisyonlari yine one alir.
    try {
      const plan = foragerPlan(this.state.settings, jobs.filter((j) => !this.state.paper.positions[j.symbol]).map((j) => ({ symbol: j.symbol, candles: j.candles })));
      this.foragerPruned = plan.pruned;
      if (this.state.settings.forager && this.state.settings.forager.enabled) {
        const rank = new Map(plan.order.map((s, i) => [s, i]));
        jobs.sort((a, b) => (rank.has(a.symbol) ? rank.get(a.symbol) : -1) - (rank.has(b.symbol) ? rank.get(b.symbol) : -1));
      }
    } catch (e) { this.foragerPruned = new Set(); this.logThrottled('forager', `forager sıralaması atlandı: ${e.message}`, 'warn'); }
    jobs.sort((a, b) => Number(!!this.state.paper.positions[b.symbol]) - Number(!!this.state.paper.positions[a.symbol]));
    if (failedWithPosition) this.entryPauseReason = 'açık pozisyon için piyasa verisi alınamadı';
    for (const job of jobs) {
      try {
        await this.processPair({ ...job, now, epoch });
        if (epoch !== this.epoch) return;
        this.syncProtectionStop(this.state.paper.positions[job.symbol], job.params);

        const d = this.state.decisions[job.symbol] || (this.state.decisions[job.symbol] = { action: 'hold', reason: 'ilk değerlendirme bekleniyor' });
        d.price = job.price;
        d.checkedAt = iso(now);
        delete d.error;
      } catch (e) {
        failed++;
        if (this.state.paper.positions[job.symbol]) {
          failedWithPosition = true;
          this.entryPauseReason = 'açık pozisyonun değerlendirmesi başarısız';
        }
        const d = this.state.decisions[job.symbol] || (this.state.decisions[job.symbol] = { action: 'hold', reason: 'ilk değerlendirme bekleniyor' });
        d.error = `işlem değerlendirmesi başarısız: ${e.message}`;
        d.checkedAt = iso(now);
        this.logThrottled(`process:${job.symbol}`, `${job.symbol} değerlendirilemedi: ${e.message}`);
      }
    }

    if (epoch !== this.epoch) return;

    // İşlem kararları sonrası gerçek equity yeniden hesaplanır; özellikle aynı
    // turda BUY/SELL olduysa history ve loss limitleri son durumu görmeli.
    paper.lastPrices = { ...paper.lastPrices, ...lastPrices };
    const finalEquity = this.computeEquity(paper.lastPrices);
    paper.equityHistory.push({ t: iso(now), equity: finalEquity });
    paper.equityHistory = paper.equityHistory.slice(-500);
    paper.peakEquityByAsset = paper.peakEquityByAsset || {};
    const quotePeak = Number(paper.peakEquityByAsset[this.quoteLabel]) || finalEquity;
    paper.peakEquityByAsset[this.quoteLabel] = Math.max(quotePeak, finalEquity);
    paper.peakEquity = paper.peakEquityByAsset[this.quoteLabel];
    if (paper.peakEquity > 0) paper.maxDrawdownPct = Math.min(paper.maxDrawdownPct, (finalEquity / paper.peakEquity - 1) * 100);

    this.trackOutage(attempted, failed, failedWithPosition);

    const riskEquity = this.liquidationEquity(paper.lastPrices);
    // Eski fiyatla pozisyonu o eski fiyattan kapatmak muhasebeyi bozar; bu yüzden kesintide yalnızca
    // taze fiyatı olan pozisyonlar kapatılır, diğerleri için uyarı verilir (bkz. checkLossLimits).
    // Veri kesintisinde de limitler değerlendirilir (eskiden tamamen atlanıyor, kesinti sırasında kill switch
    // ve günlük limit devre dışı kalıyordu). Taze fiyatı olmayan pozisyon ESKİ fiyattan satılmaz.
    if (this.checkLossLimits(riskEquity, { freshSince: now, degraded: failedWithPosition })) return;

    this.persist();
    if (this.notifier && attempted > 0 && failed < attempted) this.notifier.ping().catch(() => {});
  }

  // Bir paritenin bir turdaki tum isleri: risk taramasi -> yeni kapanan mumda sinyal -> dolum -> olusan mumda risk.
  syncProtectionStop(position, params) {
    if (!position) return;
    const sl = Number(params?.stopLossPct);
    const tp = Number(params?.takeProfitPct);
    if (!Number.isFinite(sl) || !Number.isFinite(position.highWaterMark) || !Number.isFinite(position.entryPrice)) return;
    const activation = Number.isFinite(tp) && tp > 0
      ? position.entryPrice * (1 + tp / 100)
      : Infinity;
    const active = !!params?.trailingStop || position.highWaterMark >= activation;
    if (!active) return;
    const breakEvenActive = position.highWaterMark >= activation;
    const profitStop = profitProtectionStop(position.entryPrice, position.highWaterMark, sl, breakEvenActive, position.breakEvenBufferPct);
    // A trailing update may tighten, but must never lower a tighter ATR/initial stop.
    position.stopPrice = Number.isFinite(position.stopPrice) ? Math.max(position.stopPrice, profitStop) : profitStop;
  }

  async processPair({ symbol, pairCfg, strategy, params, candles, now, price, epoch, riskOnly = false, timeframe = pairCfg.timeframe || this.state.settings.defaultTimeframe }) {
    const paper = this.state.paper;
    const { closed, forming } = splitCandles(candles, now, timeframe);
    const lastClosed = closed[closed.length - 1];
    let pos = paper.positions[symbol] || null;

    // (a) KAPANMIS mumlarda, henuz taranmamis olanlarda mum ici risk kontrolu (ag kesintisi vb. icin geriye donuk).
    if (pos) {
      if (pos.checkedThroughT === undefined) pos.checkedThroughT = lastClosed ? lastClosed.t : 0; // eski kayit: simdiden itibaren
      for (const c of closed) {
        if (c.t <= pos.checkedThroughT) continue;
        const hit = intrabarRiskExit(pos, c, params, true);
        if (hit) {
          if (this.sellAt(symbol, pos, hit.ref, hit.reason) === true) {
            pos = null;
          } else {
            // Satış başarısız: pozisyon AÇIK kalır. checkedThroughT ilerletilmez, bu mum
            // sonraki turda yeniden taranır; bu arada yeni alım durdurulur.
            this.logThrottled(`sell-fail:${symbol}`, `${symbol}: ${hit.reason} satışı gerçekleşmedi, pozisyon açık; sonraki turda yeniden denenecek.`, 'error');
            this.entryPauseReason = this.entryPauseReason || 'açık pozisyon satışı başarısız';
          }
          break;
        }
        pos.checkedThroughT = c.t;
      }
    }

    // (b) Yeni kapanan mum varsa sinyali BIR KEZ degerlendir.
    // riskOnly (parite silinmiş / strateji kaydı bozuk): yalnızca stop izlenir, strateji sinyali uygulanmaz.
    if (!riskOnly && lastClosed && paper.lastSignalT[symbol] !== lastClosed.t) {
      const decision = strategy.evaluate({ candles: closed, position: pos, params });
      // Sinyal taze mi? Mum kapanisindan cok sonra (bot kapaliydi, parite yeni eklendi) uygulanmaz.
      const pollMs = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
      const step = forming ? forming.t - lastClosed.t : (candles.length > 1 ? lastClosed.t - candles[candles.length - 2].t : timeframeMs(timeframe));
      const closeT = forming ? forming.t : lastClosed.t + (step || timeframeMs(timeframe));
      // API sadece kapanmis mumlari donduruyorsa forming=false olabilir.
      // Bu durumda sinyali sonsuza kadar fresh kabul etmek YASAK: kapanis zamani
      // lastClosed.t + timeframe'dan hesaplanir.
      const maxAgeMs = Math.min(Math.max(3 * pollMs, 120000), Math.max(60000, (step || timeframeMs(timeframe) || 3600000) / 2));
      // Production freshness checks must never be bypassed for synthetic timestamps.
      // Tests that use historical fixtures must inject a matching nowFn instead.
      const ageMs = Math.max(0, now - closeT);
      const fresh = ageMs <= maxAgeMs;

      this.state.decisions[symbol] = {
        action: decision.action,
        reason: decision.reason,
        candleT: lastClosed.t,
        evaluatedAt: iso(now),
        price,
        checkedAt: iso(now),
        stale: !fresh
      };

      const prevSignalT = paper.lastSignalT[symbol];
      // Uygulanamayan SELL sinyali tüketilmiş sayılmaz: pozisyon açık kalırsa sonraki turda (sinyal hâlâ tazeyse) yeniden denenir.
      const keepSignalForRetry = () => { if (prevSignalT === undefined) delete paper.lastSignalT[symbol]; else paper.lastSignalT[symbol] = prevSignalT; };
      paper.lastSignalT[symbol] = lastClosed.t;
      if (!fresh) {
        if (decision.action !== 'hold') {
          this.logThrottled(`stale:${symbol}`, `${symbol}: ${decision.action === 'buy' ? 'alım' : 'satım'} sinyali eski (${Math.round(ageMs / 60000)} dk önce kapanan mum), uygulanmadı.`, 'info');
        }
      } else {
        // Varsayılan: backtest ile birebir aynı kural (dolum mumun AÇILIŞINDAN; test/parity.test.js bunu doğrular).
        // Ancak bot yeni mumu açılıştan ~90 sn sonra görebilir ve canlıda o açılış fiyatı alınamaz, yani paper
        // sonuçları iyimser kalır. settings.paperConservativeFill=true ise referans, açılış ile GÖZLENEN fiyattan
        // KÖTÜ olandır (alımda yüksek, satımda düşük); bu mod backtest ile birebir eşleşmez, bilerek.
        const observed = Number.isFinite(Number(price)) && Number(price) > 0 ? Number(price) : null;
        const conservative = this.state.settings.paperConservativeFill === true;
        const fillRefFor = (side) => {
          if (!forming) return null;
          if (ageMs > pollMs * 1.5) return observed ?? forming.o;
          if (!conservative || observed === null) return forming.o;
          return side === 'buy' ? Math.max(forming.o, observed) : Math.min(forming.o, observed);
        };
        if (decision.action === 'sell' && pos) {
          const sellRef = fillRefFor('sell');
          if (sellRef != null) {
            if (this.sellAt(symbol, pos, sellRef, decision.reason) === true) pos = null;
            else {
              keepSignalForRetry();
              this.logThrottled(`sell-fail:${symbol}`, `${symbol}: SELL sinyali uygulanamadı, pozisyon açık; sinyal sonraki turda yeniden denenecek.`, 'error');
            }
          } else {
            keepSignalForRetry();
            this.logThrottled(`no-forming-sell:${symbol}`, `${symbol}: forming mum yok; yeni SELL son kapanıştan uygulanmadı.`);
          }
        } else if (decision.action === 'hold' && pos) {
          // Zaman bariyeri: strateji tutmayi seciyor ama pozisyon cok uzun suredir hedefe ulasamadi.
          const tb = timeBarrierExit({ position: pos, closedCandles: closed, price: observedPrice(price, lastClosed), config: this.state.settings.timeBarrier });
          if (tb) {
            const sellRef = fillRefFor('sell');
            if (sellRef != null) {
              if (this.sellAt(symbol, pos, sellRef, tb.reason) === true) pos = null;
              else keepSignalForRetry();
            } else keepSignalForRetry();
          }
        } else if (decision.action === 'buy' && pairCfg.enabled && !pos) {
          const blocked = this._extrasEntryBlock(symbol, closed, timeframe, now);
          if (blocked) {
            this.state.decisions[symbol].blockedBy = blocked.reason;
            this.logThrottled(`extras-block:${symbol}`, `${symbol}: alım sinyali uygulanmadı — ${blocked.reason}.`, 'info');
            return;
          }
          const buyRef = fillRefFor('buy');
          if (buyRef != null) { await this.tryBuy(symbol, pairCfg, decision, params, buyRef, lastClosed.t, epoch); pos = paper.positions[symbol] || null; }
          else this.logThrottled(`no-forming:${symbol}`, `${symbol}: forming mum yok; yeni BUY son kapanıştan doldurulmadı.`);
        }
      }
    }

    // (c) Olusan (henuz kapanmamis) mumda mum ici risk kontrolu. Zirve guncellenmez (commit=false).
    pos = paper.positions[symbol] || null;
    if (pos && forming && forming.t > (pos.checkedThroughT ?? 0)) {
      const hit = intrabarRiskExit(pos, forming, params, false);
      if (hit && this.sellAt(symbol, pos, hit.ref, hit.reason) !== true) {
        this.logThrottled(`sell-fail:${symbol}`, `${symbol}: ${hit.reason} satışı gerçekleşmedi, pozisyon açık; sonraki turda yeniden denenecek.`, 'error');
        this.entryPauseReason = this.entryPauseReason || 'açık pozisyon satışı başarısız';
      }
    }
  }

  _extrasEntryBlock(symbol, closed, timeframe, now) {
    try {
      let referenceEquity = 0;
      try { referenceEquity = Number(this.computeEquity()) || 0; } catch { referenceEquity = 0; }
      return entryBlock({
        settings: this.state.settings,
        trades: this.state.paper.trades,
        symbol, now, closedCandles: closed,
        timeframeMs: timeframeMs(timeframe),
        referenceEquity,
        foragerPruned: this.foragerPruned
      });
    } catch (e) {
      // Ek katman hatasi alimi sessizce acmamali ama tum motoru da durdurmamali: guvenli taraf = bu alimi atla.
      return { reason: `ek koruma katmanı hatası (${e.message}); güvenli tarafta alım atlandı` };
    }
  }

  async tryBuy(symbol, pairCfg, decision, params, refPrice, lastClosedT, epoch) {
    const settings = this.state.settings;
    const positions = () => this.state.paper.positions;
    if (this.entryPauseReason) {
      this.logThrottled(`entry-pause:${symbol}`, `${symbol}: yeni alım güvenlik nedeniyle durduruldu (${this.entryPauseReason}).`);
      return;
    }
    if (positions()[symbol]) return;
    if (Object.keys(positions()).length >= settings.maxConcurrentPositions) return; // portfoy geneli limit dolu

    const budgetPct = Number(pairCfg.budgetPct);
    if (!Number.isFinite(budgetPct) || budgetPct <= 0 || !Number.isFinite(refPrice) || refPrice <= 0) {
      this.logThrottled(`buy:${symbol}`, `${symbol}: alım atlandı, bütçe payı ya da fiyat geçersiz.`);
      return;
    }

    // Kill switch / gunluk zarar limiti asilmisken YENI giris acilmaz (canli motorla ayni davranis).
    // Eskiden limit yalnizca tur sonunda kontrol edildigi icin ayni turda alim yapip hemen kapatiliyordu.
    const gate = this.entryRiskGate();
    if (gate) { this.logThrottled(`riskgate:${symbol}`, `${symbol}: alım atlandı, ${gate}.`); return; }

    const pairAtStart = this.state.pairs[symbol];
    const rules = await this.getSymbolRules(symbol);

    // await sirasinda durum degismis olabilir: yeniden dogrula.
    if (epoch !== undefined && epoch !== this.epoch) return;
    // await sirasinda parite silinmis/degistirilmis olabilir: sahipsiz (izlenmeyen) pozisyon acma.
    if (this.state.pairs[symbol] !== pairAtStart || pairCfg.enabled === false) return;
    if (this.entryRiskGate()) return;
    if (positions()[symbol]) return;
    if (Object.keys(positions()).length >= settings.maxConcurrentPositions) return;

    const paper = this.state.paper;
    const quote = this.quoteAsset(symbol);
    if (!this.pairSupported(symbol)) return;
    const feeRate = this.feeRate;
    const quoteCash = this.cashFor(quote);
    const dayStartQuote = Number((paper.dayStartEquityByAsset || {})[quote] || quoteCash);
    const reserve = dayStartQuote * (settings.reserveCashPct / 100) || 0;
    const spendable = Math.max(0, quoteCash - reserve);
    // budgetPct portföyün ortak başlangıç/günlük equity'sinin hedef payıdır;
    // kalan nakdin yüzdesi değildir. Böylece BTC/ETH/SOL için 30/30/30,
    // %10 rezerv ile gerçekten ortak kasadan hedeflenir ve işlem sırasına
    // bağlı olarak 30 -> 21 -> 14.7 şeklinde küçülmez.
    let amount = budgetPct >= 100
      ? spendable
      : Math.min(spendable, Math.max(0, dayStartQuote * (budgetPct / 100)));

    const maxTrade = Number(settings.maxTradeQuote);
    if (maxTrade > 0) amount = Math.min(amount, maxTrade);

    // Borsanin minimum emir degeri KOMISYON dusuldukten sonra da saglanmali.
    const minNotional = rules.minNotional || FALLBACK_MIN_NOTIONAL;
    const minAmount = (minNotional * (1 + feeRate)) * 1.005;
    if (amount < minAmount) {
      const canRaise = spendable >= minAmount && !(maxTrade > 0 && maxTrade < minAmount);
      if (!canRaise) {
        this.logThrottled(`buy:${symbol}`, `${symbol}: alım sinyali var ama kullanılabilir bakiye minimum emrin (${minNotional} ${quote}) altında.`);
        return;
      }
      amount = minAmount; // en azindan minimumu dene
    }

    // Portfoy politikasi NIHAI tutarla kontrol edilir (min-notional yukseltmesi kategori sinirini asamaz).
    const equityNow = this.computeEquity();
    const policyCheck = canOpenPosition({ symbol, pair: pairCfg, positions: positions(), pairs: this.state.pairs, policy: settings.portfolioPolicy, equity: equityNow, requestedCost: amount });
    if (!policyCheck.ok) { this.logThrottled(`policy:${symbol}:${policyCheck.reason}`, `${symbol}: portföy politikası nedeniyle alım atlandı: ${policyCheck.reason}.`); return; }

    const fill = buyFill(refPrice, this.slipPct);
    if (!Number.isFinite(fill) || fill <= 0) {
      this.logThrottled(`buy:${symbol}`, `${symbol}: dolum fiyatı sayısal sınır dışında, alım atlandı.`);
      return;
    }
    // Fee is charged on the executed quote notional. The budget includes both
    // notional and fee, so solve quantity = budget / (price * (1 + feeRate)).
    let quantity = roundDownToStep(amount / (fill * (1 + feeRate)), rules.stepSize);
    if (!(quantity > 0) || (rules.minQty && quantity < rules.minQty)) {
      this.logThrottled(`buy:${symbol}`, `${symbol}: miktar borsanın minimum lotunun altında, alım atlandı.`);
      return;
    }
    if (quantity * fill < minNotional) {
      this.logThrottled(`buy:${symbol}`, `${symbol}: yuvarlama sonrası emir değeri minimumun (${minNotional} ${quote}) altında, alım atlandı.`);
      return;
    }

    const notional = quantity * fill;
    const fee = notional * feeRate;
    const cost = notional + fee; // gerçek quote çıkışı = dolum notional'ı + notional üzerinden komisyon
    if (![notional, fee, cost].every(Number.isFinite) || notional <= 0 || fee < 0 || cost < 0 || cost > amount + 1e-8 || cost > quoteCash + 1e-9) {
      this.logThrottled(`buy:${symbol}`, `${symbol}: işlem maliyeti sayısal/bakiye sınırını aşıyor, alım atlandı.`, 'error');
      return;
    }
    const stopLossPct = Number(params.stopLossPct);
    const position = {
      symbol,
      strategyId: pairCfg.strategyId,
      entryPrice: fill,
      quantity,
      costQuote: cost,
      quoteAsset: quote,
      baseAsset: String(symbol).split('/')[0].toUpperCase(),
      costUSDT: cost,
      stopPrice: (() => {
        const pctStop = Number.isFinite(stopLossPct) ? fill * (1 - stopLossPct / 100) : null;
        const distance = Number(decision?.suggestedStopDistance);
        const strategyStop = Number.isFinite(distance) && distance > 0 ? fill - distance : null;
        return Number.isFinite(pctStop) && Number.isFinite(strategyStop) ? Math.max(pctStop, strategyStop) : (Number.isFinite(pctStop) ? pctStop : strategyStop);
      })(),
      highWaterMark: fill,
      breakEvenBufferPct: breakEvenBufferPct(feeRate * 100, this.slipPct),
      openedAt: iso(this.nowFn()),
      checkedThroughT: lastClosedT,
      reason: decision.reason
    };
    this.commitPaperMutation((candidate) => {
      const cp = candidate.paper;
      cp.cashByAsset = cp.cashByAsset || {};
      cp.cashByAsset[quote] = Math.max(0, quoteCash - cost);
      if (String(candidate.settings.quoteAsset || '').toUpperCase() === quote) {
        cp.cash = cp.cashByAsset[quote];
        cp._legacyCashMirror = cp.cash;
      }
      cp.costs = cp.costs || { fees: 0, slippage: 0 };
      cp.costs.fees += fee;
      cp.costs.slippage += (fill - refPrice) * quantity;
      cp.positions[symbol] = position;
    });
    const remainingCash = Math.max(0, quoteCash - cost);
    const baseAsset = String(symbol).split('/')[0].toUpperCase();
    const msg = `ALIM ${symbol} @ ${formatPrice(fill)} | miktar: ${formatQuantity(quantity)} ${baseAsset} | harcanan: ${formatMoney(cost)} ${this.quoteLabel} | kalan: ${formatMoney(remainingCash)} ${this.quoteLabel} | komisyon: ${formatMoney(fee)} ${this.quoteLabel} - ${decision.reason}`;
    this.log(msg);
    this.notify(fmt.paperBuy({ symbol, fill, quantity, cost, remainingCash, fee, reason: decision.reason, at: this.nowFn() }), { html: true, durable: true });
  }

  // ref: kaymasiz referans fiyat; dolum fiyati kayma ile hesaplanir.
  sellAt(symbol, position, ref, reason) {
    const paper = this.state.paper;
    const quote = position.quoteAsset || this.quoteAsset(symbol);
    const cashBefore = this.cashFor(quote);
    const fill = sellFill(ref, this.slipPct);
    if (!Number.isFinite(fill) || fill <= 0) {
      this.logThrottled(`sell:${symbol}`, `${symbol}: satış dolum fiyatı sayısal sınır dışında, satış atlandı.`, 'error');
      return false;
    }
    const gross = position.quantity * fill;
    const fee = gross * this.feeRate;
    const net = gross - fee;
    if (![gross, fee, net].every(Number.isFinite) || gross < 0 || fee < 0 || net < 0) {
      this.logThrottled(`sell:${symbol}`, `${symbol}: satış muhasebesi sayısal sınır dışında, pozisyon korunuyor.`, 'error');
      return false;
    }
    const costQuote = Number(position.costQuote ?? position.costUSDT ?? 0);
    const pnl = net - costQuote;
    const pnlPct = costQuote > 0 ? (pnl / costQuote) * 100 : 0;

    const trade = {
      symbol,
      entryPrice: position.entryPrice,
      exitPrice: fill,
      quantity: position.quantity,
      pnl,
      pnlPct,
      reason,
      openedAt: position.openedAt,
      closedAt: iso(this.nowFn())
    };
    this.commitPaperMutation((candidate) => {
      const cp = candidate.paper;
      cp.cashByAsset = cp.cashByAsset || {};
      cp.cashByAsset[quote] = cashBefore + net;
      if (String(candidate.settings.quoteAsset || '').toUpperCase() === quote) {
        cp.cash = cp.cashByAsset[quote];
        cp._legacyCashMirror = cp.cash;
      }
      delete cp.positions[symbol];
      cp.costs = cp.costs || { fees: 0, slippage: 0 };
      cp.costs.fees += fee;
      cp.costs.slippage += (ref - fill) * position.quantity;
      cp.stats = cp.stats || { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, pctSum: 0 };
      cp.stats.trades++;
      cp.stats.pctSum += pnlPct;
      if (pnl > 0) { cp.stats.wins++; cp.stats.grossWin += pnl; } else cp.stats.grossLoss += -pnl;
      cp.trades = cp.trades || [];
      cp.trades.unshift(trade);
      cp.trades = cp.trades.slice(0, 300);
    });

    const sign = pnl >= 0 ? '+' : '';
    const msg = `SATIM ${symbol} @ ${fill.toFixed(6)} - ${reason} (${sign}${pnl.toFixed(2)} ${quote}, ${sign}${pnlPct.toFixed(2)}%)`;
    this.log(msg);
    this.notify(fmt.paperSell({ symbol, fill, reason, pnl, pnlPct, entryPrice: position.entryPrice, openedAt: position.openedAt, at: this.nowFn() }), { html: true, durable: true });
    return true;
  }

  // Kapatma referans fiyatı. Eskiden son fiyat yoksa GİRİŞ fiyatından, eskimiş fiyat varsa o fiyattan
  // satılıyordu; bu hem muhasebeyi bozar hem de gerçekte alınamayacak bir fiyat uydurur.
  //  - fiyat yoksa / geçersizse: satış yapılmaz
  //  - freshSince verildiyse: fiyat o andan sonra alınmış olmalı (bu turun taze fiyatı)
  //  - allowStale değilse: fiyat maxPriceAgeMs'den eski olamaz
  // freshSince yoksa zaman damgası olmayan (eski sürümden kalma) fiyat kabul edilir; freshSince varsa damgasız fiyat taze sayılmaz.
  _closeRef(symbol, { freshSince, allowStale = false } = {}) {
    const paper = this.state.paper;
    const price = Number((paper.lastPrices || {})[symbol]);
    if (!Number.isFinite(price) || price <= 0) return { error: 'son fiyat yok' };
    const t = Number((paper.lastPriceT || {})[symbol]);
    if (Number.isFinite(Number(freshSince)) && !(Number.isFinite(t) && t >= Number(freshSince))) return { error: 'bu turda taze fiyat alınamadı' };
    if (Number.isFinite(t)) {
      if (!allowStale) {
        const age = Number(this.nowFn()) - t;
        if (age > this.maxPriceAgeMs) return { error: `son fiyat ${Math.round(age / 60000)} dk eski` };
      }
    }
    return { price };
  }

  // Tum pozisyonlari son bilinen TAZE fiyattan (kayma ile) kapatir. Kaydetmez; cagiran kaydeder.
  // Bir pozisyonun kapatilamamasi (fiyat yok / satis reddi / disk hatasi) dongüyü KESMEZ: kalanlar denenir.
  // Kapatilamayanlar this.lastCloseFailures'ta ve pozisyon olarak acik kalir.
  closeAll(reason, opts = {}) {
    let n = 0;
    this.lastCloseFailures = [];
    for (const [symbol, pos] of Object.entries({ ...this.state.paper.positions })) {
      try {
        const ref = this._closeRef(symbol, opts);
        if (ref.error) {
          this.lastCloseFailures.push({ symbol, error: ref.error });
          this.logThrottled(`close:${symbol}`, `${symbol}: pozisyon kapatılamadı (${ref.error}); pozisyon açık kaldı.`, 'error');
          continue;
        }
        if (this.sellAt(symbol, pos, ref.price, reason) === true) n++;
        else this.lastCloseFailures.push({ symbol, error: 'satış reddedildi' });
      } catch (e) {
        this.lastCloseFailures.push({ symbol, error: e.message });
        this.log(`${symbol}: kapatma sırasında hata (${e.message}); kalan pozisyonlar denenmeye devam ediyor.`, 'error');
      }
    }
    return n;
  }

  // Elle kapatma (ornegin parite silinirken). Basarisizsa false doner, nedeni this.lastCloseError'dadir.
  closePosition(symbol, reason, opts = {}) {
    this.lastCloseError = '';
    const pos = this.state.paper.positions[symbol];
    if (!pos) return false;
    const ref = this._closeRef(symbol, opts);
    if (ref.error) {
      this.lastCloseError = ref.error;
      this.logThrottled(`close:${symbol}`, `${symbol}: pozisyon kapatılamadı (${ref.error}); pozisyon açık kaldı.`, 'error');
      return false;
    }
    try {
      const ok = this.sellAt(symbol, pos, ref.price, reason) === true;
      if (!ok) this.lastCloseError = 'satış reddedildi (sayısal sınır)';
      return ok;
    } catch (e) {
      this.lastCloseError = `kayıt/satış hatası: ${e.message}`;
      return false;
    }
  }

  // Kalıcı yazım başarısız olsa bile güvenlik kilidi RAM'de uygulanır (kilit asla "yazılamadı" diye atlanmaz).
  _commitOrApply(mutator, what) {
    try {
      this.commitPaperMutation(mutator);
    } catch (e) {
      mutator(this.state);
      this.log(`${what} diske yazılamadı, bellekte uygulandı (${e.message}).`, 'error');
    }
  }

  _safeStop(reason) {
    try {
      this.stop(reason, { notify: false }); // kill switch / gunluk limit kendi mesajini zaten gonderdi
    } catch (e) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.epoch++;
      this.busy = false;
      this.busyToken = null;
      this.state.running = false;
      this.log(`Bot durduruldu ama durum diske yazılamadı (${e.message}).`, 'error');
    }
  }

  // Veri kesintisinde limit aşıldıysa: yalnızca TAZE fiyatlı pozisyonlar kapatılır. Fiyatı alınamayan
  // pozisyon eski fiyattan satılmaz ve motor DURDURULMAZ (durursa o pozisyonun stop'u hiç izlenmezdi);
  // veri gelince bir sonraki normal turda limit yeniden değerlendirilip işlem yapılır.
  _degradedLimitBreach(kind, reason, freshSince) {
    const n = this.closeAll(`${kind} (veri kesintisi): ${reason}`, { freshSince });
    const remaining = Object.keys(this.state.paper.positions || {}).length;
    if (remaining === 0) return this.checkLossLimits(this.liquidationEquity(), { freshSince });
    const msg = `${kind} limiti aşıldı (${reason}) ama bir pozisyonun piyasa verisi alınamıyor: ${n} pozisyon kapatıldı, ${remaining} pozisyon açık. Veri gelince limit yeniden değerlendirilecek; motor izlemeye devam ediyor.`;
    this.logThrottled('degraded-limit', msg, 'error');
    this.notify(`⚠ ${msg}`, { key: 'degraded-limit', minIntervalMs: 15 * 60000, priority: 'critical' });
    this.entryPauseReason = this.entryPauseReason || 'risk limiti aşıldı, açık pozisyon verisi yok';
    return false;
  }

  // true dondururse bot durduruldu (stop() kaydetti).
  // opts.freshSince: yalnızca bu andan sonra fiyatı alınmış pozisyonlar kapatılır.
  // opts.degraded: açık pozisyon için bu turda veri alınamadı.
  checkLossLimits(equity, opts = {}) {
    const s = this.state.settings;
    const paper = this.state.paper;
    const { freshSince, degraded = false } = opts;

    // 1) Kill switch: baslangic bakiyesine gore TOPLAM zarar.
    const start = Number(paper.startingBalanceByAsset?.[this.quoteLabel] ?? paper.startingBalance);
    const killLimit = Number(s.killSwitchLossPct);
    if (start > 0 && killLimit > 0) {
      const totalPct = (equity / start - 1) * 100;
      if (totalPct <= -killLimit) {
        const reason = `toplam zarar %${Math.abs(totalPct).toFixed(1)} (limit %${killLimit})`;
        if (degraded) return this._degradedLimitBreach('Kill switch', reason, freshSince);
        this._commitOrApply((candidate) => { candidate.killSwitch = { t: iso(this.nowFn()), reason }; candidate.running = false; }, 'Kill switch kilidi');
        const closed = this.closeAll(`Kill switch: toplam zarar ${totalPct.toFixed(1)}%`, { freshSince });
        const remaining = Object.keys(this.state.paper.positions || {}).length;
        const msg = `KILL SWITCH: ${reason}. ${closed} pozisyon kapatıldı, ${remaining} pozisyon açık kaldı. Bot kilitlendi.`;
        this.log(msg, 'error');
        this.notify(`🛑 ${msg}`, { priority: 'critical' });
        this._safeStop('Kill switch.');
        return true;
      }
    }

    // 2) Gunluk zarar limiti.
    const dayStart = Number(paper.dayStartEquityByAsset?.[this.quoteLabel] ?? paper.dayStartEquity);
    const limitPct = Math.abs(Number(s.dailyLossLimitPct));
    if (dayStart > 0 && limitPct > 0) {
      const dayPnlPct = ((equity - dayStart) / dayStart) * 100;
      if (dayPnlPct <= -limitPct) {
        if (degraded) return this._degradedLimitBreach('Günlük zarar', `${dayPnlPct.toFixed(2)}%`, freshSince);
        // Motor durdurulunca stop izleme de durur. Pozisyonları açık bırakmak
        // korumasız risk yaratacağından günlük limitte güvenli varsayılan olarak kapat.
        this._commitOrApply((candidate) => { candidate.running = false; }, 'Günlük limit durumu');
        const n = this.closeAll(`Günlük zarar limiti (${dayPnlPct.toFixed(2)}%)`, { freshSince });
        const remaining = Object.keys(this.state.paper.positions || {}).length;
        const msg = `Günlük zarar limiti aşıldı (${dayPnlPct.toFixed(2)}%). ${n} pozisyon kapatıldı, ${remaining} pozisyon açık kaldı.`;
        this.notify(`⛔ ${msg} Bot durdu.`, { priority: 'critical' });
        this._safeStop(msg);
        return true;
      }
    }
    return false;
  }

  // Yeni giris acilmasini engelleyen risk durumu (kill switch / gunluk zarar). Bos string = engel yok.
  entryRiskGate() {
    if (this.state.killSwitch) return 'kill switch aktif';

    const baselineError = this.riskBaselineError();
    if (baselineError) return `risk tabanı geçersiz; hesabı sıfırla (${baselineError})`;

    const s = this.state.settings;
    const paper = this.state.paper;
    const dayStart = Number(paper.dayStartEquityByAsset?.[this.quoteLabel]);
    const limitPct = Math.abs(Number(s.dailyLossLimitPct));
    if (dayStart > 0 && limitPct > 0) {
      const eq = this.computeEquity();
      if (Number.isFinite(eq) && ((eq - dayStart) / dayStart) * 100 <= -limitPct) return 'günlük zarar limiti aşıldı';
    }
    return '';
  }

  // Veri akisi art arda kesilirse uyar (acik pozisyonun stop'u izlenemez hale gelir).
  trackOutage(attempted, failed, failedWithPosition) {
    if (attempted === 0) return;
    const bad = failed === attempted || failedWithPosition;
    if (bad) {
      this.outageStreak++;
      if (this.outageStreak >= OUTAGE_TICKS && !this.outageAlerted) {
        this.outageAlerted = true;
        const hasPos = Object.keys(this.state.paper.positions).length > 0;
        const msg = `Veri akışı kesildi (${this.outageStreak} tur).` + (hasPos ? ' Açık pozisyonların stop-loss\'u izlenemiyor.' : '');
        this.log(msg, 'error');
        this.notify(`⚠ ${msg}`, { key: 'outage', minIntervalMs: 30 * 60000, priority: 'critical' });
      }
    } else {
      if (this.outageAlerted) {
        this.log('Veri akışı geri geldi.');
        this.notify('✅ Veri akışı geri geldi.', { key: 'outage-ok', minIntervalMs: 60000, priority: 'quiet' });
      }
      this.outageStreak = 0;
      this.outageAlerted = false;
      // NOT: lastTickAt burada SIFIRLANMAZ. Eskiden bu blokta null'lanip "sistem saati geriye gitti"
      // korumasini her saglikli turda siliyordu.
    }
  }
}

module.exports = PaperEngine;
