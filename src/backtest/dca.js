// src/backtest/dca.js
//
// DCA (Dolar Maliyet Ortalamasi) referansi. Bir "strateji" degil, bir YATIRIM YONTEMI:
// sermaye test penceresine esit parcalara bolunup duzenli aralikla (varsayilan: haftada bir)
// ayni tutarda alinir, SATILMAZ. Sinyal, indikator, stop yoktur.
//
// Adil karsilastirma icin: toplam sermaye pencere boyunca TAMAMEN yatirilir (yatirilmamis kisim
// nakit, getirisi sifir kabul edilir); ayni komisyon/kayma odenir; test sonunda al-tut ile ayni
// sekilde maliyetli bir cikis hesaplanir. Sonuc, diger stratejilerle ve al-tut ile ayni
// metrik alanlarini tasir, boylece rapor, duyarlilik tablosu ve kabul olcutleri ayni sekilde calisir.
//
// Beklenti: yukselen piyasada ortalama maruziyet ~%50 oldugu icin al-tut'un GERISINDE kalir;
// dusen piyasada daha az kaybeder. Piyasa yonunu tahmin etmez.

const { buyFill, sellFill } = require('../execution');
const { buyAndHold, maxDrawdownPct } = require('./simulator');

const DCA_ID = 'dca_weekly';

function runDca({ candles, startIndex = 0, intervalDays = 7, capital = 1000, feePct = 0.1, slippagePct = 0.05 }) {
  const n = candles.length;
  if (n === 0 || startIndex >= n) throw new Error('DCA için test penceresinde yeterli mum yok.');
  if (!(intervalDays > 0)) throw new Error('DCA aralığı pozitif olmalı.');
  const fee = feePct / 100;

  const candleMs = candles[startIndex + 1] ? candles[startIndex + 1].t - candles[startIndex].t : 86400000;
  const stepBars = Math.max(1, Math.round((intervalDays * 86400000) / candleMs));
  const bars = n - startIndex;
  const buys = Math.max(1, Math.floor(bars / stepBars));
  const amount = capital / buys;

  let cash = capital;
  let qty = 0;
  let feesPaid = 0;
  let slipCost = 0;
  let exposureSum = 0;
  const purchases = [];
  const equity = new Array(bars);

  for (let i = startIndex; i < n; i++) {
    const k = i - startIndex;
    if (k % stepBars === 0 && purchases.length < buys) {
      const ref = candles[i].o; // alim, mumun acilisinda
      const fill = buyFill(ref, slippagePct);
      // amount bütçesi hem gerçekleşen notional'ı hem de notional üzerinden
      // hesaplanan komisyonu kapsar; buyAndHold/simulator ile aynı muhasebe.
      const bought = amount / (fill * (1 + fee));
      const feeAmt = bought * fill * fee;
      qty += bought;
      cash -= amount;
      feesPaid += feeAmt;
      slipCost += (fill - ref) * bought;
      purchases.push({ t: candles[i].t, price: fill, amount });
    }
    const value = qty * candles[i].c;
    equity[k] = cash + value;
    exposureSum += equity[k] > 0 ? value / equity[k] : 0;
  }

  // Test sonunda, al-tut ile ayni sekilde maliyetli cikis.
  const last = n - 1;
  const exitFill = sellFill(candles[last].c, slippagePct);
  const gross = qty * exitFill;
  const exitFee = gross * fee;
  feesPaid += exitFee;
  slipCost += (candles[last].c - exitFill) * qty;
  const finalEquity = cash + gross - exitFee;
  equity[bars - 1] = finalEquity;

  const bh = buyAndHold(candles, startIndex, capital, feePct, slippagePct);
  const mid = Math.max(1, Math.floor(bars / 2));
  const midEq = equity[mid - 1];

  return {
    candlesTested: bars,
    startT: candles[startIndex].t,
    endT: candles[last].t,
    capital,
    finalEquity,
    returnPct: (finalEquity / capital - 1) * 100,
    buyHoldPct: bh.pct,
    maxDrawdownPct: maxDrawdownPct(equity, capital),
    buyHoldMaxDrawdownPct: bh.maxDrawdownPct,
    trades: purchases.length, // alim sayisi
    winRatePct: null,
    profitFactor: null,
    avgTradePct: null,
    worstTradePct: null,
    exposurePct: (exposureSum / bars) * 100, // ortalama olarak sermayenin ne kadari varlikta
    firstHalfPct: (midEq / capital - 1) * 100,
    secondHalfPct: (finalEquity / midEq - 1) * 100,
    feesPct: (feesPaid / capital) * 100,
    slippagePct: (slipCost / capital) * 100,
    tradeList: purchases
  };
}

module.exports = { runDca, DCA_ID };
