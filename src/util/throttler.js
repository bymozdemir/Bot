// Agirlikli, kayan pencereli REST butce sinirlayici (Hummingbot AsyncThrottler fikrinden esinlendi).
// Ayni adaptorun butun herkese acik cagrilari (mum + ticker + defter) TEK butceden gecer; boylece
// parite sayisi artinca istek patlamasi 429/418'e donusmeden once sirayla bekletilir.
//
// - FIFO: gelen istekler sirayla servis edilir (aclik yok).
// - maxWaitMs asilirsa THROTTLE_WAIT hatasi: cagiran, toplam istek suresi butcesini asmadan hata alir.
// - weight > limit ise asla karsilanamaz: aninda hata.

class ThrottleError extends Error {
  constructor(message, code, retryAfterMs = 0) { super(message); this.name = 'ThrottleError'; this.code = code; this.retryAfterMs = retryAfterMs; }
}

class WeightedThrottler {
  constructor({ maxWeight = 2400, intervalMs = 60000, nowFn = Date.now, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (!(maxWeight > 0) || !(intervalMs > 0)) throw new Error('throttler: maxWeight ve intervalMs pozitif olmalı.');
    this.maxWeight = maxWeight;
    this.intervalMs = intervalMs;
    this.nowFn = nowFn;
    this.sleepFn = sleepFn;
    this.entries = []; // { at, weight }
    this._tail = Promise.resolve();
    this.stats = { acquired: 0, waited: 0, waitedMs: 0, rejected: 0 };
  }

  _prune(now) {
    while (this.entries.length && this.entries[0].at <= now - this.intervalMs) this.entries.shift();
  }
  used(now = this.nowFn()) { this._prune(now); return this.entries.reduce((s, e) => s + e.weight, 0); }

  acquire(weight = 1, { maxWaitMs = Infinity } = {}) {
    const w = Number(weight);
    if (!(w > 0)) return Promise.reject(new ThrottleError('throttler: ağırlık pozitif olmalı.', 'THROTTLE_BAD_WEIGHT'));
    if (w > this.maxWeight) { this.stats.rejected++; return Promise.reject(new ThrottleError(`throttler: ağırlık ${w} > bütçe ${this.maxWeight}.`, 'THROTTLE_TOO_HEAVY')); }
    const deadline = maxWaitMs === Infinity ? Infinity : this.nowFn() + maxWaitMs;
    const run = async () => {
      let waited = 0;
      for (;;) {
        const now = this.nowFn();
        this._prune(now);
        const used = this.entries.reduce((s, e) => s + e.weight, 0);
        if (used + w <= this.maxWeight) {
          this.entries.push({ at: now, weight: w });
          this.stats.acquired++;
          if (waited > 0) { this.stats.waited++; this.stats.waitedMs += waited; }
          return;
        }
        // En az gereken kadar eski girdinin dusmesini bekle.
        let freed = used, need = used + w - this.maxWeight, until = now + this.intervalMs;
        for (const e of this.entries) { freed -= e.weight; need -= e.weight; if (need <= 0) { until = e.at + this.intervalMs; break; } }
        const waitMs = Math.max(1, until - now);
        if (now + waitMs > deadline) {
          this.stats.rejected++;
          throw new ThrottleError(`throttler: istek bütçesi dolu, ~${Math.ceil(waitMs / 1000)} sn beklenmeli.`, 'THROTTLE_WAIT', waitMs);
        }
        await this.sleepFn(waitMs);
        waited += waitMs;
      }
    };
    const p = this._tail.then(run, run);
    this._tail = p.catch(() => {});
    return p;
  }
}

// Binance public REST agirliklari (resmi dokuman, tek sembol): klines 2, ticker/price 2, depth <=100 icin 5, ticker/24hr (tumu) 80.
const BINANCE_WEIGHTS = { '/api/v3/klines': 2, '/api/v3/ticker/price': 2, '/api/v3/depth': 5, '/api/v3/ticker/24hr': 80, '/api/v3/exchangeInfo': 20 };
const weightFor = (pathname, table = BINANCE_WEIGHTS) => table[pathname] || 2;

module.exports = { WeightedThrottler, ThrottleError, BINANCE_WEIGHTS, weightFor };
