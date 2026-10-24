'use strict';
// src/exchanges/orderGuards.js
//
// Emir olusturma icin ORTAK korumalar (Binance, BTCTurk, Binance TR, Paribu ve Stage 4 borsalari).
//
// Neden var:
//  - OrderManager, `unknownOutcome` isareti OLMAYAN her hatayi REJECTED ("emir kesin acilmadi") sayar ve
//    islem tekrar denenebilir. Istek borsaya gittikten SONRA olusan bir TypeError/SyntaxError (ornegin
//    HTTP 200 + govde `null`) bu yuzden cift emre yol acabilirdi.
//  - HTTP 200 + bos/bozuk govde "emir kabul edildi" sayilmamali; borsa emir kimligi olmayan yanit
//    sonucu BELIRSIZDIR ve kurtarma akisina (UNKNOWN) gitmelidir.
//  - Gecersiz miktar/yon/kimlik ag cagrisindan ONCE reddedilmelidir.

const MIN_ORDER_QTY = 1e-10; // hicbir borsa adimi bundan kucuk degildir; altindaki deger "0" olarak gonderilirdi
const MAX_ORDER_QTY = 1e21; // Number#toFixed bu degerden itibaren ussel gosterime gecer

function invalid(name, message) {
  const err = new Error(`${name}: ${message}`);
  err.exchange = name;
  err.invalidOrderArgs = true; // istek GONDERILMEDI: kesin red
  return err;
}

// Agdan once cagrilir. Gecerliyse normalize edilmis { side, amount } dondurur.
function validateOrderArgs(name, { side, amount, clientOrderId, requireClientOrderId = true } = {}) {
  const s = String(side == null ? '' : side).toLowerCase();
  if (s !== 'buy' && s !== 'sell') throw invalid(name, 'emir yönü buy veya sell olmalı.');
  const n = amount === null || amount === undefined || amount === '' || typeof amount === 'boolean' ? NaN : Number(amount);
  if (!Number.isFinite(n) || !(n > 0)) throw invalid(name, 'emir miktarı pozitif ve sonlu olmalı.');
  if (n < MIN_ORDER_QTY) throw invalid(name, 'emir miktarı ondalık hassasiyetin altında; sıfıra yuvarlanırdı.');
  if (n >= MAX_ORDER_QTY) throw invalid(name, 'emir miktarı makul sınırın üzerinde.');
  if (requireClientOrderId && !String(clientOrderId == null ? '' : clientOrderId)) {
    throw invalid(name, 'clientOrderId zorunlu; kimliksiz canlı emir gönderilmez.');
  }
  return { side: s, amount: n };
}

function validatePositivePrice(name, label, value) {
  const n = value === null || value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || !(n > 0) || n >= MAX_ORDER_QTY) throw invalid(name, `${label} pozitif ve sonlu olmalı.`);
  return n;
}

function unknownResponse(name, why) {
  const err = new Error(`${name}: emir yanıtı doğrulanamadı (${why}); sonuç belirsiz, otomatik tekrar gönderilmez.`);
  err.exchange = name;
  err.unknownOutcome = true;
  err.orderResponseInvalid = true;
  return err;
}

function hasValue(v) {
  return v !== null && v !== undefined && String(v) !== '';
}

// Istegi gonderen fonksiyonu sarar.
//  - Istek cikis yaptiktan sonra olusan TypeError/RangeError/SyntaxError => unknownOutcome
//  - requireOrderId: yanitta borsa emir kimligi yoksa => unknownOutcome
//  - yanit clientOrderId/side tasiyorsa istemcinin gonderdigiyle eslesmeli
async function guardCreate(name, send, { clientOrderId, side, requireOrderId = true } = {}) {
  let out;
  try {
    out = await send();
  } catch (err) {
    if (err && !err.unknownOutcome && !err.invalidOrderArgs
      && (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError)) {
      err.unknownOutcome = true;
      err.exchange = err.exchange || name;
    }
    throw err;
  }
  if (out === null || out === undefined || typeof out !== 'object' || Array.isArray(out)) {
    throw unknownResponse(name, 'boş veya nesne olmayan yanıt');
  }
  if (!requireOrderId) return out;
  const orderId = out.orderId ?? out.exchangeOrderId ?? out.id;
  if (!hasValue(orderId)) throw unknownResponse(name, 'borsa emir kimliği yok');
  const echoedCid = out.clientOrderId ?? out.newOrderClientId ?? out.orderClientId;
  if (hasValue(echoedCid) && hasValue(clientOrderId) && String(echoedCid) !== String(clientOrderId)) {
    throw unknownResponse(name, 'clientOrderId uyuşmuyor');
  }
  if (hasValue(out.side) && side && String(out.side).toLowerCase() !== String(side).toLowerCase()) {
    throw unknownResponse(name, 'yön uyuşmuyor');
  }
  return out;
}

module.exports = { validateOrderArgs, validatePositivePrice, guardCreate, unknownResponse, MIN_ORDER_QTY, MAX_ORDER_QTY };
