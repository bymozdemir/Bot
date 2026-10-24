// src/notify.js
//
// Bildirim gonderici. Uc kanal, hepsi istege bagli (.env ile ayarlanir):
//   * Telegram:  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   * Termux:    NOTIFY_TERMUX=1   (pkg install termux-api + Termux:API uygulamasi gerekir)
//   * Nabiz:     HEALTHCHECK_URL   (ornegin healthchecks.io ping adresi). Bot her turda bu
//                adrese GET atar; ping KESILIRSE (telefon kapandi/bot coktu/internet gitti)
//                servis sana haber verir. Bot cokmus ya da telefon olmusse kendi kendine
//                bildirim GONDEREMEZ, bu yuzden bu kanal onemlidir.
//
// send() ASLA hata firlatmaz: bildirim yollanamadi diye bot durmamali.
//
// Oncelik (opts.priority):
//   'critical' -> sesli, kuyrukta one gecer, 429/ag hatasinda 4 kez dener, sessiz modda da sesli kalir
//   'normal'   -> sesli (varsayilan), 2 kez dener; sessiz modda sessiz iletilir
//   'quiet'    -> her zaman sessiz iletilir (disable_notification), 1 kez dener
//   durable:true (normal oncelikle birlikte) -> mesaj onemli ama sesi/sirasi normal kalir: 4 kez dener, hepsi
//                 basarisiz olursa kritik gibi bekleme listesine alinir (sessiz modda sessiz iletilir)
//
// KRITIK mesaj tum denemelerde gonderilemezse (internet yok) kaybolmaz: bellekte bekler
// (en fazla 20) ve baglanti gelince "⏱ Gecikmeli bildirim" onekiyle, olay zamaniyla gonderilir.
//
// Telegram tarafinda mesajlar sirayla ve en az minGapMs arayla gider (429 yememek icin);
// 4096 karakter sinirini asan mesajlar satir sinirindan bolunur. opts.html=true ise
// parse_mode=HTML kullanilir; Telegram etiketi reddederse etiketsiz duz metne dusulur.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { formatIstanbulTime } = require('./istanbulTime');

// Kuyruktaki Telegram mesajlari arasindaki en az bekleme (bir onceki mesajin BITISINDEN sayilir). Telegram bir sohbette
// saniyede ~1 mesaja izin verir; komut yanitlari (/durum vb.) kuyruk disindan ayni sohbete gider, bu yuzden 1 sn sinirda
// kalir. 5 sn guvenli tampon birakir; NOTIFY_MIN_GAP_MS ile degistirilebilir.
const DEFAULT_MIN_GAP_MS = 5000;
const TG_LIMIT = 4000; // Telegram siniri 4096; guvenlik payi birakilir
const MAX_QUEUE = 60;
const MAX_PENDING = 20; // gonderilemeyen kritik mesaj ust siniri (en eski duser)
const FLUSH_BACKOFF_MS = 15000; // ag yokken bekleyenleri her mesajdan once yeniden denememek icin

const stripTags = (s) => String(s)
  .replace(/<\/?(b|i|u|s|code|pre|strong|em|tg-spoiler)>/gi, '')
  .replace(/<a\s+href="[^"]*">/gi, '').replace(/<\/a>/gi, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// Uzun metni satir sinirindan boler. HTML kullanimi: etiketler tek satir icinde acilip kapanmali.
function splitMessage(text, limit = TG_LIMIT) {
  const src = String(text ?? '');
  if (src.length <= limit) return [src];
  const parts = [];
  let cur = '';
  const pushCur = () => { if (cur.length) { parts.push(cur); cur = ''; } };
  for (const line of src.split('\n')) {
    if (line.length > limit) {
      pushCur();
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > limit) { pushCur(); cur = line; } else cur = next;
  }
  pushCur();
  return parts;
}

