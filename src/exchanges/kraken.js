// src/exchanges/kraken.js
//
// Kraken Spot REST adaptörü — Stage 4: özel API.
// Resmî belge: https://docs.kraken.com/api/  (host: https://api.kraken.com)
//
// Kimlik doğrulama (POST, form-urlencoded):
//   API-Key: key
//   API-Sign: base64( HMAC-SHA512( base64decode(secret), uriPath + SHA256(nonce + postData) ) )
//   nonce: artan tamsayı (burada mikro-saniye ölçeğinde, süreç içinde kesin artan)
//
// İstemci kimliği: cl_ord_id (AddOrder, CancelOrder, OpenOrders, ClosedOrders; Haziran/Eylül 2024 değişiklik günlüğü).
//   Biçim: UUID. Botun kimliği deterministik UUID'ye çevrilir. cl_ord_id benzersizliği yalnızca AÇIK emirlerde
//   doğrulanır; botun kimlikleri zaten tekildir.
// Kurtarma: txid bilinmiyorsa önce OpenOrders{cl_ord_id}, sonra ClosedOrders{cl_ord_id} sorgulanır.
//   İkisinde de yoksa bu "emir yok" kanıtı DEĞİLDİR (geçmiş gecikebilir): err.orderNotFound=true, emir UNKNOWN kalır.
//
// Koruyucu stop: ordertype=stop-loss (stop-market). liveTradingVerified=false.

const crypto = require('crypto');
const PrivateAdapterBase = require('./privateBase');
const Base = require('./base');
const { deterministicUuid, requireClientOrderId, positiveNumber, sideOf, plain, decimalsFromStep } = PrivateAdapterBase.helpers;
const interval = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
const ALIAS = { XBT: 'BTC', XXBT: 'BTC', XDG: 'DOGE', XXDG: 'DOGE', XETH: 'ETH', XLTC: 'LTC', XXRP: 'XRP', XXLM: 'XLM', XXMR: 'XMR', XETC: 'ETC', XZEC: 'ZEC' };
const FIAT = { ZUSD: 'USD', ZEUR: 'EUR', ZGBP: 'GBP', ZCAD: 'CAD', ZJPY: 'JPY', ZAUD: 'AUD' };

// Kraken eşdeğer varlık kodlarını bot kodlarına çevirir (XXBT -> BTC, ZUSD -> USD).
function assetCode(a) {
  const s = String(a || '').toUpperCase();
  if (FIAT[s]) return FIAT[s];
  if (ALIAS[s]) return ALIAS[s];
  return s;
}

// Sonucu belirsiz sayılacak servis hataları (emir kabul edilmiş olabilir).
const AMBIGUOUS_ERROR = /^(EService:|EGeneral:Internal error|EGeneral:Temporary lockout)/i;

class KrakenAdapter extends PrivateAdapterBase {
  constructor(opts = {}) {
    super(opts, { id: 'kraken', name: 'Kraken', quoteAssets: ['USD', 'EUR', 'USDT'], baseUrl: 'https://api.kraken.com', baseUrlEnv: 'KRAKEN_BASE_URL', allowedHosts: ['kraken.com'] });
    this.capabilities.protectiveStopImplemented = true; // kodda var; sandbox/hesap doğrulaması ayrı
    this.nowFn = opts.nowFn || (() => Date.now());
    this._lastNonce = 0;
    this._symbolByPair = new Map();
  }

  normalizeSymbol(s) {
    const parts = String(s).toUpperCase().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Kraken sembolü BASE/QUOTE olmalı');
    const aliases = { BTC: 'XBT', DOGE: 'XDG' };
    const b = aliases[parts[0]] || parts[0];
    const pair = `${b}${parts[1]}`;
    this._symbolByPair.set(pair, String(s).toUpperCase());
    return pair;
  }
  _localFromPair(pair, fallback) {
    if (fallback) return fallback;
    const p = String(pair || '').toUpperCase();
    return this._symbolByPair.get(p) || p;
  }

  _nextNonce() {
    this._lastNonce = Math.max(this._lastNonce + 1, this.nowFn() * 1000);
    return String(this._lastNonce);
  }

