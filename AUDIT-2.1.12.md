# 2.1.12 Teknik Denetim Notu

Tarih: 2026-10-24
Temel sürüm: 2.1.11
Çalışma modu: PAPER; canlı emir gönderilmedi.

## Değişiklik

Sorun: `splitCandles()` son mumun oluşmakta mı yoksa kapanmış mı olduğunu son birkaç mumun zaman farkından tahmin ediyordu. Eksik bir mum nedeniyle son farklar [1 saat, 2 saat] olduğunda medyan tahmini 2 saat seçilebilirdi. Bu, 1 saatlik son mumu yanlış sınıflandırıp sinyalin zamanlamasını etkileyebilirdi.

Çözüm:
- `splitCandles(candles, now, timeframe)` artık mevcutsa yapılandırılmış timeframe süresini kullanıyor.
- `paperEngine.js` ve `liveEngine.js` bu timeframe bilgisini açıkça geçiriyor.
- Timeframe verilmezse eski çıkarım yöntemi korunuyor.
- Yeni `test/marketDataFreshness.test.js` üç test ekliyor: gap sonrası kapanmış mum, gerçek oluşan mum ve geriye dönük uyumluluk.

## Doğrulama sonuçları

- Hedefli testler: 104/104 başarılı.
- Ayrı olarak tam çalıştırılan look-ahead, timeframe ve piyasa verisi kontrolleri: başarılı.
- Tam izole toplu test: denendi, ancak dış çalışma süresi 300 saniyeye ulaştığı için tamamlanmadı. Bu nedenle tüm test paketinin geçtiği iddia edilmiyor.
- Canlı Binance emir akışı, API anahtarları veya gerçek hesapla test edilmedi.
- Canlı işlem kilitleri, kullanıcı ayarları, risk limitleri ve kimlik bilgileri değiştirilmedi.

## Değiştirilen dosyalar

- `src/execution.js`
- `src/paperEngine.js`
- `src/liveEngine.js`
- `test/marketDataFreshness.test.js` (yeni)
- `group6` (yeni testi toplu test envanterine ekler)
- `package.json` (2.1.12)
- `test-inventory.md`
- `CHANGELOG-2.1.12-market-data-candle-split.md`

## Sonraki öncelik

Binance mum verisinin gecikme/timeout davranışı, yeniden deneme ve çoklu parite yükü üzerinde ayrı ölçüm yapılmalı. Bu değişiklik tek başına ağ zaman aşımını çözmez; kapanmış/oluşan mum sınıflandırmasındaki belirsizliği azaltır.
