# 2.1.15 — Sınırlı eşzamanlı piyasa verisi ve giriş güvenliği

## Yeni düzeltmeler

- Paper motorunda mum verisi toplama sıralı döngüden sınırlı eşzamanlı iş kuyruğuna taşındı. Varsayılan eşzamanlılık 4; `MARKET_DATA_CONCURRENCY` (öncelikli) veya `PAPER_MARKET_DATA_CONCURRENCY` ile 1–8 aralığında ayarlanabilir. Sınırsız `Promise.all` kullanılmaz.
- Live motoru, aktif/pozisyonlu sembollerin mum ve ticker verilerini sınırlı eşzamanlılıkla önceden toplar. Strateji değerlendirmesi, risk kapıları ve emir gönderimi sıralı kalır.
- Live ön toplama sırasında boş/bozuk, eski veya geleceğe ait mumlar ve geçersiz ticker fiyatı reddedilir. Bu kontroller, açık pozisyon verisi eksikken başka sembollerde yeni alım yapılmasını önleyen tur kapısına da bağlandı.
- Açık pozisyonlardan en az birinin piyasa verisi eksik/eskimişse o tur yeni alımlar durdurulur; mevcut pozisyonların normal çıkış ve koruma yönetimi çalışmaya devam eder. Geçici veri hatası tek başına kalıcı `safeToTrade=false` kilidi oluşturmaz.
- Eşzamanlılık yardımcısı ilk hata sonrası yeni iş başlatmaz ve başlamış işleri sonuçlanana kadar bekler; eski tick'in arka planda state değiştirme riskini azaltır.
- Binance public fallback allowlist, 429/418 bekleme penceresi, toplam istek deadline'ı ve live stale-candle koruması 2.1.14'ten devralındı.

## Testler

- Yeni `test/marketDataConcurrency.test.js`: concurrency üst sınırı, sıralı sonuçlar, hata sonrası bekleme ve argüman doğrulama.
- `test/liveEngine.test.js`: açık pozisyonun verisi ağ hatasıyla veya eski mumla bozulduğunda yeni girişlerin durması.
- 14 dosyalık çekirdek regresyon seçimi: 183/183 başarılı.
- Ayrı live + concurrency + market-data seçimi: 36/36 başarılı.
- 110 test dosyasının grup envanteri eksiksiz ve yinelenmesiz.
- Gruplu koşu toplamı: 1088 test; 1087 başarılı, 1 başarısız. Tek başarısız test `serverIntegration.test.js`; çalışma ortamında `express`, `dotenv`, `ws` bağımlılıkları eksik olduğundan test açıkça hata verdi. `npm ci` denemesi bu ortamda zaman aşımına uğradı; bu test başarılı sayılmıyor.
- 231 JavaScript dosyası `node --check` kontrolünden geçti; 0 sözdizimi hatası.

## Sınırlar

- Hummingbot tarzı sürekli WebSocket mum beslemesi + REST geçmiş tamamlama/dedup yaşam döngüsü bu sürümde henüz yoktur.
- Canlı Binance/Testnet emir akışı, gerçek bakiye ve kârlılık doğrulanmadı.
- Canlı kullanım önerilmez; varsayılan PAPER modu ve canlı işlem kilitleri değiştirilmedi.
