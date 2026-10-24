// src/exchanges/bitstamp.js
//
// Bitstamp REST v2 adaptörü — Stage 4: özel API (bakiye, açık emir, market emir, sorgu, iptal).
// Resmî belge: https://www.bitstamp.net/api/  (host: https://www.bitstamp.net)
//
// Kimlik doğrulama (v2): X-Auth: "BITSTAMP <key>", X-Auth-Signature (hex HMAC-SHA256),
//   X-Auth-Nonce (UUID), X-Auth-Timestamp (ms), X-Auth-Version: v2.
//   mesaj = "BITSTAMP "+key + METHOD + host + path + query + contentType + nonce + timestamp + "v2" + body
//   Gövde yoksa Content-Type başlığı gönderilmez ve mesajda boş bırakılır.
//
// İstemci kimliği: client_order_id (oluşturma + order_status). Mükerrer kimlik hatası 400.019 =>
//   emir ZATEN VAR olabilir => unknownOutcome. order_status kapalı emirler için yalnızca son 30 günü döndürür.
//
// Koruyucu stop: stop-limit satış (stop_price parametresi, bkz. createStopOrder). liveTradingVerified=false.

const crypto = require('crypto');
const PrivateAdapterBase = require('./privateBase');
const Base = require('./base');
const { deterministicUuid, requireClientOrderId, positiveNumber, sideOf, plain, decimalsFromStep } = PrivateAdapterBase.helpers;

class BitstampAdapter extends PrivateAdapterBase {
  constructor(opts = {}) {
    super(opts, { id: 'bitstamp', name: 'Bitstamp', quoteAssets: ['USD', 'EUR', 'USDT'], baseUrl: 'https://www.bitstamp.net/api/v2', baseUrlEnv: 'BITSTAMP_BASE_URL', allowedHosts: ['bitstamp.net'] });
    this.capabilities.protectiveStopImplemented = true; // kodda var; sandbox/hesap doğrulaması ayrı
    this.nowFn = opts.nowFn || (() => Date.now());
    this.nonceFn = opts.nonceFn || (() => crypto.randomUUID());
  }

  normalizeSymbol(s) { const [b, q] = String(s).toLowerCase().split('/'); if (!b || !q) throw new Error('Bitstamp sembolü BASE/QUOTE olmalı'); return `${b}${q}`; }

  // ---- imzalama -------------------------------------------------------------------------------
  _buildRequest(endpoint, params = {}) {
    this._requireCredentials();
    const url = new URL(`${this.baseUrl}${endpoint}`);
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.append(k, String(v));
    const body = form.toString();
    const contentType = body ? 'application/x-www-form-urlencoded' : '';
    const nonce = this.nonceFn();
    const timestamp = String(this.nowFn());
    const message = `BITSTAMP ${this.apiKey}POST${url.host}${url.pathname}${url.search ? url.search.slice(1) : ''}${contentType}${nonce}${timestamp}v2${body}`;
    const signature = crypto.createHmac('sha256', this.apiSecret).update(message, 'utf8').digest('hex');
    const headers = { Accept: 'application/json', 'X-Auth': `BITSTAMP ${this.apiKey}`, 'X-Auth-Signature': signature, 'X-Auth-Nonce': nonce, 'X-Auth-Timestamp': timestamp, 'X-Auth-Version': 'v2' };
    if (contentType) headers['Content-Type'] = contentType;
    return { method: 'POST', url: url.toString(), headers, body: body || undefined, _message: message };
  }

  async _private(endpoint, params = {}, { mutating = false } = {}) {
    const data = await this._send(this._buildRequest(endpoint, params), { mutating });
    if (data && !Array.isArray(data) && (data.status === 'error' || data.error)) {
      const err = new Error(`Bitstamp API: ${JSON.stringify(data.reason || data.error || data).slice(0, 300)}`);
      err.exchange = this.id; err.body = data;
      if (mutating && /400\.019|client_order_id.*(exist|already)/i.test(JSON.stringify(data))) err.unknownOutcome = true;
      if (mutating && /500\.002/.test(JSON.stringify(data))) err.unknownOutcome = true;
      throw err;
    }
    return data;
  }

  // ---- normalizasyon --------------------------------------------------------------------------
  _normalizeStatus(st, remaining, exec) {
    const s = String(st || '').toLowerCase();
    if (s === 'open') return exec > 0 ? 'PARTIALLY_FILLED' : 'NEW';
    if (s === 'finished') return remaining > 1e-12 ? 'UNKNOWN' : 'FILLED';
    if (s === 'canceled' || s === 'cancelled') return 'CANCELED';
    if (s === 'expired') return 'EXPIRED';
    return 'UNKNOWN';
  }

