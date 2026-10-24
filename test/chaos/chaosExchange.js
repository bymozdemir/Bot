'use strict';
// Kaos ortami: gercek bir spot borsanin emir durum makinesini, bakiye muhasebesini ve
// agin kotu davranislarini (gecikme, sira bozulmasi, tekrar, kayip WS olayi, eski REST cevabi,
// belirsiz zaman asimi) tohumlu (seeded) rastgelelikle taklit eder. Ayni tohum = ayni senaryo.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ChaosExchange {
  constructor(rng, opts = {}) {
    this.rng = rng;
    this.id = 'binance';
    this.name = 'Chaos';
    this.environment = 'testnet';
    this.quoteAssets = ['USDT'];
    this.capabilities = { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: false, marketOrderBook: false, liveTradingVerified: true, verifiesResponseSymbol: true, orderTrades: opts.orderTrades !== false, orderNotFoundIsDefinitive: true };
    this.symbol = 'BTCUSDT';
    this.orders = new Map();        // orderId -> order (gercek durum)
    this.byCid = new Map();
    this.nextId = 100;
    this.eventCounter = 1;
    this.pending = [];              // henuz teslim edilmemis WS olaylari
    this.deliver = null;            // (event) => void ; harness baglar
    this.price = 100;
    this.balances = { BTC: { free: opts.btc ?? 0, locked: 0 }, ETH: { free: opts.eth ?? 0, locked: 0 }, USDT: { free: opts.usdt ?? 100000, locked: 0 } };
    this.bases = { BTCUSDT: 'BTC', ETHUSDT: 'ETH' };
    this.marketSells = [];          // gonderilen market satislari (oversell denetimi)
    this.p = Object.assign({ errorProb: 0.08, staleProb: 0.35, dropProb: 0.12, dupProb: 0.2, injectProb: 0.5, unknownProb: 0.06 }, opts.p || {});
    this.onAwait = null;            // her await noktasinda kaos enjekte eden kanca
    this.trace = null;              // hata ayiklama: senkron olay kaydi (ek await yok)
  }

  chance(p) { return this.rng() < p; }

  _t(msg) { if (this.trace) this.trace.push(`${msg} | BTC free=${this.balances.BTC.free.toFixed(6)} locked=${this.balances.BTC.locked.toFixed(6)}`); }

  async tick() {
    const g = this.gen || 0;
    await Promise.resolve();
    // Surec coktuyse (gen artti) eski surecin devam eden akislari sonsuza dek asili kalir: hicbir sey yapamaz.
    if (g !== (this.gen || 0)) await new Promise(() => {});
    if (this.crashCountdown !== undefined && --this.crashCountdown === 0 && this.onCrash) {
      this.onCrash();
      await new Promise(() => {});
    }
    if (this.onAwait && this.chance(this.p.injectProb)) this.onAwait();
  }

  snapshot(o, { withFills = true } = {}) {
    return {
      orderId: o.id, clientOrderId: o.cid, symbol: o.sym || this.symbol, side: o.side.toUpperCase(), type: o.type,
      status: o.status, origQty: String(o.orig), executedQty: String(o.exec), cummulativeQuoteQty: String(o.quote),
      fills: !withFills ? [] : o.fills.map((f) => ({ tradeId: f.id, qty: String(f.qty), price: String(f.price), commission: String(f.commission), commissionAsset: f.asset }))
    };
  }

  // --- gercek durum degisimleri ---
  _event(o, trade, x) {
    const ev = { e: 'executionReport', c: o.cid, i: o.id, s: o.sym || this.symbol, S: o.side.toUpperCase(), X: o.status, x, z: String(o.exec), Z: String(o.quote), q: String(o.orig), t: trade ? trade.id : -1, I: this.eventCounter, E: this.eventCounter++, N: trade ? trade.asset : null, n: trade ? String(trade.commission) : '0' };
    this.pending.push(ev);
    return ev;
  }

  fillStep(o, forceFull = false) {
    if (['FILLED', 'CANCELED', 'EXPIRED'].includes(o.status)) return false;
    const remaining = o.orig - o.exec;
    if (!(remaining > 1e-12)) return false;
    const qty = forceFull || this.chance(0.4) ? remaining : Math.round(remaining * (0.2 + this.rng() * 0.6) * 1e8) / 1e8;
    const q = qty >= remaining - 1e-12 ? remaining : qty;
    const price = this.price;
    const base = o.base || 'BTC';
    const feeAsset = this.chance(0.2) ? 'BNB' : (o.side === 'buy' ? base : 'USDT');
    const commission = feeAsset === base ? q * 0.001 : (feeAsset === 'USDT' ? q * price * 0.001 : q * 0.0005);
    const trade = { id: `t${this.nextId++}`, qty: q, price, commission: Math.round(commission * 1e10) / 1e10, asset: feeAsset };
    o.fills.push(trade);
    o.exec = Math.round((o.exec + q) * 1e10) / 1e10;
    o.quote = Math.round((o.quote + q * price) * 1e8) / 1e8;
    o.status = o.exec >= o.orig - 1e-12 ? 'FILLED' : 'PARTIALLY_FILLED';
    if (o.status === 'FILLED') o.exec = o.orig;
    // bakiye muhasebesi
    if (o.side === 'sell') {
      this.balances[base].locked = Math.max(0, this.balances[base].locked - (o.locked ? q : 0));
      if (!o.locked) this.balances[base].free -= q;
      this.balances.USDT.free += q * price - (feeAsset === 'USDT' ? trade.commission : 0);
    } else {
      this.balances.USDT.free -= q * price;
      this.balances[base].free += q - (feeAsset === base ? trade.commission : 0);
    }
    this._event(o, trade, 'TRADE');
    this._t(`FILL ${o.cid.slice(-5)} ${o.type} q=${q.toFixed(5)} -> ${o.status} exec=${o.exec}`);
    return true;
  }

  // Rastgele bir acik emri ilerlet (borsada gercekten tetiklenme / dolum).
  advanceRandom() {
    const open = [...this.orders.values()].filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
    if (!open.length) return false;
    const o = open[Math.floor(this.rng() * open.length)];
    return this.fillStep(o);
  }

  cancelTruth(o) {
    if (o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED') return false;
    o.status = 'CANCELED';
    if (o.side === 'sell' && o.locked) {
      const left = o.orig - o.exec;
      const b = o.base || 'BTC';
      this.balances[b].locked = Math.max(0, this.balances[b].locked - left);
      this.balances[b].free += left;
    }
    this._event(o, null, 'CANCELED');
    this._t(`CANCEL-TRUTH ${o.cid.slice(-5)} exec=${o.exec}`);
    return true;
  }

  // --- WS teslimati: sira bozma, tekrar, kayip ---
  pump(max = 3) {
    for (let i = 0; i < max && this.pending.length; i++) {
      const idx = Math.floor(this.rng() * this.pending.length);   // sira bozulur
      const [ev] = this.pending.splice(idx, 1);
      if (this.chance(this.p.dropProb)) continue;                  // olay kayboldu
      if (this.deliver) this.deliver(ev);
      if (this.chance(this.p.dupProb) && this.deliver) this.deliver({ ...ev });   // tekrar
    }
  }

  flushAll({ lossy = false } = {}) {
    while (this.pending.length) {
      const idx = Math.floor(this.rng() * this.pending.length);
      const [ev] = this.pending.splice(idx, 1);
      if (lossy && this.chance(this.p.dropProb)) continue;
      if (this.deliver) this.deliver(ev);
    }
  }

  // --- REST yuzeyi ---
  _newOrder({ symbol, side, amount, cid, type, locked = false }) {
    const sym = String(symbol).replace('/', '').toUpperCase();
    const o = { id: this.nextId++, cid, side, type, sym, base: this.bases[sym] || 'BTC', orig: Number(amount), exec: 0, quote: 0, status: 'NEW', fills: [], locked };
    this.orders.set(o.id, o); this.byCid.set(cid, o);
    return o;
  }

  async createMarketOrder(symbol, side, amount, cid) {
    if (this.onCreate) this.onCreate(cid, 'market');
    this._t(`CALL createMarket ${side} ${amount}`);
    await this.tick();
    if (this.chance(this.p.errorProb)) throw Object.assign(new Error('insufficient balance'), { httpStatus: 400 });
    if (side === 'sell') {
      const sym = String(symbol).replace('/', '').toUpperCase(); const bs = this.bases[sym] || 'BTC';
      const stopsFilled = [...this.orders.values()].some((x) => x.locked && x.status === 'FILLED' && x.sym === sym);
      this.marketSells.push({ cid, sym, amount: Number(amount), freeAtCall: this.balances[bs].free, lockedAtCall: this.balances[bs].locked, stopFilledAtCall: stopsFilled });
      if (this.balances[bs].free < Number(amount) - 1e-9) throw Object.assign(new Error('insufficient balance'), { httpStatus: 400 });
    }
    const o = this._newOrder({ symbol, side, amount, cid, type: 'MARKET' });
    const unknown = this.chance(this.p.unknownProb);   // emir gitti ama istemci yaniti goremedi
    this.fillStep(o, this.chance(0.7));
    if (this.chance(0.3)) this.fillStep(o, true);
    if (o.status === 'PARTIALLY_FILLED') { o.status = 'EXPIRED'; this._event(o, null, 'EXPIRED'); }   // market emri acik-kismi kalmaz
    const snap = this.snapshot(o);
    await this.tick();
    if (unknown) throw Object.assign(new Error('timeout'), { unknownOutcome: true });
    return this.chance(this.p.staleProb) ? snap : this.snapshot(o);
  }

  async createStopOrder(symbol, side, amount, stop, limit, cid) {
    if (this.onCreate) this.onCreate(cid, 'stop');
    this._t(`CALL createStop ${cid.slice(-5)} ${amount}`);
    await this.tick();
    if (this.chance(this.p.errorProb)) throw Object.assign(new Error('rejected'), { httpStatus: 400 });
    const bs0 = this.bases[String(symbol).replace('/', '').toUpperCase()] || 'BTC';
    if (this.balances[bs0].free < Number(amount) - 1e-9) throw Object.assign(new Error('insufficient balance'), { httpStatus: 400 });
    const o = this._newOrder({ symbol, side: 'sell', amount, cid, type: 'STOP_LOSS_LIMIT', locked: true });
    this.balances[o.base].free -= Number(amount); this.balances[o.base].locked += Number(amount);
    const unknown = this.chance(this.p.unknownProb);
    const snap = this.snapshot(o);
    await this.tick();
    if (unknown) throw Object.assign(new Error('timeout'), { unknownOutcome: true });
    return this.chance(this.p.staleProb) ? snap : this.snapshot(o);
  }

  async getOrder(symbol, orderId, cid) {
    const early = this.chance(this.p.staleProb);
    const o = this.orders.get(Number(orderId)) || this.byCid.get(cid);
    if (!o) throw Object.assign(new Error('Order does not exist.'), { httpStatus: 400, binanceCode: -2013 });
    const wf = { withFills: this.p.restFills !== false };
    const snap = early ? this.snapshot(o, wf) : null;
    await this.tick();
    if (this.chance(this.p.errorProb)) throw Object.assign(new Error('network'), { unknownOutcome: true });
    return early ? snap : this.snapshot(o, wf);
  }

  async cancelOrder(symbol, orderId) {
    this._t(`CALL cancel ${orderId}`);
    await this.tick();
    const o = this.orders.get(Number(orderId));
    if (!o) throw Object.assign(new Error('Unknown order sent.'), { httpStatus: 400, code: -2011 });
    if (this.chance(this.p.errorProb)) throw Object.assign(new Error('network'), { unknownOutcome: true });
    if (['FILLED', 'CANCELED', 'EXPIRED'].includes(o.status)) {
      // Gercek Binance: terminal emri iptal etmek -2011 "Unknown order sent." doner.
      throw Object.assign(new Error('Unknown order sent.'), { httpStatus: 400, code: -2011 });
    }
    this.cancelTruth(o);
    const snap = this.snapshot(o);
    await this.tick();
    return snap;
  }

  async getOrderTrades(symbol, orderId) {
    await this.tick();
    if (this.chance(this.p.errorProb)) throw Object.assign(new Error('network'), { unknownOutcome: true });
    const o = this.orders.get(Number(orderId));
    if (!o) throw Object.assign(new Error('Order does not exist'), { httpStatus: 400 });
    return o.fills.map((f) => ({ tradeId: f.id, orderId: o.id, price: String(f.price), qty: String(f.qty), commission: String(f.commission), commissionAsset: f.asset }));
  }

  async fetchBalance() {
    await this.tick();
    const clean = (b) => { const free = Math.max(0, Math.round(b.free * 1e10) / 1e10); const locked = Math.max(0, Math.round(b.locked * 1e10) / 1e10); return { free, locked, total: free + locked }; };
    return { BTC: clean(this.balances.BTC), ETH: clean(this.balances.ETH), USDT: clean(this.balances.USDT) };
  }
  async fetchOpenOrders() { await this.tick(); return [...this.orders.values()].filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED').map((o) => this.snapshot(o)); }
  async fetchCandles() { return []; }
  async fetchTicker() { return { price: this.price }; }
  async fetchSymbolRules() { return { stepSize: 0.00001, minQty: 0.00001, minNotional: 1, tickSize: 0.01 }; }
}

module.exports = { ChaosExchange, mulberry32 };
