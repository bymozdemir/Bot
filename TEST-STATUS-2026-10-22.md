# Test status — 2026-10-22

## Passed in this environment

- `node scripts/offlinePreflight.js` — PASS; defaults to paper mode and live safety lock remains closed.
- Targeted combined suite — 52/52 tests passed, covering Binance Testnet opt-in gate, notification durability/restart persistence, User Data Stream race handling, chaos scenarios, backtest accounting and exchange capability safety.
- Focused regression files `fastTimeframe.test.js`, `liveEngine.test.js`, `mergeRegression.test.js`, and `windowsSafety.test.js` — 59/59 passed after making each test explicitly set and restore the official Spot Testnet opt-in environment; no production safety gates were weakened.
- `test/backtest.cli.test.js` — 5/5 passed after reducing redundant fixture scope while retaining cache, refresh, 24-month sensitivity/check, invalid-option, offline-error, and DCA flag assertions.
- Test list integrity — 106 test files, all listed exactly once across `group0`–`group6`.
- JavaScript syntax checks for modified production and test files — PASS.

## Not verified here

- Full `scripts/runTestsBatched.js` did not complete within a 5-minute command window; the run was still in `backtest.cli.test.js`. Do not treat the full suite as green.
- `serverIntegration.test.js` cannot run until `express`, `dotenv`, and `ws` are installed. Offline `npm ci` previously failed because the `ws` tarball was not cached.
- `scripts/testnetPreflight.js` returned `EAI_AGAIN` for `testnet.binance.vision` in this environment. No exchange API credentials were used and no order was sent.
- Signed Spot Testnet balance/order/stop/cancel/restart recovery flow has not been end-to-end validated.
- Binance `liveTradingVerified` remains `false`; production trading remains blocked.

## Next action on the user's Termux device

Run `npm ci`, `npm run test:server-integration`, `npm run test:batched`, then `npm run testnet:preflight`. Only after those are clear, use separate official Spot Testnet API keys and follow `TESTNET-GECIS-TR.md`. Never place real account API keys in this test build's `.env`.

## Security/chaos audit follow-up — 2026-10-22

- Found and fixed Binance REST base URL accepting an official hostname over plain HTTP; HTTPS is now required outside explicitly enabled localhost tests. Credentials, unexpected paths/query/fragments, and custom ports are rejected.
- Found and fixed Binance WebSocket override allowing production/testnet hostname crossover. The environment must match the exact official WebSocket host.
- Hardened the Testnet opt-in helper to independently require HTTPS and the exact official root URL.
- Full suite on this environment: 1,072 tests, 1,070 passed, 2 failed. The auth event-loop timing test failed once under suite load but passed on two isolated runs (16/16 each). `serverIntegration.test.js` remains unverified because `express`, `dotenv`, and `ws` were unavailable and dependency installation could not complete.
- Additional chaos: 1,000,000-step paper fuzz PASS; 17,280 synthetic hours PASS; 1,000,000-step portfolio-policy fuzz PASS; 100 User Data Stream race iterations PASS.
- Testnet network preflight returned `EAI_AGAIN`; no credentials or orders were used. See `SECURITY-AUDIT-2026-10-22.md` for details.

## Ek dogrulama — bildirim tani kaydi (2026-10-22)

- `src/paperEngine.js`: Telegram teslim sonucu `telegram:false` donerse motor calismaya devam ederken olay, bekleyen kuyruk sayisi ve son hata yerel log'a yazilir. Senkron bildirim-gonderici hatalari da yutulup loglanir.
- `src/notify.js`: Telegram HTTP hata aciklamasi, token maskelenerek `detail().channels.telegram.lastError` alanina eklenir.
- `test/notifyGap.test.js`: bes eszamanli alimin sirayla tamamini gonderme regresyon testi eklendi.
- `test/notifyParity.test.js`: basarisiz teslimin motoru durdurmadan yerel log'a yazildigi testi eklendi.
- Bildirim/Telegram ilgili testler: **92/92 gecti**.
- `test/securityFixes193.test.js`: **16/16 gecti**; olay dongusu zamanlama testi tek basina bu kosuda gecti.
- `test/serverIntegration.test.js`: calistirilamadi; `express`, `dotenv`, `ws` eksik. `npm ci` denemesi npm registry DNS hatalari (`EAI_AGAIN`) nedeniyle tamamlanmadi. Bu test basarili sayilmiyor.
- Gecmisteki 5 alimin yalniz 2 bildiriminin gelme nedeni kesinlestirilemedi; calistirma anina ait `data/` ve bildirim kuyrugu kayitlari bu arsivde yok. Yeni tani kaydi sonraki benzer olayi ayrismayi saglayacak.

**Guvenlik notu:** Bot PAPER modunda tutulmalidir. Bu degisiklik canli islem guvenlik kilidini degistirmez.
