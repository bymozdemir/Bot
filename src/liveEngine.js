// src/liveEngine.js
// Gercek emir motoru. PaperEngine'den ayri tutulur.
// Varsayilan olarak KAPALI: canli emir icin mode=live + LIVE_TRADING_ENABLED=true gerekir.

const strategies = require('./strategies');
const { roundDownToStep, splitCandles, timeframeMs, validateCandleSeries } = require('./execution');
const tfPolicy = require('./timeframePolicy');
const { isBinanceSpotTestnetOptIn } = require('./util/binanceTestnetGate');
const MIN_STOP_STEP_PCT = 0.25;
const PAIR_OUTAGE_TICKS = 3; // bu kadar tur ust uste islenemeyen parite icin uyari (paper OUTAGE_TICKS ile ayni)
// ACIL CIKIS (koruma kalmadi / risk limiti asildi): normal giris filtreleri (spread %0.75, etki %0.50, derinlik 1.25x)
// alis icin tasarlandi. Cikis bu filtrelere takilirsa, ozellikle stop iptal edilmis ve pozisyon korumasizken, coin
// elde kalir ve borsadaki stop-market zaten (korumasiz) tetiklenir. Bu yuzden acil cikista esikler gevsetilir;
// emrin TUMUNU doldurmaya yetecek derinlik yine zorunludur (marketSafety.estimate bunu garanti eder).
const EMERGENCY_MAX_SPREAD_PCT = 5;
const EMERGENCY_MAX_SLIPPAGE_PCT = 3;
const EMERGENCY_MIN_DEPTH_COVERAGE = 1.0;
const { OrderManager, TERMINAL, thirdFeeValuationIsCurrent } = require('./orderManager');
const { AccountReconciler, managedBaseAssets } = require('./reconciliation');
const { LiveRecovery } = require('./liveRecovery');
const { BinanceUserDataStream } = require('./userDataStream');
const { positionReductionOnSell, realizedPnl, nonPairCommissionAssets, commissionInAsset } = require('./financial');
const { validateMarketOrder } = require('./orderRules');
const { checkMarketOrderSafety } = require('./marketSafety');
const { normalizePortfolioPolicy, canOpenPosition } = require('./portfolioPolicy');
const { normalizeExtras, entryBlock, timeBarrierExit, foragerPlan } = require('./entryExtras');
const fmt = require('./notifyFormat');
const { mapWithConcurrency } = require('./util/concurrency');

const iso = (ms) => new Date(ms).toISOString();
// Pozisyonu koruyan tüm SELL emir rolleri. Hareketli stop (profit-protection-stop) eksikse
// dolumu yok sayılır, satılmış pozisyon açık kalır ve koruma döngüsü ikinci SELL üretirdi.
const PROTECTIVE_ROLES = new Set(['protective-stop', 'protective-stop-recovery', 'protective-tp', 'profit-protection-stop']);