function createNotifier({ env = process.env, fetchFn = globalThis.fetch, execFn = execFile, logger = console, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN || '';
  const chatId = env.TELEGRAM_CHAT_ID || '';
  // Token URL yolunda tasinir: ozel taban yalnizca acikca izin verilirse (yerel test) kullanilir.
  const tgBase = (env.TELEGRAM_API_BASE && env.ALLOW_LOCAL_EXCHANGE_URLS === '1' ? env.TELEGRAM_API_BASE : 'https://api.telegram.org').replace(/\/+$/, '');
  const termux = env.NOTIFY_TERMUX === '1' || env.NOTIFY_TERMUX === 'true';
  const healthUrl = env.HEALTHCHECK_URL || '';
  const minGapMs = Number.isFinite(Number(env.NOTIFY_MIN_GAP_MS)) && env.NOTIFY_MIN_GAP_MS !== undefined && env.NOTIFY_MIN_GAP_MS !== '' ? Math.max(0, Number(env.NOTIFY_MIN_GAP_MS)) : DEFAULT_MIN_GAP_MS;
  const retryBaseMs = Number.isFinite(Number(env.NOTIFY_RETRY_BASE_MS)) && env.NOTIFY_RETRY_BASE_MS !== undefined && env.NOTIFY_RETRY_BASE_MS !== '' ? Math.max(0, Number(env.NOTIFY_RETRY_BASE_MS)) : 1000;

  const lastByKey = new Map(); // key -> { t, ms }
  const warnedAt = new Map(); // kanal -> son uyari zamani
  const WARN_EVERY_MS = 10 * 60 * 1000;
  const health = { telegram: { failures: 0, lastOkAt: null, lastError: null }, termux: { failures: 0, lastOkAt: null, lastError: null } };
  let lastPing = 0;
  let mutedUntil = 0;
  let lastSendAt = 0;
  let pumping = false;
  const queue = [];
  let droppedWarned = false;
  // Kalici bekleyen bildirimler: yeniden baslatmada kaybolmamasi icin diske yazilir.
  const pendingDir = env.BOT_DATA_DIR || (env === process.env ? path.join(process.cwd(), 'data') : fs.mkdtempSync(path.join(os.tmpdir(), 'bot-notify-test-')));
  const pendingFile = path.join(pendingDir, 'notify-pending.json');
  let pending = [];
  try {
    if (!(token && chatId)) throw new Error('Telegram not configured');
    const saved = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    if (Array.isArray(saved)) pending = saved.filter((x) => x && typeof x.text === 'string')
      .map((x) => ({ text: x.text, html: x.html === true, silent: x.silent === true, at: Number.isFinite(Number(x.at)) ? Number(x.at) : now() }))
      .slice(-MAX_PENDING);
  } catch (_) { /* dosya yok/bozuksa yeni kuyrukla basla; bildirim gonderimi botu durdurmamali */ }
  function persistPending() {
    try {
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      const tmp = `${pendingFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(pending), { mode: 0o600 });
      fs.renameSync(tmp, pendingFile);
    } catch (e) {
      logger.warn(`[bildirim] bekleyen kuyruk diske yazilamadi: ${scrub(e && e.message ? e.message : e)}`);
    }
  }
  let flushing = false;
  let lastFlushFailAt = 0;

  const status = () => ({
    telegram: !!(token && chatId), termux, healthcheck: !!healthUrl
  });
  // Ayrintili durum (panel/komutlar icin); status() eski sozlesmeyi aynen korur.
  const detail = () => ({
    ...status(),
    muted: isMuted(),
    mutedUntil: isMuted() ? mutedUntil : null,
    queued: queue.length,
    pending: pending.length,
    channels: {
      telegram: { ...health.telegram },
      termux: { ...health.termux }
    }
  });

  // Hata mesajlarinda token sizmasin.
  const scrub = (msg) => (token ? String(msg).split(token).join('***') : String(msg));
  // Ayni kanal icin uyari 10 dakikada en fazla bir kez; kanal duzelince "geri geldi" bilgisi verilir.
  const warnChannel = (channel, err) => {
    const t = now();
    const last = warnedAt.get(channel);
    if (last !== undefined && t - last < WARN_EVERY_MS) return;
    warnedAt.set(channel, t);
    logger.warn(`[bildirim] ${channel} gonderilemedi: ${scrub(err && err.message ? err.message : err)} (bu uyari ${Math.round(WARN_EVERY_MS / 60000)} dakikada en fazla bir kez gosterilir)`);
  };
  const markOk = (channel) => {
    const h = health[channel];
    if (!h) return;
    if (h.failures > 0 && typeof logger.log === 'function') logger.log(`[bildirim] ${channel} yeniden calisiyor (${h.failures} basarisiz denemeden sonra).`);
    h.failures = 0; h.lastOkAt = now(); h.lastError = null;
    warnedAt.delete(channel);
  };
  const markFail = (channel, err) => {
    const h = health[channel];
    if (!h) return;
    h.failures += 1;
    // Telegram yanit aciklamasi (ornegin chat not found / parse error) olay kaydinda
    // HTTP koduyla birlikte tutulur; token her durumda scrub edilir.
    const detail = err && err.description ? ` — ${String(err.description)}` : '';
    h.lastError = scrub(`${err && err.message ? err.message : err}${detail}`).slice(0, 240);
  };

  function isMuted() { return mutedUntil > now(); }
  function mute(ms) {
    const n = Number(ms);
    mutedUntil = Number.isFinite(n) && n > 0 ? now() + n : 0;
    return mutedUntil;
  }
  function unmute() { mutedUntil = 0; }

  async function timedFetch(url, opts, ms = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetchFn(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Tek bir Telegram sendMessage istegi. Hata nesnesi: { status, retryAfterMs, description, permanent }
  async function tgRequest(body) {
    const res = await timedFetch(`${tgBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) return;
    let info = null;
    try { info = typeof res.json === 'function' ? await res.json() : null; } catch (_) { info = null; }
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.description = info && info.description ? String(info.description) : '';
    const ra = info && info.parameters && Number(info.parameters.retry_after);
    err.retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 0;
    // 400/401/403/404: istek ya da yetki sorunu; tekrar denemek bir sey degistirmez.
    err.permanent = [400, 401, 403, 404].includes(res.status);
    throw err;
  }

  // Bir parcayi gonderir: oncelige gore yeniden dener; HTML etiketi reddedilirse duz metne duser.
  async function sendTelegramPart(text, { html, silent, attempts }) {
    let useHtml = Boolean(html);
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      const body = { chat_id: chatId, text: useHtml ? text : (html ? stripTags(text) : text) };
      if (useHtml) body.parse_mode = 'HTML';
      if (silent) body.disable_notification = true;
      try {
        await tgRequest(body);
        return;
      } catch (e) {
        lastErr = e;
        if (useHtml && e.status === 400 && /parse|entit|tag/i.test(e.description || '')) { useHtml = false; i -= 1; continue; }
        if (e.permanent) throw e;
        if (i < attempts - 1) await sleep(e.retryAfterMs || retryBaseMs * (2 ** i));
      }
    }
    throw lastErr || new Error('gonderilemedi');
  }

  async function sendTelegram(text, { html, silent, attempts }) {
    const parts = splitMessage(text);
    const withPrefix = (i) => `${parts.length > 1 ? `(${i + 1}/${parts.length}) ` : ''}${parts[i]}`;
    for (let i = 0; i < parts.length; i++) {
      try {
        await sendTelegramPart(withPrefix(i), { html, silent, attempts });
      } catch (e) {
        // Gitmeyen parcalar (bu ve sonrakiler) bekletilebilsin; giden parcalar tekrarlanmaz.
        e.unsent = parts.slice(i).map((_, k) => withPrefix(i + k));
        throw e;
      }
    }
  }

  function queuePending(text, html, silent = false) {
    pending.push({ text, html: Boolean(html), silent: Boolean(silent), at: now() });
    if (pending.length > MAX_PENDING) pending = pending.slice(pending.length - MAX_PENDING);
    persistPending();
  }

  // Bekleyen kritik mesajlari sirayla, parca basina tek denemeyle gonderir; ilk basarisizlikta durur.
  // Kalici hata (yanlis token/chat vb.) mesaji bir daha asla gonderilemez; kuyruktan atilir.
  async function flushPending({ inPump = false } = {}) {
    if (flushing || !pending.length || !(token && chatId)) return 0;
    if (pumping && !inPump) return 0; // sirada giden mesajla yarismasin; sonraki turda denenir
    flushing = true;
    let sent = 0;
    try {
      while (pending.length) {
        const item = pending[0];
        const text = `⏱ Gecikmeli bildirim (olay: ${formatIstanbulTime(item.at)})\n${item.text}`;
        try {
          await sendTelegramPart(text, { html: item.html, silent: item.silent === true, attempts: 1 });
        } catch (e) {
          if (e && e.permanent) { pending.shift(); persistPending(); warnChannel('telegram', e); continue; }
          lastFlushFailAt = now();
          break;
        }
        pending.shift();
        persistPending(); // Diskteki kuyruk, her basarili teslimden hemen sonra da guncellenmeli.
        sent += 1;
      }
      if (!pending.length) lastFlushFailAt = 0;
    } finally {
      flushing = false;
    }
    return sent;
  }

  function sendTermux(title, text) {
    return new Promise((resolve, reject) => {
      execFn('termux-notification', ['--title', title, '--content', text], { timeout: 8000 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function deliver(job) {
    const st = status();
    const result = {};
    const plain = job.html ? stripTags(job.text) : job.text;
    const prio = job.priority;
    const silent = prio === 'quiet' || (prio !== 'critical' && isMuted());
    const keep = prio === 'critical' || (prio === 'normal' && job.durable === true); // basarisizsa bekleme listesine alinir
    const attempts = keep ? 4 : prio === 'quiet' ? 1 : 2;
    if (st.telegram) {
      // Eski (bekleyen) kritik mesajlar yeni mesajdan once gider; ag yokken son basarisiz denemeden 15 sn gecmeden tekrar denenmez.
      if (pending.length && now() - lastFlushFailAt >= FLUSH_BACKOFF_MS) await flushPending({ inPump: true }).catch(() => 0);
      result.telegram = await sendTelegram(job.text, { html: job.html, silent, attempts })
        .then(() => { markOk('telegram'); return true; }, (e) => {
          markFail('telegram', e); warnChannel('telegram', e);
          if (keep && !(e && e.permanent) && e && Array.isArray(e.unsent)) for (const part of e.unsent) queuePending(part, job.html, silent);
          return false;
        });
    }
    if (st.termux) {
      result.termux = await sendTermux(job.title, plain)
        .then(() => { markOk('termux'); return true; }, (e) => { markFail('termux', e); warnChannel('termux', e); return false; });
    }
    return result;
  }

  // Sirali isleyici: mesajlar sirayla gider; kritikler kuyrugun onune gecer.
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        const gap = minGapMs - (now() - lastSendAt);
        if (gap > 0 && lastSendAt > 0 && status().telegram) await sleep(gap);
        let result = {};
        try { result = await deliver(job); } catch (e) { warnChannel('genel', e); }
        lastSendAt = now();
        job.resolve(result);
      }
    } finally {
      pumping = false;
      if (queue.length) pump().catch(() => {});
    }
  }

  function enqueue(job) {
    return new Promise((resolve) => {
      job.resolve = resolve;
      if (job.priority === 'critical') {
        let idx = 0;
        while (idx < queue.length && queue[idx].priority === 'critical') idx += 1;
        queue.splice(idx, 0, job);
      } else {
        if (queue.length >= MAX_QUEUE) {
          // Sismis kuyrukta en eski sessiz/normal mesaj atilir; kritikler asla atilmaz.
          const dropAt = queue.findIndex((j) => j.priority !== 'critical');
          if (dropAt >= 0) {
            const [dropped] = queue.splice(dropAt, 1);
            dropped.resolve({ dropped: true });
            if (!droppedWarned) { droppedWarned = true; logger.warn('[bildirim] kuyruk doldu; en eski rutin mesajlar atildi (kritik mesajlar korunur).'); }
          }
        }
        queue.push(job);
      }
      pump().catch(() => resolve({}));
    });
  }

  function pruneKeys(t) {
    if (lastByKey.size < 200) return;
    for (const [k, v] of lastByKey) if (t - v.t > Math.max(v.ms, 60 * 60 * 1000)) lastByKey.delete(k);
  }

  // key + minIntervalMs: ayni tur olayin (ornegin "veri kesildi") sik sik tekrarlanmasini onler.
  async function send(text, { key, minIntervalMs = 0, title = 'AL-SAT', priority = 'normal', html = false, durable = false } = {}) {
    try {
      if (key && minIntervalMs > 0) {
        const last = lastByKey.get(key);
        const t = now();
        if (last !== undefined && t - last.t < minIntervalMs) return { skipped: true };
        lastByKey.set(key, { t, ms: minIntervalMs });
        pruneKeys(t);
      }
      const prio = ['critical', 'normal', 'quiet'].includes(priority) ? priority : 'normal';
      const st = status();
      if (!st.telegram && !st.termux) return {};
      return await enqueue({ text: String(text), title, priority: prio, html: Boolean(html), durable: Boolean(durable) });
    } catch (e) {
      warnChannel('genel', e);
      return {};
    }
  }

  // Nabiz: en fazla 30 saniyede bir.
  async function ping() {
    if (!healthUrl) return false;
    const t = now();
    if (t - lastPing < 30000) return false;
    lastPing = t;
    try {
      const res = await timedFetch(healthUrl, { method: 'GET' }, 8000);
      return res.ok;
    } catch (e) {
      warnChannel('nabiz', e);
      return false;
    }
  }

  return { send, ping, status, detail, mute, unmute, isMuted: () => isMuted(), flushPending, pendingCount: () => pending.length };
}

module.exports = { createNotifier, splitMessage, stripTags };
