'use strict';
// src/runtimeMarker.js
//
// Calisma isaretcisi: botun temiz mi kapandigini yoksa aniden mi kesildigini ve ne kadar
// sure kapali kaldigini anlamak icin. Dosya: <dataDir>/runtime-marker.json
//  - boot():      onceki calismanin isaretini okur, yenisini yazar (cleanExit:false)
//  - heartbeat(): her dakika "hala yasiyorum" zamanini gunceller (kesinti suresi bundan hesaplanir)
//  - markClean(): SIGINT/SIGTERM ile duzgun kapanista cleanExit:true yazar
// Tum islemler hata yutar; isaretci yazilamazsa bot yine calisir.

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./util/atomicWrite');

function createRuntimeMarker({ dataDir, nowFn = Date.now }) {
  const file = path.join(dataDir, 'runtime-marker.json');
  let current = null;

  const write = (obj) => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      atomicWriteFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
    } catch (e) { /* isaretci yazilamazsa bot yine calisir */ }
  };
  const readPrev = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && Number.isFinite(Number(j.startedAt))) {
        return { startedAt: Number(j.startedAt), lastAliveAt: Number(j.lastAliveAt) || Number(j.startedAt), cleanExit: j.cleanExit === true };
      }
    } catch (e) { /* yok ya da bozuk */ }
    return null;
  };

  function boot() {
    const previous = readPrev();
    const t = nowFn();
    current = { startedAt: t, lastAliveAt: t, cleanExit: false };
    write(current);
    return { previous, downtimeMs: previous ? Math.max(0, t - previous.lastAliveAt) : 0 };
  }
  function heartbeat() { if (!current) return; current.lastAliveAt = nowFn(); write(current); }
  function markClean() { if (!current) return; current.lastAliveAt = nowFn(); current.cleanExit = true; write(current); }
  return { boot, heartbeat, markClean, file };
}

// Onceki oturumun nasil bittigi: iki bagimsiz kayit birlestirilir (state.notifyMeta + isaretci dosyasi).
//   stateSays: 'first' | 'clean' | 'unexpected'  (state.json icindeki bayraktan)
//   markerPrev: boot().previous (null = dosya yok/bozuk)
// Birinde bile "beklenmedik" varsa beklenmedik sayilir (guvenli taraf); ikisinde de gecmis yoksa 'first'.
function combineShutdown(stateSays, markerPrev) {
  const markerSays = !markerPrev ? 'first' : (markerPrev.cleanExit ? 'clean' : 'unexpected');
  if (stateSays === 'unexpected' || markerSays === 'unexpected') return 'unexpected';
  if (stateSays === 'clean' || markerSays === 'clean') return 'clean';
  return 'first';
}

module.exports = { createRuntimeMarker, combineShutdown };
