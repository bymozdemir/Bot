// Testler icin ortak yardimcilar (bagimlilik yok, sadece Node'un kendi modulleri).
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');

const H = 3600000;
const T0 = Date.now() - 299 * H;
const candles = (closes) => closes.map((c, i) => ({ t: T0 + i * H, o: c, h: c, l: c, c, v: 1 }));
const flat = (n, price) => candles(Array.from({ length: n }, () => price));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Diske dokunmayan, log'lari console yerine state'e yazan test motoru.
function makeEngine({ exchange, state, onUpdate } = {}) {
  const st = state || store.defaultState();
  const ex = exchange || {
    id: 'fake',
    name: 'Fake',
    quoteAssets: ['USDT'],
    fetchCandles: async () => flat(300, 100),
    fetchSymbolRules: async () => ({ minNotional: 10 })
  };
  const engine = new PaperEngine({ exchange: ex, store: { save() {} }, state: st, onUpdate });
  engine.log = function (msg, level = 'info') {
    this.state.log.unshift({ t: new Date().toISOString(), msg, level });
  };
  return { engine, state: st };
}

// Tek parite, verilen strateji karariyla.
function onlyPair(state, symbol = 'BTC/USDT') {
  state.pairs = { [symbol]: state.pairs[symbol] || Object.values(state.pairs)[0] };
  state.pairs[symbol].symbol = symbol;
  return state.pairs[symbol];
}

module.exports = { candles, flat, sleep, makeEngine, onlyPair, store };
