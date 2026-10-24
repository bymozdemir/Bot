const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('vault unlock endpoint limiter tanımlı ve kullanılabilir', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const vaultLimiter\s*=\s*makeLimiter\(/);
  assert.match(src, /vaultLimiter\.blocked\(key\)/);
  assert.match(src, /vaultLimiter\.fail\(key\)/);
  assert.match(src, /vaultLimiter\.reset\(key\)/);
});
