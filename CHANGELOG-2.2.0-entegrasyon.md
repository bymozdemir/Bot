# 2.2.0 — Açık kaynak botlardan entegrasyon

Kaynaklar: Freqtrade, Hummingbot, Jesse, OctoBot, Passivbot. Kod kopyalanmadı; fikirler JavaScript'te,
bu botun mimarisine (spot, long-only, stop'lu) uygun olarak sıfırdan yazıldı.

**Varsayılan davranış değişmez.** Davranışı değiştiren her özellik varsayılan KAPALI. Metrikler, yeni
stratejiler (yalnızca seçilirse çalışır), throttler (geniş bütçe) ve `--risk` raporu pasif/eklemelidir.

## Yeni ayarlar (`POST /api/settings`, kısmi yama birleştirilir)
Canlı modda bu anahtarlar risk ayarı sayılır ve yeniden doğrulama ister.

```json
{
  "protections": { "enabled": true,
    "cooldown":      { "enabled": true, "minutes": 60, "adverseMinutes": 0, "maxMinutes": 1440 },
    "stoplossGuard": { "enabled": true, "tradeLimit": 3, "lookbackMinutes": 1440, "lockMinutes": 120, "onlyPerPair": false },
    "maxDrawdown":   { "enabled": true, "tradeLimit": 5, "lookbackMinutes": 2880, "maxDrawdownPct": 8, "lockMinutes": 240 },
    "lowProfitPairs":{ "enabled": false, "tradeLimit": 4, "lookbackMinutes": 1440, "requiredProfitPct": 0, "lockMinutes": 360 } },
  "pairFilters": { "enabled": true, "minCandles": 100, "minQuoteVolume24h": 0, "minAtrPct": 0, "maxAtrPct": 0, "maxRangePct": 0 },
  "timeBarrier": { "enabled": true, "maxHoldBars": 48, "minProfitPct": 0.5 },
  "forager":     { "enabled": true, "volumeDropPct": 20, "spanBars": 20, "weights": { "volume": 1, "volatility": 1, "unilateralness": 0 } }
}
```

| Özellik | Kaynak fikir | Ne yapar | Neye dokunur |
|---|---|---|---|
| protections | Freqtrade | Cooldown, ardışık stop kilidi, işlem drawdown kilidi, düşük kârlı parite kilidi. Kilitler işlem geçmişinden **yeniden hesaplanır** (state.json şeması değişmedi, yeniden başlatmada kaybolmaz). `adverseMinutes` > 0 ise düşüş yönlülüğü kadar ek bekleme (Passivbot). | Yalnız yeni alım |
| pairFilters | Freqtrade | Yaş (min mum), 24s hacim, ATR% alt/üst, aralık stabilitesi. | Yalnız yeni alım |
| timeBarrier | Hummingbot | N mumdur açık ve kâr hedefine ulaşmamış pozisyonu, strateji "tut" derken çıkarır. Mevcut sell yolundan geçer. Backtest'te de modellenir (`runBacktest({ timeBarrier })`). | Çıkış |
| forager | Passivbot | Sınırlı pozisyon slotlarını hacim/oynaklık/yönlülük skoruna göre sıralar; en düşük hacimli %X'i yeni alımdan eler. Açık pozisyonlar her zaman önce işlenir. | İşleme sırası + yeni alım |

Ek katman bir istisna fırlatırsa **alım güvenli tarafta atlanır**, motor durmaz.

## Backtest
- `node backtest.js --risk` : Sharpe, Sortino, Calmar, Ulcer, CVaR, Omega, beklenti, payoff, ardışık kayıp,
  Monte Carlo (işlem sırası bootstrap, tohumlu/tekrarlanabilir) ve anlamlılık testi (p-değeri). `<30` işlemde güvenme.
- Her sonuçta `metrics` alanı (JSON çıktısında).

## Yeni stratejiler
- `supertrend` (Hummingbot supertrend_v1): ATR bant trend dönüşü.
- `dip_analyser` (OctoBot): aşırı satım + yeşil dönüş mumu + hacim patlaması + çöküş koruması.
- Gösterge: `supertrend`, `directionality` (Passivbot unilateralness).

## Piyasa verisi
- **Ortak REST bütçesi** (Hummingbot throttler): Binance public çağrıları tek kayan pencereden geçer.
  `PUBLIC_API_WEIGHT_PER_MIN` (varsayılan 2400, Binance limiti 6000; 0 = kapalı). Bütçe dolarsa ağa çıkmadan
  `throttled/rateLimited` hatası.
- **WebSocket mum akışı** (opt-in: `MARKET_DATA_WS=1`, yalnız Binance): akış sadece hızlandırıcıdır. Bağlantı açık,
  geçmiş REST ile tamamlanmış, olay taze ve mum sayısı yeterliyse akıştan; aksi halde REST. Her iki kaynak da aynı
  doğrulayıcılardan geçer. Kopma/yeniden bağlanma sonrası geçmiş yeniden tamamlanır. `ws` paketi gerekir (zaten bağımlılık).

## Bilerek YAPILMAYANLAR
- **Passivbot'un martingale/grid/unstuck stratejisi**: vadeli, kaldıraçlı ve zarar realize ederek ortalama düşürme
  mantığıdır; bu botun "stop'lu spot" risk modeliyle çelişir.
- **Hacim/volatilite ölçekli stop (Hummingbot)**: canlı koruyucu stop kodunda `stopLossPct` ~10 yerde kullanılıyor;
  canlı para yoluna dokunmadan güvenle eklenemedi.
- **Zirveden equity-drawdown HSL (Passivbot)**: canlı motor equity geçmişi tutmuyor. Yerine işlem-bazlı
  `maxDrawdown` koruması eklendi; mevcut kill switch / günlük limit değişmedi.
- OctoBot grid/DCA modları: çoklu eşzamanlı emir gerektirir, tek-pozisyonlu strateji arayüzüne sığmaz.
- Paneli (public/) güncelleme: yeni ayarlar şimdilik API üzerinden.

## Testler
Yeni: protections, metricsMonteCarlo, entryExtras, newStrategies, forager, throttler, candleFeed, binanceFeedThrottle.
Toplam 1164 testin 1163'ü geçer; kalan, `express` kurulu olmadığı için bu ortamda koşamayan `server entegrasyon`
testidir (orijinal 2.1.15'te de aynı koşulda düşer). Kendi makinende `npm ci && npm test` ile koştur.
