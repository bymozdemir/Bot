# Multi-exchange API finalization

This build wires the live engine to four exchange adapters:

- Binance Spot
- Binance TR
- BtcTurk Spot
- Paribu Spot

The live engine remains locked behind `LIVE_TRADING_ENABLED=true`, the exchange-specific allow flag, `settings.mode=live`, reconciliation, and the existing risk gates.

## API keys

Use the narrowest permission set possible. **Do not grant withdrawal permission.**

- Binance: Spot trading/read permissions only.
- Binance TR: trading/read permissions only.
- BtcTurk: Total Funds + Trade + required WebSocket permission if later enabled.
- Paribu: Read + Trade; no withdrawal.

## Test environments

Binance Spot has an official Spot Testnet endpoint. BtcTurk documents a development host (`api-dev.btcturk.com`) in its API examples. Binance TR and Paribu should be treated as production API endpoints unless the exchange itself supplies a sandbox/test account for your account; the adapter therefore does not invent a fake sandbox URL.

## Safety rules in this build

1. A POST/DELETE request is never automatically retried.
2. HTTP 5xx / timeout after an order submission is `UNKNOWN`, not `REJECTED`.
3. Unknown order results stop the live engine until reconciliation.
4. Client order IDs are persisted before sending.
5. BtcTurk market BUY correctly sends quote-currency quantity (TRY/USDT); market SELL sends crypto quantity.
6. Protective stops use market-stop semantics where the exchange supports them (Binance `STOP_LOSS`, Binance TR `STOP_LOSS`, BtcTurk `stopMarket`, Paribu conditional Market order).
7. No withdrawal endpoint is implemented by the bot. On Binance production the engine also refuses to start if the API key reports withdrawal permission enabled (`GET /sapi/v1/account/apiRestrictions`).

## Preflight

Set credentials in `.env`, then:

`npm run api:preflight`

This only reads balances/open orders. It does not submit, cancel, or withdraw orders.

## Exchange-specific final tests

### Binance
Use Spot Testnet first. Verify:
- authenticated account
- balance
- open orders
- market BUY/SELL
- protective stop
- order query
- cancel
- restart/reconciliation
- WebSocket execution report

### BtcTurk
Use the documented development environment if your test credentials/account support it. Verify the same lifecycle. Pay special attention to market BUY quantity: the BtcTurk API defines market BUY quantity in quote currency, while market SELL quantity is crypto.

### Binance TR
The adapter uses the documented `/open/v1` signed account/order endpoints. There is no hard-coded fake testnet URL. If Binance TR provides a sandbox for your account, set `BINANCE_TR_BASE_URL` to that official endpoint.

### Paribu
The adapter uses the official `api.paribu.com` API. The official Paribu API wrapper documents `market/ticker`, `chart/history`, `user/assets`, `open-orders`, `order`, order query/cancel and account trade history; market BUY uses `total` (quote currency) while market SELL uses `amount` (base currency). The adapter also supports conditional Market stop orders.

Paribu candle data uses the documented `web.paribu.com/chart/history` path exposed by the maintained official-API wrapper, with timeframe validation and response-shape validation. Symbol precision/rules are discovered from Paribu exchange configuration; if they cannot be obtained, live trading is blocked rather than using invented precision.

Paribu does not expose a verified client-order-id field in the current adapter contract. The adapter keeps a fingerprint search helper for diagnostics, but it is deliberately not advertised as deterministic recovery (`recoveryByFingerprint=false`). Because of this, Paribu LIVE remains blocked until a deterministic client-order/recovery contract is verified.

## Static live-contract audit

Run `node scripts/liveContractAudit.js`. It verifies that all four adapters expose the complete live-trading interface and the reconciliation/stop safety capabilities. This is a code-level audit only; it does not send orders.
