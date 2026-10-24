const test = require('node:test');
const assert = require('node:assert/strict');
const PaperEngine = require('../src/paperEngine');
const store = require('../src/store');

function engineAt(nowMs, tz) {
  const state = store.defaultState();
  if (tz !== undefined) state.settings.riskDayTimezone = tz;
  const ctx = { now: nowMs };
  const engine = new PaperEngine({ exchange: { quoteAssets: ['USDT'] }, store: { save() {} }, state, nowFn: () => ctx.now });
  engine.log = () => {};
  return { engine, state, ctx };
}

test('varsayilan gun siniri Turkiye saati (Europe/Istanbul, UTC+3)', () => {
  assert.equal(store.defaultState().settings.riskDayTimezone, 'Europe/Istanbul');
});

test('gun anahtari yerel saate gore: 22:30 UTC = ertesi gun 01:30 Istanbul', () => {
  const t = Date.UTC(2026, 8, 30, 22, 30);
  assert.equal(engineAt(t, 'Europe/Istanbul').engine.getRiskDayKey(t), '2026-10-01');
  assert.equal(engineAt(t, 'UTC').engine.getRiskDayKey(t), '2026-09-30');
});

test('gun yerel gece yarisinda (21:00 UTC) degisir, UTC gece yarisinda degil', () => {
  const before = Date.UTC(2026, 8, 30, 20, 59);
  const after = Date.UTC(2026, 8, 30, 21, 1);
  const { engine } = engineAt(before, 'Europe/Istanbul');
  assert.notEqual(engine.getRiskDayKey(before), engine.getRiskDayKey(after));
  const utc = engineAt(before, 'UTC').engine;
  assert.equal(utc.getRiskDayKey(before), utc.getRiskDayKey(after));
});

test('rollover: gun degisince gun basi bakiyesi yeniden alinir, ayni gunde degismez', () => {
  const t1 = Date.UTC(2026, 8, 30, 20, 0);
  const { engine, state, ctx } = engineAt(t1, 'Europe/Istanbul');
  state.paper.dayKey = null;
  engine.rolloverDayIfNeeded(150);
  assert.equal(state.paper.dayStartEquity, 150);
  assert.equal(state.paper.dayKey, '2026-09-30');
  ctx.now = Date.UTC(2026, 8, 30, 20, 55); // hala ayni yerel gun
  engine.rolloverDayIfNeeded(120);
  assert.equal(state.paper.dayStartEquity, 150);
  ctx.now = Date.UTC(2026, 8, 30, 21, 5); // yerel gece yarisi gecti
  engine.rolloverDayIfNeeded(120);
  assert.equal(state.paper.dayKey, '2026-10-01');
  assert.equal(state.paper.dayStartEquity, 120);
});

test('gecersiz/eksik saat dilimi cokmez, UTC\'ye duser', () => {
  const t = Date.UTC(2026, 8, 30, 22, 30);
  assert.equal(engineAt(t, 'Mars/Olympus').engine.getRiskDayKey(t), '2026-09-30');
  assert.equal(engineAt(t, '').engine.getRiskDayKey(t), '2026-10-01'); // bos ayar -> varsayilan Europe/Istanbul
  assert.equal(engineAt(t, undefined).state.settings.riskDayTimezone, 'Europe/Istanbul');
});
