'use strict';
// src/notifyFormat.js
//
// Telegram/Termux bildirim metinleri. Hepsi parse_mode=HTML uyumludur:
//  - Dinamik her deger esc() ile kacirilir (hata mesajlari, sembol, sebep vb. '<' '&' icerebilir).
//  - Etiketler (<b>, <code>) yalnizca TEK satir icinde acilip kapanir; boylece uzun mesaj
//    satir sinirindan bolunse bile etiket yarim kalmaz.
// Burada hesaplama yapilmaz; yalnizca gosterim vardir.

const { formatPrice, formatQuantity, formatMoney } = require('./numberFormat');
const { formatIstanbulTime } = require('./istanbulTime');

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b = (v) => `<b>${esc(v)}</b>`;
const code = (v) => `<code>${esc(v)}</code>`;

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function signed(v, digits = 2) {
  const n = num(v);
  if (n === null) return '?';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}
function pct(v, digits = 2) {
  const n = num(v);
  return n === null ? '?' : `${signed(n, digits)}%`;
}
function price(v) { return num(v) === null ? '?' : formatPrice(v); }
function qty(v) { return num(v) === null ? '?' : formatQuantity(v); }
function money(v) { return num(v) === null ? '?' : formatMoney(v); }
function moneyShort(v) {
  const n = num(v);
  if (n === null) return '?';
  const a = Math.abs(n);
  return n.toFixed(a >= 100 ? 2 : a >= 1 ? 3 : 6).replace(/\.?0+$/, '') || '0';
}

function duration(fromIso, toMs) {
  const from = Date.parse(fromIso);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const mins = Math.floor((to - from) / 60000);
  if (mins < 1) return '1 dk\'dan kısa';
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const out = [];
  if (d) out.push(`${d}g`);
  if (h) out.push(`${h}s`);
  if (m && !d) out.push(`${m}dk`);
  return out.join(' ') || `${mins}dk`;
}

const stamp = (ms) => `🕒 İstanbul: ${formatIstanbulTime(ms)}`;
const baseOf = (symbol) => String(symbol || '').split('/')[0].toUpperCase();
const quoteOf = (symbol, fallback = '') => String(String(symbol || '').split('/')[1] || fallback).toUpperCase();

// ---- Canli alim / satim / koruyucu emir ----

function liveBuy({ symbol, avgPrice, quantity, quoteSpent, stopPrice, stopFailed, recovered, takeProfitPct, trailing, reason, at }) {
  const quote = quoteOf(symbol);
  const lines = [`🟢 ${b(`CANLI ALIM ${symbol}`)}${recovered ? ' — GEÇ DOLUM / KURTARMA' : ''}`];
  lines.push(`Fiyat: ${code(price(avgPrice))} | Miktar: ${code(qty(quantity))} ${esc(baseOf(symbol))}`);
  if (num(quoteSpent) !== null) lines.push(`Harcanan: ${code(money(quoteSpent))} ${esc(quote)}`);
  const sp = num(stopPrice); const ap = num(avgPrice);
  if (stopFailed) {
    lines.push('Koruyucu stop: ⚠ KURULAMADI — pozisyon KORUMASIZ olabilir (ayrı uyarıya bakın)');
  } else if (sp !== null && sp > 0) {
    const dist = ap && ap > 0 ? ` (${pct((sp / ap - 1) * 100, 2)})` : '';
    lines.push(`Koruyucu stop: ${code(price(sp))}${esc(dist)}${trailing ? ' | trailing AÇIK' : ''}`);
  } else {
    lines.push('Koruyucu stop: ⚠ fiyat belirlenemedi');
  }
  if (num(takeProfitPct) > 0) lines.push(`Kâr koruma eşiği: %${esc(num(takeProfitPct))}`);
  if (reason) lines.push(`Sebep: ${esc(String(reason).slice(0, 300))}`);
  lines.push(stamp(at));
  return lines.join('\n');
}

// kind: 'SATIM' | 'KISMİ SATIM'
function liveSell({ symbol, kind = 'SATIM', entryPrice, exitPrice, quantity, pnl, pnlPct, reason, openedAt, closedAtMs, remainingQty, emergency }) {
  const quote = quoteOf(symbol);
  const n = num(pnl);
  const icon = n !== null && n < 0 ? '🔴' : '🟢';
  const lines = [`${icon} ${b(`CANLI ${kind} ${symbol}`)}${emergency ? ' — ACİL ÇIKIŞ' : ''}`];
  lines.push(`Giriş: ${code(price(entryPrice))} → Çıkış: ${code(price(exitPrice))} | Miktar: ${code(qty(quantity))} ${esc(baseOf(symbol))}`);
  lines.push(`K/Z: ${b(`${signed(pnl)} ${quote}`)} (${esc(pct(pnlPct))})`);
  const dur = duration(openedAt, closedAtMs);
  if (dur) lines.push(`Pozisyon süresi: ${esc(dur)}`);
  if (num(remainingQty) > 0) lines.push(`Kalan pozisyon: ${code(qty(remainingQty))} ${esc(baseOf(symbol))} (koruyucu stop yeniden kuruluyor)`);
  if (reason) lines.push(`Sebep: ${esc(String(reason).slice(0, 300))}`);
  lines.push(stamp(closedAtMs));
  return lines.join('\n');
}

