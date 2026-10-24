const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPrice, formatQuantity, formatMoney } = require('../src/numberFormat');

test('formatPrice tiny token prices without rounding them to zero', () => {
  assert.equal(formatPrice(0.000004), '0.000004');
  assert.equal(formatPrice(1e-17), '0.00000000000000001');
  assert.notEqual(formatPrice(1e-17), '0.00000');
});

test('formatQuantity shows actual token amount, including very large quantities', () => {
  assert.equal(formatQuantity(123.456), '123.456');
  assert.equal(formatQuantity(1.5e18), '1,500,000,000,000,000,000');
});

test('formatMoney preserves small quote currency remainders', () => {
  assert.equal(formatMoney(0.00000012), '0.00000012');
  assert.equal(formatMoney(15), '15');
});
