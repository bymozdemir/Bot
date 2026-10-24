// src/exchanges/binancetr.js
// Binance TR REST adaptoru.
//
// Binance TR, Binance.com ile aynı isimli bazı kavramları kullansa da REST
// sözleşmesi birebir aynı değildir. Bu dosya bu nedenle binance.js'i miras
// almak yerine Binance TR'nin resmi /open/v1 API'sine göre ayrı uygulanır.

const crypto = require('crypto');
const ExchangeAdapter = require('./base');
const { validateOrderArgs, validatePositivePrice, guardCreate } = require('./orderGuards');
const { fetchWithRetry } = require('../util/retry');
const { plainDecimal } = require('../execution');

const BINANCE_TR_BASE_URL = 'https://www.binance.tr';
const BINANCE_TR_MARKET_BASE_URL = 'https://api.binance.me';

const STATUS = {
  0: 'NEW',
  1: 'PARTIALLY_FILLED',
  2: 'FILLED',
  3: 'CANCELED',
  4: 'CANCELED',
  5: 'REJECTED',
  6: 'EXPIRED',
  '-2': 'NEW'
};

const SIDE = { buy: 0, sell: 1 };
const ORDER_TYPE = {
  LIMIT: 1,
  MARKET: 2,
  STOP_LOSS: 3,
  STOP_LOSS_LIMIT: 4,
  TAKE_PROFIT: 5,
  TAKE_PROFIT_LIMIT: 6,
  LIMIT_MAKER: 7
};

class BinanceTrAdapter extends ExchangeAdapter {
  constructor(opts = {}) {
    super(opts);
    this.id = 'binancetr';
    this.name = 'Binance TR';
    this.quoteAssets = ['TRY'];
    // REST canlı işlemler destekleniyor. User Data Stream ayrı bir entegrasyon
    // olarak tutuluyor; REST mutabakatı çalışmadan WS canlı kapısı açılmıyor.
    this.capabilities = {
      clientOrderId: true,
      orderQuery: true,
      balanceQuery: true,
      openOrdersQuery: true,
      userDataStream: false,
      oco: true,
      nativeTrailingOco: false,
      marketOrderBook: true,
      protectiveStopImplemented: true,
      verifiesResponseSymbol: true,
      liveTradingVerified: false
    };
    this.baseUrl = String(opts.baseUrl || BINANCE_TR_BASE_URL).replace(/\/+$/, '');
    this.marketBaseUrl = String(opts.marketBaseUrl || BINANCE_TR_MARKET_BASE_URL).replace(/\/+$/, '');
    this.trackedSymbols = new Set();
    this._timeOffsetMs = 0;
    this._timeSyncedAt = 0;
  }

  normalizeSymbol(symbol) {
    const s = String(symbol || '').toUpperCase().replace(/\s+/g, '');
    if (!s) throw new Error('Sembol boş olamaz.');
    if (s.includes('/')) {
      const [base, quote] = s.split('/');
      if (!base || !quote) throw new Error(`Geçersiz Binance TR sembolü: ${symbol}`);
      return `${base}_${quote}`;
    }
    // Zaten BTC_TRY biçimindeyse koru.
    if (s.includes('_')) return s;
    if (s.endsWith('TRY')) return `${s.slice(0, -3)}_TRY`;
    return s;
  }

  _marketSymbol(symbol) {
    return this.normalizeSymbol(symbol).replace('_', '');
  }

  _localSymbol(raw) {
    const s = String(raw || '').toUpperCase();
    if (s.includes('_')) return s.replace('_', '/');
    if (s.endsWith('TRY')) return `${s.slice(0, -3)}/TRY`;
    if (s.endsWith('USDT')) return `${s.slice(0, -4)}/USDT`;
    return s;
  }

