// src/util/retry.js
// Mobil veri / Wi-Fi geciscisinde ag istekleri ara sira zaman asimina ugrar
// ya da gecici 5xx doner. Bu sarmalayici olmadan tek bir basarisiz istek
// tum tick() turunu Promise reddiyle kesebilirdi (paperEngine zaten sembol
// basina try/catch yapiyor ama gereksiz yere "hata" olarak loglanip alim/satim
// firsati kacar). Burada kisa bir yeniden deneme ile gecici sorunlar sessizce
// asilir.

const { applyNetworkDefaults, explainNetworkError } = require('./network');
applyNetworkDefaults();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Yanit govdesi ust siniri: ele gecirilmis/hatali bir uc nokta GB'larca veri akitip sureci bellek yetersizliginden
// dusuremesin (acik canli pozisyon varken bu, koruyucu stop izlemesini de keserdi). Varsayilan 50 MB; ihtiyac halinde
// HTTP_MAX_BODY_BYTES ortam degiskeni veya cagri basina { maxBytes } ile degistirilir.
const DEFAULT_MAX_BODY_BYTES = (() => {
  const n = Number(process.env.HTTP_MAX_BODY_BYTES);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 50 * 1024 * 1024;
})();

function tooLarge(limit, mutating) {
  const err = new Error(`HTTP yanıt gövdesi sınırı aşıldı (${limit} bayt); istek iptal edildi.`);
  err.code = 'RESPONSE_TOO_LARGE';
  // Emir gonderme/iptal (POST/PUT/DELETE) istegi borsaya ulasmis olabilir: sonuc BELIRSIZDIR, otomatik tekrar yok.
  if (mutating) err.unknownOutcome = true;
  return err;
}

async function readBodyCapped(res, limit, mutating) {
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    try { await res.body?.cancel?.(); } catch (_) { /* yoksay */ }
    throw tooLarge(limit, mutating);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw tooLarge(limit, mutating);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch (_) { /* yoksay */ }
      throw tooLarge(limit, mutating);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithRetry(url, opts = {}, { retries = 2, timeoutMs = 10000, backoffMs = 800, maxBytes = DEFAULT_MAX_BODY_BYTES, retry429 = true } = {}) {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String((opts && opts.method) || 'GET').toUpperCase());
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Never follow redirects: signed headers/query strings must stay on the validated endpoint.
      // This also avoids replaying a mutating order via a 307/308 redirect.
      let res = await fetch(url, { ...opts, redirect: 'error', signal: controller.signal });
      // Zaman aşımı sayacı YALNIZCA başlıklar gelince değil, GÖVDE de okunana kadar açık kalmalı. Eskiden başlıktan
      // hemen sonra durduruluyordu: sunucu başlığı gönderip gövdeyi yarıda bırakırsa çağıranın res.json()'ı sonsuza
      // dek asılı kalıyor, canlı motor turu (stop yeniden kurma, risk kapısı) ve emir sonucu bekleyen çağrı kilitleniyordu.
      // Gövde burada, süre sınırı altında tamponlanır; çağıran aynı arayüzle (json/text/status/headers) devam eder.
      if (typeof Response !== 'undefined' && res instanceof Response && ![101, 204, 205, 304].includes(res.status)) {
        const buf = await readBodyCapped(res, maxBytes, mutating);
        res = new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      clearTimeout(timer);
      // 418 = IP yasaklandi: istek gondermeye devam etmek yasagi UZATIR; tekrar denenmez, hata olarak yukari verilir.
      if (((res.status === 429 && retry429) || res.status >= 500) && attempt < retries) {
        const retryAfterRaw = res.headers?.get?.('retry-after');
        const retryAfter = Number(retryAfterRaw);
        const serverDelay = Number.isFinite(retryAfter) && retryAfter >= 0
          ? (retryAfter < 1000 ? retryAfter * 1000 : retryAfter)
          : 0;
        const jitter = Math.floor(Math.random() * Math.max(25, backoffMs * 0.25));
        const delay = Math.min(30000, Math.max(backoffMs * (attempt + 1), serverDelay) + jitter);
        lastErr = new Error(`HTTP ${res.status}`);
        lastErr.httpStatus = res.status;
        lastErr.retryAfterMs = delay;
        await sleep(delay);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      // Gövde sınırı aşımı tekrar denemeyle düzelmez ve tekrar denemek yükü katlar: hemen yukarı ver.
      if (e && e.code === 'RESPONSE_TOO_LARGE') throw e;
      if (e.name === 'AbortError') {
        lastErr = new Error(`zaman aşımı (${timeoutMs}ms) — ${explainNetworkError('zaman aşımı')}`);
      } else {
        // Node'un fetch'i (undici) ag hatalarinda genelde sadece "fetch failed"
        // mesaji verir, gercek sebep (DNS bulunamadi, sertifika hatasi, baglanti
        // reddedildi...) e.cause icinde saklidir. Log'da sadece e.message
        // okunacagi icin (paperEngine.js) gercek sebebi buraya, mesajin icine
        // gomuyoruz -- yoksa "fetch failed" yazip gercek nedeni gizliyordu.
        const cause = e.cause;
        const causeMsg = cause ? cause.code || cause.message || String(cause) : null;
        const hint = explainNetworkError(causeMsg || e.message);
        lastErr = causeMsg ? new Error(`${e.message} (${causeMsg})${hint ? ' — ' + hint : ''}`) : e;
      }
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr;
}

module.exports = { fetchWithRetry, sleep, DEFAULT_MAX_BODY_BYTES };
