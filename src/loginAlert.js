'use strict';
// src/loginAlert.js
//
// Panele hatali sifre girisi olunca Telegram'a uyari. Spam olmasin diye en fazla 10 dakikada
// bir mesaj gider; mesajda son 10 dakikadaki toplam hatali deneme sayisi yazar.
// send() hata firlatmaz (bildirim yollanamadi diye giris akisi bozulmamali).

const WINDOW_MS = 10 * 60 * 1000;

function createLoginAlert({ notifier, now = () => Date.now() } = {}) {
  const times = [];
  return function notifyLoginFailure() {
    const t = now();
    times.push(t);
    while (times.length && t - times[0] > WINDOW_MS) times.shift();
    if (!notifier || typeof notifier.send !== 'function') return Promise.resolve({});
    return Promise.resolve(notifier.send(
      `🔐 Panele hatalı şifre denemesi (son 10 dk: ${times.length}). Sen değilsen şifreyi değiştir: npm run setup`,
      { key: 'login-fail', minIntervalMs: WINDOW_MS, priority: 'normal' }
    )).catch(() => ({}));
  };
}

module.exports = { createLoginAlert, WINDOW_MS };
