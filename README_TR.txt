Step 6 test-fixture patch — 2026-10-14

Amaç: Yeni liveTradingVerified fail-closed kapısı eklendikten sonra, canlı motorun iç davranışını sahte borsa ile test eden eski testlerin daha hedeflenen kontrole ulaşmasını sağlamak.

Değişiklikler yalnızca test/*.test.js dosyalarındadır. src/ altındaki üretim kodu ve gerçek borsa adaptörlerinin liveTradingVerified=false durumu değiştirilmemiştir.

Önemli:
- Bu yama gerçek borsaları canlıya açmaz.
- Test çiftlerinde liveTradingVerified:true, yalnızca ilgili iç akışları izole etmek için kullanılır.
- mergeRegression.test.js içindeki gerçek Binance/Binance TR/BTCTurk/Paribu adaptörleri doğrulama kanıtı yokken fail-closed kalacak şekilde beklenen sonuçlar güncellenmiştir.
- Bu paket test dosyaları için uyumluluk yamasıdır; tüm testlerin geçtiği iddiası değildir. Uyguladıktan sonra hedefli testleri ve ardından npm run test:batched komutunu yeniden çalıştırın.
