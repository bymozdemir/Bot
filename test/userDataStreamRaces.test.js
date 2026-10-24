'use strict';
// Kullanici veri akisi: yeniden baglanma yarisi, disk hatasinda olay kaybi, basarisiz abonelikte soket sizintisi.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { BinanceUserDataStream } = require('../src/userDataStream');

function mkFakeWs(closeDelay, { rejectSubscribe = false } = {}) {
  const sockets = [];
  class FakeWS extends EventEmitter {
    constructor() { super(); this.n = sockets.length; sockets.push(this); this.closed = false; setImmediate(() => this.emit('open')); }
    send(data) {
      const id = JSON.parse(data).id;
      setImmediate(() => this.emit('message', JSON.stringify(rejectSubscribe ? { id, status: 400, error: { msg: 'reddedildi' } } : { id, status: 200, result: { subscriptionId: this.n } })));
    }
    close() { if (this.closed) return; this.closed = true; setTimeout(() => this.emit('close'), closeDelay); }
    terminate() { this.close(); }
  }
  FakeWS.sockets = sockets;
  return FakeWS;
}
const ex = { createUserDataStreamSignature: () => ({}), getUserDataWsUrl: () => 'ws://x' };
const mk = (WS, extra = {}) => new BinanceUserDataStream({ exchange: ex, orderManager: { applyExecutionReport: () => {} }, state: {}, store: { save() {} }, WebSocketImpl: WS, reconnectMs: 10, subscribeTimeoutMs: 500, ...extra });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('akış: eventStreamTerminated sonrası eski soketin gecikmiş kapanışı yeni bağlantıyı bozmaz, soket sızmaz', async () => {
  const WS = mkFakeWs(60); const st = mk(WS);
  await st.start();
  st.ws.emit('message', JSON.stringify({ event: { e: 'eventStreamTerminated', E: 1 } }));
  await wait(250);
  const open = WS.sockets.filter((s) => !s.closed);
  assert.equal(open.length, 1, `yalnız 1 açık soket olmalı: ${open.length} (toplam ${WS.sockets.length})`);
  assert.equal(st.ws, open[0]);
  await st.stop();
});

test('akış: disk yazımı başarısız olsa bile yürütme raporu uygulanır ve istisna sızmaz', async () => {
  const WS = mkFakeWs(5); const applied = []; let fail = false;
  const st = new BinanceUserDataStream({ exchange: ex, orderManager: { applyExecutionReport: (e) => applied.push(e) }, state: {}, store: { save() { if (fail) throw new Error('ENOSPC'); } }, WebSocketImpl: WS, reconnectMs: 10 });
  await st.start();
  fail = true;
  assert.doesNotThrow(() => st.ws.emit('message', JSON.stringify({ event: { e: 'executionReport', E: 5, c: 'x', i: 1 } })));
  assert.equal(applied.length, 1, 'olay uygulanmalı');
  assert.ok(st.lastSaveError);
  await st.stop();
});

test('akış: abonelik reddedilirse açık kalan soket temizlenir (her denemede bağlantı sızmaz)', async () => {
  const WS = mkFakeWs(5, { rejectSubscribe: true }); const st = mk(WS);
  await assert.rejects(() => st.start(), /reddedildi/);
  await wait(50);
  assert.equal(WS.sockets.filter((s) => !s.closed).length, 0, 'reddedilen bağlantı kapatılmalı');
  await st.stop();
});
