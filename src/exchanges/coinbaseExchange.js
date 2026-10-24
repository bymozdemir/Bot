// src/exchanges/coinbaseExchange.js
//
// Coinbase Exchange (eski adıyla Pro) REST adaptörü — Stage 4: özel API.
// Resmî belge: https://docs.cdp.coinbase.com/exchange/  (host: https://api.exchange.coinbase.com,
// sandbox: https://api-public.sandbox.exchange.coinbase.com — COINBASEEXCHANGE_BASE_URL ile).
//
// Kimlik doğrulama: CB-ACCESS-KEY / -SIGN / -TIMESTAMP (saniye) / -PASSPHRASE.
//   SIGN = base64( HMAC-SHA256( base64decode(secret), timestamp + METHOD + requestPath + body ) )
//
// İstemci kimliği: client_oid (UUID). Botun kimliği deterministik UUID'ye çevrilir.
//   Sorgu/iptal: GET|DELETE /orders/client:{client_oid}.
// !!! Belgedeki uyarı: hiç eşleşmesi olmayan iptal edilmiş emir için GET 404 dönebilir. Bu yüzden 404,
//     "emir yok" kanıtı DEĞİLDİR; adaptör err.orderNotFound=true atar ve emir UNKNOWN kalır.
//
// Koruyucu stop: stop-limit (type=limit + stop=loss + stop_price). Stop-market kullanılmaz.
// liveTradingVerified=false: gerçek/sandbox hesap kanıtı olmadan true yapılmaz.

const crypto = require('crypto');
const PrivateAdapterBase = require('./privateBase');
const Base = require('./base');
const { deterministicUuid, requireClientOrderId, positiveNumber, sideOf, plain, decimalsFromStep } = PrivateAdapterBase.helpers;

const STOP_LIMIT_SLIPPAGE = 0.01; // limitPrice verilmezse stop fiyatının %1 altı

class CoinbaseExchangeAdapter extends PrivateAdapterBase {
  constructor(opts = {}) {
    super(opts, {
      id: 'coinbaseexchange', name: 'Coinbase Exchange', quoteAssets: ['USD', 'USDC', 'EUR'],
      baseUrl: 'https://api.exchange.coinbase.com', baseUrlEnv: 'COINBASEEXCHANGE_BASE_URL',
      allowedHosts: ['coinbase.com'], passphraseEnv: 'COINBASEEXCHANGE_API_PASSPHRASE'
    });
    this.capabilities.protectiveStopImplemented = true; // kodda var; sandbox/hesap doğrulaması ayrı
    this.nowFn = opts.nowFn || (() => Date.now());
    this.stopLimitSlippage = Number.isFinite(Number(opts.stopLimitSlippage)) ? Number(opts.stopLimitSlippage) : STOP_LIMIT_SLIPPAGE;
  }

  normalizeSymbol(s) { const [b, q] = String(s).toUpperCase().split('/'); if (!b || !q) throw new Error('Coinbase sembolü BASE/QUOTE olmalı'); return `${b}-${q}`; }
  _local(productId) { return String(productId || '').toUpperCase().replace('-', '/'); }

  // ---- imzalama -------------------------------------------------------------------------------
  _sign(timestamp, method, requestPath, body) {
    this._requireCredentials({ passphrase: true });
    const key = Buffer.from(this.apiSecret, 'base64');
    return crypto.createHmac('sha256', key).update(`${timestamp}${method}${requestPath}${body}`, 'utf8').digest('base64');
  }

