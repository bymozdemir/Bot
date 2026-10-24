# Tek kod tabanı — Ev PC / VPS / Termux

Bu proje aynı uygulama kodunu üç çalışma ortamında kullanır. Strateji, risk, Paper/Live ve borsa adaptörleri değişmez; yalnızca uygulamanın nasıl sürekli çalıştırıldığı değişir.

## 1) Ev bilgisayarı

En basit yol:

```bash
npm install
npm start   # ilk açılışta panel şifresi ve Telegram bilgilerini sorar, .env'i kendisi oluşturur
```

Varsayılan `HOST=127.0.0.1` olduğu için panel yalnızca aynı bilgisayardan açılır: `http://127.0.0.1:8787`.

Bilgisayardan telefon/tablet gibi aynı ev ağındaki başka cihazların erişmesi gerekiyorsa:

- `HOST=0.0.0.0`
- panel için `npm run auth:setup` ile en az 12 karakterlik güçlü bir parola
- işletim sistemi firewall'ında yalnızca yerel ağ erişimi

kullan. İnternete doğrudan port açma.

## 2) VPS

Docker önerilen yöntemdir:

```bash
# İlk kurulum: panel parolası (ve isteğe bağlı Telegram) interaktif sorulur
npm run setup
mkdir -p data
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

Kontrol:

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml ps
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs -f bot
curl http://127.0.0.1:8787/api/health
```

VPS'te internete açarken uygulamayı doğrudan `:8787` üzerinden yayınlamak yerine HTTPS reverse proxy kullan. Caddy veya Nginx üzerinden `https://bot.senin-domainin.com` gibi bir adres ver.

Reverse proxy kullanırken `.env` içine:

```env
HOST=0.0.0.0
TRUST_PROXY=true
```

koy. TLS'i reverse proxy sonlandırır; bot WebSocket `/ws` bağlantısını da destekler.

**Önemli (1.9.2):**
- `docker-compose.vps.yml` portu yalnızca `127.0.0.1:8787` olarak yayınlar. Reverse proxy aynı makinede olmalı; `8787`'yi internete doğrudan açma.
- `TRUST_PROXY=true` artık "tüm zincire güven" değil, **tam 1 proxy'ye** güvendir (`TRUST_PROXY_HOPS`, varsayılan 1). `req.ip`, güvenilir proxy'nin eklediği son adrestir; istemcinin gönderdiği sahte `X-Forwarded-For` girişleri yok sayılır. Proxy'n `X-Forwarded-For` ve `X-Forwarded-Proto` başlıklarını **eklemeli/ezmeli** (Caddy ve nginx `proxy_set_header ... $proxy_add_x_forwarded_for` ile yapar).
- Aynı `data/` klasörünü iki süreç kullanamaz (`data/bot.lock`). Docker ve systemd'yi aynı klasörle birlikte çalıştırma.
- Docker `HEALTHCHECK` artık oturumsuz `GET /api/health` ile çalışır (yalnızca `{ok, service}` döner; ayrıntılar oturum ister).
- Kasa ana şifresi en az 12 karakter. Boşta kalırsa `VAULT_AUTO_LOCK_MINUTES` (varsayılan 60) sonra otomatik kilitlenir. Eski kasalar doğru şifre girilince otomatik olarak güçlü KDF'ye yükseltilir.

## 3) Termux

Docker yerine doğrudan Node.js çalıştır:

```bash
npm install
npm start   # ilk açılışta panel şifresi ve Telegram bilgilerini sorar, .env'i kendisi oluşturur
```

Termux:Boot ile otomatik başlatma için mevcut Android/Termux başlatma akışına `node ~/crypto-bot/server.js` komutu eklenebilir. Android'in pil optimizasyonları ve arka plan kısıtlamaları nedeniyle VPS kadar güvenilir 7/24 çalışma beklenmemeli.

## Veri ve ayarlar

- `data/` botun kalıcı durumudur.
- Docker'da `./data:/app/data` ile host üzerinde kalır.
- `.env` API sırlarını içerir; Git'e koyma.
- API anahtarlarında yalnızca gerekli trading/read izinlerini aç; withdrawal/para çekme kapalı kalsın.

## Modlar

- PAPER: gerçek piyasa verisi + sanal emirler.
- LIVE: gerçek API + gerçek emir; mevcut güvenlik kapıları ve preflight tamamlanmadan başlatılmamalı.

Mod değişimi bot dururken yapılır.

## Sağlık kontrolü

`GET /api/health` kimlik doğrulaması istemeyen makine-sağlığı uç noktasıdır. Docker healthcheck bunu kullanır. Dışarıya yayınlanacaksa yalnızca reverse proxy/monitoring katmanının erişmesine izin vermek daha güvenlidir.


## 1.9.3 notları
- **systemd:** `systemd/crypto-bot.service` sistem servisidir ve ayrıcalıksız `cryptobot` kullanıcısıyla çalışır (dosyanın başındaki kurulum adımlarına bak). Root olmadan kullanıcı oturumunda çalıştıracaksan `systemd/crypto-bot.user.service`'i kullan.
- **Docker:** konteyner `read_only` çalışır; yalnızca `./data` yazılabilir. `package-lock.json` olmadan imaj derlenmez (bilerek).
- WebSocket en fazla 16 eşzamanlı istemci kabul eder ve istemciden mesaj kabul etmez.
- Borsaya dış istek üreten uçlar (`/api/candles`, `/api/backtest/quick`, `/api/scanner`, `/api/analytics`, `/api/live/preflight`) hız sınırlıdır; sınır aşılınca `429` + `Retry-After` döner.
- Entegrasyon testi (`test/serverIntegration.test.js`) gerçek sunucuyu başlatır; `npm install` yapılmış ortamda otomatik çalışır.
