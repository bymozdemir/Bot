// Denetim bulgusu regresyon testleri (2.0.8):
//  F1: HTTP 200 + govde `null` => TypeError => unknownOutcome=false => OrderManager REJECTED => cift emir riski.
//  F2: Binance / BTCTurk / Binance TR: HTTP 200 + bos/bozuk govde "emir kabul edildi" sayiliyordu.
//  F3: Gecersiz miktar (0, negatif, NaN, cok kucuk, cok buyuk), gecersiz yon, kimliksiz emir AGDAN ONCE reddedilmeli.
// Bu testler gercek borsaya BAGLANMAZ (fetch sahte).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExchange } = require('../src/exchanges');
const { OrderManager } = require('../src/orderManager');

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const B64 = Buffer.from('secret').toString('base64');
const CID = 'market-mgqx1abc-0123456789';

const CFG = {
  coinbaseexchange: { opts: { apiKey: 'k', apiSecret: B64, apiPassphrase: 'p', nowFn: () => NOW }, sym: 'BTC/USD' },
  kraken: { opts: { apiKey: 'k', apiSecret: B64, nowFn: () => NOW }, sym: 'BTC/USD' },
  bitstamp: { opts: { apiKey: 'k', apiSecret: 's', nowFn: () => NOW, nonceFn: () => 'n1' }, sym: 'BTC/USD' },
  okx: { opts: { apiKey: 'k', apiSecret: 's', apiPassphrase: 'p', nowFn: () => NOW }, sym: 'BTC/USDT' },
  okxtr: { opts: { apiKey: 'k', apiSecret: 's', apiPassphrase: 'p', nowFn: () => NOW }, sym: 'BTC/USDT' },
  bybittr: { opts: { apiKey: 'k', apiSecret: 's', nowFn: () => NOW }, sym: 'BTC/USDT' },
  binance: { opts: { apiKey: 'k', apiSecret: 's', environment: 'production' }, sym: 'BTC/USDT' },
  btcturk: { opts: { apiKey: 'k', apiSecret: B64 }, sym: 'BTC/TRY' },
  binancetr: { opts: { apiKey: 'k', apiSecret: 's' }, sym: 'BTC/USDT' },
  paribu: { opts: { apiKey: 'k', apiSecret: 's' }, sym: 'BTC/TRY' }
};
const NEEDS_CID = Object.keys(CFG).filter((id) => id !== 'paribu'); // Paribu API'si istemci kimligi tasimaz
const OLD_LIVE = ['binance', 'btcturk', 'binancetr'];

function res(body, status = 200, nonJson = false) {
  return { ok: status >= 200 && status < 300, status, headers: { get() { return null; } },
    async json() { if (nonJson) throw new Error('bad json'); return body; }, async text() { return JSON.stringify(body); } };
}
// Zaman senkronu uclarina dogru yanit verir; diger her cagriya `orderResponse` doner.
function install(orderResponse) {
  const calls = []; const old = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, method: String(init.method || 'GET').toUpperCase() });
    if (/\/time$/.test(u.pathname)) return res({ serverTime: Date.now(), data: { serverTime: Date.now() }, code: 0 });
    return typeof orderResponse === 'function' ? orderResponse(u, init) : orderResponse;
  };
  return { calls, orderCalls: () => calls.filter((c) => !/\/time$/.test(c.path)), restore() { global.fetch = old; } };
}

for (const id of Object.keys(CFG)) {
  test(`${id}: HTTP 200 + govde null => belirsiz sonuc (REJECTED sayilmaz, tekrar gonderilmez)`, async () => {
    const h = install(res(null));
    try {
      const ex = createExchange(id, CFG[id].opts);
      await assert.rejects(ex.createMarketOrder(CFG[id].sym, 'buy', 0.01, CID), (e) => {
        assert.equal(e.unknownOutcome, true, `unknownOutcome olmali; gelen: ${e && e.message}`);
        assert.ok(!(e instanceof TypeError) || e.unknownOutcome === true);
        return true;
      });
      assert.equal(h.orderCalls().filter((c) => c.method === 'POST').length, 1, 'emir istegi TEK kez gonderilmeli');
    } finally { h.restore(); }
  });
}

for (const id of OLD_LIVE) {
  for (const [label, body, nonJson] of [['{}', {}, false], ['[]', [], false], ['bozuk JSON', null, true], ['emir kimligi yok', { status: 'NEW', clientOrderId: CID, side: 'BUY' }, false]]) {
    test(`${id}: HTTP 200 + ${label} => emir kabul edilmis SAYILMAZ`, async () => {
      const h = install(res(body, 200, nonJson));
      try {
        const ex = createExchange(id, CFG[id].opts);
        await assert.rejects(ex.createMarketOrder(CFG[id].sym, 'buy', 0.01, CID), (e) => { assert.equal(e.unknownOutcome, true); return true; });
      } finally { h.restore(); }
    });
  }
}