  _buildRequest(method, path, { query = null, body = null } = {}) {
    this._requireCredentials({ passphrase: true });
    const m = method.toUpperCase();
    const params = query ? new URLSearchParams(query) : null;
    const qs = params && String(params) ? `?${params}` : '';
    const requestPath = `${path}${qs}`;
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = String(Math.floor(this.nowFn() / 1000));
    return {
      method: m,
      url: `${this.baseUrl}${requestPath}`,
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        'CB-ACCESS-KEY': this.apiKey, 'CB-ACCESS-SIGN': this._sign(timestamp, m, requestPath, bodyStr),
        'CB-ACCESS-TIMESTAMP': timestamp, 'CB-ACCESS-PASSPHRASE': this.apiPassphrase
      },
      body: bodyStr || undefined
    };
  }

  async _private(method, path, opts = {}, { mutating = false } = {}) {
    return this._send(this._buildRequest(method, path, opts), { mutating });
  }

  // ---- normalizasyon --------------------------------------------------------------------------
  _normalizeOrder(o = {}, { clientOrderId, symbol } = {}) {
    const exec = Number(o.filled_size || 0);
    const status = String(o.status || '').toLowerCase();
    const reason = String(o.done_reason || '').toLowerCase();
    let st;
    if (status === 'pending') st = 'NEW';
    else if (status === 'open' || status === 'active') st = exec > 0 ? 'PARTIALLY_FILLED' : 'NEW';
    else if (status === 'rejected') st = 'REJECTED';
    else if (status === 'done') st = reason === 'filled' ? 'FILLED' : (reason === 'canceled' || reason === 'cancelled') ? 'CANCELED' : 'UNKNOWN';
    else st = 'UNKNOWN';
    const sym = symbol || this._local(o.product_id);
    const quote = String(sym).split('/')[1];
    const fee = Number(o.fill_fees);
    return {
      orderId: o.id ?? null, exchangeOrderId: o.id ?? null,
      // Borsaya giden kimlik deterministik UUID'dir; botun kimliğini yalnızca çağıran biliyorsa döndürürüz.
      clientOrderId: clientOrderId || null, exchangeClientOrderId: o.client_oid || null,
      symbol: sym, side: String(o.side || '').toLowerCase(), status: st,
      executedQty: exec, origQty: Number(o.size || 0), cummulativeQuoteQty: Number(o.executed_value || 0),
      price: Number(o.price || 0), stopPrice: Number(o.stop_price || 0), createTime: o.created_at || null,
      fills: Number.isFinite(fee) && fee > 0 && quote ? [{ commission: fee, commissionAsset: quote }] : []
    };
  }

  // ---- özel yöntemler -------------------------------------------------------------------------
  async fetchBalance() {
    const data = await this._private('GET', '/accounts');
    if (!Array.isArray(data)) throw new Error('Coinbase bakiye cevabı şema doğrulamasını geçemedi.');
    const out = {};
    for (const a of data) {
      const asset = String(a.currency || '').toUpperCase();
      const free = Number(a.available), locked = Number(a.hold || 0);
      if (!asset || !Number.isFinite(free)) continue;
      if (free > 0 || locked > 0) out[asset] = { free, locked };
    }
    return out;
  }

  async fetchOpenOrders(symbols = []) {
    const list = Array.isArray(symbols) && symbols.length ? symbols : [null];
    const all = [];
    for (const symbol of list) {
      const q = [['status', 'open'], ['status', 'active'], ['status', 'pending'], ['limit', '100']];
      if (symbol) q.push(['product_id', this.normalizeSymbol(symbol)]);
      const data = await this._private('GET', '/orders', { query: q });
      if (!Array.isArray(data)) throw new Error('Coinbase açık emir cevabı şema doğrulamasını geçemedi.');
      if (data.length >= 100) throw new Error('Coinbase açık emir listesi sayfalama sınırına ulaştı; eksik liste güvenli değil, işlem durduruldu.');
      for (const o of data) all.push(this._normalizeOrder(o, { symbol: symbol || undefined }));
    }
    return all;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const s = sideOf(side, this.name);
    const cid = requireClientOrderId(clientOrderId, this.name);
    const size = plain(positiveNumber(amount, 'miktar', this.name), 8);
    const body = { type: 'market', side: s, product_id: this.normalizeSymbol(symbol), size, client_oid: deterministicUuid(cid) };
    const data = await this._private('POST', '/orders', { body }, { mutating: true });
    const created = this._assertCreated(this._normalizeOrder(data, { clientOrderId: cid, symbol }), { clientOrderId: cid, side: s });
    if (data.client_oid && data.client_oid !== body.client_oid) { const e = new Error('Coinbase client_oid yanıtta farklı; sonuç belirsiz.'); e.unknownOutcome = true; throw e; }
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (sideOf(side, this.name) !== 'sell') throw new Error('Coinbase koruyucu stop yalnızca sell olabilir.');
    const cid = requireClientOrderId(clientOrderId, this.name);
    const size = positiveNumber(amount, 'miktar', this.name);
    const stop = positiveNumber(stopPrice, 'stop fiyatı', this.name);
    const rules = await this.fetchSymbolRules(symbol);
    const round = (p) => rules.tickSize > 0 ? Number((Math.floor(p / rules.tickSize + 1e-9) * rules.tickSize).toFixed(decimalsFromStep(rules.tickSize))) : p;
    const stopR = round(stop);
    const limitR = round(Number(limitPrice) > 0 ? Number(limitPrice) : stop * (1 - this.stopLimitSlippage));
    if (!(limitR > 0) || limitR > stopR) throw new Error('Coinbase stop-limit için limit fiyatı stop fiyatını aşamaz.');
    const body = {
      type: 'limit', side: 'sell', product_id: this.normalizeSymbol(symbol), size: plain(size, 8),
      price: plain(limitR, 8), stop: 'loss', stop_price: plain(stopR, 8), time_in_force: 'GTC', client_oid: deterministicUuid(cid)
    };
    const data = await this._private('POST', '/orders', { body }, { mutating: true });
    const created = this._assertCreated(this._normalizeOrder(data, { clientOrderId: cid, symbol }), { clientOrderId: cid, side: 'sell' });
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async getOrder(symbol, orderId, clientOrderId) {
    let ref;
    if (orderId !== undefined && orderId !== null && orderId !== '') ref = String(orderId);
    else if (clientOrderId) ref = `client:${deterministicUuid(clientOrderId)}`;
    else throw new Error('Coinbase getOrder için orderId veya clientOrderId gerekli.');
    try {
      const data = await this._private('GET', `/orders/${encodeURIComponent(ref).replace('%3A', ':')}`);
      return this._normalizeOrder(data, { clientOrderId, symbol });
    } catch (err) {
      if (err.httpStatus === 404) {
        err.orderNotFound = true;
        err.message += ' — 404 "emir yok" kanıtı değildir (eşleşmesiz iptal edilen emirler kaydedilmeyebilir); emir UNKNOWN kalmalı.';
      }
      throw err;
    }
  }

  async cancelOrder(symbol, orderId) {
    if (orderId === undefined || orderId === null || orderId === '') throw new Error('Coinbase iptal için borsa emir kimliği gerekli.');
    const query = symbol ? { product_id: this.normalizeSymbol(symbol) } : null;
    await this._private('DELETE', `/orders/${encodeURIComponent(orderId)}`, { query }, { mutating: true });
    // İptal çağrısı başarılı, ama dolum yarışı olabilir: durumu doğrula; doğrulanamazsa UNKNOWN döndür.
    try {
      const o = await this.getOrder(symbol, orderId);
      return o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' ? { ...o, status: 'UNKNOWN' } : o;
    } catch (err) {
      if (err.orderNotFound) return { orderId, exchangeOrderId: orderId, symbol, status: 'CANCELED', executedQty: 0 };
      return { orderId, exchangeOrderId: orderId, symbol, status: 'UNKNOWN', executedQty: 0 };
    }
  }

  // ---- genel piyasa verisi --------------------------------------------------------------------
  async fetchTicker(s) { const d = await this._get(`/products/${this.normalizeSymbol(s)}/ticker`); return { symbol: s, price: Number(d.price), bid: Number(d.bid), ask: Number(d.ask), volume: Number(d.volume) }; }
  // Coinbase Exchange'te toplu 24s endpoint'i yok: ürün başına /stats çağrılır. İstek sayısı sınırlıdır
  // (varsayılan en çok 60 çevrimiçi ürün, 5 eşzamanlı) — tarayıcı için kaba bir likidite listesi, tam piyasa taraması değil.
  async fetchAllTickers24h({ maxProducts = 60, concurrency = 5 } = {}) {
    const products = (await this._get('/products')).filter((p) => p.status === 'online' && !p.trading_disabled && this.quoteAssets.includes(String(p.quote_currency || '').toUpperCase())).slice(0, maxProducts);
    const out = [];
    let i = 0;
    const worker = async () => {
      while (i < products.length) {
        const p = products[i++];
        try {
          const d = await this._get(`/products/${p.id}/stats`);
          out.push(this._tickerRow(p.id.replace('-', '/'), { last: d.last, open: d.open, quoteVolume: Number(d.volume) * Number(d.last), high: d.high, low: d.low, baseVolume: d.volume }));
        } catch (_) { /* tek ürün hatası listeyi bozmaz */ }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return out;
  }
  async fetchCandles(s, tf = '1h', limit = 200) { const sec = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 }[tf]; if (!sec) throw new Error('Coinbase desteklenmeyen timeframe'); const now = Date.now(); const d = await this._get(`/products/${this.normalizeSymbol(s)}/candles`, { granularity: sec, start: new Date(now - Math.min(limit, 300) * sec * 1000).toISOString(), end: new Date(now).toISOString() }); return Base.validateCandleRows(d.slice(0, limit).reverse().map(x => ({ t: x[0] * 1000, o: x[3], h: x[2], l: x[1], c: x[4], v: x[5] })), { source: this.name }); }
  async fetchSymbolRules(s) {
    const p = await this._get(`/products/${this.normalizeSymbol(s)}`);
    if (p.trading_disabled || p.cancel_only || p.limit_only || p.post_only || (p.status && p.status !== 'online')) {
      throw new Error(`Coinbase ${s}: ürün şu an market emir kabul etmiyor (status=${p.status}); canlı emir durduruldu.`);
    }
    const [base, quote] = String(s).toUpperCase().split('/');
    return this._rules(s, { stepSize: p.base_increment, minQty: p.base_min_size, maxQty: p.base_max_size, tickSize: p.quote_increment, minNotional: p.min_market_funds, base, quote });
  }
  async fetchOrderBook(s, limit = 20) { const d = await this._get(`/products/${this.normalizeSymbol(s)}/book`, { level: 2 }); return { bids: d.bids.slice(0, limit).map(x => [Number(x[0]), Number(x[1])]), asks: d.asks.slice(0, limit).map(x => [Number(x[0]), Number(x[1])]) }; }
}
module.exports = CoinbaseExchangeAdapter;
