const test = require('node:test');
const assert = require('node:assert/strict');
const { CandleFeed, CandleStore } = require('../src/marketData/candleFeed');

const H = 3600000;
const row = (i, c = 100) => ({ t: i * H, o: c, h: c + 1, l: c - 1, c, v: 5 });
const kline = (sym, i, c, x = false) => JSON.stringify({ stream: `${sym.toLowerCase()}@kline_1h`, data: { e: 'kline', s: sym, k: { t: i * H, i: '1h', o: String(c), h: String(c + 1), l: String(c - 1), c: String(c), v: '5', x } } });

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.handlers = {}; this.sent = []; this.closed = false; FakeWS.instances.push(this); }
  on(ev, fn) { this.handlers[ev] = fn; return this; }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() { this.closed = true; }
  emit(ev, arg) { if (this.handlers[ev]) this.handlers[ev](arg); }
}
const tick = () => new Promise((r) => setImmediate(r));
function setup(opts = {}) {
  FakeWS.instances = [];
  let now = 1000 * H;
  const rest = { calls: 0, rows: Array.from({ length: 60 }, (_, i) => row(900 + i)), fail: false };
  const feed = new CandleFeed({
    wsUrl: 'wss://fake', WebSocketImpl: FakeWS, nowFn: () => now, maxStaleMs: 60000, reconnectMs: 5, backfillRetryMs: 1000,
    fetchRest: async () => { rest.calls++; if (rest.fail) throw new Error('rest down'); return rest.rows.map((r) => ({ ...r })); },
    timers: { setTimeout: (fn) => { const t = setTimeout(fn, 1); return t; }, clearTimeout },
    ...opts
  });
  return { feed, rest, advance: (ms) => { now += ms; }, setNow: (v) => { now = v; } };
}

test('CandleStore: forming mum guncellenir, gecmise mum eklenmez, hizasiz mum reddedilir', () => {
  const s = new CandleStore({ intervalMs: H, maxCandles: 5 });
  assert.equal(s.applyKline(row(1), 1), true);
  assert.equal(s.applyKline({ ...row(1, 105) }, 2), true);
  assert.equal(s.rows.length, 1); assert.equal(s.rows[0].c, 105);
  assert.equal(s.applyKline(row(2), 3), true);
  assert.equal(s.applyKline(row(0), 4), false);              // gecmise yeni mum yok
  assert.equal(s.applyKline({ ...row(3), t: 3 * H + 5 }, 5), false); // hizasiz
  assert.equal(s.applyKline({ t: 1, o: 'x' }, 5), false);    // bozuk
  for (let i = 3; i < 12; i++) s.applyKline(row(i), 9);
  assert.equal(s.rows.length, 5);                             // deque siniri
});

test('CandleStore.mergeHistory: REST kapanmis mumu kazanir, akistaki olusan mum korunur', () => {
  const s = new CandleStore({ intervalMs: H });
  s.applyKline(row(10, 111), 1); s.applyKline(row(11, 222), 1); // 11 = olusan
  s.mergeHistory([row(9), row(10, 100), row(11, 150)]);
  assert.deepEqual(s.rows.map((r) => r.t / H), [9, 10, 11]);
  assert.equal(s.rows.find((r) => r.t === 10 * H).c, 100);
  assert.equal(s.rows.find((r) => r.t === 11 * H).c, 222);
  assert.equal(s.isAligned(), true);
});

test('baglanti + REST tamamlama sonrasi mumlar akistan servis edilir; once REST yolu (null)', async () => {
  const { feed, rest } = setup();
  assert.equal(feed.getCandles('BTC/USDT', '1h', 50), null);       // henuz abonelik yok
  feed.ensure('BTC/USDT', '1h', 50);
  assert.equal(feed.getCandles('BTC/USDT', '1h', 50), null);       // baglanti/gecmis hazir degil
  FakeWS.instances[0].emit('open'); await tick(); await tick();
  assert.equal(rest.calls, 1);
  assert.deepEqual(FakeWS.instances[0].sent[0].params, ['btcusdt@kline_1h']);
  const got = feed.getCandles('BTC/USDT', '1h', 50);
  assert.equal(got.length, 50);
  assert.equal(got.at(-1).t, 959 * H);
  FakeWS.instances[0].emit('message', kline('BTCUSDT', 959, 120));
  FakeWS.instances[0].emit('message', kline('BTCUSDT', 960, 130));  // yeni mum acildi
  const after = feed.getCandles('BTC/USDT', '1h', 50);
  assert.equal(after.at(-1).t, 960 * H); assert.equal(after.at(-1).c, 130);
  assert.equal(after.at(-2).c, 120);
  assert.equal(feed.stats.servedFromFeed, 2);
});

