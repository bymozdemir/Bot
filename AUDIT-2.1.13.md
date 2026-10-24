# Sürüm 2.1.13 — Birleşik kaynak denetimi

Tarih: 2026-10-24
Temel kaynak: Kullanıcının yüklediği `bot-2.1.12-market-data-fix.zip`
Referans kaynak: Kullanıcının yüklediği `hummingbot-master.zip`
Mod: kaynak kodu denetimi ve izole testler; gerçek borsaya emir gönderilmedi.

## İncelenen alanlar
- Proje envanteri, paket tanımları, test grup dosyaları ve kurulum/çalışma yönergeleri.
- Binance REST adaptörü, public host fallback davranışı ve `fetchWithRetry`.
- `execution.js` mum doğrulama/sınıflandırma yardımcıları.
- Paper ve live motorlarının mum verisi kontrolü ve sinyal tazeliği.
- Emir yöneticisi, kısmi dolum ve emir belirsizliği testlerinden seçili regresyon kapsamı.
- Hummingbot `CandlesBase` mimarisinin geçmiş veri + WebSocket, paylaşılan throttler ve bağlantı yaşam döngüsü yaklaşımı.

Bu, tüm dosyaların envanterinin ve JavaScript sözdiziminin tarandığı; ilgili modüllerin ayrıntılı incelendiği bir denetimdir. Hummingbot'ın bütün Python/Cython uygulamasının satır satır yeniden yazımı veya tüm özelliklerinin bu botta yeniden uygulanması değildir.

## Uygulanan değişiklikler

### 1. Binance HTTP 429 / 418 davranışı
- 429 rate-limit yanıtında `Retry-After` saniye veya HTTP tarihi olarak okunur.
- 429 ve 418 yanıtları için başka public hostlara failover yapılmaz. Aynı IP'yi etkileyen limit/ban sırasında host değiştirerek daha fazla istek gönderilmesi önlenir.
- `Retry-After` yoksa 429 için 5 saniye, 418 için 5 dakika geçici bekleme uygulanır. Bu yalnızca süreç içi korumadır; süreç yeniden başlatılırsa bellek içi bekleme sıfırlanır.
- `fetchWithRetry` varsayılanı değişmeden kalır; Binance public çağrısı 429 otomatik retry davranışını açıkça kapatır.

### 2. Toplam public istek süresi
- Host başına timeout'ların toplamda uzun bir zincire dönüşmesini engellemek için `_publicGet` varsayılan 22 saniyelik toplam süre bütçesi kullanır.
- Kalan bütçe dolduğunda yeni host denenmez ve `PUBLIC_API_DEADLINE` hata kodu verilir.

### 3. Live mum tazeliği
- Live motoru, Paper motorunda zaten olan yaş/future timestamp kontrollerini sinyal değerlendirmesinden önce uygular.
- Eski veya belirgin şekilde gelecekte zaman damgalı mum serisi reddedilir; bu seriden alım sinyali üretilmez.

## Doğrulama sonuçları
- 11 ilgili test dosyası: 159/159 başarılı.
- `node --check`: 229 JavaScript dosyası, 0 sözdizimi hatası.
- 109 test dosyası grup envanterinde eksiksiz ve yinelenmeden listeleniyor.
- Tam test paketi çalıştırılmadı: ortamda `node_modules` yoktu; `npm ci --offline` npm önbelleğinde `ws` paketi bulunmadığı için başarısız oldu.
- Canlı Binance/Testnet emir akışı, API anahtarları, gerçek bakiye ve gerçek piyasa performansı test edilmedi.

## Kalan önemli mimari fırsat
Hummingbot'ın kalıcı WebSocket mum akışı, REST geçmiş mum tamamlama ve paylaşılan API throttler yapısı bu sürüme taşınmadı. Bunlar sadece bir HTTP yardımcı fonksiyonu değişikliği değildir; soket yaşam döngüsü, yeniden bağlanma, mum sıralama/dedup, state geçişi ve her sembol/timeframe için abonelik yönetimi gerektirir. Güvenli biçimde ayrı bir mimari değişiklik ve paper/stress test kampanyası olarak ele alınmalıdır.

## Operasyon notu
Bu ZIP'i mevcut çalışan bot klasörünün üzerine doğrudan açmayın. Önce Termux'ta botu durdurup `data/` ve `.env` dosyalarını ayrı yedekleyin; bu sürümü ayrı klasörde kurup test edin. ZIP, mevcut state veya API anahtarlarını içermemelidir.
