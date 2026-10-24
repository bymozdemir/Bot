// src/util/network.js
// Ag varsayilanlari: farkli ortamlarda (ev Wi-Fi, mobil veri, Termux, Windows, VPS) Binance'e
// baglanti sorunlarinin en sik nedenlerini onceden yumusatir.
//  * IPv4 oncelikli DNS: bircok ev modemi IPv6 yolunu bozuk cikarir ("ping Google calisir,
//    Binance zaman asimina ugrar"). Node varsayilani IPv6'yi once dener ve takilir.
//  * autoSelectFamily (Happy Eyeballs): ilk adres takilirsa digerini dener.
//  * HTTPS_PROXY / HTTP_PROXY / ALL_PROXY: Node'un fetch'i bunlari kendiliginden kullanmaz;
//    undici kuruluysa global proxy olarak baglanir.
// TLS dogrulamasini KAPATMAYIZ: API anahtari tasiyan trafikte NODE_TLS_REJECT_UNAUTHORIZED=0 yasak.
const dns = require('dns');
const net = require('net');

let applied = false;
const info = { dnsOrder: null, autoSelectFamily: false, proxy: null, proxyError: null };

function applyNetworkDefaults() {
  if (applied) return info;
  applied = true;
  const order = String(process.env.DNS_ORDER || 'ipv4first').toLowerCase();
  if (['ipv4first', 'ipv6first', 'verbatim'].includes(order) && typeof dns.setDefaultResultOrder === 'function') {
    try { dns.setDefaultResultOrder(order); info.dnsOrder = order; } catch (_) { /* eski Node */ }
  }
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    try {
      net.setDefaultAutoSelectFamily(true);
      if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') net.setDefaultAutoSelectFamilyAttemptTimeout(500);
      info.autoSelectFamily = true;
    } catch (_) { /* yoksay */ }
  }
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    info.proxy = proxy.replace(/\/\/[^@/]*@/, '//***@'); // kimlik bilgisini loglama
    try {
      const undici = require('undici');
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
    } catch (e) {
      info.proxyError = 'Proxy tanımlı ama "undici" paketi kurulu değil: `npm install undici` çalıştırın.';
    }
  }
  return info;
}

// Ag hatasi kodunu insan dilinde aciklar (log + panel icin).
function explainNetworkError(codeOrMsg) {
  const s = String(codeOrMsg || '');
  if (/ENOTFOUND|EAI_AGAIN/.test(s)) return 'DNS adı çözülemiyor: modem/ISS DNS\'i Binance\'i vermiyor olabilir. DNS\'i 1.1.1.1 veya 8.8.8.8 yapın.';
  if (/ETIMEDOUT|zaman aşımı|ENETUNREACH|EHOSTUNREACH/.test(s)) return 'Bağlantı zaman aşımı: IPv6 yolu bozuk olabilir (DNS_ORDER=ipv4first varsayılan), ISS/güvenlik duvarı Binance\'i engelliyor olabilir.';
  if (/ECONNRESET|EPIPE|socket hang up/.test(s)) return 'Bağlantı sıfırlandı: ISS/modem TLS el sıkışmasını (SNI) kesiyor olabilir; alternatif adres veya proxy deneyin.';
  if (/ECONNREFUSED/.test(s)) return 'Bağlantı reddedildi: adres/port engelli veya proxy yanlış.';
  if (/UNABLE_TO_VERIFY|SELF_SIGNED|CERT_|certificate/i.test(s)) return 'Sertifika doğrulanamadı: antivirüs "HTTPS taraması" veya kurumsal proxy araya giriyor olabilir. Kök sertifikayı NODE_EXTRA_CA_CERTS ile tanıtın; doğrulamayı KAPATMAYIN.';
  return null;
}

module.exports = { applyNetworkDefaults, explainNetworkError, info };
