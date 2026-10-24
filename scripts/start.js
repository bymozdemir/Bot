#!/usr/bin/env node
'use strict';
// `npm start` girişi. Etkileşimli terminalde ilk kurulum eksikse (panel şifresi, Telegram) sırayla sorar,
// sonra botu başlatır. `npm run setup` ayarları yeniden sorar ve botu başlatmaz.
// Terminal yoksa (Termux:Boot, systemd, Docker) hiçbir şey sormaz; doğrudan server.js çalışır.
const path = require('path');
const root = path.join(__dirname, '..');
process.chdir(root);

const reconfigure = process.argv.slice(2).includes('--setup');

(async () => {
  const fr = require('../src/firstRun');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const envFile = path.join(root, '.env');
  const dataDir = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(root, 'data');
  const pending = fr.needsSetup({ envFile, dataDir, env: process.env });

  if (reconfigure && !interactive) {
    console.error('npm run setup etkileşimli bir terminal gerektirir.');
    process.exit(1);
  }
  if (interactive && (reconfigure || pending)) {
    try {
      await fr.runSetup({ io: fr.makeTerminalIO(), envFile, dataDir, env: process.env, reconfigure, setPassword: require('../src/auth').setPassword });
    } catch (e) {
      console.error(`Kurulum yarım kaldı: ${e.message}. Yeniden denemek için: npm start`);
      process.exit(1);
    }
  } else if (pending) {
    console.error('[kurulum] Eksik ayar var ama terminal etkileşimli değil; kurulum sorulmadı. Elle başlatıp soruları yanıtla: npm start');
  }
  if (reconfigure) { console.log('Ayarlar kaydedildi. Başlatmak için: npm start'); return; }
  require('../server.js');
})();
