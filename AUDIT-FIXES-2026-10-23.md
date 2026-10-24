# Denetim bulguları ve düzeltmeler — 2026-10-23

Bu paket, kullanıcı tarafından bildirilen dört kod bulgusuna yönelik hedefli düzeltmeler içerir.

## Düzeltildi

1. **Prototype isimli strategyId**: `src/strategies/index.js` içindeki strateji kaydı araması artık yalnızca registry'nin kendi anahtarlarını kabul eder. `constructor`, `__proto__` ve `toString` geçerli strateji sayılmaz. `POST /api/pairs` ve `PATCH /api/pairs/:symbol` geçersiz stratejiyi kontrollü 400 yanıtıyla reddeder.
2. **Aşırı küçük pozitif risk değerleri**: `killSwitchLossPct` için `0` (kapalı) veya en az `0.1`; `maxTradeQuote` için `0` (sınırsız/paper semantiği) veya en az 1 kasa birimi; `reserveCashPct` için `0` veya en az `0.1` kabul edilir. Rezerv sınırı hem doğrudan ayarda hem `portfolioPolicy.reserveCashPct` içinde uygulanır. Canlı moda ait mevcut ek güvenlik kontrolleri değişmedi.
3. **Scanner HTTP hata kodu**: `/api/scanner` dış veri/scan hatalarında artık diğer borsa-verisi uçlarıyla tutarlı biçimde 502 döndürür.
4. **Eski yedek dosyaları**: `server.js.before-*` ve `*.bak-oco-fix` dosyaları dağıtım kaynak paketinden kaldırıldı.

## Bu çalışma ortamında doğrulananlar

- `node --check server.js`, `node --check src/strategies/index.js` ve `node --check test/serverIntegration.test.js` başarılı.
- Strateji registry regresyon kontrolü: `constructor`, `__proto__`, `toString` üçü de reddedildi.
- `node --test test/strategyGate.test.js test/strategyResearch.test.js test/strategyScanner.test.js`: 17/17 geçti.
- ZIP içeriğinde `node_modules`, `.env`, `data/` ve eski yedek dosyaları bulunmuyor.

## Doğrulama sınırı

Bu kaynak pakette `node_modules` yok ve bu çalışma ortamında `express`, `dotenv`, `ws` kurulu değil. Bu nedenle HTTP entegrasyon testleri (yeni API regresyon testleri dâhil) burada çalıştırılamadı. Bunlar kaynak pakete eklendi; tam doğrulama için Termux'ta `npm ci` ve ardından `npm run test:server-integration` çalıştırılmalı. Gerçek borsa/Testnet/Android ve çok günlük bellek testleri de ağ/cihaz erişimi olmadan doğrulanmış sayılmaz.