// Borsa tarafindaki koruyucu stop-loss / take-profit emri doldu.
function protectiveFill({ symbol, isTp, partial, entryPrice, exitPrice, quantity, pnl, pnlPct, stopPrice, openedAt, closedAtMs, remainingQty }) {
  const quote = quoteOf(symbol);
  const n = num(pnl);
  const title = isTp ? '🎯 TAKE-PROFIT GERÇEKLEŞTİ' : '🛑 STOP-LOSS TETİKLENDİ';
  const lines = [`${b(`${title} ${symbol}`)}${partial ? ' (kısmi dolum)' : ''}`];
  lines.push(`Giriş: ${code(price(entryPrice))} → Çıkış: ${code(price(exitPrice))} | Miktar: ${code(qty(quantity))} ${esc(baseOf(symbol))}`);
  lines.push(`K/Z: ${b(`${signed(pnl)} ${quote}`)} (${esc(pct(pnlPct))}) ${n !== null && n < 0 ? '🔴' : '🟢'}`);
  if (!isTp && num(stopPrice) > 0) lines.push(`Stop seviyesi: ${code(price(stopPrice))}`);
  const dur = duration(openedAt, closedAtMs);
  if (dur) lines.push(`Pozisyon süresi: ${esc(dur)}`);
  if (num(remainingQty) > 0) lines.push(`Kalan pozisyon: ${code(qty(remainingQty))} ${esc(baseOf(symbol))}`);
  else lines.push('Pozisyon kapandı.');
  lines.push(stamp(closedAtMs));
  return lines.join('\n');
}

// ---- Risk / kilit ----

// kind: 'total' | 'daily' | 'config'
function liveKillSwitch({ kind, reason, equity, startEquity, dayStartEquity, quote, symbols = [], at }) {
  const title = kind === 'daily' ? 'CANLI GÜNLÜK ZARAR LİMİTİ AŞILDI' : kind === 'config' ? 'CANLI RİSK AYARI GEÇERSİZ' : 'CANLI KILL SWITCH (toplam zarar)';
  const lines = [`🛑 ${b(title)}`, `Sebep: ${esc(reason)}`];
  if (num(equity) !== null) {
    const base = kind === 'daily' ? dayStartEquity : startEquity;
    const label = kind === 'daily' ? 'gün başı' : 'başlangıç';
    lines.push(`Özkaynak: ${code(moneyShort(equity))} ${esc(quote || '')}${num(base) > 0 ? ` (${label}: ${esc(moneyShort(base))})` : ''}`);
  }
  lines.push(symbols.length
    ? `Kapatılacak pozisyon: ${esc(symbols.length)} (${esc(symbols.join(', '))})`
    : 'Açık pozisyon yok.');
  lines.push('Yeni emirler durdu; bot kilitlendi (panelden kill switch\'i onaylayana kadar açılmaz).');
  lines.push(stamp(at));
  return lines.join('\n');
}

function liveKillSwitchResult({ closed = [], remaining = [], failed = [], at }) {
  const lines = [`🛑 ${b('Kill switch sonucu')}: ${esc(closed.length)} pozisyon kapatıldı, ${esc(remaining.length)} açık kaldı.`];
  if (remaining.length) {
    lines.push(`Açık kalan: ${esc(remaining.join(', '))}`);
    lines.push('⚠ Borsadaki koruyucu stop emirlerinin yerinde olduğunu kontrol et.');
  }
  if (failed.length) lines.push(`Kapatılamayan: ${esc(failed.map((f) => `${f.symbol} (${String(f.error).slice(0, 80)})`).join('; '))}`);
  lines.push(stamp(at));
  return lines.join('\n');
}

function lockMessage({ reason, symbols = [], at }) {
  const lines = [`🔒 ${b('CANLI İŞLEM KİLİTLENDİ')}`, `Sebep: ${esc(reason || 'belirtilmedi (log\'a bak)')}`];
  lines.push('Yeni emirler durdu.');
  if (symbols.length) lines.push(`Açık pozisyon: ${esc(symbols.join(', '))} — borsadaki stop emirlerinin yerinde olduğunu kontrol et.`);
  lines.push(stamp(at));
  return lines.join('\n');
}

