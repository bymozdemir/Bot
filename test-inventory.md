# Test Envanteri ve Doğrulama Raporu

Son doğrulama tarihi: 2026-10-24  
Proje: Binance USDT Trading Bot  
Sürüm: 2.1.15  
Varsayılan mod: PAPER

## 2.1.15 güncel doğrulama

- Test dosyaları: 110/110; `group0`–`group6` listelerinde her dosya tam bir kez bulunuyor, eksik/çift referans yok.
- Gruplu test toplamı: 1088 test; 1087 başarılı, 1 başarısız.
- Tek başarısız test: `test/serverIntegration.test.js`; `express`, `dotenv` ve `ws` bağımlılıkları bu çalışma ortamında kurulamadığı için açıkça başarısız oluyor. `npm ci` denemesi zaman aşımına uğradı. Bu test başarılı olarak sayılmıyor.
- Grup 0: `--test-force-exit` ile 138/138 geçti; bu grupta test süreci açık handle bırakabildiği için normal çıkış ayrıca temizlenmeli.
- Çekirdek regresyon seçimi (14 dosya): 183/183 başarılı.
- Live motor + bounded-concurrency seçimi: 36/36 başarılı.
- JavaScript sözdizimi: 231 dosya, 0 hata (`node --check`).
- Offline preflight: başarılı; 17 strateji varsayılanı geçerli, PAPER varsayılanı ve canlı işlem kilidi kapalı.
- Gerçek Binance/Testnet emir akışı, gerçek bakiye ve kârlılık doğrulanmadı.

## 2.1.15 yeni kapsam

- PaperEngine mum verisi için sınırlı eşzamanlılık.
- LiveEngine candle/ticker ön toplaması; strateji/emir kararı sıralı.
- Açık pozisyonun piyasa verisi eksik veya stale ise aynı tick'te yeni girişleri durdurma.
- Concurrency sınırı, sonuç sırası, hata sonrası worker davranışı için `test/marketDataConcurrency.test.js`.
- Açık pozisyon verisi ağ hatası veya stale candle ile bozulduğunda yeni alım kapısı için iki LiveEngine testi.

---

## Tarihsel doğrulama kayıtları (güncel sürüm sonucu yerine kullanılmamalı)

## Önceki tam toplu test sonucu (2.1.11)

- Test dosyaları: 108/108
- Toplam test: 1083
- Başarılı: 1083
- Başarısız: 0
- Atlanan: 0
- Çalıştırma: İzole toplu test
- Sonuç: BAŞARILI

## 2.1.12 değişiklik doğrulaması

- Yeni test dosyası: `test/marketDataFreshness.test.js` (3 test)
- Hedefli testler (mum sınıflandırma, engine, timeframe, ağ fallback, look-ahead): 104/104 başarılı.
- Tam toplu test: bu rapor oluşturulurken henüz çalıştırılmamış.

## Önceki doğrulama

Önceki tam test sonucu: 1081/1081 başarılı.
Güncel tam test sonucu: 1083/1083 başarılı.

İki ek OCO testinin toplam test sayısına dahil olduğu
ayrıca hedefli test çalıştırmasıyla da doğrulandı.

## Hedefli testler

- exchangeSafety.test.js
- binanceTestnetOptIn.test.js
- mergeRegression.test.js
- Son bildirilen hedefli sonuç: 34/34 başarılı

Not: Hedefli testler tam toplu test toplamına tekrar eklenmez.

## Sınırlar ve henüz kanıtlanmamış noktalar

- Test başarısı, canlı işlem güvenliğinin kesin kanıtı değildir.
- Genel Binance Spot Testnet bağlantısı başarılıydı.
- API anahtarlarıyla özel uç noktalar ve gerçek Testnet emir akışı
  ayrıca doğrulanmalıdır.
- Canlı ortamda emir gönderiminin doğrulandığı iddia edilmemektedir.

## 2.1.13 piyasa verisi ve API dayanıklılığı doğrulaması

- İlgili hedefli testler: 159/159 başarılı (11 test dosyası).
- `node --check`: 229 JavaScript dosyasında sözdizimi hatası yok.
- Test envanteri: 109/109 test dosyası gruplara birer kez dahil; eksik/çift referans yok.
- Yeni kapsam: Binance 429/418 rate-limit davranışı, toplam public API süre bütçesi, live stale/future candle reddi.
- Tam test paketi çalıştırılmadı: `npm ci --offline`, `ws` paketi önbellekte bulunmadığı için başarısız oldu.
- Canlı emir akışı ve kârlılık doğrulanmadı.


## 2.1.14 public fallback host allowlist doğrulaması

- Yeni regresyon: `BINANCE_PUBLIC_FALLBACKS` yalnızca resmî Binance public hostlarını kabul eder.
- Ağ fallback / market-data freshness / no-lookahead / timeframe: 42/42 başarılı.
- Engine / live engine / execution / order manager / market safety / portfolio policy: 118/118 başarılı.
- Tam test paketi ve server entegrasyon testi bu ortamda tamamlanmadı/bağımlılıkları kurulamadı; bu testler başarılı olarak sayılmıyor.
