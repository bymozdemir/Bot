'use strict';
// fetchWithRetry: sunucu başlığı gönderip gövdeyi yarıda bırakırsa istek zaman aşımına uğramalı (eskiden sonsuza dek asılıyordu).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchWithRetry } = require('../src/util/retry');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const closeServer = (srv) => { srv.closeAllConnections?.(); srv.close(); };

test('gövdesi yarıda kalan yanıt zaman aşımına uğrar, asılı kalmaz', async () => {
  const { srv, base } = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' }); res.write('{"a":'); });
  try {
    const t0 = Date.now();
    const outcome = await Promise.race([
      fetchWithRetry(`${base}/`, {}, { retries: 0, timeoutMs: 300 }).then((res) => res.text().then(() => 'dondu'), (e) => e),
      new Promise((ok) => setTimeout(() => ok('ASILI'), 4000))
    ]);
    assert.notEqual(outcome, 'ASILI', 'istek zaman aşımına rağmen asılı kaldı');
    assert.ok(outcome instanceof Error && /zaman aşımı/.test(outcome.message), String(outcome));
    assert.ok(Date.now() - t0 < 3000);
  } finally { closeServer(srv); }
});

test('normal yanıt, 204 ve hata kodu yolları aynı arayüzle çalışır', async () => {
  const { srv, base } = await serve((req, res) => {
    if (req.url === '/204') { res.writeHead(204); return res.end(); }
    if (req.url === '/500') { res.writeHead(500); return res.end('{"err":1}'); }
    res.writeHead(200, { 'content-type': 'application/json', 'x-a': 'b' }); res.end('{"ok":true}');
  });
  try {
    const a = await fetchWithRetry(`${base}/`, {}, { retries: 0 });
    assert.equal(a.status, 200); assert.equal(a.headers.get('x-a'), 'b'); assert.deepEqual(await a.json(), { ok: true });
    const b = await fetchWithRetry(`${base}/204`, {}, { retries: 0 });
    assert.equal(b.status, 204);
    const c = await fetchWithRetry(`${base}/500`, {}, { retries: 0 });
    assert.equal(c.ok, false); assert.equal(await c.text(), '{"err":1}');
  } finally { closeServer(srv); }
});
