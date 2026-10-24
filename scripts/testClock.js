#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOWS = [
  '2026-10-02T12:00:00Z',
  '2026-10-02T20:59:00Z',
  '2026-10-02T21:01:00Z',
  '2026-10-02T22:30:00Z',
  '2026-12-31T23:30:00Z',
  '2027-06-15T03:00:00Z'
];
const loader = path.join(__dirname, 'fakeNow.js');
const TIMEOUT_MS = 240000;
let failed = 0;

for (const now of NOWS) {
  const options = {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      FAKE_NOW: now,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS || '',
        `--require=${loader}`
      ].filter(Boolean).join(' ')
    }
  };

  const r = spawnSync(
    process.execPath,
    ['scripts/runTests.js'],
    options
  );

  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const passMatch = out.match(/(?:ℹ\s+|#\s*)pass\s+(\d+)/i);
  const failMatch = out.match(/(?:ℹ\s+|#\s*)fail\s+(\d+)/i);
  const pass = passMatch ? Number(passMatch[1]) : null;
  const fail = failMatch ? Number(failMatch[1]) : null;

  let reason = '';
  if (r.error) {
    reason = r.error.code === 'ETIMEDOUT'
      ? `ZAMAN ASIMI (${TIMEOUT_MS / 1000} sn)`
      : `ALT SUREC HATASI: ${r.error.message}`;
  } else if (r.signal) {
    reason = `SUREC SINYALLE SONLANDI: ${r.signal}`;
  } else if (r.status !== 0) {
    reason = `CIKIS KODU: ${r.status}`;
  } else if (pass === null || fail === null) {
    reason = 'TEST OZETI OKUNAMADI';
  } else if (fail !== 0) {
    reason = `${fail} BASARISIZ TEST`;
  }

  if (reason) {
    failed++;
    console.log(`${now}  BASARISIZ: ${reason}`);
    const bad = out.match(/(?:not ok .+|✖ .+|Error:.+)/g) || [];
    bad.slice(0, 5).forEach(line => console.log(`  ${line.slice(0, 200)}`));
    if (pass !== null && fail !== null) {
      console.log(`  Gecen: ${pass}, Basarisiz: ${fail}`);
    }
  } else {
    console.log(`${now}  GECEN: ${pass}, BASARISIZ: ${fail}`);
  }
}

console.log(
  failed
    ? `\nSONUC: ${failed}/${NOWS.length} tarih turu basarisiz veya dogrulanamadi.`
    : `\nSONUC: ${NOWS.length} tarih turunun tamami basarili.`
);
process.exitCode = failed ? 1 : 0;
