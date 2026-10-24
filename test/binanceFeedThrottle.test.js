const test = require('node:test');
const assert = require('node:assert/strict');
const Binance = require('../src/exchanges/binance');

const H = 3600000;
class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.h = {}; this.sent = []; FakeWS.instances.push(this); }
  on(e, f) { this.h[e] = f; return this; }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() {}
  emit(e, a) { if (this.h[e]) this.h[e](a); }
}
const tick = () => new Promise((r) => setImmediate(r));
const restRows = (endIdx, n = 60) => Array.from({ length: n }, (_, i) => { const t = (endIdx - n + 1 + i) * H; return { t, o: 100, h: 101, l: 99, c: 100, v: 5 }; });

test('varsayilan: WebSocket kapali, REST throttler acik (2400/dk)', () => {
  delete process.env.MARKET_DATA_WS; delete process.env.PUBLIC_API_WEIGHT_PER_MIN;
  const b = new Binance({});
  assert.equal(b._getCandleFeed(), null);
  assert.equal(b.publicThrottler.maxWeight, 2400);
});

test('PUBLIC_API_WEIGHT_PER_MIN=0 throttleri kapatir', () => {
  const b = new Binance({ publicWeightPerMin: 0 });
  assert.equal(b.publicThrottler, null);
});

test('butce dolunca public istek aga cikmadan rateLimited/throttled hatasi verir', async () => {
  const b = new Binance({ publicWeightPerMin: 4, publicRequestTimeoutMs: 1000 });
  await b.publicThrottler.acquire(4);
  await assert.rejects(() => b._publicGet('/api/v3/klines', { symbol: 'BTCUSDT', interval: '1h', limit: 5 }),
    (e) => e.throttled === true && e.rateLimited === true && /bütçe/.test(e.message));
});

test('WS acikken ilk cagri REST, akis hazir olunca mumlar akistan gelir ve dogrulayicidan gecer', async () => {
  FakeWS.instances = [];
  const now = Date.now();
  const lastT = Math.floor(now / H) * H;
  const endIdx = lastT / H;
  const b = new Binance({ marketDataWs: true, publicWeightPerMin: 0, candleFeed: { WebSocketImpl: FakeWS, reconnectMs: 5 } });
  let restCalls = 0;
  b._fetchCandlesRest = async (_s, _tf, n) => { restCalls++; return restRows(endIdx, n); };
  const first = await b.fetchCandles('BTC/USDT', '1h', 50);
  assert.equal(first.length, 50);
  assert.equal(restCalls, 1);                         // akis henuz hazir degil -> REST
  FakeWS.instances[0].emit('open'); await tick(); await tick();
  assert.equal(restCalls, 2);                         // gecmis tamamlama (arka plan)
  assert.deepEqual(FakeWS.instances[0].sent[0].params, ['btcusdt@kline_1h']);
  FakeWS.instances[0].emit('message', JSON.stringify({ data: { e: 'kline', s: 'BTCUSDT', k: { t: lastT, i: '1h', o: '100', h: '103', l: '99', c: '102', v: '9', x: false } } }));
  const second = await b.fetchCandles('BTC/USDT', '1h', 50);
  assert.equal(restCalls, 2);                         // bu sefer REST'e cikilmadi
  assert.equal(second.at(-1).c, 102);
  assert.equal(b.candleFeed.stats.servedFromFeed, 1);
  b.closeMarketFeed();
  assert.equal(b.candleFeed, null);
});

test('WS bozuk/hizasiz mum verirse dogrulayici reddeder (REST yoluna sessizce guvenilmez)', async () => {
  FakeWS.instances = [];
  const lastT = Math.floor(Date.now() / H) * H;
  const b = new Binance({ marketDataWs: true, publicWeightPerMin: 0, candleFeed: { WebSocketImpl: FakeWS } });
  b._fetchCandlesRest = async (_s, _tf, n) => restRows(lastT / H, n);
  await b.fetchCandles('ETH/USDT', '1h', 50);
  FakeWS.instances[0].emit('open'); await tick(); await tick();
  FakeWS.instances[0].emit('message', JSON.stringify({ data: { e: 'kline', s: 'ETHUSDT', k: { t: lastT + 5, i: '1h', o: '1', h: '2', l: '1', c: '1', v: '1', x: false } } }));
  const rows = await b.fetchCandles('ETH/USDT', '1h', 50);
  assert.equal(rows.at(-1).t, lastT);                  // hizasiz mum akisa hic girmedi
  b.closeMarketFeed();
});
