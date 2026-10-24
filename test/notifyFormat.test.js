'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fmt = require('../src/notifyFormat');

const AT = Date.UTC(2026, 9, 19, 12, 0);
const balanced = (text) => { for (const line of text.split('\n')) for (const tag of ['b', 'code']) assert.equal((line.match(new RegExp(`<${tag}>`, 'g')) || []).length, (line.match(new RegExp(`</${tag}>`, 'g')) || []).length, `dengesiz <${tag}>: ${line}`); };

test('esc: & < > kacirilir; null/undefined bos metin olur', () => {
  assert.equal(fmt.esc('a<b>&"c"'), 'a&lt;b&gt;&amp;"c"');
  assert.equal(fmt.esc(null), ''); assert.equal(fmt.esc(undefined), '');
});

test('duration: dakika/saat/gun bicimi ve gecersiz girdi', () => {
  assert.equal(fmt.duration('2026-10-19T11:59:40.000Z', AT), '1 dk\'dan kısa');
  assert.equal(fmt.duration(new Date(AT - 45 * 60000).toISOString(), AT), '45dk');
  assert.equal(fmt.duration(new Date(AT - 135 * 60000).toISOString(), AT), '2s 15dk');
  assert.equal(fmt.duration(new Date(AT - (26 * 60 + 10) * 60000).toISOString(), AT), '1g 2s');
  assert.equal(fmt.duration('bozuk', AT), null);
  assert.equal(fmt.duration(new Date(AT + 60000).toISOString(), AT), null);
});

test('signed/pct bozuk degerde ? doner', () => {
  assert.equal(fmt.signed(1.234), '+1.23'); assert.equal(fmt.signed(-1.234), '-1.23'); assert.equal(fmt.signed('x'), '?');
  assert.equal(fmt.pct(-2.5), '-2.50%'); assert.equal(fmt.pct(null), '?'); assert.equal(fmt.pct(undefined), '?'); assert.equal(fmt.pct(0), '+0.00%');
});

test('canli mesajlar etiket dengeli, kullanici metnini escape eder ve eksik veriyle bozulmaz', () => {
  const evil = '<b>x</b> & "y"';
  const msgs = [
    fmt.liveBuy({ symbol: 'BTC/USDT', avgPrice: 100, quantity: 1, quoteSpent: 100, stopPrice: 95, takeProfitPct: 5, trailing: true, reason: evil, at: AT }),
    fmt.liveBuy({ symbol: 'BTC/USDT', avgPrice: 100, quantity: 1, stopPrice: null, at: AT }),
    fmt.liveSell({ symbol: 'BTC/USDT', kind: 'KISMİ SATIM', entryPrice: 100, exitPrice: 110, quantity: 0.4, pnl: 4, pnlPct: 10, reason: evil, openedAt: new Date(AT - 3600000).toISOString(), closedAtMs: AT, remainingQty: 0.6, emergency: true }),
    fmt.protectiveFill({ symbol: 'ETH/USDT', isTp: false, partial: false, entryPrice: 10, exitPrice: 9, quantity: 2, pnl: -2, pnlPct: -10, stopPrice: 9, openedAt: new Date(AT - 3600000).toISOString(), closedAtMs: AT, remainingQty: 0 }),
    fmt.liveKillSwitch({ kind: 'total', reason: evil, equity: 700, startEquity: 1000, quote: 'USDT', symbols: ['A/USDT', 'B/USDT'], at: AT }),
    fmt.liveKillSwitchResult({ closed: ['A/USDT'], remaining: ['B/USDT'], failed: [{ symbol: 'B/USDT', error: evil }], at: AT }),
    fmt.lockMessage({ reason: evil, symbols: ['A/USDT'], at: AT }),
    fmt.lockMessage({ reason: null, at: AT }),
    fmt.unlockMessage({ lockedForMs: 7 * 60000, at: AT }),
    fmt.engineStopped({ mode: 'live', reason: evil, openPositions: ['A/USDT'], at: AT }),
    fmt.processShutdown({ signal: 'SIGTERM', mode: 'paper', openPositions: ['A/USDT'], at: AT }),
    fmt.bootMessage({ mode: 'live', exchange: 'binance', running: true, autoResumed: true, previousShutdown: 'unexpected', openPositions: ['A/USDT'], killSwitch: true, at: AT })
  ];
  for (const m of msgs) {
    balanced(m);
    assert.doesNotMatch(m, /<b>x<\/b>/, 'kullanici metnindeki etiket kacirilmali');
    assert.match(m, /🕒 İstanbul: /);
    assert.doesNotMatch(m, /undefined|NaN|\[object/);
  }
  assert.match(msgs[1], /Koruyucu stop: ⚠ fiyat belirlenemedi/);
  assert.match(msgs[2], /KISMİ SATIM BTC\/USDT<\/b> — ACİL ÇIKIŞ/);
  assert.match(msgs[2], /Kalan pozisyon: <code>0\.6<\/code> BTC/);
  assert.match(msgs[4], /Özkaynak: <code>700<\/code> USDT \(başlangıç: 1000\)/);
  assert.match(msgs[5], /1 pozisyon kapatıldı, 1 açık kaldı/);
  assert.match(msgs[5], /Kapatılamayan: B\/USDT/);
  assert.match(msgs[7], /Sebep: belirtilmedi/);
  assert.match(msgs[8], /Kilit süresi: ~7 dk/);
  assert.match(msgs[9], /Canlı bot durduruldu/);
  assert.match(msgs[10], /Yeniden açılınca bildirim gelir/);
  assert.match(msgs[10], /paper pozisyonların stop-loss/);
  assert.match(msgs[11], /beklenmedik kapanış/);
  assert.match(msgs[11], /OTOMATİK devam ediyor/);
  assert.match(msgs[11], /Kill switch AÇIK/);
});

test('bootMessage: temiz/ilk acilis ve durmus motor ifadeleri', () => {
  const clean = fmt.bootMessage({ mode: 'paper', exchange: 'binance', running: false, autoResumed: false, previousShutdown: 'clean', openPositions: [], at: AT });
  assert.match(clean, /\(PAPER\)/); assert.match(clean, /temiz kapanış/); assert.match(clean, /durmuş/); assert.match(clean, /Açık pozisyon yok/);
  assert.match(fmt.bootMessage({ mode: 'paper', previousShutdown: 'first', at: AT }), /ilk açılış/);
});
