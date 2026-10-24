#!/usr/bin/env node
// Ag tanilama: "Google ping calisiyor ama Binance yok" gibi durumlarda NEDENI bulur.
// Calistir: npm run net:check   (Windows / Linux / Termux / VPS'te ayni)
// Hicbir API anahtari gerekmez ve emir gondermez; yalnizca herkese acik /api/v3/time cagirir.
try { require('dotenv').config(); } catch (_) { /* npm install öncesi de çalışsın */ }
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const { applyNetworkDefaults, explainNetworkError } = require('../src/util/network');

const HOSTS = ['api.binance.com', 'api-gcp.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com', 'api4.binance.com', 'data-api.binance.vision'];
const T = 7000;
const line = (ok, msg) => console.log(`${ok === null ? '  ' : ok ? '✔ ' : '✘ '}${msg}`);

function tcp(host, port, family) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port, family, timeout: T });
    s.once('connect', () => { s.destroy(); resolve({ ok: true, ms: Date.now() - t0 }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, err: 'zaman aşımı' }); });
    s.once('error', (e) => resolve({ ok: false, err: e.code || e.message }));
  });
}
function tlsHandshake(host, address) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: address, port: 443, servername: host, timeout: T });
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate();
      const out = { ok: s.authorized, err: s.authorizationError, issuer: c && c.issuer && (c.issuer.O || c.issuer.CN), proto: s.getProtocol() };
      s.destroy(); resolve(out);
    });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, err: 'zaman aşımı' }); });
    s.once('error', (e) => resolve({ ok: false, err: e.code || e.message }));
  });
}

(async () => {
  const info = applyNetworkDefaults();
  console.log(`Node ${process.version} | ${process.platform} | DNS sırası: ${info.dnsOrder || '-'} | proxy: ${info.proxy || 'yok'}`);
  if (info.proxyError) line(false, info.proxyError);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') line(false, 'NODE_TLS_REJECT_UNAUTHORIZED=0 AÇIK: bu güvensizdir, canlı mod bu durumda başlamaz. Kaldırın.');
  console.log('');
  let reachable = 0; const problems = new Set();
  for (const host of HOSTS) {
    console.log(`— ${host}`);
    let addrs = [];
    try { addrs = await dns.promises.lookup(host, { all: true }); } catch (e) { line(false, `DNS: ${e.code || e.message}`); problems.add(e.code || 'DNS'); continue; }
    line(true, `DNS: ${addrs.map((a) => a.address).join(', ')}`);
    let hostOk = false;
    for (const a of addrs.slice(0, 4)) {
      const r = await tcp(a.address, 443, a.family);
      if (!r.ok) { line(false, `TCP ${a.address} (IPv${a.family}): ${r.err}`); problems.add(r.err); continue; }
      const h = await tlsHandshake(host, a.address);
      if (!h.ok) { line(false, `TLS ${a.address}: ${h.err}`); problems.add(h.err); continue; }
      line(true, `TCP+TLS ${a.address} (IPv${a.family}) ${r.ms} ms, ${h.proto}, sertifika veren: ${h.issuer}`);
      hostOk = true;
    }
    if (hostOk) {
      try {
        const t0 = Date.now(); const res = await fetch(`https://${host}/api/v3/time`, { signal: AbortSignal.timeout(T) });
        const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch (_) { /* JSON degil */ }
        if (!res.ok || !j || !j.serverTime) { line(false, `HTTPS /api/v3/time → ${res.status}, beklenen yanıt değil: "${text.slice(0, 80).replace(/\s+/g, ' ')}" (araya giren bir proxy/filtre olabilir)`); problems.add(`HTTP ${res.status}`); }
        else {
          const drift = Date.now() - j.serverTime;
          line(true, `HTTPS /api/v3/time → ${res.status} (${Date.now() - t0} ms), saat farkı ${drift} ms${Math.abs(drift) > 4000 ? '  ⚠ SAAT SAPMIŞ (>4 sn): imzalı emirler reddedilir' : ''}`);
          reachable++;
        }
      } catch (e) {
        const c = e.cause && (e.cause.code || e.cause.message); line(false, `HTTPS: ${c || e.message}`); problems.add(c || e.message);
      }
    }
  }
  console.log('');
  if (reachable > 0) {
    line(true, `${reachable}/${HOSTS.length} adrese ulaşıldı. Bot herkese açık veride çalışan adresi otomatik seçer.`);
    if (!reachable || reachable < HOSTS.length) console.log('  (Bazı adresler kapalı olabilir; bu normaldir.)');
  } else {
    line(false, 'Hiçbir Binance adresine ulaşılamadı. Olası nedenler:');
    for (const p of problems) { const h = explainNetworkError(p); if (h) console.log(`   • ${p}: ${h}`); }
    console.log('   • Sırayla deneyin: (1) DNS\'i 1.1.1.1/8.8.8.8 yapın, (2) modemde IPv6\'yı kapatın, (3) cep telefonu hotspot ile deneyin,');
    console.log('     (4) antivirüs HTTPS taramasını Node için kapatın, (5) VPS kullanın. Ayrıntı: docs/NETWORK.md');
  }
  process.exit(reachable > 0 ? 0 : 2);
})();
