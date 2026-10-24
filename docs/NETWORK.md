# Ağ sorunları: "Google ping çalışıyor ama Binance çekmiyor"

Ping yalnızca ICMP'dir; Binance'e giden trafik ise DNS + IPv4/IPv6 + TCP 443 + TLS (SNI) + HTTPS katmanlarından geçer.
Bunlardan biri takılırsa ping çalışır ama bot mum çekemez. **Önce teşhis edin:**

    npm run net:check

Çıktı hangi katmanda koptuğunu söyler (DNS / TCP / TLS / HTTPS) ve saat sapmasını da ölçer.

## 1.8.0 FINAL'de bot kendiliğinden ne yapar
- **IPv4 öncelikli DNS** (`DNS_ORDER=ipv4first`) + hızlı adres geçişi: bozuk IPv6 yolu en sık ev-modemi nedenidir.
- **Herkese açık veri (mum, fiyat, derinlik, saat) için alternatif Binance adresleri:** `api.binance.com` yanıt vermezse
  sırayla `api-gcp`, `api1-4` ve `data-api.binance.vision` denenir; çalışan adres hatırlanır, bozuk adres 60 sn atlanır.
  Emir/bakiye gibi **imzalı istekler asla alternatiflere gitmez**; yalnızca resmi ortam adresine gider.
- **Hata mesajları açıklayıcıdır** (DNS mi, zaman aşımı mı, sertifika mı) ve log'a öneriyle birlikte yazılır.
- **Proxy desteği:** `HTTPS_PROXY=http://host:port` tanımlıysa kullanılır (`npm install undici` gerekir).
- **TLS doğrulaması asla kapatılmaz;** `NODE_TLS_REJECT_UNAUTHORIZED=0` iken canlı mod başlamaz.

## Teşhise göre çözüm
| net:check çıktısı | Olası neden | Çözüm |
|---|---|---|
| `DNS: ENOTFOUND` | Modem/ISS DNS'i adı vermiyor | Bilgisayar/telefon DNS'ini 1.1.1.1 veya 8.8.8.8 yapın |
| `TCP ... ETIMEDOUT` (IPv6 satırı) | Bozuk IPv6 | Modemde IPv6'yı kapatın (bot zaten IPv4 öncelikli) |
| `TCP ... ETIMEDOUT` (tüm adresler) | ISS/güvenlik duvarı engeli | Hotspot ile deneyin; sorun mobil veride yoksa ev ağı/ISS kaynaklıdır |
| `TLS ... ECONNRESET` | ISS el sıkışmayı (SNI) kesiyor | Alternatif adres (otomatik), proxy veya VPS |
| `TLS ... UNABLE_TO_VERIFY_LEAF_SIGNATURE` / sertifika veren Binance/DigiCert/Amazon değil | Antivirüs "HTTPS taraması" veya kurumsal proxy | Antivirüste Node'u hariç tutun veya kök sertifikayı `NODE_EXTRA_CA_CERTS=C:\yol\kok.pem` ile tanıtın |
| `HTTPS ... beklenen yanıt değil` | Araya giren filtre/proxy | Aynı çözümler |
| `saat farkı > 4 sn` | Saat sapması | Saati otomatik senkronize edin (imzalı emirler reddedilir) |

## Ortama göre notlar
- **Windows:** `docs/WINDOWS.md`. Windows Güvenlik/antivirüs HTTPS taramasını Node için kapatmak çoğu TLS hatasını çözer.
- **Termux (telefon):** `pkg install nodejs git`, sonra `npm install`. Bot telefonda arka planda kalsın diye
  `termux-wake-lock` çalıştırın ve pil tasarrufunu Termux için kapatın. Canlı para için telefon önerilmez
  (uyku/ağ geçişi riski); denemeler ve paper mod uygundur.
- **Linux / VPS:** `systemd/crypto-bot.service` (sistem, ayrıcalıksız `cryptobot` kullanıcısı) ya da `systemd/crypto-bot.user.service` dosyasını kullanın. VPS çoğu zaman ev ağı engellerini aşar;
  bazı ülke IP'leri Binance'te bölge engeline (HTTP 451) takılabilir, bu durumda başka bölge seçin.
- **Hiçbir şey çalışmazsa:** ev ağından erişim ISS tarafından engelleniyorsa bu kodla aşılacak bir şey yoktur;
  telefon hotspot'u veya VPS kullanın. Ağ kısıtlarını aşan araçlar kullanmadan önce kendi ülkenizin ve Binance'in
  kullanım koşullarını kontrol etmek sizin sorumluluğunuzdadır.

## .env ayarları
    DNS_ORDER=ipv4first                 # ipv6first | verbatim
    BINANCE_PUBLIC_FALLBACKS=           # boş = varsayılan liste; "off" = kapalı; virgüllü https adresleri
    HTTPS_PROXY=                        # isteğe bağlı
    NODE_EXTRA_CA_CERTS=                # kurumsal/antivirüs kök sertifikası (.pem)
