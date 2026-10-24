# Crypto Bot

**Amaç:** Güvenli Paper mod geliştirme ve doğrulaması. **Canlı işlem bu pakette onaylanmış değildir; canlı işlem kilidi kapalı kalmalıdır.**

## Kurulum ve ilk doğrulama

Gereksinim: Node.js 18 veya üstü.

```sh
npm ci
npm audit
npm run preflight
npm run test:batched
npm run test:clock
npm run test:server-integration
npm run testnet:preflight
```

Testlerden biri başarısızsa atlandıysa veya ortam nedeniyle çalıştırılamadıysa bunu başarı olarak değerlendirmeyin. `npm ci` ve `npm audit` ağ erişimi olan temiz bir ortamda tamamlanmalıdır. Sonuçları tarihli raporlarla karşılaştırmak yerine, bu pakette yeniden çalıştırılmış sonuçları esas alın.

## Çalıştırma

```sh
npm install
npm start
```

**İlk kurulum otomatiktir.** `npm start` ilk açılışta (etkileşimli terminalde) eksik bilgileri sırayla sorar ve `.env` dosyasını kendisi oluşturur:

1. **Panel şifresi** (en az 12 karakter, yazarken görünmez) → `data/auth.json` içine özet olarak kaydedilir.
2. **Telegram** (isteğe bağlı): BotFather token'ı doğrulanır; chat ID boş bırakılırsa bota yazdığın ilk mesajdan otomatik bulunur; test mesajı gönderilir. Bilgiler `.env` içine (izin 600) yazılır.

Sonraki açılışlarda hiçbir şey sorulmaz. Bilgileri değiştirmek için `npm run setup`, sihirbazsız doğrudan başlatmak için `npm run start:direct`. Terminal yoksa (Termux:Boot, systemd, Docker) hiçbir şey sorulmaz. Gerçek API anahtarlarını ZIP'e, loglara veya hata raporlarına eklemeyin.


## Binance Spot Testnet'e kontrollü geçiş

Testnet emirleri üretim hesabından ayrıdır. Testnet için ayrı API anahtarları oluşturun; gerçek hesap anahtarlarını kullanmayın. Üretim adaptörü doğrulanmış ilan edilmez ve üretim emirleri güvenlik kilidinde kalır. Testnet emri göndermek için üç koşul birlikte gerekir; bunları yalnızca kendi cihazınızdaki `.env` dosyasına ekleyin:

```dotenv
BINANCE_ENV=testnet
ALLOW_BINANCE_TESTNET_TRADING=true
LIVE_TRADING_ENABLED=true
```

Ayrıca panelde çalışma modu `live` seçildiğinde bu ayarlar **yalnızca resmi `testnet.binance.vision` adresini** kabul eder. `BINANCE_ENV=production` veya farklı bir hostname ile `liveTradingVerified=false` güvenlik kilidi üretim emirlerini engellemeye devam eder. İlk olarak `npm ci`, ardından `npm run testnet:preflight` çalıştırın. Preflight yalnızca herkese açık saat uç noktasını okur; API anahtarı doğrulamaz ve emir göndermez. Testnet erişimi, API kimlik doğrulaması, küçük emir, koruyucu stop, satış/iptal ve yeniden başlatma kurtarması doğrulanmadan gerçek hesaba geçmeyin.

Kaos testleri hızlı varsayılanlarla çalışır. Daha uzun stres koşusu için: `CHAOS_ORDER_ITERATIONS=400 CHAOS_TEST_ITERATIONS=300 CHAOS_MULTI_ITERATIONS=250 node --test test/chaosCampaign.test.js`.

## Güvenlik durumu

- Varsayılan kullanım Paper modudur.
- Canlı işlem için gereken borsa sözleşmesi ve kurtarma doğrulaması tamamlanmış değildir. Gerçek hesap/sandbox emir akışları doğrulanmadan canlı işlem açılmamalıdır.
- Paribu emir kimliği/kurtarma denetimi `identity=false` durumundadır; Paribu canlı işlemi kullanmayın.
- Bu yazılım kâr garantisi vermez.

## Borsalar ve yetenekler

Borsa desteği tek bir listeyle sınırlı değildir: her adaptörün piyasa verisi, emir oluşturma, emir sorgulama, iptal, kimlik eşleştirme ve kurtarma davranışı ayrı ayrı doğrulanmalıdır. Kodda adaptör bulunması canlı emir akışının doğrulandığı anlamına gelmez. Güncel yetenek ve doğrulama durumu için `docs/EXCHANGE_CAPABILITY_MATRIX.md` dosyasına bakın.

