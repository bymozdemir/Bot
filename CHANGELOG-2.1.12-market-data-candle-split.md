# 2.1.12 — Mum kapanışını açık zaman dilimine göre sınıflandırma

## Değişiklik
- `splitCandles(candles, now, timeframe)` artık biliniyorsa yapılandırılmış zaman dilimini kullanır.
- Paper ve live motorları mumları ayırırken kendi paritenin açık zaman dilimini geçirir.
- Son mumlar arasında eksik mum/gap varsa medyan farkın yanlış zaman dilimi seçip kapanmış mumu oluşan mum olarak sınıflandırması önlenir.
- Zaman dilimi verilmezse eski farktan çıkarım davranışı geriye dönük uyumluluk için korunur.

## Doğrulama
- Yeni `test/marketDataFreshness.test.js`: 3 test.
- Hedefli test grubu: 104/104 geçti.
- Tam toplu test denemesi dış 300 saniyelik süre sınırına ulaştı; bütün paket sonucu doğrulanmış sayılmaz.
- Canlı Binance emir akışı test edilmedi; canlı işlem doğrulama kilitleri değiştirilmedi.