function unlockMessage({ lockedForMs, at }) {
  const mins = Number.isFinite(Number(lockedForMs)) ? Math.max(0, Math.round(lockedForMs / 60000)) : null;
  return [`🔓 ${b('Canlı işlem kilidi kalktı')} — yeni emirlere yeniden izin var.`, ...(mins !== null ? [`Kilit süresi: ~${mins} dk`] : []), stamp(at)].join('\n');
}

// ---- Paper (mevcut metinleri korur, okunurlugu artirir) ----

function paperBuy({ symbol, fill, quantity, cost, remainingCash, fee, reason, at }) {
  const quote = quoteOf(symbol);
  const lines = [`🟢 ${b(`ALIM ${symbol}`)} @ ${code(price(fill))}`];
  lines.push(`Miktar: ${code(qty(quantity))} ${esc(baseOf(symbol))} | Harcanan: ${code(money(cost))} ${esc(quote)}`);
  lines.push(`Kalan: ${code(money(remainingCash))} ${esc(quote)} | Komisyon: ${code(money(fee))} ${esc(quote)}`);
  if (reason) lines.push(`Sebep: ${esc(String(reason).slice(0, 300))}`);
  lines.push(stamp(at));
  return lines.join('\n');
}

function paperSell({ symbol, fill, reason, pnl, pnlPct, entryPrice, openedAt, at }) {
  const quote = quoteOf(symbol);
  const n = num(pnl);
  const lines = [`${n !== null && n < 0 ? '🔴' : '🟢'} ${b(`SATIM ${symbol}`)} @ ${code(price(fill))}`];
  if (num(entryPrice) > 0) lines.push(`Giriş: ${code(price(entryPrice))} → Çıkış: ${code(price(fill))}`);
  lines.push(`K/Z: ${b(`${signed(pnl)} ${quote}`)} (${esc(pct(pnlPct))})`);
  const dur = duration(openedAt, at);
  if (dur) lines.push(`Pozisyon süresi: ${esc(dur)}`);
  if (reason) lines.push(`Sebep: ${esc(String(reason).slice(0, 300))}`);
  lines.push(stamp(at));
  return lines.join('\n');
}

// ---- Yasam dongusu ----

function engineStopped({ mode, reason, openPositions = [], at }) {
  const live = String(mode || 'paper').toLowerCase() === 'live';
  const lines = [`⏹ ${b(live ? 'Canlı bot durduruldu' : 'Bot durduruldu')}`, `Sebep: ${esc(String(reason || 'belirtilmedi').slice(0, 300))}`];
  if (openPositions.length) {
    lines.push(`Açık pozisyon: ${esc(openPositions.join(', '))}`);
    lines.push(live
      ? '⚠ Bot artık izlemiyor; borsadaki stop emirleri yerinde kalır. Ek koruma gerekiyorsa pozisyonları elle kontrol et.'
      : '⚠ Paper pozisyonların stop-loss\'u bot çalışmadığı sürece izlenmez.');
  }
  lines.push(stamp(at));
  return lines.join('\n');
}

function processShutdown({ signal, mode, openPositions = [], at }) {
  const live = String(mode || 'paper').toLowerCase() === 'live';
  const lines = [`⏻ ${b('Bot süreci kapatılıyor')} (${esc(signal || 'sinyal')})`];
  if (openPositions.length) {
    lines.push(`Açık pozisyon: ${esc(openPositions.join(', '))}`);
    lines.push(live
      ? '⚠ Süreç kapalıyken bot izlemez; borsadaki stop emirleri yerinde kalır.'
      : '⚠ Süreç kapalıyken paper pozisyonların stop-loss\'u izlenmez.');
  }
  lines.push('Yeniden açılınca bildirim gelir.', stamp(at));
  return lines.join('\n');
}