## Test listeleri

`group0`–`group6` dosyaları `npm run test:batched` tarafından kullanılır; silmeyin veya test dosyası eklerken güncellemeyi unutmayın. Testler bağımlılık gerektiriyorsa önce `npm ci` tamamlanmalıdır.

## Telegram

Telegram komutları yalnızca `.env` içinde doğru `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` tanımlandığında etkinleşir. Yalnızca tanımlı chat kimliği yanıt alır.

| Komut | İşlev |
|---|---|
| `/basla`, `/bitir` | Paper motorunu başlat / durdur (`/bitir` canlıda da durdurur) |
| `/durum`, `/bakiye` | Durum, nakit ve açık varlıklar (**canlı modda gerçek hesap/pozisyon kayıtlarından**) |
| `/rapor` | Getiri, kazanma oranı, kâr faktörü |
| `/islemler [adet]` | Son kapanan işlemler (varsayılan 5, en fazla 15) |
| `/pozisyonlar` | Açık pozisyonlar: giriş, güncel fiyat, açık K/Z, stop seviyesi, süre (canlıda borsada stop emri var mı) |
| `/loglar [adet\|hata]` | Son log kayıtları (varsayılan 10, en fazla 25); `hata` yalnızca hata/uyarı |
| `/ayarlar` | Risk limitleri, takip edilen coin sayısı, bildirim kanalları (salt-okunur) |
| `/ozet` | Günlük özeti şimdi gönder |
| `/sessiz [saat\|kapat\|durum]` | Rutin bildirimleri sessize al (varsayılan 2 saat, 0.25–24); kritik uyarılar yine sesli gelir |
| `/coinler` | Takip edilen coinler ve durumları |
| `/coin_ekle PEPE/USDT` | Coin ekleme sihirbazı |
| `/coin_sil PEPE/USDT` | Coini sil (onay ister; açık pozisyon son fiyattan kapatılır) |
| `/coin_durdur`, `/coin_ac` | Coinde yeni alımı durdur / yeniden aç |
| `/onayla`, `/iptal` | Bekleyen ekleme/silme işlemini onayla / iptal et |

Coin ekleme, silme, durdurma ve açma yalnızca Paper modda çalışır; ayarlar `/onayla` gelmeden kaydedilmez. Telegram canlı işlem başlatamaz ve manuel alım/satım emri veremez. Uzun yanıtlar 4096 karakter sınırında otomatik bölünür.

### Otomatik bildirimler

Öncelik: **kritik** mesajlar sesli gelir, kuyrukta öne geçer, ağ/429 hatasında 4 kez yeniden denenir ve sessiz modda da sesli kalır. Kritik mesaj 4 denemede de gönderilemezse (internet yok) **kaybolmaz**: kalıcı kuyruk dosyasına yazılır (en fazla 20 bekleyen kritik/önemli mesaj) ve yeniden başlatmada geri yüklenir; bağlantı gelince `⏱ Gecikmeli bildirim (olay: ...)` önekiyle iletilir. **Normal** mesajlar sesli (sessiz modda sessiz), **rutin** mesajlar her zaman sessiz iletilir. Mesajlar HTML biçimlidir; Telegram biçimi reddederse düz metne düşülür.

