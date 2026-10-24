// Prevent two bot processes from writing the same state directory.
// Fail closed for stale, malformed, or foreign-host locks: PID values are not
// comparable across hosts/containers and automatic unlinking can permit split brain.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function acquireInstanceLock(dataDir, { pid = process.pid, host = os.hostname() } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'bot.lock');
  const reclaimFile = path.join(dataDir, 'bot.lock.reclaim');
  const token = crypto.randomBytes(16).toString('hex');
  const record = { pid: Number(pid), host: String(host), startedAt: new Date().toISOString(), token };

  const writeExclusive = () => {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
    catch (e) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} throw e; }
    fs.closeSync(fd);
  };
  const readLock = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
  };

  try {
    writeExclusive();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const cur = readLock();
    if (!cur) {
      throw new Error(`Süreç kilidi dosyası bozuk; güvenlik için otomatik silinmedi. Botların durduğunu doğrulayıp elle kaldır: ${file}`);
    }
    const sameHost = cur && String(cur.host || '') === String(host);
    if (!sameHost) {
      throw new Error(`Bu veri klasörü kilitli (başka host/container: ${cur.host || 'bilinmiyor'}). Güvenlik için otomatik devralınmadı: ${file}`);
    }
    if (pidAlive(cur.pid)) {
      throw new Error(`Bu veri klasörü kilitli (canlı pid ${cur.pid}). İkinci bot başlatılmadı: ${file}`);
    }

    // Tek bir süreç eski kilidi devralsın. Yeniden kontrol, kilit dosyasının
    // kontrol ile silme arasında başka bir süreç tarafından değiştirilmesini önler.
    let reclaimFd;
    try {
      reclaimFd = fs.openSync(reclaimFile, 'wx', 0o600);
      fs.writeFileSync(reclaimFd, JSON.stringify({ pid: Number(pid), host: String(host), token }));
      fs.fsyncSync(reclaimFd);
    } catch (reclaimError) {
      if (reclaimError.code === 'EEXIST') {
        throw new Error(`Eski kilit için başka bir başlangıç kurtarma yapıyor; güvenlik için bu başlangıç durduruldu: ${file}`);
      }
      throw reclaimError;
    } finally {
      if (reclaimFd !== undefined) try { fs.closeSync(reclaimFd); } catch {}
    }
    try {
      const latest = readLock();
      if (!latest || latest.token !== cur.token || latest.host !== cur.host || Number(latest.pid) !== Number(cur.pid)) {
        throw new Error(`Kilit kurtarma sırasında değişti; ikinci bot başlatılmadı: ${file}`);
      }
      if (pidAlive(latest.pid)) {
        throw new Error(`Eski kilitteki pid ${latest.pid} hâlâ canlı; kilit devralınmadı: ${file}`);
      }
      fs.unlinkSync(file);
      try {
        writeExclusive();
      } catch (createError) {
        throw new Error(`Eski kilit kaldırıldı ancak yeni kilit güvenle oluşturulamadı: ${createError.message}`);
      }
    } finally {
      try {
        const marker = JSON.parse(fs.readFileSync(reclaimFile, 'utf8'));
        if (marker.token === token && Number(marker.pid) === Number(pid) && marker.host === String(host)) fs.unlinkSync(reclaimFile);
      } catch { /* Yalnızca kendi kurtarma işaretçimizi kaldır. */ }
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cur.token === token && cur.pid === record.pid && cur.host === record.host) fs.unlinkSync(file);
    } catch { /* Never remove a lock that cannot be verified as ours. */ }
  };
  process.once('exit', release);
  return { file, release, token };
}
module.exports = { acquireInstanceLock, pidAlive };
