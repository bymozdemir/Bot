#!/usr/bin/env node
// Salt-okunur canlı doğrulama. EMİR GÖNDERMEZ, İPTAL ETMEZ.
// Kullanım: node scripts/exchangeReadonlyAudit.js <borsa-id> [BASE/QUOTE]
// Anahtarlar ortamdan: <ID>_API_KEY, <ID>_API_SECRET, (varsa) <ID>_API_PASSPHRASE
// Yalnızca OKUMA yetkili anahtar kullanın. Bu script hiçbir koşulda canlı emir göndermez.
'use strict';

const { createExchange, registry } = require('../src/exchanges');

function classifyMissingOrderProbe({ returnedOrder, error }) {
  if (error && error.orderNotFound === true) {
    return { status: 'OK', detail: 'var olmayan emir doğru biçimde orderNotFound olarak sınıflandırıldı' };
  }
  if (error) {
    return { status: 'FAIL', note: `beklenmeyen sorgu hatası (orderNotFound=${!!error.orderNotFound}): ${String(error.message || error).slice(0, 120)}` };
  }
  if (returnedOrder !== undefined && returnedOrder !== null) {
    return { status: 'FAIL', note: 'var olmayan emir kimliği için API bir emir döndürdü; kimlik sorgusu güvenilir değil' };
  }
  return { status: 'FAIL', note: 'API ne emir döndürdü ne de orderNotFound hatası verdi; sonuç belirsiz' };
}

async function runAudit(id, symbol, env = process.env) {
  const P = id.toUpperCase();
  const ex = createExchange(id, {
    apiKey: env[`${P}_API_KEY`],
    apiSecret: env[`${P}_API_SECRET`],
    apiPassphrase: env[`${P}_API_PASSPHRASE`]
  });
  const results = [];
  async function step(name, fn, { privateStep = false } = {}) {
    if (privateStep && !(ex.apiKey && ex.apiSecret)) {
      results.push({ name, status: 'SKIP', note: 'salt-okunur API anahtarı yok; özel uç noktalar doğrulanmadı' });
      return;
    }
    try {
      const v = await fn();
      results.push({ name, status: 'OK', detail: v });
    } catch (e) {
      results.push({ name, status: 'FAIL', note: String(e.message || e), orderNotFound: !!e.orderNotFound });
    }
  }

  await step('ticker', async () => {
    const t = await ex.fetchTicker(symbol);
    if (!Number.isFinite(Number(t?.price)) || Number(t.price) <= 0) throw new Error('geçerli pozitif ticker fiyatı yok');
    return Number(t.price);
  });
  await step('orderbook', async () => {
    const b = await ex.fetchOrderBook(symbol, 5);
    if (!Array.isArray(b?.bids) || !Array.isArray(b?.asks) || !b.bids.length || !b.asks.length) throw new Error('boş/geçersiz defter');
    const bid = Number(b.bids[0]?.[0]); const ask = Number(b.asks[0]?.[0]);
    if (!(bid > 0) || !(ask > 0) || bid > ask) throw new Error('en iyi alış/satış fiyatları geçersiz veya çapraz');
    return `${bid} / ${ask}`;
  });
  await step('candles-1h', async () => {
    const c = await ex.fetchCandles(symbol, '1h', 50);
    if (!Array.isArray(c) || c.length < 2) throw new Error('yeterli mum yok');
    const d = Number(c[1].t) - Number(c[0].t);
    if (d !== 3600000) throw new Error(`ilk iki mum aralığı ${d}ms (1h değil)`);
    return `${c.length} mum`;
  });
  await step('symbol-rules', async () => {
    const r = await ex.fetchSymbolRules(symbol);
    if (!(Number(r?.stepSize) > 0)) throw new Error('stepSize yok/geçersiz');
    if (!(Number(r?.minQty) >= 0) || !(Number(r?.tickSize) >= 0) || !(Number(r?.minNotional) >= 0)) throw new Error('sembol kuralları negatif/geçersiz');
    return { stepSize: r.stepSize, minQty: r.minQty, tickSize: r.tickSize, minNotional: r.minNotional };
  });
  await step('balance (imza + yetki)', async () => {
    const b = await ex.fetchBalance();
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('bakiye yanıtı geçerli nesne değil');
    return `${Object.keys(b).length} varlık`;
  }, { privateStep: true });
  await step('open-orders (şema)', async () => {
    const orders = await ex.fetchOpenOrders([symbol]);
    if (!Array.isArray(orders)) throw new Error('açık emir yanıtı dizi değil');
    return `${orders.length} açık emir`;
  }, { privateStep: true });
  if (ex.apiKey && ex.apiSecret) {
    try {
      const returnedOrder = await ex.getOrder(symbol, null, `audit-nonexistent-${Date.now()}`);
      results.push({ name: 'getOrder: olmayan kimlik', ...classifyMissingOrderProbe({ returnedOrder }) });
    } catch (error) {
      results.push({ name: 'getOrder: olmayan kimlik', ...classifyMissingOrderProbe({ error }) });
    }
  } else {
    results.push({ name: 'getOrder: olmayan kimlik', status: 'SKIP', note: 'salt-okunur API anahtarı yok; sorgu davranışı doğrulanmadı' });
  }

  const failures = results.filter((r) => r.status === 'FAIL').length;
  const skips = results.filter((r) => r.status === 'SKIP').length;
  const status = failures ? 'FAIL' : skips ? 'PARTIAL' : 'PASS';
  return { exchange: id, symbol, at: new Date().toISOString(), auditStatus: status, liveTradingVerified: ex.capabilities?.liveTradingVerified === true, results };
}

async function main() {
  const id = (process.argv[2] || '').toLowerCase();
  if (!registry[id]) {
    console.error(`Kullanım: node scripts/exchangeReadonlyAudit.js <${Object.keys(registry).join('|')}> [BASE/QUOTE]`);
    process.exitCode = 2;
    return;
  }
  const result = await runAudit(id, process.argv[3] || 'BTC/USDT');
  console.log(JSON.stringify(result, null, 2));
  if (result.auditStatus === 'FAIL') process.exitCode = 1;
  else if (result.auditStatus === 'PARTIAL') process.exitCode = 2;
}

if (require.main === module) main().catch((err) => {
  console.error(`Salt-okunur borsa denetimi başlatılamadı: ${String(err.message || err)}`);
  process.exitCode = 1;
});

module.exports = { classifyMissingOrderProbe, runAudit };
