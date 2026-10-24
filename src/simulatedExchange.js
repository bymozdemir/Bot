// API gerektirmeyen deterministik borsa simulasyonu.
// Canli Binance yerine kodun emir/recovery/risk akislarini test etmek icin kullanilir.
class SimulatedExchange {
  constructor({ quoteAsset = 'USDT', startingQuote = 1000, prices = {} } = {}) {
    this.id = 'simulation';
    this.name = 'Simulation';
    this.quoteAssets = [quoteAsset];
    this.capabilities = {
      clientOrderId: true, orderQuery: true, balanceQuery: true,
      openOrdersQuery: true, userDataStream: false, oco: true, nativeTrailingOco: true, liveTradingVerified: true
    };
    this.balances = { [quoteAsset]: { free: Number(startingQuote), locked: 0 } };
    this.prices = { ...prices };
    this.orders = new Map();
    this.nextId = 1;
    this.failure = null;
    this.executionEvents = [];
  }
  setPrice(symbol, price) { this.prices[symbol] = Number(price); }
  setFailure(failure) { this.failure = failure || null; }
  _consumeFailure(kind) {
    if (!this.failure || this.failure.kind !== kind) return null;
    const f = this.failure;
    if (!f.keep) this.failure = null;
    return f;
  }
  _maybeFail(kind) {
    const f = this._consumeFailure(kind);
    if (!f) return;
    const e = new Error(f.message || `simulation ${kind} failure`);
    e.unknownOutcome = !!f.unknownOutcome;
    e.httpStatus = f.httpStatus || null;
    throw e;
  }
  async fetchBalance() { this._maybeFail('balance'); return JSON.parse(JSON.stringify(this.balances)); }
  async fetchOpenOrders() {
    this._maybeFail('openOrders');
    return [...this.orders.values()].filter(o => !['FILLED','CANCELED','REJECTED','EXPIRED'].includes(o.status));
  }
  async fetchTicker(symbol) { return { symbol, price: this.prices[symbol] || 100 }; }
  async fetchCandles() { return []; }
  async fetchSymbolRules(symbol) { return { symbol, stepSize: 0.000001, minQty: 0.000001, minNotional: 1, marketStepSize: 0.000001, marketMinQty: 0.000001, tickSize: 0.01 }; }
  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const failure = this._consumeFailure('market');
    if (failure && !failure.executeBeforeError) {
      const e = new Error(failure.message || 'simulation market failure');
      e.unknownOutcome = !!failure.unknownOutcome;
      e.httpStatus = failure.httpStatus || null;
      throw e;
    }
    const price = Number(this.prices[symbol] || 100);
    const quote = this.quoteAssets[0];
    const base = symbol.split('/')[0];
    const qty = Number(amount);
    const cost = qty * price;
    const id = this.nextId++;
    if (side === 'buy') {
      if ((this.balances[quote]?.free || 0) < cost) throw new Error('simulation insufficient quote balance');
      this.balances[quote].free -= cost;
      this.balances[base] = this.balances[base] || { free: 0, locked: 0 };
      this.balances[base].free += qty;
    } else {
      const have = this.balances[base]?.free || 0;
      if (have + 1e-12 < qty) throw new Error('simulation insufficient base balance');
      this.balances[base].free -= qty;
      this.balances[quote].free += cost;
    }
    let executedQty = qty;
    let status = 'FILLED';
    const partialPct = failure && Number.isFinite(Number(failure.partialPct)) ? Math.max(0, Math.min(100, Number(failure.partialPct))) : null;
    if (partialPct !== null && partialPct < 100) {
      // Roll back the unfilled portion because only the executed quantity changes balances.
      const unfilled = qty - (qty * partialPct / 100);
      if (side === 'buy') {
        this.balances[quote].free += unfilled * price;
        this.balances[base].free -= unfilled;
      } else {
        this.balances[base].free += unfilled;
        this.balances[quote].free -= unfilled * price;
      }
      executedQty = qty * partialPct / 100;
      status = 'PARTIALLY_FILLED';
    }
    const order = { orderId:id, clientOrderId, symbol, side:side.toLowerCase(), status, executedQty, origQty:qty, cummulativeQuoteQty:executedQty * price };
    this.orders.set(clientOrderId, order);
    this.executionEvents.push({ type:'execution', clientOrderId, orderId:id, executedQty });
    if (failure && failure.executeBeforeError) {
      const e = new Error(failure.message || 'simulation market result unknown after execution');
      e.unknownOutcome = !!failure.unknownOutcome;
      e.httpStatus = failure.httpStatus || null;
      throw e;
    }
    return order;
  }
  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    const failure = this._consumeFailure('stop');
    if (failure && !failure.executeBeforeError) {
      const e = new Error(failure.message || 'simulation stop failure');
      e.unknownOutcome = !!failure.unknownOutcome;
      e.httpStatus = failure.httpStatus || null;
      throw e;
    }
    const id = this.nextId++;
    const order = { orderId:id, clientOrderId, symbol, side:side.toLowerCase(), status:'NEW', executedQty:0, origQty:Number(amount), stopPrice:Number(stopPrice), price:Number(limitPrice), cummulativeQuoteQty:0 };
    this.orders.set(clientOrderId, order);
    if (failure && failure.executeBeforeError) {
      const e = new Error(failure.message || 'simulation stop result unknown after creation');
      e.unknownOutcome = !!failure.unknownOutcome;
      e.httpStatus = failure.httpStatus || null;
      throw e;
    }
    return order;
  }
  async getOrder(symbol, orderId, clientOrderId) {
    this._maybeFail('getOrder');
    const o = clientOrderId ? this.orders.get(clientOrderId) : [...this.orders.values()].find(x => x.orderId === orderId && x.symbol === symbol);
    if (!o) throw new Error('simulation order not found');
    return o;
  }
  async createTakeProfitOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    return { status: 'NEW', orderId: `tp-${Date.now()}`, clientOrderId, symbol, side, executedQty: 0, origQty: amount, stopPrice };
  }

  async cancelOrder(symbol, orderId) {
    const failure = this._consumeFailure('cancel');
    const o = [...this.orders.values()].find(x => x.orderId === orderId && x.symbol === symbol);
    if (!o) throw new Error('simulation order not found');
    o.status = 'CANCELED';
    if (failure) {
      const e = new Error(failure.message || 'simulation cancel result unknown after cancellation');
      e.unknownOutcome = !!failure.unknownOutcome;
      e.httpStatus = failure.httpStatus || null;
      if (failure.executeBeforeError) throw e;
      throw e;
    }
    return o;
  }
  triggerStop(clientOrderId) {
    const o = this.orders.get(clientOrderId);
    if (!o || o.status !== 'NEW') throw new Error('simulation stop not open');
    const price = Number(this.prices[o.symbol] || o.stopPrice);
    const base = o.symbol.split('/')[0], quote = this.quoteAssets[0];
    const qty = Number(o.origQty);
    this.balances[base] = this.balances[base] || { free: 0, locked: 0 };
    const sellQty = Math.min(qty, this.balances[base].free);
    this.balances[base].free -= sellQty;
    this.balances[quote].free += sellQty * price;
    o.status = 'FILLED'; o.executedQty = sellQty; o.cummulativeQuoteQty = sellQty * price;
    return o;
  }
}
module.exports = { SimulatedExchange };
