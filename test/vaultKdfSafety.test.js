'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

function runWithVaultFile(fileContents, script = "require('./src/vault').unlock('this-is-a-long-test-passphrase')") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-kdf-'));
  try {
    fs.writeFileSync(path.join(dir, 'credentials.enc.json'), fileContents);
    return spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, BOT_DATA_DIR: dir },
      encoding: 'utf8',
      timeout: 3000
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('vault rejects hostile KDF parameters before expensive scrypt', () => {
  const payload = JSON.stringify({
    version: 2,
    salt: Buffer.alloc(16, 7).toString('base64'),
    kdf: { N: 1073741824, r: 8, p: 1 },
    canary: { iv: '', data: '', tag: '' },
    exchanges: {}
  });
  const result = runWithVaultFile(payload, "try { require('./src/vault').unlock('this-is-a-long-test-passphrase'); process.exit(2); } catch (e) { if (!/KDF parametreleri geçersiz/.test(e.message)) process.exit(3); }");
  assert.equal(result.error, undefined, 'vault check must finish without timeout');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('vault rejects oversized credential file before JSON parsing', () => {
  const result = runWithVaultFile(' '.repeat(1024 * 1024 + 1), "try { require('./src/vault').unlock('this-is-a-long-test-passphrase'); process.exit(2); } catch (e) { if (!/boyutu geçersiz/.test(e.message)) process.exit(3); }");
  assert.equal(result.error, undefined, 'vault check must finish without timeout');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
