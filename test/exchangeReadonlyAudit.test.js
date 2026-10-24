'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMissingOrderProbe } = require('../scripts/exchangeReadonlyAudit');

test('readonly audit yalnızca açık orderNotFound hatasını beklenen sonuç sayar', () => {
  assert.equal(classifyMissingOrderProbe({ error: Object.assign(new Error('not found'), { orderNotFound: true }) }).status, 'OK');
  assert.equal(classifyMissingOrderProbe({ error: new Error('unauthorized') }).status, 'FAIL');
  assert.equal(classifyMissingOrderProbe({ returnedOrder: { orderId: 'unexpected' } }).status, 'FAIL');
  assert.equal(classifyMissingOrderProbe({ returnedOrder: null }).status, 'FAIL');
});
