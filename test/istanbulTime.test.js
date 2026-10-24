'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatIstanbulTime, withIstanbulTime } = require('../src/istanbulTime');

test('UTC zamanını doğru şekilde İstanbul saatine çevirir; işlem zamanını değiştirmez', () => {
  assert.equal(formatIstanbulTime('2026-10-13T22:52:29.992Z'), '14.10.26 01:52:29');
  assert.equal(withIstanbulTime('ALIM BTC/USDT', '2026-10-13T22:52:29.992Z'), 'ALIM BTC/USDT\n🕒 İstanbul: 14.10.26 01:52:29');
});

test('geçersiz zaman güvenli metin döndürür', () => {
  assert.equal(formatIstanbulTime('not-a-date'), 'bilinmiyor');
});
