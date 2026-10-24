// Denetim düzeltmeleri için regresyon testleri (aşama 8).
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');
const { OrderManager } = require('../src/orderManager');
const { runPortfolioBacktest } = require('../src/backtest/portfolioSimulator');
const { quantile, bootstrapTradeReturns } = require('../src/backtest/strategyGate');

const H = 3600000;

// ---------- 1) Strateji kapısı: yüzdelik dilim (quantile) ----------
test('quantile doğrusal enterpolasyon yapar (eski sürüm medyanı 5.5 yerine 8 veriyordu)', () => {
  const d = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.ok(Math.abs(quantile(d, 0.5) - 5.5) < 1e-9);
  assert.ok(Math.abs(quantile(d, 0.05) - 1.45) < 1e-9);
  assert.ok(Math.abs(quantile(d, 0.95) - 9.55) < 1e-9);
  assert.equal(quantile([7], 0.5), 7);
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([-3, -1, 2], 0.5), -1);
});

test('bootstrap sonuçları artık sıralı: p05 <= medyan <= p95 ve sınırlar gözlenen aralıkta', () => {
  const trades = Array.from({ length: 40 }, (_, i) => ({ pnlPct: i % 3 === 0 ? -2 : 1.5 }));
  const r = bootstrapTradeReturns(trades, 800, 42);
  assert.ok(r.p05 <= r.median && r.median <= r.p95);
  // Eski hata x[b] + x[b+1]*f verdiği için medyan/p95 gerçek dağılımın dışına taşabiliyordu.
  const best = trades.reduce((t, x) => t * (1 + Math.max(...trades.map((y) => y.pnlPct)) / 100), 1);
  assert.ok(r.p95 <= (best - 1) * 100 + 1e-6);
});

// ---------- 2) Portföy simülatörü: sonraki mumun AÇILIŞINDA doldurma ----------
function series(n, base, { gap = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const o = base + i * 0.5 + gap;
    const c = o + 0.2;
    return { t: 1_700_000_000_000 + i * H, o, h: c * 1.0005, l: o * 0.9995, c, v: 100 };
  });
}

function scriptedStrategy({ buyAtLen, sellAtLen }) {
  return {
    defaultParams: { stopLossPct: 50, takeProfitPct: 0, trailingStop: false },
    minCandles: () => 5,
    evaluate({ candles, position }) {
      if (!position && candles.length === buyAtLen) return { action: 'buy', reason: 'test-buy' };
      if (position && candles.length === sellAtLen) return { action: 'sell', reason: 'test-sell' };
      return { action: 'hold', reason: 'bekle' };
    }
  };
}

test('portföy simülatörü sinyal mumunun kapanışından değil, sonraki mumun açılışından doldurur', () => {
  const cs = series(40, 100);
  const r = runPortfolioBacktest({
    datasets: { A: { candles: cs } }, symbols: ['A'], strategy: scriptedStrategy({ buyAtLen: 10, sellAtLen: 20 }),
    capital: 1000, feePct: 0.1, slippagePct: 0.05, reserveCashPct: 10, maxConcurrentPositions: 3, budgetPct: 30
  });
  assert.equal(r.trades, 1);
  const t = r.tradeList[0];
  // Sinyal 10. mum kapanışında (index 9) üretildi: alım index 10 açılışında, satım (sinyal index 19) index 20 açılışında.
  assert.ok(Math.abs(t.entryPrice - cs[10].o * 1.0005) < 1e-9, `giriş ${t.entryPrice} beklenen ${cs[10].o * 1.0005}`);
  assert.ok(Math.abs(t.exitPrice - cs[20].o * 0.9995) < 1e-9, `çıkış ${t.exitPrice} beklenen ${cs[20].o * 0.9995}`);
  assert.notEqual(t.entryPrice, cs[9].c * 1.0005, 'sinyal mumunun kapanışından dolum (ileriye bakma) olmamalı');
});

test('portföy simülatörü son mumda yeni emir vermez ve açık pozisyonu zorla kapatır', () => {
  const cs = series(30, 100);
  const r = runPortfolioBacktest({
    datasets: { A: { candles: cs } }, symbols: ['A'], strategy: scriptedStrategy({ buyAtLen: 25, sellAtLen: 999 }),
    capital: 1000, feePct: 0.1, slippagePct: 0.05, reserveCashPct: 10, maxConcurrentPositions: 3, budgetPct: 30
  });
  assert.equal(r.trades, 1);
  assert.equal(r.tradeList[0].forced, true);
  const buyOnLast = runPortfolioBacktest({
    datasets: { A: { candles: cs } }, symbols: ['A'], strategy: scriptedStrategy({ buyAtLen: 30, sellAtLen: 999 }),
    capital: 1000, feePct: 0.1, slippagePct: 0.05, reserveCashPct: 10, maxConcurrentPositions: 3, budgetPct: 30
  });
  assert.equal(buyOnLast.trades, 0, 'son mumda üretilen sinyal uygulanamaz');
});