// previousShutdown: 'clean' | 'unexpected' | 'first'
function bootMessage({ mode, exchange, running, autoResumed, previousShutdown, lastAliveAt, openPositions = [], killSwitch, safeToTrade, at }) {
  const live = String(mode || 'paper').toLowerCase() === 'live';
  const prev = previousShutdown === 'clean' ? 'temiz kapanış' : previousShutdown === 'unexpected' ? '⚠ beklenmedik kapanış (çökme/elektrik/kill)' : 'ilk açılış';
  const lines = [`🔄 ${b('Bot açıldı')} (${live ? 'CANLI' : 'PAPER'})`];
  lines.push(`Borsa: ${esc(exchange || 'bilinmiyor')} | Önceki oturum: ${esc(prev)}`);
  // lastAliveAt: runtimeMarker'in son nabzi (ms). Varsa botun ne zamandan beri kapali oldugu da yazilir.
  if (previousShutdown !== 'first' && Number.isFinite(Number(lastAliveAt)) && Number(lastAliveAt) > 0) {
    const gap = duration(new Date(Number(lastAliveAt)).toISOString(), at);
    lines.push(`Son aktif: ${esc(formatIstanbulTime(Number(lastAliveAt)))}${gap ? ` | ${previousShutdown === 'unexpected' ? 'kesinti ≈' : 'kapalı kalma:'} ${esc(gap)}` : ''}`);
  }
  lines.push(`Motor: ${autoResumed ? 'önceki durumdan OTOMATİK devam ediyor' : running ? 'çalışıyor' : 'durmuş (başlatmak için /basla veya panel)'}`);
  if (killSwitch) lines.push('⛔ Kill switch AÇIK — işlemler engelli.');
  if (live && safeToTrade === false) lines.push('🔒 Canlı işlem şu an kilitli; mutabakat tamamlanınca açılır.');
  lines.push(openPositions.length ? `Açık pozisyon: ${esc(openPositions.join(', '))}` : 'Açık pozisyon yok.');
  lines.push(stamp(at));
  return lines.join('\n');
}

// ---- Gunluk ozet ----

// d: telegramStatus.buildDailySummaryData() ciktisi
function dailySummary(d) {
  const q = esc(d.quoteAsset || '');
  const live = String(d.mode || 'paper').toLowerCase() === 'live';
  const lines = [`📅 ${b('GÜNLÜK ÖZET')} — ${esc(d.dayLabel)} (${live ? 'CANLI' : 'PAPER'})`];
  lines.push(`Bot: ${d.running ? '✅ çalışıyor' : '⏹ durmuş'}${d.killSwitch ? ' | ⛔ kill switch AÇIK' : ''}${live && d.safeToTrade === false ? ' | 🔒 kilitli' : ''}`);
  if (d.lastTickAt) lines.push(`Son kontrol: ${esc(formatIstanbulTime(d.lastTickAt))}`);
  lines.push('');
  lines.push(`Bugün kapanan işlem: ${b(d.todayTrades)}${d.todayTrades ? ` (kazanan ${esc(d.todayWins)}, kaybeden ${esc(d.todayTrades - d.todayWins)})` : ''}`);
  lines.push(`Bugünkü gerçekleşen K/Z: ${b(`${signed(d.todayPnl)} ${d.quoteAsset || ''}`.trim())}`);
  if (num(d.equity) !== null) {
    let line = `Özkaynak: ${code(moneyShort(d.equity))} ${q}`;
    if (num(d.dayStartEquity) > 0) line += ` | gün içi: ${esc(pct((d.equity / d.dayStartEquity - 1) * 100))}`;
    lines.push(line);
  }
  if (num(d.startingBalance) > 0 && num(d.equity) !== null) lines.push(`Başlangıca göre: ${esc(pct((d.equity / d.startingBalance - 1) * 100))}`);
  lines.push(`Toplam kapanan işlem: ${esc(d.totalTrades)}${d.totalTrades ? ` | kazanma oranı %${esc(d.winRate.toFixed(1))}` : ''}`);
  lines.push('');
  if (d.positions.length) {
    lines.push(`${b(`Açık pozisyonlar (${d.positions.length})`)}`);
    for (const p of d.positions.slice(0, 12)) {
      const u = num(p.unrealizedPct);
      lines.push(`• ${esc(p.symbol)}: ${u === null ? 'güncel fiyat yok' : esc(pct(u))}${num(p.stopPrice) > 0 ? ` | stop ${esc(price(p.stopPrice))}` : ''}`);
    }
    if (d.positions.length > 12) lines.push(`… +${d.positions.length - 12} pozisyon daha`);
  } else {
    lines.push('Açık pozisyon yok.');
  }
  if (num(d.notifyPending) > 0) {
    lines.push('');
    lines.push(`⚠ Gönderilemeyen kritik bildirim bekliyor: ${esc(d.notifyPending)} (bağlantı gelince iletilir)`);
  }
  if (d.errorCount > 0 || d.warnCount > 0) {
    lines.push('');
    lines.push(`Bugünkü log: ${esc(d.errorCount)} hata, ${esc(d.warnCount)} uyarı${d.lastError ? ` — son hata: ${esc(String(d.lastError).slice(0, 160))}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  esc, b, code, signed, pct, price, qty, money, moneyShort, duration, stamp,
  liveBuy, liveSell, protectiveFill, liveKillSwitch, liveKillSwitchResult, lockMessage, unlockMessage,
  paperBuy, paperSell, engineStopped, processShutdown, bootMessage, dailySummary
};
