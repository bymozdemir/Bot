'use strict';

// Explicitly permits sandbox orders only. This does not mark the adapter as
// production-verified and must never permit a production hostname.
function isBinanceSpotTestnetOptIn(exchange, env = process.env) {
  if (!exchange || exchange.id !== 'binance') return false;
  if (String(exchange.environment || '').toLowerCase() !== 'testnet') return false;
  if (String(env.BINANCE_ENV || '').toLowerCase() !== 'testnet') return false;
  if (env.ALLOW_BINANCE_TESTNET_TRADING !== 'true' || env.LIVE_TRADING_ENABLED !== 'true') return false;
  let parsed;
  try { parsed = new URL(exchange.baseUrl || 'https://testnet.binance.vision'); } catch (_) { return false; }
  // Defense in depth: the adapter constructor also validates this, but the live
  // gate must independently reject HTTP, credentials, custom ports and URL paths.
  return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'testnet.binance.vision' &&
    !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash &&
    (parsed.pathname === '/' || parsed.pathname === '');
}

module.exports = { isBinanceSpotTestnetOptIn };
