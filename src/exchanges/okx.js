// src/exchanges/okx.js
//
// OKX Spot V5 REST adaptörü — Stage 4: özel API.
// Resmî belge: https://www.okx.com/docs-v5/en/  (global host: https://www.okx.com)
// Bölgesel hesaplar kendi alan adını kullanmak zorundadır (ör. OKX TR: tr.okx.com); bkz. okxtr.js.
//
// Kimlik doğrulama: OK-ACCESS-KEY / -SIGN / -TIMESTAMP (ISO-8601 ms, UTC) / -PASSPHRASE.
//   SIGN = base64( HMAC-SHA256( secret, timestamp + METHOD + requestPath(+query) + body ) )
// Demo ticaret: OKX_SIMULATED=1 ya da opts.simulated => "x-simulated-trading: 1" başlığı (demo anahtarı gerekir).
//
// İstemci kimliği: clOrdId — YALNIZCA alfanümerik, en fazla 32 karakter. Botun kimliği (tire içerir) doğrudan
//   kullanılamaz; deterministik 32 haneli hex'e çevrilir. Koruyucu stop: algo emri (conditional + slTriggerPx,
//   slOrdPx=-1 market) algoClOrdId ile; bot tarafında orderId "algo:<algoId>" öneki taşır.
// Belirsiz sonuç: 50001/50004/50013/50026 (servis) ve sCode 51149 (emir zaman aşımı) => unknownOutcome.
// Kurtarma sınırı: OKX, hiç dolmamış iptal emirlerini yalnızca kısa süre saklar; 51603 "emir yok" kanıtı DEĞİLDİR.
// liveTradingVerified=false.

const crypto = require('crypto');
const PrivateAdapterBase = require('./privateBase');
const Base = require('./base');
const { deterministicHex, requireClientOrderId, positiveNumber, sideOf, plain } = PrivateAdapterBase.helpers;

const AMBIGUOUS_CODES = new Set(['50001', '50004', '50013', '50026', '51149']);
const NOT_FOUND_CODES = new Set(['51603', '51400']);

class OkxAdapter extends PrivateAdapterBase {
  constructor(opts = {}, cfg = {}) {
    super(opts, {
      id: cfg.id || 'okx', name: cfg.name || 'OKX', quoteAssets: cfg.quoteAssets || ['USDT', 'USDC', 'USD', 'EUR'],
      baseUrl: cfg.baseUrl || 'https://www.okx.com', baseUrlEnv: cfg.baseUrlEnv || 'OKX_BASE_URL',
      allowedHosts: ['okx.com'], passphraseEnv: cfg.passphraseEnv || 'OKX_API_PASSPHRASE'
    });
    this.capabilities.protectiveStopImplemented = true; // kodda var; sandbox/hesap doğrulaması ayrı
    this.nowFn = opts.nowFn || (() => Date.now());
    this.simulated = opts.simulated === true || process.env.OKX_SIMULATED === '1';
  }

  normalizeSymbol(s) { const [b, q] = String(s).toUpperCase().split('/'); if (!b || !q) throw new Error('OKX sembolü BASE/QUOTE olmalı'); return `${b}-${q}`; }
  _local(instId) { return String(instId || '').toUpperCase().replace('-', '/'); }
  _clOrdId(cid) { return deterministicHex(cid, 32); }

  // ---- imzalama -------------------------------------------------------------------------------
  _sign(timestamp, method, requestPath, body) {
    this._requireCredentials({ passphrase: true });
    return crypto.createHmac('sha256', this.apiSecret).update(`${timestamp}${method}${requestPath}${body}`, 'utf8').digest('base64');
  }

  _buildRequest(method, path, { query = null, body = null } = {}) {
    this._requireCredentials({ passphrase: true });
    const m = method.toUpperCase();
    const qs = query ? new URLSearchParams(query).toString() : '';
    const requestPath = `${path}${qs ? `?${qs}` : ''}`;
    const bodyStr = body === null || body === undefined ? '' : JSON.stringify(body);
    const timestamp = new Date(this.nowFn()).toISOString();
    const headers = {
      Accept: 'application/json', 'Content-Type': 'application/json',
      'OK-ACCESS-KEY': this.apiKey, 'OK-ACCESS-SIGN': this._sign(timestamp, m, requestPath, bodyStr),
      'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': this.apiPassphrase
    };
    if (this.simulated) headers['x-simulated-trading'] = '1';
    return { method: m, url: `${this.baseUrl}${requestPath}`, headers, body: bodyStr || undefined };
  }