  // ---- imzalama -------------------------------------------------------------------------------
  _sign(path, nonce, postData) {
    this._requireCredentials();
    const hash = crypto.createHash('sha256').update(`${nonce}${postData}`, 'utf8').digest();
    return crypto.createHmac('sha512', Buffer.from(this.apiSecret, 'base64')).update(Buffer.concat([Buffer.from(path, 'utf8'), hash])).digest('base64');
  }

  _buildRequest(endpoint, params = {}) {
    this._requireCredentials();
    const path = `/0/private/${endpoint}`;
    const nonce = this._nextNonce();
    const form = new URLSearchParams({ nonce });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.append(k, String(v));
    const postData = form.toString();
    return {
      method: 'POST', url: `${this.baseUrl}${path}`,
      headers: { 'API-Key': this.apiKey, 'API-Sign': this._sign(path, nonce, postData), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: postData
    };
  }

  async _private(endpoint, params = {}, { mutating = false } = {}) {
    const data = await this._send(this._buildRequest(endpoint, params), { mutating });
    if (Array.isArray(data.error) && data.error.length) {
      const err = new Error(`Kraken API: ${data.error.join('; ')}`);
      err.exchange = this.id; err.krakenErrors = data.error;
      if (mutating && data.error.some((e) => AMBIGUOUS_ERROR.test(e))) err.unknownOutcome = true;
      throw err;
    }
    if (!data || typeof data.result !== 'object' || data.result === null) {
      const err = new Error('Kraken yanıtında result alanı yok.');
      err.exchange = this.id; if (mutating) err.unknownOutcome = true;
      throw err;
    }
    return data.result;
  }

  // ---- normalizasyon --------------------------------------------------------------------------
  _normalizeOrder(txid, o = {}, { clientOrderId, symbol } = {}) {
    const exec = Number(o.vol_exec || 0), vol = Number(o.vol || 0);
    const status = String(o.status || '').toLowerCase();
    let st;
    if (status === 'pending') st = 'NEW';
    else if (status === 'open') st = exec > 0 ? 'PARTIALLY_FILLED' : 'NEW';
    else if (status === 'closed') st = vol > 0 && exec + 1e-12 < vol ? 'UNKNOWN' : 'FILLED';
    else if (status === 'canceled' || status === 'cancelled') st = 'CANCELED';
    else if (status === 'expired') st = 'EXPIRED';
    else st = 'UNKNOWN';
    const sym = this._localFromPair(o.descr?.pair, symbol);
    const quote = String(sym).includes('/') ? String(sym).split('/')[1] : null;
    const fee = Number(o.fee);
    return {
      orderId: txid ?? null, exchangeOrderId: txid ?? null,
      clientOrderId: clientOrderId || null, exchangeClientOrderId: o.cl_ord_id || null,
      symbol: sym, side: String(o.descr?.type || '').toLowerCase(), status: st,
      executedQty: exec, origQty: vol, cummulativeQuoteQty: Number(o.cost || 0),
      price: Number(o.descr?.price || 0), stopPrice: Number(o.stopprice || o.descr?.price || 0), createTime: o.opentm || null,
      fills: Number.isFinite(fee) && fee > 0 && quote ? [{ commission: fee, commissionAsset: quote }] : []
    };
  }

  // ---- özel yöntemler -------------------------------------------------------------------------
  async fetchBalance() {
    const r = await this._private('BalanceEx');
    const out = {};
    for (const [rawAsset, v] of Object.entries(r)) {
      if (rawAsset.includes('.')) continue; // .S/.F/.M/.B/.HOLD: stake/opt-in varlıkları serbest bakiye sayılmaz
      const total = Number(v?.balance), hold = Number(v?.hold_trade || 0);
      if (!Number.isFinite(total)) continue;
      const free = Math.max(0, total - hold);
      if (free > 0 || hold > 0) out[assetCode(rawAsset)] = { free, locked: hold };
    }
    return out;
  }

  async fetchOpenOrders(symbols = []) {
    const r = await this._private('OpenOrders', { trades: false });
    if (!r.open || typeof r.open !== 'object') throw new Error('Kraken açık emir cevabı şema doğrulamasını geçemedi.');
    const wanted = new Set((Array.isArray(symbols) ? symbols : []).map((s) => this.normalizeSymbol(s)));
    const out = [];
    for (const [txid, o] of Object.entries(r.open)) {
      const pair = String(o.descr?.pair || '').toUpperCase().replace('/', '');
      if (wanted.size && !wanted.has(pair)) continue;
      out.push(this._normalizeOrder(txid, o));
    }
    return out;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const s = sideOf(side, this.name);
    const cid = requireClientOrderId(clientOrderId, this.name);
    const volume = plain(positiveNumber(amount, 'miktar', this.name), 10);
    const r = await this._private('AddOrder', { ordertype: 'market', type: s, volume, pair: this.normalizeSymbol(symbol), cl_ord_id: deterministicUuid(cid) }, { mutating: true });
    const txid = Array.isArray(r.txid) ? r.txid[0] : r.txid;
    const created = this._assertCreated({ orderId: txid ?? null, exchangeOrderId: txid ?? null, clientOrderId: cid, symbol, side: s, status: 'NEW', origQty: Number(volume), executedQty: 0, fills: [] }, { clientOrderId: cid, side: s });
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (sideOf(side, this.name) !== 'sell') throw new Error('Kraken koruyucu stop yalnızca sell olabilir.');
    const cid = requireClientOrderId(clientOrderId, this.name);
    const volume = plain(positiveNumber(amount, 'miktar', this.name), 10);
    const stop = positiveNumber(stopPrice, 'stop fiyatı', this.name);
    const rules = await this.fetchSymbolRules(symbol);
    const price = rules.tickSize > 0 ? Number((Math.floor(stop / rules.tickSize + 1e-9) * rules.tickSize).toFixed(decimalsFromStep(rules.tickSize))) : stop;
    const r = await this._private('AddOrder', { ordertype: 'stop-loss', type: 'sell', volume, pair: this.normalizeSymbol(symbol), price: plain(price, 10), trigger: 'last', cl_ord_id: deterministicUuid(cid) }, { mutating: true });
    const txid = Array.isArray(r.txid) ? r.txid[0] : r.txid;
    const created = this._assertCreated({ orderId: txid ?? null, exchangeOrderId: txid ?? null, clientOrderId: cid, symbol, side: 'sell', status: 'NEW', origQty: Number(volume), executedQty: 0, stopPrice: price, fills: [] }, { clientOrderId: cid, side: 'sell' });
    return this._enrichAfterCreate(created, symbol, cid);
  }

  async getOrder(symbol, orderId, clientOrderId) {
    if (orderId !== undefined && orderId !== null && orderId !== '') {
      const r = await this._private('QueryOrders', { txid: orderId, trades: false });
      const o = r[orderId];
      if (!o) { const e = new Error(`Kraken emir bulunamadı: ${orderId}`); e.orderNotFound = true; throw e; }
      return this._normalizeOrder(orderId, o, { clientOrderId, symbol });
    }
    if (!clientOrderId) throw new Error('Kraken getOrder için orderId veya clientOrderId gerekli.');
    const cl = deterministicUuid(clientOrderId);
    const open = await this._private('OpenOrders', { cl_ord_id: cl, trades: false });
    const o1 = open.open && Object.entries(open.open)[0];
    if (o1) return this._normalizeOrder(o1[0], o1[1], { clientOrderId, symbol });
    const closed = await this._private('ClosedOrders', { cl_ord_id: cl, trades: false });
    const o2 = closed.closed && Object.entries(closed.closed)[0];
    if (o2) return this._normalizeOrder(o2[0], o2[1], { clientOrderId, symbol });
    const e = new Error('Kraken: cl_ord_id ile ne açık ne kapalı emir bulundu. Bu "emir yok" kanıtı değildir; emir UNKNOWN kalmalı, otomatik tekrar gönderilmemeli.');
    e.orderNotFound = true; throw e;
  }

  async cancelOrder(symbol, orderId) {
    if (orderId === undefined || orderId === null || orderId === '') throw new Error('Kraken iptal için borsa emir kimliği gerekli.');
    await this._private('CancelOrder', { txid: orderId }, { mutating: true });
    try {
      const o = await this.getOrder(symbol, orderId);
      return o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' ? { ...o, status: 'UNKNOWN' } : o;
    } catch (_) {
      return { orderId, exchangeOrderId: orderId, symbol, status: 'UNKNOWN', executedQty: 0 };
    }
  }

  // ---- genel piyasa verisi --------------------------------------------------------------------
  async fetchTicker(s) { const d = await this._get('/0/public/Ticker', { pair: this.normalizeSymbol(s) }); if (Array.isArray(d.error) && d.error.length) throw new Error(`Kraken API: ${d.error.join('; ')}`); const v = Object.values(d.result || {})[0]; if (!v) throw new Error('Kraken ticker sonucu yok'); return { symbol: s, price: Number(v.c?.[0]), bid: Number(v.b?.[0]), ask: Number(v.a?.[0]), volume: Number(v.v?.[1]) }; }
  async fetchAllTickers24h() {
    const d = await this._get('/0/public/Ticker');
    if (Array.isArray(d.error) && d.error.length) throw new Error(`Kraken API: ${d.error.join('; ')}`);
    const pairs = await this._get('/0/public/AssetPairs');
    if (Array.isArray(pairs.error) && pairs.error.length) throw new Error(`Kraken API: ${pairs.error.join('; ')}`);
    const out = [];
    for (const [key, v] of Object.entries(d.result || {})) {
      const info = pairs.result?.[key];
      const ws = String(info?.wsname || '');
      if (!ws.includes('/')) continue; // eşlenemeyen pair yanlış sembolle sunulmaz
      const [b, q] = ws.split('/').map(assetCode);
      const vwap24 = Number(v.p?.[1]);
      out.push(this._tickerRow(`${b}/${q}`, { last: v.c?.[0], open: v.o, quoteVolume: Number(v.v?.[1]) * (Number.isFinite(vwap24) && vwap24 > 0 ? vwap24 : Number(v.c?.[0])), high: v.h?.[1], low: v.l?.[1], baseVolume: v.v?.[1] }));
    }
    return out;
  }
  async fetchCandles(s, tf = '1h', limit = 200) { if (!interval[tf]) throw new Error('Kraken desteklenmeyen timeframe'); const d = await this._get('/0/public/OHLC', { pair: this.normalizeSymbol(s), interval: interval[tf] }); if (Array.isArray(d.error) && d.error.length) throw new Error(`Kraken API: ${d.error.join('; ')}`); const k = Object.keys(d.result || {}).find(x => x !== 'last'); return Base.validateCandleRows((d.result?.[k] || []).slice(-limit).map(x => ({ t: Number(x[0]) * 1000, o: x[1], h: x[2], l: x[3], c: x[4], v: x[6] })), { source: this.name }); }
  async fetchSymbolRules(s) {
    const d = await this._get('/0/public/AssetPairs', { pair: this.normalizeSymbol(s) });
    if (Array.isArray(d.error) && d.error.length) throw new Error(`Kraken API: ${d.error.join('; ')}`);
    const p = Object.values(d.result || {})[0];
    if (!p) throw new Error('Kraken pair bulunamadı');
    if (p.status && p.status !== 'online') throw new Error(`Kraken ${s}: pair durumu ${p.status}; canlı emir durduruldu.`);
    const [base, quote] = String(s).toUpperCase().split('/');
    const lot = 10 ** (-Number(p.lot_decimals ?? 8));
    const tick = Number(p.tick_size) || 10 ** (-Number(p.pair_decimals ?? 2));
    return this._rules(s, { stepSize: lot, minQty: Number(p.ordermin), tickSize: tick, minNotional: Number(p.costmin || 0), base, quote });
  }
  async fetchOrderBook(s, limit = 20) { const d = await this._get('/0/public/Depth', { pair: this.normalizeSymbol(s), count: Math.min(limit, 500) }); if (Array.isArray(d.error) && d.error.length) throw new Error(`Kraken API: ${d.error.join('; ')}`); const v = Object.values(d.result || {})[0]; return { bids: (v?.bids || []).map(x => [Number(x[0]), Number(x[1])]), asks: (v?.asks || []).map(x => [Number(x[0]), Number(x[1])]) }; }
}
module.exports = KrakenAdapter;
module.exports.assetCode = assetCode;
