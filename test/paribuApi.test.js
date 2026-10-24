const test = require('node:test');
const assert = require('node:assert/strict');
const ParibuAdapter = require('../src/exchanges/paribu');

function fakeResponse(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}
function withMockFetch(handler, fn) {
  const old = global.fetch;
  global.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { global.fetch = old; });
}

test('Paribu private adapter official base + POST /order contract', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  assert.equal(ex.baseUrl, 'https://api.paribu.com');
  await withMockFetch(async (url, opts) => {
    assert.equal(url, 'https://api.paribu.com/order');
    const body = JSON.parse(opts.body);
    assert.equal(body.market, 'btc_tl');
    assert.equal(body.trade, 'buy');
    assert.equal(body.type, 'market');
    assert.equal(body.total, 2100);
    assert.equal(body.amount, undefined);
    assert.equal(opts.headers.Authorization, 'key');
    assert.match(opts.headers['X-Signature'], /^[A-Za-z0-9+/]+={0,2}$/);
    const expected = require('crypto').createHmac('sha256', 'secret').update(JSON.stringify(body), 'utf8').digest('base64');
    assert.equal(opts.headers['X-Signature'], expected);
    return fakeResponse({ id:'42', market:'btc_tl', trade:'buy', status:'filled', total:'2100', executedAmount:'0.01', executedQuoteAmount:'2100' });
  }, async () => {
    const o = await ex.createMarketOrder('BTC/TRY', 'buy', 2100, 'cid-1');
    assert.equal(o.exchangeOrderId, '42');
    assert.equal(o.status, 'FILLED');
    assert.equal(o.symbol, 'BTC/TRY');
  });
});

test('Paribu sembol normalizasyonu API tarafında daima küçük harfli ve TL uyumlu', () => {
  const ex = new ParibuAdapter();
  assert.equal(ex.normalizeSymbol('BTC/TRY'), 'btc_tl');
  assert.equal(ex.normalizeSymbol('BTC_TL'), 'btc_tl');
  assert.equal(ex.normalizeSymbol('eth/usdt'), 'eth_usdt');
});

test('Paribu ticker public response normalize edilir', async () => {
  const ex = new ParibuAdapter();
  await withMockFetch(async (url) => {
    assert.equal(url, 'https://www.paribu.com/ticker');
    return fakeResponse({ BTC_TL: { last: 2500000, percentChange: 1.2, volume: 2, high24hr: 2600000, low24hr: 2400000 } });
  }, async () => {
    const t = await ex.fetchTicker('BTC/TRY');
    assert.equal(t.price, 2500000);
    const rows = await ex.fetchAllTickers24h();
    assert.equal(rows[0].symbol, 'BTC/TRY');
  });
});


test('Paribu market SELL base miktarı, conditional market stop ve fingerprint recovery', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  let calls = [];
  await withMockFetch(async (url, opts) => {
    calls.push({url, opts});
    if (url === 'https://api.paribu.com/order') {
      const body = JSON.parse(opts.body);
      if (body.type === 'market' && body.trade === 'sell' && body.condition) {
        assert.equal(body.amount, 0.01);
        assert.equal(body.condition, 2400000);
      } else {
        assert.equal(body.amount, 0.01);
      }
      return fakeResponse({ id:'43', market:'btc_tl', trade:'sell', status:'open', amount:'0.01' });
    }
    if (url === 'https://api.paribu.com/open-orders?market=btc_tl') {
      return fakeResponse([{ id:'44', market:'btc_tl', trade:'sell', status:'open', amount:'0.02' }]);
    }
    return fakeResponse([]);
  }, async () => {
    const stop = await ex.createStopOrder('BTC/TRY', 'sell', 0.01, 2400000, 2390000, 'stop-1');
    assert.equal(stop.exchangeOrderId, '43');
    assert.equal(stop.status, 'NEW');
  });
  assert.ok(calls.length > 0);
});

test('Paribu stop API anlık market satışına dönüşürse güvenli biçimde reddedilir', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  await withMockFetch(async () => fakeResponse({ id:'99', market:'btc_tl', trade:'sell', status:'filled', executedAmount:'0.01', amount:'0.01' }), async () => {
    await assert.rejects(ex.createStopOrder('BTC/TRY','sell',0.01,2400000,2390000), /hemen gerçekleşti/);
  });
});

test('Paribu koruyucu stop alış yönünü reddeder', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  await assert.rejects(ex.createStopOrder('BTC/TRY','buy',0.01,2400000,2390000), /yalnızca sell/);
});

test('Paribu fingerprint recovery tek aday olsa bile emri otomatik benimsemez', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  await withMockFetch(async (url) => {
    if (String(url).includes('/open-orders')) return fakeResponse([
      { id:'44', market:'btc_tl', trade:'sell', status:'open', amount:'0.01' }
    ]);
    return fakeResponse([]);
  }, async () => {
    const found = await ex.findOrderForRecovery({ symbol:'BTC/TRY', side:'sell', amount:0.01 });
    assert.equal(found, null);
  });
});

