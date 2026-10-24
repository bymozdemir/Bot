# Çalışma modları

## PAPER
Gerçek piyasa verisi okunur. Strateji, risk, sanal komisyon/kayma ve emir yaşam döngüsü simüle edilir. Borsaya hiçbir emir gönderilmez ve gerçek API anahtarı gerekmez.

## LIVE
Gerçek emir motorudur. Mod seçilebilir ancak bot çalıştırılırken exchange adapter, API kimlik bilgileri, risk kapıları, reconciliation ve koruyucu stop kontrolleri tamamlanmadan motor başlamaz.

### Mod değişimi
- Bot çalışırken mod değiştirilemez.
- LIVE seçimi için kullanıcı onayı gerekir.
- LIVE modu seçmek tek başına emir göndermez.
- API doğrulaması ve canlı güvenlik kapıları geçilmeden `start` reddedilir.
- Withdrawal/para çekme yetkisi hiçbir API anahtarında kullanılmamalıdır.

Önerilen kullanıcı akışı: `PAPER -> LIVE`.