  // OKX hata modeli: HTTP 200 + {code,msg,data}; emir yanıtlarında data[0].sCode ayrıca kontrol edilir.
  async _private(method, path, opts = {}, { mutating = false } = {}) {
    const d = await this._send(this._buildRequest(method, path, opts), { mutating });
    const fail = (code, msg, unknownCandidate) => {
      const err = new Error(`OKX API ${code}: ${msg || 'hata'}`);
      err.exchange = this.id; err.okxCode = String(code);
      if (mutating && (unknownCandidate || AMBIGUOUS_CODES.has(String(code)))) err.unknownOutcome = true;
      if (NOT_FOUND_CODES.has(String(code))) err.orderNotFound = true;
      return err;
    };
    if (d.code !== undefined && String(d.code) !== '0') {
      const first = Array.isArray(d.data) ? d.data[0] : null;
      throw fail(first?.sCode && first.sCode !== '0' ? first.sCode : d.code, first?.sMsg || d.msg);
    }
    if (!Array.isArray(d.data)) { const e = new Error('OKX yanıtında data dizisi yok.'); e.exchange = this.id; if (mutating) e.unknownOutcome = true; throw e; }
    const first = d.data[0];
    if (mutating && first && first.sCode !== undefined && String(first.sCode) !== '0') throw fail(first.sCode, first.sMsg);
    return d.data;
  }

  // ---- normalizasyon --------------------------------------------------------------------------
  _normalizeOrder(o = {}, { clientOrderId, symbol } = {}) {
    const exec = Number(o.accFillSz || 0);
    const state = String(o.state || '').toLowerCase();
    let st;
    if (state === 'live') st = 'NEW';
    else if (state === 'partially_filled') st = 'PARTIALLY_FILLED';
    else if (state === 'filled') st = 'FILLED';
    else if (state === 'canceled' || state === 'mmp_canceled') st = 'CANCELED';
    else st = 'UNKNOWN';
    const sym = symbol || this._local(o.instId);
    const avg = Number(o.avgPx);
    const fee = Number(o.fee);
    const feeCcy = String(o.feeCcy || '').toUpperCase();
    return {
      orderId: o.ordId ?? null, exchangeOrderId: o.ordId ?? null,
      clientOrderId: clientOrderId || null, exchangeClientOrderId: o.clOrdId || null,
      symbol: sym, side: String(o.side || '').toLowerCase(), status: st,
      executedQty: exec, origQty: Number(o.sz || 0), cummulativeQuoteQty: Number.isFinite(avg) && avg > 0 ? exec * avg : 0,
      price: Number(o.px || 0), createTime: o.cTime ? Number(o.cTime) : null,
      // OKX fee: kesinti negatif gelir (ör. -0.001). Komisyon pozitif tutar olarak aktarılır.
      fills: Number.isFinite(fee) && fee < 0 && feeCcy ? [{ commission: Math.abs(fee), commissionAsset: feeCcy }] : []
    };
  }

  _normalizeAlgo(a = {}, { clientOrderId, symbol } = {}) {
    const state = String(a.state || '').toLowerCase();
    const map = { live: 'NEW', pause: 'NEW', canceled: 'CANCELED', order_failed: 'REJECTED' };
    // effective/partially_effective: tetiklendi ve gerçek emir verildi. Gerçek dolum bu kayıttan okunamaz => UNKNOWN.
    const st = map[state] || 'UNKNOWN';
    return {
      orderId: a.algoId ? `algo:${a.algoId}` : null, exchangeOrderId: a.algoId ? `algo:${a.algoId}` : null,
      clientOrderId: clientOrderId || null, exchangeClientOrderId: a.algoClOrdId || null,
      symbol: symbol || this._local(a.instId), side: String(a.side || 'sell').toLowerCase(), status: st,
      executedQty: 0, origQty: Number(a.sz || 0), cummulativeQuoteQty: 0, price: 0, stopPrice: Number(a.slTriggerPx || 0),
      triggeredOrderId: a.ordId || null, fills: []
    };
  }

