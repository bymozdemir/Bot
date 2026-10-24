#!/usr/bin/env node
'use strict';
// Public, read-only connectivity check for Binance Spot Testnet; no API keys and no orders.
const dns = require('node:dns').promises;
const https = require('node:https');
const host = 'testnet.binance.vision';
const timeoutMs = Math.max(1000, Number(process.env.TESTNET_PREFLIGHT_TIMEOUT_MS || 8000));
function getTime() {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: host, path: '/api/v3/time', timeout: timeoutMs, headers: { 'User-Agent': 'paper-bot-testnet-preflight/1.0' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => body += c);
      res.on('end', () => {
        let json; try { json = JSON.parse(body); } catch { return reject(new Error(`HTTP ${res.statusCode}; non-JSON response`)); }
        if (res.statusCode !== 200 || !Number.isFinite(json.serverTime)) return reject(new Error(`HTTP ${res.statusCode}; unexpected response`));
        resolve({ serverTime: json.serverTime, statusCode: res.statusCode });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
(async () => {
  console.log('Binance Spot Testnet preflight (read-only; no credentials; no orders)');
  try {
    const records = await dns.lookup(host, { all: true });
    console.log(`DNS PASS: ${records.map(r => r.address).join(', ')}`);
    const r = await getTime();
    const drift = Date.now() - r.serverTime;
    console.log(`HTTPS PASS: ${host}/api/v3/time HTTP ${r.statusCode}; local-server clock difference ${drift}ms`);
    if (Math.abs(drift) > 4000) { console.error('WARN: local clock differs by >4 seconds; signed requests may fail.'); process.exitCode = 2; }
    else console.log('READY: public Testnet endpoint reachable. This does not validate API keys or order placement.');
  } catch (e) {
    console.error(`NOT READY: ${e.code || e.message}`);
    console.error('Check internet/DNS, Android Private DNS, VPN/proxy, device date/time, then retry. No trading request was sent.');
    process.exitCode = 2;
  }
})();
