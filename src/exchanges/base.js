// src/exchanges/base.js
//
// Her borsa adaptoru bu sekli uygulamali. Panel ve strateji motoru sadece bu
// metodlari cagirir, boylece Binance -> BTCTurk -> Paribu -> Binance TR
// eklerken strategy.js / paperEngine.js hic degismez.
//
// Yeni bir borsa eklerken:
//   1. exchanges/<isim>.js dosyasi olustur, asagidaki metodlarin hepsini uygula.
//   2. exchanges/index.js icindeki registry'e ekle.
//   3. Sembol formati farkliysa (ornegin "BTC/USDT" -> "BTCTRY") normalizeSymbol'de cevir.
//
// id: 'binance' | 'binancetr' | 'btcturk' | 'paribu'
// name: panelde gosterilecek isim
// quoteAssets: bu borsada islem gorebilecek kasa birimleri (ornegin ['USDT'] ya da ['TRY'])
//
// Tum metodlar Promise dondurur. Ag hatasinda catch edilebilir bir Error firlatilmali.

function validateCandleRows(rows, { source = 'exchange', requireSorted = true } = {}) {
  if (!Array.isArray(rows)) throw new Error(`${source} candle cevabı dizi değil.`);
  let prev = -Infinity;
  return rows.map((c, i) => {
    const t=Number(c?.t), o=Number(c?.o), h=Number(c?.h), l=Number(c?.l), close=Number(c?.c), v=Number(c?.v);
    if (![t,o,h,l,close,v].every(Number.isFinite)) throw new Error(`${source} candle[${i}] geçersiz sayı içeriyor.`);
    if (!(t >= 0) || (requireSorted && t <= prev)) throw new Error(`${source} candle timestamp sırası geçersiz.`);
    if (!(h >= Math.max(o,close,l)) || !(l <= Math.min(o,close,h)) || h < l || v < 0) throw new Error(`${source} candle[${i}] OHLCV invariant ihlali.`);
    prev=t;
    return {t,o,h,l,c:close,v};
  });
}

class ExchangeAdapter {
  constructor(opts = {}) {
    this.id = 'base';
    this.name = 'Base';
    this.quoteAssets = [];
    this.capabilities = { clientOrderId: false, orderQuery: false, balanceQuery: false, openOrdersQuery: false, userDataStream: false, oco: false, nativeTrailingOco: false, marketOrderBook: false };
    this.apiKey = opts.apiKey || null;
    this.apiSecret = opts.apiSecret || null;
  }

  // Bu borsanin sembolu nasil yazdigini donusturur. Girdi her zaman "BTC/USDT" formatinda.
  normalizeSymbol(symbol) {
    throw new Error('normalizeSymbol uygulanmadi');
  }

  // Herkese acik: son N mum. Donus: [{t, o, h, l, c, v}], eskiden yeniye.
  async fetchCandles(symbol, timeframe, limit) {
    throw new Error('fetchCandles uygulanmadi');
  }

  // Herkese acik: guncel fiyat.
  async fetchTicker(symbol) {
    throw new Error('fetchTicker uygulanmadi');
  }

  // Herkese acik: tum semboller icin 24 saatlik hacim/degisim (piyasa tarayici icin).
  async fetchAllTickers24h() {
    throw new Error('fetchAllTickers24h uygulanmadi');
  }

  // Sembolun minimum emir tutari, adim buyuklugu gibi kurallari.
  async fetchSymbolRules(symbol) {
    throw new Error('fetchSymbolRules uygulanmadi');
  }

  // PUBLIC: order book snapshot. Donus: {bids:[[price,qty]], asks:[[price,qty]]}.
  async fetchOrderBook(symbol, limit = 20) {
    throw new Error('fetchOrderBook uygulanmadi');
  }

  // OZEL (API anahtari gerektirir): kasa bakiyesi.
  async fetchOpenOrders() {
    throw new Error('fetchOpenOrders uygulanmadi (API anahtari gerekli)');
  }

  async fetchBalance() {
    throw new Error('fetchBalance uygulanmadi (API anahtari gerekli)');
  }

  // OZEL: market emriyle al/sat. side: 'buy' | 'sell'
  async createMarketOrder(symbol, side, amount) {
    throw new Error('createMarketOrder uygulanmadi (API anahtari gerekli, canli fazda aktif edilecek)');
  }

  // OZEL: borsaya stop-loss emri koy, boylece baglanti kopsa da pozisyon korunur.
  async createStopOrder(symbol, side, amount, stopPrice) {
    throw new Error('createStopOrder uygulanmadi (API anahtari gerekli, canli fazda aktif edilecek)');
  }

  async getOrder(symbol, orderId, clientOrderId) {
    throw new Error('getOrder uygulanmadi (API anahtari gerekli, canli fazda aktif edilecek)');
  }

  async cancelOrder(symbol, orderId) {
    throw new Error('cancelOrder uygulanmadi (API anahtari gerekli, canli fazda aktif edilecek)');
  }
}

ExchangeAdapter.validateCandleRows = validateCandleRows;
module.exports = ExchangeAdapter;
