'use strict';
// Kaos kampanyasi: tohumlu rastgele senaryolar (gecikme, tekrar, kayip WS olayi, eski REST cevabi, belirsiz zaman asimi).
// Ayni tohum ayni senaryoyu uretir; hata durumunda tohum numarasi mesajda yer alir ve `node test/chaos/*.js <baslangic> <adet>` ile tekrarlanir.
const test = require('node:test');
const assert = require('node:assert/strict');
const om = require('./chaos/orderManagerChaos');
const eng = require('./chaos/engineChaos');
const multi = require('./chaos/multiChaos');

function quiet(fn) {
  return async () => {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try { return await fn(); } finally { Object.assign(console, saved); }
  };
}
const HARSH = { dropProb: 0.4, errorProb: 0.2, staleProb: 0.6, unknownProb: 0.15 };
// Fast CI defaults; raise these env vars for extended soak runs.
const ORDER_ITERS = Math.max(1, Number(process.env.CHAOS_ORDER_ITERATIONS || 60));
const ENGINE_ITERS = Math.max(1, Number(process.env.CHAOS_TEST_ITERATIONS || 40));
const MULTI_ITERS = Math.max(1, Number(process.env.CHAOS_MULTI_ITERATIONS || 20));

test('kaos: OrderManager degişmezleri (REST fills ile)', quiet(async () => {
  const r = await om.runMany(1, ORDER_ITERS, {});
  assert.deepEqual(r.violations.slice(0, 5), []);
}));
test('kaos: OrderManager degişmezleri (gerçek Binance gibi: GET /order fills yok)', quiet(async () => {
  const r = await om.runMany(1001, ORDER_ITERS, { p: { restFills: false } });
  assert.deepEqual(r.violations.slice(0, 5), []);
}));
test('kaos: OrderManager degişmezleri (sert: yüksek kayıp/hata/eski cevap)', quiet(async () => {
  const r = await om.runMany(2001, ORDER_ITERS, { p: { restFills: false, ...HARSH } });
  assert.deepEqual(r.violations.slice(0, 5), []);
}));
test('kaos: LiveEngine güvenlik + canlılık (toparlanma sonrası kapı açılır, ihlal yok)', quiet(async () => {
  const r = await eng.runMany(1, ENGINE_ITERS, {});
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.lockedAfterRecovery, 0, `ağ düzeldikten sonra kalıcı kilit: ${JSON.stringify(r.stats.lockReasons)}`);
}));
test('kaos: LiveEngine sert modda güvenlik ihlali ve kalıcı kilit yok', quiet(async () => {
  const r = await eng.runMany(20001, ENGINE_ITERS, { p: { ...HARSH, dropProb: 0.35, injectProb: 0.8 } });
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.lockedAfterRecovery, 0, `kalıcı kilit: ${JSON.stringify(r.stats.lockReasons)}`);
}));

test('kaos: süreç çökmesi/yeniden başlatma (diske yazılmış durumdan kurtarma; korumasız pozisyon ve kalıcı kilit yok)', quiet(async () => {
  const r = await eng.runMany(1001, ENGINE_ITERS, { crash: true });
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.lockedAfterRecovery, 0, `çökme sonrası kalıcı kilit: ${JSON.stringify(r.stats.lockReasons)}`);
}));
test('kaos: çökme + sert ağ koşulları', quiet(async () => {
  const r = await eng.runMany(30001, ENGINE_ITERS, { crash: true, p: { ...HARSH, dropProb: 0.35, injectProb: 0.8 } });
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.lockedAfterRecovery, 0, `kalıcı kilit: ${JSON.stringify(r.stats.lockReasons)}`);
}));

test('kaos: disk yazma arızası (emir gönderilmeden önce diske yazılır; süreç çökmez; toparlanma)', quiet(async () => {
  const r = await eng.runMany(1, ENGINE_ITERS, { diskFail: 0.3 });
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.lockedAfterRecovery, 0, `kalıcı kilit: ${JSON.stringify(r.stats.lockReasons)}`);
}));
test('kaos: disk arızası + süreç çökmesi', quiet(async () => {
  const r = await eng.runMany(1, ENGINE_ITERS, { diskFail: 0.4, crash: true });
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.lockedAfterRecovery, 0, `kalıcı kilit: ${JSON.stringify(r.stats.lockReasons)}`);
}));

test('kaos: gerçek zararda kill switch (kalıcı kilit, yeniden başlatmada korunur; korumasız kalan pozisyon <%2)', quiet(async () => {
  const r = await eng.runMany(1, ENGINE_ITERS, { riskLoss: true, risk: true });
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.ok(r.stats.killed >= Math.ceil(ENGINE_ITERS * 0.97), 'kill switch gerçek zararda devreye girmeli');
  assert.ok(r.stats.unprotectedAfterKill / r.stats.ran < 0.02, `korumasız kalan: ${r.stats.unprotectedAfterKill}/${r.stats.ran}`);
}));
test('kaos: kill switch + süreç çökmesi', quiet(async () => {
  const r = await eng.runMany(1, ENGINE_ITERS, { riskLoss: true, risk: true, crash: true });
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.unprotectedAfterKill, 0);
}));
test('kaos: gerçek zarar olmadığında yanlış kill switch tetiklenmez', quiet(async () => {
  const r = await eng.runMany(1, ENGINE_ITERS, { risk: true });
  assert.deepEqual(r.violations.slice(0, 5), []);
}));

test('kaos: çoklu sembol (BTC+ETH eşzamanlı akışlar; sembol karışması, aşırı satış, kalıcı kilit yok)', quiet(async () => {
  const r = await multi.runMany(1, MULTI_ITERS, {});
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.lockedAfterRecovery, 0, `kalıcı kilit: ${JSON.stringify(r.stats.lockReasons)}`);
}));
test('kaos: çoklu sembol + süreç çökmesi', quiet(async () => {
  const r = await multi.runMany(1, MULTI_ITERS, { crash: true });
  assert.deepEqual(r.violations.slice(0, 5), []);
  assert.equal(r.stats.lockedAfterRecovery, 0, `kalıcı kilit: ${JSON.stringify(r.stats.lockReasons)}`);
}));
