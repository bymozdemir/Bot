# Güvenlik ve Kaos Denetimi — 2026-10-22

## Kapsam ve sınırlar

- Proje sürümü: `2.1.7-testnet-gate`.
- 106 test dosyasının tamamı `scripts/runTestsBatched.js` ile çalıştırıldı.
- Denetim sırasında gerçek hesap API anahtarı kullanılmadı; gerçek veya Testnet emri gönderilmedi.
- Bu ortamda DNS/ağ erişimi sınırlı olduğundan gerçek Binance Spot Testnet entegrasyonu doğrulanamadı.

## Bulunan ve düzeltilen güvenlik açıkları

### 1. Binance REST URL'sinde HTTPS zorunlu değildi — DÜZELTİLDİ

Önceki sürüm, `http://api.binance.com` adresini doğru hostname olduğu için kabul ediyordu. İmzalı REST çağrıları API anahtarı başlığı ve imza taşıdığı için düz HTTP, ağ üzerinde gizlilik/bütünlük riski oluşturabilirdi.

Düzeltme:
- Resmî Binance REST adreslerinde HTTPS zorunlu.
- URL kullanıcı adı/şifre, ek path/query/fragment veya beklenmeyen port içeriyorsa reddediliyor.
- HTTP ve özel port yalnızca açıkça etkinleştirilmiş yerel test sunucusunda kabul ediliyor.
- Kullanılmayan `skipBaseUrlCheck` geçişi kaldırıldı.

### 2. WebSocket URL override ortamlar arasında geçiş yapabiliyordu — DÜZELTİLDİ

Önceki kontrol Binance alan adlarına izin veriyor, ancak `BINANCE_ENV=testnet` iken üretim WebSocket hostname'ini de kabul edebiliyordu.

Düzeltme:
- Testnet için yalnızca `ws-api.testnet.binance.vision`.
- Üretim için yalnızca `ws-api.binance.com`.
- Kimlik bilgisi, özel port, query veya fragment içeren override reddediliyor.

### 3. Testnet canlı izin kapısı URL protokolünü tek başına doğrulamıyordu — SERTLEŞTİRİLDİ

İzin yardımcısı artık yalnızca HTTPS, tam Testnet hostname'i ve kök URL kabul ediyor; kullanıcı bilgisi, özel port, path, query ve fragment kabul etmiyor. Bu, adaptör doğrulamasına ek savunma katmanıdır.

## Test sonuçları

### Tam test paketi

- 106/106 test dosyası çalıştırıcı tarafından bulundu ve işlendi.
- Tam paket ilk çalıştırma sonucu: **1.072 test; 1.070 başarılı, 2 başarısız**.
- Başarısızlardan biri `securityFixes193.test.js` içindeki olay döngüsü gecikme eşiğiydi (665 ms). Dosya daha sonra iki ayrı tekil çalıştırmada da **16/16 geçti**; bu sonuç yük altında zamanlama hassasiyetine işaret ediyor.
- Diğer başarısız test `serverIntegration.test.js`: `express`, `dotenv` ve `ws` bağımlılıkları bu denetim ortamında kurulu değildi. `npm ci` tamamlanamadığı için gerçek HTTP/WebSocket sunucu entegrasyonu doğrulanamadı. Bu test başarılı sayılmıyor.

### Ek doğrulamalar

- `node scripts/offlinePreflight.js` — BAŞARILI; varsayılan mod `paper`, canlı kilit kapalı.
- JavaScript dosyalarının tamamında `node --check` — BAŞARILI.
- Binance URL/ortam/güvenlik odaklı üç test dosyası — **32/32 geçti**.
- `test/backtest.cli.test.js` — **5/5 geçti** (uzatılmış tekil çalışma).
- `test/paperRedTeam4.test.js` — **3/3 geçti** (30 günlük sentetik kaos senaryosu).
- `test/parity.test.js` — **7/7 geçti** (uzatılmış tekil çalışma).
- Paper fuzz — **1.000.000 adım geçti**; 62.231 yeniden başlatma/serileştirme olayı, 658.513 kilit gözlemi ve 100 işlem yolu.
- 720 günlük sentetik paper kaosu — 17.280 saat; 881 yeniden başlatma, 669 sentetik kesinti, 325 kasa birimi değişimi, 9 alış ve 7 satış yolu doğrulandı.
- Portföy politikası fuzz — **1.000.000 adım geçti**; 493.611 izin ve 506.389 ret kararı.
- User Data Stream yarış stresi — **100/100 yineleme geçti**, sızıntı yapan açık socket gözlenmedi.
- Binance Spot Testnet preflight — `EAI_AGAIN`; DNS/ağ erişimi yoktu. Emir gönderilmedi.

## Kalan doğrulama işleri

1. Bağımlılıkları ağ erişimi olan ortamda `npm ci` ile kurup `npm run test:server-integration` testini çalıştırın.
2. Resmî Binance Spot Testnet API anahtarlarıyla, gerçek hesaptan tamamen ayrı olarak bakiye/alış/koruyucu stop/iptal/yeniden başlatma-kurtarma akışını uçtan uca doğrulayın.
3. `securityFixes193.test.js` içindeki olay döngüsü zamanlama testi daha az ortama bağımlı olacak şekilde iyileştirilmeli; tekil çalıştırmalarda geçti ama tam pakette bir kez eşik aşıldı.

## Güvenlik kararı

Bu denetim üretim canlı işlemine geçiş onayı değildir. `liveTradingVerified` üretim için doğrulanmış değildir; üretim canlı işlem kapalı kalmalıdır. Spot Testnet uçtan uca doğrulaması ve sunucu entegrasyon testi tamamlanmadan gerçek emir verilmemelidir.
