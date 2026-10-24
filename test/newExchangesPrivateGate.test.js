const test = require('node:test');
const assert = require('node:assert/strict');
const { createExchange } = require('../src/exchanges');
const { OrderManager } = require('../src/orderManager');

const withPrivate = ['coinbaseexchange', 'kraken', 'bitstamp', 'okx', 'okxtr', 'bybittr'];

test('Stage 4: altı özel adaptör kodludur ama hiçbiri liveTradingVerified değildir', () => {
  for (const id of withPrivate) {
    const ex = createExchange(id);
    assert.equal(ex.capabilities.privateApiImplemented, true, id);
    assert.equal(ex.capabilities.liveTradingVerified, false, id);
    assert.equal(ex.capabilities.recoveryByFingerprint, false, id);
    assert.equal(ex.capabilities.oco, false, id);
    assert.equal(ex.capabilities.nativeTrailingOco, false, id);
  }
});

test('Stage 4: OrderManager, liveTradingVerified=false adaptörle emir göndermeyi reddeder (derinlemesine savunma)', async () => {
  for (const id of withPrivate) {
    const ex = createExchange(id, { apiKey: 'k', apiSecret: 'c2VjcmV0', apiPassphrase: 'p' });
    let calls = 0; const oldFetch = global.fetch; global.fetch = async () => { calls++; throw new Error('ağ çağrılmamalı'); };
    try {
      const om = new OrderManager({ exchange: ex, state: { liveOrders: {} }, store: { save() {} } });
      await assert.rejects(() => om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: 'cid-gate' }), /liveTradingVerified=false/, id);
    } finally { global.fetch = oldFetch; }
    assert.equal(calls, 0, `${id} ağ isteği yapmamalı`);
  }
});

test('Stage 4: Bitstamp artık stop-limit satış kurabilir ama yine liveTradingVerified=false', async () => {
  const ex = createExchange('bitstamp', { apiKey: 'k', apiSecret: 's' });
  assert.equal(typeof ex.createStopOrder, 'function');
  assert.equal(ex.capabilities.liveTradingVerified, false);
});

test('Stage 4: env ile gelen URL, imzalı istek taşıdığı için host allowlist dışında reddedilir', () => {
  const cases = [['coinbaseexchange', 'https://evil.example'], ['kraken', 'https://evil.example'], ['bitstamp', 'https://evil.example'], ['okx', 'https://evil.example'], ['okxtr', 'https://evil.example'], ['bybittr', 'https://evil.example']];
  for (const [id, url] of cases) assert.throws(() => createExchange(id, { baseUrl: url }), /izin verilen host/, id);
  assert.doesNotThrow(() => createExchange('coinbaseexchange', { baseUrl: 'https://api-public.sandbox.exchange.coinbase.com' }));
});

test('Stage 3 korunur: Midas resmî API doğrulanana kadar tamamen kapalı', async () => {
  const ex = createExchange('midas');
  assert.equal(ex.capabilities.publicMarketData, false);
  assert.equal(ex.capabilities.liveTradingVerified, false);
  await assert.rejects(() => ex.fetchTicker('BTC/TRY'), /resmî kripto/i);
  await assert.rejects(() => ex.createMarketOrder('BTC/TRY', 'buy', 1), /doğrulanmadı|kapalı/i);
});
