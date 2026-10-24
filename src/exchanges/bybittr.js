// src/exchanges/bybittr.js
//
// Bybit TR (Türkiye) — Bybit V5 REST, Spot kategorisi — Stage 4.
// Resmî belge (bybit-exchange.github.io/docs/v5/guide, 2026-10-14): "Turkey users: use https://api.bybit.tr for mainnet".
// WebSocket (kullanılmıyor): stream.bybit.tr. Global api.bybit.com, TR hesapları için KULLANILMAZ.
// Alan adı yalnızca bybit.tr alt alanlarına izin veren allowlist'ten geçer (BYBITTR_BASE_URL).
//
// Kimlik doğrulama: X-BAPI-API-KEY / -TIMESTAMP (ms) / -RECV-WINDOW / -SIGN
//   SIGN = hex( HMAC-SHA256( secret, timestamp + apiKey + recvWindow + (queryString | jsonBody) ) )
//
// İstemci kimliği: orderLinkId (en fazla 36 karakter; botun kimliği zaten ≤36 ve [A-Za-z0-9_-]).
//   Mükerrer orderLinkId (110072) emrin ZATEN VAR olabileceği anlamına gelir => unknownOutcome.
// Market AL emri: Bybit varsayılan olarak miktarı QUOTE sayar; bu adaptör marketUnit=baseCoin gönderir
//   (bot sözleşmesi: miktar = baz varlık).
// Hesap türü: BYBITTR_ACCOUNT_TYPE (varsayılan UNIFIED; klasik hesaplar için SPOT). TR hesap türü doğrulanmadı.
// Koruyucu stop: Spot koşullu emir (orderFilter=StopOrder, triggerPrice, Market). Sandbox/gerçek hesapta
//   doğrulanmadı. liveTradingVerified=false.

const crypto = require('crypto');
const PrivateAdapterBase = require('./privateBase');
const Base = require('./base');
const { requireClientOrderId, positiveNumber, sideOf, plain } = PrivateAdapterBase.helpers;

const AMBIGUOUS_CODES = new Set([10000, 10016, 10019]);   // sunucu zaman aşımı / sunucu hatası / servis yeniden başlıyor
const DUPLICATE_CODES = new Set([110072]);                // OrderLinkedID is duplicate
const NOT_FOUND_CODES = new Set([110001, 170213]);        // Order does not exist

class BybitTrAdapter extends PrivateAdapterBase {
  constructor(opts = {}) {
    super(opts, { id: 'bybittr', name: 'Bybit TR', quoteAssets: ['TRY', 'USDT', 'USDC'], baseUrl: 'https://api.bybit.tr', baseUrlEnv: 'BYBITTR_BASE_URL', allowedHosts: ['bybit.tr'] });
    this.capabilities.protectiveStopImplemented = true; // kodda var; sandbox/hesap doğrulaması ayrı
    this.nowFn = opts.nowFn || (() => Date.now());
    this.accountType = String(opts.accountType || process.env.BYBITTR_ACCOUNT_TYPE || 'UNIFIED').toUpperCase();
    this.baseUrlConfigured = true; // varsayılan artık resmî belgeden doğrulanmış host
  }

  normalizeSymbol(s) { const [b, q] = String(s).toUpperCase().split('/'); if (!b || !q) throw new Error('Bybit TR sembolü BASE/QUOTE olmalı'); return `${b}${q}`; }

  // ---- imzalama -------------------------------------------------------------------------------
  _sign(timestamp, payload) {
    this._requireCredentials();
    return crypto.createHmac('sha256', this.apiSecret).update(`${timestamp}${this.apiKey}${this.recvWindowMs}${payload}`, 'utf8').digest('hex');
  }