test('binance: yanitta farkli clientOrderId => belirsiz sonuc', async () => {
  const h = install(res({ orderId: 7, clientOrderId: 'baska-bir-emir', side: 'BUY', status: 'NEW' }));
  try {
    const ex = createExchange('binance', CFG.binance.opts);
    await assert.rejects(ex.createMarketOrder('BTC/USDT', 'buy', 0.01, CID), (e) => { assert.equal(e.unknownOutcome, true); return true; });
  } finally { h.restore(); }
});

test('binance: gecerli yanit degismeden gecer ve emir kimligi/istemci kimligi gonderilir', async () => {
  let sent;
  const h = install((u) => { sent = u; return res({ orderId: 7, clientOrderId: CID, side: 'BUY', status: 'FILLED', executedQty: '0.01' }); });
  try {
    const ex = createExchange('binance', CFG.binance.opts);
    const o = await ex.createMarketOrder('BTC/USDT', 'buy', 0.01, CID);
    assert.equal(o.orderId, 7);
    assert.equal(sent.searchParams.get('newClientOrderId'), CID);
    assert.equal(sent.searchParams.get('quantity'), '0.01');
  } finally { h.restore(); }
});

test('btcturk: gecerli yanit gecer, clientOrderId govdede gonderilir', async () => {
  let body;
  const h = install((u, init) => { body = JSON.parse(init.body); return res({ success: true, code: 0, data: { id: 9, pairSymbol: 'BTCTRY', type: 'Buy', quantity: '0.01', newOrderClientId: CID } }); });
  try {
    const ex = createExchange('btcturk', CFG.btcturk.opts);
    const o = await ex.createMarketOrder('BTC/TRY', 'buy', 0.01, CID);
    assert.equal(o.orderId, 9);
    assert.equal(body.newOrderClientId, CID);
  } finally { h.restore(); }
});

// ---- Girdi dogrulama: AG CAGRISI OLMADAN reddedilmeli ----
const BAD_AMOUNTS = { sifir: 0, negatif: -1, NaN: NaN, sonsuz: Infinity, metin: 'abc', null: null, tanimsiz: undefined, cok_kucuk: 1e-12, cok_buyuk: 1e21, bos_metin: '', mantiksal: true };
for (const id of Object.keys(CFG)) {
  for (const [label, amt] of Object.entries(BAD_AMOUNTS)) {
    test(`${id}: gecersiz miktar (${label}) ag cagrisindan once reddedilir`, async () => {
      const h = install(res({}, 500));
      try {
        const ex = createExchange(id, CFG[id].opts);
        await assert.rejects(ex.createMarketOrder(CFG[id].sym, 'buy', amt, CID));
        assert.equal(h.calls.length, 0, 'hicbir ag cagrisi yapilmamali');
      } finally { h.restore(); }
    });
  }
  test(`${id}: gecersiz yon ag cagrisindan once reddedilir`, async () => {
    const h = install(res({}, 500));
    try {
      const ex = createExchange(id, CFG[id].opts);
      await assert.rejects(ex.createMarketOrder(CFG[id].sym, 'hold', 0.01, CID));
      assert.equal(h.calls.length, 0);
    } finally { h.restore(); }
  });
}
for (const id of NEEDS_CID) {
  test(`${id}: clientOrderId'siz canli emir ag cagrisindan once reddedilir`, async () => {
    const h = install(res({}, 500));
    try {
      const ex = createExchange(id, CFG[id].opts);
      await assert.rejects(ex.createMarketOrder(CFG[id].sym, 'buy', 0.01, ''));
      assert.equal(h.calls.length, 0);
    } finally { h.restore(); }
  });
}

// ---- Uctan uca: OrderManager `null` govdeyi REJECTED degil UNKNOWN olarak kaydeder ----
test('OrderManager: borsa HTTP 200 + null donerse emir UNKNOWN + mutabakat gerekli; ayni cid ile ikinci emir gonderilmez', async () => {
  const h = install(res(null));
  try {
    const ex = createExchange('binance', CFG.binance.opts);
    ex.capabilities.liveTradingVerified = true; // Bu test, canlı kapısı öncesindeki belirsiz POST davranışını izole eder.
    const state = { liveOrders: {} };
    const om = new OrderManager({ exchange: ex, state, store: { save() {} } });
    const first = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 0.01, clientOrderId: CID });
    assert.equal(first.status, 'UNKNOWN');
    assert.equal(first.requiresReconciliation, true);
    const postsAfterFirst = h.orderCalls().filter((c) => c.method === 'POST').length;
    assert.equal(postsAfterFirst, 1);
    const second = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 0.01, clientOrderId: CID });
    assert.equal(second.reused, true);
    assert.equal(h.orderCalls().filter((c) => c.method === 'POST').length, 1, 'ayni kimlikle ikinci POST yapilmamali');
  } finally { h.restore(); }
});

