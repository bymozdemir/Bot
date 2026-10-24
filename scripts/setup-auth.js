#!/usr/bin/env node
const readline = require('readline');
const auth = require('../src/auth');

function askHidden(prompt) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer); }));
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let value = '';
    const onData = (ch) => {
      ch = String(ch);
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); resolve(value); return;
      }
      if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      if (ch === '\u007f') value = value.slice(0, -1); else value += ch;
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
}

(async () => {
  try {
    const a = await askHidden('Yeni panel şifresi (en az 12 karakter): ');
    const b = await askHidden('Tekrar: ');
    if (a !== b) throw new Error('Şifreler eşleşmiyor.');
    auth.setPassword(a);
    console.log(`Panel kimliği oluşturuldu: ${auth.AUTH_FILE}`);
    console.log('Artık PANEL_PASSWORD kullanman gerekmez; .env içindeki değeri kaldırabilirsin.');
  } catch (e) {
    console.error('Kurulum başarısız:', e.message);
    process.exit(1);
  }
})();
