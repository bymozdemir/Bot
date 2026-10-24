# 2.1.14 — Public fallback host allowlist

## Değişiklik

- `BINANCE_PUBLIC_FALLBACKS` artık yalnızca tam eşleşen resmî Binance public veri hostlarını kabul eder: `api.binance.com`, `api-gcp.binance.com`, `api1.binance.com`–`api4.binance.com` ve `data-api.binance.vision`.
- HTTP, kullanıcı bilgisi, özel port, path, query, fragment ve benzer görünen ama resmî olmayan hostlar reddedilir.
- Bu, API anahtarından ziyade piyasa verisinin güvenilirliğini korur: yapılandırılmış sahte bir endpoint'in botu sahte mum/fiyatlarla yönlendirme riskini azaltır.
- `BINANCE_PUBLIC_FALLBACKS=off` davranışı korunur.

## Doğrulama

- Ağ fallback / mum doğrulama / look-ahead / timeframe hedefli testleri: 42/42 başarılı.
- Engine / live engine / execution / order manager / market safety / portfolio policy testleri: 118/118 başarılı.
- Server entegrasyon testi bu çalışma ortamında bağımlılık kurulumu eksik olduğundan ayrı çalıştırmada doğrulanamadı; bu, uygulama hatası olarak yorumlanamaz ve başarı sayılmaz.
- Tam test paketi tamamlanmadı. Gerçek Binance/Testnet uçtan uca emir akışı ve kârlılık test edilmedi.
