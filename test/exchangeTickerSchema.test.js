const test = require('node:test');
const assert = require('node:assert/strict');
const Coinbase = require('../src/exchanges/coinbaseExchange');
const Kraken = require('../src/exchanges/kraken');
const Bitstamp = require('../src/exchanges/bitstamp');
const Okx = require('../src/exchanges/okx');
const BybitTr = require('../src/exchanges/bybittr');
const { scan } = require('../src/scanner');

const REQUIRED = ['symbol', 'lastPrice', 'changePct', 'quoteVolume', 'highPrice', 'lowPrice'];
function assertScannerRows(rows) {
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const key of REQUIRED) assert.ok(Object.hasOwn(row, key), `missing ${key}`);
    assert.ok(Number.isFinite(row.quoteVolume), 'quoteVolume must be numeric');
  }
}

test('Coinbase Exchange ticker rows use the scanner contract and quote-volume units', async () => {
  const ex = new Coinbase();
  ex._get = async (path) => path === '/products'
    ? [{ id: 'BTC-USD', status: 'online', quote_currency: 'USD' }, { id: 'ETH-USD', status: 'offline', quote_currency: 'USD' }]
    : { last: '110', open: '100', volume: '50000', high: '120', low: '90' };
  const rows = await ex.fetchAllTickers24h();
  assertScannerRows(rows);
  assert.equal(rows[0].symbol, 'BTC/USD');
  assert.equal(rows[0].changePct, 10);
  assert.equal(rows[0].quoteVolume, 5500000);
});

test('Kraken ticker rows use price change percentage, not VWAP, for changePct', async () => {
  const ex = new Kraken();
  ex._get = async (path) => path === '/0/public/AssetPairs'
    ? { error: [], result: { XXBTZUSD: { wsname: 'XBT/USD' } } }
    : { error: [], result: { XXBTZUSD: { c: ['110', '1'], o: '100', v: ['1000', '50000'], h: ['120', '125'], l: ['90', '88'], p: ['105', '104'] } } };
  const rows = await ex.fetchAllTickers24h();
  assertScannerRows(rows);
  assert.equal(rows[0].changePct, 10);
  assert.equal(rows[0].quoteVolume, 5200000);
});

test('Bitstamp ticker rows use normalized scanner fields', async () => {
  const ex = new Bitstamp();
  ex._get = async () => [{ pair: 'BTC/USD', last: '110', open: '100', volume: '50000', percent_change_24: '10', high: '120', low: '90' }];
  const rows = await ex.fetchAllTickers24h();
  assertScannerRows(rows);
  assert.equal(rows[0].symbol, 'BTC/USD');
  assert.equal(rows[0].quoteVolume, 5500000);
});

test('OKX ticker rows use normalized scanner fields and quote turnover', async () => {
  const ex = new Okx();
  ex._get = async () => ({ code: '0', data: [{ instId: 'BTC-USDT', last: '110', open24h: '100', volCcy24h: '5500000', vol24h: '50000', high24h: '120', low24h: '90' }] });
  const rows = await ex.fetchAllTickers24h();
  assertScannerRows(rows);
  assert.equal(rows[0].symbol, 'BTC/USDT');
  assert.equal(rows[0].changePct, 10);
  assert.equal(rows[0].quoteVolume, 5500000);
});

test('Bybit TR ticker rows normalize symbol, percentage, and quote turnover', async () => {
  const ex = new BybitTr({ baseUrl: 'https://api.bybit.tr' });
  ex._get = async () => ({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '110', prevPrice24h: '100', price24hPcnt: '0.1', turnover24h: '5500000', volume24h: '50000', highPrice24h: '120', lowPrice24h: '90' }] } });
  const rows = await ex.fetchAllTickers24h();
  assertScannerRows(rows);
  assert.equal(rows[0].symbol, 'BTC/USDT');
  assert.ok(Math.abs(rows[0].changePct - 10) < 1e-9);
  assert.equal(rows[0].quoteVolume, 5500000);
});

test('scanner can select public-only adapter rows with the shared quoteVolume contract', async () => {
  const exchange = { fetchAllTickers24h: async () => [
    { symbol: 'BTC/USDT', lastPrice: 100, changePct: 1, quoteVolume: 6_000_000, highPrice: 110, lowPrice: 90 },
    { symbol: 'ETH/USDT', lastPrice: 10, changePct: 1, quoteVolume: 1_000_000, highPrice: 11, lowPrice: 9 }
  ] };
  const rows = await scan(exchange);
  assert.deepEqual(rows.map(x => x.symbol), ['BTC/USDT']);
});
