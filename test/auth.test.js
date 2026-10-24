const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(code, env) {
  return spawnSync(process.execPath, ['-e', code], { env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' }, encoding: 'utf8' });
}

test('panel auth: parola hashlenir, düz metin auth.json içinde tutulmaz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-auth-'));
  const code = `const a=require(${JSON.stringify(path.resolve(__dirname,'../src/auth'))}); a.setPassword('ÇokGüçlüPanelParolası-2026!'); console.log(a.AUTH_FILE);`;
  const r = run(code, { BOT_DATA_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(dir, 'auth.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('scrypt'));
  assert.ok(!raw.includes('ÇokGüçlüPanelParolası-2026!'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('panel auth: doğru parola session üretir, yanlış parola reddedilir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-auth-'));
  const code = `const a=require(${JSON.stringify(path.resolve(__dirname,'../src/auth'))}); a.setPassword('GuvenliPanelParolasi-2026!'); const good=a.login('GuvenliPanelParolasi-2026!'); const bad=a.login('yanlis'); console.log(JSON.stringify({good:!!good,bad:!!bad,valid:!!a.getSession(good.token)}));`;
  const r = run(code, { BOT_DATA_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { good: true, bad: false, valid: true });
});

test('panel auth: session logout sonrası geçersiz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-auth-'));
  const r = run(`const a=require(${JSON.stringify(path.resolve(__dirname,'../src/auth'))}); a.setPassword('GuvenliPanelParolasi-2026!'); const x=a.login('GuvenliPanelParolasi-2026!'); a.logout(x.token); console.log(!!a.getSession(x.token));`, { BOT_DATA_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'false');
});
