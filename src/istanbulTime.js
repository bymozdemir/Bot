'use strict';

// Human-facing timestamps only. Keep persisted timestamps and engine calculations in UTC.
function formatIstanbulTime(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'bilinmiyor';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(date);
}

function withIstanbulTime(message, value = Date.now()) {
  return `${message}\n🕒 İstanbul: ${formatIstanbulTime(value)}`;
}

// Istanbul takvim gunu anahtari (YYYY-MM-DD) ve gun icindeki dakika (0-1439). Gunluk ozet zamanlamasi icin.
function istanbulDayKey(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function istanbulMinuteOfDay(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((x) => x.type === 'hour')?.value);
  const m = Number(parts.find((x) => x.type === 'minute')?.value);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

module.exports = { formatIstanbulTime, withIstanbulTime, istanbulDayKey, istanbulMinuteOfDay };
