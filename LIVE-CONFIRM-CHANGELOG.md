# Canlı moda geçiş onay akışı

- Canlı mod seçildiğinde doğrudan mod değiştirmek yerine açık onay paneli gösterilir.
- "Gerçek para ile işlem yapılacağını anlıyorum" kutusu işaretlenmeden Tamam butonu etkinleşmez.
- Tamam akışı önce `/api/live/preflight?forTransition=1` ile canlı hedef adaptörü üzerinde ön kontrol çalıştırır.
- Herhangi bir ön kontrol başarısızsa mod PAPER kalır; arayüz başarısız kontrolleri gösterir.
- Ön kontrol başarılıysa sunucu 60 saniyelik, tek kullanımlık geçiş tokeni verir. `/api/settings` LIVE geçişinde bu token zorunludur.
- Başarılı geçişten sonra onay paneli kapanır. Canlı mod uyarısı (`modeNote`) görünür kalır ve yenileme sonrası gerçek mod sunucu durumundan çizilir.
- Bot çalışırken mod değiştirme engeli korunmuştur.

## Doğrulama

- `node --check server.js`: başarılı
- `node --check public/app.js`: başarılı
- `node --check test/serverIntegration.test.js`: başarılı
- `npm run test:server-integration`: 13/13 test başarılı
- `npm run preflight`: başarılı
- `npm test`: tüm paket tamamlanmadan zaman aşımına uğradı; bu nedenle tam test paketi için başarı iddiası yoktur.

Not: Bu değişiklik gerçek borsa/Termux ortamında denenmedi. Ön kontrolün geçmesi gerçek para ile işlem yapmanın güvenli veya kârlı olduğunu garanti etmez. Önce Binance Spot Testnet ile doğrulayın.
