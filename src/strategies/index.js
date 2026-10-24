// src/strategies/index.js
//
// STRATEJI KAYIT DEFTERI. Yeni bir strateji eklemek icin:
//   1. src/strategies/<isim>.js dosyasi olustur, su sekli uygula:
//        { id, name, description, defaultParams, paramsSchema, minCandles(params), evaluate(ctx) }
//      evaluate ctx = { candles, position, params } alir, {action:'buy'|'sell'|'hold', reason, price} dondurur.
//      paramsSchema panelin formu OTOMATIK cizmesi icin var -- yeni bir sayisal/boolean
//      parametre eklersen sadece schema'ya bir satir eklemen yeterli, panel kodu degismez.
//   2. Asagidaki registry objesine ekle.
// Bu ikisi disinda ne paperEngine.js ne de public/app.js degismesi gerekir.

const rsiEmaMacd = require('./rsiEmaMacd');
const emaCross = require('./emaCross');
const bollingerReversion = require('./bollingerReversion');
const macdMomentum = require('./macdMomentum');
const rsiSimple = require('./rsiSimple');
const trendFilter = require('./trendFilter');
const trendFilterV2 = require('./trendFilterV2');
const aggressiveBreakout = require('./aggressiveBreakout');
const trendRegime = require('./trendRegime');
const donchianRegime = require('./donchianRegime');
const tsmom = require('./tsmom');
const adxChandelier = require('./adxChandelier');
const trendVote = require('./trendVote');
const regimeAdx = require('./regimeAdx');
const regimeChandelier = require('./regimeChandelier');
const regimePullback = require('./regimePullback');
const regimeStrict = require('./regimeStrict');
const supertrend = require('./supertrend');
const dipAnalyser = require('./dipAnalyser');

const registry = {
  [rsiEmaMacd.id]: rsiEmaMacd,
  [emaCross.id]: emaCross,
  [bollingerReversion.id]: bollingerReversion,
  [macdMomentum.id]: macdMomentum,
  [rsiSimple.id]: rsiSimple,
  [trendFilter.id]: trendFilter,
  [trendFilterV2.id]: trendFilterV2,
  [aggressiveBreakout.id]: aggressiveBreakout,
  [trendRegime.id]: trendRegime,
  [donchianRegime.id]: donchianRegime,
  [tsmom.id]: tsmom,
  [adxChandelier.id]: adxChandelier,
  [trendVote.id]: trendVote,
  [regimeAdx.id]: regimeAdx,
  [regimeChandelier.id]: regimeChandelier,
  [regimePullback.id]: regimePullback,
  [regimeStrict.id]: regimeStrict,
  [supertrend.id]: supertrend,
  [dipAnalyser.id]: dipAnalyser
};

function list() {
  return Object.values(registry).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    defaultParams: s.defaultParams,
    paramsSchema: s.paramsSchema
  }));
}

function get(id) {
  // Registry lookup must never resolve inherited Object.prototype names such as
  // constructor, __proto__, or toString as if they were registered strategies.
  const s = typeof id === 'string' && Object.prototype.hasOwnProperty.call(registry, id)
    ? registry[id]
    : null;
  if (!s) {
    throw new Error(`Bilinmeyen strateji: ${id}. Kayıtlı: ${Object.keys(registry).join(', ')}`);
  }
  return s;
}

// Panelden/API'den gelen parametre yamasindan SADECE stratejinin semasinda
// tanimli anahtarlari alir (bilinmeyen anahtarlar state.json'a sizmasin).
function pickParams(id, patch) {
  const s = get(id);
  const out = {};
  for (const f of s.paramsSchema) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, f.key)) out[f.key] = patch[f.key];
  }
  return out;
}

// Tam (birlestirilmis) parametre kumesini semaya gore dogrular. Hata mesaji
// (string) ya da null dondurur. Sonlu sayi, min/max, tamsayi (step=1) ve
// stratejiye ozel capraz kontrol (ornegin hizli < yavas) yapilir.
function validateParams(id, params) {
  const s = get(id);
  for (const f of s.paramsSchema) {
    const v = params[f.key];
    if (f.type === 'boolean') {
      if (typeof v !== 'boolean') return `${f.label}: açık/kapalı olmalı.`;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${f.label}: geçerli bir sayı gir.`;
    if (f.min !== undefined && v < f.min) return `${f.label}: en az ${f.min} olmalı.`;
    if (f.max !== undefined && v > f.max) return `${f.label}: en çok ${f.max} olabilir.`;
    if (f.step === 1 && !Number.isInteger(v)) return `${f.label}: tam sayı olmalı.`;
  }
  if (typeof s.validate === 'function') {
    const err = s.validate(params);
    if (err) return err;
  }
  // Strateji tek seferde alinabilecek mum sayisindan fazla gecmis isterse HIC islem yapmaz (sessiz arıza).
  if (typeof s.minCandles === 'function' && s.minCandles(params) + 1 > MAX_CANDLE_LIMIT) {
    return `Seçilen parametreler en az ${s.minCandles(params) + 1} mum gerektiriyor; borsa tek çağrıda en fazla ${MAX_CANDLE_LIMIT} mum verir. Periyotları küçült.`;
  }
  return null;
}

// Bir strateji icin borsadan kac mum istenecegi. Hem canli/kagit motor (paperEngine)
// hem de backtest AYNI fonksiyonu kullanir: gostergeler ayni uzunlukta pencere
// uzerinde hesaplandigi icin (EMA'nin isinma etkisi dahil) iki tarafin sonuclari
// birbirine tutarli olur.
const MIN_CANDLE_LIMIT = 300;
const MAX_CANDLE_LIMIT = 1000; // Binance tek çağrı limiti; EMA200 için 810 -> 860 civarı istenir // Binance klines ust siniri
function candleLimit(strategy, params) {
  return Math.min(MAX_CANDLE_LIMIT, Math.max(MIN_CANDLE_LIMIT, strategy.minCandles(params) + 50));
}

module.exports = { list, get, registry, pickParams, validateParams, candleLimit };
