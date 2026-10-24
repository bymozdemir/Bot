'use strict';
// Cross-site istek reddi: durum degistiren HER ucta (login/reauth/logout dahil) ayni kural uygulanir.
// Origin varsa panelin kendi origin'i olmali; tarayici Sec-Fetch-Site: cross-site gonderdiyse reddedilir.
// Origin hic yoksa ama Referer varsa, Referer'in origin'i de panelin kendi origin'i olmali
// (Referer'siz/Origin'siz istekler tarayici disi istemcilerdir ve cerez SameSite=Strict ile korunur).
// Donus: null (gecebilir) veya { status, error }.
function crossSiteRejection(req, sameOrigin) {
  const headers = (req && req.headers) || {};
  if (headers.origin && !sameOrigin(req, headers.origin)) return { status: 403, error: 'Geçersiz istek kaynağı.' };
  if (!headers.origin && headers.referer) {
    let refOrigin = null;
    try { refOrigin = new URL(String(headers.referer)).origin; } catch (_) { /* gecersiz Referer asagida reddedilir */ }
    if (!refOrigin || refOrigin === 'null' || !sameOrigin(req, refOrigin)) return { status: 403, error: 'Geçersiz istek kaynağı.' };
  }
  if (headers['sec-fetch-site'] === 'cross-site') return { status: 403, error: 'Cross-site istek engellendi.' };
  return null;
}
module.exports = { crossSiteRejection };
