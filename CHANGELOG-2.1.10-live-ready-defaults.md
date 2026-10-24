# 2.1.10 — Canlıya hazır varsayılanlar (Binance Testnet test koşusu için)

## Değişiklikler
- `maxTradeQuote` varsayılanı 0 (sınırsız) → **50 USDT**. Gerçek borsada 0 kabul edilmediği için canlı geçişi/ön kontrolü takıyordu.
- 9 trend/rejim stratejisinin varsayılan stop-loss'u **%15 → %8** (trend_filter, trend_filter_v2, trend_regime, regime_* ailesi, adx_chandelier, tsmom, donchian_regime, regime_strict, trend_vote). Kaynak dosyalardaki %15 orijinal varsayılandı (kullanıcı denemesi değildi).
- Eski `state.json` için TEK SEFERLİK geçiş (`defaultsVersion: 2`): maxTradeQuote 0 ise 50 (yalnız USDT kasada), parite stopu birebir %15 ise stratejinin yeni varsayılanı. Bilinçli özel değerlere dokunulmaz; geçişten sonra kullanıcı 0 yaparsa geri yazılmaz.
- Origin başlığı yokken yabancı/geçersiz `Referer` artık 403 (CSRF sertleştirmesi).
- Panel etiketleri: "işlem başına üst tutar" ve "kill switch" için "canlı modda 0 olamaz".

## Testler
- Eski `securityFixes191` regex testi güncel koruma koduna uyarlandı.
- `trendcriteria` varsayılan stop beklentisi %8.
- parity / engine2 / paperModeRegression / preApiSafety fixture'larına açık `maxTradeQuote: 0` (bu testler tutar sınırını değil, başka davranışları ölçer).
- Yeni: `test/liveReadyDefaults.test.js` (8 test).
- Sonuç: 107/107 dosya, 1095/1095 test geçti; saldırı betiği 186 kontrol, 0 bulgu.

## Değişmeyenler (bilinçli)
dailyLossLimitPct 5, killSwitchLossPct 25, maxConcurrentPositions 3, reserveCashPct 10, defaultBudgetPct 30. Üretim Binance kilidi (`liveTradingVerified=false`, `ALLOW_PRODUCTION_TRADING`) AÇILMADI.

## Ek ayar turu (varsayılanlar ve zip içi data)
- `killSwitchLossPct` varsayılanı 25 → **15** (günlük limitin 3 katı; aynı gün kilitlenmeyi ve aşırı geniş zarar toleransını önler).
- Zip içindeki `data/state.json` (+`.bak`): `maxTradeQuote` 5 → 50 (5 USDT, Binance minimum emir tutarının altına düşebiliyordu), `killSwitchLossPct` 5 → 15 (günlük limitle aynıydı), kategori başına maks. pozisyon 5 → 0 (genel limit 3 zaten belirleyici), `defaultsVersion` 2. Mod (live), borsa, kasa, anahtarlar ve pariteler değişmedi.
