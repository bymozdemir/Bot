# Kaynak denetimi — 2.1.14

Tarih: 2026-10-24
Temel kaynak: 2.1.13 birleşik arşivi; ilave değişiklik `BINANCE_PUBLIC_FALLBACKS` host doğrulaması.

## Sonuç

2.1.14, 2.1.13'teki 429/418 beklemesi, toplam public API süre bütçesi ve live mum tazeliği kontrollerini korur. Ek olarak, çevre değişkeniyle tanımlanan Binance public fallback adreslerini resmî host allowlist'i ile sınırlar.

## İlave bulgu ve düzeltme

Önceki sürümde `BINANCE_PUBLIC_FALLBACKS` içindeki özel adresler HTTPS şemasını taşıdığı sürece kabul edilebiliyordu. Public isteklerde API anahtarı gönderilmese de bu adresler sahte piyasa verisi döndürerek sinyal kararlarını etkileyebilirdi. Artık yalnızca tam eşleşen resmî Binance public hostları kabul edilir; kullanıcı bilgisi, özel port, path/query/fragment ve benzer görünen sahte hostlar reddedilir.

## Doğrulama

- `node --check`: 229 JavaScript dosyası, 0 sözdizimi hatası.
- Ağ fallback / market-data freshness / no-lookahead / timeframe: 42/42 geçti.
- Engine / live engine / execution / order manager / market safety / portfolio policy: 118/118 geçti.
- Server entegrasyon testi ayrı denemede başarısız oldu çünkü ortamda `express`, `dotenv` ve `ws` bağımlılıkları tam kurulmamıştı. Bu test başarılı sayılmıyor.
- Offline preflight: başarılı; 17 stratejinin varsayılan parametreleri geçerli, varsayılan mod paper, canlı işlem kilidi kapalı.
- Tam test paketi bu ortamda tamamlanmadı; önceki tam koşu 120 saniye sınırına takılmış, izole toplu koşu da ortam süresi içinde tamamlanamamıştır.
- Gerçek Binance/Testnet emir akışı, gerçek bakiye, gerçek API anahtarları ve kârlılık doğrulanmadı.

## Hummingbot karşılaştırmasında hâlâ yapılmayanlar

Hummingbot'ın kalıcı WebSocket mum beslemesi, REST geçmiş veri tamamlama, ortak throttler ve bağlantı yeniden kurma/mum dedup yaşam döngüsü bu botta bütünüyle uygulanmış değildir. Bu, ayrı bir mimari geliştirme ve test kampanyasıdır.

## Operasyon

Bu sürüm de önceki çalışan dizinin üzerine açılmamalı. Önce `data/` ve `.env` yedeği alınmalı; ayrı klasörde kurulum, preflight ve testler yapılmalı. Canlı moda geçiş önerilmez.
