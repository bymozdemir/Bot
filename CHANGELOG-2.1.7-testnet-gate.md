# 2.1.7-testnet-gate

- Added a dedicated, explicit Binance Spot Testnet opt-in. It requires `BINANCE_ENV=testnet`, `ALLOW_BINANCE_TESTNET_TRADING=true`, `LIVE_TRADING_ENABLED=true`, and the official `testnet.binance.vision` hostname.
- Kept `liveTradingVerified=false` for the Binance adapter. The opt-in is restricted to the official Spot Testnet; production hostname/production environment still fails closed.
- Added unit tests for hostname allowlisting, opt-in requirements, OrderManager defense-in-depth, and LiveEngine startup gating.
- Added read-only `npm run testnet:preflight` to check DNS/HTTPS access and clock difference without credentials or orders.
- Reduced default chaos/backtest fixture workloads to finish routine tests in constrained environments; longer chaos soak values remain configurable via `CHAOS_ORDER_ITERATIONS`, `CHAOS_TEST_ITERATIONS`, and `CHAOS_MULTI_ITERATIONS`.
- Updated Testnet transition instructions and notification queue persistence documentation.

This release is a Testnet-preparation build, not a production/live-trading approval. End-to-end signed Testnet orders still need to be validated on a network-connected device with separate Spot Testnet API credentials.
