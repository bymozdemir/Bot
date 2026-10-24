// src/backtest/criteria.js
//
// STRATEJI KABUL OLCUTLERI. Bu olcutler 24 aylik sonuclar GORULMEDEN ONCE yazildi ve
// sabittir (surum 1). Sonradan "bu da iyi gorunuyor" diye olcutleri degistirmek ya da
// ayar taramasi yapmak gecmise uydurmaktir; olcut degisecekse surum numarasi artirilir ve
// bu acikca not edilir.
//
// Her (mum araligi x strateji) icin, pariteler uzerinden olculur. Olcutler yalnizca
// 24 aylik calistirma icin tanimlidir (iki yari ~12'ser ay).
//
//   K1  net getirisi pozitif olan parite sayisi >= %60 (5 paritede 3)
//   K2  pariteler ortalamasinda 1. yari VE 2. yari getirisi pozitif
//   K3  toplam islem sayisi >= 50
//   K4  ortalama en buyuk dusus, al-tut'un en buyuk dususunun YARISINI asmaz
//   K5  ortalama getiri >= al-tut getirisinin yarisi (al-tut negatifse: >= al-tut getirisi)
//   K6  toplam islem sayisi >= 10 (anlamsiz derecede az islemle aday cikmasin)
//
//   G seti (getiri odakli strateji):   K1 + K2 + K3 + K4
//   R seti (risk azaltici, orn. trend filtresi): K1 + K4 + K5 + K6
//
// "ADAY" yalnizca bir set tamamen saglanirsa denir. ADAY, gercek para icin KANIT degildir:
// sadece ileriye donuk kagit sinamasina gecme hakki verir.

const CRITERIA_VERSION = 1;
const REQUIRED_MONTHS = 24;

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function evaluateCriteria(results) {
  const out = {};
  for (const tf of [...new Set(results.map((r) => r.timeframe))]) {
    out[tf] = {};
    const inTf = results.filter((r) => r.timeframe === tf);
    const symbols = [...new Set(inTf.map((r) => r.symbol))];
    const bh = symbols.map((s) => inTf.find((r) => r.symbol === s));
    const bhRet = avg(bh.map((r) => r.buyHoldPct));
    const bhDd = avg(bh.map((r) => r.buyHoldMaxDrawdownPct));

    for (const id of [...new Set(inTf.map((r) => r.strategyId))]) {
      const rows = inTf.filter((r) => r.strategyId === id);
      const n = rows.length;
      const ret = avg(rows.map((r) => r.returnPct));
      const dd = avg(rows.map((r) => r.maxDrawdownPct));
      const trades = rows.reduce((s, r) => s + r.trades, 0);
      const positive = rows.filter((r) => r.returnPct > 0).length;
      const h1 = avg(rows.map((r) => r.firstHalfPct));
      const h2 = avg(rows.map((r) => r.secondHalfPct));

      const k = {
        K1: positive >= Math.ceil(n * 0.6),
        K2: h1 > 0 && h2 > 0,
        K3: trades >= 50,
        K4: Math.abs(dd) <= 0.5 * Math.abs(bhDd),
        K5: bhRet > 0 ? ret >= 0.5 * bhRet : ret >= bhRet,
        K6: trades >= 10
      };
      const G = k.K1 && k.K2 && k.K3 && k.K4;
      const R = k.K1 && k.K4 && k.K5 && k.K6;
      out[tf][id] = { k, G, R, candidate: G || R, detail: { n, ret, bhRet, dd, bhDd, trades, positive, h1, h2 } };
    }
  }
  return out;
}

module.exports = { evaluateCriteria, CRITERIA_VERSION, REQUIRED_MONTHS };