  _normalizeStatusOrder(o = {}, { symbol, clientOrderId } = {}) {
    const [base, quote] = String(symbol || '').toLowerCase().split('/');
    let exec = 0, cost = 0, fee = 0;
    for (const t of o.transactions || []) {
      if (base && t[base] !== undefined) exec += Math.abs(Number(t[base]) || 0);
      if (quote && t[quote] !== undefined) cost += Math.abs(Number(t[quote]) || 0);
      fee += Math.abs(Number(t.fee) || 0);
    }
    const remaining = Number(o.amount_remaining || 0);
    const type = o.type === undefined ? '' : (String(o.type) === '0' ? 'buy' : String(o.type) === '1' ? 'sell' : String(o.type).toLowerCase());
    return {
      orderId: o.id !== undefined ? String(o.id) : null, exchangeOrderId: o.id !== undefined ? String(o.id) : null,
      clientOrderId: clientOrderId || null, exchangeClientOrderId: o.client_order_id || null,
      symbol: symbol || String(o.market || '').toUpperCase(), side: type, status: this._normalizeStatus(o.status, remaining, exec),
      executedQty: exec, origQty: exec + remaining, cummulativeQuoteQty: cost,
      price: Number(o.price || 0), createTime: o.datetime || null,
      fills: fee > 0 && quote ? [{ commission: fee, commissionAsset: quote.toUpperCase() }] : []
    };
  }

  // ---- özel yöntemler -------------------------------------------------------------------------
  async fetchBalance() {
    const d = await this._private('/balance/');
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Bitstamp bakiye cevabı şema doğrulamasını geçemedi.');
    const out = {};
    for (const [k, v] of Object.entries(d)) {
      const m = /^([a-z0-9]+)_available$/.exec(k);
      if (!m) continue;
      const asset = m[1].toUpperCase();
      const free = Number(v), locked = Number(d[`${m[1]}_reserved`] || 0);
      if (Number.isFinite(free) && (free > 0 || locked > 0)) out[asset] = { free, locked };
    }
    return out;
  }

  async fetchOpenOrders(symbols = []) {
    const list = Array.isArray(symbols) && symbols.length ? symbols : [null];
    const all = [];
    for (const symbol of list) {
      const d = await this._private(symbol ? `/open_orders/${this.normalizeSymbol(symbol)}/` : '/open_orders/all/');
      if (!Array.isArray(d)) throw new Error('Bitstamp açık emir cevabı şema doğrulamasını geçemedi.');
      for (const o of d) {
        const pair = String(o.currency_pair || o.market || '').toUpperCase();
        all.push({
          orderId: String(o.id), exchangeOrderId: String(o.id), clientOrderId: null, exchangeClientOrderId: o.client_order_id || null,
          symbol: symbol || pair, side: String(o.type) === '0' ? 'buy' : String(o.type) === '1' ? 'sell' : String(o.type || '').toLowerCase(),
          status: 'NEW', executedQty: 0, origQty: Number(o.amount || 0), price: Number(o.price || 0), createTime: o.datetime || null
        });
      }
    }
    return all;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const s = sideOf(side, this.name);
    const cid = requireClientOrderId(clientOrderId, this.name);
    const qty = plain(positiveNumber(amount, 'miktar', this.name), 8);
    const d = await this._private(`/${s}/market/${this.normalizeSymbol(symbol)}/`, { amount: qty, client_order_id: deterministicUuid(cid) }, { mutating: true });
    const created = this._assertCreated({
      orderId: d.id !== undefined ? String(d.id) : null, exchangeOrderId: d.id !== undefined ? String(d.id) : null,
      clientOrderId: cid, symbol, side: s, status: 'NEW', origQty: Number(qty), executedQty: 0, fills: []
    }, { clientOrderId: cid, side: s });
    if (d.client_order_id && d.client_order_id !== deterministicUuid(cid)) { const e = new Error('Bitstamp client_order_id yanıtta farklı; sonuç belirsiz.'); e.unknownOutcome = true; throw e; }
    return this._enrichAfterCreate(created, symbol, cid);
  }

