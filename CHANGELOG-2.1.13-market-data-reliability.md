# 2.1.13 — Piyasa verisi ve API dayanıklılığı

## 2.1.12'den devralınan düzeltme
- `splitCandles(candles, now, timeframe)` bilinen mum süresini kullanır; veri boşluğu olduğunda medyan aralık yanlış zaman dilimi seçmez.

## Bu sürümdeki ek iyileştirmeler
- Binance public API HTTP 429 yanıtında `Retry-After` dikkate alınır; aynı IP için alternatif hostlara geçip ek istek yağdırılmaz.
- Binance public API HTTP 418 IP engeli yanıtında host failover yapılmaz ve istekler için geçici ortak bekleme penceresi kurulur.
- Public API isteğinin bütün host failover/tekrar zinciri varsayılan 22 saniyelik toplam süre bütçesiyle sınırlanır. Bir istek her host için ayrı ayrı süre harcayıp çok uzun sürmez.
- Live motoru, Paper motoruyla aynı stale/future mum kontrollerini uygular; eski veya belirgin biçimde gelecek zaman damgalı mumlar strateji sinyaline ilerlemez.
- 429, 418, toplam istek süresi, eski mum ve gelecek mum senaryoları için regresyon testleri eklendi.

## Güvenlik
- API anahtarları, state dosyaları ve kullanıcı ayarları değiştirilmedi.
- Canlı emir gönderilmedi; canlı işlem doğrulama kilitleri değiştirilmedi.
- 429/418 sırasında güvenli tarafta kalmak için istekler bekletilir/hata ile sonlandırılır; bekleme penceresinde yeni public istek gönderilmez.

## Doğrulama
- İlgili 11 test dosyasında 159/159 test başarılı.
- `node --check` ile 229 JavaScript dosyası sözdizimi kontrolünden geçti.
- 109 test dosyasının tümü test gruplarına birer kez dahil; eksik veya yinelenen grup referansı bulunmadı.
- Tam test paketi bu ortamda çalıştırılmadı. Bağımlılık kurulumu `npm ci --offline` sırasında `ws` paketi npm önbelleğinde bulunmadığı için tamamlanamadı. Bu nedenle tam test paketinin geçtiği iddia edilmez.
- Binance canlı/Testnet emir akışı veya kârlılık testi yapılmadı.
