const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const { checkRiskExit } = require('../src/strategies/riskExit');
const { flat, candles } = require('./helpers');

const pos = (over = {}) => ({ entryPrice: 100, stopPrice: 97, highWaterMark: 100, quantity: 1, ...over });

test('her stratejide: veri yetersizken bile stop-loss tetiklenir', () => {
  for (const s of strategies.list()) {
    const strat = strategies.get(s.id);
    const d = strat.evaluate({ candles: flat(3, 50), position: pos(), params: strat.defaultParams });
    assert.equal(d.action, 'sell', `${s.id}: ${JSON.stringify(d)}`);
    assert.match(d.reason, /stop-loss/);
  }
});

test('her stratejide: pozisyon yokken yetersiz veri hold doner', () => {
  for (const s of strategies.list()) {
    const strat = strategies.get(s.id);
    const d = strat.evaluate({ candles: flat(3, 50), position: null, params: strat.defaultParams });
    assert.equal(d.action, 'hold');
  }
});

test('take-profit artık satış değil, dinamik kâr koruma eşiğidir', () => {
  const p = pos();
  const params = { stopLossPct: 3, takeProfitPct: 6, trailingStop: false };
  assert.equal(checkRiskExit(p, 106, params), null);
  assert.equal(p.highWaterMark, 106);
  const d = checkRiskExit(p, 102.82, params);
  assert.equal(d.action, 'sell');
  assert.match(d.reason, /profit-protection/);
});


test('kâr koruma, stopLossPct TPden büyük olsa bile başabaş altına inmez', () => {
  const p = pos();
  const params = { stopLossPct: 8, takeProfitPct: 5, trailingStop: false };
  assert.equal(checkRiskExit(p, 105, params), null);
  assert.equal(p.highWaterMark, 105);
  const d = checkRiskExit(p, 100.19, params);
  assert.equal(d.action, 'sell');
  assert.match(d.reason, /profit-protection/);
});

test('trailing stop: zirve yukselir, geri cekilince satar', () => {
  const p = pos();
  const params = { stopLossPct: 3, takeProfitPct: 50, trailingStop: true };
  assert.equal(checkRiskExit(p, 110, params), null);
  assert.equal(p.highWaterMark, 110);
  const d = checkRiskExit(p, 106, params); // 110*0.97 = 106.7
  assert.equal(d.action, 'sell');
  assert.match(d.reason, /profit-protection|trailing/);
});

test('gecersiz (NaN/eksik) parametre stop-loss\'u sessizce kapatmaz, statik stop calisir', () => {
  const d = checkRiskExit(pos(), 50, { stopLossPct: undefined, takeProfitPct: undefined, trailingStop: false });
  assert.equal(d.action, 'sell');
});

test('eski pozisyonda highWaterMark yoksa NaN olmaz', () => {
  const p = pos({ highWaterMark: undefined });
  checkRiskExit(p, 101, { stopLossPct: 3, takeProfitPct: 50, trailingStop: true });
  assert.equal(p.highWaterMark, 101);
});

test('validateParams: aralik, tamsayi, capraz kontrol, boolean', () => {
  const id = 'ema_cross';
  const ok = { ...strategies.get(id).defaultParams };
  assert.equal(strategies.validateParams(id, ok), null);
  assert.match(strategies.validateParams(id, { ...ok, emaFast: 60 }), /hızlı/); // hizli >= yavas
  assert.match(strategies.validateParams(id, { ...ok, stopLossPct: NaN }), /sayı/);
  assert.match(strategies.validateParams(id, { ...ok, stopLossPct: 0 }), /en az/);
  assert.match(strategies.validateParams(id, { ...ok, emaSlow: 999 }), /en çok/);
  assert.match(strategies.validateParams(id, { ...ok, emaFast: 20.5 }), /tam sayı/);
  assert.match(strategies.validateParams(id, { ...ok, trailingStop: 'evet' }), /açık\/kapalı/);
  assert.match(strategies.validateParams('rsi_ema_macd', { ...strategies.get('rsi_ema_macd').defaultParams, macdFast: 30 }), /MACD/);
});

test('pickParams sadece sema anahtarlarini alir', () => {
  const out = strategies.pickParams('ema_cross', { emaFast: 10, hack: 1, __proto__: { x: 1 } });
  assert.deepEqual(out, { emaFast: 10 });
});

test('rsi_ema_macd artik kullanilmayan emaFast icermez', () => {
  const s = strategies.get('rsi_ema_macd');
  assert.equal('emaFast' in s.defaultParams, false);
  assert.equal(s.paramsSchema.some((f) => f.key === 'emaFast'), false);
});

test('yeterli veride alim sinyali (bollinger alt banda dusus)', () => {
  const closes = Array.from({ length: 40 }, () => 100).concat([80]);
  const s = strategies.get('bollinger_reversion');
  const d = s.evaluate({ candles: candles(closes), position: null, params: s.defaultParams });
  assert.equal(d.action, 'buy');
});
