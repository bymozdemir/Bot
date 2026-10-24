// src/exchanges/privateBase.js
//
// Stage 4: Coinbase Exchange, Kraken, Bitstamp, OKX, OKX TR ve Bybit TR için ortak özel-API tabanı.
//
// Güvenlik ilkeleri (bütün alt sınıflar için geçerli):
//  1. liveTradingVerified HER ZAMAN false'tur. Bu bayrak yalnızca gerçek hesap/sandbox kanıtı
//     docs/ içinde kayıt altına alındıktan sonra, kod incelemesiyle elle true yapılır.
//  2. Emir oluşturma/iptal (mutating) istekleri ASLA otomatik tekrar denenmez.
//  3. Ağ hatası, zaman aşımı, 5xx veya çözümlenemeyen yanıt => err.unknownOutcome = true.
//     OrderManager bu durumda emri UNKNOWN yapar ve yeni emir göndermez; kurtarma getOrder(cid) ile olur.
//  4. "Mükerrer clientOrderId" hatası emrin ZATEN VAR olabileceği anlamına gelir => unknownOutcome.
//  5. İstemci emir kimliği her borsanın biçim kısıtına göre, botun kimliğinden DETERMİNİSTİK türetilir;
//     böylece yeniden başlatmadan sonra aynı kimlikle sorgu yapılabilir.
//  6. Ortam değişkeniyle gelen URL, imzalı istek taşıdığı için host allowlist'inden geçer.

