const test = require('node:test');
const assert = require('node:assert/strict');
const BinanceAdapter = require('../src/exchanges/binance');
const { explainNetworkError } = require('../src/util/network');

function withFetch(impl, fn) {
  const real = global.fetch; global.fetch = impl;
  return Promise.resolve(fn()).finally(() => { global.fetch = real; });
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('Binance herkese açık veri: ana adres kapalıysa alternatif adrese düşer ve onu hatırlar', async () => {
  const ex = new BinanceAdapter({});
  const seen = [];
  await withFetch(async (url) => {
    seen.push(new URL(url).hostname);
    if (url.startsWith('https://api.binance.com')) { const e = new TypeError('fetch failed'); e.cause = { code: 'ETIMEDOUT' }; throw e; }
    return ok({ serverTime: 1 });
  }, async () => {
    const r = await ex._publicGet('/api/v3/time');
    assert.deepEqual(r, { serverTime: 1 });
    assert.equal(ex._publicGoodHost, 'https://api-gcp.binance.com');
    seen.length = 0;
    await ex._publicGet('/api/v3/time');
    assert.deepEqual(seen, ['api-gcp.binance.com']); // sticky: bozuk ana adres tekrar beklenmez
  });
});

test('Binance herkese açık veri: 400 (geçersiz parametre) alternatif adreste denenmez', async () => {
  const ex = new BinanceAdapter({});
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: false, status: 400, text: async () => '{"code":-1121}', json: async () => ({}) }; }, async () => {
    await assert.rejects(() => ex._publicGet('/api/v3/klines', { symbol: 'XXX' }), /400/);
  });
  assert.equal(calls, 1);
});

test('Binance 451 (bölge engeli) → alternatif adres denenir', async () => {
  const ex = new BinanceAdapter({});
  await withFetch(async (url) => url.startsWith('https://api.binance.com')
    ? { ok: false, status: 451, text: async () => 'blocked', json: async () => ({}) } : ok([1]), async () => {
    assert.deepEqual(await ex._publicGet('/api/v3/klines'), [1]);
  });
});

test('Fallback yalnızca herkese açık veri için: testnet ve imzalı yol ana adresle sınırlı', () => {
  const t = new BinanceAdapter({ environment: 'testnet' });
  assert.deepEqual(t._publicHosts(), ['https://testnet.binance.vision']);
  const p = new BinanceAdapter({});
  assert.ok(p._publicHosts().includes('https://data-api.binance.vision'));
  assert.equal(p.baseUrl, 'https://api.binance.com'); // imzalı istekler buradan gider
});

test('BINANCE_PUBLIC_FALLBACKS=off alternatifleri kapatır', () => {
  process.env.BINANCE_PUBLIC_FALLBACKS = 'off';
  try { assert.deepEqual(new BinanceAdapter({})._publicHosts(), ['https://api.binance.com']); }
  finally { delete process.env.BINANCE_PUBLIC_FALLBACKS; }
});

test('BINANCE_PUBLIC_FALLBACKS yalnızca resmî Binance HTTPS hostlarını kabul eder', () => {
  process.env.BINANCE_PUBLIC_FALLBACKS = 'https://api1.binance.com,https://data-api.binance.vision';
  try {
    assert.deepEqual(new BinanceAdapter({})._publicHosts(), [
      'https://api.binance.com', 'https://api1.binance.com', 'https://data-api.binance.vision'
    ]);
  } finally { delete process.env.BINANCE_PUBLIC_FALLBACKS; }
  for (const bad of [
    'https://evil.example', 'https://api.binance.com.evil.example',
    'http://api1.binance.com', 'https://user:pass@api1.binance.com',
    'https://api1.binance.com:8443', 'https://api1.binance.com/path'
  ]) {
    process.env.BINANCE_PUBLIC_FALLBACKS = bad;
    try { assert.throws(() => new BinanceAdapter({})._publicHosts(), /BINANCE_PUBLIC_FALLBACKS/); }
    finally { delete process.env.BINANCE_PUBLIC_FALLBACKS; }
  }
});

test('explainNetworkError: yaygın hata kodlarını Türkçe açıklar', () => {
  assert.match(explainNetworkError('ENOTFOUND'), /DNS/);
  assert.match(explainNetworkError('ETIMEDOUT'), /IPv6|zaman/);
  assert.match(explainNetworkError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), /NODE_EXTRA_CA_CERTS/);
  assert.equal(explainNetworkError('baska'), null);
});

test('Binance mum verisi: geçerli OHLCV ve ardışık timeframe zorunlu', async () => {
  const ex = new BinanceAdapter({});
  const base = Date.now() - 3 * 3600000;
  const candles = [0,1,2].map(i => [base + i*3600000, '100','110','90','105','12']);
  await withFetch(async () => ok(candles), async () => {
    const out = await ex.fetchCandles('BTC/USDT', '1h', 3);
    assert.equal(out.length, 3);
    assert.equal(out[1].t - out[0].t, 3600000);
    assert.equal(out[0].o, 100);
  });
});

