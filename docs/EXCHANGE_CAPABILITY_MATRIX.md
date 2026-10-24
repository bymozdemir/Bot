# Güncel borsa yetenek ve doğrulama durumu — 2026-10-14

Bu tablo, mevcut kod denetiminin durumunu gösterir. **GREEN gerçek hesapta güvenle işlem yapılabildiği anlamına gelmelidir**; mock test veya adaptör kodunun bulunması tek başına GREEN değildir. Bu sürümde gerçek/sandbox uçtan uca kanıtı bulunan borsa yoktur.

| Borsa | Özel API kodu | Emir kimliği / sorgulama | Koruyucu stop kodu | Kod sözleşmesi denetimi | Canlı doğrulama | Sonuç |
|---|---|---|---|---|---|---|
| Binance | Var | Var | Var | Asgari statik sözleşme tamam | Yapılmadı | YELLOW — canlı kilitli |
| BtcTurk | Var | Var | Var | Asgari statik sözleşme tamam | Yapılmadı | YELLOW — canlı kilitli |
| Binance TR | Var | Var | Var | Asgari statik sözleşme tamam | Yapılmadı | YELLOW — canlı kilitli |
| Coinbase Exchange | Var | Var | Var | Asgari statik sözleşme tamam | Yapılmadı | YELLOW — canlı kilitli |
| Kraken | Var | Var | Var | Asgari statik sözleşme tamam | Yapılmadı | YELLOW — canlı kilitli |
| Bitstamp | Var | Var | Var | Asgari statik sözleşme tamam | Yapılmadı | YELLOW — canlı kilitli |
| OKX | Var | Var | Var | Asgari statik sözleşme tamam | Yapılmadı | YELLOW — canlı kilitli |
| OKX TR | Var | Var | Var | Asgari statik sözleşme tamam | Bölgesel ürün/hesap kapsamı yapılmadı | YELLOW — canlı kilitli |
| Bybit TR | Var | Var | Var | Asgari statik sözleşme tamam | Bölgesel API/ürün kapsamı yapılmadı | YELLOW — canlı kilitli |
| Paribu | Var | Güvenli client-order-id round-trip doğrulanmadı | Var, fakat güvenli kimlik/kurtarma eksik | Eksik | Yapılmadı | RED — canlı kullanım yasak |
| Midas | Doğrulanmış resmî API yok | Yok | Yok | Eksik | Yapılmadı | RED — kapalı |

## Renklerin anlamı

- **GREEN:** Kod sözleşmesi tamam ve bu sürüm için kaydedilmiş, tekrarlanabilir sandbox/gerçek hesap kanıtı mevcut. Bu sürümde hiçbir borsa bu seviyede değildir.
- **YELLOW:** Asgari kod sözleşmesi statik/mocks testleriyle mevcut, fakat gerçek/sandbox uçtan uca kanıtı eksik. Canlı işlem izni vermez.
- **RED:** Güvenli kimlik/kurtarma veya resmî API sözleşmesi gibi asgari şart eksik. Canlı işlem izni vermez.

## Zorunlu güvenlik kuralları

- `liveTradingVerified` açıkça `true` değilse canlı motor ve `OrderManager` emri reddeder; `false`, `undefined` ve eksik alan aynı şekilde fail-closed davranır.
- OCO veya trailing desteği doğrulanmadıysa bot bunları iki ayrı emirle taklit etmez.
- API anahtarları yalnızca kullanıcının cihazında girilmeli; çekim yetkisi kapalı olmalıdır.
- Önce salt-okunur API, sonra varsa sandbox/testnet üzerinde emir oluşturma, sorgulama, iptal ve belirsiz POST kurtarma akışları doğrulanmalıdır.
- Adaptör kodunun veya mock testlerinin varlığı gerçek borsa davranışının doğrulandığı anlamına gelmez.

Güncel çalıştırma komutu: `node scripts/liveContractAudit.js`. Bu komut statik kod sözleşmesini denetler; gerçek/sandbox testinin yerine geçmez.