  // Koruyucu stop = STOP-LIMIT SATIŞ: POST /sell/{pair}/ + stop_price (resmî belge: "When the stop price is reached,
  // a stop order becomes a limit/market order"; Nisan 2025'te yalnızca stop-market ALIŞ ve trailing kaldırıldı,
  // stop-limit satış sürüyor). Stop-market satış parametresi belgeden kesinleştirilemediği için kullanılmaz.
  // Limit fiyatı verilmezse stop fiyatının %1 altı alınır; boşluklu düşüşte emir dolmayabilir (stop-limit riski).
  // Gerçek hesapta doğrulanmadı (liveTradingVerified=false).
  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (sideOf(side, this.name) !== 'sell') throw new Error('Bitstamp koruyucu stop yalnızca sell olabilir.');
    const cid = requireClientOrderId(clientOrderId, this.name);
    const qty = positiveNumber(amount, 'miktar', this.name);
    const stop = positiveNumber(stopPrice, 'stop fiyatı', this.name);
    const rules = await this.fetchSymbolRules(symbol);
    const round = (p) => rules.tickSize > 0 ? Number((Math.floor(p / rules.tickSize + 1e-9) * rules.tickSize).toFixed(decimalsFromStep(rules.tickSize))) : p;
    const stopR = round(stop);
    const limitR = round(Number(limitPrice) > 0 ? Number(limitPrice) : stop * 0.99);
    if (!(limitR > 0) || limitR > stopR) throw new Error('Bitstamp stop-limit için limit fiyatı stop fiyatını aşamaz.');
    const d = await this._private(`/sell/${this.normalizeSymbol(symbol)}/`, { amount: plain(qty, 8), price: plain(limitR, 8), stop_price: plain(stopR, 8), client_order_id: deterministicUuid(cid) }, { mutating: true });
    const created = this._assertCreated({
      orderId: d.id !== undefined ? String(d.id) : null, exchangeOrderId: d.id !== undefined ? String(d.id) : null,
      clientOrderId: cid, symbol, side: 'sell', status: 'NEW', origQty: qty, executedQty: 0, stopPrice: stopR, fills: []
    }, { clientOrderId: cid, side: 'sell' });
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async getOrder(symbol, orderId, clientOrderId) {
    const params = {};
    if (orderId !== undefined && orderId !== null && orderId !== '') params.id = orderId;
    else if (clientOrderId) params.client_order_id = deterministicUuid(clientOrderId);
    else throw new Error('Bitstamp getOrder için orderId veya clientOrderId gerekli.');
    try {
      const d = await this._private('/order_status/', params);
      return this._normalizeStatusOrder(d, { symbol, clientOrderId });
    } catch (err) {
      if (/order not found|404\.|not found/i.test(err.message)) {
        err.orderNotFound = true;
        err.message += ' — kapalı emirler yalnızca son 30 gün sorgulanabilir; bu "emir yok" kanıtı değildir.';
      }
      throw err;
    }
  }

  async cancelOrder(symbol, orderId) {
    if (orderId === undefined || orderId === null || orderId === '') throw new Error('Bitstamp iptal için borsa emir kimliği gerekli.');
    await this._private('/cancel_order/', { id: orderId }, { mutating: true });
    try {
      const o = await this.getOrder(symbol, orderId);
      return o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' ? { ...o, status: 'UNKNOWN' } : o;
    } catch (_) {
      return { orderId: String(orderId), exchangeOrderId: String(orderId), symbol, status: 'UNKNOWN', executedQty: 0 };
    }
  }

  // ---- genel piyasa verisi --------------------------------------------------------------------
  async fetchTicker(s) { const d = await this._get(`/ticker/${this.normalizeSymbol(s)}/`); return { symbol: s, price: Number(d.last), bid: Number(d.bid), ask: Number(d.ask), volume: Number(d.volume) }; }
  async fetchAllTickers24h() { const d = await this._get('/ticker/'); return (Array.isArray(d) ? d : []).filter((x) => String(x.pair || '').includes('/')).map((x) => this._tickerRow(String(x.pair).toUpperCase(), { last: x.last, open: x.open, quoteVolume: Number(x.volume) * (Number(x.vwap) > 0 ? Number(x.vwap) : Number(x.last)), high: x.high, low: x.low, baseVolume: x.volume })); }
  async fetchCandles(s, tf = '1h', limit = 200) { const step = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[tf]; if (!step) throw new Error('Bitstamp desteklenmeyen timeframe'); const d = await this._get(`/ohlc/${this.normalizeSymbol(s)}/`, { step, limit: Math.min(limit, 1000) }); return Base.validateCandleRows((d.data?.ohlc || []).map(x => ({ t: Number(x.timestamp) * 1000, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume })), { source: this.name }); }
  async fetchSymbolRules(s) {
    const d = await this._get('/trading-pairs-info/');
    const p = (Array.isArray(d) ? d : []).find(x => String(x.url_symbol).toLowerCase() === this.normalizeSymbol(s));
    if (!p) throw new Error('Bitstamp pair bulunamadı');
    if (String(p.trading || '').toLowerCase() === 'disabled') throw new Error(`Bitstamp ${s}: işlem kapalı; canlı emir durduruldu.`);
    const [base, quote] = String(s).toUpperCase().split('/');
    const minNotional = Number(String(p.minimum_order || '0').split(' ')[0]) || 0;
    return this._rules(s, { stepSize: 10 ** (-Number(p.base_decimals ?? 8)), minQty: 0, tickSize: 10 ** (-Number(p.counter_decimals ?? 2)), minNotional, base, quote });
  }
  async fetchOrderBook(s, limit = 20) { const d = await this._get(`/order_book/${this.normalizeSymbol(s)}/`); return { bids: (d.bids || []).slice(0, limit).map(x => [Number(x[0]), Number(x[1])]), asks: (d.asks || []).slice(0, limit).map(x => [Number(x[0]), Number(x[1])]) }; }
}
module.exports = BitstampAdapter;
