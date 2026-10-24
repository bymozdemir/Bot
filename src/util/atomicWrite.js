const fs = require('fs');
const lastBackupAt = new Map();

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* retry beklemesi desteklenmiyorsa devam et */ }
}

function renameWithRetry(tmp, file, attempts = 8) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) break;
      sleepSync(25 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* temp artığı ikincil temizliktir */ }
  throw lastErr || new Error('Atomik rename başarısız.');
}

function atomicWriteFileSync(file, data, { mode, backup = false, backupEveryMs = 60000 } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${require('crypto').randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', mode === undefined ? 0o600 : mode);
  let readyToRename = false;
  try {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) throw new Error('Dosya yazımı ilerlemedi.');
      offset += written;
    }
    // Dosya verisinin diske aktarımı başarısızsa eski state'i değiştirmeden kapalı kal.
    // fsync hatasını yutmak, kalıcı yazma yapılmış gibi yanlış güven verir.
    fs.fsyncSync(fd);
    readyToRename = true;
  } catch (err) {
    try { fs.closeSync(fd); } catch (_) { /* asıl hata korunur */ }
    try { fs.unlinkSync(tmp); } catch (_) { /* temizlik best effort */ }
    throw err;
  }
  if (readyToRename) {
    try { fs.closeSync(fd); } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* temizlik best effort */ }
      throw err;
    }
  }

  if (backup && fs.existsSync(file)) {
    const now = Date.now();
    if (now - (lastBackupAt.get(file) || 0) >= backupEveryMs) {
      let valid = true;
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { valid = false; }
      if (valid) {
        try { fs.copyFileSync(file, `${file}.bak`); lastBackupAt.set(file, now); } catch (_) { /* yedek best effort; asıl atomik yazma sürer */ }
      }
    }
  }
  renameWithRetry(tmp, file);
  // POSIX'te rename'in elektrik kesintisinde kalıcı olması için dizin girdisi de fsync edilir.
  // Windows dizin fsync desteklemez; orada sessizce atlanır (veri dosyası zaten fsync edildi).
  if (process.platform !== 'win32') {
    let dfd = null;
    try { dfd = fs.openSync(require('path').dirname(file), 'r'); fs.fsyncSync(dfd); }
    catch (_) { /* bazı dosya sistemleri dizin fsync desteklemez */ }
    finally { if (dfd !== null) { try { fs.closeSync(dfd); } catch (_) { /* yoksay */ } } }
  }
}

module.exports = { atomicWriteFileSync, renameWithRetry };
