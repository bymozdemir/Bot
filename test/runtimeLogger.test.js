'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('runtime logger appends console records to bot.log and redacts secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-runtime-log-'));
  const modulePath = path.resolve(__dirname, '../src/util/runtimeLogger.js');
  const script = `const l=require(${JSON.stringify(modulePath)}); l.install(${JSON.stringify(dir)}); console.log('bot started'); console.error('TELEGRAM_BOT_TOKEN=secret123');`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rows = fs.readFileSync(path.join(dir, 'bot.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((r) => r.message.includes('bot started')));
  assert.ok(rows.some((r) => r.message.includes('TELEGRAM_BOT_TOKEN=[REDACTED]')));
  assert.ok(!fs.readFileSync(path.join(dir, 'bot.log'), 'utf8').includes('secret123'));
  fs.rmSync(dir, { recursive: true, force: true });
});
