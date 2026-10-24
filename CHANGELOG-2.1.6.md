# 2.1.6-recovery-isolated

- Same-host stale `data/bot.lock` files can now be reclaimed automatically only when the recorded PID is no longer alive.
- Live PID locks, malformed lock files, and locks from another host/container remain fail-closed.
- The existing Telegram notifier remains best-effort: send failures are handled inside the notification layer and do not directly stop the trading engine.
- This change does not override the bot's own safety/kill-switch state and does not add automatic restart after an intentional safety stop.

Validation: targeted lock + notification tests passed. The complete test runner exceeded the available execution window in this environment; full suite completion is not claimed.
