// OKX TR (Türkiye) — OKX V5 API'sinin bölgesel hostu.
// Resmî belge (tr.okx.com/docs-v5/en): "Production Trading URL — REST: https://tr.okx.com".
// Bölgesel hesap/anahtar yalnızca bu hostla çalışır; global www.okx.com ile karıştırılmamalıdır.
// Not: bu adaptör OKX adaptörünün özel API koduna dayanır; TR'ye özgü ürün/parite kapsamı ve emir davranışı
// ayrıca sandbox/gerçek hesap kanıtıyla doğrulanmadan liveTradingVerified=false kalır.
const OkxAdapter = require('./okx');
class OkxTrAdapter extends OkxAdapter {
  constructor(opts = {}) {
    super(opts, { id: 'okxtr', name: 'OKX TR', quoteAssets: ['TRY', 'USDT', 'USDC'], baseUrl: 'https://tr.okx.com', baseUrlEnv: 'OKXTR_BASE_URL', passphraseEnv: 'OKXTR_API_PASSPHRASE' });
  }
}
module.exports = OkxTrAdapter;
