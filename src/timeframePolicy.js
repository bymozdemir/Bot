// Mum aralığı seçim tablosu (tek gerçek kaynak: sunucu doğrulaması, canlı motor ve panel bunu kullanır).
//
//   aralık | Agresif | Normal | Canlı | Azami kontrol aralığı
//   1m 3m 5m  : evet  | hayır  | hayır | sinyal tazeliğinden türetilir (aşağıya bak)
//   15m 30m   : evet  | evet   | evet  | sınır yok
//   1h 4h     : evet  | evet   | evet  | sınır yok
//
// "Normal" listesinde 15m, eski kurulumlar bozulmasın diye korunur. Kısa aralıklar (<15m) YALNIZCA agresif stratejide,
// yalnızca paper modda ve hızlı kontrol aralığıyla çalışır:
//  * Sinyal tazeliği: mum kapanışından en fazla max(60 sn, mum/2) sonra alım uygulanır (paperEngine/liveEngine maxAgeMs).
//    Kontrol aralığı bunun ~1/3'ünü aşarsa alım sinyallerinin çoğu "eski" sayılıp atlanır.
//  * Komisyon+kayma gidiş-dönüş ~%0.3'tür; kısa mumlarda hareketler bunu kolay yutar.
//  * Kısa mumlarda canlı stop yenileme/emir trafiği borsada doğrulanmadı.
const AGGRESSIVE_STRATEGY = 'aggressive_breakout';
const MIN_MS = 60000;
const TABLE = {
  '1m':  { label: '1 dk',   ms: 1 * MIN_MS,   aggressive: true, normal: false, live: false },
  '3m':  { label: '3 dk',   ms: 3 * MIN_MS,   aggressive: true, normal: false, live: false },
  '5m':  { label: '5 dk',   ms: 5 * MIN_MS,   aggressive: true, normal: false, live: false },
  '15m': { label: '15 dk',  ms: 15 * MIN_MS,  aggressive: true, normal: true,  live: true },
  '30m': { label: '30 dk',  ms: 30 * MIN_MS,  aggressive: true, normal: true,  live: true },
  '1h':  { label: '1 saat', ms: 60 * MIN_MS,  aggressive: true, normal: true,  live: true },
  '4h':  { label: '4 saat', ms: 240 * MIN_MS, aggressive: true, normal: true,  live: true }
};
const ALL_TIMEFRAMES = Object.keys(TABLE);
// Borsa adaptörlerinin desteklemediği aralıklar (kod: btcturk.js / paribu.js çözünürlük tabloları).
const EXCHANGE_UNSUPPORTED = { btcturk: ['3m'], paribu: ['3m'] };

const isAggressive = (strategyId) => strategyId === AGGRESSIVE_STRATEGY;
const isFast = (tf) => Boolean(TABLE[tf]) && TABLE[tf].ms < 15 * MIN_MS;

// Kısa mumda alım sinyalinin taze sayılması için azami kontrol aralığı (sn): max(60 sn, mum/2) / 3.
function maxPollSeconds(tf) {
  if (!isFast(tf)) return null;
  return Math.floor(Math.max(60000, TABLE[tf].ms / 2) / 3 / 1000);
}

// Hata metni ya da null. exchangeId verilmezse borsa kontrolü yapılmaz.
function timeframeProblem({ timeframe, strategyId, pollSeconds, mode, exchangeId } = {}) {
  const row = TABLE[timeframe];
  if (!row) return `Mum aralığı şunlardan biri olmalı: ${ALL_TIMEFRAMES.join(', ')}`;
  if (exchangeId && (EXCHANGE_UNSUPPORTED[exchangeId] || []).includes(timeframe)) return `${row.label} mum aralığı ${exchangeId} borsasında desteklenmiyor.`;
  if (isAggressive(strategyId) ? !row.aggressive : !row.normal) return `${row.label} mum aralığı yalnızca Agresif Kırılım stratejisi için seçilebilir.`;
  if (mode === 'live' && !row.live) return `${row.label} mum aralığı canlı modda henüz desteklenmiyor (yalnızca paper).`;
  const maxPoll = maxPollSeconds(timeframe);
  if (maxPoll !== null && !(Number(pollSeconds) <= maxPoll)) return `${row.label} mum için kontrol sıklığı en fazla ${maxPoll} sn olmalı (şu an ${pollSeconds} sn); aksi halde sinyaller eski sayılıp atlanır.`;
  return null;
}

// Paneldeki seçim tablosu için.
function describe() {
  return ALL_TIMEFRAMES.map((tf) => ({ id: tf, ...TABLE[tf], maxPollSeconds: maxPollSeconds(tf), unsupportedOn: Object.keys(EXCHANGE_UNSUPPORTED).filter((x) => EXCHANGE_UNSUPPORTED[x].includes(tf)) }));
}

module.exports = { AGGRESSIVE_STRATEGY, TABLE, ALL_TIMEFRAMES, EXCHANGE_UNSUPPORTED, isAggressive, isFast, maxPollSeconds, timeframeProblem, describe };