test('Paribu fingerprint recovery benzersiz olmayan emri otomatik benimsemez', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  await withMockFetch(async (url) => {
    if (String(url).includes('/open-orders')) return fakeResponse([
      { id:'44', market:'btc_tl', trade:'sell', status:'open', amount:'0.01' },
      { id:'45', market:'btc_tl', trade:'sell', status:'open', amount:'0.01' }
    ]);
    return fakeResponse([]);
  }, async () => {
    const found = await ex.findOrderForRecovery({ symbol:'BTC/TRY', side:'sell', amount:0.01 });
    assert.equal(found, null);
  });
});




test('Paribu current API endpoint contract: assets/open-orders/order-id', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  await withMockFetch(async (url, opts) => {
    assert.equal(url, 'https://api.paribu.com/user/assets');
    assert.equal(opts.method, 'GET');
    return fakeResponse([{ asset:'TRY', free:'1000', locked:'25' }, { asset:'BTC', free:'0.01', locked:'0.002' }]);
  }, async () => {
    const b = await ex.fetchBalance();
    assert.deepEqual(b.TRY, { free:1000, locked:25 });
    assert.deepEqual(b.BTC, { free:0.01, locked:0.002 });
  });

  await withMockFetch(async (url, opts) => {
    assert.equal(url, 'https://api.paribu.com/open-orders?market=btc_tl');
    assert.equal(opts.method, 'GET');
    return fakeResponse([{ id:'77', market:'btc_tl', trade:'sell', status:'open', amount:'0.01' }]);
  }, async () => {
    const rows = await ex.fetchOpenOrders(['BTC/TRY']);
    assert.equal(rows[0].exchangeOrderId, '77');
  });

  await withMockFetch(async (url, opts) => {
    assert.equal(url, 'https://api.paribu.com/order/77');
    assert.equal(opts.method, 'GET');
    return fakeResponse({ id:'77', market:'btc_tl', trade:'sell', status:'open', amount:'0.01' });
  }, async () => {
    const o = await ex.getOrder('BTC/TRY', '77');
    assert.equal(o.exchangeOrderId, '77');
  });
});

test('Paribu mutating transport ve 5XX hatalari unknownOutcome olur', async () => {
  const ex = new ParibuAdapter({apiKey:'key', apiSecret:'secret'});
  const oldFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({message:'server'}), {status:503});
  try {
    await assert.rejects(ex.createMarketOrder('BTC/TRY','buy',100,'cid-5xx'), (err) => err.unknownOutcome === true && err.httpStatus === 503);
  } finally { global.fetch = oldFetch; }
  global.fetch = async () => { throw new Error('network timeout'); };
  try {
    await assert.rejects(ex.createMarketOrder('BTC/TRY','buy',100,'cid-timeout'), (err) => err.unknownOutcome === true);
  } finally { global.fetch = oldFetch; }
});

test('Paribu malformed POST response is unknown outcome and cannot be retried blindly', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  await withMockFetch(async () => fakeResponse({ market:'btc_tl', trade:'buy', status:'open' }), async () => {
    await assert.rejects(ex.createMarketOrder('BTC/TRY', 'buy', 100, 'cid-no-id'), (err) => {
      assert.equal(err.unknownOutcome, true);
      assert.equal(err.orderResponseInvalid, true);
      return /sonucu belirsiz/.test(err.message);
    });
  });
});

test('Paribu POST response with mismatched market or side is rejected as unknown outcome', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  await withMockFetch(async () => fakeResponse({ id:'88', market:'eth_tl', trade:'buy', status:'open' }), async () => {
    await assert.rejects(ex.createMarketOrder('BTC/TRY', 'buy', 100, 'cid-wrong-market'), (err) => err.unknownOutcome === true && err.orderResponseInvalid === true);
  });
  await withMockFetch(async () => fakeResponse({ id:'89', market:'btc_tl', trade:'sell', status:'open' }), async () => {
    await assert.rejects(ex.createMarketOrder('BTC/TRY', 'buy', 100, 'cid-wrong-side'), (err) => err.unknownOutcome === true && err.orderResponseInvalid === true);
  });
});

test('Paribu rejects invalid order side and amount before sending request', async () => {
  const ex = new ParibuAdapter({ apiKey:'key', apiSecret:'secret' });
  let calls = 0;
  await withMockFetch(async () => { calls++; return fakeResponse({ id:'90', market:'btc_tl', trade:'buy', status:'open' }); }, async () => {
    await assert.rejects(ex.createMarketOrder('BTC/TRY', 'hold', 100), /buy veya sell/);
    await assert.rejects(ex.createMarketOrder('BTC/TRY', 'buy', 0), /pozitif/);
    await assert.rejects(ex.createMarketOrder('BTC/TRY', 'sell', NaN), /pozitif/);
  });
  assert.equal(calls, 0);
});
