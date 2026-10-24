const { registry } = require('../src/exchanges');

const required = [
  'fetchCandles','fetchTicker','fetchAllTickers24h','fetchSymbolRules',
  'fetchOpenOrders','fetchBalance','createMarketOrder','createStopOrder','getOrder','cancelOrder'
];

// RED: the adapter does not satisfy the minimum code contract.
// YELLOW: code contract is present, but explicit sandbox/real-account verification is absent.
// GREEN: code contract is present AND liveTradingVerified is explicitly true.
// Never treat an undefined verification flag as proof.
let failed = false;
for (const [id, Cls] of Object.entries(registry)) {
  const ex = new Cls();
  const missing = required.filter((m) => typeof ex[m] !== 'function');
  const caps = ex.capabilities || {};
  const safeIdentity = caps.clientOrderId === true && caps.recoveryByFingerprint !== true;
  const safePrivate = caps.orderQuery === true && caps.balanceQuery === true && caps.openOrdersQuery === true;
  const safeStop = typeof ex.createStopOrder === 'function' && typeof ex.cancelOrder === 'function' && caps.protectiveStopImplemented === true;
  const codeOk = missing.length === 0 && safeIdentity && safePrivate && safeStop;
  const verified = caps.liveTradingVerified === true;
  const label = !codeOk ? 'RED' : verified ? 'GREEN' : 'YELLOW';
  console.log(`${label} ${id}: code=${codeOk ? 'complete' : 'incomplete'} identity=${safeIdentity} private=${safePrivate} stop=${safeStop} verified=${verified ? 'YES' : 'NO'}${missing.length ? ` missing=${missing.join(',')}` : ''}`);
  if (!codeOk) failed = true;
}
if (failed) process.exit(1);
