// Paribu Spot REST adapter.
// Public market data: https://www.paribu.com/ticker
// Private Spot API: https://api.paribu.com
// Paribu documents API-key + HMAC-SHA256 authentication and order creation at
// POST /order. Private endpoint paths are kept configurable because Paribu's
// documentation is versioned independently from the public web ticker.

const crypto = require('crypto');
const ExchangeAdapter = require('./base');
const { validateOrderArgs, validatePositivePrice, guardCreate } = require('./orderGuards');
const { fetchWithRetry } = require('../util/retry');

const PUBLIC_TICKER_URL = 'https://www.paribu.com/ticker';
const { assertAllowedUrl } = require('../util/hostGuard');
const API_BASE_URL = 'https://api.paribu.com';
const WEB_BASE_URL = 'https://web.paribu.com';

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function unwrap(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.data !== undefined) return data.data;
  if (data.result !== undefined) return data.result;
  return data;
}

class ParibuAdapter extends ExchangeAdapter {
  constructor(opts = {}) {
    super(opts);
    this.id = 'paribu';
    this.name = 'Paribu';
    this.quoteAssets = ['TRY', 'USDT'];
    this.marketBuyUsesQuote = true;
    this.capabilities = {
      // Paribu'nun bu adaptördeki kimlik sözleşmesi canlı olarak doğrulanmadan
      // fingerprint ile emir tahmini YAPILMAZ. Yanlış emri sahiplenme riski kabul edilemez.
      clientOrderId: false,
      marketBuyUsesQuote: true,
      recoveryByFingerprint: false,
      orderQuery: true,
      balanceQuery: true,
      openOrdersQuery: true,
      takeProfitOrder: false,
      protectiveStopImplemented: false,
      userDataStream: false,
      oco: false,
      nativeTrailingOco: false,
      marketOrderBook: false,
      liveTradingVerified: false
    };
    const envBase = process.env.PARIBU_BASE_URL ? assertAllowedUrl(process.env.PARIBU_BASE_URL, ['paribu.com'], 'PARIBU_BASE_URL') : '';
    this.baseUrl = String(opts.baseUrl || envBase || API_BASE_URL).replace(/\/+$/, '');
    this.tickerUrl = String(opts.tickerUrl || PUBLIC_TICKER_URL).replace(/\/+$/, '');
    const envWeb = process.env.PARIBU_WEB_BASE_URL ? assertAllowedUrl(process.env.PARIBU_WEB_BASE_URL, ['paribu.com'], 'PARIBU_WEB_BASE_URL') : '';
    this.webBaseUrl = String(opts.webBaseUrl || envWeb || WEB_BASE_URL).replace(/\/+$/, '');
    this.signaturePayload = String(opts.signaturePayload || process.env.PARIBU_SIGNATURE_PAYLOAD || 'auto').toLowerCase();
  }

  normalizeSymbol(symbol) {
    const s = String(symbol || '').toUpperCase().replace(/\s+/g, '');
    if (!s) throw new Error('Paribu sembolü boş olamaz.');
    if (s.includes('_')) {
      const [base, quote] = s.split('_');
      return `${base}_${quote === 'TRY' ? 'TL' : quote}`.toLowerCase();
    }
    const [base, quote] = s.split('/');
    if (!base || !quote) throw new Error(`Geçersiz Paribu sembolü: ${symbol}`);
    return `${base}_${quote === 'TRY' ? 'TL' : quote}`.toLowerCase();
  }

  _localSymbol(raw) {
    const s = String(raw || '').toUpperCase();
    const [base, quote] = s.split('_');
    return `${base}/${quote === 'TL' ? 'TRY' : quote}`;
  }

  _sign(payload) {
    if (!this.apiSecret) throw new Error('Paribu API secret tanımlı değil.');
    return crypto.createHmac('sha256', this.apiSecret).update(payload, 'utf8').digest('base64');
  }

