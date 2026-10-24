// Canli bot yeniden baslatma kurtarmasi.
// Yeni islem acmadan once disk uzerindeki acik/belirsiz emirleri borsadan
// yeniden dogrular. Bir emir dogrulanamazsa yeni isleme izin vermez.

class LiveRecovery {
  constructor({ orderManager, reconciler, state, store, nowFn, repair } = {}) {
    if (!orderManager) throw new Error('LiveRecovery için OrderManager gerekli.');
    if (!reconciler) throw new Error('LiveRecovery için AccountReconciler gerekli.');
    if (!state) throw new Error('LiveRecovery için state gerekli.');
    if (!store || typeof store.save !== 'function') throw new Error('LiveRecovery için store.save gerekli.');
    this.orderManager = orderManager;
    this.reconciler = reconciler;
    this.state = state;
    this.store = store;
    this.nowFn = nowFn || (() => Date.now());
    this.repair = typeof repair === 'function' ? repair : null;
  }

  async recover() {
    const startedAt = new Date(this.nowFn()).toISOString();
    const result = {
      startedAt,
      completedAt: null,
      safeToTrade: false,
      reconciledOrders: [],
      errors: []
    };

    try {
      // Once PENDING/UNKNOWN/PARTIALLY_FILLED orders are resolved, the account
      // reconciliation can accurately decide whether there are orphan orders.
      result.reconciledOrders = await this.orderManager.reconcileAll();
    } catch (err) {
      result.errors.push(`Emir kurtarma başarısız: ${err?.message || String(err)}`);
    }

    try {
      let account = await this.reconciler.reconcile();
      result.account = account;
      // İlk mutabakatın güvenli olmaması recovery için son nokta değildir. Özellikle
      // UNKNOWN entry'nin FILLED olması veya exchange'te bulunan protective leg'in
      // local state'e bağlanmamış olması önce onarılabilir; ardından hesap yeniden
      // mutabakat edilir. Repair başarısızsa yine fail-closed kalır.
      if (this.repair) {
        try {
          const repairResult = await this.repair({ account, recovery: result });
          result.repair = repairResult || null;
          if (repairResult?.changed) account = await this.reconciler.reconcile();
          result.account = account;
        } catch (err) {
          result.errors.push(`Recovery onarımı başarısız: ${err?.message || String(err)}`);
        }
      }
      result.safeToTrade = result.errors.length === 0 && account.safeToTrade === true && !this.state.killSwitch;
      if (this.state.killSwitch) result.errors.push('Kill switch devrede; recovery canlı işlem kapısını açmadı.');
    } catch (err) {
      result.errors.push(`Hesap mutabakatı başarısız: ${err?.message || String(err)}`);
    }

    result.completedAt = new Date(this.nowFn()).toISOString();
    this.state.liveRecovery = result;
    this.store.save(this.state);
    return result;
  }
}

module.exports = { LiveRecovery };
