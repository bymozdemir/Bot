// src/reconciliation.js
//
// Canli moda gecmeden once borsadaki gercek Spot hesabinin botun yerel
// durumuyla uyumlu olup olmadigini kontrol eder.
//
// Bu katman kasitli olarak "beklenen coin miktari" uydurmaz. Henuz canli
// pozisyon defterimiz olmadigi icin sadece kesin olarak bildigimiz seyleri
// dogrular: hesap okunabiliyor mu, belirsiz emir var mi, borsada botun
// tanimadigi acik emir var mi?

const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

function normalizeBalances(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Borsa bakiye cevabı nesne değil veya boş.');
  }
  const out = {};
  for (const [asset, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Geçersiz bakiye verisi: ${asset}`);
    }
    const free = Number(value.free ?? 0);
    const locked = Number(value.locked ?? 0);
    if (!Number.isFinite(free) || !Number.isFinite(locked) || free < 0 || locked < 0 || !Number.isFinite(free + locked)) {
      throw new Error(`Geçersiz bakiye verisi: ${asset}`);
    }
    out[String(asset).toUpperCase()] = { free, locked, total: free + locked };
  }
  return out;
}


function splitPair(symbol) {
  const parts = String(symbol || '').toUpperCase().split('/');
  return parts.length === 2 && parts[0] && parts[1] ? { base: parts[0], quote: parts[1] } : { base: null, quote: null };
}

function managedBaseAssets(state) {
  const out = new Set();
  for (const symbol of Object.keys(state?.pairs || {})) {
    const { base } = splitPair(symbol);
    if (base) out.add(base);
  }
  for (const position of Object.values(state?.live?.positions || {})) {
    const { base } = splitPair(position?.symbol);
    if (base) out.add(base);
    else if (position?.baseAsset) out.add(String(position.baseAsset).toUpperCase());
  }
  return out;
}

function checkManagedBalances(state, balances) {
  const positions = state?.live?.positions || {};
  const assets = managedBaseAssets(state);
  const mismatches = [];
  for (const asset of assets) {
    const total = Number(balances?.[asset]?.total || 0);
    if (!Number.isFinite(total) || total < 0) {
      mismatches.push({ asset, expected: null, actual: total, reason: 'invalid_exchange_balance' });
      continue;
    }
    // Testnet başlangıç bakiyeleri bot pozisyonu değildir. Açıkça kaydedilmiş
    // başlangıç envanteri varsa, yerel pozisyon miktarlarına eklenir. Production
    // hesaplarında otomatik baseline oluşturulmaz.
    const rawBaseline = state?.live?.balanceBaselineByAsset?.[asset] ?? 0;
    const baseline = Number(rawBaseline);
    if (!Number.isFinite(baseline) || baseline < 0) {
      mismatches.push({ asset, expected: null, actual: total, reason: 'invalid_local_baseline' });
      continue;
    }
    let expected = baseline;
    for (const p of Object.values(positions)) {
      const parsed = splitPair(p?.symbol);
      const positionBase = String(p?.baseAsset || parsed.base || '').toUpperCase();
      if (positionBase !== asset) continue;
      const quantity = Number(p?.quantity);
      const costQuote = Number(p?.costQuote ?? 0);
      if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(costQuote) || costQuote < 0) {
        mismatches.push({ asset, expected: null, actual: total, reason: 'invalid_local_position' });
        continue;
      }
      expected += quantity;
    }
    // Adim (stepSize) yuvarlamasindan kalan, satilamayan kucuk artiklar (dust) yerel defterde
    // ayrica tutulur; aksi halde her kapanan pozisyon sonrasi hesap "beklenmeyen bakiye" sayilip
    // canli islem sonsuza dek kilitlenirdi. Bozuk dust degeri NaN ile karsilastirmalari etkisizlestirip
    // mutabakati yanlislikla guvenli gostermemeli.
    const rawDust = state?.live?.dustByAsset?.[asset] ?? 0;
    const dust = Number(rawDust);
    if (!Number.isFinite(dust) || dust < 0) {
      mismatches.push({ asset, expected: null, actual: total, reason: 'invalid_local_dust' });
      continue;
    }
    expected += dust;
    // No position + a non-trivial managed asset balance means the account
    // contains inventory the bot does not own in its local ledger.
    const tolerance = Math.max(1e-12, expected * 1e-8);
    if (expected <= tolerance) {
      if (total > tolerance) {
        mismatches.push({ asset, expected, actual: total, reason: 'unexpected_asset_balance' });
      }
    } else if (Math.abs(total - expected) > tolerance) {
      mismatches.push({
        asset,
        expected,
        actual: total,
        reason: total < expected ? 'position_balance_shortfall' : 'unexpected_asset_balance'
      });
    }
  }
  return mismatches;
}

function localOpenOrderIds(state) {
  const ids = new Set();
  for (const order of Object.values(state?.liveOrders || {})) {
    if (!order || TERMINAL.has(String(order.status || '').toUpperCase())) continue;
    if (order.exchangeOrderId !== null && order.exchangeOrderId !== undefined) {
      ids.add(String(order.exchangeOrderId));
    }
  }
  return ids;
}

class AccountReconciler {
  constructor({ exchange, state, store, nowFn } = {}) {
    if (!exchange) throw new Error('AccountReconciler için exchange gerekli.');
    if (!state) throw new Error('AccountReconciler için state gerekli.');
    if (!store || typeof store.save !== 'function') throw new Error('AccountReconciler için store.save gerekli.');
    this.exchange = exchange;
    this.state = state;
    this.store = store;
    this.nowFn = nowFn || (() => Date.now());
  }

  async reconcile({ requireOpenOrders = true } = {}) {
    const checkedAt = new Date(this.nowFn()).toISOString();
    const result = {
      safeToTrade: false,
      checkedAt,
      exchange: this.exchange.id || this.exchange.name || 'unknown',
      balances: {},
      openOrders: [],
      unknownLocalOrders: [],
      orphanOpenOrders: [],
      errors: []
    };

    if (typeof this.exchange.fetchBalance !== 'function') {
      result.errors.push('Borsa bakiye sorgusunu desteklemiyor.');
      return this._save(result);
    }

    try {
      result.balances = normalizeBalances(await this.exchange.fetchBalance());
    } catch (err) {
      result.errors.push(`Bakiye sorgulanamadı: ${err?.message || String(err)}`);
      return this._save(result);
    }

    // UNKNOWN/PENDING/PARTIALLY_FILLED gibi kapanmamis yerel emirler varsa,
    // bunlar cozulmeden yeni canli islem baslatmak guvenli degildir.
    const localPending = Object.values(this.state.liveOrders || {})
      .filter((o) => o && !TERMINAL.has(String(o.status || '').toUpperCase()));

    const caps = this.exchange.capabilities || {};
    if (requireOpenOrders && caps.openOrdersQuery && typeof this.exchange.fetchOpenOrders === 'function') {
      try {
        const configuredSymbols = Object.keys(this.state.pairs || {});
        result.openOrders = await this.exchange.fetchOpenOrders(configuredSymbols);
        if (!Array.isArray(result.openOrders)) throw new Error('Borsa açık emir cevabı dizi değil.');
        const invalidOpenOrders = result.openOrders.filter((o) =>
          !o || typeof o !== 'object' || Array.isArray(o) ||
          o.orderId === null || o.orderId === undefined || String(o.orderId).trim() === '' ||
          typeof o.symbol !== 'string' || !o.symbol.trim() ||
          !['NEW', 'PARTIALLY_FILLED'].includes(String(o.status || '').toUpperCase())
        );
        if (invalidOpenOrders.length) {
          result.errors.push(`Borsa açık emir yanıtında ${invalidOpenOrders.length} kayıt kimlik/sembol/durum doğrulamasını geçemedi.`);
        }
        const maxOpenOrders = Number(this.state.settings?.maxOpenOrders || 12);
        if (result.openOrders.length > maxOpenOrders) result.errors.push(`Borsada açık emir sayısı üst sınırı aşıldı: ${result.openOrders.length}/${maxOpenOrders}.`);
        const knownIds = localOpenOrderIds(this.state);
        result.orphanOpenOrders = result.openOrders
          .filter((o) => o?.orderId !== undefined && o?.orderId !== null)
          .filter((o) => !knownIds.has(String(o.orderId)))
          .map((o) => ({ ...o,
            orderId: o.orderId,
            clientOrderId: o.clientOrderId || null,
            symbol: o.symbol,
            side: o.side,
            status: o.status,
            executedQty: Number(o.executedQty || 0)
          }));

        // Kendi açık emirlerimiz (özellikle koruyucu stoplar) güvenlidir;
        // bunları sadece açık oldukları için "belirsiz" sayamayız. Ancak yerel
        // kayıt borsada artık açık değilse, WebSocket kaçırılmış olabilir; bu
        // durumda order manager'ın ayrıca sorgulaması gerekir ve canlı kapı kapanır.
        const openIdSet = new Set(result.openOrders.map((o) => String(o.orderId)));
        result.unknownLocalOrders = localPending
          .filter((o) => o.exchangeOrderId == null || !openIdSet.has(String(o.exchangeOrderId)))
          .map((o) => ({
            clientOrderId: o.clientOrderId,
            exchangeOrderId: o.exchangeOrderId ?? null,
            symbol: o.symbol,
            status: o.status
          }));
      } catch (err) {
        result.errors.push(`Açık emirler sorgulanamadı: ${err?.message || String(err)}`);
      }
    } else if (requireOpenOrders) {
      result.errors.push('Açık emir sorgulama desteği yok; canlı işlem güvenli şekilde başlatılamaz.');
    }

    // Quote bakiyeleri de pozisyonlar gibi parite bazında anlamlıdır. TRY ve USDT
    // aynı 'cash' havuzu değildir; bu yüzden beklenen quote varlıklarını ayrı izleriz.
    const expectedQuotes = new Set();
    for (const symbol of Object.keys(this.state.pairs || {})) { const { quote } = splitPair(symbol); if (quote) expectedQuotes.add(quote); }
    for (const position of Object.values(this.state.live?.positions || {})) { if (position?.quoteAsset) expectedQuotes.add(String(position.quoteAsset).toUpperCase()); else { const { quote } = splitPair(position?.symbol); if (quote) expectedQuotes.add(quote); } }
    result.quoteBalances = {};
    for (const quote of expectedQuotes) result.quoteBalances[quote] = result.balances?.[quote] || { free: 0, locked: 0, total: 0 };

    result.balanceMismatches = checkManagedBalances(this.state, result.balances);
    if (result.balanceMismatches.length) {
      result.errors.push('Yönetilen varlık bakiyesi yerel pozisyon defteriyle uyuşmuyor.');
    }

    // Açık bir pozisyon varsa, onun koruyucu stopunun da borsada gerçekten
    // açık olması gerekir. Sadece bakiye eşleşmesi yeterli değildir: stop
    // iptal edilmiş, dolmuş veya WebSocket mesajı kaçırılmış olabilir.
    // Böyle bir pozisyonu yeni işlem kapısından güvenli kabul etmiyoruz.
    const positions = this.state.live?.positions || {};
    for (const [symbol, position] of Object.entries(positions)) {
      const stopId = position?.stopOrderId;
      if (!stopId) {
        result.errors.push(`Koruyucu stop kaydı yok: ${symbol}`);
        continue;
      }
      const localStop = this.state.liveOrders?.[stopId];
      if (!localStop) {
        result.errors.push(`Koruyucu stop yerel kayıtta yok: ${symbol} / ${stopId}`);
        continue;
      }
      const stopStatus = String(localStop.status || '').toUpperCase();
      if (stopStatus !== 'NEW' && stopStatus !== 'PARTIALLY_FILLED') {
        result.errors.push(`Koruyucu stop açık değil: ${symbol} / ${stopId} / ${stopStatus}`);
        continue;
      }
      const exchangeOpen = result.openOrders.find((o) =>
        String(o.orderId) === String(localStop.exchangeOrderId) ||
        (o.clientOrderId && String(o.clientOrderId) === String(stopId))
      );
      if (!exchangeOpen) {
        result.errors.push(`Koruyucu stop borsada açık değil: ${symbol} / ${stopId}`);
      }
    }

    result.safeToTrade = result.errors.length === 0 &&
      result.unknownLocalOrders.length === 0 &&
      result.orphanOpenOrders.length === 0;

    return this._save(result);
  }

  _save(result) {
    this.state.liveReconciliation = result;
    this.store.save(this.state);
    return result;
  }
}

module.exports = { AccountReconciler, normalizeBalances, localOpenOrderIds, managedBaseAssets, checkManagedBalances };
