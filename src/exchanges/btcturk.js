// src/exchanges/btcturk.js
//
// BTCTurk Spot REST adaptoru. Herkese acik uclar dogrulanmis kaynaklardan
// alindi (docs.btcturk.com, ccxt'nin implicit endpoint listesi, resmi
// broker-api-docs deposu). Ozel (private) uclarin imzalama semasi da
// dogrulanmis kaynaktan (BTCTrader/broker-api-docs README) alindi.
//
// Public base:  https://api.btcturk.com/api/v2
// Private base: https://api.btcturk.com/api/v1
//
// Auth semasi (BTCTurk'e ozgu, Binance'ten FARKLI):
//   - Headers: X-PCK (api key), X-Stamp (nonce, ms cinsinden unix zaman), X-Signature
//   - message = apiKey + nonce  (duz string birlestirme, baska hicbir sey yok)
//   - HMAC anahtari = base64'ten COZULMUS (decode edilmis) API secret
//   - X-Signature = HMAC-SHA256(message, decoded_secret) sonucunun base64'u
//
// !!! DIKKAT - OHLC (MUM) VERISI GRANULARITESI DOGRULANAMADI !!!
// /api/v2/ohlc ucu resmi olarak dokumante, ama toplulugun yazdigi istemci
// kutuphaneleri bunu "gunluk" (daily) OHLC olarak tanimliyor. BTCTurk'un
// kendi grafik widget'i icin ayri, dokumante edilmemis bir "ucuncu host"
// kullandigina dair kaynaklar var (muhtemelen dakikalik/saatlik cozunurluk
// icin). Bu ucuncu hostu herkese acik dokumantasyonda bulamadim. Yani su an
// bu adaptorle 1h/4h/15m mum istegi, GERCEKTE GUNLUK veri donduruyor olabilir
// -- bu, EMA/RSI hesaplarini yanlislar. Canliya gecmeden once bunu gercek bir
// API cagrisiyla dogrula (panelden bir BTCTurk paritesi ekleyip loglardaki
// mum sayisini/araligini kontrol et).

const crypto = require('crypto');
const ExchangeAdapter = require('./base');
const { fetchWithRetry } = require('../util/retry');
const { validateOrderArgs, validatePositivePrice, guardCreate } = require('./orderGuards');

const { assertAllowedUrl } = require('../util/hostGuard');
const PUBLIC_BASE_URL = 'https://api.btcturk.com/api/v2';
const PRIVATE_BASE_URL = 'https://api.btcturk.com/api/v1';
const GRAPH_BASE_URL = 'https://graph-api.btcturk.com/v1';

class BtcturkAdapter extends ExchangeAdapter {
  constructor(opts = {}) {
    super(opts);
    this.id = 'btcturk';
    this.name = 'BTCTurk';
    this.quoteAssets = ['TRY', 'USDT'];
    this.marketBuyUsesQuote = true; // BTCTurk'te hem TRY hem USDT pariteleri var
    const envPrivate = process.env.BTCTURK_PRIVATE_BASE_URL ? assertAllowedUrl(process.env.BTCTURK_PRIVATE_BASE_URL, ['btcturk.com'], 'BTCTURK_PRIVATE_BASE_URL') : '';
    this.privateBaseUrl = String(opts.privateBaseUrl || envPrivate || PRIVATE_BASE_URL).replace(/\/+$/, '');
    this.capabilities = {
      clientOrderId: true,
      marketBuyUsesQuote: true,
      orderQuery: true,
      balanceQuery: true,
      openOrdersQuery: true,
      userDataStream: false,
      oco: false,
      nativeTrailingOco: false,
      marketOrderBook: true,
      protectiveStopImplemented: true,
      liveTradingVerified: false
    };
  }

  normalizeSymbol(symbol) {
    // "BTC/USDT" -> "BTCUSDT"
    return symbol.replace('/', '').toUpperCase();
  }

  async _publicGet(pathname, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${PUBLIC_BASE_URL}${pathname}${qs ? '?' + qs : ''}`;
    const res = await fetchWithRetry(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`${this.name} ${pathname} başarısız (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
    }
    // BTCTurk yanitlari genelde {data: [...], success: true} seklinde sarilir.
    return data.data !== undefined ? data.data : data;
  }

