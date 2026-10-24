// src/scanner.js
// Piyasa tarayici: API anahtari gerektirmez, herkese acik 24 saatlik veriyi
// okur. Amac "hangisi yukselecek" tahmini degil, hangi paritelerin likit
// oldugunu (dusuk kaymayla islem yapilabilir) gostermek.

const MIN_QUOTE_VOLUME_USDT = 5_000_000; // bu hacmin altindaki paritelerde stop emri kolay kayar

async function scan(exchange, { minVolume = MIN_QUOTE_VOLUME_USDT, limit = 30 } = {}) {
  const tickers = await exchange.fetchAllTickers24h();
  return tickers
    .filter((t) => t.quoteVolume >= minVolume)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit);
}

module.exports = { scan, MIN_QUOTE_VOLUME_USDT };