  async _request(url, opts = {}, { signed = false, allowRetry = true } = {}) {
    const res = await fetchWithRetry(url, opts, { retries: allowRetry ? 2 : 0, timeoutMs: 10000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${this.name} HTTP ${res.status}: ${data.msg || data.message || JSON.stringify(data)}`);
      err.httpStatus = res.status;
      err.exchange = this.id;
      if (signed && res.status >= 500) err.unknownOutcome = true;
      throw err;
    }
    if (data && data.code !== undefined && Number(data.code) !== 0) {
      const err = new Error(`${this.name} API ${data.code}: ${data.msg || data.message || 'Bilinmeyen API hatası'}`);
      err.apiCode = data.code;
      err.exchange = this.id;
      throw err;
    }
    return data;
  }

  async _publicGet(pathname, params = {}, market = false) {
    const qs = new URLSearchParams(params).toString();
    const base = market ? this.marketBaseUrl : this.baseUrl;
    const url = `${base}${pathname}${qs ? '?' + qs : ''}`;
    const response = await this._request(url);
    return response?.data;
  }

  _sign(params) {
    if (!this.apiSecret) throw new Error('Binance TR API secret tanımlı değil.');
    const qs = new URLSearchParams(params).toString();
    return `${qs}&signature=${crypto.createHmac('sha256', this.apiSecret).update(qs, 'utf8').digest('hex')}`;
  }

  async _signedRequest(method, pathname, params = {}, { allowRetry = false } = {}) {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Binance TR canlı işlemleri için API anahtarı ve secret gerekli.');
    }
    await this._ensureTimeSync();
    const fullParams = { ...params, timestamp: Date.now() + (this._timeOffsetMs || 0), recvWindow: 5000 };
    const signed = this._sign(fullParams);
    const url = `${this.baseUrl}${pathname}?${signed}`;
    try {
      return await this._request(url, {
        method,
        headers: { 'X-MBX-APIKEY': this.apiKey }
      }, { signed: true, allowRetry });
    } catch (err) {
      if (String(method).toUpperCase() === 'POST' || String(method).toUpperCase() === 'DELETE') {
        // Transport failure has no definitive exchange-side outcome.
        // Reconciliation must decide; never turn it into a safe-to-retry rejection.
        err.unknownOutcome = err.unknownOutcome || !err.httpStatus;
      }
      throw err;
    }
  }

  _normalizeOrder(raw = {}, fallback = {}) {
    const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
    const numericStatus = data.status;
    const side = data.side === 0 || data.side === '0' ? 'buy'
      : data.side === 1 || data.side === '1' ? 'sell'
      : String(data.side || fallback.side || '').toLowerCase();
    return {
      orderId: data.orderId ?? fallback.orderId ?? null,
      orderListId: data.orderListId ?? fallback.orderListId ?? null,
      clientOrderId: data.clientId ?? data.clientOrderId ?? fallback.clientOrderId ?? null,
      symbol: this._localSymbol(data.symbol || fallback.symbol),
      side,
      status: STATUS[String(numericStatus)] || String(data.status || fallback.status || 'NEW').toUpperCase(),
      executedQty: Number(data.executedQty || 0),
      origQty: Number(data.origQty || fallback.origQty || fallback.amount || 0),
      cummulativeQuoteQty: Number(data.executedQuoteQty ?? data.cummulativeQuoteQty ?? data.origQuoteQty ?? 0),
      price: Number(data.price || 0),
      stopPrice: Number(data.stopPrice || 0),
      createTime: data.createTime
    };
  }

  async fetchServerTime() {
    const response = await this._request(`${this.baseUrl}/open/v1/common/time`);
    return Number(response?.timestamp || 0);
  }

  async _ensureTimeSync(force = false) {
    if (!force && this._timeSyncedAt && Date.now() - this._timeSyncedAt < 10 * 60 * 1000) return;
    try {
      const t0 = Date.now();
      const server = await this.fetchServerTime();
      const t1 = Date.now();
      if (Number.isFinite(server) && server > 1e12) this._timeOffsetMs = Math.round(server - (t0 + t1) / 2);
    } catch (_) {}
    this._timeSyncedAt = Date.now();
  }

  async fetchCandles(symbol, timeframe = '1h', limit = 300) {
    const raw = await this._publicGet('/api/v1/klines', {
      symbol: this._marketSymbol(symbol), interval: timeframe, limit: Math.min(1000, Math.max(1, Number(limit) || 300))
    }, true);
    if (!Array.isArray(raw)) throw new Error('Binance TR kline cevabı beklenen dizi biçiminde değil.');
    return raw.map((k) => ({
      t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5])
    }));
  }

  async fetchOrderBook(symbol, limit = 20) {
    const marketSymbol = this._marketSymbol(symbol);
    const qs = new URLSearchParams({ symbol: marketSymbol, limit: String(Math.min(100, Math.max(5, Number(limit) || 20))) }).toString();
    const url = `${this.marketBaseUrl}/api/v3/depth?${qs}`;
    const data = await this._request(url, {}, { allowRetry: true });
    const book = data?.data || data;
    return { bids: book?.bids || [], asks: book?.asks || [], timestamp: Date.now() };
  }

  async fetchTicker(symbol) {
    const raw = await this._publicGet('/api/v3/ticker/price', { symbol: this._marketSymbol(symbol) }, true);
    return { symbol, price: Number(raw?.price) };
  }

  async fetchAllTickers24h() {
    const raw = await this._publicGet('/api/v3/ticker/24hr', {}, true);
    if (!Array.isArray(raw)) throw new Error('Binance TR 24s ticker cevabı beklenen dizi biçiminde değil.');
    return raw
      .filter((t) => String(t.symbol || '').endsWith('TRY'))
      .map((t) => ({
        symbol: this._localSymbol(t.symbol),
        lastPrice: Number(t.lastPrice),
        changePct: Number(t.priceChangePercent),
        quoteVolume: Number(t.quoteVolume),
        highPrice: Number(t.highPrice),
        lowPrice: Number(t.lowPrice)
      }));
  }

  async fetchSymbolRules(symbol) {
    const wanted = this.normalizeSymbol(symbol);
    const data = await this._publicGet('/open/v1/common/symbols');
    const list = Array.isArray(data?.list) ? data.list : [];
    const info = list.find((x) => String(x.symbol || '').toUpperCase() === wanted);
    if (!info) throw new Error(`Binance TR sembolü bulunamadı: ${symbol}`);
    if (info.status && !['TRADING', '1', 'ENABLED'].includes(String(info.status).toUpperCase())) throw new Error(`Binance TR sembolü işlem için açık değil (${info.status}): ${symbol}`);
    this.trackedSymbols.add(wanted);
    const filters = Array.isArray(info.filters) ? info.filters : [];
    const lot = filters.find((f) => f.filterType === 'LOT_SIZE') || {};
    const marketLot = filters.find((f) => f.filterType === 'MARKET_LOT_SIZE') || {};
    const price = filters.find((f) => f.filterType === 'PRICE_FILTER') || {};
    const notional = filters.find((f) => f.filterType === 'NOTIONAL') || filters.find((f) => f.filterType === 'MIN_NOTIONAL') || {};
    const hasNotionalFilter = Boolean(filters.find((f) => f.filterType === 'NOTIONAL'));
    const minNotionalAppliesToMarket = hasNotionalFilter ? notional.applyMinToMarket !== false : notional.applyToMarket !== false;
    const maxNotionalAppliesToMarket = hasNotionalFilter ? notional.applyMaxToMarket !== false : true;
    const orderTypes = Array.isArray(info.orderTypes) ? info.orderTypes : [];
    const normalizedOrderTypes = orderTypes.map((x) => String(x).toUpperCase().replace(/[_\s-]/g, ''));
    // Binance TR documents numeric order type 3 as STOP_LOSS. Unknown/empty
    // orderTypes are left unspecified; a known list without a stop type fails closed.
    const supportsProtectiveStop = orderTypes.length ? normalizedOrderTypes.some((x) => ['3', 'STOPLOSS'].includes(x)) : undefined;
    let executionRules = {};
    let referencePrice = 0;
    try {
      const er = await this._publicGet('/api/v3/executionRules', { symbol: this._marketSymbol(symbol) }, true);
      const rule = er?.symbolRules?.[0]?.rules?.find((r) => r.ruleType === 'PRICE_RANGE');
      if (rule) executionRules = rule;
      const rp = await this._publicGet('/api/v3/referencePrice', { symbol: this._marketSymbol(symbol) }, true);
      referencePrice = Number(rp?.referencePrice || rp?.price || rp?.data?.referencePrice || 0);
    } catch (_) {}
    return {
      symbol, stepSize: Number(lot.stepSize || 0), minQty: Number(lot.minQty || 0), maxQty: Number(lot.maxQty || 0),
      marketStepSize: Number(marketLot.stepSize || 0), marketMinQty: Number(marketLot.minQty || 0), marketMaxQty: Number(marketLot.maxQty || 0),
      tickSize: Number(price.tickSize || 0), minPrice: Number(price.minPrice || 0), maxPrice: Number(price.maxPrice || 0),
      minNotional: Number(notional.minNotional || 0), maxNotional: Number(notional.maxNotional || 0),
      applyToMarket: minNotionalAppliesToMarket, minNotionalAppliesToMarket, maxNotionalAppliesToMarket,
      priceRange: executionRules, referencePrice, baseAsset: info.baseAsset, quoteAsset: info.quoteAsset,
      orderTypes, supportsProtectiveStop
    };
  }

  async fetchOpenOrders(symbols = []) {
    const list = Array.isArray(symbols) && symbols.length ? symbols : [...this.trackedSymbols];
    if (!list.length) throw new Error('Binance TR açık emir sorgusu için en az bir sembol gerekli.');
    const all = [];
    for (const symbol of list) {
      const normalized = this.normalizeSymbol(symbol);
      const response = await this._signedRequest('GET', '/open/v1/orders', { symbol: normalized, type: 1, limit: 1000 }, { allowRetry: true });
      if (!response?.data || !Array.isArray(response.data.list)) throw new Error('Binance TR açık emir cevabı şema doğrulamasını geçemedi.');
      const rows = response.data.list;
      all.push(...rows.map((o) => this._normalizeOrder(o)));
    }
    return all;
  }

  async fetchBalance() {
    const response = await this._signedRequest('GET', '/open/v1/account/spot', {}, { allowRetry: true });
    const balances = {};
    for (const b of response?.data?.accountAssets || []) {
      const free = Number(b.free || 0), locked = Number(b.locked || 0);
      if (free > 0 || locked > 0) balances[b.asset] = { free, locked };
    }
    return balances;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const a = validateOrderArgs('Binance TR', { side, amount, clientOrderId });
    const params = {
      symbol: this.normalizeSymbol(symbol), side: SIDE[a.side], type: ORDER_TYPE.MARKET,
      quantity: plainDecimal(a.amount)
    };
    if (params.side === undefined) throw new Error(`Geçersiz Binance TR emir yönü: ${side}`);
    params.clientId = String(clientOrderId);
    return guardCreate('Binance TR', async () => {
      const response = await this._signedRequest('POST', '/open/v1/orders', params);
      return this._normalizeOrder(response?.data || response, { symbol, side: a.side, amount: a.amount, clientOrderId, status: 'NEW' });
    }, { clientOrderId, side: a.side });
  }

  async createOcoOrder(...args) {
    return guardCreate('Binance TR', () => this._createOcoOrderRaw(...args), { requireOrderId: false });
  }

  async _createOcoOrderRaw(symbol, side, amount, { takeProfitPrice, stopPrice, stopLimitPrice = 0, listClientOrderId, takeProfitClientOrderId, stopClientOrderId } = {}) {
    if (String(side).toLowerCase() !== 'sell') throw new Error('Binance TR OCO adaptörü şimdilik yalnızca sell destekliyor.');
    if (!(Number(amount) > 0) || !(Number(takeProfitPrice) > 0) || !(Number(stopPrice) > 0)) {
      throw new Error('Binance TR OCO için miktar, TP ve stop fiyatı zorunludur.');
    }
    // Binance TR'nin resmi OCO sözleşmesi stopLimitPrice alanını zorunlu tutuyor.
    // Burada gizli bir fiyat tamponu icat etmiyoruz: caller bir stop-limit fiyatı
    // vermediyse trigger fiyatının kendisini kullanıyoruz. Gerçek hesapta bu,
    // stop-limit'in gap durumunda dolmama riskini korur; dolayısıyla trailing
    // ile karıştırılmamalı ve native trailing olarak işaretlenmemelidir.
    const effectiveStopLimitPrice = Number(stopLimitPrice) > 0 ? Number(stopLimitPrice) : Number(stopPrice);
    const params = {
      symbol: this.normalizeSymbol(symbol),
      side: SIDE.sell,
      quantity: plainDecimal(amount),
      price: plainDecimal(takeProfitPrice),
      stopPrice: plainDecimal(stopPrice),
      stopLimitPrice: plainDecimal(effectiveStopLimitPrice)
    };
    if (listClientOrderId) params.listClientId = listClientOrderId;
    if (takeProfitClientOrderId) params.limitClientId = takeProfitClientOrderId;
    if (stopClientOrderId) params.stopClientId = stopClientOrderId;

    const created = await this._signedRequest('POST', '/open/v1/orders/oco', params, { allowRetry: false });
    const data = created?.data && typeof created.data === 'object' ? created.data : created;
    const result = {
      ...created,
      orderListId: data?.orderListId ?? null,
      listClientOrderId: data?.listClientId ?? listClientOrderId ?? null,
      orders: [],
      orderReports: []
    };

    // Dokümante edilen OCO create cevabı yalnızca orderId/createTime gösterebildiği
    // için iki leg'i clientId ile tekrar sorguluyoruz. Böylece yerel OrderManager
    // her iki koruyucu emri ayrı ayrı reconcile edebilir.
    for (const cid of [takeProfitClientOrderId, stopClientOrderId]) {
      if (!cid) continue;
      try {
        const leg = await this.getOrder(symbol, null, cid);
        if (leg?.orderListId != null && result.orderListId == null) result.orderListId = leg.orderListId;
        if (leg?.clientOrderId === cid || leg?.orderId != null) result.orders.push(leg);
      } catch (err) {
        // OCO creation succeeded but a follow-up detail call failed. The OCO itself
        // must not be recreated; caller treats the returned leg uncertainty as a
        // reconciliation condition rather than sending duplicate protection.
        err.unknownOutcome = true;
        throw err;
      }
    }
    return result;
  }

  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (String(side).toLowerCase() !== 'sell') throw new Error('Binance TR koruyucu stop şimdilik yalnızca SELL destekliyor.');
    const a = validateOrderArgs('Binance TR', { side, amount, clientOrderId });
    const params = {
      symbol: this.normalizeSymbol(symbol), side: SIDE.sell, type: ORDER_TYPE.STOP_LOSS,
      quantity: plainDecimal(a.amount), stopPrice: plainDecimal(validatePositivePrice('Binance TR', 'stop fiyatı', stopPrice))
    };
    params.clientId = String(clientOrderId);
    return guardCreate('Binance TR', async () => {
      const response = await this._signedRequest('POST', '/open/v1/orders', params);
      return this._normalizeOrder(response?.data || response, { symbol, side, amount: a.amount, clientOrderId, status: 'NEW' });
    }, { clientOrderId, side: 'sell' });
  }

  async createTakeProfitOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (String(side).toLowerCase() !== 'sell') throw new Error('Binance TR take-profit yalnızca SELL destekliyor.');
    const a = validateOrderArgs('Binance TR', { side, amount, clientOrderId });
    const params = { symbol: this.normalizeSymbol(symbol), side: SIDE.sell, type: ORDER_TYPE.TAKE_PROFIT, quantity: plainDecimal(a.amount), stopPrice: plainDecimal(validatePositivePrice('Binance TR', 'take-profit fiyatı', stopPrice)) };
    params.clientId = String(clientOrderId);
    return guardCreate('Binance TR', async () => {
      const response = await this._signedRequest('POST', '/open/v1/orders', params);
      return this._normalizeOrder(response?.data || response, { symbol, side, amount: a.amount, clientOrderId, status: 'NEW' });
    }, { clientOrderId, side: 'sell' });
  }

  async getOrder(symbol, orderId, clientOrderId) {
    const params = { symbol: this.normalizeSymbol(symbol) };
    if (orderId !== undefined && orderId !== null) params.orderId = orderId;
    else if (clientOrderId) params.clientId = clientOrderId;
    else throw new Error('getOrder için orderId veya clientOrderId gerekli.');
    const response = await this._signedRequest('GET', '/open/v1/orders/detail', params, { allowRetry: false });
    return this._normalizeOrder(response?.data || response, { symbol, clientOrderId });
  }

  async cancelOrder(symbol, orderId) {
    const params = { symbol: this.normalizeSymbol(symbol) };
    if (orderId !== undefined && orderId !== null) params.orderId = orderId;
    else throw new Error('Binance TR iptali için orderId gerekli.');
    const response = await this._signedRequest('POST', '/open/v1/orders/cancel', params, { allowRetry: false });
    return this._normalizeOrder(response?.data || response, { symbol, orderId, status: 'CANCELED' });
  }
}

module.exports = BinanceTrAdapter;
