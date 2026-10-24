const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { BinanceUserDataStream } = require('../src/userDataStream');
const BinanceAdapter = require('../src/exchanges/binance');

class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.handlers = {};
    this.sent = [];
    FakeWS.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }
  on(name, fn) { this.handlers[name] = fn; }
  emit(name, value) { if (this.handlers[name]) this.handlers[name](value); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.emit('close'); }
}

function store() { return { save() {} }; }

test('User Data Stream imzalı subscribe olur ve executionReport OrderManagera gider', async () => {
  FakeWS.instances.length = 0;
  const events = [];
  const exchange = {
    createUserDataStreamSignature({ timestamp, recvWindow }) { return { apiKey: 'KEY', timestamp, recvWindow, signature: 'SIG' }; },
    getUserDataWsUrl() { return 'wss://test'; }
  };
  const om = { applyExecutionReport(event) { events.push(event); } };
  const state = {};
  const stream = new BinanceUserDataStream({ exchange, orderManager: om, state, store: store(), WebSocketImpl: FakeWS, nowFn: () => 1000, connectionRefreshMs: 0 });
  const started = stream.start();
  await new Promise((resolve) => setImmediate(resolve));
  const ws = FakeWS.instances[0];
  assert.equal(ws.url, 'wss://test');
  assert.equal(ws.sent[0].method, 'userDataStream.subscribe.signature');
  assert.equal(ws.sent[0].params.apiKey, 'KEY');
  assert.equal(ws.sent[0].params.signature, 'SIG');
  assert.equal(ws.sent[0].params.timestamp, 1000);
  ws.emit('message', JSON.stringify({ id: ws.sent[0].id, status: 200, result: { subscriptionId: 3 } }));
  await started;
  ws.emit('message', JSON.stringify({ event: { e: 'executionReport', E: 123, c: 'cid-1', i: 7, s: 'BTCUSDT', X: 'FILLED', z: '1', q: '1', Z: '100' } }));
  assert.equal(events.length, 1);
  assert.equal(events[0].c, 'cid-1');
  assert.equal(state.liveStream.connected, true);
  await stream.stop();
});

test('eventStreamTerminated bağlantıyı kapatıp yeniden bağlanma planlar', () => {
  FakeWS.instances.length = 0;
  const exchange = {
    createUserDataStreamSignature() { return { apiKey: 'KEY', timestamp: Date.now(), recvWindow: 5000, signature: 'SIG' }; },
    getUserDataWsUrl() { return 'wss://test'; }
  };
  const om = { applyExecutionReport() {} };
  const stream = new BinanceUserDataStream({ exchange, orderManager: om, state: {}, store: store(), WebSocketImpl: FakeWS, reconnectMs: 0, connectionRefreshMs: 0 });
  stream.running = true;
  stream.ws = { closeCalled: false, close() { this.closeCalled = true; } };
  stream._handleMessage({ event: { e: 'eventStreamTerminated', E: 123 } });
  assert.equal(stream.ws.closeCalled, true);
  assert.equal(stream.state.liveStream.connected, false);
  stream.stop();
});

test('tanınmayan executionReport doğrudan benimsenmez', () => {
  const exchange = { createUserDataStreamSignature() { return {}; }, getUserDataWsUrl() { return 'wss://test'; } };
  const om = { applyExecutionReport(event) { return { handled: false, reason: 'unknown_local_order' }; } };
  const stream = new BinanceUserDataStream({ exchange, orderManager: om, state: {}, store: store(), WebSocketImpl: FakeWS });
  assert.doesNotThrow(() => stream._handleMessage({ e: 'executionReport', c: 'foreign', X: 'NEW' }));
});


test('Node 22+ uyumluluğu: sunucu WebSocketi yerine ws adapteri seçilir', () => {
  const source = fs.readFileSync(require.resolve('../src/userDataStream'), 'utf8');
  assert.match(source, /require\('ws'\)/);
  assert.doesNotMatch(source, /globalThis\.WebSocket/);
});

test('Binance User Data Stream timestampı saat offsetini kullanır', () => {
  const ex = new BinanceAdapter({ apiKey: 'k', apiSecret: 's' });
  ex._timeOffsetMs = 4321;
  assert.equal(ex.getUserDataStreamTimestamp(100000), 104321);
  const before = Date.now();
  const signed = ex.createUserDataStreamSignature({ timestamp: undefined, recvWindow: 5000 });
  const after = Date.now();
  assert.ok(signed.timestamp >= before + 4321 && signed.timestamp <= after + 4321);
});
