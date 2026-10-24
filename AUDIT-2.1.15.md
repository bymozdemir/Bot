# Teknik denetim — Bot 2.1.15

Tarih: 2026-10-24  
Temel sürüm: 2.1.14  
Kapsam: Hummingbot veri akışı/emir izleme mimarisi ile karşılaştırma; market-data çağrı akışı; paper/live giriş kapıları; test ve kaynak envanteri.

## Özet karar

2.1.15, 2.1.14'e göre somut bir piyasa-verisi dayanıklılığı düzeltmesi içerir. Paper motoru ve live motoru için sınırlandırılmış eşzamanlı veri toplama eklenmiştir. Live tarafta risk/emir kararları yine sıralı çalışır. Açık pozisyonun piyasa verisi eksik veya eskiyse yeni girişler o tur durur.

Bu sürüm kusursuz veya canlı kullanıma hazır olarak sınıflandırılamaz. Tam suite içindeki server entegrasyon testi bağımlılık eksikliği yüzünden doğrulanamadı; gerçek Binance/Testnet emir akışı çalıştırılmadı.

## 2.1.15 değişiklikleri

### P1 — Sıralı veri toplama darboğazı

Önceki PaperEngine, sembollerin mum verisini tek tek bekliyordu. 17+ sembollü listede tek bir yavaş endpoint, sonraki sembollerin işlenmesini geciktirebilirdi. `mapWithConcurrency` ile sınırlı iş kuyruğu eklendi; varsayılan 4 eşzamanlı sembol, üst sınır 8. Emirler/pozisyon güncellemeleri paralelleştirilmedi.

LiveEngine artık uygun sembollerin candle + ticker verilerini önceden alır; doğrulama ve strateji/emir kararları seri sırada kalır. `Promise.allSettled` kullanımı, aynı sembole ait isteklerden biri erken hata verince diğer isteğin sınırsız şekilde işçi yuvası dışında kalmasını engeller.

### P1 — Açık pozisyon verisi bozulduğunda yeni risk

Önceden bir açık pozisyonun piyasa verisi alınamasa bile diğer sembollerde yeni alım değerlendirmeleri devam edebilirdi. Live tick artık ön toplama sırasında ağ hatası, boş/bozuk mum, stale/future timestamp veya geçersiz ticker görürse bu tur yeni girişleri durdurur. Sağlıklı semboller hâlâ değerlendirilir; mevcut pozisyonun koruyucu stop'u kaldırılmaz ve geçici veri hatası tek başına kalıcı güvenlik kilidine dönüştürülmez. Açık pozisyon, quote varlığı yeni seçilen borsada desteklenmiyor olsa bile döngüden sessizce atlanmaz.

### Devralınan korumalar

- Public Binance fallback tam host allowlist'i.
- HTTP 429/418'de host değiştirerek istek yağdırmama ve Retry-After beklemesi.
- Public API host failover zincirinde toplam süre bütçesi.
- Live mum tazeliği ve gelecek zaman damgası denetimi.
- Belirsiz emir sonucunda kör tekrar göndermeme, kalıcı PENDING ve mutabakat korumaları.

## Test ve statik doğrulama

- JavaScript sözdizimi: 231 dosya, 0 hata.
- Test dosyaları: 110; grup envanterinde 110/110, eksik/çift kayıt yok.
- Çekirdek regresyon seçimi: 183/183 başarılı.
- Live + concurrency seçimi: 36/36 başarılı.
- Gruplu testler: 1088 test; 1087 pass, 1 fail. Tek başarısız `test/serverIntegration.test.js` olup açık hata `express`, `dotenv`, `ws` eksikliği. `npm ci` denemesi çalışma ortamında zaman aşımına uğradı; bu testin sonucu doğrulanmamış sayılır.
- Grup 0'da testler 138/138 geçti; bu grup test süreci açık handle bırakabildiğinden `--test-force-exit` ile özet alınmıştır.
- `npm ls --depth=0` başarılı değil; bağımlılık dizini kısmen oluşmuş ve eksik/uyumsuz. Arşive `node_modules` eklenmemiştir.

## Hummingbot ile mimari parite

| Bileşen | Bu bot | Hummingbot yaklaşımı | Karar |
|---|---|---|---|
| Mum verisi | REST polling; 2.1.15'te bounded concurrency | Kalıcı WS candle listener + REST historical fill | Kısmi parite; WS mimarisi ayrı iş |
| API limitleri | HTTP 429/418 cooldown, timeout/retry, sınırlı paralellik | Paylaşılan throttler ve endpoint limit tanımları | Kısmi; ortak ağırlıklı request budget yok |
| Mum geçmişi/boşluk | REST'ten son seri ve candle doğrulama | WS başlangıcından geçmişi doldurma, zaman sıralama/eşit aralık denetimi | Kısmi; kalıcı gap-fill/dedup katmanı yok |
| Emir izleme | PENDING, clientOrderId, UNKNOWN, fill muhasebesi, reconciliation | Active/cached/lost emir takibi, restore ve geç dolum işleme | İşlevsel korumalar güçlü; lost-order/cache davranışı birebir aynı değil |
| Koruyucu stop ve risk | Borsa stopları, recovery, kill switch, yeni giriş kapısı | Connector ve order tracker üzerinden emir yaşam döngüsü | Doğrudan mimari aktarım yerine test/parite yaklaşımı uygun |
| Strateji araştırması | Backtest, walk-forward, maliyet ve portfolio policy araçları | Strateji/controller ve connector ekosistemi | Farklı amaçlar; kârlılık sadece ortak veriyle OOS testte karşılaştırılmalı |

## Açık kalan P1/P2 işleri

1. Sürekli Binance Spot WebSocket candle feed'i, reconnect/backoff, REST bootstrap/gap-fill, timestamp dedup ve sıra kontrolü.
2. Binance ağırlıklı endpoint bazlı ortak rate-limit/throttler; REST ve WS yeniden bağlanma yükünü birlikte kontrol etme.
3. `npm ci` ile bağımlılıkları temiz ortamda kurup server entegrasyon testini ve normal `npm test` akışını tekrar çalıştırma.
4. Binance Spot Testnet'te ayrı test anahtarlarıyla create/query/cancel/fill/partial-fill/restart akışını uçtan uca doğrulama.
5. 17+ sembollü PAPER testte önce/sonra tur süresi, timeout oranı, 429 oranı ve veri tazeliğini ölçme. Şu an performans kazancı mimari gerekçedir; gerçek piyasa ölçümü değildir.
6. Çoklu zaman dilimi stratejisini ayrı bir deney olarak OOS/walk-forward + komisyon/kayma ile test etme; aynı mum verisinden gelecek bilgi sızıntısını dışlama.

## Güvenlik sınırları

- PAPER varsayılanı ve canlı işlem güvenlik kapıları değiştirilmedi.
- API anahtarı, `.env`, `data/` veya kullanıcı state'i arşive eklenmedi.
- Gerçek emir gönderilmedi; canlı kârlılık veya güvenlik garantisi verilmez.