| Mesaj | Ne zaman | Öncelik |
|---|---|---|
| 🔄 Bot açıldı | Süreç her açıldığında; önceki kapanış **temiz / beklenmedik (çökme, elektrik, kill) / ilk açılış**; ilk açılış değilse **son aktif zaman ve kesinti / kapalı kalma süresi** | normal (beklenmedik: kritik) |
| ⏻ Bot süreci kapatılıyor | SIGINT/SIGTERM ile kapanırken (açık pozisyon uyarısıyla) | normal |
| ⏹ Bot / Canlı bot durduruldu | Motor panelden, Telegram dışı yollarla veya hatayla durunca (açık pozisyon uyarısıyla) | normal |
| ▶ Bot / Canlı motor başlatıldı | Motor başlayınca | rutin |
| 🟢 ALIM · 🟢/🔴 SATIM | Paper alım/satım: fiyat, miktar, harcanan, kalan, komisyon, giriş→çıkış, K/Z %, süre, sebep | normal |
| 🟢 CANLI ALIM | Fiyat, miktar, harcanan, koruyucu stop (%), kâr eşiği, sebep | normal |
| 🟢/🔴 CANLI SATIM / KISMİ SATIM | Giriş→çıkış, K/Z ve %, süre, sebep, kalan miktar (acil çıkış: kritik) | normal |
| 🛑 STOP-LOSS TETİKLENDİ · 🎯 TAKE-PROFIT GERÇEKLEŞTİ | **Borsadaki** koruyucu emir doldu (tam/kısmi dolum) | kritik |
| 🛑 KILL SWITCH · ⛔ günlük zarar limiti | Paper ve **canlı**: sebep, özkaynak, kapatılacak pozisyonlar; canlıda ayrıca "Kill switch sonucu" | kritik |
| 🔒 CANLI İŞLEM KİLİTLENDİ | **Sebep yazılı** (mutabakat, stream, stop kaydı…) ve açık pozisyonlar | kritik |
| 🔓 Canlı işlem kilidi kalktı | Kilit açılınca, kilit süresiyle | normal |
| 🚨 Canlı tick hatası · KRİTİK koruma mesajları | Stop sonucu belirsiz / stop yenilenemedi ve acil çıkış başarısız | kritik |
| ⚠ Veri akışı kesildi · ✅ geri geldi | Fiyat/mum verisi alınamıyor ve stop izlenemiyor | kritik · rutin |
| 💥 Bot çöktü · ⚠ Açılışta başlatılamadı | Beklenmeyen hata | kritik |
| 📅 GÜNLÜK ÖZET | Her gün 23:55 (İstanbul): günün K/Z'si, işlem sayısı, özkaynak, açık pozisyonlar, "bot yaşıyor", hata sayısı; gönderilemeyen kritik bildirim varsa uyarısı | rutin |
| 🔐 Panele hatalı şifre denemesi | Panel girişinde yanlış şifre; son 10 dakikadaki deneme sayısıyla, en fazla 10 dakikada bir mesaj | normal |
| ⏱ Gecikmeli bildirim | Önceden gönderilemeyen kritik mesajın, bağlantı gelince olay zamanıyla iletilmesi | kritik |

Ayarlar (`.env`):

| Değişken | Anlam |
|---|---|
| `DAILY_SUMMARY=0` | Günlük özeti kapatır |
| `DAILY_SUMMARY_TIME=21:30` | Günlük özet saati (İstanbul, `HH:MM`; varsayılan `23:55`) |
| `NOTIFY_TERMUX=1` | Aynı mesajları Termux bildirimi olarak da gösterir |
| `HEALTHCHECK_URL` | Nabız adresi: bot çökerse/telefon kapanırsa kendi kendine mesaj atamayacağı için dış servis (örn. healthchecks.io) haber verir |
| `NOTIFY_MIN_GAP_MS` | Telegram bildirim kuyruğunda mesajlar arası en az bekleme, ms (varsayılan 5000) |
| `NOTIFY_RETRY_BASE_MS` | Yeniden deneme başlangıç beklemesi (varsayılan 1000) |

Notlar: Sessiz mod (`/sessiz`) süreç yeniden başlayınca sıfırlanır (güvenli tarafa, sesli). Bot tamamen çökmüşse kendisi bildirim gönderemez; bu yüzden `HEALTHCHECK_URL` kullanmanız önerilir. Beklenmedik kapanış tespiti iki kayıtla yapılır: `state.json` içindeki `notifyMeta` bayrağı ve `data/runtime-marker.json` (bot her dakika "hâlâ yaşıyorum" nabzı yazar; kesinti süresi buradan hesaplanır). İkisinden biri bile beklenmedik diyorsa uyarı kritik gelir; ikisini de silerseniz bir sonraki açılış "ilk açılış" görünür. Bekleyen kritik mesajlar bellekte tutulur; bot tamamen kapanırsa gönderilemeyenler kaybolur, bu yüzden `HEALTHCHECK_URL` önerilir.

## Kayıtlar ve hassas veriler

Çalışma günlükleri varsayılan olarak `data/bot.log`, durum ve Paper kayıtları `data/state.json` konumundadır. `BOT_DATA_DIR` tanımlıysa günlük yolu bu dizine taşınır. Dosyaları paylaşmadan önce token, API anahtarı, parola ve kişisel bilgileri kontrol edip temizleyin.

## Çoklu sembol piyasa verisi (2.1.15)

Paper ve live motorları mum/ticker verilerini sınırlı eşzamanlılıkla toplar. Varsayılan sınır 4 semboldür; `.env` içinde `MARKET_DATA_CONCURRENCY=1`–`8` olarak ayarlanabilir. Bu ayar yalnızca veri toplama işçilerini sınırlar; strateji değerlendirmesi ve emir gönderimi seri kalır. Açık pozisyonlardan birinin piyasa verisi alınamaz veya eski/bozuk gelirse o tick'te yeni alımlar durur.