class LiveEngine {
  constructor({ exchange, store, state, onUpdate, notifier, nowFn, orderManager, reconciler, recovery, stream, allowLive = false } = {}) {
    this.exchange = exchange;
    this.store = store;
    this.state = state;
    this.onUpdate = onUpdate || (() => {});
    this.notifier = notifier || null;
    // Varsayilan saat: borsa saatine gore duzeltilmis zaman (varsa). Yerel saat ileri/geri ise mum KAPANISI yanlis
    // algilanir ve strateji henuz kapanmamis mumla karar verip o sinyali tuketirdi.
    this.nowFn = nowFn || (() => (exchange && typeof exchange.nowMs === 'function' ? exchange.nowMs() : Date.now()));
    this.allowLive = allowLive || process.env.LIVE_TRADING_ENABLED === 'true';
    this.orderManager = orderManager || new OrderManager({ exchange, state, store, nowFn, onOrderUpdate: (o) => this._onOrderUpdate(o) });
    this.reconciler = reconciler || new AccountReconciler({ exchange, state, store, nowFn });
    this.recovery = recovery || new LiveRecovery({ orderManager: this.orderManager, reconciler: this.reconciler, state, store, nowFn, repair: async (ctx) => this._repairRecoveredState(ctx) });
    this.stream = stream || null;
    this.timer = null;
    this.busy = false;
    this.epoch = 0;
    this.symbolRulesCache = {};
    this.lastReconcileAt = 0;
    this.reconcileEveryMs = 5 * 60 * 1000;
    this.stopUpdateLocks = new Map();
    this.pairFailStreak = new Map(); // symbol -> { n, alerted, lastError }: ust uste islenemeyen paritelerin sayaci
    // Market data is prefetched with bounded parallelism; order/risk decisions remain serial.
    const requestedConcurrency = Number(process.env.MARKET_DATA_CONCURRENCY || 4);
    this.marketDataConcurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(8, Math.floor(requestedConcurrency))) : 4;
    this._lastMarketDataPauseLogAt = 0;
  }

  _lockSnapshot() {
    const live = this.state.live || {};
    return JSON.stringify([
      live.lockReason || null, this.state.killSwitch || null, this.state.liveReconciliation?.safeToTrade ?? null,
      live.stopRecoveryError || null, live.feeValuationWarning || null, live.criticalAlert || null,
      this.state.liveStreamWarning || null
    ]);
  }

  // Disk yazimi basarisiz olursa (ENOSPC, izin...) olay isleyicilerinde istisna firlatilmaz: firlatilirsa koruyucu dolum
  // isleyicisi hic calismaz veya yakalanmamis promise reddi sureci cokertir. Hata kaydedilir, kapi kilitlenir.
  _safePersist() {
    try { this.persist(); return true; } catch (err) {
      this.lastPersistError = { message: err?.message || String(err), at: iso(this.nowFn()) };
      this.state.live.safeToTrade = false;
      this.state.live.lockReason = 'Durum diske yazılamadı; kalıcılık geri gelene kadar canlı işlem kilitli.';
      return false;
    }
  }

  _onOrderUpdate(order) {
    if (!order || !order.symbol) return;
    const status = String(order.status || '').toUpperCase();
    // Her gerçek dolum bakiyeyi değiştirebilir. Eski 5 dakikalık bakiye
    // görüntüsüyle zarar limitini hesaplayıp yeni girişe devam etme: bir sonraki
    // tick'te REST mutabakatını zorla ve o zamana kadar yeni emirleri kilitle.
    if (status === 'PARTIALLY_FILLED' || status === 'FILLED') {
      this.lastReconcileAt = 0;
      this.state.live.safeToTrade = false;
      this.state.live.lockReason = 'Emir dolumu sonrası bakiye mutabakatı bekleniyor';
      this._safePersist();
    }
    const role = order.meta?.role;
    if (!PROTECTIVE_ROLES.has(role)) return;
    const pos = this.state.live?.positions?.[order.symbol];
    if (!pos || (pos.stopOrderId !== order.clientOrderId && pos.tpOrderId !== order.clientOrderId)) return;

    // Aynı sembol için arka arkaya gelen stop fill olaylarını seri işleriz.
    // Böylece iki PARTIALLY_FILLED mesajı aynı anda eski stopu iptal edip
    // iki yeni koruyucu stop oluşturamaz.
    const previous = this.stopUpdateLocks.get(order.symbol);
    const work = previous ? previous.then(() => this._handleProtectiveStopUpdate(order)) : this._handleProtectiveStopUpdate(order);
    const current = work.catch((err) => {
      this.state.live.safeToTrade = false;
      this.state.live.stopRecoveryError = { symbol: order.symbol, clientOrderId: order.clientOrderId, at: iso(this.nowFn()), error: err?.message || String(err) };
      this._safePersist();
      this.log(`${order.symbol}: koruyucu stop kurtarma başarısız: ${err?.message || String(err)}`, 'error');
    }).finally(() => {
      if (this.stopUpdateLocks.get(order.symbol) === current) this.stopUpdateLocks.delete(order.symbol);
    });
    this.stopUpdateLocks.set(order.symbol, current);
  }

  async _handleProtectiveStopUpdate(order) {
    const status = String(order.status || '').toUpperCase();
    if (status !== 'PARTIALLY_FILLED' && status !== 'FILLED') return;

    const symbol = order.symbol;
    let pos = this.state.live?.positions?.[symbol];
    let isTp = !!pos && pos.tpOrderId === order.clientOrderId;
    if (!pos || (!isTp && pos.stopOrderId !== order.clientOrderId)) return;

    if (this._feeRefreshNeeded(order)) {
      order = await this._withFeeValuation(order);
      // Bekleme sirasinda baska bir cagri (ornegin trailing akisi ile WS) ayni dolumu isleyip sayaclari sifirlamis veya
      // emri pozisyondan ayirmis olabilir: baglanti kontrolu bekleme SONRASINDA yeniden yapilir, yoksa ayni dolum
      // sifirlanmis sayaclarla ikinci kez dusulur (pozisyonun bakiyeden once silinmesi).
      pos = this.state.live?.positions?.[symbol];
      isTp = !!pos && pos.tpOrderId === order.clientOrderId;
      if (!pos || (!isTp && pos.stopOrderId !== order.clientOrderId)) return;
    }
    // Tekrar korumasi kumulatif duruma bagli: ayni son olay kimligiyle ama REST ile BUYUMUS dolum (iptal/mutabakat
    // yaniti) artik yok sayilmaz; yalnizca birebir ayni kumulatif durum tekrar islenmez.
    const executionId = `${order.lastExecutionId || order.exchangeOrderId || order.clientOrderId}|${order.executedQty}|${order.quoteQty}`;
    const seen = new Set(pos.stopExecutionIds || []);
    if (seen.has(executionId)) return;
    seen.add(executionId);

    const cumulativeGross = Math.max(0, Number(order.executedQty || 0));
    const cumulativeBaseFee = Math.max(0, Number(order.commissionBase || 0));
    const cumulativeNetQuote = Math.max(0, Number(order.netQuoteQty ?? order.quoteQty ?? 0));
    const cumulativeThirdFee = this._orderFeeQuoteValue(order);
    if (cumulativeThirdFee === null) {
      this.state.live.safeToTrade = false;
      this.state.live.feeValuationWarning = { symbol, clientOrderId: order.clientOrderId, side: 'sell', at: iso(this.nowFn()), commissionByAsset: { ...(order.commissionByAsset || {}) } };
      this.state.live.unpricedRealizedTrades = (this.state.live.unpricedRealizedTrades || 0) + 1;
      this._safePersist();
      return;
    }

    const prevGross = Math.max(0, Number(pos.stopExecutedQty || 0));
    const prevBaseFee = Math.max(0, Number(pos.stopCommissionBase || 0));
    const prevNetQuote = Math.max(0, Number(pos.stopNetQuoteQty || 0));
    const prevThirdFee = Math.max(0, Number(pos.stopThirdAssetCommissionQuote || 0));
    const grossDelta = Math.max(0, cumulativeGross - prevGross);
    const baseFeeDelta = Math.max(0, cumulativeBaseFee - prevBaseFee);
    const netQuoteDelta = Math.max(0, cumulativeNetQuote - prevNetQuote);
    const thirdFeeDelta = Math.max(0, cumulativeThirdFee - prevThirdFee);
    const outflowQty = Math.min(pos.quantity, positionReductionOnSell(grossDelta, baseFeeDelta));
    const soldQty = Math.min(pos.quantity, grossDelta);

    pos.stopExecutedQty = cumulativeGross;
    pos.stopCommissionBase = cumulativeBaseFee;
    pos.stopNetQuoteQty = cumulativeNetQuote;
    pos.stopThirdAssetCommissionQuote = cumulativeThirdFee;
    pos.stopExecutionIds = [...seen];
    // Emir bazinda islenmis kumulatif miktarlar: pozisyona bagli olmayan emirlerin dolumlari sonradan sahiplenilirse tekrar sayilmaz.
    pos.stopBooked = { ...(pos.stopBooked || {}), [order.clientOrderId]: { gross: cumulativeGross, baseFee: cumulativeBaseFee, netQuote: cumulativeNetQuote, thirdFee: cumulativeThirdFee } };

    if (grossDelta <= 0 && outflowQty <= 0) {
      this._safePersist();
      return;
    }

    const proceeds = Math.max(0, netQuoteDelta - thirdFeeDelta);
    // Emir tamamen dolduysa ve geriye adimdan kucuk bir artik kaldiysa (koruyucu emir miktari
    // adima asagi yuvarlanmisti) pozisyon kapanmis sayilir; artik dust defterine yazilir.
    let dustLeft = 0;
    let pnlOutflow = outflowQty;
    if (status === 'FILLED') {
      const leftover = Math.max(0, pos.quantity - outflowQty);
      if (leftover > 1e-12) {
        let stepRules = null;
        try { stepRules = await this.getRules(symbol); } catch (_) { /* kurallar alinamazsa artik dust sayilmaz */ }
        const step = Number(stepRules?.stepSize || stepRules?.marketStepSize || 0);
        if (step > 0 && leftover < step - 1e-12) { dustLeft = leftover; pnlOutflow = pos.quantity; }
      }
    }
    const pnlResult = realizedPnl(pos, pnlOutflow, proceeds);
    this._recordLiveTrade(symbol, pos, order, soldQty, pnlResult, isTp ? 'take-profit' : 'protective stop');

    const remaining = Math.max(0, pos.quantity - pnlOutflow);
    // Borsa tarafinda tetiklenen koruyucu stop-loss / take-profit en onemli canli olaydir: kullaniciya hemen haber ver.
    // executionId daha once islenmediyse buraya ulasilir; ayni dolum iki kez bildirilmez.
    this.notify(fmt.protectiveFill({
      symbol, isTp, partial: remaining > 1e-12,
      entryPrice: pos.entryPrice,
      exitPrice: soldQty > 0 ? pnlResult.proceeds / soldQty : 0,
      quantity: soldQty, pnl: pnlResult.pnl,
      pnlPct: Number(pnlResult.costBasis) > 0 ? (pnlResult.pnl / Number(pnlResult.costBasis)) * 100 : null,
      stopPrice: pos.stopPrice, openedAt: pos.openedAt, closedAtMs: this.nowFn(), remainingQty: remaining
    }), { key: `live-protective-fill:${symbol}:${executionId}`, minIntervalMs: 60000, priority: 'critical', html: true });
    pos.quantity = remaining;
    pos.costQuote = Math.max(0, Number(pos.costQuote || 0) - pnlResult.costBasis);

    const oppositeId = isTp ? pos.stopOrderId : pos.tpOrderId;

    // Yalnızca gerçekten sıfıra inmiş pozisyon silinebilir. FILLED yanıtı,
    // komisyon/yuvarlama/yanıt tutarsızlığı nedeniyle yerel pozisyon miktarıyla
    // uyuşmuyorsa kalan envanter korunur ve yeni koruyucu stop kurulur.
    if (remaining <= 1e-12) {
      if (oppositeId && oppositeId !== order.clientOrderId) {
        const canceledOpposite = await this.orderManager.cancel(oppositeId);
        if (!canceledOpposite || canceledOpposite.status !== 'CANCELED') {
          this.state.live.safeToTrade = false;
          this.state.live.protectiveCancelPending = { symbol, filledOrderId: order.clientOrderId, oppositeId, at: iso(this.nowFn()) };
          this._safePersist();
          throw new Error(`${symbol}: koruyucu emir gerçekleşti fakat karşı bacak kesin iptal edilemedi; canlı işlem kilitlendi.`);
        }
      }
      if (dustLeft > 0) this._addDust(symbol, dustLeft);
      delete this.state.live.positions[symbol];
      this.log(`${isTp ? 'TAKE-PROFIT' : 'KORUYUCU STOP'} GERÇEKLEŞTİ: ${symbol}`, 'warn');
      this._safePersist();
      return;
    }

    // Kısmi dolum veya FILLED yanıtına rağmen anlamlı kalan miktar: eski SELL
    // bacakları kalan pozisyondan büyük olabilir. Önce açık emirleri kesin iptal
    // et; terminal FILLED emrini iptal etmeye çalışma.
    if (status !== 'FILLED') {
      const canceled = await this.orderManager.cancel(order.clientOrderId);
      if (!canceled || canceled.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this._safePersist();
        throw new Error(`${symbol}: kısmi koruyucu emir sonrası mevcut emir kesin iptal edilemedi.`);
      }
    }
    if (oppositeId && oppositeId !== order.clientOrderId) {
      const opposite = await this.orderManager.cancel(oppositeId);
      if (!opposite || opposite.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this.state.live.protectiveCancelPending = { symbol, filledOrderId: order.clientOrderId, oppositeId, at: iso(this.nowFn()) };
        this._safePersist();
        throw new Error(`${symbol}: koruyucu dolumdan sonra karşı bacak iptal edilemedi; yeni SELL oluşturulmadı.`);
      }
    }

    // Kısmi take-profit sonrası TP'yi yeniden kurmak yerine kalan pozisyonu
    // stop ile koruyoruz. Böylece eski miktarlı TP/SL bacaklarından biri açık
    // kalmaz ve iki bağımsız koruyucu SELL aynı bakiyeyi tüketmeye çalışmaz.
    pos.stopOrderId = null;
    pos.tpOrderId = null;
    pos.tpPrice = null;
    pos.protectiveMode = 'single-stop';
    pos.stopExecutedQty = 0;
    pos.stopCommissionBase = 0;
    pos.stopNetQuoteQty = 0;
    pos.stopThirdAssetCommissionQuote = 0;
    pos.stopExecutionIds = [];

    const rules = await this.getRules(symbol);
    // Bu sembol icin bir SATIS suruyorsa yedek stop KURMA: satis kalan miktari kendi satar (basarisiz olursa kendi
    // yolunda korumayi yeniden kurar). Eszamanli stop, market satisla ayni bakiyeyi kilitler ve satis reddedilir.
    if (this.sellsInProgress?.has(symbol)) {
      this._safePersist();
      this.log(`${symbol}: satış sürüyor; kısmi dolum sonrası yedek stop satış tarafından yönetilecek.`, 'warn');
      return;
    }
    const stopPct = Number(this.state.pairs?.[symbol]?.params?.stopLossPct);
    const entryPrice = Number(pos.entryPrice || 0);
    const configuredStop = entryPrice > 0 && Number.isFinite(stopPct) && stopPct > 0
      ? entryPrice * (1 - stopPct / 100) : Number(pos.stopPrice || 0);
    const stopPrice = this._roundSellStopPrice(configuredStop, rules.tickSize);
    if (!(stopPrice > 0) || !Number.isFinite(stopPrice)) {
      this.state.live.safeToTrade = false;
      this._safePersist();
      throw new Error(`${symbol}: kısmi koruyucu dolum sonrası geçerli stop fiyatı hesaplanamadı.`);
    }
    const replacement = await this.orderManager.submitStop({ symbol, side: 'sell', amount: this._sellQty(remaining, rules), stopPrice, limitPrice: 0, meta: { role: 'protective-stop-recovery', entryClientOrderId: pos.entryOrderId } });
    pos.stopOrderId = replacement.clientOrderId;
    pos.stopPrice = stopPrice;
    if (replacement.status !== 'NEW' && replacement.status !== 'FILLED') {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: kısmi koruyucu emir yeniden kurulamadı (${replacement.status}).`);
    }
    this.state.live.safeToTrade = false;
    if (String(replacement.status).toUpperCase() === 'FILLED') { await this._handleProtectiveStopUpdate(replacement); return; }
    this._safePersist();
  }

  log(msg, level = 'info') {
    this.state.log.unshift({ t: iso(this.nowFn()), msg, level });
    this.state.log = this.state.log.slice(0, 200);
    console.log(`[live:${level}] ${msg}`);
  }

  notify(text, opts) {
    if (this.notifier) this.notifier.send(text, opts).catch(() => {});
  }

  // Acik canli pozisyon sembolleri (bildirim metinleri icin).
  _openSymbols() {
    return Object.keys(this.state.live?.positions || {});
  }

  // Kilit sebebini kullaniciya anlasilir tek satirda ozetler (log'a bakmadan nedenini bilsin).
  _lockReasonText() {
    const live = this.state.live || {};
    const rec = this.state.liveReconciliation || null;
    const cands = [];
    if (this.state.killSwitch?.reason) cands.push(`kill switch: ${this.state.killSwitch.reason}`);
    if (live.lockReason) cands.push(live.lockReason);
    if (live.criticalAlert?.message) cands.push(`${live.criticalAlert.symbol || ''} ${live.criticalAlert.message}`.trim());
    if (live.stopReplacementError) cands.push(`${live.stopReplacementError.symbol || ''}: stop yenileme hatası (${live.stopReplacementError.error})`);
    if (live.stopRecoveryError) cands.push(`stop kurtarma hatası: ${typeof live.stopRecoveryError === 'string' ? live.stopRecoveryError : (live.stopRecoveryError.error || live.stopRecoveryError.message || 'bilinmiyor')}`);
    if (live.feeValuationWarning) cands.push(`${live.feeValuationWarning.symbol || ''}: komisyon değerlemesi yapılamadı`.trim());
    if (live.protectiveCancelPending) cands.push(`${live.protectiveCancelPending.symbol || ''}: koruyucu emrin karşı bacağı iptal edilemedi`.trim());
    if (this.state.liveStreamWarning) cands.push('User Data Stream uyarısı');
    if (rec && rec.safeToTrade === false) {
      if (Array.isArray(rec.errors) && rec.errors.length) cands.push(`mutabakat: ${rec.errors.slice(0, 2).join(' | ')}`);
      else if (rec.unknownLocalOrders?.length) cands.push('mutabakat: yerelde bilinmeyen emir var');
      else if (rec.orphanOpenOrders?.length) cands.push('mutabakat: borsada sahipsiz açık emir var');
    }
    if (live.lastPairError?.error) cands.push(`${live.lastPairError.symbol}: ${live.lastPairError.error}`);
    const text = cands.filter(Boolean)[0];
    return text ? String(text).slice(0, 400) : null;
  }

  persist() {
    this.store.save(this.state);
    this.onUpdate(this.state);
  }

  quoteAsset(symbol) {
    const q = String(symbol || '').toUpperCase().split('/')[1] || '';
    return q || null;
  }

  pairSupported(symbol) {
    const quotes = this.exchange.quoteAssets || [];
    if (!quotes.length) return true;
    const quote = this.quoteAsset(symbol);
    const active = String(this.state.settings.quoteAsset || quotes[0] || '').toUpperCase();
    return quotes.includes(quote) && quote === active;
  }

  ensureState() {
    if (!this.state.live || typeof this.state.live !== 'object') this.state.live = {};
    this.state.live.positions = this.state.live.positions || {};
    this.state.live.lastSignalT = this.state.live.lastSignalT || {};
    this.state.live.lastPrices = this.state.live.lastPrices || {};
    this.state.live.lastReconcileAt = this.state.live.lastReconcileAt || null;
    // Fail-closed: alan eksik/bozuksa kilitli başla; yalnızca start() mutabakattan sonra açar.
    this.state.live.safeToTrade = this.state.live.safeToTrade === true;
    this.state.live.trades = this.state.live.trades || [];
    this.state.live.stats = this.state.live.stats || { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, realizedPnl: 0 };
    this.state.live.realizedPnl = Number.isFinite(Number(this.state.live.realizedPnl)) ? Number(this.state.live.realizedPnl) : 0;
    this.state.live.dayRealizedPnl = Number.isFinite(Number(this.state.live.dayRealizedPnl)) ? Number(this.state.live.dayRealizedPnl) : 0;
    this.state.live.startingEquityByQuote = this.state.live.startingEquityByQuote || {};
    this.state.live.dayStartEquityByQuote = this.state.live.dayStartEquityByQuote || {};
    this.state.live.dayRealizedPnlByQuote = this.state.live.dayRealizedPnlByQuote || {};
  }

  _validateRiskSettings() {
    const s = this.state.settings || {};
    s.portfolioPolicy = normalizePortfolioPolicy(s.portfolioPolicy);
    normalizeExtras(s);
    // Legacy scalar settings remain authoritative for backward-compatible direct state/test edits.
    s.portfolioPolicy.maxPositions = Number.isFinite(Number(s.maxConcurrentPositions)) ? Number(s.maxConcurrentPositions) : s.portfolioPolicy.maxPositions;
    s.portfolioPolicy.reserveCashPct = Number.isFinite(Number(s.reserveCashPct)) ? Number(s.reserveCashPct) : s.portfolioPolicy.reserveCashPct;
    const value = (key, fallback) => s[key] === undefined ? fallback : s[key];
    const maxPos = Number(value('maxConcurrentPositions', 3));
    const maxOpenOrders = Number(value('maxOpenOrders', 12));
    const reserve = Number(value('reserveCashPct', 10));
    const daily = Number(value('dailyLossLimitPct', 5));
    const total = Number(value('killSwitchLossPct', 15));
    const maxTrade = Number(value('maxTradeQuote', 0));
    const maxSpread = Number(value('maxMarketSpreadPct', 0.75));
    const maxSlip = Number(value('maxMarketSlippagePct', 0.50));
    const minDepth = Number(value('minMarketDepthCoverage', 1.25));
    const errors = [];
    if (!Number.isInteger(maxPos) || maxPos < 1) errors.push('maxConcurrentPositions geçersiz');
    if (!Number.isInteger(maxOpenOrders) || maxOpenOrders < 1) errors.push('maxOpenOrders geçersiz');
    if (!Number.isFinite(reserve) || reserve < 0 || reserve > 100) errors.push('reserveCashPct geçersiz');
    if (!Number.isFinite(daily) || daily < 0 || daily > 100) errors.push('dailyLossLimitPct geçersiz');
    if (!Number.isFinite(total) || total < 0 || total > 100) errors.push('killSwitchLossPct geçersiz');
    if (!Number.isFinite(maxTrade) || maxTrade < 0) errors.push('maxTradeQuote geçersiz');
    if (!Number.isFinite(maxSpread) || maxSpread <= 0 || maxSpread > 10) errors.push('maxMarketSpreadPct geçersiz');
    if (!Number.isFinite(maxSlip) || maxSlip <= 0 || maxSlip > 10) errors.push('maxMarketSlippagePct geçersiz');
    if (!Number.isFinite(minDepth) || minDepth < 1) errors.push('minMarketDepthCoverage geçersiz');
    return errors;
  }

  assertStartAllowed() {
    if (this.state.settings.mode !== 'live') throw new Error('Canlı motoru için settings.mode="live" olmalı.');
    const riskErrors = this._validateRiskSettings();
    if (riskErrors.length) throw new Error(`Canlı risk ayarları geçersiz: ${riskErrors.join(', ')}.`);
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 iken canlı mod başlatılamaz: TLS doğrulaması kapalıyken API anahtarı ve emirler ele geçirilebilir. Sertifika sorunu için NODE_EXTRA_CA_CERTS kullanın.');
    }
    if (!this.allowLive) throw new Error('Canlı işlem güvenlik kilidi kapalı. LIVE_TRADING_ENABLED=true olmadan gerçek emir gönderilmez.');
    // Gerçek borsalar için adaptorün REST sözleşmesi ayrıca doğrulanmış olmalı.
    // simulation çevrimdışı sahte borsadır; gerçek emir gönderemez.
    if (this.exchange.id === 'simulation') {
      // izin ver
    } else if (this.exchange.id === 'binance') {
      // Binance.com üretim/testnet kilitleri aşağıda uygulanır.
    } else if (this.exchange.id === 'binancetr') {
      if (process.env.ALLOW_BINANCE_TR_TRADING !== 'true') {
        throw new Error('Binance TR canlı işlem güvenlik kilidi kapalı. Önce ALLOW_BINANCE_TR_TRADING=true ile açıkça etkinleştirilmelidir.');
      }
    } else if (this.exchange.id === 'btcturk') {
      if (process.env.ALLOW_BTCTURK_TRADING !== 'true') {
        throw new Error('BTCTurk canlı işlem güvenlik kilidi kapalı. Önce ALLOW_BTCTURK_TRADING=true ile açıkça etkinleştirilmelidir.');
      }
    } else if (this.exchange.id === 'paribu') {
      if (process.env.ALLOW_PARIBU_TRADING !== 'true') {
        throw new Error('Paribu canlı işlem güvenlik kilidi kapalı. Önce ALLOW_PARIBU_TRADING=true ile açıkça etkinleştirilmelidir.');
      }
    } else {
      throw new Error(`Canlı işlem doğrulanmamış borsa için kapalı: "${this.exchange.id}".`);
    }
    if (process.env.BINANCE_ALLOW_LOCAL_BASE_URL === 'true') {
      throw new Error('BINANCE_ALLOW_LOCAL_BASE_URL yalnızca testler içindir; bu bayrakla canlı mod başlatılamaz.');
    }
    const caps = this.exchange.capabilities || {};
    const testnetOptIn = isBinanceSpotTestnetOptIn(this.exchange);
    if (this.exchange.id === 'binance' && String(this.exchange.environment || 'production') === 'testnet' && !testnetOptIn) {
      throw new Error('Binance Spot Testnet emirleri için BINANCE_ENV=testnet, ALLOW_BINANCE_TESTNET_TRADING=true ve LIVE_TRADING_ENABLED=true birlikte gerekli.');
    }
    if (caps.liveTradingVerified !== true && !testnetOptIn) {
      throw new Error(`${this.exchange.name || this.exchange.id}: liveTradingVerified=false veya eksik; üretim canlı başlatma engellendi (Testnet için ayrı açık izin gerekir).`);
    }
    if (!caps.clientOrderId || caps.recoveryByFingerprint === true || !caps.orderQuery || !caps.balanceQuery || !caps.openOrdersQuery) {
      throw new Error('Bu borsa güvenli canlı işlem için doğrulanmış clientOrderId + deterministik emir sorgulama yetenekleri gerekli.');
    }
    if (this.exchange.id === 'binance' && String(this.exchange.environment || 'production') === 'production' && process.env.ALLOW_PRODUCTION_TRADING !== 'true') {
      throw new Error('Binance üretim ortamı ek güvenlik kilidi nedeniyle kapalı. Önce Testnet doğrulaması tamamlanmalı; üretim için ALLOW_PRODUCTION_TRADING=true açıkça verilmelidir.');
    }
    const knownLiveExchange = ['binance','binancetr','btcturk','paribu'].includes(this.exchange.id);
    if (knownLiveExchange && caps.marketOrderBook !== true && typeof this.exchange.fetchOrderBook !== 'function') {
      throw new Error('Canlı MARKET emirleri için doğrulanmış order-book erişimi zorunlu; bu borsada canlı market emirleri kapalı.');
    }
    if (typeof this.exchange.createStopOrder !== 'function' || typeof this.exchange.cancelOrder !== 'function') {
      throw new Error('Canlı işlem için koruyucu stop emri desteği gerekli.');
    }
    for (const pair of Object.values(this.state.pairs || {})) {
      if (!pair.enabled) continue;
      let params = pair.params || {};
      try { params = { ...strategies.get(pair.strategyId).defaultParams, ...params }; } catch (_) { /* bilinmeyen strateji processPair'de uyarilir */ }
      { const tfErr = tfPolicy.timeframeProblem({ timeframe: pair.timeframe || this.state.settings.defaultTimeframe, strategyId: pair.strategyId, pollSeconds: this.state.settings.pollSeconds, mode: 'live' }); if (tfErr) throw new Error(`${pair.symbol}: ${tfErr} Canlı başlatma engellendi.`); }
      const hasTrailing = Boolean(params.trailingStop);
      if (this.exchange.id !== 'simulation' && hasTrailing && this.exchange.capabilities?.nativeTrailingOco !== true) {
        throw new Error(`${pair.symbol}: trailing stop için borsanın native trailing/OCO sözleşmesi doğrulanmamış; canlı başlatma engellendi.`);
      }
      if (hasTrailing && this.exchange.capabilities?.orderQuery !== true) {
        throw new Error(`${pair.symbol}: trailing stop için güvenli emir sorgulama yeteneği gerekli.`);
      }
    }
    // GERCEK borsada "0 = sinirsiz/kapali" anlamina gelen risk ayarlari ile baslatilmaz: ilk canli
    // denemede tek islem tutari ve zarar kesiciler acikca belirlenmis olmali.
    if (this.exchange.id !== 'simulation') {
      const s = this.state.settings || {};
      const missing = [];
      if (!(Number(s.maxTradeQuote) > 0)) missing.push('maxTradeQuote (işlem başına üst tutar) 0 olamaz');
      if (!(Number(s.killSwitchLossPct) > 0)) missing.push('killSwitchLossPct (toplam zarar limiti) 0 olamaz');
      if (!(Number(s.dailyLossLimitPct) > 0)) missing.push('dailyLossLimitPct (günlük zarar limiti) 0 olamaz');
      if (missing.length) throw new Error(`Gerçek borsada canlı başlatma için risk limitleri zorunlu: ${missing.join('; ')}.`);
    }
  }

  // Ayarlardan kontrol sikligi degisince (server.js) calisan zamanlayici yeni aralikla kurulur.
  reschedule() {
    if (this.timer) this._schedule();
  }

  _schedule() {
    if (this.timer) clearInterval(this.timer);
    const ms = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
    this.timer = setInterval(() => this.safeTick(), ms);
  }

  async _repairRecoveredState({ account } = {}) {
    this.ensureState();
    const positions = this.state.live.positions || (this.state.live.positions = {});
    const openOrders = Array.isArray(account?.openOrders) ? account.openOrders : [];
    let changed = false;
    const adopted = []; // bu cagrida kurtarmayla pozisyona cevrilen girisler (bildirim icin)

    // Binance Spot Testnet hesabı başlangıçta botun yönetmediği coin bakiyeleriyle
    // gelebilir. Yalnızca TESTNET'te, yerel pozisyon/emir tamamen boşken, borsada
    // açık emir yokken ve kill switch kapalıyken bunları bir defalık başlangıç
    // envanteri olarak kaydet. Production'da bu yol hiçbir zaman çalışmaz.
    const isBinanceTestnet = this.exchange?.id === 'binance' && this.exchange?.environment === 'testnet';
    const hasBaseline = this.state.live.balanceBaselineByAsset && typeof this.state.live.balanceBaselineByAsset === 'object';
    const localOrders = Object.values(this.state.liveOrders || {});
    const accountErrors = Array.isArray(account?.errors) ? account.errors : [];
    const onlyBalanceMismatch = accountErrors.every((e) => e === 'Yönetilen varlık bakiyesi yerel pozisyon defteriyle uyuşmuyor.');
    const cleanTestnetInventory = isBinanceTestnet && !hasBaseline && !this.state.killSwitch &&
      Object.keys(positions).length === 0 && localOrders.length === 0 &&
      openOrders.length === 0 && (account?.orphanOpenOrders || []).length === 0 &&
      (account?.unknownLocalOrders || []).length === 0 && onlyBalanceMismatch &&
      account?.balances && typeof account.balances === 'object';
    if (cleanTestnetInventory) {
      const baseline = {};
      for (const symbol of Object.keys(this.state.pairs || {})) {
        const base = String(symbol).toUpperCase().split('/')[0];
        if (!base) continue;
        const total = Number(account.balances?.[base]?.total ?? 0);
        if (!Number.isFinite(total) || total < 0) throw new Error(`Testnet başlangıç bakiyesi doğrulanamadı: ${base}`);
        baseline[base] = total;
      }
      this.state.live.balanceBaselineByAsset = baseline;
      changed = true;
      this.log(`Binance Spot Testnet başlangıç bakiyeleri bir kez kaydedildi (${Object.keys(baseline).length} varlık). Bu bakiyeler bot pozisyonu sayılmaz.`, 'warn');
    }

    // Baseline zaten varken sonradan yeni bir parite eklenirse, o coinin testnet başlangıç bakiyesi baseline'da
    // olmadığı için 'unexpected_asset_balance' ile sonsuza dek kilit çıkardı. Yalnızca testnet'te, yalnızca
    // baseline'da hiç olmayan ve yerelde hiç pozisyon/emir kaydı bulunmayan varlıklar için, başka sorun yokken ekle.
    const baselineObj = this.state.live.balanceBaselineByAsset;
    if (!cleanTestnetInventory && isBinanceTestnet && hasBaseline && !Array.isArray(baselineObj) && !this.state.killSwitch &&
        onlyBalanceMismatch && accountErrors.length > 0 &&
        (account?.orphanOpenOrders || []).length === 0 && (account?.unknownLocalOrders || []).length === 0 &&
        Array.isArray(account?.balanceMismatches)) {
      const baseOf = (sym) => String(sym || '').toUpperCase().split('/')[0];
      const added = [];
      for (const m of account.balanceMismatches) {
        const asset = String(m?.asset || '').toUpperCase();
        if (!asset || m.reason !== 'unexpected_asset_balance') continue;
        if (Object.prototype.hasOwnProperty.call(baselineObj, asset)) continue;
        const hasPosition = Object.values(positions).some((p) => String(p?.baseAsset || baseOf(p?.symbol)).toUpperCase() === asset);
        const hasOrder = localOrders.some((o) => baseOf(o?.symbol) === asset);
        if (hasPosition || hasOrder) continue;
        const total = Number(m.actual);
        if (!Number.isFinite(total) || total < 0) continue;
        baselineObj[asset] = total;
        added.push(asset);
      }
      if (added.length) {
        changed = true;
        this.log(`Binance Spot Testnet başlangıç bakiyesine yeni varlık(lar) eklendi: ${added.join(', ')}. Bu bakiyeler bot pozisyonu sayılmaz.`, 'warn');
      }
    }

    // 1) UNKNOWN/PENDING entry emirleri borsada FILLED olduysa pozisyonu yeniden kur.
    // Aynı clientOrderId için ikinci BUY kesinlikle gönderilmez; mevcut dolum muhasebeye alınır.
    for (let order of Object.values(this.state.liveOrders || {})) {
      const role = order?.meta?.role;
      const status = String(order?.status || '').toUpperCase();
      const adoptable = status === 'FILLED' || status === 'CANCELED' || status === 'EXPIRED'; // EXPIRED: likidite yetersizliginden kismi dolan market alis
      if (role !== 'entry' || !adoptable || !(Number(order.netExecutedQty ?? order.executedQty) > 0)) continue;
      const symbol = String(order.symbol || '').toUpperCase();
      if (!symbol || positions[symbol]) continue;
      const side = String(order.side || '').toLowerCase();
      if (side !== 'buy') continue;
      order = await this._withFeeValuation(order);
      const filledQty = Number(order.netExecutedQty ?? order.executedQty);

      // KRITIK: Bu giris daha once satilip kapatilmis olabilir (yerel pozisyonun olmamasinin NORMAL nedeni).
      // Girise bagli (entryOrderId / entryClientOrderId) SELL emirlerinin dolum miktari dusulur; geriye adim
      // kadar bile coin kalmadiysa pozisyon KAPANMISTIR ve yeniden KURULMAZ. Eskiden tamamlanmis her al-sat
      // sonrasi yeniden baslatmada hayalet pozisyon uretiliyor, stop kurulamayinca canli mod acilamiyordu.
      let soldLinked = 0;
      for (const o of Object.values(this.state.liveOrders || {})) {
        if (!o || String(o.side || '').toLowerCase() !== 'sell') continue;
        const link = o.meta?.entryOrderId || o.meta?.entryClientOrderId;
        if (link !== order.clientOrderId) continue;
        const baseAsset = symbol.split('/')[0];
        const baseFee = commissionInAsset({ byAsset: o.commissionByAsset || {} }, baseAsset);
        soldLinked += positionReductionOnSell(Number(o.executedQty || 0), baseFee);
      }
      const remainingQty = filledQty - soldLinked;
      let stepRules = null;
      try { stepRules = await this.getRules(symbol); } catch (_) { /* kurallar yoksa asagida atlanir */ }
      const stepSize = Number(stepRules?.stepSize || stepRules?.marketStepSize || 0);
      if (!(remainingQty > Math.max(stepSize, 1e-12))) continue; // kapanmis giris
      // Ikinci kanit: hesapta bu coin GERCEKTEN var mi? Yoksa (elle satilmis vb.) pozisyon kurulmaz.
      const baseAsset = symbol.split('/')[0];
      const heldTotal = Number(account?.balances?.[baseAsset]?.total);
      if (!Number.isFinite(heldTotal) || heldTotal + Math.max(1e-10, remainingQty * 1e-6) < remainingQty) {
        this.log(`${symbol}: kayıtlı giriş emri açık görünüyor ama hesapta yeterli ${baseAsset} yok; pozisyon yeniden kurulmadı.`, 'warn');
        continue;
      }
      const thirdFee = this._orderFeeQuoteValue(await this._withFeeValuation(order));
      if (thirdFee === null) throw new Error(`${symbol}: recovery sırasında üçüncü varlık komisyonu değerlenemedi.`);
      const grossQuote = Number(order.netQuoteQty ?? order.quoteQty ?? 0);
      const quoteSpent = grossQuote + thirdFee;
      if (!(filledQty > 0) || !(quoteSpent > 0)) throw new Error(`${symbol}: recovery BUY muhasebesi geçersiz.`);
      const avgPrice = quoteSpent / filledQty;
      const pairCfg = this.state.pairs?.[symbol];
      if (!pairCfg) throw new Error(`${symbol}: recovery BUY için pair yapılandırması bulunamadı.`);
      let params = pairCfg.params || {};
      try { params = { ...strategies.get(pairCfg.strategyId).defaultParams, ...params }; } catch (_) {}
      positions[symbol] = {
        symbol,
        baseAsset: symbol.split('/')[0],
        quoteAsset: symbol.split('/')[1],
        quantity: remainingQty,
        entryPrice: avgPrice,
        costQuote: quoteSpent * (remainingQty / filledQty),
        entryCommissionTotal: Number(order.commissionTotal || 0),
        entryCommissionByAsset: { ...(order.commissionByAsset || {}) },
        entryThirdAssetCommissionQuote: thirdFee,
        entryThirdAssetCommissionValuation: order.thirdAssetCommissionValuation || {},
        openedAt: order.createdAt || iso(this.nowFn()),
        entryOrderId: order.clientOrderId,
        stopOrderId: null,
        stopPrice: null,
        tpOrderId: null,
        tpPrice: null,
        protectiveMode: 'single-stop',
        nativeTrailing: false,
        orderListId: null,
        takeProfitPct: Number(params.takeProfitPct || 0),
        trailingStop: Boolean(params.trailingStop),
        highWaterMark: avgPrice,
        reason: order.meta?.reason || 'recovered-entry',
        stopExecutedQty: 0,
        stopCommissionBase: 0,
        stopNetQuoteQty: 0,
        stopThirdAssetCommissionQuote: 0,
        stopExecutionIds: []
      };
      adopted.push(symbol);
      changed = true;
    }

    // 2) Borsada açık ama local state'e bağlanmamış protective SELL varsa, yalnızca
    // miktarı pozisyonla birebir eşleşen ve tek anlamlı aday varsa sahiplen.
    for (const [symbol, pos] of Object.entries(positions)) {
      const known = new Set([pos.stopOrderId, pos.tpOrderId].filter(Boolean).map(String));
      const candidates = openOrders.filter((o) =>
        String(o.symbol || '').toUpperCase() === symbol &&
        String(o.side || '').toLowerCase() === 'sell' &&
        ['NEW','PARTIALLY_FILLED'].includes(String(o.status || '').toUpperCase()) &&
        o.clientOrderId && !known.has(String(o.clientOrderId))
      );
      const expectedQty = Number(pos.quantity || 0);
      const qtyCandidates = candidates.filter((o) => {
        const q = Number(o.origQty ?? o.amount ?? 0);
        return q > 0 && q <= expectedQty + Math.max(1e-10, expectedQty * 1e-8) && (expectedQty - q) <= Math.max(1e-6, expectedQty * 1e-6);
      });
      if (pos.protectiveMode === 'oco') {
        // OCO iki leg olmalı. Tek leg bulunursa mevcut korumanın tamamlandığı kanıtlanmış değildir.
        if (qtyCandidates.length === 2) {
          const sorted = [...qtyCandidates].sort((a,b) => Number(a.stopPrice || 0) - Number(b.stopPrice || 0));
          const stop = sorted[0], tp = sorted[1];
          this.orderManager._record(stop.clientOrderId, { ...stop, exchangeOrderId: stop.exchangeOrderId ?? stop.orderId ?? null, type:'STOP_LOSS', meta:{ ...(stop.meta||{}), role:'protective-stop-recovery', entryClientOrderId:pos.entryOrderId, recovered:true } });
          this.orderManager._record(tp.clientOrderId, { ...tp, exchangeOrderId: tp.exchangeOrderId ?? tp.orderId ?? null, type:'TAKE_PROFIT', meta:{ ...(tp.meta||{}), role:'protective-tp', entryClientOrderId:pos.entryOrderId, recovered:true } });
          pos.stopOrderId = stop.clientOrderId; pos.tpOrderId = tp.clientOrderId;
          pos.stopPrice = Number(stop.stopPrice || pos.stopPrice || 0) || pos.stopPrice;
          pos.tpPrice = Number(tp.stopPrice || tp.price || 0) || pos.tpPrice;
          pos.orderListId = stop.orderListId ?? tp.orderListId ?? null;
          changed = true;
        } else if (qtyCandidates.length === 1) {
          throw new Error(`${symbol}: OCO recovery sırasında yalnızca tek koruyucu leg bulundu; ikinci leg doğrulanmadan yeni SELL gönderilmeyecek.`);
        }
      } else if (!pos.stopOrderId) {
        if (qtyCandidates.length === 1) {
          const stop = qtyCandidates[0];
          this.orderManager._record(stop.clientOrderId, { ...stop, exchangeOrderId: stop.exchangeOrderId ?? stop.orderId ?? null, type:'STOP_LOSS', meta:{ ...(stop.meta||{}), role:'protective-stop-recovery', entryClientOrderId:pos.entryOrderId, recovered:true } });
          pos.stopOrderId = stop.clientOrderId;
          pos.stopPrice = Number(stop.stopPrice || pos.stopPrice || 0) || pos.stopPrice;
          pos.protectiveMode = 'single-stop';
          changed = true;
        } else if (qtyCandidates.length > 1) {
          throw new Error(`${symbol}: birden fazla eşleşen koruyucu SELL bulundu; duplicate koruma riski nedeniyle işlem kilitlendi.`);
        }
      }
    }

    // 3) Recovered position protection yoksa yeni koruma kur; ama yalnızca exchange'te
    // eşleşen orphan koruma bulunmadığı kesinleştikten sonra.
    for (const [symbol, pos] of Object.entries(positions)) {
      const pairCfg = this.state.pairs?.[symbol];
      if (!pairCfg) throw new Error(`${symbol}: recovery position yapılandırması bulunamadı.`);
      let params = pairCfg.params || {};
      try { params = { ...strategies.get(pairCfg.strategyId).defaultParams, ...params }; } catch (_) {}
      const rules = await this.getRules(symbol);
      const refPrice = Number(pos.entryPrice || 0);
      if (!(refPrice > 0)) throw new Error(`${symbol}: recovery pozisyon fiyatı geçersiz.`);
      const stopPct = Number(params.stopLossPct);
      if (!(stopPct > 0 && stopPct < 100)) throw new Error(`${symbol}: recovery stopLossPct geçersiz.`);
      if (!pos.stopOrderId) {
        const stopPrice = this._roundSellStopPrice(refPrice * (1 - stopPct/100), rules.tickSize);
        const qty = this._sellQty(pos.quantity, rules);
        if (!(qty > 0)) throw new Error(`${symbol}: recovery stop miktarı geçersiz.`);
        const stop = await this.orderManager.submitStop({ symbol, side:'sell', amount:qty, stopPrice, limitPrice:0, meta:{role:'protective-stop-recovery', entryClientOrderId:pos.entryOrderId, recovered:true} });
        if (!['NEW','FILLED'].includes(String(stop.status).toUpperCase())) throw new Error(`${symbol}: recovery stop kurulamadı (${stop.status}).`);
        pos.stopOrderId = stop.clientOrderId; pos.stopPrice = stopPrice; pos.protectiveMode='single-stop'; pos.tpOrderId=null; pos.tpPrice=null; pos.orderListId=null;
        changed = true;
      }
    }
    if (changed) this._safePersist();
    // Kurtarmayla kurulan pozisyon (gec dolan giris / yeniden baslatma sonrasi) eskiden hic bildirilmiyordu.
    // Koruyucu stop kurulduktan SONRA tek mesaj gider; anahtar normal alimla ayni oldugundan ayni giris iki kez bildirilmez.
    for (const symbol of adopted) {
      const pos = positions[symbol];
      if (!pos) continue;
      this.notify(fmt.liveBuy({
        symbol, avgPrice: pos.entryPrice, quantity: pos.quantity, quoteSpent: pos.costQuote,
        stopPrice: pos.stopOrderId ? pos.stopPrice : null, stopFailed: !pos.stopOrderId, recovered: true,
        takeProfitPct: pos.takeProfitPct, trailing: pos.trailingStop, reason: pos.reason, at: this.nowFn()
      }), { key: `live-buy:${symbol}:${pos.entryOrderId || pos.entryPrice}`, minIntervalMs: 60000, html: true, durable: true });
    }
    return { changed };
  }

  // Çalışma sırasında (yeniden başlatma olmadan) dolan 'entry' emirlerini pozisyona çevirir ve koruyucu stop kurar.
  // Aday: role='entry', FILLED (veya kısmi dolumdan sonra CANCELED), yerel pozisyonu olmayan, daha önce değerlendirilmemiş emir.
  // Kanıt kuralları _repairRecoveredState ile aynıdır (girişe bağlı satışlar düşülür, hesapta coin gerçekten var mı bakılır).
  _entryAdoptionCandidates() {
    const positions = this.state.live?.positions || {};
    return Object.values(this.state.liveOrders || {}).filter((o) => {
      if (!o || o.meta?.role !== 'entry' || o.entryAdoptionChecked) return false;
      const status = String(o.status || '').toUpperCase();
      if (status !== 'FILLED' && status !== 'CANCELED' && status !== 'EXPIRED') return false;
      if (String(o.side || '').toLowerCase() !== 'buy') return false;
      if (!(Number(o.netExecutedQty ?? o.executedQty) > 0)) return false;
      return !positions[String(o.symbol || '').toUpperCase()];
    });
  }

  async _adoptFilledEntries() {
    const candidates = this._entryAdoptionCandidates();
    if (!candidates.length) return false;
    try {
      let account = await this.reconciler.reconcile();
      const repair = await this._repairRecoveredState({ account });
      for (const c of candidates) this.orderManager._record(c.clientOrderId, { entryAdoptionChecked: true, entryAdoptionAt: iso(this.nowFn()) }, { tolerateSaveError: true });
      if (repair?.changed) {
        account = await this.reconciler.reconcile();
        this.lastReconcileAt = this.nowFn();
        this.state.live.lastReconcileAt = iso(this.lastReconcileAt);
        this.state.live.lastBalance = account.balances || null;
        this.state.live.safeToTrade = account.safeToTrade === true;
        if (this.state.live.safeToTrade) this.state.live.lockReason = null;
        this.log(`Geç dolan giriş emri pozisyona çevrildi ve koruyucu stop kuruldu (${candidates.map((c) => c.symbol).join(', ')}).`, 'warn');
        this._safePersist();
      }
      return repair?.changed === true;
    } catch (err) {
      this.state.live.safeToTrade = false;
      this.state.live.lockReason = `Geç dolan giriş emri pozisyona çevrilemedi: ${err?.message || String(err)}`;
      this.state.live.stopRecoveryError = { symbol: candidates[0]?.symbol || null, at: iso(this.nowFn()), error: err?.message || String(err) };
      this.log(`Geç dolan giriş emri işlenemedi: ${err?.message || String(err)}`, 'error');
      this._safePersist();
      return false;
    }
  }

  // Başlangıç mutabakatı güvenli çıkmadığında kullanıcıya gösterilecek ilk gerçek neden (tek satır).
  _startFailureReason(recovery) {
    const parts = [];
    if (Array.isArray(recovery?.errors)) parts.push(...recovery.errors);
    const acc = recovery?.account || this.state.liveReconciliation || null;
    if (acc) {
      if (Array.isArray(acc.errors)) parts.push(...acc.errors);
      for (const m of acc.balanceMismatches || []) {
        parts.push(`${m.asset}: ${m.reason} (beklenen ${m.expected}, borsada ${m.actual})`);
      }
      if (acc.unknownLocalOrders?.length) parts.push('yerelde bilinmeyen emir var');
      if (acc.orphanOpenOrders?.length) parts.push('borsada sahipsiz açık emir var');
    }
    const text = [...new Set(parts.filter(Boolean).map(String))].join(' | ');
    return text ? text.slice(0, 400) : '';
  }

  async start() {
    if (this.timer) return;
    this.assertStartAllowed();
    if (this.state.killSwitch) throw new Error(`Kill switch devrede: ${this.state.killSwitch.reason}`);

    this.ensureState();
    await this._assertApiKeySafe();
    const recovery = await this.recovery.recover();
    if (!recovery.safeToTrade) {
      this.state.live.safeToTrade = false;
      // Genel cümle nedeni gizliyordu; ilk gerçek nedeni hem hata metnine hem kilit nedenine yaz.
      const reason = this._startFailureReason(recovery);
      if (reason) this.state.live.lockReason = `Başlangıç mutabakatı: ${reason}`;
      this._safePersist();
      throw new Error(`Canlı başlangıç güvenli değil: emir/bakiye mutabakatı tamamlanamadı.${reason ? ` Neden: ${reason}` : ''}`);
    }

    if (this.stream) {
      try {
        await this.stream.start();
      } catch (err) {
        this.state.live.safeToTrade = false;
        // Akış yarım kalmasın: sonraki 'başlat' gerçekten yeniden bağlansın.
        try { await this.stream.stop(); } catch (_) { /* yoksay */ }
        this._safePersist();
        const raw = err?.message || String(err);
        const hint = /-2015|Invalid API-key|permissions for action/i.test(raw)
          ? ' Kontrol et: anahtarlar doğru ortamdan mı (testnet anahtarı için BINANCE_ENV=testnet), anahtarda okuma/Spot yetkisi var mı, IP kısıtı var mı, kasada eski anahtar mı kayıtlı?'
          : '';
        throw new Error(`User Data Stream başlatılamadı: ${raw}${hint}`);
      }
    }

    this.state.running = true;
    this.state.live.safeToTrade = true;
    this._wasSafe = true; // ilk turda gelen kilit de bildirilsin (eskiden ilk tur kilidi sessiz geciyordu)
    this._lockedSince = null;
    this.pairFailStreak.clear();
    this.log('Canlı motor başlatıldı.');
    this.notify('▶ Canlı işlem motoru başlatıldı.', { key: 'live-start', minIntervalMs: 60000, priority: 'quiet' });
    this._safePersist();
    this._schedule();
    this.safeTick();
  }

  // Para çekme yetkisi doğrulanamıyorsa gerçek borsada canlı başlangıç fail-closed olur.
  async _assertApiKeySafe() {
    this.state.live.apiRestrictionsChecked = false;
    this.state.live.apiRestrictionsUnverified = null;
    // Simülasyon gerçek hesap anahtarı kullanmaz. Binance testnet de üretim
    // hesabındaki çekim yetkisini sorgulayamaz; üretime geçişte yeniden doğrulanır.
    if (this.exchange.id === 'simulation') return;
    if (this.exchange.id === 'binance' && String(this.exchange.environment || 'production') !== 'production') return;
    if (typeof this.exchange.fetchApiRestrictions !== 'function') {
      this.state.live.apiRestrictionsUnverified = 'Bu adaptör API anahtarı izinlerini sorgulamayı desteklemiyor.';
      throw new Error('Canlı başlangıç engellendi: API anahtarının para çekme yetkisinin kapalı olduğu programatik olarak doğrulanamıyor.');
    }
    let info;
    try {
      info = await this.exchange.fetchApiRestrictions();
    } catch (err) {
      this.state.live.apiRestrictionsUnverified = err?.message || String(err);
      this._safePersist();
      throw new Error(`Canlı başlangıç engellendi: API anahtarı izinleri doğrulanamadı (${this.state.live.apiRestrictionsUnverified}).`);
    }
    if (!info || typeof info.enableWithdrawals !== 'boolean') {
      this.state.live.apiRestrictionsUnverified = 'Borsa yanıtında enableWithdrawals alanı yok veya geçersiz.';
      this._safePersist();
      throw new Error('Canlı başlangıç engellendi: para çekme izni yanıtı kesin değil.');
    }
    if (info.enableWithdrawals === true) {
      throw new Error('API anahtarında PARA ÇEKME yetkisi açık. Güvenlik için canlı mod başlatılmadı; anahtarı yalnızca okuma + spot işlem yetkisiyle yeniden oluştur.');
    }
    this.state.live.apiRestrictionsUnverified = null;
    this.state.live.apiRestrictionsChecked = true;
    this._safePersist();
  }

  // opts.notify=false: durdurma zaten ayri bir bildirimle duyurulduysa (kill switch, Telegram /bitir) tekrar mesaj atma.
  async stop(reason = 'Kullanıcı durdurdu.', { notify = true } = {}) {
    const wasRunning = this.state.running === true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.epoch++;
    this.state.running = false;
    if (this.stream) await this.stream.stop().catch(() => {});
    this.log('Canlı bot durduruldu: ' + reason);
    this._safePersist();
    if (notify && wasRunning) {
      this.notify(fmt.engineStopped({ mode: 'live', reason, openPositions: this._openSymbols(), at: this.nowFn() }), { key: 'live-stopped', minIntervalMs: 30000, priority: 'critical', durable: true, html: true });
    }
  }

  safeTick() {
    return this.tick().catch((e) => {
      this.log('Canlı tick hatası: ' + e.message, 'error');
      // Ornegin "koruyucu stop reddedildi" gibi durumlarda gercek pozisyon korumasiz kalabilir: sesli bildir.
      this.notify(`🚨 Canlı tick hatası: ${e.message}`, { key: 'live-tick-error', minIntervalMs: 5 * 60000, priority: 'critical' });
    });
  }

  async _reconcileIfDue() {
    const now = this.nowFn();
    if (now - this.lastReconcileAt < this.reconcileEveryMs) return this.state.live?.safeToTrade === true;
    // WebSocket kopmasi sirasinda dolan emirler (ozellikle koruyucu stop) REST ile yakalanir;
    // aksi halde bakiye uyusmazligi canli islemi kalici kilitlerdi.
    if (typeof this.orderManager?.refreshPending === 'function') {
      try {
        const rp = await this.orderManager.refreshPending();
        if (rp.failed > 0) this.log(`${rp.failed} bekleyen emrin durumu şimdilik tazelenemedi (geçici ağ hatası olabilir); kayıtlar korunuyor.`, 'warn');
        await Promise.all([...this.stopUpdateLocks.values()]);
      } catch (err) {
        this.log(`Emir durumu REST ile güncellenemedi: ${err?.message || String(err)}`, 'warn');
      }
    }
    const r = await this.reconciler.reconcile();
    this.lastReconcileAt = now;
    this.state.live.lastReconcileAt = iso(now);
    this.state.live.lastBalance = r.balances || null;
    this.state.live.safeToTrade = r.safeToTrade === true;
    // Mutabakat temiz ve her pozisyonun korumasi dogrulandiysa eski kilit nedenleri/uyarilari temizlenir;
    // aksi halde panel cozulmus bir sorunu sonsuza dek "KILIT NEDENI" diye gostermeye devam ederdi.
    if (this.state.live.safeToTrade) {
      this.state.live.lockReason = null;
      this.state.live.stopReplacementError = null;
      this.state.live.stopRecoveryError = null;
      this.state.live.criticalAlert = null;
    }
    this._safePersist();
    return this.state.live.safeToTrade;
  }

  // Paritenin verisi/islemi ust uste PAIR_OUTAGE_TICKS tur alinamazsa tek bir kritik uyari gider (paper'daki
  // "veri akisi kesildi" uyarisinin canli karsiligi); parite duzelince "yeniden calisiyor" bilgisi gider.
  // Eskiden bu hata yalnizca loga yaziliyordu: borsadaki stop yerinde kalsa da strateji cikisi/trailing sessizce durabiliyordu.
  _trackPairResult(symbol, err) {
    let st = this.pairFailStreak.get(symbol);
    if (!err) {
      if (!st) return;
      this.pairFailStreak.delete(symbol);
      if (st.alerted) this.notify(`✅ ${symbol}: parite işleme yeniden çalışıyor.`, { key: `live-pair-ok:${symbol}`, minIntervalMs: 60000, priority: 'quiet' });
      return;
    }
    if (!st) { st = { n: 0, alerted: false, lastError: '' }; this.pairFailStreak.set(symbol, st); }
    st.n += 1;
    st.lastError = String(err?.message || err).slice(0, 160);
    if (st.n < PAIR_OUTAGE_TICKS || st.alerted) return;
    st.alerted = true;
    const pos = this.state.live?.positions?.[symbol];
    const tail = pos
      ? (pos.stopOrderId
        ? ' Açık pozisyon için borsadaki koruyucu stop yerinde; ancak strateji çıkışı ve trailing bu pariteyi değerlendiremiyor.'
        : ' Açık pozisyonun strateji çıkışı bu pariteyi değerlendiremiyor ve kayıtlı koruyucu stop YOK; borsayı/paneli kontrol edin.')
      : ' Bu parite için yeni alım/çıkış kararı verilmiyor.';
    this.notify(`⚠ ${symbol}: ${st.n} tur üst üste işlenemedi (${st.lastError}).${tail}`, { key: `live-pair-outage:${symbol}`, minIntervalMs: 10 * 60000, priority: 'critical' });
  }

  async tick() {
    if (!this.state.running || this.busy) return;
    this.busy = true;
    const epoch = this.epoch;
    let tickFailed = false;
    try {
      this.ensureState();
      // Önceki reconciliation başarısız olduysa burada kalıcı kilitlenme
      // yaşanmamalı. _reconcileIfDue kendi periyodunu uygular ve zamanı
      // geldiğinde yeniden bakiye/açık emir/koruyucu emir mutabakatı yapar.
      // Eski başarısız sonucu sadece güvenli durum bilgisi olarak kullanmak,
      // yeni reconciliation çağrısını hiç çalıştırmayan bir deadlock yaratır.
      await this._reconcileIfDue();
      // Dolmuş ama yerelde pozisyonu olmayan giriş emirleri (ör. NEW dönüp sonradan dolan market alış) önce
      // pozisyona çevrilir; böylece aşağıdaki koruma adımı ve stop kurulumu onları da kapsar.
      await this._adoptFilledEntries();
      // Belirsiz kalıp sonradan dolan çıkış emirleri, koruma adımından ÖNCE işlenmeli (aksi halde satılmış miktar için stop denenir).
      await this._adoptFilledExits();
      // Güvenlik kilidi yeni girişleri durdurur; mevcut pozisyonların korumasını
      // durdurmamalıdır. Stop eksikse burada REST üzerinden yeniden kurmayı deneriz.
      await this._ensurePositionProtection();
      if (this.stream && this.state.liveStream && this.state.liveStream.connected !== true) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = 'User Data Stream bağlı değil';
        this._safePersist();
        return;
      }
      // Yeni sinyalleri değerlendirmeden ÖNCE risk kapısını çalıştır.
      // Böylece günlük/toplam zarar limiti zaten aşılmışsa aynı tick içinde
      // yeni bir alış emri açılmaz.
      await this._checkRiskGate();
      if (!this.state.running || !this.state.live.safeToTrade) return;
      const pairEntries = Object.entries(this.state.pairs);
      const eligibleEntries = pairEntries.filter(([symbol, pairCfg]) =>
        (pairCfg.enabled || !!this.state.live.positions[symbol]) &&
        (this.pairSupported(symbol) || !!this.state.live.positions[symbol]));
      const snapshots = new Map();
      // Fetch candles + ticker before strategy/order processing. Bounded parallelism
      // prevents one slow symbol from serially delaying every later symbol, while all
      // state-changing decisions and order submissions remain sequential below.
      await mapWithConcurrency(eligibleEntries, this.marketDataConcurrency, async ([symbol, pairCfg]) => {
        try {
          const strategy = strategies.get(pairCfg.strategyId);
          const params = { ...strategy.defaultParams, ...(pairCfg.params || {}) };
          const paramError = strategies.validateParams(strategy.id, params);
          if (paramError) throw new Error(`geçersiz strateji parametreleri: ${paramError}`);
          const timeframe = pairCfg.timeframe || this.state.settings.defaultTimeframe;
          const limit = Math.min(1000, strategies.candleLimit(strategy, params) + 1);
          const [candlesResult, tickerResult] = await Promise.allSettled([
            this.exchange.fetchCandles(symbol, timeframe, limit),
            this.exchange.fetchTicker(symbol)
          ]);
          // Keep the worker slot until both requests settle; otherwise a fast
          // candle failure could leave ticker requests running outside the bound.
          if (candlesResult.status === 'rejected') throw candlesResult.reason;
          if (tickerResult.status === 'rejected') throw tickerResult.reason;
          const candles = candlesResult.value;
          const ticker = tickerResult.value;
          if (!Array.isArray(candles) || candles.length === 0) throw new Error('boş veya geçersiz mum verisi');
          validateCandleSeries(candles, timeframe);
          const latestCandle = candles[candles.length - 1];
          const timeframeDuration = timeframeMs(timeframe);
          const pollMs = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
          const maxDataAgeMs = Math.max(2 * (timeframeDuration || 0), 5 * pollMs, 5 * 60 * 1000);
          const futureToleranceMs = Math.max(5 * 60 * 1000, 2 * pollMs);
          const ageMs = Number(this.nowFn()) - Number(latestCandle.t);
          if (ageMs > maxDataAgeMs) throw new Error(`piyasa verisi eski (${Math.round(ageMs / 60000)} dk; sınır ${Math.round(maxDataAgeMs / 60000)} dk)`);
          if (ageMs < -futureToleranceMs) throw new Error('piyasa verisinin zaman damgası sistem zamanından ileride');
          if (!Number.isFinite(Number(ticker?.price)) || Number(ticker.price) <= 0) throw new Error('geçersiz ticker fiyatı');
          snapshots.set(symbol, { candles, ticker });
        } catch (error) {
          snapshots.set(symbol, { error });
        }
      });
      if (epoch !== this.epoch) return;
      const positionDataFailure = eligibleEntries.some(([symbol]) =>
        !!this.state.live.positions[symbol] && !!snapshots.get(symbol)?.error);
      const allowNewEntries = !positionDataFailure;
      if (positionDataFailure) {
        const pauseNow = Number(this.nowFn());
        if (!this._lastMarketDataPauseLogAt || pauseNow - this._lastMarketDataPauseLogAt >= 5 * 60 * 1000) {
          this.log('Açık pozisyonlardan en az biri için piyasa verisi alınamadı; bu tur yeni alımlar durduruldu. Mevcut pozisyonların çıkış ve koruma yönetimi devam edecek.', 'warn');
          this._lastMarketDataPauseLogAt = pauseNow;
        }
      }
      // Forager (opsiyonel): yeni alim adaylarini skora gore sirala; acik pozisyonlar her zaman once islenir.
      let orderedEntries = pairEntries;
      try {
        const live = this.state.live;
        const cands = pairEntries.filter(([sym]) => !live.positions[sym] && snapshots.get(sym) && !snapshots.get(sym).error)
          .map(([sym]) => ({ symbol: sym, candles: snapshots.get(sym).candles }));
        const plan = foragerPlan(this.state.settings, cands);
        this.foragerPruned = plan.pruned;
        if (this.state.settings.forager && this.state.settings.forager.enabled) {
          const rank = new Map(plan.order.map((sym, i) => [sym, i]));
          const key = (sym) => (live.positions[sym] ? -2 : (rank.has(sym) ? rank.get(sym) : Number.MAX_SAFE_INTEGER));
          orderedEntries = [...pairEntries].sort((a, b) => key(a[0]) - key(b[0]));
        }
      } catch (e) { this.foragerPruned = new Set(); this.log(`forager sıralaması atlandı: ${e.message}`, 'warn'); }
      for (const [symbol, pairCfg] of orderedEntries) {
        if (this.state.live.safeToTrade !== true) break;
        if (!pairCfg.enabled && !this.state.live.positions[symbol]) { this.pairFailStreak.delete(symbol); continue; }
        if (!this.pairSupported(symbol) && !this.state.live.positions[symbol]) { this.pairFailStreak.delete(symbol); continue; }
        try {
          await this.processPair(symbol, pairCfg, epoch, snapshots.get(symbol), allowNewEntries);
          if (this.state.live.lastPairError?.symbol === symbol) this.state.live.lastPairError = null;
          if (epoch === this.epoch) this._trackPairResult(symbol, null);
        } catch (err) {
          if (epoch !== this.epoch) return;
          // Tek bir bozuk/delist edilmiş parite diğer paritelerin satış ve stop
          // işlemlerini durduramaz. Pozisyon varsa koruma kilitli kalır ama loop devam eder.
          this.log(`${symbol}: parite tick hatası: ${err?.message || String(err)}`, 'error');
          this.state.live.lastPairError = { symbol, at: iso(this.nowFn()), error: err?.message || String(err) };
          this._safePersist();
          if (epoch === this.epoch) this._trackPairResult(symbol, err);
        }
        if (epoch !== this.epoch) return;
      }
      await this._checkRiskGate();
    } catch (err) {
      tickFailed = true;
      throw err;
    } finally {
      this.busy = false;
      // Nabiz (dead-man's switch): paper motoru gibi canli motor da her BASARILI turda ping atar.
      // Kilitli olsa bile surec yasiyorsa ping gider; surec/ag giderse ping kesilir ve servis haber verir.
      if (!tickFailed) this.lastTickAt = this.nowFn(); // "bot yasiyor" bilgisi (gunluk ozet / durum komutlari)
      if (!tickFailed && this.notifier && typeof this.notifier.ping === 'function') this.notifier.ping().catch(() => {});
      // Guvenli durumdan kilitli duruma gecis: yeni emirler durur, kullaniciya haber ver.
      const safeNow = this.state.live && this.state.live.safeToTrade === true;
      if (this._wasSafe === true && !safeNow) {
        this._lockedSince = this.nowFn();
        // Kill switch zaten kendi (sebepli) mesajini gonderdi; ayni olay icin ikinci "kilitlendi" mesaji atma.
        if (!this.state.killSwitch) {
          const lockReason = this._lockReasonText();
          this.notify(fmt.lockMessage({ reason: lockReason, symbols: this._openSymbols(), at: this.nowFn() }),
            { key: `live-locked:${lockReason || 'bilinmiyor'}`, minIntervalMs: 10 * 60000, priority: 'critical', html: true });
        }
      } else if (this._wasSafe === false && safeNow) {
        const since = Number(this._lockedSince);
        this._lockedSince = null;
        this.notify(fmt.unlockMessage({ lockedForMs: Number.isFinite(since) ? this.nowFn() - since : null, at: this.nowFn() }),
          { key: 'live-unlocked', minIntervalMs: 60000, priority: 'normal', html: true });
      }
      this._wasSafe = safeNow;
    }
  }

  // Belirsiz (UNKNOWN) kalip sonradan FILLED/kismi dolan CIKIS emirleri: sell() hata firlatip kilitlenmisti ve dolum
  // hicbir yerde pozisyona islenmemisti (hayalet pozisyon, kalici kilit). Giris emirlerindeki _adoptFilledEntries
  // gibi, bu dolumlar da (entryOrderId eslesmesiyle ve yalnizca bir kez) pozisyona/deftere islenir.
  async _adoptFilledExits() {
    const positions = this.state.live?.positions || {};
    const candidates = Object.values(this.state.liveOrders || {}).filter((o) => {
      if (!o || o.meta?.role !== 'exit' || o.exitBooked) return false;
      if (String(o.side || '').toLowerCase() !== 'sell') return false;
      if (!(Number(o.executedQty) > 0)) return false;
      const status = String(o.status || '').toUpperCase();
      if (status !== 'FILLED' && status !== 'CANCELED' && status !== 'EXPIRED') return false;
      const pos = positions[String(o.symbol || '').toUpperCase()] || positions[o.symbol];
      return !!pos && !!o.meta?.entryOrderId && pos.entryOrderId === o.meta.entryOrderId;
    });
    let changed = false;
    for (const order of candidates) {
      const symbol = order.symbol;
      const position = this.state.live.positions[symbol];
      if (!position) continue;
      try {
        const sellRules = await this.getRules(symbol);
        const verified = await this._withFeeValuation(order);
        const grossFilled = Number(verified.executedQty || 0);
        const positionOutflow = positionReductionOnSell(grossFilled, Number(verified.commissionBase || 0));
        const soldQty = Math.min(position.quantity, grossFilled);
        const outflowQty = Math.min(position.quantity, positionOutflow);
        const price = Number(order.quoteQty) > 0 && grossFilled > 0 ? Number(order.quoteQty) / grossFilled : Number(position.entryPrice || 0);
        this.state.live.safeToTrade = false;
        this.log(`${symbol}: belirsiz kalan çıkış emri (${order.clientOrderId}) gerçekleşmiş; pozisyona işleniyor.`, 'warn');
        await this._bookExitFill({ symbol, position, order: verified, soldQty, outflowQty, price, reason: String(order.meta?.reason || 'çıkış (gecikmeli doğrulandı)'), emergency: false, sellRules });
        changed = true;
      } catch (err) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `${symbol}: gerçekleşmiş çıkış emri deftere işlenemedi: ${err?.message || String(err)}`;
        this.log(this.state.live.lockReason, 'error');
      }
    }
    if (changed) { this.lastReconcileAt = 0; this._safePersist(); }
    return changed;
  }

  // Giris komisyonu alis aninda islem bazinda DOGRULANAMADIYSA (ag hatasi, kayip WS olaylari) pozisyon brut/eksik net
  // miktarla kaydedilmis olabilir: bakiyeden buyuk pozisyon, reddedilen koruyucu stop ve kalici kilit demektir.
  // Dogrulama sonradan basarili olursa, henuz hic cikis yapilmamis pozisyonun miktari net miktara duzeltilir.
  async _reverifyEntryFees(symbol, position) {
    const id = position?.entryOrderId;
    if (!id || position.entryFeesVerified === true) return;
    if (!this.exchange?.capabilities?.orderTrades || typeof this.orderManager?.verifyFees !== 'function') return;
    const before = this.orderManager.get?.(id);
    if (!before || !(Number(before.executedQty) > 0)) return;
    const fresh = await this._withFeeValuation(before);
    const rec = this.orderManager.get(id);
    if (!(Number(rec?.feesVerifiedQty || 0) >= Number(rec?.executedQty || 0) - 1e-12)) return;   // hala dogrulanamadi
    position.entryFeesVerified = true;
    const net = Number(fresh.netExecutedQty ?? fresh.executedQty);
    // "Dokunulmamis": hic cikis/stop dolumu islenmemis ve miktar hala giris aninda kaydedilen (ya da brut dolum) miktar.
    // Kayit baska bir yolla (reconcile) zaten dogrulanmis olabilecegi icin karsilastirma KAYITLA degil pozisyonla yapilir.
    const near = (a, b) => Math.abs(Number(a) - Number(b)) <= Math.max(1e-9, Math.abs(Number(b)) * 1e-9);
    const untouched = !(Number(position.stopExecutedQty) > 0) && !position.stopBooked
      && (near(position.quantity, position.entryQuantity ?? NaN) || near(position.quantity, rec.executedQty));
    if (untouched && net > 0 && net < Number(position.quantity) - 1e-9) {
      this.log(`${symbol}: giriş komisyonu doğrulandı; pozisyon miktarı ${position.quantity} → ${net} olarak düzeltildi.`, 'warn');
      position.quantity = net;
      position.entryQuantity = net;
      if (Number(position.costQuote) > 0) position.entryPrice = Number(position.costQuote) / net;
      position.entryCommissionByAsset = { ...(fresh.commissionByAsset || {}) };
      position.entryCommissionTotal = Number(fresh.commissionTotal || 0);
      this.state.live.safeToTrade = false;
      this.lastReconcileAt = 0;
    }
    this._safePersist();
  }

  // Pozisyona BAGLI OLMAYAN (yanit kaybolan / degistirilmis) koruyucu emirler sonradan dolmus olabilir. Bu dolumlar
  // pozisyona hic islenmezse yerel miktar bakiyeden buyuk kalir (hayalet pozisyon, kalici kilit). Emir bazinda islenmis
  // kumulatif miktar (pos.stopBooked) ustundeki dolum, koruyucu dolum yolundan (seri, tekrarsiz) pozisyona islenir.
  async _bookUnlinkedProtectiveFills(symbol, position) {
    const candidates = Object.values(this.state.liveOrders || {}).filter((o) => {
      if (!o || !PROTECTIVE_ROLES.has(o.meta?.role)) return false;
      if (String(o.side || '').toLowerCase() !== 'sell') return false;
      if (String(o.symbol || '').toUpperCase() !== String(symbol).toUpperCase()) return false;
      if (o.clientOrderId === position.stopOrderId || o.clientOrderId === position.tpOrderId) return false;
      if (!o.meta?.entryClientOrderId || o.meta.entryClientOrderId !== position.entryOrderId) return false;
      const status = String(o.status || '').toUpperCase();
      if (!['FILLED', 'PARTIALLY_FILLED', 'CANCELED', 'EXPIRED'].includes(status)) return false;
      const booked = Number(position.stopBooked?.[o.clientOrderId]?.gross || 0);
      return Number(o.executedQty || 0) > booked + 1e-12;
    });
    let changed = false;
    for (const o of candidates) {
      const pos = this.state.live.positions[symbol];
      if (!pos) break;
      const pendingLock = this.stopUpdateLocks.get(symbol);
      if (pendingLock) await pendingLock.catch(() => {});
      const booked = pos.stopBooked?.[o.clientOrderId] || { gross: 0, baseFee: 0, netQuote: 0, thirdFee: 0 };
      const prevLink = { stopOrderId: pos.stopOrderId, stopExecutedQty: pos.stopExecutedQty, stopCommissionBase: pos.stopCommissionBase, stopNetQuoteQty: pos.stopNetQuoteQty, stopThird: pos.stopThirdAssetCommissionQuote, ids: pos.stopExecutionIds };
      pos.stopOrderId = o.clientOrderId;
      pos.stopExecutedQty = booked.gross; pos.stopCommissionBase = booked.baseFee; pos.stopNetQuoteQty = booked.netQuote;
      pos.stopThirdAssetCommissionQuote = booked.thirdFee; pos.stopExecutionIds = [];
      this.log(`${symbol}: pozisyona bağlı olmayan koruyucu emrin (${o.clientOrderId}) dolumu işleniyor.`, 'warn');
      try {
        await this._handleProtectiveStopUpdate({ ...o, status: String(o.status).toUpperCase() === 'FILLED' ? 'FILLED' : 'PARTIALLY_FILLED' });
        changed = true;
      } catch (err) {
        this.state.live.safeToTrade = false;
        this.state.live.stopRecoveryError = { symbol, clientOrderId: o.clientOrderId, at: iso(this.nowFn()), error: err?.message || String(err) };
      }
      const after = this.state.live.positions[symbol];
      // Isleyici yeni bir stop kurmadiysa (ornegin dolum islenmedi) onceki baglanti geri yuklenir.
      if (after && after.stopOrderId === o.clientOrderId && prevLink.stopOrderId !== o.clientOrderId) {
        after.stopOrderId = prevLink.stopOrderId; after.stopExecutedQty = prevLink.stopExecutedQty; after.stopCommissionBase = prevLink.stopCommissionBase;
        after.stopNetQuoteQty = prevLink.stopNetQuoteQty; after.stopThirdAssetCommissionQuote = prevLink.stopThird; after.stopExecutionIds = prevLink.ids;
      }
    }
    if (changed) { this.lastReconcileAt = 0; this.state.live.safeToTrade = false; this._safePersist(); }
    return changed;
  }

  // Pozisyona bagli olmayan ama borsada ACIK olan (NEW/PARTIALLY_FILLED) tek bir koruyucu stop varsa onu dondurur;
  // birden fazlaysa 'ambiguous' (ikisini birden saymak oversell riski), yoksa null.
  _findAdoptableProtectiveStop(symbol, position) {
    const open = Object.values(this.state.liveOrders || {}).filter((o) => {
      if (!o || String(o.side || '').toLowerCase() !== 'sell') return false;
      if (!['protective-stop', 'protective-stop-recovery', 'profit-protection-stop'].includes(o.meta?.role)) return false;
      if (String(o.symbol || '').toUpperCase() !== String(symbol).toUpperCase()) return false;
      if (!['NEW', 'PARTIALLY_FILLED'].includes(String(o.status || '').toUpperCase())) return false;
      // Baska bir pozisyon/giris icin kurulmus stop sahiplenilmez.
      if (o.meta?.entryClientOrderId && position.entryOrderId && o.meta.entryClientOrderId !== position.entryOrderId) return false;
      return true;
    });
    if (open.length === 0) return null;
    if (open.length > 1) return 'ambiguous';
    return open[0];
  }

  async _ensurePositionProtection() {
    let recoveredAny = false;
    const positions = this.state.live?.positions || {};
    for (const [symbol, position] of Object.entries(positions)) {
      await this._reverifyEntryFees(symbol, position);
      await this._bookUnlinkedProtectiveFills(symbol, position);
      if (!this.state.live.positions[symbol]) continue;
      let stopId = position?.stopOrderId;
      let stop = stopId ? this.orderManager.get(stopId) : null;
      let stopStatus = String(stop?.status || '').toUpperCase();
      // Stop gonderimi zaman asimina ugradiysa (UNKNOWN) emir borsada ACIK kalmis ama pozisyona hic baglanmamis olabilir.
      // Yeni stop gondermek (bakiye zaten kilitli) reddedilir ve bot sonsuza dek kilitli kalir: once mevcut acik
      // koruyucu stop sahiplenilir; kismi dolumu varsa pozisyona islenir.
      if (!stopId || ['CANCELED', 'REJECTED', 'EXPIRED'].includes(stopStatus)) {
        const adoptable = this._findAdoptableProtectiveStop(symbol, position);
        if (adoptable === 'ambiguous') {
          this.state.live.safeToTrade = false;
          this.state.live.lockReason = `${symbol}: birden fazla açık koruyucu stop bulundu; elle kontrol gerekli (oversell riski).`;
          continue;
        }
        if (adoptable) {
          position.stopOrderId = adoptable.clientOrderId;
          if (Number(adoptable.stopPrice) > 0) position.stopPrice = Number(adoptable.stopPrice);
          position.protectiveMode = 'single-stop'; position.nativeTrailing = false;
          this.log(`${symbol}: borsada açık koruyucu stop (${adoptable.clientOrderId}) pozisyona bağlandı.`, 'warn');
          stopId = adoptable.clientOrderId; stop = adoptable; stopStatus = String(adoptable.status || '').toUpperCase();
          if (Number(adoptable.executedQty || 0) > 0) {
            const pendingLock = this.stopUpdateLocks.get(symbol);
            if (pendingLock) await pendingLock.catch(() => {});
            await this._handleProtectiveStopUpdate({ ...adoptable, status: 'PARTIALLY_FILLED' });
          }
          this.lastReconcileAt = 0;
          this._safePersist();
          if (!this.state.live.positions[symbol]) continue;
        }
      }
      if (stopId && (stopStatus === 'NEW' || stopStatus === 'PARTIALLY_FILLED')) continue;
      // Stop dolmuş/kısmi dolup kapanmışsa önce dolumu muhasebeleştir. Aksi halde satılmış miktar
      // için yeni SELL stop kurulur (oversell) veya kalan miktar yanlış korunur.
      if (stop && Number(stop.executedQty || 0) > 0) {
        const pendingLock = this.stopUpdateLocks.get(symbol);
        if (pendingLock) await pendingLock.catch(() => {});
        await this._handleProtectiveStopUpdate({ ...stop, status: stopStatus === 'FILLED' ? 'FILLED' : 'PARTIALLY_FILLED' });
        if (!this.state.live.positions[symbol]) continue;
        if (stopStatus === 'FILLED') continue;
        // Dolumu ZATEN islenmis (isleyici tekrar korumasiyla erken dondu) ve emir terminal olmus: pozisyon artik bu bitmis
        // stopa bagli kalmamali; yoksa sell() "kismen dolmus stop" diye reddeder ve yeni stop hic kurulamaz (kalici kilit).
        const cur = this.state.live.positions[symbol];
        if (cur.stopOrderId === stopId && ['CANCELED', 'EXPIRED', 'REJECTED'].includes(String(this.orderManager.get(stopId)?.status || '').toUpperCase())
            && Number(cur.stopExecutedQty || 0) >= Number(stop.executedQty || 0) - 1e-12) {
          cur.stopOrderId = null; cur.stopExecutedQty = 0; cur.stopCommissionBase = 0; cur.stopNetQuoteQty = 0;
          cur.stopThirdAssetCommissionQuote = 0; cur.stopExecutionIds = [];
          this._safePersist();
        }
      }

      // Belirsiz/pending aynı sembol emri varken ikinci bir SELL stop üretmek
      // oversell riskidir; önce reconciliation çözülmelidir.
      const blocking = this.orderManager.listPending().find((o) =>
        o && o.symbol === symbol && (o.uncertain === true || String(o.status).toUpperCase() === 'UNKNOWN')
      );
      if (blocking) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `${symbol}: belirsiz emir ${blocking.clientOrderId} çözülmedi`;
        continue;
      }

      try {
        // Fiyat zaten stop seviyesinin ALTINA indiyse SELL-stop kurulamaz (borsa "hemen tetiklenir" diye
        // reddeder) ve pozisyon sonsuza dek korumasiz kalirdi. Bu durumda piyasadan kontrollu cikis yapilir.
        let lastPrice = Number(this.state.live?.lastPrices?.[symbol]);
        try { const t = await this.exchange.fetchTicker(symbol); if (Number(t?.price) > 0) lastPrice = Number(t.price); } catch (_) { /* son bilinen fiyat */ }
        if (Number(position.stopPrice) > 0 && lastPrice > 0 && lastPrice <= Number(position.stopPrice)) {
          this.log(`${symbol}: fiyat (${lastPrice}) stop seviyesinin (${position.stopPrice}) altında ve koruma yok; piyasadan çıkış deneniyor.`, 'warn');
          this.state.live.safeToTrade = false;
          await this.sell(symbol, position, lastPrice, 'koruma kurulamadı: fiyat stop seviyesinin altında', this.epoch, { emergency: true });
          this._safePersist();
          continue;
        }
        const rules = await this.getRules(symbol);
        const { stop: replacement, stopPrice } = await this._placeProtectiveStop(symbol, position, position.quantity, rules);
        if (replacement.status === 'NEW' || replacement.status === 'FILLED') {
          position.stopOrderId = replacement.clientOrderId;
          position.stopPrice = stopPrice;
          position.protectiveMode = 'single-stop';
          position.nativeTrailing = false;
          this.state.live.stopRecoveryError = null;
          this.state.live.lockReason = null;
          recoveredAny = true;
          this.log(`${symbol}: eksik koruyucu stop yeniden kuruldu.`, 'warn');
        } else {
          this.state.live.safeToTrade = false;
          this.state.live.stopRecoveryError = { symbol, at: iso(this.nowFn()), error: `Stop sonucu: ${replacement.status}` };
        }
      } catch (err) {
        this.state.live.safeToTrade = false;
        this.state.live.stopRecoveryError = { symbol, at: iso(this.nowFn()), error: err?.message || String(err) };
        this.log(`${symbol}: koruyucu stop yeniden kurulamadı: ${err?.message || String(err)}`, 'error');
      }
      this._safePersist();
    }
    if (recoveredAny) {
      // Stop gerçekten borsada açık mı diye hemen doğrula; 5 dakikalık normal
      // reconciliation aralığını beklemek gereksiz bir güvenlik kilidi yaratmasın.
      try {
        const r = await this.reconciler.reconcile();
        this.lastReconcileAt = this.nowFn();
        this.state.live.lastReconcileAt = iso(this.lastReconcileAt);
        this.state.live.lastBalance = r.balances || null;
        this.state.live.safeToTrade = r.safeToTrade === true;
        this._safePersist();
      } catch (err) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `Stop kurtarma sonrası doğrulama başarısız: ${err?.message || String(err)}`;
        this._safePersist();
      }
    }
  }

  async processPair(symbol, pairCfg, epoch, marketData = null, allowNewEntries = true) {
    let strategy;
    try { strategy = strategies.get(pairCfg.strategyId); } catch (e) { this.log(`${symbol}: ${e.message}`, 'warn'); return; }
    const params = { ...strategy.defaultParams, ...(pairCfg.params || {}) };
    const paramError = strategies.validateParams(strategy.id, params);
    if (paramError) { this.log(`${symbol}: geçersiz strateji parametreleri: ${paramError}`, 'warn'); return; }

    const timeframe = pairCfg.timeframe || this.state.settings.defaultTimeframe;
    if (marketData?.error) throw marketData.error;
    const candles = marketData
      ? marketData.candles
      : await this.exchange.fetchCandles(symbol, timeframe, Math.min(1000, strategies.candleLimit(strategy, params) + 1));
    validateCandleSeries(candles, timeframe);
    // Paper motor already rejects stale/future market data before it can update
    // equity or create a signal. Keep the live path symmetric: a syntactically
    // valid but cached candle series must not authorize a new real-money order.
    const latestCandle = candles[candles.length - 1];
    if (latestCandle) {
      const timeframeDuration = timeframeMs(timeframe);
      const pollMs = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
      const maxDataAgeMs = Math.max(2 * (timeframeDuration || 0), 5 * pollMs, 5 * 60 * 1000);
      const futureToleranceMs = Math.max(5 * 60 * 1000, 2 * pollMs);
      const ageMs = this.nowFn() - Number(latestCandle.t);
      if (ageMs > maxDataAgeMs) {
        throw new Error(`piyasa verisi eski (${Math.round(ageMs / 60000)} dk; sınır ${Math.round(maxDataAgeMs / 60000)} dk)`);
      }
      if (ageMs < -futureToleranceMs) {
        throw new Error('piyasa verisinin zaman damgası sistem zamanından ileride');
      }
    }
    const ticker = marketData ? marketData.ticker : await this.exchange.fetchTicker(symbol);
    if (epoch !== this.epoch) return;
    const price = Number(ticker.price);
    if (!Number.isFinite(price) || price <= 0) return;
    this.state.live.lastPrices[symbol] = price;

    const position = this.state.live.positions[symbol] || null;
    // Koruyucu emir senkronizasyonu sinyal dedup'undan ÖNCE çalışır: böylece
    // aynı mum içinde de trailing stop gerçek borsa emriyle yukarı taşınabilir.
    if (position) await this._syncTrailingStop(symbol, position, params, price);
    const { closed, forming } = splitCandles(candles, this.nowFn(), timeframe);
    if (!closed.length) return;
    const lastClosed = closed[closed.length - 1];
    if (this.state.live.lastSignalT[symbol] === lastClosed.t) return;

    const decision = strategy.evaluate({ candles: closed, position, params });
    this.state.live.lastSignalT[symbol] = lastClosed.t;

    // Sinyal taze mi? (kagit motorla ayni kural) Mum kapanisindan cok sonra -bot kapaliydi, parite yeni
    // eklendi, ag kesildi- bir ALIM sinyali bilinmeyen bir fiyattan gercek para harcatir: UYGULANMAZ.
    // Eski bir SATIM sinyali ise riski azalttigi icin yine uygulanir.
    const pollMs = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
    const step = forming ? forming.t - lastClosed.t : (candles.length > 1 ? lastClosed.t - candles[candles.length - 2].t : timeframeMs(timeframe));
    const closeT = forming ? forming.t : lastClosed.t + (step || timeframeMs(timeframe));
    const maxAgeMs = Math.min(Math.max(3 * pollMs, 120000), Math.max(60000, (step || timeframeMs(timeframe) || 3600000) / 2));
    const now = this.nowFn();
    // Never bypass stale-signal protection in production for synthetic timestamps.
    // Tests using fixture timestamps must inject a matching clock.
    const ageMs = Math.max(0, now - closeT);
    const fresh = ageMs <= maxAgeMs;
    this.state.decisions[symbol] = { action: decision.action, reason: decision.reason, candleT: lastClosed.t, evaluatedAt: iso(this.nowFn()), price, mode: 'live', stale: !fresh };
    this._safePersist();

    if (decision.action === 'buy' && !fresh) {
      this.log(`${symbol}: alım sinyali eski (${Math.round(ageMs / 60000)} dk önce kapanan mum), gerçek emir gönderilmedi.`, 'info');
    } else if (decision.action === 'buy' && pairCfg.enabled && !position) {
      if (!allowNewEntries) {
        this.log(`${symbol}: bu tur yeni alım yapılmadı; açık pozisyonlardan en az birinin piyasa verisi eksik.`, 'warn');
        return;
      }
      const blocked = this._extrasEntryBlock(symbol, closed, timeframe);
      if (blocked) {
        this.state.decisions[symbol].blockedBy = blocked.reason;
        this.log(`${symbol}: alım sinyali uygulanmadı — ${blocked.reason}.`, 'info');
        return;
      }
      await this.buy(symbol, pairCfg, params, price, decision.reason, epoch);
    } else if (decision.action === 'hold' && position && fresh) {
      // Zaman bariyeri: yalnizca bir CIKIS onerisi; emir mevcut sell yolundan (stop iptali, mutabakat, kilitler) gecer.
      const tb = timeBarrierExit({ position, closedCandles: closed, price, config: this.state.settings.timeBarrier });
      if (tb) {
        try {
          await this.sell(symbol, position, price, tb.reason, epoch);
        } catch (err) {
          if (this.state.live.lastSignalT[symbol] === lastClosed.t) delete this.state.live.lastSignalT[symbol];
          this._safePersist();
          throw err;
        }
      }
    } else if (decision.action === 'sell' && position) {
      try {
        await this.sell(symbol, position, price, decision.reason, epoch);
      } catch (err) {
        // Basarisiz cikis sinyali bu muma TUKETILMIS sayilmaz: sonraki turda (kilit acilinca) yeniden denenir.
        // Aksi halde ornegin 4 saatlik mumda bir ag hatasi, cikis sinyalini 4 saat boyunca yutardi.
        if (this.state.live.lastSignalT[symbol] === lastClosed.t) delete this.state.live.lastSignalT[symbol];
        this._safePersist();
        throw err;
      }
    }
  }

  _extrasEntryBlock(symbol, closed, timeframe) {
    try {
      let referenceEquity = 0;
      try { referenceEquity = Number(Object.values(this.state.live.startingEquityByQuote || {})[0]) || 0; } catch { referenceEquity = 0; }
      return entryBlock({
        settings: this.state.settings,
        trades: this.state.live.trades,
        symbol, now: this.nowFn(), closedCandles: closed,
        timeframeMs: timeframeMs(timeframe),
        referenceEquity,
        foragerPruned: this.foragerPruned
      });
    } catch (e) {
      return { reason: `ek koruma katmanı hatası (${e.message}); güvenli tarafta alım atlandı` };
    }
  }

  async getRules(symbol) {
    if (this.symbolRulesCache[symbol]) return this.symbolRulesCache[symbol];
    const r = await this.exchange.fetchSymbolRules(symbol);
    this.symbolRulesCache[symbol] = r;
    return r;
  }

  // Komisyon dogrulama/degerleme AG cagrisi gerektirebilir; gerekmiyorsa islem eşzamanlı (bekleme olmadan) surer.
  _feeRefreshNeeded(order) {
    const om = this.orderManager;
    const rec = order?.clientOrderId ? om?.get?.(order.clientOrderId) : null;
    if (!rec) return false;
    const exCaps = this.exchange?.capabilities || {};
    if (exCaps.orderTrades && Number(rec.executedQty || 0) > Number(rec.feesVerifiedQty || 0) + 1e-12) return true;
    const symbol = String(rec.symbol || '').toUpperCase().replace('/', '');
    const quote = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TRY', 'EUR', 'BTC', 'ETH'].find((q) => symbol.endsWith(q)) || '';
    const base = quote ? symbol.slice(0, -quote.length) : '';
    const third = nonPairCommissionAssets({ byAsset: rec.commissionByAsset || {} }, base, quote);
    return third.length > 0 && !thirdFeeValuationIsCurrent(rec, third);
  }

  // Emrin komisyonunu once islem bazinda dogrular (WS olaylari kaybolmus olabilir; myTrades destekleniyorsa), sonra
  // ucuncu varlik komisyonunu (BNB vb.) GUNCEL miktarlarla degerler. Net miktarlar da guncel kayittan alinir:
  // eksik komisyonla hesaplanan net miktar, bakiyeden BUYUK pozisyon ve reddedilen koruyucu stop demektir.
  async _withFeeValuation(order) {
    if (!order?.clientOrderId || !this.orderManager) return order;
    try {
      if (typeof this.orderManager.verifyFees === 'function') await this.orderManager.verifyFees(order.clientOrderId);
      const fresh = typeof this.orderManager.ensureFeeValuation === 'function'
        ? await this.orderManager.ensureFeeValuation(order.clientOrderId)
        : this.orderManager.get?.(order.clientOrderId);
      if (!fresh) return order;
      const pick = {};
      for (const k of ['thirdAssetCommissionQuote', 'thirdAssetCommissionValuationComplete', 'thirdAssetCommissionValuation', 'commissionByAsset', 'commissionTotal', 'commissionBase', 'commissionQuote', 'netExecutedQty', 'netQuoteQty']) {
        if (fresh[k] !== undefined) pick[k] = fresh[k];
      }
      return { ...order, ...pick };
    } catch (_) { return order; }
  }

  _orderFeeQuoteValue(order) {
    const symbol = String(order?.symbol || '').toUpperCase().replace('/', '');
    const quotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TRY', 'EUR', 'BTC', 'ETH'];
    const quote = quotes.find((q) => symbol.endsWith(q)) || '';
    const base = quote ? symbol.slice(0, -quote.length) : '';
    const third = nonPairCommissionAssets({ byAsset: order?.commissionByAsset || order?.commission?.byAsset || {} }, base, quote);
    if (!third.length) return 0;
    if (order?.thirdAssetCommissionValuationComplete !== true) return null;
    // Bayat degerleme (komisyon sonradan WS ile artti / hic degerlenmedi) 0 sayilmaz: null -> yeniden degerleme gerekir.
    if (order?.thirdAssetCommissionValuation && !thirdFeeValuationIsCurrent(order, third)) return null;
    const value = Number(order?.thirdAssetCommissionQuote);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  _roundSellStopPrice(price, tickSize) {
    const p = Number(price);
    const t = Number(tickSize);
    if (!(p > 0)) return 0;
    if (!(t > 0)) return p;
    const quotient = p / t;
    const nearest = Math.round(quotient);
    // Normalize binary representation noise (e.g. 120 * 0.97 becomes
    // 116.39999999999999). For a SELL stop, a one-tick downward rounding
    // caused only by float noise is unnecessary and can delay protection.
    const normalized = Math.abs(quotient - nearest) <= 1e-8 ? nearest * t : Math.floor(quotient) * t;
    return Number(normalized.toFixed(Math.min(12, Math.max(0, String(t).split('.')[1]?.length || 0))));
  }

  // Satilabilir/koruyucu emir miktari: borsa adimina (LOT_SIZE / MARKET_LOT_SIZE) ASAGI yuvarlanir.
  // Alimda baz varlik komisyonu dusulunce net miktar adim katı olmaz; yuvarlanmadan gonderilirse
  // hem market satis hem koruyucu stop "LOT_SIZE" filtresiyle reddedilir ve pozisyondan cikilamaz.
  _sellQty(qty, rules, { market = false } = {}) {
    const q = Number(qty);
    if (!(q > 0)) return 0;
    const step = market
      ? Number(rules?.marketStepSize || rules?.stepSize || 0)
      : Number(rules?.stepSize || rules?.marketStepSize || 0);
    return step > 0 ? roundDownToStep(q, step) : q;
  }

  _addDust(symbol, qty) {
    const base = String(symbol || '').toUpperCase().split('/')[0];
    const q = Number(qty);
    if (!base || !(q > 0)) return;
    this.state.live.dustByAsset = this.state.live.dustByAsset || {};
    this.state.live.dustByAsset[base] = Number(this.state.live.dustByAsset[base] || 0) + q;
  }

  // takeProfitPct <= 0 kâr koruma aktivasyonunu kapatır.
  _tpEnabled(pct) {
    const n = Number(pct);
    return Number.isFinite(n) && n > 0;
  }

  _pairParams(symbol) {
    const pair = this.state.pairs?.[symbol] || {};
    let defaults = {};
    try { defaults = strategies.get(pair.strategyId).defaultParams || {}; } catch (_) { /* bilinmeyen strateji */ }
    return { ...defaults, ...(pair.params || {}) };
  }

  // Tek bir koruyucu stop kurar (kismi dolum / satis iptali / yeniden koruma icin ortak yol).
  async _placeProtectiveStop(symbol, position, qty, rules, role = 'protective-stop-recovery') {
    const stopPct = Number(this._pairParams(symbol).stopLossPct);
    let stopPrice = Number(position.stopPrice);
    if (!(stopPrice > 0)) {
      if (!(stopPct > 0)) throw new Error(`${symbol}: koruyucu stop için geçerli stopLossPct yok.`);
      stopPrice = Number(position.entryPrice || 0) * (1 - stopPct / 100);
    }
    stopPrice = this._roundSellStopPrice(stopPrice, rules.tickSize);
    const amount = this._sellQty(qty, rules);
    if (!(stopPrice > 0) || !(amount > 0)) throw new Error(`${symbol}: koruyucu stop parametreleri üretilemedi.`);
    const stop = await this.orderManager.submitStop({ symbol, side: 'sell', amount, stopPrice, limitPrice: 0, meta: { role, entryClientOrderId: position.entryOrderId } });
    return { stop, stopPrice };
  }

  async _syncTrailingStop(symbol, position, params, price) {
    if (position.nativeTrailing) return;
    if (!(Number(params.stopLossPct) > 0) || !(price > 0) || !position.stopOrderId) return;
    const tpPct = Number(params.takeProfitPct);
    const activation = Number.isFinite(tpPct) && tpPct > 0
      ? Number(position.entryPrice || 0) * (1 + tpPct / 100)
      : Infinity;
    const oldHigh = Number(position.highWaterMark || position.entryPrice || 0);
    const alreadyTrailing = Boolean(params.trailingStop) || oldHigh >= activation;
    if (!alreadyTrailing && price < activation) return;
    if (!(price > oldHigh)) return;
    position.highWaterMark = price;
    const rules = await this.getRules(symbol);
    const trailingStop = price * (1 - Number(params.stopLossPct) / 100);
    const breakEvenFloor = Number(position.entryPrice || 0) * (1 + 0.20 / 100);
    const naturalBreakEven = trailingStop >= breakEvenFloor;
    const tpBreakEven = Number.isFinite(activation) && (oldHigh >= activation || price >= activation);
    const floorActive = tpBreakEven || naturalBreakEven;
    const nextStop = this._roundSellStopPrice(floorActive ? Math.max(trailingStop, breakEvenFloor) : trailingStop, rules.tickSize);
    if (!(nextStop > Number(position.stopPrice || 0) + Math.max(Number(rules.tickSize || 0), 1e-12))) return;
    // Her yeni tepede iptal+yeniden kurma, stop'suz kisa pencereyi ve API/emir kaydi yukunu surekli tekrarlar.
    // Stop yalnizca en az %0.25 iyilesiyorsa tasinir (kâr korumanin ilk aktivasyonu bu esigi zaten asar).
    if (Number(position.stopPrice) > 0 && nextStop < Number(position.stopPrice) * (1 + MIN_STOP_STEP_PCT / 100)) return;
    const wasSafe = this.state.live.safeToTrade === true;
    const lockSnapshot = this._lockSnapshot();
    this.state.live.safeToTrade = false;
    const oldId = position.stopOrderId;

    // Spot borsalarda SELL stop emri coin miktarını kilitleyebilir. Bu nedenle
    // eski stop canlıyken aynı miktarda ikinci SELL stop göndermek çoğu borsada
    // -2010 / insufficient balance ile reddedilir. Güvenli spot sözleşmesi:
    // cancel -> doğrula -> replacement. Aradaki çıplak pencereyi mümkün olduğunca
    // kısa tutuyoruz; replacement başarısız olursa yeniden koruma, o da olmazsa
    // kontrollü market çıkışı deneniyor.
    const canceled = await this.orderManager.cancel(oldId);
    if (canceled && String(canceled.status).toUpperCase() === 'FILLED') {
      await this._settleProtectiveFilledDuringCancel(symbol, canceled);
      return;
    }
    if (!canceled || String(canceled.status).toUpperCase() !== 'CANCELED' || Number(canceled.executedQty || 0) > 0) {
      this.state.live.safeToTrade = false;
      this._safePersist();
      throw new Error(`${symbol}: eski dinamik stop güvenli şekilde iptal edilemedi; canlı işlem kilitlendi.`);
    }
    position.stopOrderId = null;
    this._safePersist();

    let replacement = null;
    let replacementError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        replacement = await this.orderManager.submitStop({
          symbol, side: 'sell', amount: this._sellQty(position.quantity, rules),
          stopPrice: nextStop,
          limitPrice: 0,
          meta: { role: 'profit-protection-stop', entryClientOrderId: position.entryOrderId, trailing: true }
        });
        const st = String(replacement.status || '').toUpperCase();
        if (['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(st)) break;
        if (st === 'UNKNOWN' || replacement.uncertain === true) {
          replacementError = new Error('Yeni stop sonucu belirsiz; duplicate SELL riski nedeniyle yeniden gönderilmedi.');
          break;
        }
        replacementError = new Error(`Stop sonucu: ${replacement.status}`);
      } catch (err) { replacementError = err; }
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }

    const replacementStatus = String(replacement?.status || '').toUpperCase();
    if (!replacement || !['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(replacementStatus)) {
      // UNKNOWN sonuçta emir borsada oluşmuş olabilir; duplicate SELL/stop üretmek
      // yerine reconciliation'a bırakıyoruz. Kesin REJECTED/başarısız sonuçta ise
      // eski stop zaten iptal edildiği için kontrollü market çıkışı son savunmadır.
      if (replacementStatus === 'UNKNOWN' || replacement?.uncertain === true) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `${symbol}: yeni stop sonucu belirsiz; reconciliation gerekli`;
        this.state.live.stopReplacementError = { symbol, at: iso(this.nowFn()), error: replacementError?.message || 'unknown stop outcome' };
        this.state.live.criticalAlert = { type: 'PROTECTION_UNKNOWN', symbol, at: iso(this.nowFn()), message: 'Yeni koruyucu stop sonucu belirsiz; reconciliation gerekli.' };
        this.notify(`🚨 KRİTİK: ${symbol} yeni koruyucu stop sonucu BELİRSİZ. Duplicate emir göndermeden reconciliation gerekli.`, { key: `critical-protection-unknown:${symbol}`, minIntervalMs: 60000, priority: 'critical' });
        this._safePersist();
        throw new Error(`${symbol}: yeni dinamik stop sonucu belirsiz; duplicate emir riski nedeniyle canlı işlem kilitlendi.`);
      }
      // Son güvenlik katmanı: eski stop artık iptal edildi ve yenisi kurulamadı.
      // Açık pozisyonu bilinçli şekilde çıplak bırakmak yerine market çıkışı dene.
      this.state.live.safeToTrade = false;
      this.state.live.stopReplacementError = { symbol, at: iso(this.nowFn()), error: replacementError?.message || 'stop replacement başarısız' };
      this._safePersist();
      try {
        await this.sell(symbol, position, price, 'profit-protection-stop-replacement-failed', this.epoch, { emergency: true });
        return;
      } catch (exitErr) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `${symbol}: stop yenilenemedi ve acil market çıkışı da başarısız; reconciliation gerekli`;
        this.state.live.criticalAlert = {
          type: 'PROTECTION_FAILURE',
          symbol,
          at: iso(this.nowFn()),
          message: `Koruyucu stop yenilenemedi ve acil market çıkışı da başarısız: ${exitErr?.message || exitErr}`
        };
        this.notify(`🚨 KRİTİK KORUMA HATASI ${symbol}: stop yenilenemedi ve acil market çıkışı da başarısız. Manuel/reconciliation müdahalesi gerekli.`, { key: `critical-protection:${symbol}`, minIntervalMs: 60000, priority: 'critical' });
        this._safePersist();
        throw new Error(`${symbol}: dinamik stop kurulamadı ve acil çıkış başarısız: ${exitErr?.message || exitErr}`);
      }
    }

    position.stopOrderId = replacement.clientOrderId;
    position.stopPrice = nextStop;
    position.protectiveMode = 'single-stop';
    position.tpOrderId = null;
    position.tpPrice = null;
    // Bekleme sırasında başka bir kaynak (mutabakat, tanınmayan emir, kill switch) kilit koyduysa
    // eski "güvenli" değeri geri yazmak o kilidi sessizce açardı.
    this.state.live.safeToTrade = wasSafe && this._lockSnapshot() === lockSnapshot;
    if (replacementStatus === 'FILLED' || replacementStatus === 'PARTIALLY_FILLED') {
      await this._handleProtectiveStopUpdate(replacement);
      return;
    }
    this._safePersist();
  }

  _validateTriggerPrice(rules, side, triggerPrice, referencePrice) {
    const p = Number(triggerPrice), ref = Number(rules?.referencePrice || referencePrice || 0);
    const pr = rules?.priceRange || {};
    if (this.exchange.id !== 'binancetr') return { ok: true, errors: [] };
    if (!(ref > 0) || !pr || Object.keys(pr).length === 0) return { ok: false, errors: ['executionRules/referencePrice'] };
    const errors = [];
    const up = String(side).toLowerCase() === 'sell' ? Number(pr.askMultiplierUp || 0) : Number(pr.bidMultiplierUp || 0);
    const down = String(side).toLowerCase() === 'sell' ? Number(pr.askMultiplierDown || 0) : Number(pr.bidMultiplierDown || 0);
    if (up > 0 && p > ref * up) errors.push('priceRangeUp');
    if (down > 0 && p < ref * down) errors.push('priceRangeDown');
    return { ok: errors.length === 0, errors };
  }

  async _checkMarketOrderSafety({ symbol, side, baseQty, quoteQty = 0, emergency = false }) {
    const relaxed = emergency === true && String(side).toLowerCase() === 'sell';
    if (this.exchange.id === 'simulation') return;
    // Gerçek adapterler capability + fetchOrderBook uygular. Eski/yalın test doubles
    // order-book sözleşmesini uygulamıyorsa bu yardımcı yalnızca unit test dublörünü
    // engellememek için bypass edilir; gerçek borsa adapterleri bypass edemez.
    if (this.exchange.id !== 'simulation' && typeof this.exchange.fetchOrderBook !== 'function') {
      return;
    }
    let book;
    try { book = await this.exchange.fetchOrderBook(symbol, 50); }
    catch (err) { this.state.live.lastMarketSafety = { symbol, side, at: iso(this.nowFn()), ok: false, errors: ['order-book alınamadı'] }; this._safePersist(); throw new Error(`${symbol}: order-book alınamadı; bu MARKET girişi gönderilmedi: ${err.message}`); }
    const cfg = this.state.settings || {};
    let result;
    try {
      result = checkMarketOrderSafety({
        book, side, baseQty, quoteQty,
        marketBuyUsesQuote: this.exchange.marketBuyUsesQuote === true || this.exchange.capabilities?.marketBuyUsesQuote === true,
        maxSpreadPct: relaxed ? Math.max(Number(cfg.maxMarketSpreadPct ?? 0.75), EMERGENCY_MAX_SPREAD_PCT) : Number(cfg.maxMarketSpreadPct ?? 0.75),
        maxSlippagePct: relaxed ? Math.max(Number(cfg.maxMarketSlippagePct ?? 0.50), EMERGENCY_MAX_SLIPPAGE_PCT) : Number(cfg.maxMarketSlippagePct ?? 0.50),
        minDepthCoverage: relaxed ? Math.min(Number(cfg.minMarketDepthCoverage ?? 1.25), EMERGENCY_MIN_DEPTH_COVERAGE) : Number(cfg.minMarketDepthCoverage ?? 1.25)
      });
    } catch (err) {
      this.state.live.lastMarketSafety = { symbol, side, at: iso(this.nowFn()), ok: false, errors: [err.message] }; this._safePersist();
      throw new Error(`${symbol}: order-book MARKET güvenlik hesabı başarısız; emir gönderilmedi: ${err.message}`);
    }
    this.state.live.lastMarketSafety = { symbol, side, at: iso(this.nowFn()), spreadPct: result.spreadPct, impactPct: result.impactPct, depthCoverage: result.coverage, avgPrice: result.avgPrice, emergency: relaxed };
    if (!result.ok) {
      this.state.live.lastMarketSafety = { ...this.state.live.lastMarketSafety, ok: false, errors: result.errors };
      this._safePersist();
      throw new Error(`${symbol}: MARKET emir güvenlik kontrolü reddetti: ${result.errors.join('; ')}`);
    }
  }

  async buy(symbol, pairCfg, params, price, reason, epoch) {
    const riskErrors = this._validateRiskSettings();
    if (riskErrors.length) {
      this.state.live.safeToTrade = false;
      this._safePersist();
      throw new Error(`Canlı risk ayarları geçersiz: ${riskErrors.join(', ')}`);
    }
    const budgetPct = Number(pairCfg?.budgetPct);
    if (!Number.isFinite(budgetPct) || budgetPct <= 0 || budgetPct > 100) {
      this.state.live.safeToTrade = false;
      this._safePersist();
      throw new Error(`${symbol}: budgetPct geçersiz; canlı alış kilitlendi.`);
    }
    // Emir göndermeden hemen önce ikinci risk kapısı. İlk kapı tick başında
    // çalışır; fakat ağ/bakiye/stop hazırlığı sırasında kill-switch tetiklenmiş
    // olabilir. Bu kontrol yeni giriş emrinin yarış durumunda kaçmasını önler.
    if (this.state.killSwitch || this.state.live?.safeToTrade !== true) return;
    if (Object.keys(this.state.live.positions).length >= Number(this.state.settings.maxConcurrentPositions || 1)) return;
    const maxOpenOrders = Number(this.state.settings.maxOpenOrders || 12);
    const activeOrderCount = Object.values(this.state.liveOrders || {}).filter((o) => o && !TERMINAL.has(String(o.status || '').toUpperCase())).length;
    if (activeOrderCount >= maxOpenOrders) { this.state.live.safeToTrade = false; this._safePersist(); throw new Error(`${symbol}: maksimum açık emir sınırı (${maxOpenOrders}) aşıldı.`); }
    const quote = this.quoteAsset(symbol);
    const supportedQuotes = this.exchange.quoteAssets || [];
    const activeQuote = String(this.state.settings.quoteAsset || (supportedQuotes[0] || '')).toUpperCase();
    if (!quote || (supportedQuotes.length && (!supportedQuotes.includes(quote) || quote !== activeQuote))) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: paritenin quote varlığı (${quote || 'bilinmiyor'}) bu borsada desteklenmiyor; canlı alış kilitlendi.`);
    }
    const balance = await this.exchange.fetchBalance();
    const available = Number(balance?.[quote]?.free || 0);
    const reserve = available * (Number(this.state.settings.reserveCashPct || 0) / 100);
    let spend = Math.max(0, available - reserve) * (Number(pairCfg.budgetPct) / 100);
    // Yerel pozisyonlar yeniden başlatma/eski sürümden kalmış olabilir. TRY ve
    // USDT gibi farklı quote varlıklarını aynı sayısal toplamda birleştirmek
    // sermaye sınırlarını bozacağından, belirsiz/karışık kasa durumunda fail-closed.
    const positionEntries = Object.entries(this.state.live.positions || {});
    const mismatchedQuote = positionEntries.find(([key, pos]) => {
      const positionQuote = String(pos?.quoteAsset || this.quoteAsset(pos?.symbol || key) || '').toUpperCase();
      return !positionQuote || positionQuote !== quote;
    });
    if (mismatchedQuote) {
      this.state.live.safeToTrade = false;
      this.state.live.lastRiskError = `Karışık/uyuşmayan kasa birimi: ${mismatchedQuote[0]} mevcut quote=${String(mismatchedQuote[1]?.quoteAsset || this.quoteAsset(mismatchedQuote[0]) || 'bilinmiyor')}, aktif quote=${quote}. Mutabakat gerekli.`;
      this._safePersist();
      throw new Error(this.state.live.lastRiskError);
    }
    const positionCost = positionEntries.reduce((sum, [, pos]) => {
      const c = Number(pos?.costQuote ?? pos?.costUSDT ?? (Number(pos?.quantity) * Number(pos?.entryPrice)));
      return sum + (Number.isFinite(c) && c > 0 ? c : 0);
    }, 0);
    const portfolioEquity = available + positionCost;
    // Portfoy politikasi, NIHAI harcama tutariyla (maxTradeQuote siniri uygulandiktan sonra) kontrol edilir.
    const maxTrade = Number(this.state.settings.maxTradeQuote || 0);
    if (maxTrade > 0) spend = Math.min(spend, maxTrade);
    const policyCheck = canOpenPosition({symbol,pair:pairCfg,positions:this.state.live.positions,pairs:this.state.pairs,policy:this.state.settings.portfolioPolicy,equity:portfolioEquity,requestedCost:spend});
    if (!policyCheck.ok) return;
    const rules = await this.getRules(symbol);
    const minNotional = Number(rules.minNotional);
    const quantityOnlyRules = rules.minNotionalMode === 'quantity-only';
    if ((!Number.isFinite(minNotional) || minNotional <= 0) && !quantityOnlyRules) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: borsa minimum emir kuralı alınamadı; canlı alış kilitlendi.`);
    }
    if (quantityOnlyRules && (!(Number(rules.minQty) > 0) || !(Number(rules.stepSize) > 0))) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: miktar/adım kuralları eksik; canlı alış kilitlendi.`);
    }
    if (minNotional > 0 && rules.minNotionalAppliesToMarket !== false && !(spend >= minNotional)) return;
    const qtyStep = Number(rules.marketStepSize || rules.stepSize || 0);
    const minQty = Number(rules.marketMinQty || rules.minQty || 0);
    const maxQty = Number(rules.marketMaxQty || rules.maxQty || 0);
    const baseQty = roundDownToStep(spend / price, qtyStep);
    if (!(baseQty > 0) || (minQty && baseQty < minQty) || (maxQty && baseQty > maxQty) || (minNotional > 0 && rules.minNotionalAppliesToMarket !== false && baseQty * price < minNotional)) return;
    if (epoch !== this.epoch || this.state.killSwitch || this.state.live?.safeToTrade !== true) return;
    // BtcTurk market BUY quantity is quote-currency amount (TRY/USDT), while
    // the other adapters use base-asset quantity. The adapter declares this explicitly.
    const marketBuyUsesQuote = this.exchange.marketBuyUsesQuote === true || this.exchange.capabilities?.marketBuyUsesQuote === true;
    const orderAmount = marketBuyUsesQuote ? spend : baseQty;
    const validationQty = marketBuyUsesQuote ? baseQty : orderAmount;
    const ruleCheck = validateMarketOrder({ rules, side: 'buy', amount: validationQty, price });
    if (!ruleCheck.ok) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: borsa emir kuralları sağlanmadı: ${ruleCheck.errors.join(', ')}`);
    }
    // Koruma on-kontrolu: market alis GONDERILMEDEN once koruyucu emrin kurulabilecegi dogrulanir.
    // Eskiden bu kontroller dolumdan SONRA yapiliyordu; basarisizlikta coin alinmis ama korumasiz
    // (ve yerel defterde kayitsiz) kalabiliyordu.
    if (rules.supportsProtectiveStop === false) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: borsa bu paritede doğrulanmış koruyucu stop türünü desteklemiyor; alış gönderilmedi.`);
    }
    const preStopPct = Number(params.stopLossPct);
    if (!Number.isFinite(preStopPct) || preStopPct <= 0 || preStopPct >= 100) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: koruyucu stop için geçerli stopLossPct gerekli; alış gönderilmedi.`);
    }
    if (Boolean(params.trailingStop) && this.exchange.id !== 'simulation' && this.exchange.capabilities?.nativeTrailingOco !== true) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: borsada doğrulanmış native trailing yok; alış gönderilmedi.`);
    }
    const preStopPrice = this._roundSellStopPrice(price * (1 - preStopPct / 100), rules.tickSize);
    if (!(preStopPrice > 0)) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: borsa fiyat adımına uygun koruyucu stop fiyatı üretilemiyor; alış gönderilmedi.`);
    }
    try {
      await this._checkMarketOrderSafety({ symbol, side: 'buy', baseQty, quoteQty: spend });
    } catch (err) {
      this.state.live.lastEntryRejection = { symbol, at: iso(this.nowFn()), reason: err?.message || String(err) };
      this._safePersist();
      this.log(`${symbol}: MARKET alış gönderilmedi: ${err?.message || String(err)}`, 'warn');
      return;
    }

    let order = await this.orderManager.submitMarket({ symbol, side: 'buy', amount: orderAmount, meta: { role: 'entry', reason } });
    if (order.status === 'UNKNOWN' || order.uncertain) {
      this.state.live.safeToTrade = false;
      this._safePersist();
      throw new Error(`${symbol}: alış emri sonucu belirsiz; canlı işlem kilitlendi.`);
    }
    if (order.status === 'PARTIALLY_FILLED') {
      const canceled = await this.orderManager.cancel(order.clientOrderId);
      if (!canceled || canceled.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this._safePersist();
        throw new Error(`${symbol}: kısmi alışın kalan miktarı iptal edilemedi; canlı işlem kilitlendi.`);
      }
      order = canceled;
      this.state.live.safeToTrade = false;
    }
    if (order.status !== 'FILLED' && order.status !== 'CANCELED' && order.status !== 'EXPIRED') {
      // Borsa market alışa terminal olmayan bir durumla (ör. NEW) yanıt verdi. Eskiden burada sessizce çıkılıyor,
      // kilit atılmıyor ve emir sonradan dolarsa pozisyon/koruyucu stop HİÇ kurulmuyordu (coin takipsiz + korumasız).
      // Önce borsadan bir kez sorgula; hâlâ terminal değilse kilitle. Emir defterinde 'entry' olarak kaldığından
      // dolum sonradan _adoptFilledEntries ile pozisyona çevrilir ve koruyucu stop kurulur.
      let refreshed = null;
      try { refreshed = await this.orderManager.reconcile(order.clientOrderId, { markUnknownOnError: false }); } catch (_) { /* aşağıda kilitlenir */ }
      const refreshedStatus = String(refreshed?.status || '').toUpperCase();
      if (refreshed && !refreshed.uncertain && (refreshedStatus === 'FILLED' || refreshedStatus === 'CANCELED' || refreshedStatus === 'EXPIRED')) {
        order = refreshed;
      } else {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `${symbol}: alış emri terminal duruma ulaşmadı (${refreshedStatus || order.status}); dolum doğrulanana kadar canlı işlem kilitli.`;
        this._safePersist();
        throw new Error(`${symbol}: alış emri terminal duruma ulaşmadı (${refreshedStatus || order.status}); canlı işlem kilitlendi, dolum doğrulanınca pozisyon otomatik kurulacak.`);
      }
    }
    if (String(order.status).toUpperCase() === 'EXPIRED' && Number(order.executedQty || 0) > 0) this.state.live.safeToTrade = false;
    order = await this._withFeeValuation(order);
    const entryRec = this.orderManager.get?.(order.clientOrderId);
    const entryFeesVerified = !this.exchange?.capabilities?.orderTrades || !entryRec || Number(entryRec.feesVerifiedQty || 0) >= Number(entryRec.executedQty || 0) - 1e-12;
    const filledQty = Number(order.netExecutedQty ?? order.executedQty ?? 0);
    if (!(filledQty > 0)) return;
    const thirdFeeQuote = this._orderFeeQuoteValue(order);
    if (thirdFeeQuote === null) {
      this.state.live.safeToTrade = false;
      this.state.live.feeValuationWarning = { symbol, clientOrderId: order.clientOrderId, side: 'buy', at: iso(this.nowFn()), commissionByAsset: { ...(order.commissionByAsset || {}) } };
      this._safePersist();
      throw new Error(`${symbol}: üçüncü varlık komisyonunun quote karşılığı hesaplanamadı; canlı işlem kilitlendi.`);
    }
    const quoteSpent = Number(order.netQuoteQty ?? order.quoteQty ?? filledQty * price) + thirdFeeQuote;
    const avgPrice = quoteSpent > 0 ? quoteSpent / filledQty : price;
    const stopPct = Number(params.stopLossPct);
    const rawStopPrice = avgPrice * (1 - stopPct / 100);
    const stopPrice = this._roundSellStopPrice(rawStopPrice, rules.tickSize);

    // Kritik: market alış FILLED olduktan sonra HICBIR dogrulama basarisizligi gercek pozisyonu
    // yerel defterden dusurmemeli. Once pozisyon kaydedilir, sonra koruma kurulur/dogrulanir.
    const [baseAssetName, quoteAssetName] = String(symbol).toUpperCase().split('/');
    this.state.live.positions[symbol] = {
      symbol, baseAsset: baseAssetName, quoteAsset: quoteAssetName,
      quantity: filledQty, entryPrice: avgPrice, costQuote: quoteSpent,
      entryCommissionTotal: Number(order.commissionTotal || 0),
      entryCommissionByAsset: { ...(order.commissionByAsset || {}) },
      entryThirdAssetCommissionQuote: thirdFeeQuote,
      entryThirdAssetCommissionValuation: order.thirdAssetCommissionValuation || {},
      openedAt: iso(this.nowFn()), entryOrderId: order.clientOrderId, entryFeesVerified, entryQuantity: filledQty,
      stopOrderId: null, stopPrice: stopPrice > 0 ? stopPrice : null, tpOrderId: null, tpPrice: null, protectiveMode: 'single-stop', nativeTrailing: false, orderListId: null, takeProfitPct: Number(params.takeProfitPct || 0), trailingStop: Boolean(params.trailingStop), highWaterMark: avgPrice,
      reason,
      stopExecutedQty: 0, stopCommissionBase: 0, stopNetQuoteQty: 0,
      stopThirdAssetCommissionQuote: 0, stopExecutionIds: []
    };
    this._safePersist();

    const hasTrailing = Boolean(params.trailingStop);
    let stop;
    // Alim bildirimi koruyucu stop sonucuna bagli kalmasin: stop kurulursa normal mesaj, kurulamazsa
    // "stop KURULAMADI" uyarili mesaj gider (eskiden hata firlayinca alim mesaji hic gitmiyordu).
    let buyNotified = false;
    const notifyBuy = (stopOk) => {
      if (buyNotified) return;
      buyNotified = true;
      this.notify(fmt.liveBuy({
        symbol, avgPrice, quantity: filledQty, quoteSpent, stopPrice: stopOk ? stopPrice : null, stopFailed: !stopOk,
        takeProfitPct: params.takeProfitPct, trailing: hasTrailing, reason, at: this.nowFn()
      }), { key: `live-buy:${symbol}:${order.clientOrderId || order.exchangeOrderId || avgPrice}`, minIntervalMs: 60000, html: true, durable: true });
    };
    try {
      const stopRuleCheck = this._validateTriggerPrice(rules, 'sell', stopPrice, price);
      if (!stopRuleCheck.ok) { this.state.live.safeToTrade = false; this._safePersist(); throw new Error(`${symbol}: stop fiyatı Binance TR execution rule dışında veya doğrulanamadı: ${stopRuleCheck.errors.join(', ')}`); }
      if (!(stopPrice > 0)) {
        this.state.live.safeToTrade = false;
        this._safePersist();
        throw new Error(`${symbol}: borsa fiyat adımına uygun koruyucu stop fiyatı üretilemedi; POZİSYON KORUMASIZ.`);
      }
      // Koruyucu emir miktari adima ASAGI yuvarlanir (baz komisyonu dusulmus net miktar adim katı degildir).
      const protectQty = this._sellQty(filledQty, rules);
      if (!(protectQty > 0)) {
        this.state.live.safeToTrade = false;
        this._safePersist();
        throw new Error(`${symbol}: dolum miktarı borsa adımının altında; koruyucu stop kurulamadı, POZİSYON KORUMASIZ.`);
      }

      try {
        // TP artık ayrı bir satış emri değildir. takeProfitPct yalnızca dinamik
        // kâr korumanın aktive olacağı eşiği belirtir; ilk koruma stop-loss
        // olarak giriş fiyatından kurulur ve fiyat yükseldikçe yukarı taşınır.
        const trailingDelta = hasTrailing ? Math.round(Number(params.stopLossPct) * 100) : 0;
        stop = await this.orderManager.submitStop({ symbol, side: 'sell', amount: protectQty, stopPrice, limitPrice: 0, trailingDelta, meta: { role: 'protective-stop', entryClientOrderId: order.clientOrderId, trailing: trailingDelta > 0 } });
      } catch (err) {
        this.state.live.safeToTrade = false; this._safePersist(); throw err;
      }
      if (stop.status === 'UNKNOWN' || stop.uncertain || stop.status === 'REJECTED' || !['NEW','FILLED'].includes(stop.status)) {
        this.state.live.safeToTrade = false; this._safePersist();
        throw new Error(`${symbol}: koruyucu stop kurulamadı (${stop.status}); canlı işlem kilitlendi, POZİSYON KORUMASIZ olabilir.`);
      }
    } catch (err) { notifyBuy(false); throw err; }
    const trailingNative = hasTrailing && Math.round(Number(params.stopLossPct) * 100) > 0;
    this.state.live.positions[symbol].stopOrderId = stop.clientOrderId;
    this.state.live.positions[symbol].stopPrice = stopPrice;
    this.state.live.positions[symbol].protectiveMode = 'single-stop';
    this.state.live.positions[symbol].nativeTrailing = trailingNative;
    this._safePersist();

    // WebSocket FILLED bildirimi stopOrderId atamasindan once gelmis olabilir.
    // OrderManager bu bildirimi kaydeder; son durumu tekrar okuyarak kacirilan
    // fill'i burada isleriz.
    const protectiveId = this.state.live.positions[symbol]?.stopOrderId;
    const latestStop = protectiveId ? (this.orderManager.get(protectiveId) || { clientOrderId: protectiveId, status: 'NEW' }) : null;
    // Alim bildirimi, koruyucu stop hemen dolmus olsa bile once gider (sira: ALIM -> STOP-LOSS).
    // Anahtar emir kimligini icerir: ayni olay tekrar bildirilmez ama farkli alimlar asla elenmez.
    notifyBuy(true);
    if (String(latestStop.status).toUpperCase() === 'FILLED') {
      await this._handleProtectiveStopUpdate(latestStop);
      return;
    }
    this.log(`CANLI ALIM ${symbol} @ ${avgPrice} miktar ${filledQty} — ${reason}`);
    this._safePersist();
  }

  // Koruyucu emri iptal etmeye calisirken emir zaten FILLED cikarsa (iptal/dolum yarisi) market satisi GONDERILMEZ:
  // pozisyon zaten stop/TP ile kapanmistir. Dolum, protective-fill yolundan (seri kilit + executionId tekrar korumasi)
  // deftere islenir; bakiye mutabakati beklenirken canli islem kilitli kalir.
  async _settleProtectiveFilledDuringCancel(symbol, filledOrder) {
    this.state.live.safeToTrade = false;
    this.state.live.lockReason = 'Koruyucu emir iptal sırasında gerçekleşti; bakiye mutabakatı bekleniyor';
    this.lastReconcileAt = 0;
    const queued = this.stopUpdateLocks.get(symbol);
    if (queued) await queued; // _onOrderUpdate zaten kuyruga almis olabilir
    // Kuyruk islemediyse (ornegin kayit/pozisyon eslesmesi sonradan degisti) executionId korumasi cift islemeyi onler.
    const pos = this.state.live?.positions?.[symbol];
    if (pos && (pos.stopOrderId === filledOrder.clientOrderId || pos.tpOrderId === filledOrder.clientOrderId)) {
      await this._handleProtectiveStopUpdate(filledOrder);
    }
    this._safePersist();
  }

  // Ayni pozisyon icin onceki bir CIKIS emri cozulmemisse (UNKNOWN/PENDING/acik ya da dolmus ama deftere islenmemis)
  // yeni market satisi gonderilmez: eski emir aslinda dolmus olabilir ve ikinci satis fazla satis/reddedilen emir demektir.
  // Once emirler yenilenir ve dolumlar islenir; cozulemezse satis reddedilir. false: pozisyon bu sirada kapanmis.
  async _clearUnresolvedExit(symbol, position) {
    const sameSymbol = (o) => String(o.symbol || '').toUpperCase() === String(symbol).toUpperCase();
    const unresolved = () => Object.values(this.state.liveOrders || {}).find((o) => {
      if (!o || !sameSymbol(o) || !position.entryOrderId) return false;
      const status = String(o.status || '').toUpperCase();
      // Cikis emri: acik, belirsiz ya da dolmus ama deftere islenmemis.
      if (o.meta?.role === 'exit' && !o.exitBooked && o.meta?.entryOrderId === position.entryOrderId) {
        return ['PENDING', 'UNKNOWN', 'NEW', 'PARTIALLY_FILLED'].includes(status) || Number(o.executedQty || 0) > 0;
      }
      // Koruyucu emir sonucu BELIRSIZSE (ornegin iptal istegi ag hatasiyla bitti) borsada hala acik ve bakiyeyi kilitlemis
      // olabilir; durumu ogrenilmeden market satis gonderilmez.
      if (PROTECTIVE_ROLES.has(o.meta?.role) && o.meta?.entryClientOrderId === position.entryOrderId) {
        return status === 'UNKNOWN' || status === 'PENDING';
      }
      return false;
    });
    if (!unresolved()) return true;
    await this._killSwitchSettle();
    if (!this.state.live.positions?.[symbol]) return false;
    const still = unresolved();
    if (still) {
      this.state.live.safeToTrade = false;
      throw new Error(`${symbol}: önceki çıkış emri (${still.clientOrderId}, ${still.status}) çözülmeden yeni market satışı gönderilmez.`);
    }
    return true;
  }

  // Satistan once koruma baglantilarini duzeltir: pozisyona bagli olmayan koruyucu emirlerin dolumlarini isler ve
  // borsada ACIK tek koruyucu stop varsa onu baglar (aksi halde sell() onu iptal etmeden market satis gonderir ve
  // stop dolmus/kilitli bakiye yuzunden fazla satis girisimi veya reddedilen emir olur). false: pozisyon kapanmis.
  async _reconcileProtectionLinks(symbol, position) {
    await this._bookUnlinkedProtectiveFills(symbol, position);
    const pos = this.state.live.positions?.[symbol];
    if (!pos) return false;
    const stopId = pos.stopOrderId;
    const stopStatus = String((stopId ? (this.orderManager.get?.(stopId) || this.state.liveOrders?.[stopId]) : null)?.status || '').toUpperCase();
    if (!stopId || ['CANCELED', 'REJECTED', 'EXPIRED'].includes(stopStatus)) {
      const adoptable = this._findAdoptableProtectiveStop(symbol, pos);
      if (adoptable === 'ambiguous') {
        this.state.live.safeToTrade = false;
        throw new Error(`${symbol}: birden fazla açık koruyucu stop bulundu; market satışı gönderilmedi (fazla satış riski).`);
      }
      if (adoptable) {
        pos.stopOrderId = adoptable.clientOrderId;
        if (Number(adoptable.stopPrice) > 0) pos.stopPrice = Number(adoptable.stopPrice);
        this._safePersist();
      }
    }
    return true;
  }

  // Satis sirasinda ayni sembol icin koruyucu islemci yedek stop kurmaz (bkz. _handleProtectiveStopUpdate) ve satis
  // baslamadan once calismakta olan islemci beklenir: boylece iptal ile market emri arasina yeni stop girmez.
  async sell(symbol, position, price, reason, epoch, opts = {}) {
    if (epoch !== this.epoch) return;
    const guard = (this.sellsInProgress ||= new Set());
    guard.add(symbol);
    try {
      const pending = this.stopUpdateLocks.get(symbol);
      if (pending) await pending.catch(() => {});
      return await this._sellInner(symbol, position, price, reason, epoch, opts);
    } finally {
      guard.delete(symbol);
    }
  }

  async _sellInner(symbol, position, price, reason, epoch, { emergency = false } = {}) {
    if (epoch !== this.epoch) return;
    if (!(await this._clearUnresolvedExit(symbol, position))) return;
    if (!(await this._reconcileProtectionLinks(symbol, position))) return;

    // 1) ON KONTROLLER (koruyucu stop'a DOKUNMADAN): kurallar + order-book guvenligi.
    //    Eskiden stop once iptal ediliyor, kontrol sonradan basarisiz olunca pozisyon korumasiz kaliyordu.
    const sellRules = await this.getRules(symbol);
    const sellQty = this._sellQty(position.quantity, sellRules, { market: true });
    if (!(sellQty > 0)) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: pozisyon miktarı borsa adımının altında; market satışı yapılamaz.`);
    }
    const sellCheck = validateMarketOrder({ rules: sellRules, side: 'sell', amount: sellQty, price });
    if (!sellCheck.ok) {
      this.state.live.safeToTrade = false; this._safePersist();
      throw new Error(`${symbol}: satış borsa kuralları sağlanmadı: ${sellCheck.errors.join(', ')}`);
    }
    await this._checkMarketOrderSafety({ symbol, side: 'sell', baseQty: sellQty, emergency });

    // 2) Ancak simdi koruyucu stop iptal edilir (hemen ardindan market satis gonderilecek).
    if (position.stopOrderId) {
      const canceled = await this.orderManager.cancel(position.stopOrderId);
      if (canceled && String(canceled.status).toUpperCase() === 'FILLED') {
        this.log(`${symbol}: koruyucu stop iptal edilirken zaten gerçekleşmişti; market satışı gönderilmedi.`, 'warn');
        await this._settleProtectiveFilledDuringCancel(symbol, canceled);
        return;
      }
      // REJECTED (borsada hic var olmadi) ve EXPIRED (borsa kapatti) bir stop zaten "acik degil"dir: iptal edilecek bir sey
      // yoktur. Yalniz CANCELED kabul edilirse, reddedilmis bir yedek stopa bagli pozisyon her satista reddedilir ve
      // korumasiz kalir.
      if (!canceled || !['CANCELED', 'REJECTED', 'EXPIRED'].includes(String(canceled.status).toUpperCase())) {
        this.state.live.safeToTrade = false;
        this._safePersist();
        throw new Error(`${symbol}: koruyucu stop iptal edilemedi; market satışına izin verilmedi.`);
      }
      // Stop iptal edilirken kısmen dolmuş olabilir. Bu durumda yerel
      // pozisyon miktarı artık borsadaki gerçek miktarı temsil etmiyor.
      // Kalan pozisyonu tahmin ederek market satışına devam etmek oversell
      // riski doğurur. Önce mutabakat/recovery yapılmalı.
      // Yalnizca pozisyona ISLENMEMIS dolum (kumulatif dolum - islenmis miktar) varsa mutabakat gerekir; zaten islenmis
      // kismi dolum miktari pozisyondan dusulmustur ve satisi engellememeli.
      const canceledExecutedQty = Number(canceled.executedQty || 0) - Number(position.stopExecutedQty || 0);
      if (Number.isFinite(canceledExecutedQty) && canceledExecutedQty > 1e-12) {
        this.state.live.safeToTrade = false;
        this.state.live.stopCancelPartialFill = {
          symbol,
          clientOrderId: position.stopOrderId,
          executedQty: canceledExecutedQty,
          at: iso(this.nowFn())
        };
        this._safePersist();
        // Iptal yaniti kesin kumulatif dolumu verir. Yalnizca reddetmek (eski davranis) islenmemis dolumu sonsuza dek
        // islenmemis birakir ve her satis denemesi ayni hatayla biter; once dolum pozisyona islenir, SONRA bu deneme
        // reddedilir (sonraki deneme guncel miktarla satar).
        // Dolum, emir bazli "islenmis" defteriyle (stopBooked) islenir: mevcut sayaclar deftere aktarilir, bag kaldirilir ve
        // yalnizca islenmemis FARK dusulur (ham isleyici cagrisi sayaclari sifirlar ve ayni dolumu ikinci kez dusebilirdi).
        try {
          const sid = position.stopOrderId;
          position.stopBooked = { ...(position.stopBooked || {}) };
          const prev = position.stopBooked[sid] || { gross: 0, baseFee: 0, netQuote: 0, thirdFee: 0 };
          position.stopBooked[sid] = {
            gross: Math.max(Number(prev.gross || 0), Number(position.stopExecutedQty || 0)),
            baseFee: Math.max(Number(prev.baseFee || 0), Number(position.stopCommissionBase || 0)),
            netQuote: Math.max(Number(prev.netQuote || 0), Number(position.stopNetQuoteQty || 0)),
            thirdFee: Math.max(Number(prev.thirdFee || 0), Number(position.stopThirdAssetCommissionQuote || 0))
          };
          position.stopOrderId = null;
          await this._bookUnlinkedProtectiveFills(symbol, position);
        } catch (err) { this.log(`${symbol}: iptal sırasında dolan miktar işlenemedi: ${err?.message || err}`, 'error'); }
        throw new Error(`${symbol}: koruyucu stop iptal edilirken kısmen dolmuş; dolum işlendi, mutabakat sonrası satış yeniden denenecek.`);
      }
      // OCO'da bir bacagin iptali tum listeyi iptal eder; diger bacagin yerel kaydi da guncellenir.
      if (position.protectiveMode === 'oco' && position.tpOrderId && typeof this.orderManager.reconcile === 'function') {
        try { await this.orderManager.reconcile(position.tpOrderId); } catch (_) { /* reconcile sonraki turda tekrar dener */ }
      }
    }

    // Son kontrol: iptal ile market emri arasinda eszamanli bir isleyici yeni bir koruyucu stop kurmus ya da baska bir
    // koruyucu emrin dolumu islenmis olabilir. Kilitli/dolmus bakiyeye karsi market satis gonderilmez; miktar degistiyse
    // satis hazirligi (sellQty) eskimistir: hata firlatilir, sonraki deneme yeniden hesaplar.
    await this._bookUnlinkedProtectiveFills(symbol, position);
    const nowPos = this.state.live.positions?.[symbol];
    if (!nowPos) return;
    // Yukaridaki islemler (dolum isleme, iptal) sirasinda bir koruyucu emrin sonucu belirsizlesmis olabilir.
    if (!(await this._clearUnresolvedExit(symbol, nowPos))) return;
    if (this._findAdoptableProtectiveStop(symbol, nowPos)) {
      this.state.live.safeToTrade = false;
      throw new Error(`${symbol}: satış hazırlığı sırasında açık bir koruyucu stop bulundu; market satışı gönderilmedi.`);
    }
    if (this._sellQty(nowPos.quantity, sellRules, { market: true }) !== sellQty) {
      this.state.live.safeToTrade = false;
      throw new Error(`${symbol}: pozisyon miktarı satış hazırlığı sırasında değişti; satış yeniden denenecek.`);
    }

    let order = await this.orderManager.submitMarket({
      symbol, side: 'sell', amount: sellQty,
      meta: { role: 'exit', reason, entryOrderId: position.entryOrderId }
    });
    if (order.status === 'UNKNOWN' || order.uncertain) {
      this.state.live.safeToTrade = false;
      this._safePersist();
      throw new Error(`${symbol}: çıkış emri sonucu belirsiz; canlı işlem kilitlendi.`);
    }

    if (order.status === 'PARTIALLY_FILLED') {
      const canceled = await this.orderManager.cancel(order.clientOrderId);
      if (!canceled || canceled.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this._safePersist();
        throw new Error(`${symbol}: kısmi satışın kalan miktarı iptal edilemedi; canlı işlem kilitlendi.`);
      }
      order = canceled;
      this.state.live.safeToTrade = false;
    }

    if (this._feeRefreshNeeded(order)) order = await this._withFeeValuation(order);
    const grossFilled = Number(order.executedQty || 0);
    const baseFee = Number(order.commissionBase || 0);
    const positionOutflow = positionReductionOnSell(grossFilled, baseFee);
    const soldQty = Math.min(position.quantity, grossFilled);
    const outflowQty = Math.min(position.quantity, positionOutflow);

    // Market satis HIC dolmadiysa (reddedildi/iptal/expire): stop zaten iptal edilmisti, pozisyon
    // korumasiz kalmasin diye koruyucu stop yeniden kurulur. Belirsiz (UNKNOWN) sonuc yukarida kilitlendi.
    if (!(soldQty > 0)) {
      this.state.live.safeToTrade = false;
      this._safePersist();
      let rearmNote = '';
      if (position.stopOrderId || position.tpOrderId) {
        try {
          const { stop, stopPrice } = await this._placeProtectiveStop(symbol, position, position.quantity, sellRules);
          if (stop.status === 'NEW' || stop.status === 'FILLED') {
            position.stopOrderId = stop.clientOrderId;
            position.stopPrice = stopPrice;
            position.tpOrderId = null; position.tpPrice = null; position.orderListId = null;
            position.protectiveMode = 'single-stop'; position.nativeTrailing = false;
            rearmNote = ' Koruyucu stop yeniden kuruldu.';
          } else {
            rearmNote = ` Koruyucu stop yeniden KURULAMADI (${stop.status}); POZİSYON KORUMASIZ.`;
          }
        } catch (err) {
          rearmNote = ` Koruyucu stop yeniden KURULAMADI (${err.message}); POZİSYON KORUMASIZ.`;
        }
        this._safePersist();
      }
      throw new Error(`${symbol}: satış emri dolmadı (${order.status}).${rearmNote}`);
    }

    return this._bookExitFill({ symbol, position, order, soldQty, outflowQty, price, reason, emergency, sellRules });
  }

  // Gerceklesmis bir CIKIS dolumunu (market satis) pozisyona ve deftere isler. sell() ve gec/belirsiz kalip sonradan
  // dolan cikislarin sahiplenilmesi (_adoptFilledExits) ayni muhasebeyi kullanir; ayni emir iki kez islenmez.
  async _bookExitFill({ symbol, position, order, soldQty, outflowQty, price, reason, emergency = false, sellRules }) {
    if (order?.clientOrderId && this.orderManager.get?.(order.clientOrderId)?.exitBooked) return;
    order = await this._withFeeValuation(order);
    const thirdFeeQuote = this._orderFeeQuoteValue(order);
    if (thirdFeeQuote === null) {
      this.state.live.safeToTrade = false;
      this.state.live.feeValuationWarning = { symbol, clientOrderId: order.clientOrderId, side: 'sell', at: iso(this.nowFn()), commissionByAsset: { ...(order.commissionByAsset || {}) } };
      this._safePersist();
      throw new Error(`${symbol}: satış için üçüncü varlık komisyonunun quote karşılığı hesaplanamadı; canlı işlem kilitlendi.`);
    }
    const proceeds = Math.max(0, Number(order.netQuoteQty ?? order.quoteQty ?? soldQty * price) - thirdFeeQuote);

    // Adim yuvarlamasindan kalan artik (< 1 adim) satilamaz: pozisyon kapanmis sayilir, artik
    // "dust" defterine yazilir (mutabakat bunu bekler) ve maliyetinin tamami gerceklesen zarara girer.
    const rawStep = Number(sellRules.marketStepSize || sellRules.stepSize || 0);
    const leftover = Math.max(0, position.quantity - outflowQty);
    const dustOnly = String(order.status).toUpperCase() === 'FILLED' && leftover > 1e-12 && rawStep > 0 && leftover < rawStep - 1e-12;
    const pnlResult = realizedPnl(position, dustOnly ? position.quantity : outflowQty, proceeds);
    const fullClose = dustOnly || outflowQty + 1e-12 >= position.quantity;
    const remaining = dustOnly ? 0 : Math.max(0, position.quantity - outflowQty);
    if (dustOnly) this._addDust(symbol, leftover);

    this._recordLiveTrade(symbol, position, order, soldQty, pnlResult, reason);
    // "Islendi" bayragi YALNIZCA bellekte isaretlenir; pozisyon degisikligiyle TEK kayitta diske yazilir. Ayri bir kayit
    // (bayrak diskte, pozisyon henuz degismemis) cokme/disk arizasinda "islendi" der ama pozisyon acik kalir: hayalet
    // pozisyon ve kalici kilit.
    const bookedRec = order?.clientOrderId ? this.state.liveOrders?.[order.clientOrderId] : null;
    if (bookedRec) { bookedRec.exitBooked = true; bookedRec.exitBookedAt = iso(this.nowFn()); }

    // Hem tam hem KISMI satis bildirilir (eskiden kismi satis sessizdi). Anahtar emir kimligini icerir:
    // ayni olay tekrarlanmaz, farkli satislar asla elenmez.
    const sellFilledFully = fullClose && String(order.status).toUpperCase() === 'FILLED';
    this.notify(fmt.liveSell({
      symbol, kind: sellFilledFully ? 'SATIM' : 'KISMİ SATIM',
      entryPrice: position.entryPrice,
      exitPrice: soldQty > 0 ? pnlResult.proceeds / soldQty : price,
      quantity: soldQty, pnl: pnlResult.pnl,
      pnlPct: Number(pnlResult.costBasis) > 0 ? (pnlResult.pnl / Number(pnlResult.costBasis)) * 100 : null,
      reason, openedAt: position.openedAt, closedAtMs: this.nowFn(),
      remainingQty: sellFilledFully ? 0 : remaining, emergency
    }), { key: `live-sell:${symbol}:${order.clientOrderId || order.exchangeOrderId || soldQty}`, minIntervalMs: 60000, html: true, priority: emergency ? 'critical' : 'normal', durable: true });

    if (!fullClose || String(order.status).toUpperCase() !== 'FILLED') {
      this.state.live.positions[symbol].quantity = remaining;
      // Cost basis, kalan coin ile orantılı azaltılır; böylece sonraki satışın
      // gerçekleşen P/L hesabı çift sayım yapmaz.
      this.state.live.positions[symbol].costQuote = Math.max(0, Number(position.costQuote || 0) - pnlResult.costBasis);
      this.state.live.positions[symbol].stopOrderId = null;
      this.state.live.safeToTrade = false;

      if (remaining > 0) {
        try {
          const { stop, stopPrice } = await this._placeProtectiveStop(symbol, this.state.live.positions[symbol], remaining, sellRules);
          if (stop.status === 'NEW' || stop.status === 'FILLED') {
            this.state.live.positions[symbol].stopOrderId = stop.clientOrderId;
            this.state.live.positions[symbol].stopPrice = stopPrice;
          } else {
            this.log(`${symbol}: kısmi satış sonrası kalan pozisyon için koruyucu stop kurulamadı (${stop.status}).`, 'error');
          }
        } catch (err) {
          this.log(`${symbol}: kısmi satış sonrası koruyucu stop kurulamadı: ${err.message}`, 'error');
        }
      }
      this._safePersist();
      return;
    }

    delete this.state.live.positions[symbol];
    this.log(`CANLI SATIM ${symbol} @ ${price} — ${reason} — gerçekleşen K/Z: ${pnlResult.pnl.toFixed(4)}`, pnlResult.pnl >= 0 ? 'info' : 'warn');
    this._safePersist();
  }

  _recordLiveTrade(symbol, position, order, soldQty, pnlResult, reason) {
    this.ensureState();
    const live = this.state.live;
    const pnl = Number(pnlResult.pnl || 0);
    const quote = String(position?.quoteAsset || String(symbol).toUpperCase().split('/')[1] || '').toUpperCase();
    live.realizedPnl += pnl;
    live.dayRealizedPnl += pnl;
    if (quote) live.dayRealizedPnlByQuote[quote] = Number(live.dayRealizedPnlByQuote[quote] || 0) + pnl;
    live.stats.trades += 1;
    live.stats.realizedPnl += pnl;
    if (pnl > 0) {
      live.stats.wins += 1;
      live.stats.grossWin += pnl;
    } else {
      live.stats.grossLoss += -pnl;
    }
    live.trades.unshift({
      symbol,
      entryPrice: Number(position.entryPrice || 0),
      exitPrice: soldQty > 0 ? Number(pnlResult.proceeds / soldQty) : 0,
      quantity: soldQty,
      proceedsQuote: Number(pnlResult.proceeds || 0),
      costBasisQuote: Number(pnlResult.costBasis || 0),
      pnl,
      pnlPct: Number(pnlResult.costBasis) > 0 ? pnl / Number(pnlResult.costBasis) * 100 : null,
      commissionTotal: Number(order.commissionTotal || 0),
      commissionByAsset: { ...(order.commissionByAsset || {}) },
      thirdAssetCommissionQuote: Number(order.thirdAssetCommissionQuote || 0),
      thirdAssetCommissionValuation: order.thirdAssetCommissionValuation || {},
      reason,
      openedAt: position.openedAt,
      closedAt: iso(this.nowFn()),
      orderId: order.exchangeOrderId || null,
      clientOrderId: order.clientOrderId || null
    });
    live.trades = live.trades.slice(0, 300);
  }

  getRiskDayKey(ms = this.nowFn()) {
    const tz = this.state.settings.riskDayTimezone || 'Europe/Istanbul';
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
    catch { return new Date(ms).toISOString().slice(0, 10); }
  }

  // Kill switch sirasinda bekleyen dolumlari deftere isler (motor durunca bunu yapan dongu kalmaz).
  async _killSwitchSettle() {
    try { await this.orderManager.refreshPending(); } catch (_) { /* ag hatasi: bir sonraki denemede */ }
    try { await Promise.all([...this.stopUpdateLocks.values()]); } catch (_) {}
    try { await this._adoptFilledExits(); } catch (_) {}
    try { await Promise.all([...this.stopUpdateLocks.values()]); } catch (_) {}
  }

  async _checkRiskGate() {
    this.ensureState();
    const live = this.state.live;
    const riskErrors = this._validateRiskSettings();
    if (riskErrors.length) {
      this.state.live.safeToTrade = false;
      this.state.killSwitch = { t: iso(this.nowFn()), reason: `geçersiz canlı risk ayarı: ${riskErrors.join(', ')}` };
      this._safePersist();
      this.notify(fmt.liveKillSwitch({ kind: 'config', reason: this.state.killSwitch.reason, symbols: this._openSymbols(), at: this.nowFn() }), { key: 'live-killswitch', minIntervalMs: 60000, priority: 'critical', html: true });
      await this.stop('Geçersiz canlı risk ayarı.', { notify: false });
      return;
    }
    const equities = this.computeEquityByQuote();
    const primaryQuote = String(this.state.settings.quoteAsset || (this.exchange.quoteAssets || ['USDT'])[0]).toUpperCase();
    if (!(Number(live.startingEquityByQuote[primaryQuote]) > 0) && Number(live.startingEquity) > 0) live.startingEquityByQuote[primaryQuote] = Number(live.startingEquity);
    if (!(Number(live.dayStartEquityByQuote[primaryQuote]) > 0) && Number(live.dayStartEquity) > 0) live.dayStartEquityByQuote[primaryQuote] = Number(live.dayStartEquity);
    if (!(Number(live.dayRealizedPnlByQuote[primaryQuote]) || 0) && Number(live.dayRealizedPnl)) live.dayRealizedPnlByQuote[primaryQuote] = Number(live.dayRealizedPnl);
    const validQuotes = Object.entries(equities).filter(([, v]) => Number.isFinite(v) && v >= 0);
    if (!validQuotes.length) return;
    const today = this.getRiskDayKey();
    if (live.dayKey !== today) {
      live.dayKey = today;
      live.dayStartEquityByQuote = { ...equities };
      live.dayRealizedPnlByQuote = {};
      // Legacy scalar fields remain for old UI/API consumers and use the primary quote only.
      live.dayStartEquity = Number(equities[primaryQuote] || 0);
      live.dayRealizedPnl = 0;
    }
    for (const [quote, equity] of validQuotes) {
      if (!(Number(live.startingEquityByQuote[quote]) > 0)) live.startingEquityByQuote[quote] = equity;
      if (!(Number(live.dayStartEquityByQuote[quote]) > 0)) live.dayStartEquityByQuote[quote] = equity;
    }
    live.startingEquity = Number(live.startingEquityByQuote[primaryQuote] || live.startingEquity || equities[primaryQuote] || 0);
    const totalLimit = Number(this.state.settings.killSwitchLossPct || 0);
    const dayLimit = Number(this.state.settings.dailyLossLimitPct || 0);
    let reason = null;
    let hit = null;
    for (const [quote, equity] of validQuotes) {
      const start = Number(live.startingEquityByQuote[quote] || equity);
      const dayStart = Number(live.dayStartEquityByQuote[quote] || equity);
      const totalLossPct = start > 0 ? ((equity / start) - 1) * 100 : 0;
      const dayLossPct = dayStart > 0 ? ((equity / dayStart) - 1) * 100 : 0;
      const dayRealizedPct = dayStart > 0 ? (Number(live.dayRealizedPnlByQuote[quote] || 0) / dayStart) * 100 : 0;
      if (totalLimit > 0 && totalLossPct <= -totalLimit) { reason = `canlı ${quote} toplam zarar %${Math.abs(totalLossPct).toFixed(2)} (limit %${totalLimit})`; hit = { kind: 'total', quote, equity, start, dayStart }; break; }
      if (dayLimit > 0 && (dayLossPct <= -dayLimit || dayRealizedPct <= -dayLimit)) { reason = `canlı ${quote} günlük zarar limiti aşıldı`; hit = { kind: 'daily', quote, equity, start, dayStart }; break; }
    }
    if (!reason) return;

    this.state.live.safeToTrade = false;
    this.state.killSwitch = { t: iso(this.nowFn()), reason };
    this.log(`KILL SWITCH: ${reason}.`, 'error');
    // Paper'daki gibi canli kill switch / gunluk limit de Telegram'a duser (eskiden yalnizca log'dayidi).
    const toClose = Object.keys(live.positions || {});
    this.notify(fmt.liveKillSwitch({
      kind: hit.kind, reason, equity: hit.equity, startEquity: hit.start, dayStartEquity: hit.dayStart,
      quote: hit.quote, symbols: toClose, at: this.nowFn()
    }), { key: 'live-killswitch', minIntervalMs: 60000, priority: 'critical', html: true });
    const failedBySymbol = new Map();
    const emergencyClose = async (symbol, position) => {
      try {
        await this.sell(symbol, position, live.lastPrices[symbol] || position.entryPrice, `Risk limiti: ${reason}`, this.epoch, { emergency: true });
        failedBySymbol.delete(symbol);
      } catch (err) { failedBySymbol.set(symbol, err.message); this.log(`${symbol}: risk nedeniyle kapatma başarısız: ${err.message}`, 'error'); }
    };
    { // Always attempt emergency closes before stopping; leaving positions open would remove bot-side protection.
      for (const [symbol, position] of Object.entries({ ...live.positions })) await emergencyClose(symbol, position);
    }
    // Kismi/basarisiz kapanislar: motor DURDURULMADAN once sinirli sayida yeniden dene. Motor durunca hicbir dongu
    // korumayi yeniden kurmaz; kalan miktar (kismi EXPIRED dolum, ag hatasi) acik stop olmadan kalir.
    const retries = Number(this.killRetryAttempts ?? 3);
    for (let attempt = 0; attempt < retries; attempt++) {
      await this._killSwitchSettle();
      const remaining = Object.entries({ ...live.positions });
      if (!remaining.length) break;
      const delay = Number(this.killRetryDelayMs ?? 1500);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      for (const [symbol, position] of remaining) await emergencyClose(symbol, position);
    }
    await this._killSwitchSettle();
    try { await this._ensurePositionProtection(); } catch (err) { this.log(`kill switch sonrası koruma kurulamadı: ${err.message}`, 'error'); }
    const failed = [...failedBySymbol.entries()].filter(([symbol]) => live.positions?.[symbol]).map(([symbol, error]) => ({ symbol, error }));
    if (toClose.length) {
      const remainingSyms = Object.keys(live.positions || {});
      this.notify(fmt.liveKillSwitchResult({
        closed: toClose.filter((x) => !remainingSyms.includes(x)), remaining: remainingSyms, failed, at: this.nowFn()
      }), { key: 'live-killswitch-result', minIntervalMs: 60000, priority: 'critical', html: true });
    }
    await this.stop(`Risk limiti: ${reason}`, { notify: false });
  }

  computeEquityByQuote() {
    const balances = this.state.live.lastBalance || {};
    const out = {};
    const quoteList = (this.exchange.quoteAssets || []).map((x) => String(x).toUpperCase());
    for (const quote of quoteList) {
      const cash = Number(balances?.[quote]?.total || 0);
      if (!Number.isFinite(cash) || cash < 0) return {};
      out[quote] = cash;
    }
    const baseQuotes = {};
    for (const symbol of Object.keys(this.state.pairs || {})) {
      const [base, quote] = String(symbol).toUpperCase().split('/');
      if (base && quote) (baseQuotes[base] ||= new Set()).add(quote);
    }
    for (const [asset, quoteSet] of Object.entries(baseQuotes)) {
      // If a base asset is traded against exactly one quote, the exchange's
      // actual balance can be valued safely in that quote. If it is traded
      // against multiple quotes, allocation is ambiguous; use local position
      // quantities instead and let reconciliation lock trading on mismatches.
      if (quoteSet.size === 1) {
        const quote = [...quoteSet][0];
        const total = Number(balances?.[asset]?.total || 0);
        const price = Number(this.state.live.lastPrices?.[`${asset}/${quote}`] || 0);
        if (total > 0 && price > 0) out[quote] = (out[quote] || 0) + total * price;
      }
    }
    for (const [symbol, position] of Object.entries(this.state.live?.positions || {})) {
      const quote = String(position?.quoteAsset || String(symbol).toUpperCase().split('/')[1] || '').toUpperCase();
      const base = String(position?.baseAsset || String(symbol).toUpperCase().split('/')[0] || '').toUpperCase();
      const qset = baseQuotes[base];
      if (qset && qset.size === 1) continue; // already valued from actual balance
      const qty = Number(position?.quantity || 0);
      const price = Number(this.state.live.lastPrices?.[symbol] || position?.entryPrice || 0);
      if (!quote || !(qty >= 0) || !(price > 0)) continue;
      out[quote] = (out[quote] || 0) + qty * price;
    }
    return out;
  }

  computeEquity(requestedQuote = null) {
    const q = String(requestedQuote || (this.exchange.quoteAssets || ['USDT'])[0]).toUpperCase();
    const byQuote = this.computeEquityByQuote();
    return Number.isFinite(Number(byQuote[q])) ? Number(byQuote[q]) : NaN;
  }
}

module.exports = LiveEngine;
