'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('eski state.json shadow modundan paper moduna güvenli biçimde taşınır', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-shadow-migration-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      settings: { mode: 'shadow', closeOnDailyLoss: false },
      pairs: {},
      shadow: { trades: [{ symbol: 'BTC/USDT', side: 'BUY' }], positions: {} }
    }));
    const script = `const s=require(${JSON.stringify(path.resolve(__dirname, '../src/store'))}).load(); process.stdout.write(JSON.stringify({mode:s.settings.mode,closeOnDailyLoss:s.settings.closeOnDailyLoss,legacyShadow:s.shadow}));`;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, BOT_DATA_DIR: dataDir }
    });
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(r.stdout);
    assert.equal(state.mode, 'paper');
    assert.equal(state.closeOnDailyLoss, true, 'legacy opt-out must migrate to safe close behavior');
    assert.equal(state.legacyShadow.trades.length, 1);
    assert.equal(state.legacyShadow.trades[0].symbol, 'BTC/USDT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
