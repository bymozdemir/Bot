# Telegram alım bildirimi incelemesi — 2026-10-22

## Bulunan

1. Paper alım yolu `paperEngine.buyAt()` içinde alım bildirimini `durable: true` ile gönderiyor.
2. Bildirim göndericisi mesajları tek kuyrukta sıraya koyuyor; varsayılan aralık 5 saniye. Ağ/HTTP geçici hatalarında yeniden deniyor ve kalıcı kuyrukta bekletiyor.
3. Buna rağmen `PaperEngine.notify()` gönderim sonucunu atıyordu. Telegram `telegram:false` döndürdüğünde, botun işlem motoru devam ediyor ancak yerel logda her olayın sonucu görünmüyordu. Bu, eksik bildirimin nedenini teşhis etmeyi zorlaştırıyordu.

## Düzeltmeler

- Paper motoru artık Telegram teslim başarısızlığını uyarı seviyesinde yerel loga yazar; alım/satım olay etiketi, bekleyen bildirim sayısı ve hata bilgisi eklenir.
- Telegram HTTP hata açıklaması, token maskelenerek notifier durumunda tutulur.
- Beş eşzamanlı alım bildiriminin tamamının kuyrukta sırayla gönderildiğini doğrulayan test eklendi.
- Teslim başarısızlığının motoru durdurmadan loglandığını doğrulayan test eklendi.

## Doğrulama

- Telegram/bildirim ve komut testleri: 92/92 geçti.
- `securityFixes193.test.js`: 16/16 geçti.
- `serverIntegration.test.js`: henüz doğrulanamadı. `express`, `dotenv`, `ws` bu çalışma ortamında yoktu; `npm ci` sırasında npm registry DNS hatası (`EAI_AGAIN`) alındı.

## Bilinmeyen

Önceki çalıştırmada bildirimi gelmeyen üç alımın kesin nedeni bu arşivden belirlenemez. İlgili `data/` dizini, `notify-pending.json` ve o çalıştırmanın tam logları arşivde bulunmuyor. Yeni tanılama kaydı, sonraki başarısız teslimde yerel logda HTTP/ağ hatasını ve bekleyen kuyruk sayısını gösterecek.

## Güvenlik sınırı

Bu paket PAPER modunda test edilmelidir. Gerçek API anahtarıyla işlem yapılmadı; Testnet emri gönderilmedi; canlı işlem güvenlik kilidi değiştirilmedi.
