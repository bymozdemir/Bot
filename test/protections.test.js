const test = require('node:test');
const assert = require('node:assert/strict');
const { checkProtections, normalizeProtections, maxDrawdownOf } = require('../src/protections');

const NOW = Date.parse('2026-10-24T12:00:00Z');
const MIN = 60000;
const trade = (symbol, minsAgo, pnlPct, reason = 'stop-loss', pnl = pnlPct) => ({ symbol, pnlPct, pnl, reason, closedAt: new Date(NOW - minsAgo * MIN).toISOString() });
const on = (extra = {}) => ({ enabled: true, cooldown: { enabled: false }, stoplossGuard: { enabled: false }, maxDrawdown: { enabled: false }, lowProfitPairs: { enabled: false }, ...extra });

test('varsayilan: kapali, hicbir sey engellenmez', () => {
  const r = checkProtections({ trades: [trade('BTC/USDT', 1, -5)], symbol: 'BTC/USDT', now: NOW, config: undefined });
  assert.equal(r.blocked, false);
});

test('bozuk ayarlar varsayilana duser, istisna firlatmaz', () => {
  const n = normalizeProtections({ enabled: 'evet', cooldown: { minutes: -5 }, stoplossGuard: { tradeLimit: 2.5 }, __proto__: { x: 1 } });
  assert.equal(n.enabled, false);
  assert.equal(n.cooldown.minutes, 60);
  assert.equal(n.stoplossGuard.tradeLimit, 3);
});

test('cooldown: cikistan sonra sure dolana kadar o parite kilitli, digerleri serbest', () => {
  const cfg = on({ cooldown: { enabled: true, minutes: 60 } });
  const trades = [trade('BTC/USDT', 20, 2, 'sinyal')];
  const a = checkProtections({ trades, symbol: 'BTC/USDT', now: NOW, config: cfg });
  assert.equal(a.blocked, true);
  assert.equal(a.scope, 'pair');
  assert.equal(a.until, NOW - 20 * MIN + 60 * MIN);
  assert.equal(checkProtections({ trades, symbol: 'ETH/USDT', now: NOW, config: cfg }).blocked, false);
  assert.equal(checkProtections({ trades, symbol: 'BTC/USDT', now: NOW + 41 * MIN, config: cfg }).blocked, false);
});

test('stoploss guard: pencere icinde yeterli stop varsa parite kilitlenir', () => {
  const cfg = on({ stoplossGuard: { enabled: true, tradeLimit: 2, lookbackMinutes: 120, lockMinutes: 90, onlyPerPair: true } });
  const trades = [trade('BTC/USDT', 30, -2), trade('BTC/USDT', 70, -3), trade('ETH/USDT', 10, -2)];
  const r = checkProtections({ trades, symbol: 'BTC/USDT', now: NOW, config: cfg });
  assert.equal(r.blocked, true);
  assert.equal(r.rule, 'stoplossGuard');
  assert.equal(checkProtections({ trades, symbol: 'ETH/USDT', now: NOW, config: cfg }).blocked, false); // onlyPerPair
});

test('stoploss guard: kar ile kapanan stop (profit-protection) ve pencere disi islemler sayilmaz', () => {
  const cfg = on({ stoplossGuard: { enabled: true, tradeLimit: 2, lookbackMinutes: 120, lockMinutes: 90 } });
  const trades = [trade('BTC/USDT', 30, -2), trade('BTC/USDT', 40, 1.5, 'profit-protection stop'), trade('BTC/USDT', 500, -3)];
  assert.equal(checkProtections({ trades, symbol: 'BTC/USDT', now: NOW, config: cfg }).blocked, false);
});

test('stoploss guard: global kilit tum paritelere uygulanir', () => {
  const cfg = on({ stoplossGuard: { enabled: true, tradeLimit: 3, lookbackMinutes: 240, lockMinutes: 60 } });
  const trades = [trade('BTC/USDT', 10, -2), trade('ETH/USDT', 20, -2), trade('SOL/USDT', 30, -2)];
  const r = checkProtections({ trades, symbol: 'XRP/USDT', now: NOW, config: cfg });
  assert.equal(r.blocked, true);
  assert.equal(r.scope, 'global');
});

test('kilit suresi dolunca otomatik acilir (durumsuz, yeniden baslatmada kaybolmaz)', () => {
  const cfg = on({ stoplossGuard: { enabled: true, tradeLimit: 1, lookbackMinutes: 600, lockMinutes: 30 } });
  const trades = [trade('BTC/USDT', 10, -2)];
  assert.equal(checkProtections({ trades, symbol: 'BTC/USDT', now: NOW, config: cfg }).blocked, true);
  assert.equal(checkProtections({ trades, symbol: 'BTC/USDT', now: NOW + 21 * MIN, config: cfg }).blocked, false);
});

test('max drawdown: kumulatif K/Z dususu referans ozkaynaga gore esigi asinca global kilit', () => {
  assert.ok(Math.abs(maxDrawdownOf([5, -10, 3, -2], 100) - 10) < 1e-9);
  const cfg = on({ maxDrawdown: { enabled: true, tradeLimit: 3, lookbackMinutes: 600, maxDrawdownPct: 5, lockMinutes: 120 } });
  const trades = [trade('A/USDT', 90, 0, 'sinyal', 4), trade('B/USDT', 60, 0, 'sinyal', -6), trade('C/USDT', 30, 0, 'sinyal', -3)];
  const r = checkProtections({ trades, symbol: 'D/USDT', now: NOW, config: cfg, referenceEquity: 100 });
  assert.equal(r.blocked, true);
  assert.equal(r.rule, 'maxDrawdown');
  assert.equal(checkProtections({ trades, symbol: 'D/USDT', now: NOW, config: cfg, referenceEquity: 1000 }).blocked, false);
});

test('low profit pairs: ortalama getirisi esigin altindaki parite kilitlenir', () => {
  const cfg = on({ lowProfitPairs: { enabled: true, tradeLimit: 3, lookbackMinutes: 600, requiredProfitPct: 0.5, lockMinutes: 60 } });
  const trades = [trade('BTC/USDT', 10, 0.1, 'sinyal'), trade('BTC/USDT', 50, -0.2, 'sinyal'), trade('BTC/USDT', 90, 0.2, 'sinyal')];
  assert.equal(checkProtections({ trades, symbol: 'BTC/USDT', now: NOW, config: cfg }).rule, 'lowProfitPairs');
  assert.equal(checkProtections({ trades, symbol: 'ETH/USDT', now: NOW, config: cfg }).blocked, false);
});

test('bozuk islem kayitlari (tarih/sayi) istisna firlatmaz', () => {
  const cfg = on({ cooldown: { enabled: true, minutes: 60 }, stoplossGuard: { enabled: true, tradeLimit: 1 } });
  const bad = [null, {}, { symbol: 'BTC/USDT', closedAt: 'yok', pnlPct: 'x' }, { symbol: 'BTC/USDT', closedAt: new Date(NOW).toISOString(), pnlPct: NaN, reason: 'stop' }];
  assert.doesNotThrow(() => checkProtections({ trades: bad.filter(Boolean), symbol: 'BTC/USDT', now: NOW, config: cfg }));
  assert.doesNotThrow(() => checkProtections({ trades: 'x', symbol: 'BTC/USDT', now: NOW, config: cfg }));
});
