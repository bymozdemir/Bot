# Hummingbot ve bu bot — ayrıntılı teknik karşılaştırma

Tarih: 2026-10-24  
İncelenenler: Hummingbot kaynak arşivi ve bot 2.1.14/2.1.15 kaynakları. İnceleme kod/mimari düzeyindedir; canlı emir veya gerçek kârlılık testi değildir.

## 1. Sonuç

Botu baştan yazmak için teknik gerekçe yok. Emir güvenliği, pozisyon kurtarma, komisyon muhasebesi, kapanmış mum sinyali ve risk kapıları gibi güçlü alanlar var. Hummingbot'tan en anlamlı aktarım, tüm framework'ü kopyalamak değil; veri akışı, throttler, geçmiş veri tamamlama ve emir takip senaryolarının tasarım ilkelerini kontrollü biçimde benimsemektir.

2.1.15'te iki somut iyileştirme uygulandı: sınırlı paralel piyasa verisi toplama ve açık pozisyon verisi eksikken yeni girişleri durdurma. Tam WebSocket candle mimarisi henüz aktarılmadı.

## 2. Mum verisi

**Hummingbot:** `CandlesBase` deque ile sınırlı geçmiş tutar, WebSocket üzerinden günceller, ilk WS mumundan sonra REST ile geçmiş mumları doldurur, timestamp sırası/eşit aralık kontrolü yapar, yeniden başlatmada ağ görevlerini yönetir. Uygun durumda aynı connector'ın throttler ve sembol haritasını paylaşabilir.

**Bu bot:** REST adaptörleri, candle şekli/interval doğrulaması, stale/future kontrolleri, closed-candle split ve son sinyal dedup var. 2.1.15'te semboller arası veri istekleri 1–8 sınırında paralel çalışabilir. Buna karşın her sembol için kalıcı candle WebSocket aboneliği, WS boşluklarını REST ile doldurma ve feed'in yeniden bağlanma yaşam döngüsü yok.

**Karar:** Piyasa verisi tarafında Hummingbot'un en büyük mimari avantajı hâlâ sürüyor. WS + REST backfill katmanı ayrı bir özellik dalı ve kaos test kampanyası olarak tasarlanmalı; tek commit ile mevcut motorun içine gömülmemeli.

## 3. Rate limit ve bağlantı dayanıklılığı

**Hummingbot:** `AsyncThrottler` ve endpoint rate limit tanımları ile aynı connector kullanan işlemlerin istek bütçesi paylaşılabilir.

**Bu bot:** HTTP retry/timeout, response-body sınırı, Binance 429/418 beklemesi, public host allowlist ve toplam public request deadline var. 2.1.15'in eşzamanlılık sınırı istek patlamasını sınırlar. Ancak endpoint ağırlıklarını hesaba katan, bütün REST çağrılarını tek bütçede toplayan genel throttler henüz yok.

**Karar:** Sıradaki veri altyapısı işi ortak endpoint-weight throttler; özellikle candle + ticker + order book çağrıları aynı bütçeden geçmeli.

## 4. Emir yaşam döngüsü ve kurtarma

**Hummingbot:** `ClientOrderTracker` aktif, cache'lenmiş ve kayıp emirleri ayrı tutar; tracking state geri yükler, order update ve trade update akışlarını işler.

**Bu bot:** Kalıcı PENDING kaydı, clientOrderId, belirsiz mutating request sonucunda UNKNOWN, kör tekrar göndermeme, kısmi fill ve komisyon idempotency, REST/WebSocket reconciliation ve stop recovery testleri var.

**Karar:** Bu botun temel emir güvenliği yeniden yazılmamalı. Hummingbot ile farklar özellikle “emir kayıp göründü ama sonra doldu”, süreç yeniden başlatma, REST/WS olay sırası ve kayıp emirlerin yaşlandırılması senaryolarıyla test edilmeli.

## 5. Risk yönetimi ve strateji

Botun portföy limiti, nakit rezervi, günlük/toplam zarar kapıları, açık pozisyon koruması ve strateji/backtest/walk-forward araçları var. Hummingbot'un connector/strategy altyapısı tek başına botun stratejilerinin daha kârlı olduğunu kanıtlamaz. Strateji kıyaslaması aynı tarih aralığı, semboller, mumlar, komisyon, slippage, emir varsayımları ve out-of-sample dönemle yapılmalıdır.

2.1.15 live motorunda bir açık pozisyonun verisi hata/eskilik nedeniyle kullanılamazsa, o tick'te yeni girişler durdurulur; sağlıklı sembollerin risk azaltıcı çıkışları engellenmez. Açık pozisyon, quote varlığı yeni seçilen borsada desteklenmiyor olsa bile döngüden sessizce atlanmaz. Bu davranışlar hedefli testlerle doğrulandı.

## 6. Ölçülmesi gerekenler

- 17+ sembol için p50/p95/p99 tur süresi.
- Sembol ve endpoint bazında timeout, HTTP 429/418, stale candle ve boş veri sayısı.
- Bağlantı kopup geldikten sonra mum sayısı/sırası/dedup doğruluğu.
- Stop izleme gecikmesi ve açık pozisyon verisi eksikken yeni alımın durması.
- Emir UNKNOWN/partial-fill/restart senaryolarında state-borsa mutabakatı.
- Aynı stratejinin walk-forward ve out-of-sample net getirisi; komisyon, kayma ve drawdown dahil.

## 7. Son karar

Mevcut botun güvenlik ve emir yaşam döngüsü güçlü temeller içeriyor; 2.1.15 veri toplama gecikmesine yönelik bir ara iyileştirme. Hummingbot ile tam mimari parite sağlanmış değildir. Canlı kullanım kararı için bağımlılıkları eksiksiz kurup testleri temiz ortamda çalıştırmak, Spot Testnet uçtan uca akışını doğrulamak ve çoklu sembol PAPER ölçümlerini tamamlamak gerekir.
