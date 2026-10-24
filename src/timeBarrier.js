// Zaman bariyeri (Hummingbot triple-barrier "time_limit" fikrinden esinlendi).
// Pozisyon belirli sayida KAPANMIS mumdan uzun suredir acik ve kar esigine ulasmadiysa cikis sinyali uretir.
// Yalnizca bir CIKIS onerisidir; emri mevcut sell yolu verir (stop/kurtarma mantigi degismez).
// Varsayilan: kapali (settings.timeBarrier.enabled=false).

const DEFAULTS = Object.freeze({ enabled: false, maxHoldBars: 48, minProfitPct: 0.5 });

function normalizeTimeBarrier(input) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const bars = Number(s.maxHoldBars);
  const minP = Number(s.minProfitPct);
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULTS.enabled,
    maxHoldBars: Number.isInteger(bars) && bars >= 1 && bars <= 10000 ? bars : DEFAULTS.maxHoldBars,
    minProfitPct: Number.isFinite(minP) && minP >= -100 && minP <= 1000 ? minP : DEFAULTS.minProfitPct
  };
}

// closedCandles: kapanmis mumlar (artan zaman). position.openedAt: ISO metin.
function timeBarrierExit({ position, closedCandles, price, config }) {
  const cfg = normalizeTimeBarrier(config);
  if (!cfg.enabled || !position || !Array.isArray(closedCandles)) return null;
  const openedMs = Date.parse(position.openedAt);
  const entry = Number(position.entryPrice);
  const px = Number(price);
  if (!Number.isFinite(openedMs) || !(entry > 0) || !(px > 0)) return null;
  let held = 0;
  for (const c of closedCandles) if (Number(c.t) >= openedMs) held++;
  if (held < cfg.maxHoldBars) return null;
  const pnlPct = (px / entry - 1) * 100;
  if (pnlPct >= cfg.minProfitPct) return null;
  return {
    action: 'sell',
    reason: `zaman bariyeri: ${held} mumdur açık, K/Z %${pnlPct.toFixed(2)} < hedef %${cfg.minProfitPct}`,
    heldBars: held,
    pnlPct
  };
}

module.exports = { DEFAULTS, normalizeTimeBarrier, timeBarrierExit };
