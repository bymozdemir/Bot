# Windows'ta çalıştırma (1.8.0 FINAL)

1. Node.js 18+ kur (LTS önerilir), proje klasöründe PowerShell veya cmd aç.
2. `npm install`
3. `npm start` ilk açılışta panel şifresini (en az 12 karakter) ve Telegram bilgilerini sorar; `.env` dosyasını kendisi oluşturur.
5. `npm test` — artık Windows'ta da çalışır (`scripts/runTests.js`).
6. `npm start` veya `scripts\start-windows.cmd` (çökerse otomatik yeniden başlatır).

## 1.8.0 FINAL'de giderilen Windows sorunları
- `npm test`: `NO_COLOR=1 node --test test/*.test.js` cmd/PowerShell'de çalışmazdı → çapraz platform çalıştırıcı.
- Dosya kaydı: `state.json`/`auth.json`/`credentials.enc.json` yazılırken `rename` antivirüs/indeksleyici yüzünden
  `EPERM/EBUSY` verebilir ve tick'i/sunucuyu çökertirdi → tekrar deneme + copy yedeği + fsync.
- `scripts/testClock.js`: boşluk içeren kullanıcı yolu (örn. `C:\Users\Ali Veli\...`) `NODE_OPTIONS` içinde bozuluyordu → tırnaklandı.
- `state.json` bozulursa artık `state.json.bak` yedeğinden devam edilir (kill switch ve canlı pozisyon kaydı kaybolmaz).

## İpuçları
- Proje klasörünü OneDrive/Dropbox senkron klasörüne KOYMA; dosya kilitleri artar. `BOT_DATA_DIR` ile veriyi dışarı al (örn. `C:\bot-data`).
- Windows Defender'da proje ve veri klasörünü hariç tutmak kilit hatalarını azaltır.
- Saat senkronu: Ayarlar → Saat → "Şimdi senkronize et". Binance imzalı isteklerde saat sapması ±5 sn'yi aşarsa emir reddeder (bot artık Binance sunucu saatine göre düzeltir).