  _buildRequest(method, path, { query = null, body = null } = {}) {
    this._requireCredentials();
    const m = method.toUpperCase();
    const qs = query ? new URLSearchParams(query).toString() : '';
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = String(this.nowFn());
    const payload = m === 'GET' ? qs : bodyStr;
    return {
      method: m, url: `${this.baseUrl}${path}${m === 'GET' && qs ? `?${qs}` : ''}`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-BAPI-API-KEY': this.apiKey, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': String(this.recvWindowMs), 'X-BAPI-SIGN': this._sign(timestamp, payload) },
      body: m === 'GET' ? undefined : bodyStr
    };
  }

  async _private(method, path, opts = {}, { mutating = false } = {}) {
    const d = await this._send(this._buildRequest(method, path, opts), { mutating });
    if (d.retCode === undefined) { const e = new Error('Bybit TR yanıtında retCode yok.'); e.exchange = this.id; if (mutating) e.unknownOutcome = true; throw e; }
    if (Number(d.retCode) !== 0) {
      const code = Number(d.retCode);
      const err = new Error(`Bybit TR API ${code}: ${d.retMsg || 'hata'}`);
      err.exchange = this.id; err.bybitCode = code;
      if (mutating && (AMBIGUOUS_CODES.has(code) || DUPLICATE_CODES.has(code))) err.unknownOutcome = true;
      if (NOT_FOUND_CODES.has(code)) err.orderNotFound = true;
      throw err;
    }
    return d.result || {};
  }

  // ---- normalizasyon --------------------------------------------------------------------------
  _normalizeOrder(o = {}, { clientOrderId, symbol } = {}) {
    const exec = Number(o.cumExecQty || 0);
    const s = String(o.orderStatus || '');
    const map = { New: 'NEW', Untriggered: 'NEW', PartiallyFilled: 'PARTIALLY_FILLED', Filled: 'FILLED', Cancelled: 'CANCELED', Deactivated: 'CANCELED', PartiallyFilledCanceled: 'CANCELED', Rejected: 'REJECTED' };
    // Triggered: koşullu emir tetiklendi, gerçek emir sonucu bu kayıttan okunamaz => UNKNOWN (yeniden mutabakat).
    const st = map[s] || 'UNKNOWN';
    const sym = symbol || String(o.symbol || '');
    const fee = Number(o.cumExecFee);
    const feeCcy = String(o.feeCurrency || '').toUpperCase();
    return {
      orderId: o.orderId || null, exchangeOrderId: o.orderId || null,
      clientOrderId: clientOrderId || null, exchangeClientOrderId: o.orderLinkId || null,
      symbol: sym, side: String(o.side || '').toLowerCase(), status: st,
      executedQty: exec, origQty: Number(o.qty || 0), cummulativeQuoteQty: Number(o.cumExecValue || 0),
      price: Number(o.price || 0), stopPrice: Number(o.triggerPrice || 0), createTime: o.createdTime ? Number(o.createdTime) : null,
      fills: Number.isFinite(fee) && fee > 0 && feeCcy ? [{ commission: fee, commissionAsset: feeCcy }] : []
    };
  }

  // ---- özel yöntemler -------------------------------------------------------------------------
  async fetchBalance() {
    const r = await this._private('GET', '/v5/account/wallet-balance', { query: { accountType: this.accountType } });
    const coins = r.list?.[0]?.coin;
    if (!Array.isArray(coins)) throw new Error('Bybit TR bakiye cevabı şema doğrulamasını geçemedi.');
    const out = {};
    for (const c of coins) {
      const asset = String(c.coin || '').toUpperCase();
      const total = Number(c.walletBalance), locked = Number(c.locked || 0);
      if (!asset || !Number.isFinite(total)) continue;
      const free = Math.max(0, total - locked);
      if (free > 0 || locked > 0) out[asset] = { free, locked };
    }
    return out;
  }

  async fetchOpenOrders(symbols = []) {
    const list = Array.isArray(symbols) && symbols.length ? symbols : [null];
    const all = [];
    for (const symbol of list) {
      for (const filter of ['Order', 'StopOrder']) {
        const query = { category: 'spot', openOnly: '0', limit: '50', orderFilter: filter };
        if (symbol) query.symbol = this.normalizeSymbol(symbol);
        const r = await this._private('GET', '/v5/order/realtime', { query });
        if (!Array.isArray(r.list)) throw new Error('Bybit TR açık emir cevabı şema doğrulamasını geçemedi.');
        if (r.list.length >= 50) throw new Error('Bybit TR açık emir listesi sayfalama sınırına ulaştı; eksik liste güvenli değil, işlem durduruldu.');
        for (const o of r.list) {
          const n = this._normalizeOrder(o, { symbol: symbol || undefined });
          if (n.status === 'NEW' || n.status === 'PARTIALLY_FILLED' || n.status === 'UNKNOWN') all.push(n);
        }
      }
    }
    return all;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const s = sideOf(side, this.name);
    const cid = requireClientOrderId(clientOrderId, this.name);
    if (String(cid).length > 36 || !/^[A-Za-z0-9_-]+$/.test(cid)) throw new Error('Bybit TR orderLinkId en fazla 36 karakter ve [A-Za-z0-9_-] olmalı.');
    const body = { category: 'spot', symbol: this.normalizeSymbol(symbol), side: s === 'buy' ? 'Buy' : 'Sell', orderType: 'Market', qty: plain(positiveNumber(amount, 'miktar', this.name), 8), marketUnit: 'baseCoin', orderLinkId: cid };
    const r = await this._private('POST', '/v5/order/create', { body }, { mutating: true });
    const created = this._assertCreated({ orderId: r.orderId || null, exchangeOrderId: r.orderId || null, clientOrderId: cid, exchangeClientOrderId: r.orderLinkId || null, symbol, side: s, status: 'NEW', origQty: Number(body.qty), executedQty: 0, fills: [] }, { clientOrderId: cid, side: s });
    if (r.orderLinkId && r.orderLinkId !== cid) { const e = new Error('Bybit TR orderLinkId yanıtta farklı; sonuç belirsiz.'); e.unknownOutcome = true; throw e; }
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (sideOf(side, this.name) !== 'sell') throw new Error('Bybit TR koruyucu stop yalnızca sell olabilir.');
    const cid = requireClientOrderId(clientOrderId, this.name);
    if (String(cid).length > 36 || !/^[A-Za-z0-9_-]+$/.test(cid)) throw new Error('Bybit TR orderLinkId en fazla 36 karakter ve [A-Za-z0-9_-] olmalı.');
    const body = { category: 'spot', symbol: this.normalizeSymbol(symbol), side: 'Sell', orderType: 'Market', qty: plain(positiveNumber(amount, 'miktar', this.name), 8), triggerPrice: plain(positiveNumber(stopPrice, 'stop fiyatı', this.name), 8), orderFilter: 'StopOrder', orderLinkId: cid };
    const r = await this._private('POST', '/v5/order/create', { body }, { mutating: true });
    const created = this._assertCreated({ orderId: r.orderId || null, exchangeOrderId: r.orderId || null, clientOrderId: cid, exchangeClientOrderId: r.orderLinkId || null, symbol, side: 'sell', status: 'NEW', origQty: Number(body.qty), executedQty: 0, stopPrice: Number(body.triggerPrice), fills: [] }, { clientOrderId: cid, side: 'sell' });
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async getOrder(symbol, orderId, clientOrderId) {
    const hasId = orderId !== undefined && orderId !== null && orderId !== '';
    if (!hasId && !clientOrderId) throw new Error('Bybit TR getOrder için orderId veya clientOrderId gerekli.');
    const ref = hasId ? { orderId: String(orderId) } : { orderLinkId: String(clientOrderId) };
    // realtime: açık + yakın zamanda kapanan; history: kapanmış emirler. Normal ve koşullu (StopOrder) emirler ayrı filtredir.
    for (const path of ['/v5/order/realtime', '/v5/order/history']) {
      for (const filter of ['Order', 'StopOrder']) {
        const r = await this._private('GET', path, { query: { category: 'spot', symbol: this.normalizeSymbol(symbol), orderFilter: filter, ...ref } });
        const o = Array.isArray(r.list) ? r.list[0] : null;
        if (o) return this._normalizeOrder(o, { clientOrderId, symbol });
      }
    }
    const e = new Error('Bybit TR emir realtime/history sorgularında bulunamadı. Bu "emir yok" kanıtı değildir; emir UNKNOWN kalmalı, otomatik tekrar gönderilmemeli.');
    e.orderNotFound = true; throw e;
  }

  async cancelOrder(symbol, orderId) {
    if (orderId === undefined || orderId === null || orderId === '') throw new Error('Bybit TR iptal için borsa emir kimliği gerekli.');
    // Koşullu emir mi normal emir mi bilinmiyor: önce normal, "yok" ise StopOrder filtresiyle dene.
    const attempt = async (filter) => this._private('POST', '/v5/order/cancel', { body: { category: 'spot', symbol: this.normalizeSymbol(symbol), orderId: String(orderId), ...(filter === 'StopOrder' ? { orderFilter: 'StopOrder' } : {}) } }, { mutating: true });
    try { await attempt('Order'); } catch (err) { if (err.orderNotFound) await attempt('StopOrder'); else throw err; }
    try {
      const o = await this.getOrder(symbol, orderId);
      return o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' ? { ...o, status: 'UNKNOWN' } : o;
    } catch (_) {
      return { orderId, exchangeOrderId: orderId, symbol, status: 'UNKNOWN', executedQty: 0 };
    }
  }

  // ---- genel piyasa verisi --------------------------------------------------------------------
  async _v5(path, p = {}) { const d = await this._get(path, p); if (d.retCode !== undefined && Number(d.retCode) !== 0) throw new Error(`Bybit TR API ${d.retCode}: ${d.retMsg || 'hata'}`); return d.result || {}; }
  async fetchTicker(s) { const d = await this._v5('/v5/market/tickers', { category: 'spot', symbol: this.normalizeSymbol(s) }); const x = d.list?.[0]; if (!x) throw new Error('Bybit TR ticker yok'); return { symbol: s, price: Number(x.lastPrice), bid: Number(x.bid1Price), ask: Number(x.ask1Price), volume: Number(x.volume24h) }; }
  async fetchAllTickers24h() {
    const d = await this._v5('/v5/market/tickers', { category: 'spot' });
    const rows = (d.list || []).filter((x) => /^[A-Z0-9]+(TRY|USDT|USDC)$/.test(String(x.symbol)));
    return rows.map((x) => {
      const quote = ['USDT', 'USDC', 'TRY'].find((q) => String(x.symbol).endsWith(q));
      const last = Number(x.lastPrice), pct = Number(x.price24hPcnt);
      const row = this._tickerRow(`${String(x.symbol).slice(0, -quote.length)}/${quote}`, { last, open: Number.isFinite(pct) ? last / (1 + pct) : NaN, quoteVolume: x.turnover24h, high: x.highPrice24h, low: x.lowPrice24h, baseVolume: x.volume24h });
      return row;
    });
  }
  async fetchCandles(s, tf = '1h', limit = 200) { const interval = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' }[tf]; if (!interval) throw new Error('Bybit TR desteklenmeyen timeframe'); const d = await this._v5('/v5/market/kline', { category: 'spot', symbol: this.normalizeSymbol(s), interval, limit: String(Math.min(limit, 1000)) }); return Base.validateCandleRows((d.list || []).slice().reverse().map(x => ({ t: Number(x[0]), o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] })), { source: this.name }); }
  async fetchSymbolRules(s) {
    const d = await this._v5('/v5/market/instruments-info', { category: 'spot', symbol: this.normalizeSymbol(s) });
    const x = d.list?.[0];
    if (!x) throw new Error('Bybit TR instrument bulunamadı');
    if (x.status && x.status !== 'Trading') throw new Error(`Bybit TR ${s}: instrument durumu ${x.status}; canlı emir durduruldu.`);
    const [base, quote] = String(s).toUpperCase().split('/');
    // Spot'ta adım büyüklüğü lotSizeFilter.basePrecision'dır (qtyStep futures içindir).
    return this._rules(s, { stepSize: x.lotSizeFilter?.basePrecision, minQty: x.lotSizeFilter?.minOrderQty, maxQty: x.lotSizeFilter?.maxOrderQty, tickSize: x.priceFilter?.tickSize, minNotional: x.lotSizeFilter?.minOrderAmt, base, quote });
  }
  async fetchOrderBook(s, limit = 20) { const d = await this._v5('/v5/market/orderbook', { category: 'spot', symbol: this.normalizeSymbol(s), limit: String(Math.min(limit, 200)) }); return { bids: (d.b || []).map(x => [Number(x[0]), Number(x[1])]), asks: (d.a || []).map(x => [Number(x[0]), Number(x[1])]) }; }
}
module.exports = BybitTrAdapter;
