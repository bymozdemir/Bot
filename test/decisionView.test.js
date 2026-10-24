'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveDecisionView } = require('../public/decision-view');

test('AL sinyali yeşil gösterilir ama pozisyon durumundan ayrı kalır', () => {
  const v = deriveDecisionView({ decision: { action: 'buy', reason: 'giriş koşulu oluştu', evaluatedAt: '2026-10-11T00:00:00.000Z', checkedAt: '2026-10-11T00:00:00.000Z' }, enabled: true, hasPosition: false });
  assert.equal(v.status.label, 'AL SİNYALİ');
  assert.equal(v.status.tone, 'good');
  assert.equal(v.position.label, 'Pozisyon yok');
  assert.equal(v.reason, 'giriş koşulu oluştu');
});

test('BEKLE sinyali alım gibi yeşil gösterilmez', () => {
  const v = deriveDecisionView({ decision: { action: 'hold', reason: 'MACD koşulu oluşmadı', evaluatedAt: '2026-10-11T00:00:00.000Z', checkedAt: '2026-10-11T00:00:00.000Z' }, enabled: true });
  assert.equal(v.status.label, 'BEKLE');
  assert.equal(v.status.tone, 'neutral');
  assert.match(v.reason, /MACD/);
});

test('eski sinyal uygulanmadı olarak gösterilir', () => {
  const v = deriveDecisionView({ decision: { action: 'buy', reason: 'alım', evaluatedAt: '2026-10-10T00:00:00.000Z', stale: true }, enabled: true });
  assert.equal(v.status.tone, 'warn');
  assert.match(v.status.label, /UYGULANMADI/);
});

test('veri hatası sinyal durumunun önüne geçer', () => {
  const v = deriveDecisionView({ decision: { action: 'buy', reason: 'alım', evaluatedAt: '2026-10-11T00:00:00.000Z', error: 'veri alınamadı' }, enabled: true });
  assert.equal(v.status.tone, 'bad');
  assert.equal(v.data.label, 'Hata var');
});

test('pasif parite yeşil sinyal gibi gösterilmez', () => {
  const v = deriveDecisionView({ decision: { action: 'buy', reason: 'alım', evaluatedAt: '2026-10-11T00:00:00.000Z' }, enabled: false });
  assert.equal(v.status.label, 'PARİTE PASİF');
  assert.equal(v.status.tone, 'muted');
});

test('ilk değerlendirme henüz yapılmadıysa bekliyor görünür', () => {
  const v = deriveDecisionView({ decision: null, enabled: true });
  assert.equal(v.status.tone, 'neutral');
  assert.equal(v.hasDecision, false);
});
