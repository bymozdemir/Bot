#!/usr/bin/env node
// Capraz platform test calistirici: "NO_COLOR=1 node --test test/*.test.js" Windows
// cmd/PowerShell'de calismaz (ortam degiskeni sozdizimi ve glob). Bu betik ikisini de cozer.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
process.exit(r.status === null ? 1 : r.status);
