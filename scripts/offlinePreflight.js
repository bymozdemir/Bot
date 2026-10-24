const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const strategies = require('../src/strategies');

const root = path.join(__dirname, '..');
const required = [
  'src/liveEngine.js', 'src/orderManager.js', 'src/reconciliation.js',
  'src/liveRecovery.js', 'src/userDataStream.js', 'src/exchanges/binance.js'
];
const problems = [];
for (const f of required) if (!fs.existsSync(path.join(root, f))) problems.push(`Eksik dosya: ${f}`);
const state = store.defaultState();
if (state.settings.mode !== 'paper') problems.push('Varsayılan mod paper değil.');
if (state.live?.safeToTrade !== false) problems.push('Varsayılan live.safeToTrade false değil.');
if (state.liveOrders && typeof state.liveOrders !== 'object') problems.push('liveOrders yapısı bozuk.');
for (const s of strategies.list()) {
  try {
    const params = { ...strategies.get(s.id).defaultParams };
    const err = strategies.validateParams(s.id, params);
    if (err) problems.push(`${s.id}: varsayılan parametre geçersiz: ${err}`);
  } catch (e) { problems.push(`${s.id}: ${e.message}`); }
}
const source = required.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
if (/BEGIN (RSA |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16}/.test(source)) problems.push('Kaynak dosyalarda olası gizli anahtar bulundu.');
if (problems.length) {
  console.error('OFFLINE PREFLIGHT: BAŞARISIZ');
  for (const p of problems) console.error('- ' + p);
  process.exit(1);
}
console.log('OFFLINE PREFLIGHT: BAŞARILI');
console.log(`- ${required.length} kritik dosya mevcut`);
console.log(`- ${strategies.list().length} stratejinin varsayılan parametreleri geçerli`);
console.log('- Varsayılan çalışma modu: paper');
console.log('- Canlı işlem güvenlik kilidi: kapalı');
console.log('- Kaynaklarda bariz gizli anahtar izi: yok');
