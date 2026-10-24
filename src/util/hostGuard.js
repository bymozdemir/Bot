// Ortam degiskeninden gelen URL'ler imzali istek (API key basligi / imza) tasir.
// Yanlis/ele gecirilmis bir env degeri anahtari baska bir sunucuya sizdirabilir:
// bu yuzden host allowlist disinda reddedilir. Yerel test icin ALLOW_LOCAL_EXCHANGE_URLS=1.
function assertAllowedUrl(value, allowedHosts, envName, { protocols = ['https:'] } = {}) {
  let u;
  try { u = new URL(String(value)); } catch (e) { throw new Error(`${envName} geçerli bir URL değil.`); }
  const host = u.hostname.toLowerCase();
  const local = process.env.ALLOW_LOCAL_EXCHANGE_URLS === '1' && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
  const okHost = allowedHosts.some((h) => host === h || host.endsWith('.' + h));
  const okProto = protocols.includes(u.protocol) || (local && ['http:', 'ws:'].includes(u.protocol));
  if (u.username || u.password) throw new Error(`${envName} içinde kullanıcı bilgisi olamaz.`);
  if (!(okHost || local) || !okProto) {
    throw new Error(`${envName} izin verilen host/protokol dışında (${host}). İzinli: ${allowedHosts.join(', ')}`);
  }
  return String(value);
}
module.exports = { assertAllowedUrl };
