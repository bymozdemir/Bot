# API denemesi öncesi kontrol listesi (1.8.0 FINAL)

Sıra önemlidir. Bir adım başarısız olursa bir sonrakine geçme.

1. **Kod:** `npm install && npm test` → tüm testler geçmeli. `npm run preflight` → BAŞARILI.
2. **Kağıt gözlemi:** En az 2–4 hafta paper. Trend V1 için `npm run walkforward` çıktısını incele (artık parite başına bileşik getiri).
3. **Anahtar:** Binance'te yalnızca *Enable Reading* + *Enable Spot & Margin Trading*. **Withdraw KAPALI.** Anahtarı sunucu IP'sine kısıtla.
4. **`npm run api:preflight binance`** → `enableWithdrawals: false`, bakiye ve açık emir okuma başarılı olmalı (production anahtarında).
5. **Testnet:** `.env` içinde `BINANCE_ENV=testnet`, `LIVE_TRADING_ENABLED=true`, `ALLOW_PRODUCTION_TRADING=false`. Panelde mode=live, tek parite, çok küçük `maxTradeQuote`.
   Testnet'te şunları ayrı ayrı doğrula: market alış → koruyucu stop kuruldu mu → stop miktarı adım katı mı → market satış → stop iptal edildi mi → bot yeniden başlatma/mutabakat → WebSocket executionReport.
6. **Komisyon varyantları:** hem BNB ile hem BNB'siz (komisyon baz coinden düşer) dene; ikincisinde `state.live.dustByAsset` oluşabilir ve mutabakat temiz kalmalı.
7. **Kasıtlı arıza:** internetini kes → geri aç; botu açık pozisyonla kapat/aç; stop'u panelden elle iptal et → bot kilitlenmeli ve bildirim gelmeli.
8. **Production (gerçek para):** `ALLOW_PRODUCTION_TRADING=true`, en küçük tutar (10–20 USDT), tek parite, `killSwitchLossPct` ve `dailyLossLimitPct` kısa tutulur. İlk haftada günlük kontrol.

## Bilinen açık noktalar (kodla çözülemeyen / bilinçli bırakılan)
- Binance'te koruyucu stop `STOP_LOSS` (market) olarak kurulur; sert gap'te kayma olabilir. Order-book kontrolü yalnızca giriş/çıkış market emirlerini korur.
- Sistem saati: Binance için sunucu saati farkı otomatik düzeltilir (1.8.0); yine de NTP açık olsun. Binance TR için de signed-request saat offseti kullanılır.
- `state.liveOrders` kayıtları temizlenmez; aylarca çalışacaksa dosya büyür (periyodik yedekle/arşivle).
- Başlangıç özkaynağı ilk görülen değerdir: bakiyeye para yatırır/çekersen toplam-zarar yüzdesi sapar.
- Paribu canlı modu bilinçli olarak kapalıdır; Binance TR / BTCTurk gerçek sözleşme doğrulanmadan açılmamalıdır.

## 1.7.2 ek kurallar
- Gerçek borsada canlı başlatma için `maxTradeQuote`, `killSwitchLossPct` ve `dailyLossLimitPct` **0 olamaz** (0 = sınırsız/kapalı anlamına geldiği için reddedilir).
- Başarısız bir çıkış (sell) sinyali aynı muma tüketilmiş sayılmaz; kilit açılınca yeniden denenir.
- `state.json.bak` son sağlam kaydı tutar; bozulmada otomatik kullanılır.