  _authHeaders() {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Bu işlem için API anahtarı gerekli. Panelden BTCTurk anahtarını kaydet.');
    }
    const nonce = Date.now().toString();
    const message = this.apiKey + nonce;
    const decodedSecret = Buffer.from(this.apiSecret, 'base64');
    const signature = crypto.createHmac('sha256', decodedSecret).update(message).digest('base64');
    return { 'X-PCK': this.apiKey, 'X-Stamp': nonce, 'X-Signature': signature };
  }

  async _privateRequest(method, pathname, params = {}, { allowRetry = false } = {}) {
    const headers = this._authHeaders();
    const isGet = method === 'GET' || method === 'DELETE';
    const qs = new URLSearchParams(params).toString();
    const url = `${this.privateBaseUrl}${pathname}${isGet && qs ? '?' + qs : ''}`;
    let res;
    try {
      res = await fetchWithRetry(
        url,
        {
          method,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: !isGet ? JSON.stringify(params) : undefined
        },
        { retries: allowRetry ? 2 : 0, timeoutMs: 10000 }
      );
    } catch (err) {
      if (method === 'POST' || method === 'DELETE') err.unknownOutcome = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${this.name} ${pathname} hata (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
      err.httpStatus = res.status;
      err.exchange = this.id;
      if ((method === 'POST' || method === 'DELETE') && res.status >= 500) err.unknownOutcome = true;
      throw err;
    }
    return data.data !== undefined ? data.data : data;
  }

  async fetchCandles(symbol, timeframe = '1h', limit = 300) {
    const resolutionMap = {
      '1m': 1, '5m': 5, '15m': 15, '30m': 30,
      '1h': 60, '4h': 240, '1d': 1440, '1w': 10080, '1y': 525600
    };
    const resolution = resolutionMap[String(timeframe).toLowerCase()];
    if (!resolution) throw new Error(`BTCTurk desteklenmeyen mum aralığı: ${timeframe}`);
    const count = Math.min(1000, Math.max(2, Number(limit) || 300));
    const to = Math.floor(Date.now() / 1000);
    const from = to - (resolution * 60 * count);
    const qs = new URLSearchParams({
      symbol: this.normalizeSymbol(symbol),
      resolution: String(resolution),
      from: String(from),
      to: String(to)
    }).toString();
    const res = await fetchWithRetry(`${GRAPH_BASE_URL}/klines/history?${qs}`, undefined, { retries: 2, timeoutMs: 10000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${this.name} kline başarısız (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
    if (data.s && data.s !== 'ok') throw new Error(`${this.name} kline API hatası: ${data.s}`);
    if (!Array.isArray(data.t) || !Array.isArray(data.o) || !Array.isArray(data.h) || !Array.isArray(data.l) || !Array.isArray(data.c) || !Array.isArray(data.v)) {
      throw new Error('BTCTurk kline cevabı beklenen dizi biçiminde değil.');
    }
    const n = Math.min(data.t.length, data.o.length, data.h.length, data.l.length, data.c.length, data.v.length);
    const candles = [];
    for (let i = 0; i < n; i++) candles.push({
      t: Number(data.t[i]) * 1000,
      o: Number(data.o[i]), h: Number(data.h[i]), l: Number(data.l[i]),
      c: Number(data.c[i]), v: Number(data.v[i])
    });
    const out = candles.slice(-count);
    const expectedMs = resolution * 60 * 1000;
    const deltas = [];
    for (let i = 1; i < out.length; i++) {
      const d = out[i].t - out[i - 1].t;
      if (Number.isFinite(d) && d > 0) deltas.push(d);
    }
    if (out.length >= 2 && (!deltas.length || Math.min(...deltas) !== expectedMs)) {
      throw new Error(`BTCTurk mum çözünürlüğü doğrulanamadı: istenen ${timeframe}, beklenen ${expectedMs}ms.`);
    }
    return out;
  }

  async fetchOrderBook(symbol, limit = 25) {
    const data = await this._publicGet('/orderbook', { pairSymbol: this.normalizeSymbol(symbol), limit: Math.min(100, Math.max(5, Number(limit) || 25)) });
    return { bids: data?.bids || [], asks: data?.asks || [], timestamp: data?.timestamp || Date.now() };
  }

  async fetchTicker(symbol) {
    const raw = await this._publicGet('/ticker', { pairSymbol: this.normalizeSymbol(symbol) });
    const t = Array.isArray(raw) ? raw[0] : raw;
    if (!t) throw new Error(`BTCTurk ticker bulunamadı: ${symbol}`);
    return { symbol, price: parseFloat(t.last) };
  }

  async fetchAllTickers24h() {
    const raw = await this._publicGet('/ticker');
    return raw.map((t) => ({
      symbol: `${t.numeratorSymbol}/${t.denominatorSymbol}`,
      lastPrice: parseFloat(t.last),
      changePct: parseFloat(t.dailyPercent),
      quoteVolume: parseFloat(t.volume) * parseFloat(t.average || t.last), // BTCTurk 'volume'u taban varlikta verir, kaba TRY/USDT karsiligina cevriliyor
      highPrice: parseFloat(t.high),
      lowPrice: parseFloat(t.low)
    }));
  }

  async fetchSymbolRules(symbol) {
    const raw = await this._publicGet('/server/exchangeinfo');
    const list = raw.symbols || raw;
    const norm = this.normalizeSymbol(symbol);
    const info = (list || []).find((s) => s.name === norm || s.nameNormalized === norm.replace(/(.+)(TRY|USDT)$/, '$1_$2'));
    if (!info) throw new Error(`BTCTurk işlem kuralları bulunamadı: ${symbol}; canlı emir güvenlik nedeniyle durduruldu.`);
    if (info.status && String(info.status).toUpperCase() !== 'TRADING') throw new Error(`BTCTurk sembolü işlem için açık değil (${info.status}): ${symbol}`);
    const priceFilter = (info.filters || []).find((f) => f.filterType === 'PRICE_FILTER') || {};
    return {
      symbol,
      stepSize: Math.pow(10, -(info.numeratorScale ?? 8)),
      minQty: priceFilter.minAmount != null ? Number(priceFilter.minAmount) : 0,
      maxQty: priceFilter.maxAmount != null ? Number(priceFilter.maxAmount) : 0,
      tickSize: Number(priceFilter.tickSize || 0),
      minPrice: Number(priceFilter.minPrice || 0),
      maxPrice: Number(priceFilter.maxPrice || 0),
      minNotional: Number(priceFilter.minExchangeValue || 0),
      baseAsset: info.numerator,
      quoteAsset: info.denominator,
      orderTypes: info.orderMethods || [],
      supportsProtectiveStop: Array.isArray(info.orderMethods) && info.orderMethods.length
        ? info.orderMethods.some((m) => String(m).toUpperCase().replace(/[_\s-]/g, '') === 'STOPMARKET')
        : undefined
    };
  }

  async fetchOpenOrders(symbols = []) {
    const list = Array.isArray(symbols) && symbols.length ? symbols : [null];
    const all = [];
    for (const symbol of list) {
      const params = symbol ? { pairSymbol: this.normalizeSymbol(symbol) } : {};
      const data = await this._privateRequest('GET', '/openOrders', params, { allowRetry: true });
      if (!data || !Array.isArray(data.bids) || !Array.isArray(data.asks)) throw new Error('BTCTurk açık emir cevabı şema doğrulamasını geçemedi.');
      const bids = data.bids;
      const asks = data.asks;
      for (const o of [...bids, ...asks]) all.push(this._normalizeOrder(o));
    }
    return all;
  }

  _normalizeOrder(o = {}) {
    const type = String(o.type || '').toLowerCase();
    const rawStatus = String(o.status || '').trim().toLowerCase();
    const statusMap = {
      untouched: 'NEW',
      active: 'NEW',
      new: 'NEW',
      partial: 'PARTIALLY_FILLED',
      partially_filled: 'PARTIALLY_FILLED',
      filled: 'FILLED',
      canceled: 'CANCELED',
      cancelled: 'CANCELED',
      rejected: 'REJECTED',
      expired: 'EXPIRED'
    };
    return {
      orderId: o.id ?? null,
      clientOrderId: o.orderClientId ?? o.newOrderClientId ?? null,
      symbol: String(o.pairsymbolnormalized || o.pairSymbolNormalized || o.pairsymbol || o.pairSymbol || '').replace('_', '/'),
      side: type === 'buy' ? 'buy' : type === 'sell' ? 'sell' : type,
      status: statusMap[rawStatus] || String(o.status || '').toUpperCase(),
      executedQty: Number(o.executedQuantity || o.filled || 0),
      origQty: Number(o.quantity ?? o.amount ?? 0),
      price: Number(o.price || 0),
      stopPrice: Number(o.stopPrice || 0),
      createTime: o.time ?? o.datetime ?? null
    };
  }

  async getOrder(symbol, orderId) {
    if (orderId === undefined || orderId === null) throw new Error('BTCTurk getOrder için orderId gerekli.');
    const data = await this._privateRequest('GET', `/order/${encodeURIComponent(orderId)}`, {}, { allowRetry: true });
    return this._normalizeOrder(data || {});
  }

  async fetchBalance() {
    const data = await this._privateRequest('GET', '/users/balances', {}, { allowRetry: true });
    const balances = {};
    for (const b of data || []) {
      const free = parseFloat(b.balance) - parseFloat(b.locked || '0');
      if (free > 0 || parseFloat(b.locked || '0') > 0) {
        balances[b.asset] = { free, locked: parseFloat(b.locked || '0') };
      }
    }
    return balances;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const a = validateOrderArgs('BTCTurk', { side, amount, clientOrderId });
    return guardCreate('BTCTurk', async () => {
      const data = await this._privateRequest('POST', '/order', {
        quantity: a.amount,
        pairSymbol: this.normalizeSymbol(symbol),
        orderType: a.side,
        orderMethod: 'market',
        newOrderClientId: String(clientOrderId)
      });
      return this._normalizeOrder(data);
    }, { clientOrderId, side: a.side });
  }

  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    if (String(side).toLowerCase() !== 'sell') throw new Error('BTCTurk koruyucu stop yalnızca sell olabilir.');
    const a = validateOrderArgs('BTCTurk', { side, amount, clientOrderId });
    const stop = validatePositivePrice('BTCTurk', 'stop fiyatı', stopPrice);
    return guardCreate('BTCTurk', async () => {
      const data = await this._privateRequest('POST', '/order', {
        quantity: a.amount,
        price: 0,
        stopPrice: stop,
        pairSymbol: this.normalizeSymbol(symbol),
        orderType: 'sell',
        orderMethod: 'stopMarket',
        newOrderClientId: String(clientOrderId)
      });
      return this._normalizeOrder(data);
    }, { clientOrderId, side: 'sell' });
  }

  async createTakeProfitOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    const a = validateOrderArgs('BTCTurk', { side, amount, clientOrderId });
    const stop = validatePositivePrice('BTCTurk', 'take-profit fiyatı', stopPrice);
    return guardCreate('BTCTurk', async () => {
      const data = await this._privateRequest('POST', '/order', {
        quantity: a.amount, price: 0, stopPrice: stop, pairSymbol: this.normalizeSymbol(symbol),
        orderType: a.side, orderMethod: 'stopMarket',
        newOrderClientId: String(clientOrderId)
      });
      return this._normalizeOrder(data);
    }, { clientOrderId, side: a.side });
  }

  async cancelOrder(symbol, orderId) {
    if (orderId === undefined || orderId === null || String(orderId).trim() === '') {
      throw new Error('BTCTurk cancelOrder için orderId gerekli.');
    }

    // BTCTurk'un DELETE /order cevabı iptal isteğinin alındığını gösterebilir;
    // nihai durum daha sonra oluşur. HTTP 200 veya {success:true,data:{}} tek
    // başına CANCELED kanıtı değildir. DELETE isteğini otomatik tekrar etmiyoruz;
    // emir durumunu salt-okunur GET ile gözlemliyoruz.
    await this._privateRequest('DELETE', '/order', { id: String(orderId) }, { allowRetry: false });

    const terminal = new Set(['CANCELED', 'FILLED', 'REJECTED', 'EXPIRED']);
    let latest = null;
    const attempts = 8;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        latest = await this.getOrder(symbol, orderId);
      } catch (err) {
        // DELETE borsaya ulaşmış olabilir. GET başarısızlığı iptalin olmadığını
        // kanıtlamaz; çağırana UNKNOWN döndürerek market satışını engelle.
        const unknown = new Error(`BTCTurk emir iptal sonucu doğrulanamadı: ${err.message}`);
        unknown.unknownOutcome = true;
        unknown.exchange = this.id;
        unknown.cause = err;
        throw unknown;
      }
      if (terminal.has(String(latest.status || '').toUpperCase())) return latest;
    }

    // Süre içinde terminal durum görülmediyse aktif/partial son gözlem döner.
    // OrderManager bunu CANCELED saymaz ve LiveEngine market satışına devam etmez.
    return latest || {
      orderId: String(orderId), symbol, status: 'UNKNOWN', executedQty: 0,
      uncertain: true, requiresReconciliation: true
    };
  }
}

module.exports = BtcturkAdapter;
