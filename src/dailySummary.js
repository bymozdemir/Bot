'use strict';
// src/dailySummary.js
//
// Gunluk Telegram ozeti. Istanbul saatiyle her gun bir kez (varsayilan 23:55) gonderilir:
// gunun K/Z'si, kapanan islem, ozkaynak, acik pozisyonlar, bot yasiyor mu, log hata sayisi.
//   DAILY_SUMMARY=0          -> kapatir
//   DAILY_SUMMARY_TIME=21:30 -> saat (Istanbul, HH:MM)
// "Hangi gun gonderildi" bilgisi state.notifyMeta.lastDailySummaryDay icinde saklanir: yeniden
// baslatma ayni gun ikinci ozet uretmez; hedef saatten sonra acilan bot o gunun ozetini yine de yollar.

const { istanbulDayKey, istanbulMinuteOfDay } = require('./istanbulTime');
const fmt = require('./notifyFormat');

function parseTime(v, fallback = 23 * 60 + 55) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]); const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? h * 60 + min : fallback;
}

function createDailySummary({ getData, notifier, state, store, env = process.env, nowFn = () => Date.now(), logger = console, intervalMs = 30000 } = {}) {
  const disabled = ['0', 'false', 'off', 'hayir', 'hayır'].includes(String(env.DAILY_SUMMARY || '').toLowerCase());
  const targetMinute = parseTime(env.DAILY_SUMMARY_TIME);
  const MAX_FAILS_PER_DAY = 4;
  let timer = null;
  let failDay = null;
  let fails = 0;

  const meta = () => {
    if (!state.notifyMeta || typeof state.notifyMeta !== 'object') state.notifyMeta = {};
    return state.notifyMeta;
  };

  function text(nowMs = nowFn()) {
    return fmt.dailySummary(getData(nowMs));
  }

  async function tick() {
    if (disabled || !notifier) return false;
    const now = nowFn();
    const dayKey = istanbulDayKey(now);
    const minute = istanbulMinuteOfDay(now);
    if (!dayKey || minute === null || minute < targetMinute) return false;
    if (meta().lastDailySummaryDay === dayKey) return false;
    if (failDay !== dayKey) { failDay = dayKey; fails = 0; }
    if (fails >= MAX_FAILS_PER_DAY) return false;
    let body;
    try { body = text(now); } catch (e) { fails += 1; logger.warn(`[gunluk-ozet] olusturulamadi: ${e.message}`); return false; }
    const st = notifier.status ? notifier.status() : { telegram: true };
    const result = await notifier.send(body, { priority: 'quiet', html: true, title: 'AL-SAT günlük özet' });
    // Hic kanal kurulu degilse (st) ya da en az bir kanal basarili ise gun tamamlandi sayilir.
    const anyConfigured = st.telegram || st.termux;
    const delivered = !anyConfigured || result.skipped === true || Object.values(result).some((v) => v === true);
    if (delivered) {
      meta().lastDailySummaryDay = dayKey;
      try { if (store && typeof store.save === 'function') store.save(state); } catch (e) { logger.warn(`[gunluk-ozet] durum kaydedilemedi: ${e.message}`); }
      return true;
    }
    fails += 1;
    return false;
  }

  function start() {
    if (disabled || timer) return false;
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
    return true;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, tick, text, isEnabled: () => !disabled, targetMinute };
}

module.exports = { createDailySummary, parseTime };