test('yetersiz sayida mum veya bozuk mesaj feed disi birakir/yoksayilir', async () => {
  const { feed } = setup();
  feed.ensure('ETH/USDT', '1h', 500);
  FakeWS.instances[0].emit('open'); await tick(); await tick();
  assert.equal(feed.getCandles('ETH/USDT', '1h', 500), null);       // 60 mum < 500
  FakeWS.instances[0].emit('message', 'bozuk json');
  FakeWS.instances[0].emit('message', JSON.stringify({ result: null, id: 1 })); // abonelik yaniti
  FakeWS.instances[0].emit('message', kline('XRPUSDT', 960, 1));    // abone olunmamis parite
  assert.ok(feed.stats.rejectedMessages >= 2);
  assert.equal(feed.getCandles('ETH/USDT', '1h', 50).length, 50);
});

test('bayat akis (olay gelmiyor) REST yoluna dusurur ve REST yagmuru olmaz', async () => {
  const { feed, rest, advance } = setup();
  feed.ensure('BTC/USDT', '1h', 50);
  FakeWS.instances[0].emit('open'); await tick(); await tick();
  assert.ok(feed.getCandles('BTC/USDT', '1h', 50));
  advance(61000);
  assert.equal(feed.getCandles('BTC/USDT', '1h', 50), null);
  for (let i = 0; i < 5; i++) feed.getCandles('BTC/USDT', '1h', 50);
  await tick();
  assert.equal(rest.calls, 1, 'bayat durumda her cagrida REST tamamlama tetiklenmemeli');
});

test('baglanti kopunca feed devre disi, yeniden baglaninca gecmis tekrar tamamlanir', async () => {
  const { feed, rest } = setup();
  feed.ensure('BTC/USDT', '1h', 50);
  FakeWS.instances[0].emit('open'); await tick(); await tick();
  assert.ok(feed.getCandles('BTC/USDT', '1h', 50));
  FakeWS.instances[0].emit('close');
  assert.equal(feed.getCandles('BTC/USDT', '1h', 50), null);
  await new Promise((r) => setTimeout(r, 30));                      // yeniden baglanma zamanlayicisi
  assert.equal(FakeWS.instances.length, 2);
  assert.equal(feed.getCandles('BTC/USDT', '1h', 50), null);       // yeni baglanti acilmadan hala null
  FakeWS.instances[1].emit('open'); await tick(); await tick();
  assert.equal(rest.calls, 2);
  assert.ok(feed.getCandles('BTC/USDT', '1h', 50));
  assert.equal(feed.stats.reconnects >= 1, true);
});

test('REST tamamlama basarisizsa feed servis etmez; kapanista soket kapanir', async () => {
  const { feed, rest } = setup();
  rest.fail = true;
  feed.ensure('BTC/USDT', '1h', 50);
  FakeWS.instances[0].emit('open'); await tick(); await tick();
  assert.equal(feed.getCandles('BTC/USDT', '1h', 50), null);
  assert.equal(feed.stats.backfillErrors, 1);
  feed.close();
  assert.equal(FakeWS.instances[0].closed, true);
  feed.ensure('BTC/USDT', '1h', 50);                                  // kapaliyken yeni baglanti acilmaz
  assert.equal(FakeWS.instances.length, 1);
});

test('desteklenmeyen aralik veya eksik ayar acik hata/yoksayma', () => {
  assert.throws(() => new CandleFeed({ fetchRest: async () => [] }), /wsUrl/);
  assert.throws(() => new CandleFeed({ wsUrl: 'wss://x' }), /fetchRest/);
  const { feed } = setup();
  feed.ensure('BTC/USDT', '7m', 10);
  assert.equal(feed.stores.size, 0);
});