const crypto = require('crypto');
const PublicOnlyAdapter = require('./publicOnlyBase');
const { fetchWithRetry } = require('../util/retry');
const { assertAllowedUrl } = require('../util/hostGuard');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// UUID biçimli (v5 benzeri sürüm/varyant bitleriyle) deterministik kimlik.
function deterministicUuid(clientOrderId) {
  const b = Buffer.from(sha256(clientOrderId).subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Yalnızca [0-9a-f], verilen uzunlukta (OKX clOrdId: alfanümerik, en fazla 32).
function deterministicHex(clientOrderId, length = 32) {
  return sha256(clientOrderId).toString('hex').slice(0, Math.max(1, Math.min(64, length)));
}

function requireClientOrderId(clientOrderId, exchangeName) {
  const s = String(clientOrderId || '');
  if (!s) throw new Error(`${exchangeName}: clientOrderId zorunlu; kimliksiz canlı emir gönderilmez.`);
  return s;
}

function positiveNumber(value, label, exchangeName) {
  // true => 1, [5] => 5 gibi örtük dönüşümler emir miktarı olamaz.
  if (typeof value === 'boolean' || Array.isArray(value)) throw new Error(`${exchangeName}: ${label} sayı olmalı.`);
  const n = Number(value);
  if (!Number.isFinite(n) || !(n > 0)) throw new Error(`${exchangeName}: ${label} pozitif ve sonlu olmalı.`);
  return n;
}

function sideOf(side, exchangeName) {
  const s = String(side || '').toLowerCase();
  if (s !== 'buy' && s !== 'sell') throw new Error(`${exchangeName}: emir yönü buy veya sell olmalı.`);
  return s;
}

// Sayıyı bilimsel gösterim olmadan, sabit ondalıkla yazar.
function plain(value, decimals = 12) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Geçersiz sayı: ${value}`);
  // 1e21 ve üzeri toFixed ile üssel gösterime düşer ("1e+21"); sıfırdan farklı değer "0"a yuvarlanamaz.
  if (Math.abs(n) >= 1e21) throw new Error(`Sayı makul sınırın üzerinde: ${value}`);
  const fixed = n.toFixed(decimals);
  if (n !== 0 && Number(fixed) === 0) throw new Error(`Sayı ondalık hassasiyetin altında (0'a yuvarlanırdı): ${value}`);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function decimalsFromStep(step) {
  const s = String(step);
  if (s.includes('e-')) { const [m, e] = s.split('e-'); return Number(e) + ((m.split('.')[1] || '').length); }
  return (s.split('.')[1] || '').length;
}

class PrivateAdapterBase extends PublicOnlyAdapter {
  constructor(opts = {}, cfg = {}) {
    // baseUrl: ortam/opts üzerinden gelirse allowlist'ten geçmek zorunda.
    const requested = opts.baseUrl || (cfg.baseUrlEnv ? process.env[cfg.baseUrlEnv] : '') || '';
    if (requested && Array.isArray(cfg.allowedHosts)) assertAllowedUrl(requested, cfg.allowedHosts, cfg.baseUrlEnv || `${cfg.id}.baseUrl`);
    super({ ...opts, baseUrl: requested || cfg.baseUrl }, cfg);
    this.allowedHosts = cfg.allowedHosts || [];
    this.apiPassphrase = opts.apiPassphrase || opts.passphrase || (cfg.passphraseEnv ? process.env[cfg.passphraseEnv] : null) || null;
    this.marketBuyUsesQuote = false; // new adapters: market BUY/SELL amount is always BASE quantity
    this.recvWindowMs = Number(opts.recvWindowMs || 5000);
    this.capabilities = {
      clientOrderId: true,
      marketBuyUsesQuote: false,
      recoveryByFingerprint: false,
      orderQuery: true,
      balanceQuery: true,
      openOrdersQuery: true,
      takeProfitOrder: false,
      protectiveStopImplemented: false,
      userDataStream: false,
      oco: false,
      nativeTrailingOco: false,
      marketOrderBook: true,
      publicMarketData: true,
      privateApiImplemented: true,
      // Kanıt yoksa false. Canlı motor ayrıca bilinmeyen borsa kimliklerini reddeder.
      liveTradingVerified: false
    };
  }

  _requireCredentials({ passphrase = false } = {}) {
    if (!this.apiKey || !this.apiSecret) throw new Error(`${this.name}: özel işlem için API key ve secret gerekli.`);
    if (passphrase && !this.apiPassphrase) throw new Error(`${this.name}: bu borsa için API passphrase gerekli (env: ${String(this.id).toUpperCase()}_API_PASSPHRASE).`);
  }

  // Alt sınıflar imzalı isteği kendileri kurar; bu yöntem gönderim + hata sınıflandırmasını yapar.
  //   req = { method, url, headers, body }   mutating: POST oluşturma/iptal
  async _send(req, { mutating = false, definitiveErrors = null } = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    let res;
    try {
      res = await fetchWithRetry(req.url, { method, headers: req.headers || {}, body: req.body }, { retries: mutating ? 0 : 2, timeoutMs: 10000 });
    } catch (err) {
      err.exchange = this.id;
      if (mutating) err.unknownOutcome = true;
      throw err;
    }
    const data = await res.json().catch(() => undefined);
    if (!res.ok) {
      const err = new Error(`${this.name} HTTP ${res.status}: ${this._errorText(data)}`);
      err.httpStatus = res.status;
      err.exchange = this.id;
      err.body = data;
      if (mutating && (res.status >= 500 || res.status === 408)) err.unknownOutcome = true;
      if (mutating && this._looksLikeDuplicateClientId(data)) err.unknownOutcome = true;
      throw err;
    }
    if (data === undefined || (mutating && (data === null || typeof data !== 'object'))) {
      // Gövde yok / `null` / nesne olmayan JSON: emir borsaya ulaşmış olabilir. TypeError'a düşmesine izin verme.
      const err = new Error(`${this.name}: yanıt çözümlenemedi (HTTP ${res.status}).`);
      err.exchange = this.id;
      if (mutating) err.unknownOutcome = true;
      throw err;
    }
    return data;
  }

  _errorText(data) {
    if (data == null) return 'gövde yok';
    if (typeof data === 'string') return data.slice(0, 300);
    return String(data.message || data.msg || data.error || data.reason || JSON.stringify(data)).slice(0, 300);
  }

  _looksLikeDuplicateClientId(data) {
    const text = JSON.stringify(data || '').toLowerCase();
    return /client[_ ]?o(rder)?[_ ]?id|cl_ord_id|clordid|orderlinkid/.test(text) && /(duplicate|already|exist|unique|used)/.test(text);
  }

  // Oluşturma yanıtı doğrulaması: borsa emir kimliği zorunlu; istemci kimliği döndüyse eşleşmeli.
  _assertCreated(order, { clientOrderId, symbol, side } = {}) {
    const bad = (why) => {
      const err = new Error(`${this.name}: emir yanıtı doğrulanamadı (${why}); sonuç belirsiz, otomatik tekrar gönderilmeyecek.`);
      err.exchange = this.id; err.unknownOutcome = true; err.orderResponseInvalid = true;
      return err;
    };
    if (order.orderId === null || order.orderId === undefined || order.orderId === '') throw bad('borsa emir kimliği yok');
    if (order.clientOrderId && String(order.clientOrderId) !== String(clientOrderId)) throw bad('clientOrderId uyuşmuyor');
    if (order.side && side && String(order.side).toLowerCase() !== String(side).toLowerCase()) throw bad('yön uyuşmuyor');
    void symbol;
    return order;
  }

  // Oluşturmadan sonra tek seferlik durum sorgusu: market emir çoğu borsada hemen dolar ama
  // oluşturma yanıtı dolum bilgisi taşımaz. Sorgu başarısızsa oluşturma yanıtı korunur (emir kabul edildi).
  async _enrichAfterCreate(created, symbol, clientOrderId) {
    try {
      const q = await this.getOrder(symbol, created.orderId, clientOrderId);
      if (q && q.orderId !== null && q.orderId !== undefined) return { ...q, clientOrderId: q.clientOrderId || clientOrderId };
    } catch (_) { /* sorgu başarısız: emir yine de kabul edilmiş durumda */ }
    return created;
  }

  // Bot kuralları (BTCTurk biçimi) + eski anahtarlar.
  _rules(symbol, { stepSize, minQty, maxQty = 0, tickSize = 0, minNotional = 0, minNotionalMode = 'required', base, quote }) {
    return {
      symbol, stepSize: Number(stepSize) || 0, minQty: Number(minQty) || 0, maxQty: Number(maxQty) || 0,
      tickSize: Number(tickSize) || 0, minNotional: Number(minNotional) || 0, minNotionalMode,
      marketStepSize: Number(stepSize) || 0, marketMinQty: Number(minQty) || 0, marketMaxQty: Number(maxQty) || 0,
      baseAsset: base, quoteAsset: quote, orderTypes: ['market', 'stop'], precisionKnown: Number(stepSize) > 0,
      // geriye dönük uyumluluk (Stage 2/3 anahtarları)
      minAmount: Number(minQty) || 0, amountStep: Number(stepSize) || 0, priceStep: Number(tickSize) || 0
    };
  }

  // Piyasa tarayıcısı (src/scanner.js) quoteVolume/lastPrice/changePct alanlarını okur. Eski anahtarlar uyumluluk için korunur.
  _tickerRow(symbol, { last, open, quoteVolume, high, low, baseVolume }) {
    const l = Number(last), o = Number(open);
    const qv = Number(quoteVolume);
    return {
      symbol, lastPrice: l, changePct: Number.isFinite(o) && o > 0 ? ((l - o) / o) * 100 : 0,
      quoteVolume: Number.isFinite(qv) ? qv : 0, highPrice: Number(high) || 0, lowPrice: Number(low) || 0,
      price: l, volume: Number(baseVolume) || 0, change: Number.isFinite(o) ? l - o : 0
    };
  }

  async createTakeProfitOrder() { return this._unsupported(); }
}

module.exports = PrivateAdapterBase;
module.exports.helpers = { deterministicUuid, deterministicHex, requireClientOrderId, positiveNumber, sideOf, plain, decimalsFromStep, sha256 };