test('portföy bütçesi nakdin değil özkaynağın yüzdesidir (3 pozisyon eşit boyutta)', () => {
  const flat = (base) => Array.from({ length: 40 }, (_, i) => ({ t: 1_700_000_000_000 + i * H, o: base, h: base, l: base, c: base, v: 1 }));
  const ds = { A: { candles: flat(100) }, B: { candles: flat(100) }, C: { candles: flat(100) } };
  const r = runPortfolioBacktest({
    datasets: ds, symbols: ['A', 'B', 'C'], strategy: scriptedStrategy({ buyAtLen: 10, sellAtLen: 999 }),
    capital: 1000, feePct: 0.1, slippagePct: 0.05, reserveCashPct: 10, maxConcurrentPositions: 3, budgetPct: 30
  });
  assert.equal(r.trades, 3);
  const fee = 0.001, buy = 100 * 1.0005, sell = 100 * 0.9995;
  const ratio = (sell * (1 - fee)) / (buy * (1 + fee)); // her 1 birim harcamanın geri dönüşü
  const expectedFinal = 1000 - 900 * (1 - ratio);       // 3 x %30 = 900 yatırılır
  assert.ok(Math.abs(r.finalEquity - expectedFinal) < 0.05, `final ${r.finalEquity} beklenen ${expectedFinal}`);
});

// ---------- 3) OrderManager: komisyonlar geriye gitmez ----------
test('reconcile REST yanıtı WebSocket komisyonunun üstüne yazmaz (varlık bazında MAX)', async () => {
  const state = { liveOrders: {} };
  const ex = {
    id: 'binance', name: 'T',
    capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true },
    async createMarketOrder() { throw new Error('kullanılmamalı'); },
    async getOrder() {
      return { symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', orderId: 5, clientOrderId: 'c1', executedQty: '1', origQty: '1', cummulativeQuoteQty: '100', fills: [{ commission: '0.1', commissionAsset: 'BNB' }] };
    },
    async fetchTicker(sym) { if (sym === 'BNB/USDT') return { price: 300 }; throw new Error('yok'); }
  };
  const om = new OrderManager({ exchange: ex, state, store: { save() {} } });
  state.liveOrders.c1 = { clientOrderId: 'c1', symbol: 'BTC/USDT', side: 'buy', status: 'NEW', exchangeOrderId: 5, executedQty: 1, quoteQty: 100, commissionByAsset: { BNB: 0.5 } };
  const rec = await om.reconcile('c1');
  assert.equal(rec.status, 'FILLED');
  assert.equal(rec.commissionByAsset.BNB, 0.5, 'daha küçük REST komisyonu daha büyük birikmiş değerin üstüne yazmamalı');
});

// ---------- 4) Canlı motor: acil çıkış alış filtrelerine takılmaz ----------
function liveFixture() {
  const state = store.defaultState();
  state.settings.mode = 'live';
  state.live.positions['BTC/USDT'] = { symbol: 'BTC/USDT', baseAsset: 'BTC', quoteAsset: 'USDT', quantity: 1, entryPrice: 100, costQuote: 100, stopOrderId: null, stopPrice: 95 };
  const ex = {
    id: 'binance', environment: 'testnet', name: 'Test', quoteAssets: ['USDT'],
    capabilities: { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, liveTradingVerified: true },
    async fetchSymbolRules() { return { stepSize: 0.001, minQty: 0.001, minNotional: 10 }; },
    // %2 spread: normal eşik (%0.75) aşılır, acil eşik (%5) aşılmaz. Derinlik bol.
    async fetchOrderBook() { return { bids: [[98, 50]], asks: [[100, 50]] }; },
    async createMarketOrder(symbol, side, amount, cid) { return { status: 'FILLED', orderId: 11, clientOrderId: cid, executedQty: amount, origQty: amount, cummulativeQuoteQty: amount * 98 }; },
    async getOrder() { return { status: 'FILLED', orderId: 11, clientOrderId: 'x', executedQty: 1, origQty: 1, cummulativeQuoteQty: 98 }; },
    async cancelOrder(symbol, orderId) { return { status: 'CANCELED', orderId }; },
    async fetchTicker() { return { price: 99 }; }
  };
  const engine = new LiveEngine({ exchange: ex, state, store: { save() {} }, allowLive: true });
  return { engine, state };
}

test('normal satış geniş spreadde reddedilir ama ACİL çıkış pozisyonu kapatır', async () => {
  const a = liveFixture();
  await assert.rejects(() => a.engine.sell('BTC/USDT', a.state.live.positions['BTC/USDT'], 99, 'normal', a.engine.epoch), /MARKET emir güvenlik kontrolü reddetti/);
  assert.ok(a.state.live.positions['BTC/USDT'], 'normal satış reddedilince pozisyon yerinde kalır');

  const b = liveFixture();
  await b.engine.sell('BTC/USDT', b.state.live.positions['BTC/USDT'], 99, 'risk limiti', b.engine.epoch, { emergency: true });
  assert.equal(b.state.live.positions['BTC/USDT'], undefined, 'acil çıkış pozisyonu kapatmalı');
  assert.equal(b.state.live.lastMarketSafety.emergency, true);
});

test('acil çıkış bile order book tüm miktarı karşılayamıyorsa reddedilir', async () => {
  const c = liveFixture();
  c.engine.exchange.fetchOrderBook = async () => ({ bids: [[98, 0.2]], asks: [[100, 50]] });
  await assert.rejects(() => c.engine.sell('BTC/USDT', c.state.live.positions['BTC/USDT'], 99, 'risk', c.engine.epoch, { emergency: true }), /derinlik|güvenlik/);
  assert.ok(c.state.live.positions['BTC/USDT']);
});