test('Binance mum verisi: eksik/bozuk timeframe sessizce kabul edilmez', async () => {
  const ex = new BinanceAdapter({});
  const base = Date.now() - 4 * 3600000;
  const candles = [
    [base, '100','110','90','105','12'],
    [base + 2*3600000, '105','112','101','110','10']
  ];
  await withFetch(async () => ok(candles), async () => {
    await assert.rejects(() => ex.fetchCandles('BTC/USDT', '1h', 2), /zaman aralığı bozuk|yanlış timeframe/);
  });
});

test('Binance mum verisi: mum süresinin TAM KATI olan boşluk (bakım/işlem yok) kabul edilir', async () => {
  const ex = new BinanceAdapter({});
  const base = Date.now() - 6 * 3600000;
  const H = 3600000;
  const candles = [
    [base, '100','110','90','105','12'],
    [base + H, '105','112','101','110','10'],
    [base + 3 * H, '110','115','108','111','9'] // base+2H eksik
  ];
  await withFetch(async () => ok(candles), async () => {
    const rows = await ex.fetchCandles('BTC/USDT', '1h', 3);
    assert.equal(rows.length, 3);
  });
});

test('Binance mum verisi: yanlış timeframe (tüm aralıklar daha büyük) ve hizasız zaman damgası reddedilir', async () => {
  const ex = new BinanceAdapter({});
  const base = Date.now() - 10 * 3600000;
  const H = 3600000;
  const fourHour = [0, 1, 2].map((i) => [base + i * 4 * H, '100','110','90','105','12']);
  await withFetch(async () => ok(fourHour), async () => {
    await assert.rejects(() => ex.fetchCandles('BTC/USDT', '1h', 3), /yanlış timeframe/);
  });
  const misaligned = [[base, '100','110','90','105','12'], [base + H + 1234, '100','110','90','105','12']];
  await withFetch(async () => ok(misaligned), async () => {
    await assert.rejects(() => ex.fetchCandles('BTC/USDT', '1h', 2), /zaman aralığı bozuk/);
  });
});

test('Binance mum verisi: NaN/Infinity ve OHLC ihlali reddedilir', async () => {
  const ex = new BinanceAdapter({});
  const base = Date.now() - 2 * 3600000;
  const bad = [
    [base, '100','110','90','NaN','12'],
    [base + 3600000, '100','110','90','105','12']
  ];
  await withFetch(async () => ok(bad), async () => {
    await assert.rejects(() => ex.fetchCandles('BTC/USDT', '1h', 2), /geçersiz sayı/);
  });
});

test('Binance HTTP 429: alternatif hostlara geçmez ve Retry-After boyunca ortak bekleme uygular', async () => {
  const ex = new BinanceAdapter({});
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return {
      ok: false, status: 429,
      headers: { get: (name) => String(name).toLowerCase() === 'retry-after' ? '30' : null },
      text: async () => 'rate limit', json: async () => ({})
    };
  }, async () => {
    await assert.rejects(() => ex._publicGet('/api/v3/klines'), (err) => err.httpStatus === 429 && err.rateLimited === true && err.retryAfterMs >= 29000);
    assert.equal(calls, 1, '429 yanıtında başka hosta veya otomatik tekrara gidilmemeli');
    await assert.rejects(() => ex._publicGet('/api/v3/time'), (err) => err.rateLimited === true && err.retryAfterMs > 0);
    assert.equal(calls, 1, 'bekleme penceresinde yeni HTTP isteği gönderilmemeli');
  });
});

test('Binance HTTP 418: IP engeli yanıtında host failover yapmaz', async () => {
  const ex = new BinanceAdapter({});
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return {
      ok: false, status: 418,
      headers: { get: () => null },
      text: async () => 'IP banned', json: async () => ({})
    };
  }, async () => {
    await assert.rejects(() => ex._publicGet('/api/v3/time'), (err) => err.httpStatus === 418 && err.rateLimited === true);
    assert.equal(calls, 1, '418 yanıtında alternatif hostlara istek gönderilmemeli');
  });
});

test('Binance public API: toplam çağrı süresi bütçesi host failover zincirini sınırlar', async () => {
  const ex = new BinanceAdapter({ publicRequestTimeoutMs: 120 });
  let calls = 0;
  await withFetch((url, opts = {}) => new Promise((resolve, reject) => {
    calls++;
    const signal = opts.signal;
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }), async () => {
    await assert.rejects(() => ex._publicGet('/api/v3/time'), (err) => err.code === 'PUBLIC_API_DEADLINE');
    assert.equal(calls, 1, 'toplam bütçe dolunca diğer hostlara geçilmemeli');
  });
});
