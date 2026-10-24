// src/exchanges/index.js
// Borsa kayit defteri. Yeni borsa eklerken (BTCTurk, Paribu, Binance TR)
// buraya bir satir eklemek yeterli -- panel ve strateji tarafinda degisiklik
// gerekmez.

const BinanceAdapter = require('./binance');
const BtcturkAdapter = require('./btcturk');
const ParibuAdapter = require('./paribu');
const BinanceTrAdapter = require('./binancetr');
const CoinbaseExchangeAdapter = require('./coinbaseExchange');
const KrakenAdapter = require('./kraken');
const BitstampAdapter = require('./bitstamp');
const OkxAdapter = require('./okx');
const OkxTrAdapter = require('./okxtr');
const BybitTrAdapter = require('./bybittr');
const MidasAdapter = require('./midas');

const registry = {
  binance: BinanceAdapter,
  btcturk: BtcturkAdapter,
  paribu: ParibuAdapter,
  binancetr: BinanceTrAdapter,
  coinbaseexchange: CoinbaseExchangeAdapter,
  kraken: KrakenAdapter,
  bitstamp: BitstampAdapter,
  okx: OkxAdapter,
  okxtr: OkxTrAdapter,
  bybittr: BybitTrAdapter,
  midas: MidasAdapter
};

function listExchanges() {
  return Object.keys(registry).map((id) => {
    const Cls = registry[id];
    const tmp = new Cls();
    return { id: tmp.id, name: tmp.name, quoteAssets: tmp.quoteAssets };
  });
}

function createExchange(id, opts) {
  const Cls = registry[id];
  if (!Cls) {
    throw new Error(
      `Borsa henuz desteklenmiyor: ${id}. Su an: ${Object.keys(registry).join(', ')}`
    );
  }
  return new Cls(opts);
}

// Binance ortami: KAGIT modda piyasa verisi HER ZAMAN gercek piyasadan (production) okunur.
// Test agi (testnet) yalnizca CANLI modda, imzali emir denemeleri icin kullanilir; aksi halde
// .env.example'daki BINANCE_ENV=testnet, kagit botu sessizce test aginin sahte fiyatlariyla calistirirdi.
function resolveBinanceEnvironment(mode, envValue) {
  if (mode !== 'live') return 'production';
  return String(envValue || 'production').toLowerCase();
}

module.exports = { registry, listExchanges, createExchange, resolveBinanceEnvironment };