  // ---- özel yöntemler -------------------------------------------------------------------------
  async fetchBalance() {
    const d = await this._private('GET', '/api/v5/account/balance');
    const details = d[0]?.details;
    if (!Array.isArray(details)) throw new Error('OKX bakiye cevabı şema doğrulamasını geçemedi.');
    const out = {};
    for (const b of details) {
      const asset = String(b.ccy || '').toUpperCase();
      const free = Number(b.availBal), locked = Number(b.frozenBal || 0);
      if (asset && Number.isFinite(free) && (free > 0 || locked > 0)) out[asset] = { free, locked };
    }
    return out;
  }

  async fetchOpenOrders(symbols = []) {
    const list = Array.isArray(symbols) && symbols.length ? symbols : [null];
    const all = [];
    for (const symbol of list) {
      const query = { instType: 'SPOT', limit: '100' };
      if (symbol) query.instId = this.normalizeSymbol(symbol);
      const d = await this._private('GET', '/api/v5/trade/orders-pending', { query });
      if (d.length >= 100) throw new Error('OKX açık emir listesi sayfalama sınırına ulaştı; eksik liste güvenli değil, işlem durduruldu.');
      for (const o of d) all.push(this._normalizeOrder(o));
      const algo = await this._private('GET', '/api/v5/trade/orders-algo-pending', { query: { ordType: 'conditional', instType: 'SPOT', ...(symbol ? { instId: this.normalizeSymbol(symbol) } : {}) } });
      for (const a of algo) all.push(this._normalizeAlgo(a));
    }
    return all;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const s = sideOf(side, this.name);
    const cid = requireClientOrderId(clientOrderId, this.name);
    const body = { instId: this.normalizeSymbol(symbol), tdMode: 'cash', side: s, ordType: 'market', sz: plain(positiveNumber(amount, 'miktar', this.name), 8), tgtCcy: 'base_ccy', clOrdId: this._clOrdId(cid) };
    const d = await this._private('POST', '/api/v5/trade/order', { body }, { mutating: true });
    const r = d[0] || {};
    const created = this._assertCreated({ orderId: r.ordId || null, exchangeOrderId: r.ordId || null, clientOrderId: cid, symbol, side: s, status: 'NEW', origQty: Number(body.sz), executedQty: 0, fills: [] }, { clientOrderId: cid, side: s });
    if (r.clOrdId && r.clOrdId !== body.clOrdId) { const e = new Error('OKX clOrdId yanıtta farklı; sonuç belirsiz.'); e.unknownOutcome = true; throw e; }
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (sideOf(side, this.name) !== 'sell') throw new Error('OKX koruyucu stop yalnızca sell olabilir.');
    const cid = requireClientOrderId(clientOrderId, this.name);
    const body = {
      instId: this.normalizeSymbol(symbol), tdMode: 'cash', side: 'sell', ordType: 'conditional', tgtCcy: 'base_ccy',
      sz: plain(positiveNumber(amount, 'miktar', this.name), 8), slTriggerPx: plain(positiveNumber(stopPrice, 'stop fiyatı', this.name), 8),
      slOrdPx: '-1', slTriggerPxType: 'last', algoClOrdId: this._clOrdId(cid)
    };
    const d = await this._private('POST', '/api/v5/trade/order-algo', { body }, { mutating: true });
    const r = d[0] || {};
    const created = this._assertCreated({ orderId: r.algoId ? `algo:${r.algoId}` : null, exchangeOrderId: r.algoId ? `algo:${r.algoId}` : null, clientOrderId: cid, symbol, side: 'sell', status: 'NEW', origQty: Number(body.sz), executedQty: 0, stopPrice: Number(body.slTriggerPx), fills: [] }, { clientOrderId: cid, side: 'sell' });
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async getOrder(symbol, orderId, clientOrderId) {
    const instId = this.normalizeSymbol(symbol);
    const hasId = orderId !== undefined && orderId !== null && orderId !== '';
    const isAlgo = hasId && String(orderId).startsWith('algo:');
    try {
      if (isAlgo) {
        const d = await this._private('GET', '/api/v5/trade/order-algo', { query: { algoId: String(orderId).slice(5) } });
        if (!d[0]) { const e = new Error('OKX algo emir bulunamadı.'); e.orderNotFound = true; throw e; }
        return this._normalizeAlgo(d[0], { clientOrderId, symbol });
      }
      if (!hasId && !clientOrderId) throw new Error('OKX getOrder için orderId veya clientOrderId gerekli.');
      const query = hasId ? { instId, ordId: String(orderId) } : { instId, clOrdId: this._clOrdId(clientOrderId) };
      const d = await this._private('GET', '/api/v5/trade/order', { query });
      if (!d[0]) { const e = new Error('OKX emir bulunamadı.'); e.orderNotFound = true; throw e; }
      return this._normalizeOrder(d[0], { clientOrderId, symbol });
    } catch (err) {
      if (err.orderNotFound) err.message += ' — OKX dolmamış iptal emirleri kısa süre sonra saklamaz; bu "emir yok" kanıtı değildir, emir UNKNOWN kalmalı.';
      throw err;
    }
  }

  async cancelOrder(symbol, orderId) {
    if (orderId === undefined || orderId === null || orderId === '') throw new Error('OKX iptal için borsa emir kimliği gerekli.');
    const instId = this.normalizeSymbol(symbol);
    if (String(orderId).startsWith('algo:')) await this._private('POST', '/api/v5/trade/cancel-algos', { body: [{ algoId: String(orderId).slice(5), instId }] }, { mutating: true });
    else await this._private('POST', '/api/v5/trade/cancel-order', { body: { instId, ordId: String(orderId) } }, { mutating: true });
    try {
      const o = await this.getOrder(symbol, orderId);
      return o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' ? { ...o, status: 'UNKNOWN' } : o;
    } catch (_) {
      return { orderId, exchangeOrderId: orderId, symbol, status: 'UNKNOWN', executedQty: 0 };
    }
  }

  // ---- genel piyasa verisi --------------------------------------------------------------------
  async _ok(path, p = {}) { const d = await this._get(path, p); if (d.code !== undefined && d.code !== '0') throw new Error(`OKX API ${d.code}: ${d.msg || 'hata'}`); return d.data || []; }
  async fetchTicker(s) { const d = (await this._ok('/api/v5/market/ticker', { instId: this.normalizeSymbol(s) }))[0]; if (!d) throw new Error('OKX ticker yok'); return { symbol: s, price: Number(d.last), bid: Number(d.bidPx), ask: Number(d.askPx), volume: Number(d.vol24h) }; }
  async fetchAllTickers24h() { return (await this._ok('/api/v5/market/tickers', { instType: 'SPOT' })).map(d => this._tickerRow(String(d.instId).replace('-', '/'), { last: d.last, open: d.open24h, quoteVolume: d.volCcy24h, high: d.high24h, low: d.low24h, baseVolume: d.vol24h })); }
  async fetchCandles(s, tf = '1h', limit = 200) { const bar = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' }[tf]; if (!bar) throw new Error('OKX desteklenmeyen timeframe'); const d = await this._ok('/api/v5/market/candles', { instId: this.normalizeSymbol(s), bar, limit: String(Math.min(limit, 300)) }); return Base.validateCandleRows(d.slice().reverse().map(x => ({ t: Number(x[0]), o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] })), { source: this.name }); }
  async fetchSymbolRules(s) {
    const d = await this._ok('/api/v5/public/instruments', { instType: 'SPOT', instId: this.normalizeSymbol(s) });
    const x = d[0];
    if (!x) throw new Error('OKX instrument bulunamadı');
    if (x.state && x.state !== 'live') throw new Error(`OKX ${s}: instrument durumu ${x.state}; canlı emir durduruldu.`);
    const [base, quote] = String(s).toUpperCase().split('/');
    // OKX SPOT minSz/lotSz are base-currency quantity rules. maxMktSz is reported in USDT,
    // not base units, so it must never be compared against a base-asset quantity. The public
    // SPOT instrument schema does not provide a separate minNotional field; enforce minSz instead.
    return this._rules(s, { stepSize: x.lotSz, minQty: x.minSz, maxQty: 0, tickSize: x.tickSz, minNotional: 0, minNotionalMode: 'quantity-only', base, quote });
  }
  async fetchOrderBook(s, limit = 20) { const x = (await this._ok('/api/v5/market/books', { instId: this.normalizeSymbol(s), sz: String(Math.min(limit, 400)) }))[0]; return { bids: (x?.bids || []).map(a => [Number(a[0]), Number(a[1])]), asks: (x?.asks || []).map(a => [Number(a[0]), Number(a[1])]) }; }
}
module.exports = OkxAdapter;
