/* Pure decision presentation helpers shared by the panel and unit tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DecisionView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ACTIONS = {
    buy: { label: 'AL SİNYALİ', tone: 'good' },
    sell: { label: 'SAT SİNYALİ', tone: 'bad' },
    hold: { label: 'BEKLE', tone: 'neutral' }
  };

  function deriveDecisionView({ decision, enabled = true, hasPosition = false } = {}) {
    const d = decision && typeof decision === 'object' ? decision : null;
    let status;
    if (!enabled) status = { label: 'PARİTE PASİF', tone: 'muted' };
    else if (d && d.error) status = { label: 'VERİ / DEĞERLENDİRME HATASI', tone: 'bad' };
    else if (!d || !d.evaluatedAt) status = { label: 'İLK DEĞERLENDİRME BEKLENİYOR', tone: 'neutral' };
    else if (d.stale) status = { label: 'ESKİ SİNYAL — UYGULANMADI', tone: 'warn' };
    else status = ACTIONS[d.action] || { label: 'KARAR BEKLENİYOR', tone: 'neutral' };

    const data = !enabled
      ? { label: 'Kontrol yapılmıyor', tone: 'muted' }
      : d && d.error
        ? { label: 'Hata var', tone: 'bad' }
        : d && d.stale
          ? { label: 'Sinyal eski', tone: 'warn' }
          : d && d.checkedAt
            ? { label: 'Son kontrol kaydı var', tone: 'good' }
            : { label: 'Henüz kontrol yok', tone: 'neutral' };

    const action = d && ACTIONS[d.action] ? ACTIONS[d.action] : { label: 'Bilinmiyor', tone: 'neutral' };
    return {
      status,
      action,
      data,
      pair: enabled ? { label: 'Aktif', tone: 'good' } : { label: 'Pasif', tone: 'muted' },
      position: hasPosition ? { label: 'Pozisyon açık', tone: 'good' } : { label: 'Pozisyon yok', tone: 'neutral' },
      reason: d && d.reason ? String(d.reason) : (!enabled ? 'Parite devre dışı.' : d && d.error ? String(d.error) : 'Henüz karar nedeni oluşmadı.'),
      error: d && d.error ? String(d.error) : '',
      evaluatedAt: d && d.evaluatedAt ? String(d.evaluatedAt) : '',
      checkedAt: d && d.checkedAt ? String(d.checkedAt) : '',
      candleT: d && d.candleT ? Number(d.candleT) : null,
      price: d && Number.isFinite(Number(d.price)) ? Number(d.price) : null,
      stale: Boolean(d && d.stale),
      hasDecision: Boolean(d && d.evaluatedAt)
    };
  }

  return { deriveDecisionView };
});
