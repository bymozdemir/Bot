const ExchangeAdapter = require('./base');
const { fetchWithRetry } = require('../util/retry');

class PublicOnlyAdapter extends ExchangeAdapter {
  constructor(opts = {}, cfg = {}) {
    super(opts);
    this.id = cfg.id; this.name = cfg.name; this.quoteAssets = cfg.quoteAssets || ['USD'];
    this.baseUrl = String(opts.baseUrl || cfg.baseUrl).replace(/\/+$/, '');
    this.capabilities = { clientOrderId: false, orderQuery: false, balanceQuery: false, openOrdersQuery: false,
      userDataStream: false, oco: false, nativeTrailingOco: false, marketOrderBook: false,
      publicMarketData: true, liveTradingVerified: false };
  }
  async _get(path, params={}) {
    const q = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${q ? `?${q}` : ''}`;
    const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, { retries: 1, timeoutMs: 8000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${this.name} public API HTTP ${res.status}`);
    return data;
  }
  _unsupported() { throw new Error(`${this.name}: özel hesap/emir API'si henüz doğrulanmadı; canlı işlem kapalı.`); }
  async fetchBalance() { return this._unsupported(); }
  async fetchOpenOrders() { return this._unsupported(); }
  async createMarketOrder() { return this._unsupported(); }
  async createStopOrder() { return this._unsupported(); }
  async getOrder() { return this._unsupported(); }
  async cancelOrder() { return this._unsupported(); }
}
module.exports = PublicOnlyAdapter;
