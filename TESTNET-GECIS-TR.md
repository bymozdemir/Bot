# Binance Spot Testnet'e geçiş kontrol listesi

**Bu paket üretim hesabında işlem yapmak için onaylanmış değildir.** Önce yalnızca Binance Spot Testnet kullanılmalıdır.

## 1. Termux'ta kurulum

Node.js 18+ kurulu olmalı. Proje klasöründe:

```sh
npm ci
npm run preflight
npm run testnet:preflight
npm run test:server-integration
```

`npm ci` ağ erişimi gerektirir. Testnet preflight başarısızsa emir denemeyin; `EAI_AGAIN` genellikle DNS/ağ çözümleme sorunudur. Android Özel DNS, VPN/proxy ve telefonun tarih-saatini kontrol edip tekrar deneyin.

## 2. Testnet anahtarları

Yalnızca resmi Binance Spot Testnet'te oluşturulan test API anahtarlarını kullanın. Gerçek Binance API anahtarlarını `.env` dosyasına bu test için koymayın. Anahtarları sohbet, ZIP, ekran görüntüsü veya loglarla paylaşmayın.

Kendi cihazınızdaki `.env` dosyasında şu üç değişkeni birlikte ayarlayın:

```dotenv
BINANCE_ENV=testnet
ALLOW_BINANCE_TESTNET_TRADING=true
LIVE_TRADING_ENABLED=true
```

Bunlar olmadan emir gönderme kapısı açılmaz. Bu kombinasyon yalnızca `https://testnet.binance.vision` hostname'ine izin verir. Üretim hostname'i ile `liveTradingVerified=false` kilidi kapalı kalır. Panelde modu `live` yapmak Testnet'e emir gönderebilen motoru başlatır; bu nedenle ilk aşamada yalnızca Testnet API anahtarları ve test varlıkları kullanın.

## 3. Sıralı doğrulama

1. `npm run testnet:preflight` — herkese açık saat uç noktasına erişim ve saat farkı. API anahtarı kullanmaz, emir göndermez.
2. `npm run api:preflight -- binance` — Testnet API anahtarları tanımlandıktan sonra bakiye/açık emir sorgularını doğrulayın.
3. Panelde tek bir parite, çok küçük test tutarı ve düşük eşzamanlı pozisyon sınırıyla Testnet motorunu başlatın.
4. Emir kimliği, gerçekleşen miktar, komisyon ve açık emir sorgusunu doğrulayın.
5. Koruyucu stopun borsada gerçekten açık olduğunu; satış/iptal sonrası miktarların ve durumun mutabık olduğunu doğrulayın.
6. Süreci durdurup yeniden başlatın; kurtarma/mutabakat sonuçlarını ve Telegram bildirim kuyruğunun yeniden yüklenmesini doğrulayın.

Bir adım başarısızsa sonraki adıma geçmeyin. Bu kontrol listesi kâr garantisi veya üretim için onay değildir.