test('OrderManager: borsa yanıtında yanlış yön/sembol varsa emir UNKNOWN olur ve yeniden gönderilmez', async () => {
  for (const badResponse of [
    { orderId: 81, clientOrderId: CID, symbol: 'BTCUSDT', side: 'SELL', status: 'FILLED', origQty: '1', executedQty: '1' },
    { orderId: 82, clientOrderId: CID, symbol: 'ETHUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1' },
    { orderId: 83, clientOrderId: 'other-cid', symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '1' },
    { orderId: 84, clientOrderId: CID, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', origQty: '1', executedQty: '2' }
  ]) {
    const ex = {
      id: 'fake', name: 'Fake', capabilities: { clientOrderId: true, orderQuery: true, liveTradingVerified: true },
      async createMarketOrder() { return badResponse; }, async getOrder() { throw new Error('not used'); }
    };
    const state = { liveOrders: {} };
    const om = new OrderManager({ exchange: ex, state, store: { save() {} } });
    const result = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: CID });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.requiresReconciliation, true);
    assert.equal(result.uncertain, true);
    const reused = await om.submitMarket({ symbol: 'BTC/USDT', side: 'buy', amount: 1, clientOrderId: CID });
    assert.equal(reused.reused, true);
  }
});

test('OrderManager: ayristirma hatasi veren eski borsa adaptoru (BTCTurk null) de UNKNOWN olur', async () => {
  const h = install(res(null));
  try {
    const ex = createExchange('btcturk', CFG.btcturk.opts);
    ex.capabilities.liveTradingVerified = true; // Test yalnızca null yanıt sonrası UNKNOWN mutabakat davranışını ölçer.
    const om = new OrderManager({ exchange: ex, state: { liveOrders: {} }, store: { save() {} } });
    const o = await om.submitMarket({ symbol: 'BTC/TRY', side: 'sell', amount: 0.01, clientOrderId: CID });
    assert.equal(o.status, 'UNKNOWN');
    assert.equal(o.requiresReconciliation, true);
  } finally { h.restore(); }
});

// ---- Koruyucu stop emirleri de ayni korumalardan gecer ----
for (const id of OLD_LIVE) {
  const sym = CFG[id].sym;
  test(`${id}: koruyucu stop, HTTP 200 + null => belirsiz sonuc`, async () => {
    const h = install(res(null));
    try {
      const ex = createExchange(id, CFG[id].opts);
      await assert.rejects(ex.createStopOrder(sym, 'sell', 0.01, 95, 94, 'stop-t-1'), (e) => { assert.equal(e.unknownOutcome, true); return true; });
    } finally { h.restore(); }
  });
  test(`${id}: koruyucu stop, HTTP 200 + emir kimligi yok => belirsiz sonuc`, async () => {
    const h = install(res({ status: 'NEW' }));
    try {
      const ex = createExchange(id, CFG[id].opts);
      await assert.rejects(ex.createStopOrder(sym, 'sell', 0.01, 95, 94, 'stop-t-1'), (e) => { assert.equal(e.unknownOutcome, true); return true; });
    } finally { h.restore(); }
  });
  test(`${id}: koruyucu stop kimliksiz / gecersiz fiyatla ag cagrisindan once reddedilir`, async () => {
    const h = install(res({}, 500));
    try {
      const ex = createExchange(id, CFG[id].opts);
      await assert.rejects(ex.createStopOrder(sym, 'sell', 0.01, 95, 94, ''));
      await assert.rejects(ex.createStopOrder(sym, 'sell', 0.01, 0, 94, 'stop-t-1'));
      await assert.rejects(ex.createStopOrder(sym, 'sell', 0.01, NaN, 94, 'stop-t-1'));
      assert.equal(h.calls.length, 0);
    } finally { h.restore(); }
  });
}
test('binance: gecerli koruyucu stop yaniti gecer', async () => {
  let u;
  const h = install((url) => { u = url; return res({ orderId: 11, clientOrderId: 'stop-t-1', side: 'SELL', status: 'NEW' }); });
  try {
    const ex = createExchange('binance', CFG.binance.opts);
    const o = await ex.createStopOrder('BTC/USDT', 'sell', 0.01, 95, 94, 'stop-t-1');
    assert.equal(o.orderId, 11);
    assert.equal(u.searchParams.get('type'), 'STOP_LOSS');
    assert.equal(u.searchParams.get('newClientOrderId'), 'stop-t-1');
  } finally { h.restore(); }
});
