require('dotenv').config();
const { createExchange } = require('../src/exchanges');
const store = require('../src/store');

async function check(id) {
  const env = {
    binance: ['BINANCE_API_KEY','BINANCE_API_SECRET'],
    binancetr: ['BINANCE_TR_API_KEY','BINANCE_TR_API_SECRET'],
    btcturk: ['BTCTURK_API_KEY','BTCTURK_API_SECRET'],
    paribu: ['PARIBU_API_KEY','PARIBU_API_SECRET']
  }[id];
  const [keyName, secretName] = env;
  if (!process.env[keyName] || !process.env[secretName]) return { id, skipped: true, reason: `missing ${keyName}/${secretName}` };
  const ex = createExchange(id, {
    apiKey: process.env[keyName], apiSecret: process.env[secretName],
    environment: id === 'binance' ? (process.env.BINANCE_ENV || 'testnet') : undefined,
    baseUrl: process.env[`${id === 'binancetr' ? 'BINANCE_TR' : id.toUpperCase()}_BASE_URL`],
    privateBaseUrl: process.env[`${id.toUpperCase()}_PRIVATE_BASE_URL`]
  });
  const out = { id, name: ex.name };
  try { out.balanceAssets = Object.keys(await ex.fetchBalance()).length; } catch (e) { out.balanceError = e.message; }
  try {
    let symbols = [];
    if (id === 'binancetr') {
      symbols = Object.keys(store.defaultState().pairs || {})
        .filter((s) => /\/TRY$/i.test(s))
        .slice(0, 1);
    }
    out.openOrders = (await ex.fetchOpenOrders(symbols)).length;
  } catch (e) { out.openOrdersError = e.message; }
  if (typeof ex.fetchApiRestrictions === 'function' && String(ex.environment || 'production') === 'production') {
    try {
      const r = await ex.fetchApiRestrictions();
      out.enableWithdrawals = r.enableWithdrawals === true;
      out.enableReading = r.enableReading === true;
      out.enableSpotAndMarginTrading = r.enableSpotAndMarginTrading === true;
      out.ipRestrict = r.ipRestrict === true;
      if (out.enableWithdrawals) out.apiRestrictionsError = 'PARA ÇEKME yetkisi AÇIK — anahtarı yeniden oluştur.';
      else if (!out.ipRestrict) out.apiRestrictionsWarning = 'IP kısıtlaması kapalı; anahtarı yalnızca sunucu IP’sine kısıtlaman önerilir.';
    } catch (e) { out.apiRestrictionsError = `yetki sorgusu başarısız: ${e.message}`; }
  }
  return out;
}

(async () => {
  const ids = process.argv.slice(2);
  const targets = ids.length ? ids : ['binance','binancetr','btcturk','paribu'];
  const results = [];
  for (const id of targets) results.push(await check(id));
  console.log(JSON.stringify(results, null, 2));
  if (results.some(r => r.balanceError || r.openOrdersError || r.apiRestrictionsError)) process.exitCode = 2;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