  async _request(url, opts = {}, { privateRequest = false, payloadForSignature = '' } = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (privateRequest) {
      if (!this.apiKey || !this.apiSecret) throw new Error('Paribu canlı işlemleri için API key ve secret gerekli.');
      headers.Authorization = this.apiKey;
      headers['X-Signature'] = this._sign(payloadForSignature);
    }
    let res;
    const method = String(opts.method || 'GET').toUpperCase();
    try {
      const retries = privateRequest && (method === 'POST' || method === 'DELETE') ? 0 : 2;
      res = await fetchWithRetry(url, { ...opts, headers }, { retries, timeoutMs: 10000 });
    } catch (err) {
      if (privateRequest && (method === 'POST' || method === 'DELETE')) err.unknownOutcome = true;
      throw err;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${this.name} HTTP ${res.status}: ${body?.message || body?.msg || JSON.stringify(body).slice(0, 300)}`);
      err.httpStatus = res.status;
      err.exchange = this.id;
      if (privateRequest && res.status >= 500) err.unknownOutcome = method === 'POST' || method === 'DELETE';
      throw err;
    }
    if (body && body.success === false) {
      const err = new Error(`${this.name} API: ${body.message || body.msg || JSON.stringify(body).slice(0, 300)}`);
      err.exchange = this.id;
      throw err;
    }
    return unwrap(body);
  }

  async _publicTicker() {
    const res = await fetchWithRetry(this.tickerUrl, undefined, { retries: 2, timeoutMs: 10000 });
    if (!res.ok) throw new Error(`${this.name} ticker başarısız (${res.status})`);
    return res.json();
  }

  async fetchTicker(symbol) {
    const map = await this._publicTicker();
    const key = this.normalizeSymbol(symbol).toUpperCase();
    const t = map[key] || map[key.toLowerCase()];
    if (!t) throw new Error(`Paribu'da parite bulunamadı: ${symbol}`);
    return { symbol, price: num(t.last) };
  }

  async fetchAllTickers24h() {
    const map = await this._publicTicker();
    return Object.entries(map).map(([key, t]) => ({
      symbol: this._localSymbol(key),
      lastPrice: num(t.last),
      changePct: num(t.percentChange),
      quoteVolume: num(t.volume) * num(t.last),
      highPrice: num(t.high24hr),
      lowPrice: num(t.low24hr)
    }));
  }

  async fetchCandles(symbol, timeframe = '1h', limit = 300) {
    const periods = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1d': '1d', '3d': '3d', '1w': '1w', '1M': '1M' };
    const period = periods[timeframe] || periods[String(timeframe).toLowerCase()];
    if (!period) throw new Error(`Paribu desteklenmeyen mum aralığı: ${timeframe}`);
    const params = new URLSearchParams({ symbol: this.normalizeSymbol(symbol), period, type: 'basic' });
    const url = `${this.webBaseUrl}/chart/history?${params}`;
    const res = await fetchWithRetry(url, undefined, { retries: 2, timeoutMs: 10000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${this.name} kline başarısız (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
    const raw = data?.payload || data?.data || data;
    const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : null);
    if (!rows) {
      const t = raw?.t || raw?.time || raw?.timestamps;
      const o = raw?.o || raw?.open; const h = raw?.h || raw?.high; const l = raw?.l || raw?.low; const c = raw?.c || raw?.close; const v = raw?.v || raw?.volume;
      if ([t,o,h,l,c,v].every(Array.isArray)) {
        return t.map((x,i)=>({ t:Number(x) < 1e12 ? Number(x)*1000 : Number(x), o:num(o[i]), h:num(h[i]), l:num(l[i]), c:num(c[i]), v:num(v[i]) })).slice(-Math.min(1000, Math.max(2, Number(limit)||300)));
      }
      throw new Error('Paribu kline cevabı beklenen OHLC biçiminde değil.');
    }
    const out = rows.map((k) => ({
      t: Number(k.t ?? k.time ?? k.timestamp ?? k[0]) < 1e12 ? Number(k.t ?? k.time ?? k.timestamp ?? k[0]) * 1000 : Number(k.t ?? k.time ?? k.timestamp ?? k[0]),
      o: num(k.o ?? k.open ?? k[1]), h: num(k.h ?? k.high ?? k[2]), l: num(k.l ?? k.low ?? k[3]), c: num(k.c ?? k.close ?? k[4]), v: num(k.v ?? k.volume ?? k[5])
    }));
    return out.slice(-Math.min(1000, Math.max(2, Number(limit)||300)));
  }

  async fetchSymbolRules(symbol) {
    const market = this.normalizeSymbol(symbol);
    const map = await this._publicTicker();
    if (!map[market.toUpperCase()] && !map[market.toLowerCase()]) throw new Error(`Paribu'da parite bulunamadı: ${symbol}`);

    // Paribu's official wrapper exposes exchange information at web.paribu.com/initials/config.
    // The response shape has changed over time, so discovery is deliberately schema-tolerant but
    // never fabricates a precision/limit: if the venue does not expose a rule, live trading stops.
    const res = await fetchWithRetry(`${this.webBaseUrl}/initials/config`, undefined, { retries: 2, timeoutMs: 10000 });
    const cfg = await res.json().catch(() => ({}));
    const wanted = market.toLowerCase();
    const variants = new Set([wanted, wanted.replace('_tl','_try'), wanted.replace('_try','_tl'), wanted.replace('_','')]);
    let found = null;
    const walk = (node) => {
      if (found || node == null) return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (typeof node !== 'object') return;
      const sym = String(node.market ?? node.symbol ?? node.pair ?? node.name ?? '').toLowerCase();
      if (variants.has(sym)) found = node;
      else for (const v of Object.values(node)) walk(v);
    };
    walk(cfg?.payload ?? cfg?.data ?? cfg);
    const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && Number.isFinite(Number(o[k]))) return Number(o[k]); return 0; };
    const base = market.split('_')[0].toUpperCase();
    const quote = market.split('_')[1].toUpperCase() === 'TL' ? 'TRY' : market.split('_')[1].toUpperCase();
    if (!found) throw new Error(`Paribu işlem kuralları alınamadı: ${symbol}; canlı emir güvenlik nedeniyle durduruldu.`);
    const precision = pick(found, ['precision','amountPrecision','quantityPrecision','basePrecision']);
    const step = pick(found, ['stepSize','amountStep','quantityStep','amount_step']) || (precision > 0 ? Math.pow(10, -precision) : 0);
    const minQty = pick(found, ['minQty','minimumAmount','minAmount','minimumQuantity']);
    const maxQty = pick(found, ['maxQty','maximumAmount','maxAmount','maximumQuantity']);
    const tick = pick(found, ['tickSize','priceStep','price_step']);
    const minPrice = pick(found, ['minPrice','minimumPrice']);
    const maxPrice = pick(found, ['maxPrice','maximumPrice']);
    const minNotional = pick(found, ['minNotional','minimumOrderValue','minOrderValue']) || (quote === 'TRY' ? 10 : 1);
    if (!(step > 0) && !(tick > 0)) throw new Error(`Paribu ${symbol} için miktar/fiyat hassasiyeti bulunamadı; canlı emir güvenlik nedeniyle durduruldu.`);
    return { symbol, stepSize: step, minQty, maxQty, marketStepSize: step, marketMinQty: minQty, marketMaxQty: maxQty, tickSize: tick, minPrice, maxPrice, minNotional, baseAsset: base, quoteAsset: quote, orderTypes: found.orderTypes || ['market'], rulesSource: 'paribu-exchange-config', precisionKnown: true }; 
  }

  _privatePayload(method, path, body, query) {
    if (this.signaturePayload === 'body') return body ? JSON.stringify(body) : '';
    if (this.signaturePayload === 'query') return new URLSearchParams(query || {}).toString();
    if (this.signaturePayload === 'auto') return method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE' ? new URLSearchParams(query || {}).toString() : (body ? JSON.stringify(body) : '');
    if (this.signaturePayload === 'path') return path;
    return `${method.toUpperCase()} ${path}${body ? `\n${JSON.stringify(body)}` : ''}`;
  }

  async _private(method, path, { body = null, query = {} } = {}) {
    const qs = new URLSearchParams(query).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    return this._request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }, { privateRequest: true, payloadForSignature: this._privatePayload(method, path, body, query) });
  }

  _normalizeOrder(raw = {}, fallback = {}) {
    const o = raw?.order || raw?.data || raw;
    const statusMap = { open: 'NEW', active: 'NEW', new: 'NEW', partially_filled: 'PARTIALLY_FILLED', filled: 'FILLED', closed: 'FILLED', canceled: 'CANCELED', cancelled: 'CANCELED', rejected: 'REJECTED', expired: 'EXPIRED' };
    const statusRaw = String(o.status || fallback.status || 'NEW').toLowerCase();
    const oid = o.id ?? o.orderId ?? fallback.exchangeOrderId ?? null;
    return {
      // OrderManager.normalizeOrder ve AccountReconciler `orderId` alanını okur; yalnızca exchangeOrderId döndürmek
      // emir kimliğinin yerel kayda null yazılmasına yol açardı. İkisi de döndürülür.
      orderId: oid,
      exchangeOrderId: oid,
      clientOrderId: o.clientId ?? o.clientOrderId ?? o.newOrderClientId ?? fallback.clientOrderId ?? null,
      symbol: this._localSymbol(o.market || o.symbol || fallback.symbol || ''),
      side: String(o.trade || o.side || fallback.side || '').toLowerCase(),
      status: statusMap[statusRaw] || String(o.status || fallback.status || 'NEW').toUpperCase(),
      executedQty: num(o.executedAmount ?? o.executedQty ?? o.filled ?? 0),
      origQty: num(o.amount ?? o.quantity ?? fallback.amount ?? 0),
      cummulativeQuoteQty: num(o.executedQuoteAmount ?? o.executedQuoteQty ?? o.quoteQty ?? 0),
      price: num(o.price),
      stopPrice: num(o.stopPrice)
    };
  }

  async fetchBalance() {
    const data = await this._private('GET', '/user/assets');
    const rows = Array.isArray(data) ? data : (data?.balances || data?.assets || data?.list || []);
    const out = {};
    for (const b of rows) {
      const asset = String(b.asset || b.currency || b.symbol || '').toUpperCase();
      if (!asset) continue;
      const free = num(b.free ?? b.available ?? b.balance);
      const locked = num(b.locked ?? b.reserved ?? b.hold);
      if (free || locked) out[asset] = { free, locked };
    }
    return out;
  }

  async fetchOpenOrders(symbols = []) {
    const out = [];
    const list = Array.isArray(symbols) && symbols.length ? symbols : [null];
    for (const symbol of list) {
      const query = symbol ? { market: this.normalizeSymbol(symbol) } : {};
      const data = await this._private('GET', '/open-orders', { query });
      const valid = Array.isArray(data) || Array.isArray(data?.orders) || Array.isArray(data?.list);
      if (!valid) throw new Error('Paribu açık emir cevabı şema doğrulamasını geçemedi.');
      const rows = Array.isArray(data) ? data : (Array.isArray(data?.orders) ? data.orders : data.list);
      for (const row of rows) out.push(this._normalizeOrder(row));
    }
    return out;
  }

  _validateCreatedOrder(data, { symbol, side, amount, clientOrderId, stopPrice } = {}) {
    const order = this._normalizeOrder(data, { symbol, side, amount, clientOrderId, stopPrice, status: 'NEW' });
    const expectedSymbol = this.normalizeSymbol(symbol);
    const actualSymbol = this.normalizeSymbol(order.symbol.replace('/', '_'));
    const expectedSide = String(side || '').toLowerCase();
    const invalid = !order.exchangeOrderId
      || actualSymbol !== expectedSymbol
      || order.side !== expectedSide
      || !['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(order.status);
    if (invalid) {
      // The exchange may have accepted the order even if its response is malformed.
      // Propagate uncertainty so callers must reconcile instead of blindly retrying.
      const err = new Error('Paribu emir yanıtı kimlik/sembol/yön doğrulamasını geçemedi; emir sonucu belirsiz, otomatik tekrar gönderilmemeli.');
      err.exchange = this.id;
      err.unknownOutcome = true;
      err.orderResponseInvalid = true;
      throw err;
    }
    return order;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    // Paribu API'si istemci kimliği taşımaz; bu yüzden clientOrderId burada zorunlu tutulmaz.
    const v = validateOrderArgs('Paribu', { side, amount, clientOrderId, requireClientOrderId: false });
    const normalizedSide = v.side;
    amount = v.amount;
    const isBuy = normalizedSide === 'buy';
    const body = { market: this.normalizeSymbol(symbol), trade: normalizedSide, type: 'market' };
    if (isBuy) body.total = Number(amount); else body.amount = Number(amount);
    // Paribu's documented Spot API does not expose a client-order-id field.
    // Keep the local ID in our state, but never send an invented field.
    return guardCreate('Paribu', async () => {
      const data = await this._private('POST', '/order', { body });
      return this._validateCreatedOrder(data, { symbol, side: normalizedSide, amount, clientOrderId });
    }, { requireOrderId: false });
  }

  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (String(side).toLowerCase() !== 'sell') throw new Error('Paribu koruyucu stop yalnızca sell olabilir.');
    if (!(Number(amount) > 0) || !(Number(stopPrice) > 0)) throw new Error('Paribu stop için miktar ve koşul fiyatı zorunludur.');
    amount = validateOrderArgs('Paribu', { side, amount, clientOrderId, requireClientOrderId: false }).amount;
    stopPrice = validatePositivePrice('Paribu', 'koşul fiyatı', stopPrice);
    // Paribu koşullu emirleri trigger fiyatı ile bekleyen emir olarak tanımlar.
    // API sözleşmesi yanlış yorumlanır ve market emir anında gerçekleşirse bunu
    // sessizce "stop kuruldu" kabul etmek yerine canlı korumayı reddediyoruz.
    const body = { market: this.normalizeSymbol(symbol), trade: 'sell', type: 'market', amount: Number(amount), condition: Number(stopPrice) };
    const order = await guardCreate('Paribu', async () => {
      const data = await this._private('POST', '/order', { body });
      return this._validateCreatedOrder(data, { symbol, side: 'sell', amount, clientOrderId, stopPrice });
    }, { requireOrderId: false });
    if (order.status === 'FILLED' || Number(order.executedQty || 0) > 0) {
      throw new Error('Paribu koşullu stop beklenmedik şekilde hemen gerçekleşti; canlı koruma reddedildi.');
    }
    return order;
  }

  // ---- Danışma amaçlı (otomatik sahiplenmeyen) kurtarma kanıtı ---------------------------------
  // Paribu'da belgelenmiş istemci kimliği yok. POST'tan ÖNCE bu anlık görüntü alınır; belirsiz sonuçta
  // POST'tan SONRA ikinci görüntü ile karşılaştırılır. Sonuç yalnızca operatöre/alarma kanıt sunar:
  // hiçbir koşulda emir otomatik sahiplenilmez, capabilities.recoveryByFingerprint false kalır.
  async captureRecoverySnapshot(symbol) {
    const [open, balance] = await Promise.all([this.fetchOpenOrders([symbol]), this.fetchBalance()]);
    return { takenAt: Date.now(), symbol, openOrderIds: open.map((o) => String(o.orderId)), balance };
  }

  assessUnknownOrder(before, after, { side, amount } = {}) {
    const beforeIds = new Set(before?.openOrderIds || []);
    const newOpen = (after?.openOrderIds || []).filter((id) => !beforeIds.has(String(id)));
    const delta = {};
    for (const asset of new Set([...Object.keys(before?.balance || {}), ...Object.keys(after?.balance || {})])) {
      const b = before?.balance?.[asset] || { free: 0, locked: 0 };
      const a = after?.balance?.[asset] || { free: 0, locked: 0 };
      const d = (a.free + a.locked) - (b.free + b.locked);
      if (Math.abs(d) > 1e-12) delta[asset] = d;
    }
    const changedAssets = Object.keys(delta);
    let verdict = 'NO_EVIDENCE';
    const reasons = [];
    if (newOpen.length > 1) { verdict = 'AMBIGUOUS'; reasons.push('Birden fazla yeni açık emir var.'); }
    else if (newOpen.length === 1) { verdict = 'LIKELY_PRESENT'; reasons.push(`Yeni açık emir: ${newOpen[0]}`); }
    else if (changedAssets.length) { verdict = 'LIKELY_FILLED_OR_MANUAL'; reasons.push(`Bakiye değişti: ${changedAssets.join(', ')} (bot emri mi elle işlem mi ayırt edilemez).`); }
    else reasons.push('Anlık görüntüler arasında fark yok; bu "emir verilmedi" kanıtı DEĞİLDİR.');
    void side; void amount;
    return { verdict, newOpenOrderIds: newOpen, balanceDelta: delta, reasons, autoAdopt: false, requiresOperator: true };
  }

  async findOrderForRecovery(record = {}) {
    // Paribu adapter contract currently has no verified clientOrderId round-trip.
    // Symbol/side/amount/time fingerprints are not proof of ownership: a manual
    // order or an older bot order can have the same shape. Never auto-adopt one.
    // Keep this method fail-closed even if called directly by recovery code.
    void record;
    return null;
  }

  async getOrder(symbol, orderId, clientOrderId) {
    if (orderId == null) throw new Error('Paribu order sorgusu için exchange orderId gerekli; clientOrderId ile tahmin yapılmaz.');
    const data = await this._private('GET', `/order/${encodeURIComponent(orderId)}`);
    return this._normalizeOrder(data, { symbol, clientOrderId });
  }

  async cancelOrder(symbol, orderId) {
    const data = await this._private('DELETE', `/order/${encodeURIComponent(orderId)}`);
    return this._normalizeOrder(data, { symbol, orderId, status: 'CANCELED' });
  }
}

module.exports = ParibuAdapter;
