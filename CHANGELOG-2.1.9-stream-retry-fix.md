# 2.1.9 — stream-retry-fix

## Düzeltilen hatalar

1. **Akış (User Data Stream) başlatılamayınca bot "çalışıyor" görünüp işlem yapmıyordu.**
   İlk başlatmada akış bağlanamazsa (ör. `-2015 Invalid API-key, IP, or permissions for action`) akış nesnesi kendini
   "çalışıyor" diye işaretli bırakıyordu. Kullanıcı tekrar "başlat" deyince `start()` hiç bağlanmadan dönüyor, motor
   açılıyor ama akış bağlı olmadığı için her turda "User Data Stream bağlı değil" kilidiyle yeni giriş vermiyordu.
   Artık başarısız ilk bağlantıda akış durdurulur (`src/userDataStream.js`) ve motor da akışı kapatır
   (`src/liveEngine.js`); sonraki "başlat" gerçekten yeniden bağlanır.
2. **"Canlı başlangıç güvenli değil: emir/bakiye mutabakatı tamamlanamadı" mesajı nedeni göstermiyordu.**
   Mesaja ve panelin kilit nedenine artık ilk gerçek neden yazılır (ör. "Bakiye sorgulanamadı: …",
   "SOL: unexpected_asset_balance (beklenen 0, borsada 500)").
3. **`-2015` hatası için ipucu.** Akış hatası -2015 ise mesaj; ortam (BINANCE_ENV=testnet), yetki, IP kısıtı ve
   kasadaki eski anahtar kontrolünü hatırlatır.
4. **Testnet baseline sonradan eklenen pariteler için de çalışır.** Baseline bir kez kaydedildikten sonra yeni parite
   eklenirse o coinin testnet başlangıç bakiyesi "beklenmeyen bakiye" sayılıp canlı işlem sonsuza dek kilitleniyordu.
   Artık yalnızca testnet'te, kill switch kapalıyken, tek hata bakiye uyuşmazlığıyken, sahipsiz/bilinmeyen emir
   yokken ve o coine ait yerel pozisyon/emir kaydı hiç yokken, baseline'da olmayan varlık eklenir.

## Testler
`test/streamStartRetry.test.js` (5 test). İlgili mevcut testler (canlı motor, recovery, mutabakat, akış, kaos,
emir yöneticisi) geçti. `express`/`ws` paketleri bu ortamda kurulu olmadığı için sunucu entegrasyon testleri
(serverIntegration, httpBodyTimeout) çalıştırılamadı; Termux'ta `npm ci` sonrası `npm run test:server-integration`
ile çalıştırılmalı.

## Not
Bu paket gerçek para için onaylı değildir; yalnızca kağıt modu ve Binance Spot Testnet içindir.
