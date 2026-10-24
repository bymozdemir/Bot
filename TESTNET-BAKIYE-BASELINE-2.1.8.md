# Testnet balance baseline recovery (2.1.8)

This patch is restricted to Binance Spot Testnet (`exchange.id === binance` and `exchange.environment === testnet`).

On the first live-engine recovery only, it records configured base-asset balances as pre-existing Testnet inventory if and only if: local positions are empty, local order records are empty, the exchange reports no open orders/orphans/unknown local orders, and the kill switch is not active. These balances are stored in `state.live.balanceBaselineByAsset`; future reconciliation expects baseline + bot-managed positions + dust. Production exchanges never auto-create a baseline.

The baseline does not create bot positions, does not submit orders, and does not sell or move any balances. If there are open orders or local positions/orders, it will not initialize the baseline and recovery remains fail-closed.

Validation: focused pre-API safety, recovery, and chaos tests passed (34 tests). The full batched suite was attempted but exceeded the execution time limit in this environment, so it is not claimed as fully completed.
