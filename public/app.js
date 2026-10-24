const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const hm = (iso) => new Date(iso).toLocaleTimeString('tr-TR');

// Sunucudan/borsadan gelen HER metin innerHTML'e girmeden once kacislanir
// (hata mesajlari, parite adlari, strateji aciklamalari...).
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

let currentState = null;
let strategiesCache = [];

// ---- Kucuk bildirim (toast): yeniden cizimlerden etkilenmez ----
function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText =
    'position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
    'background:var(--ac);color:#fff;padding:8px 16px;border-radius:8px;font-weight:600;z-index:90;max-width:90%';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}
const guard = (promise) => promise.catch((e) => alert(e.message));

// ---- Güvenli panel girişi (server-side session) ----
function askPassword(message) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99;padding:16px';
    ov.innerHTML =
      '<div class="c" style="max-width:340px;width:100%"><h2>Panel şifresi</h2><p class="mu" id="pwMsg"></p>' +
      '<input type="password" id="pwInput" autocomplete="current-password"><button id="pwOk">Giriş</button></div>';
    document.body.appendChild(ov);
    $('pwMsg').textContent = message || 'Bu panel şifreyle korunuyor.';
    const input = $('pwInput');
    input.focus();
    const done = () => {
      const v = input.value;
      ov.remove();
      resolve(v);
    };
    $('pwOk').addEventListener('click', done);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
  });
}

let loginPromise = null;
let reauthPromise = null;
function ensureLogin() {
  if (!loginPromise) {
    loginPromise = (async () => {
      let msg = '';
      for (;;) {
        const pw = await askPassword(msg);
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw })
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) return;
        if (body.setupRequired) {
          alert(body.error || 'Panel kurulumu gerekli.');
          throw new Error(body.error || 'Panel kimliği ayarlı değil.');
        }
        msg = body.error || 'Giriş başarısız.';
      }
    })().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

async function ensureReauth() {
  if (!reauthPromise) {
    reauthPromise = (async () => {
      const pw = await askPassword('Hassas işlem için şifreni yeniden doğrula.');
      const res = await fetch('/api/reauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Yeniden doğrulama başarısız.');
    })().finally(() => { reauthPromise = null; });
  }
  return reauthPromise;
}

async function api(pathname, opts = {}, retried = false, reauthed = false) {
  const res = await fetch(pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.authRequired && !retried) {
    await ensureLogin();
    return api(pathname, opts, true, reauthed);
  }
  if (res.status === 428 && body.reauthRequired && !reauthed) {
    await ensureReauth();
    return api(pathname, opts, retried, true);
  }
  if (!res.ok) throw new Error(body.error || `${pathname} başarısız`);
  return body;
}

function renderTimeframeTable(state) {
  const body = document.getElementById('tfTableBody');
  if (!body) return;
  const yn = (v) => (v ? '✅' : '—');
  body.innerHTML = (state.timeframes || []).map((t) => `<tr><td>${esc(t.label)}${t.unsupportedOn?.length ? ' *' : ''}</td><td>${yn(t.aggressive)}</td><td>${yn(t.normal)}</td><td>${yn(t.live)}</td><td>${t.maxPollSeconds ? esc(t.maxPollSeconds) + ' sn' : 'sınır yok'}</td></tr>`).join('') + ((state.timeframes || []).some((t) => t.unsupportedOn?.length) ? '<tr><td colspan="5" class="mu">* 3 dk: BTCTurk ve Paribu desteklemez.</td></tr>' : '');
}

function render(state) {
  currentState = state;
  renderTimeframeTable(state);
  const st = $('st');
  st.textContent = state.running ? '● ÇALIŞIYOR' : '● DURDU';
  st.className = 'badge ' + (state.running ? 'on' : 'off');

  const p = state.paper;
  const lp = p.lastPrices || {};
  const eqBy = state.paperEquityByAsset || {};
  const eqQuotes = Object.keys(eqBy);
  const equity = eqQuotes.length === 1 ? Number(eqBy[eqQuotes[0]] || 0) : null;
  $('eq').textContent = equity === null ? 'Çoklu kasa' : (fmt(equity) + ' ' + eqQuotes[0]);
  const dayPnlPct = p.dayStartEquity > 0 ? ((equity - p.dayStartEquity) / p.dayStartEquity) * 100 : 0;
  const dp = $('dp');
  dp.textContent = (dayPnlPct >= 0 ? '+' : '') + fmt(dayPnlPct, 2) + '%';
  dp.className = 'big ' + (dayPnlPct >= 0 ? 'u' : 'd');
  $('op').textContent = Object.keys(p.positions).length;

  $('scanVolHeader').textContent = `24s hacim (${(state.settings && state.settings.quoteAsset) || state.quoteAsset || 'USDT'})`;
  renderExchangeSelect(state);
  renderVaultBox(state);
  renderMode(state);
  renderKill(state);
  renderNotify(state);
  renderPairs(state);
  updateDecisions(state);
  renderPositions(state);
  renderTrades(state);
  renderPerformance(state);
  renderRisk(state);
  syncBacktestControls(state);
  syncChartControls(state);
  renderPortfolioSettings(state.settings);
  renderLog(state.log);
}

// ---- Borsa secimi ----
function renderExchangeSelect(state) {
  const sel = $('exSel');
  if (!sel.dataset.filled) {
    sel.innerHTML = state.exchanges.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
    sel.dataset.filled = '1';
  }
  sel.value = state.settings.exchange;
}
$('exSel').addEventListener('change', async (e) => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ exchange: e.target.value }) });
  } catch (err) {
    alert(err.message);
    if (currentState) $('exSel').value = currentState.settings.exchange; // reddedildiyse eski secime don
  }
});

// ---- Kasa (şifreli API anahtarı) ----
// Kasa kutusu SADECE kasanin durumu degisince yeniden cizilir (kilit acildi/kapandi,
// anahtar eklendi/silindi). Boylece yarim yazilmis anahtar/sifre, her canli
// guncellemede silinmez.
let vaultSignature = null;
function renderVaultBox(state) {
  const v = state.vault;
  const signature = JSON.stringify([v.initialized, v.unlocked, v.exchangesWithKeys, v.error || '', state.exchanges.map((e) => e.id)]);
  if (signature === vaultSignature) return;
  vaultSignature = signature;
  const box = $('vaultBox');

  if (v.error) {
    box.innerHTML = `<p class="d">Kasa dosyası okunamadı: ${esc(v.error)}</p>`;
    return;
  }

  if (!v.initialized) {
    box.innerHTML = `
      <p class="mu">API anahtarlarını şifreli saklamak için bir ana şifre belirle. Bu şifre hiçbir dosyaya yazılmaz, sadece sunucu açıkken bellekte tutulur; sunucu yeniden başlarsa tekrar girmen gerekir.</p>
      <label for="vpPass">Ana şifre (en az 12 karakter)</label>
      <input type="password" id="vpPass" autocomplete="new-password">
      <button id="vpCreate">Kasa oluştur</button>`;
    $('vpCreate').addEventListener('click', () =>
      guard(api('/api/vault/unlock', { method: 'POST', body: JSON.stringify({ passphrase: $('vpPass').value }) }))
    );
    return;
  }

  if (!v.unlocked) {
    box.innerHTML = `
      <p class="mu">Kasa kilitli.</p>
      <label for="vpPass">Ana şifre</label>
      <input type="password" id="vpPass" autocomplete="current-password">
      <button id="vpUnlock">Kilidi aç</button>`;
    $('vpUnlock').addEventListener('click', () =>
      guard(api('/api/vault/unlock', { method: 'POST', body: JSON.stringify({ passphrase: $('vpPass').value }) }))
    );
    return;
  }

  const savedRows = v.exchangesWithKeys.length
    ? v.exchangesWithKeys
        .map((id) => {
          const ex = state.exchanges.find((e) => e.id === id);
          return `<div class="keyRow"><span>${esc(ex ? ex.name : id)} — kayıtlı</span><button data-removekey="${esc(id)}">Sil</button></div>`;
        })
        .join('')
    : '<div class="mu">Henüz kayıtlı anahtar yok.</div>';

  box.innerHTML = `
    <div class="vaultRow"><span class="chip on">Kasa açık</span><button class="s" id="vpLock" style="width:auto;margin:0;padding:4px 8px;font-size:12px">Kilitle</button></div>
    ${savedRows}
    <label for="vpExchange">Borsa</label>
    <select id="vpExchange">${state.exchanges.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</select>
    <label for="vpApiKey">API Key</label>
    <input id="vpApiKey" autocomplete="off">
    <label for="vpApiSecret">API Secret</label>
    <input id="vpApiSecret" type="password" autocomplete="off">
    <label for="vpApiPassphrase">API Passphrase (yalnızca Coinbase Exchange, OKX, OKX TR)</label>
    <input id="vpApiPassphrase" type="password" autocomplete="off">
    <button id="vpSaveKeys">Anahtarı kaydet</button>
    <p class="mu">Kağıt işlem modu bu anahtarlara ihtiyaç duymaz; ileride canlı faz için saklanır. Sadece spot işlem izni olan, para çekme izni kapalı bir anahtar kullan.</p>`;

  $('vpLock').addEventListener('click', () => guard(api('/api/vault/lock', { method: 'POST' })));
  $('vpSaveKeys').addEventListener('click', async () => {
    try {
      await api('/api/vault/keys', {
        method: 'POST',
        body: JSON.stringify({ exchange: $('vpExchange').value, apiKey: $('vpApiKey').value, apiSecret: $('vpApiSecret').value, apiPassphrase: $('vpApiPassphrase').value || undefined })
      });
      $('vpApiKey').value = '';
      $('vpApiSecret').value = '';
      $('vpApiPassphrase').value = '';
      toast('Anahtar kaydedildi ✓');
    } catch (e) { alert(e.message); }
  });
  box.querySelectorAll('[data-removekey]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm(`${btn.dataset.removekey} için kayıtlı anahtarı silmek istediğine emin misin?`)) return;
      guard(api(`/api/vault/keys/${encodeURIComponent(btn.dataset.removekey)}`, { method: 'DELETE' }));
    });
  });
}

// ---- Pariteler (her biri kendi stratejisi + kendi parametreleri) ----
function paramFieldHtml(field, value) {
  if (field.type === 'boolean') {
    return `<div class="full r"><span>${esc(field.label)}</span><input class="sw" type="checkbox" data-param="${esc(field.key)}" ${value ? 'checked' : ''}></div>`;
  }
  return `<div><label>${esc(field.label)}</label><input type="number" step="${esc(field.step ?? 1)}" ${field.min !== undefined ? `min="${esc(field.min)}"` : ''} ${field.max !== undefined ? `max="${esc(field.max)}"` : ''} data-param="${esc(field.key)}" value="${esc(value)}"></div>`;
}

// Pozisyon durumu: canli modda gercek hesap, aksi halde kagit hesap.
function pairHasPosition(state, symbol) {
  const src = state && state.settings && state.settings.mode === 'live' ? (state.live && state.live.positions) : (state.paper && state.paper.positions);
  return Boolean(src && src[symbol]);
}
// Acik/kapali olan kartlar (yeniden cizimde korunur).
const openPairs = new Set();

function pairCardHtml(symbol, pair, strategiesList) {
  const strategy = strategiesList.find((s) => s.id === pair.strategyId) || strategiesList[0];
  const fields = strategy.paramsSchema
    .map((f) => paramFieldHtml(f, (pair.params || {})[f.key] ?? strategy.defaultParams[f.key]))
    .join('');
  const isOpen = openPairs.has(symbol);
  const bodyId = 'pairBody-' + String(symbol).replace(/[^A-Za-z0-9]/g, '_');
  return `
    <div class="pairCard ${pair.enabled ? '' : 'off'} ${isOpen ? 'open' : ''}" data-symbol="${esc(symbol)}">
      <div class="pairRow">
        <div class="pairMain" data-expand="${esc(symbol)}">
          <span class="nameLine"><span class="name">${esc(symbol)}</span><span class="posState" data-posstate="${esc(symbol)}" title="Pozisyon yok">○ Pozisyon</span></span>
          <span class="sub stratName">${esc(strategy.name)}</span>
        </div>
        <div class="actions">
          <span class="chip ${pair.enabled ? 'on' : 'off'}" data-toggle="${esc(symbol)}" role="button" tabindex="0">${pair.enabled ? 'Aktif' : 'Pasif'}</span>
          <button class="s" data-delete="${esc(symbol)}">Sil</button>
          <button class="s arrow" data-arrow="${esc(symbol)}" aria-expanded="${isOpen ? 'true' : 'false'}" aria-controls="${bodyId}" aria-label="${esc(symbol)} ayrıntıları">▾</button>
        </div>
      </div>
      <div class="pairBody" id="${bodyId}" ${isOpen ? '' : 'hidden'}>
        <label>Strateji</label>
        <select data-strategy="${esc(symbol)}">
          ${strategiesList.map((s) => `<option value="${esc(s.id)}" ${s.id === pair.strategyId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <div class="fieldGrid">
          <div><label>Portföy kategorisi</label><select data-field="portfolioClass"><option value="core" ${pair.portfolioClass === 'core' ? 'selected' : ''}>Ana</option><option value="speculative" ${pair.portfolioClass === 'speculative' ? 'selected' : ''}>Spekülatif</option></select></div>
          <div><label>Bütçe payı (%)</label><input type="number" min="1" max="100" step="1" data-field="budgetPct" value="${esc(pair.budgetPct)}"></div>
          <div><label>Mum aralığı</label>
            <select data-field="timeframe">
              ${(currentState?.timeframes || []).map((t) => `<option value="${esc(t.id)}" ${pair.timeframe === t.id ? 'selected' : ''}>${esc(t.label)}${t.normal ? '' : ' (yalnız Agresif)'}</option>`).join('')}
            </select>
          </div>
          ${fields}
        </div>
        <div class="riskHint" data-risk-hint="${esc(symbol)}" hidden></div>
        <div class="decLine" data-decision="${esc(symbol)}"></div>
        <p class="mu">${esc(strategy.description)}</p>
        <button data-save="${esc(symbol)}">Kaydet</button>
      </div>
    </div>`;
}

// Satirdaki pozisyon yazisini (yesil = acik, gri = yok) karti yeniden cizmeden gunceller.
function updatePairStatuses(state) {
  document.querySelectorAll('#pairList [data-posstate]').forEach((el) => {
    const open = pairHasPosition(state, el.dataset.posstate);
    el.textContent = open ? '● Pozisyon' : '○ Pozisyon';
    el.title = open ? 'Pozisyon açık' : 'Pozisyon yok';
    el.classList.toggle('open', open);
  });
}

// Kullanicinin kaydetmedigi duzenlemesi olan kartlar (yeniden cizimde korunur).
const dirtyPairs = new Set();
$('pairList').addEventListener('input', markDirty);
$('pairList').addEventListener('change', markDirty);
function markDirty(e) {
  const t = e.target;
  if (!t.dataset || (t.dataset.field === undefined && t.dataset.param === undefined)) return;
  const card = t.closest('.pairCard');
  if (card) dirtyPairs.add(card.dataset.symbol);
}

function updateRiskHint(card) {
  const hint = card.querySelector('[data-risk-hint]');
  if (!hint) return;
  const slEl = card.querySelector('[data-param="stopLossPct"]');
  const tpEl = card.querySelector('[data-param="takeProfitPct"]');
  if (!slEl || !tpEl) { hint.hidden = true; hint.textContent = ''; return; }
  const sl = Number(slEl.value);
  const tp = Number(tpEl.value);
  if (Number.isFinite(sl) && Number.isFinite(tp) && tp > 0 && sl > tp) {
    hint.hidden = false;
    hint.className = 'riskHint warn';
    hint.textContent = `Uyarı: Kâr koruma eşiği %${tp} ve stop mesafesi %${sl}. TP sonrası fiyat ${sl}% kadar geri çekilirse kârın büyük kısmı geri verilebilir; koruma başabaş altına bırakılmaz.`;
  } else {
    hint.hidden = true;
    hint.textContent = '';
  }
}

function buildPairCard(symbol, state) {
  const tmp = document.createElement('div');
  tmp.innerHTML = pairCardHtml(symbol, state.pairs[symbol], state.strategies);
  const card = tmp.firstElementChild;

  const setOpen = (open) => {
    const body = card.querySelector('.pairBody');
    const arrow = card.querySelector('[data-arrow]');
    body.hidden = !open;
    card.classList.toggle('open', open);
    arrow.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) openPairs.add(symbol); else openPairs.delete(symbol);
  };
  card.querySelector('[data-arrow]').addEventListener('click', () => setOpen(card.querySelector('.pairBody').hidden));
  card.querySelector('[data-expand]').addEventListener('click', () => setOpen(card.querySelector('.pairBody').hidden));
  card.querySelector('[data-toggle]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
  });
  card.querySelector('[data-toggle]').addEventListener('click', () => {
    const enabled = currentState.pairs[symbol].enabled;
    guard(api(`/api/pairs/${encodeURIComponent(symbol)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !enabled }) }));
  });
  card.querySelector('[data-delete]').addEventListener('click', () => {
    if (!confirm(`${symbol} listeden silinsin mi? Açık pozisyon varsa son bilinen fiyattan (kağıt olarak) kapatılır.`)) return;
    dirtyPairs.delete(symbol);
    openPairs.delete(symbol);
    guard(api(`/api/pairs/${encodeURIComponent(symbol)}`, { method: 'DELETE' }));
  });
  const stratSel = card.querySelector('[data-strategy]');
  stratSel.addEventListener('change', () => {
    if (!confirm('Strateji değiştirilince bu paritenin parametreleri yeni stratejinin varsayılanlarına sıfırlanır. Devam edilsin mi?')) {
      stratSel.value = currentState.pairs[symbol].strategyId;
      return;
    }
    dirtyPairs.delete(symbol); // yeni stratejinin formu gelsin
    guard(api(`/api/pairs/${encodeURIComponent(symbol)}`, { method: 'PATCH', body: JSON.stringify({ strategyId: stratSel.value }) }));
  });
  card.querySelectorAll('[data-param="stopLossPct"],[data-param="takeProfitPct"]').forEach((el) => {
    el.addEventListener('input', () => updateRiskHint(card));
  });
  updateRiskHint(card);

  card.querySelector('[data-save]').addEventListener('click', async () => {
    updateRiskHint(card);
    const budgetPct = Number(card.querySelector('[data-field="budgetPct"]').value);
    const portfolioClass = card.querySelector('[data-field="portfolioClass"]').value;
    const timeframe = card.querySelector('[data-field="timeframe"]').value;
    const params = {};
    card.querySelectorAll('[data-param]').forEach((input) => {
      params[input.dataset.param] = input.type === 'checkbox' ? input.checked : Number(input.value);
    });
    try {
      const res = await api(`/api/pairs/${encodeURIComponent(symbol)}`, { method: 'PATCH', body: JSON.stringify({ budgetPct, portfolioClass, timeframe, params }) });
      dirtyPairs.delete(symbol);
      if (currentState && res.pair) {
        currentState.pairs[symbol] = res.pair; // sunucunun dogruladigi degerlerle yenile
        renderPairs(currentState);
      }
      toast(`${symbol} kaydedildi ✓`);
    } catch (e) { alert(e.message); }
  });
  return card;
}

function renderPairs(state) {
  const box = $('pairList');
  const symbols = Object.keys(state.pairs);

  box.querySelectorAll(':scope > .mu').forEach((el) => el.remove());
  const wanted = new Set(symbols);
  box.querySelectorAll('.pairCard').forEach((el) => {
    if (!wanted.has(el.dataset.symbol)) {
      dirtyPairs.delete(el.dataset.symbol);
      openPairs.delete(el.dataset.symbol);
      el.remove();
    }
  });
  if (!symbols.length) {
    box.innerHTML = '<div class="mu">Henüz parite eklenmedi.</div>';
    return;
  }

  symbols.forEach((symbol) => {
    const old = box.querySelector(`.pairCard[data-symbol="${CSS.escape(symbol)}"]`);
    // Duzenleme yarida ise (kaydedilmemis degisiklik ya da odakta bir sayi/mum alani) karti yeniden cizme.
    const a = document.activeElement;
    const editing = !!(a && a.dataset && (a.dataset.field !== undefined || a.dataset.param !== undefined) && old && old.contains(a));
    if (old && (dirtyPairs.has(symbol) || editing)) return;
    const card = buildPairCard(symbol, state);
    if (old) old.replaceWith(card);
    else box.appendChild(card);
  });
  updatePairStatuses(state);
}

// ---- Yeni parite ekleme ----
$('addPairBtn').addEventListener('click', async () => {
  const symbol = $('newSymbol').value.trim().toUpperCase();
  const strategyId = $('newStrategy').value;
  if (!symbol) return;
  try {
    await api('/api/pairs', { method: 'POST', body: JSON.stringify({ symbol, strategyId }) });
    $('newSymbol').value = '';
  } catch (e) { alert(e.message); }
});

// ---- Pozisyonlar / işlemler ----
function renderPositions(state) {
  const entries = Object.entries(state.paper.positions);
  $('posEmpty').style.display = entries.length ? 'none' : '';
  $('posTable').style.display = entries.length ? '' : 'none';
  const lastPrices = state.paper.lastPrices || {};
  $('posBody').innerHTML = entries
    .map(([symbol, pos]) => {
      const current = lastPrices[symbol] ?? pos.entryPrice;
      const pnlPct = ((current - pos.entryPrice) / pos.entryPrice) * 100;
      const stop = pos.stopPrice === null || pos.stopPrice === undefined ? '-' : fmt(pos.stopPrice, 6);
      return `<tr>
        <td>${esc(symbol)}</td><td>${fmt(pos.entryPrice, 6)}</td><td>${fmt(current, 6)}</td>
        <td>${fmt(pos.quantity, 6)}</td><td>${stop}</td>
        <td class="${pnlPct >= 0 ? 'u' : 'd'}">${pnlPct >= 0 ? '+' : ''}${fmt(pnlPct, 2)}%</td>
      </tr>`;
    })
    .join('');
}

function renderTrades(state) {
  const trades = state.paper.trades;
  $('tradeEmpty').style.display = trades.length ? 'none' : '';
  $('tradeTable').style.display = trades.length ? '' : 'none';
  $('tradeBody').innerHTML = trades
    .slice(0, 30)
    .map(
      (t) => `<tr>
        <td>${esc(t.symbol)}</td><td class="mu">${esc(t.reason)}</td>
        <td>${fmt(t.entryPrice, 4)} → ${fmt(t.exitPrice, 4)}</td>
        <td class="${t.pnl >= 0 ? 'u' : 'd'}">${t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)} (${fmt(t.pnlPct, 1)}%)</td>
        <td class="mu">${hm(t.closedAt)}</td>
      </tr>`
    )
    .join('');
}

// ---- Portfoy geneli ayarlar ----
const PORTFOLIO_FIELDS = [
  ['maxPos', 'maxConcurrentPositions', 'Aynı anda maks. pozisyon'],
  ['reservePct', 'reserveCashPct', 'Hiç kullanılmayacak pay'],
  ['dailyLoss', 'dailyLossLimitPct', 'Günlük zarar limiti'],
  ['pollSeconds', 'pollSeconds', 'Kontrol sıklığı'],
  ['startBal', 'paperStartingBalance', 'Başlangıç bakiyesi'],
  ['killPct', 'killSwitchLossPct', 'Kill switch'],
  ['maxTrade', 'maxTradeQuote', 'İşlem başına üst tutar'],
  ['feePct', 'paperFeePct', 'Komisyon'],
  ['slipPct', 'paperSlippagePct', 'Kayma']
];
const POLICY_FIELDS = [['coreMaxPos','core','maxPositions'],['coreCapPct','core','maxCapitalPct'],['specMaxPos','speculative','maxPositions'],['specCapPct','speculative','maxCapitalPct']];
POLICY_FIELDS.forEach(([id]) => $(id).addEventListener('input', () => { portfolioDirty = true; }));
let portfolioDirty = false;
PORTFOLIO_FIELDS.forEach(([id]) => $(id).addEventListener('input', () => { portfolioDirty = true; }));
$('closeOnLoss').addEventListener('change', () => { portfolioDirty = true; });

function renderPortfolioSettings(s) {
  if (portfolioDirty) return; // kaydedilmemis duzenleme varsa uzerine yazma
  PORTFOLIO_FIELDS.forEach(([id, key]) => { $(id).value = s[key] ?? ''; });
  $('closeOnLoss').checked = true; // güvenli duruş için zorunlu
  const pol=s.portfolioPolicy || {}; const b=pol.buckets || {};
  for(const [id,key,field] of POLICY_FIELDS) $(id).value = b[key]?.[field] ?? (field==='maxPositions'?0:100);
}

$('saveSettings').addEventListener('click', async () => {
  const body = {};
  for (const [id, key, label] of PORTFOLIO_FIELDS) {
    const raw = $(id).value.trim();
    if (raw === '') { alert(`${label}: boş bırakılamaz.`); return; }
    body[key] = Number(raw);
  }
  body.closeOnDailyLoss = true; // pozisyonları korumasız bırakmaya izin verme
  const currentPolicy=(currentState?.settings?.portfolioPolicy)||{};
  const buckets={...(currentPolicy.buckets||{})};
  for(const [id,key,field] of POLICY_FIELDS){ buckets[key]={...(buckets[key]||{label:key==='core'?'Ana':'Spekülatif'}), [field]:Number($(id).value)}; }
  body.portfolioPolicy={maxPositions:Number($('maxPos').value),reserveCashPct:Number($('reservePct').value),buckets};
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    portfolioDirty = false;
    if (currentState) renderPortfolioSettings(currentState.settings);
    toast('Ayarlar kaydedildi ✓');
  } catch (e) { alert(e.message); }
});

function renderLog(log) {
  $('log').innerHTML = log.map((l) => `<div>[${hm(l.t)}] ${esc(l.msg)}</div>`).join('');
}

// ---- kontroller ----
$('startBtn').addEventListener('click', () => guard(api('/api/control', { method: 'POST', body: JSON.stringify({ action: 'start' }) })));
$('stopBtn').addEventListener('click', () => guard(api('/api/control', { method: 'POST', body: JSON.stringify({ action: 'stop' }) })));
$('resetBtn').addEventListener('click', () => {
  if (!confirm('Kağıt hesabı sıfırlanacak: bakiye, pozisyonlar, işlem geçmişi ve log silinir. (Ayarlar ve pariteler korunur.) Emin misin?')) return;
  guard(api('/api/control', { method: 'POST', body: JSON.stringify({ action: 'reset' }) }));
});

$('scanBtn').addEventListener('click', async () => {
  $('scanBtn').textContent = 'Taranıyor...';
  try {
    const { results } = await api('/api/scanner');
    $('scanTable').style.display = results.length ? '' : 'none';
    $('scanBody').innerHTML = results
      .map(
        (r) => `<tr>
          <td>${esc(r.symbol)}</td><td>${fmt(r.lastPrice, 4)}</td>
          <td class="${r.changePct >= 0 ? 'u' : 'd'}">${r.changePct >= 0 ? '+' : ''}${fmt(r.changePct, 2)}%</td>
          <td>${fmt(r.quoteVolume, 0)}</td>
          <td><button class="s" data-watch="${esc(r.symbol)}" style="width:auto;margin:0;padding:4px 8px;font-size:12px">İzle</button></td>
        </tr>`
      )
      .join('');
    $('scanBody').querySelectorAll('[data-watch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api('/api/pairs', { method: 'POST', body: JSON.stringify({ symbol: btn.dataset.watch, strategyId: strategiesCache[0] && strategiesCache[0].id }) });
          toast(`${btn.dataset.watch} izlemeye eklendi ✓`);
        } catch (e) { alert(e.message); }
      });
    });
  } catch (e) {
    alert('Tarama başarısız: ' + e.message);
  } finally {
    $('scanBtn').textContent = 'Tara';
  }
});

// ---- WebSocket canli guncelleme, kopunca REST'e dusup yeniden dener ----
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => { $('wsSt').textContent = 'canlı bağlı'; $('wsSt').className = 'badge on'; };
  ws.onclose = () => { $('wsSt').textContent = 'bağlantı koptu, yeniden deneniyor...'; $('wsSt').className = 'badge off'; setTimeout(connectWs, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') {
      if (msg.state.strategies) strategiesCache = msg.state.strategies;
      if (!$('newStrategy').dataset.filled && strategiesCache.length) {
        $('newStrategy').innerHTML = strategiesCache.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
        $('newStrategy').dataset.filled = '1';
      }
      render(msg.state);
    }
  };
}

// ---- Görsel karar kartı (her parite için; yalnızca motorun gerçek kararını gösterir) ----
const ACTION_LABEL = { hold: 'BEKLE', buy: 'AL sinyali', sell: 'SAT sinyali' };
const clock = (ms) => new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const fp = (p) => Number(p).toLocaleString('tr-TR', { maximumFractionDigits: p >= 1000 ? 2 : p >= 1 ? 4 : 6 });

function addDecisionPill(parent, label, tone) {
  const pill = document.createElement('span');
  pill.className = `decisionPill ${tone || 'neutral'}`;
  pill.textContent = label;
  parent.appendChild(pill);
}

function updateDecisions(state) {
  document.querySelectorAll('.decLine[data-decision]').forEach((el) => {
    const symbol = el.dataset.decision;
    const d = (state.decisions || {})[symbol];
    const pair = state.pairs && state.pairs[symbol];
    const hasPosition = state.settings?.mode === 'live'
      ? Boolean(state.live?.positions && state.live.positions[symbol])
      : Boolean(state.paper?.positions && state.paper.positions[symbol]);
    const view = window.DecisionView.deriveDecisionView({ decision: d, enabled: Boolean(pair && pair.enabled), hasPosition });

    el.replaceChildren();
    el.className = `decLine visualDecision ${view.status.tone}`;

    const head = document.createElement('div');
    head.className = 'decisionTop';
    const title = document.createElement('strong');
    title.textContent = 'STRATEJİ KARARI';
    head.appendChild(title);
    addDecisionPill(head, view.status.label, view.status.tone);
    el.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'decisionPills';
    addDecisionPill(chips, `Parite: ${view.pair.label}`, view.pair.tone);
    addDecisionPill(chips, `Veri: ${view.data.label}`, view.data.tone);
    addDecisionPill(chips, `Pozisyon: ${view.position.label}`, view.position.tone);
    el.appendChild(chips);

    const reason = document.createElement('div');
    reason.className = 'decisionReason';
    const reasonLabel = document.createElement('b');
    reasonLabel.textContent = 'Neden: ';
    reason.appendChild(reasonLabel);
    reason.appendChild(document.createTextNode(view.reason));
    el.appendChild(reason);

    if (d && d.action === 'buy' && !hasPosition && pair && pair.enabled && !view.stale && !view.error) {
      const hint = document.createElement('div');
      hint.className = 'decisionHint';
      hint.textContent = 'AL sinyali, pozisyonun kesin açıldığı anlamına gelmez. Bakiye, risk limiti veya emir kuralı alımı engellerse ayrıntı Log kayıtlarında görünür.';
      el.appendChild(hint);
    }
    if (view.error) {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = '⚠ ' + view.error;
      el.appendChild(err);
    }
    if (view.evaluatedAt || view.checkedAt || view.price !== null) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      const parts = [];
      if (view.candleT) parts.push(`mum kapanışı ${clock(view.candleT)}`);
      if (view.evaluatedAt) parts.push(`karar ${clock(Date.parse(view.evaluatedAt))}`);
      if (view.checkedAt) parts.push(`son kontrol ${new Date(view.checkedAt).toLocaleTimeString('tr-TR')}`);
      if (view.price !== null) parts.push(`fiyat ${fp(view.price)}`);
      sub.textContent = parts.join(' · ');
      el.appendChild(sub);
    }
  });
}

// ---- Çalışma modu seçici ----
let liveConfirmPending = false;
async function setMode(mode) {
  if (currentState?.running) { alert('Mod değiştirmek için önce botu durdur.'); return; }
  if (mode === 'live') {
    liveConfirmPending = true;
    $('liveConfirm').style.display = '';
    $('liveConfirmStatus').textContent = '';
    $('liveAck').checked = false;
    $('liveConfirmBtn').disabled = true;
    $('liveAck').focus();
    return;
  }
  try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode }) }); }
  catch (e) { alert(e.message); }
}
$('modeSwitch').addEventListener('click', () => {
  const live = currentState?.settings?.mode === 'live';
  setMode(live ? 'paper' : 'live');
});
$('liveAck').addEventListener('change', () => {
  $('liveConfirmBtn').disabled = !$('liveAck').checked;
});
$('liveConfirmBtn').addEventListener('click', async () => {
  if (!$('liveAck').checked || !liveConfirmPending) return;
  const btn = $('liveConfirmBtn');
  const status = $('liveConfirmStatus');
  btn.disabled = true;
  status.textContent = 'Canlı geçiş ön kontrolleri çalışıyor…';
  try {
    const preflight = await api('/api/live/preflight?forTransition=1');
    if (!preflight.safe) {
      const failed = (preflight.checks || []).filter(c => !c.ok).map(c => `${c.label}: ${c.detail}`).join(' · ');
      status.textContent = 'Canlı moda geçiş engellendi. ' + (failed || 'Güvenlik kontrolleri geçmedi.');
      btn.disabled = false;
      return;
    }
    if (!preflight.transitionToken) throw new Error('Güvenlik ön kontrolü geçerli bir geçiş anahtarı üretmedi.');
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'live', livePreflightToken: preflight.transitionToken }) });
    liveConfirmPending = false;
    $('liveConfirm').style.display = 'none';
    $('liveAck').checked = false;
    status.textContent = '';
    toast('Canlı moda geçiş tamamlandı; bot başlatılmadan emir gönderilmez.');
  } catch (e) {
    status.textContent = 'Canlı moda geçiş başarısız: ' + e.message;
    btn.disabled = false;
  }
});

// ---- Calisma modu (KAGIT / CANLI) ve canli hesap durumu ----
// Canli modda panel kagit moduyla ayni gorunmemeli: rozet, uyari ve gercek hesap karti.
function renderMode(state) {
  const live = state.settings.mode === 'live';
  const modeSwitch = $('modeSwitch');
  modeSwitch.classList.toggle('live', live);
  modeSwitch.classList.toggle('paper', !live);
  modeSwitch.setAttribute('aria-checked', live ? 'true' : 'false');
  modeSwitch.disabled = !!state.running;
  $('paperModeLabel').classList.toggle('active', !live);
  $('liveModeLabel').classList.toggle('active', live);
  $('modeHint').textContent = live ? 'Gerçek emirler · API doğrulaması gerekli' : 'Gerçek veri · sanal emir';
  $('liveConfirm').style.display = (!live && liveConfirmPending) ? '' : 'none';
  if (!live) { $('liveAck').checked = false; $('liveConfirmBtn').disabled = true; }
  const badge = $('modeBadge');
  badge.textContent = live ? 'CANLI' : 'KAĞIT';
  badge.className = 'badge ' + (live ? 'off' : 'on');
  const note = $('modeNote');
  if (live) {
    note.className = 'note liveWarn';
    note.textContent = '🔴 CANLI MOD: gerçek emir gönderilebilir. "Kontrol", "Performans", "Açık pozisyonlar", "Son işlemler" ve grafikteki işaretler KAĞIT hesabına aittir. Gerçek hesabın durumu için "Canlı durum" kartına bak.';
  } else {
    note.className = 'note';
    note.innerHTML = '🟢 <b>PAPER MOD</b>: gerçek borsa fiyatlarını okur, emirleri <b>simüle eder</b>. Gerçek para hareket etmez.';
  }
  $('liveCard').style.display = live ? '' : 'none';
  if (!live) return;

  const L = state.live || {};
  const quote = (state.settings && state.settings.quoteAsset) || state.quoteAsset || 'USDT';
  const bal = L.lastBalance && L.lastBalance[quote];
  const stats = L.stats || {};
  const positions = Object.values(L.positions || {});
  const stream = state.liveStream || {};
  const cells = [
    ['Güvenlik kilidi', L.safeToTrade ? 'açık' : 'KİLİTLİ (yeni emir yok)', L.safeToTrade ? 'u' : 'd'],
    ['Son mutabakat', L.lastReconcileAt ? new Date(L.lastReconcileAt).toLocaleTimeString('tr-TR') : 'yok', ''],
    [`Serbest ${quote}`, bal ? fmt(bal.free, 2) : '-', ''],
    ['Başlangıç özsermaye', L.startingEquity ? fmt(L.startingEquity, 2) : '-', ''],
    ['Bugün gerçekleşen K/Z', fmt(L.dayRealizedPnl || 0, 2), (L.dayRealizedPnl || 0) >= 0 ? 'u' : 'd'],
    ['Toplam gerçekleşen K/Z', fmt(L.realizedPnl || 0, 2), (L.realizedPnl || 0) >= 0 ? 'u' : 'd'],
    ['Gerçek işlem sayısı', String(stats.trades || 0), ''],
    ['Canlı emir akışı', stream.connected ? 'bağlı' : 'bağlı değil', stream.connected ? 'u' : 'd']
  ];
  $('liveGrid').innerHTML = cells.map(([k, v, c]) => `<div><div class="k">${esc(k)}</div><div class="v ${c}">${esc(v)}</div></div>`).join('');

  $('livePos').innerHTML = positions.length
    ? '<div class="livePosRow mu"><span>Parite</span><span>Miktar</span><span>Giriş</span><span>Stop emri</span></div>' +
      positions.map((p) => {
        const protectedOk = !!p.stopOrderId;
        return `<div class="livePosRow ${protectedOk ? '' : 'warn'}"><span>${esc(p.symbol)}</span><span>${fmt(p.quantity, 6)}</span><span>${fmt(p.entryPrice, 4)}</span><span>${protectedOk ? 'borsada · ' + fmt(p.stopPrice, 4) : 'YOK ⚠'}</span></div>`;
      }).join('')
    : '<div class="mu">Açık gerçek pozisyon yok.</div>';
  // Kilit nedenleri: mutabakat sonucu (state.liveReconciliation) ve motorun kendi bayraklari birlikte listelenir.
  const reasons = [];
  if (L.lockReason) reasons.push(String(L.lockReason));
  const rec = state.liveReconciliation || {};
  (rec.errors || []).slice(0, 3).forEach((m) => reasons.push(String(m)));
  (rec.balanceMismatches || []).slice(0, 2).forEach((m) => reasons.push(`Bakiye uyuşmuyor: ${m.asset} (${m.reason})`));
  if ((rec.orphanOpenOrders || []).length) reasons.push(`Botun tanımadığı ${rec.orphanOpenOrders.length} açık emir var`);
  if ((rec.unknownLocalOrders || []).length) reasons.push(`Durumu belirsiz ${rec.unknownLocalOrders.length} yerel emir var`);
  if (L.stopRecoveryError) reasons.push(`Stop yenileme hatası (${L.stopRecoveryError.symbol}): ${L.stopRecoveryError.error}`);
  if (L.stopReplacementError) reasons.push(`Stop taşıma hatası (${L.stopReplacementError.symbol})`);
  if (L.feeValuationWarning) reasons.push(`Komisyon değerlenemedi (${L.feeValuationWarning.symbol})`);
  if (L.protectiveCancelPending) reasons.push(`Koruyucu emir iptali bekliyor (${L.protectiveCancelPending.symbol})`);
  if (L.stopCancelPartialFill) reasons.push(`Stop iptalinde kısmi dolum (${L.stopCancelPartialFill.symbol})`);
  if (L.lastPairError) reasons.push(`Parite hatası (${L.lastPairError.symbol}): ${L.lastPairError.error}`);
  if (!stream.connected) reasons.push('Canlı emir akışı bağlı değil');
  if (state.killSwitch) reasons.push(`Kill switch: ${state.killSwitch.reason}`);
  const uniqReasons = [...new Set(reasons)].slice(0, 6);
  const critical = L.criticalAlert ? ` 🚨 KRİTİK: ${L.criticalAlert.message}` : '';
  $('liveNote').textContent = (L.safeToTrade
    ? 'Her gerçek pozisyonun borsada koruyucu stop emri olmalı; "YOK ⚠" görürsen hemen borsayı kontrol et.'
    : `KİLİT NEDENİ: ${uniqReasons.length ? uniqReasons.join(' · ') : 'Güvenlik mutabakatı geçmedi.'} — yeni giriş emri verilmez; mevcut pozisyonların koruması ayrı olarak sürdürülür.`) + critical;
}

$('preflightBtn')?.addEventListener('click',async()=>{ const b=$('preflightBox'); b.textContent='Kontroller çalışıyor…'; try{const r=await api('/api/live/preflight'); b.innerHTML=r.checks.map(c=>`<div class="r"><span>${c.ok?'✅':'❌'} ${esc(c.label)}</span><span class="${c.ok?'u':'d'}">${esc(c.detail)}</span></div>`).join('')+`<p class="${r.safe?'u':'d'}"><b>${r.safe?'CANLI ÖN KONTROL: GEÇTİ':'CANLI ÖN KONTROL: GEÇMEDİ'}</b></p>`;}catch(e){b.textContent='Ön kontrol hatası: '+e.message;} });

// ---- Kill switch uyarisi ----
function renderKill(state) {
  const k = state.killSwitch;
  $('killBanner').style.display = k ? '' : 'none';
  if (k) $('killText').textContent = `${k.reason} · ${new Date(k.t).toLocaleString('tr-TR')}. Kilidi kaldırmadan bot başlatılamaz. Zarar hâlâ limitin üstündeyse önce limiti artır ya da hesabı sıfırla.`;
}
$('ackKillBtn').addEventListener('click', () => {
  if (!confirm('Kill switch kilidi kaldırılsın mı? Bot yine de kendiliğinden başlamaz, sen başlatırsın.')) return;
  guard(api('/api/control', { method: 'POST', body: JSON.stringify({ action: 'ack_kill' }) }));
});

// ---- Bildirimler ----
function renderNotify(state) {
  const n = state.notify || {};
  const rows = [['Telegram', n.telegram], ['Termux bildirimi', n.termux], ['Nabız (healthcheck)', n.healthcheck]];
  $('notifyBox').innerHTML =
    rows.map(([k, v]) => `<div class="r"><span>${esc(k)}</span><span class="${v ? 'u' : 'mu'}">${v ? 'açık' : 'kapalı'}</span></div>`).join('') +
    '<p class="mu">Kurulum için README\'deki "Bildirimler" bölümüne bak (.env dosyasına yazılır).</p>';
}
$('notifyTestBtn').addEventListener('click', async () => {
  try {
    await api('/api/notify/test', { method: 'POST' });
    toast('Test bildirimi gönderildi ✓');
  } catch (e) { alert(e.message); }
});

// ---- Performans ----
function renderPerformance(state) {
  const p = state.paper;
  const lp = p.lastPrices || {};
  const equity = p.cash + Object.entries(p.positions).reduce((sum, [sym, pos]) => sum + pos.quantity * (lp[sym] ?? pos.entryPrice), 0);
  const start = p.startingBalance > 0 ? p.startingBalance : 150;
  const ret = (equity / start - 1) * 100;
  const st = p.stats || { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, pctSum: 0 };
  const win = st.trades ? (st.wins / st.trades) * 100 : null;
  const pf = st.grossLoss > 0 ? st.grossWin / st.grossLoss : null;
  const avg = st.trades ? st.pctSum / st.trades : null;
  const costs = p.costs ? p.costs.fees + p.costs.slippage : 0;
  const bhList = Object.entries(p.firstPrices || {}).filter(([s]) => lp[s] !== undefined).map(([s, f]) => (lp[s] / f - 1) * 100);
  const bh = bhList.length ? bhList.reduce((a, b) => a + b, 0) / bhList.length : null;
  const pc = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : (v >= 0 ? '+' : '') + fmt(v, d) + '%');
  const cls = (v) => (v === null || !Number.isFinite(v) ? '' : v >= 0 ? 'u' : 'd');
  const cells = [
    ['Toplam getiri', pc(ret, 2), cls(ret)],
    ['Al-tut (ort.)', pc(bh, 2), cls(bh)],
    ['İşlem sayısı', String(st.trades), ''],
    ['Kazanma oranı', win === null ? '-' : fmt(win, 0) + '%', ''],
    ['Kâr faktörü', pf === null ? '-' : fmt(pf, 2), ''],
    ['Ort. işlem', pc(avg, 2), cls(avg)],
    ['En büyük düşüş', pc(p.maxDrawdownPct || 0, 1), 'd'],
    ['Komisyon + kayma', fmt(costs, 2) + ' ' + ((state.settings && state.settings.quoteAsset) || state.quoteAsset || 'USDT'), '']
  ];
  $('perfGrid').innerHTML = cells.map(([k, v, c]) => `<div><div class="k">${esc(k)}</div><div class="v ${c}">${esc(v)}</div></div>`).join('');
  $('perfNote').textContent =
    'Al-tut: izlenen paritelerin ilk görüldükleri fiyattan bu yana ortalama değişimi. ' + (st.trades < 30 ? 'İşlem sayısı 30\'dan az: istatistik henüz zayıf.' : '');
}

// ---- Risk merkezi ----
async function renderRisk(state) {
  try {
    const r = await api('/api/risk');
    const pc = (v) => v == null || !Number.isFinite(v) ? '-' : (v >= 0 ? '+' : '') + fmt(v, 2) + '%';
    const cells = [
      ['Özsermaye', fmt(r.equity,2)+' '+r.quote,''],['Günlük K/Z',pc(r.dayPnlPct),r.dayPnlPct>=0?'u':'d'],
      ['Toplam getiri',pc(r.returnPct),r.returnPct>=0?'u':'d'],['Drawdown',pc(r.drawdownPct),'d'],
      ['Maks. drawdown',pc(r.maxDrawdownPct),'d'],['Açık risk/exposure',fmt(r.exposurePct,1)+'%',''],
      ['Pozisyon',r.positions+' / '+r.maxPositions,''],['Kazanma oranı',r.winRate==null?'-':fmt(r.winRate,1)+'%',''],
      ['Profit factor',r.profitFactor==null?'-':fmt(r.profitFactor,2), ''],['Maliyet',fmt((r.costs.fees||0)+(r.costs.slippage||0),2)+' '+r.quote,'']
    ];
    $('riskGrid').innerHTML=cells.map(([k,v,c])=>`<div><div class="k">${esc(k)}</div><div class="v ${c}">${esc(v)}</div></div>`).join('');
    const warns=[];
    if(r.dayPnlPct<=-Math.abs(r.dailyLimitPct)) warns.push('⚠️ Günlük zarar limiti tetiklenmiş/çok yakın.');
    if(r.exposurePct>90) warns.push('⚠️ Portföy exposure %90 üzerinde.');
    if(r.drawdownPct<=-10) warns.push('⚠️ Drawdown %10 altında.');
    if(r.killSwitch) warns.push('🛑 Kill switch aktif.');
    $('riskWarnings').textContent=warns.join('  ')+(warns.length?'':'Risk limitleri şu an aşılmamış.');
  } catch(e) { $('riskWarnings').textContent='Risk verisi alınamadı: '+e.message; }
}

// ---- Hızlı backtest ----
function syncBacktestControls(state) {
  const syms=Object.keys(state.pairs||{}); const bs=$('btSymbol');
  if(bs && bs.dataset.sig!==syms.join(',')){ const prev=bs.value; bs.innerHTML=syms.map(x=>`<option>${esc(x)}</option>`).join(''); if(syms.includes(prev)) bs.value=prev; bs.dataset.sig=syms.join(','); }
  const st=$('btStrategy'); if(st && !st.dataset.filled){ st.innerHTML=state.strategies.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join(''); st.dataset.filled='1'; }
  if(bs && state.pairs[bs.value]) { const p=state.pairs[bs.value]; if(!st.dataset.user) st.value=p.strategyId; $('btTf').value=p.timeframe||'1h'; }
}
$('btSymbol')?.addEventListener('change',()=>{ if(currentState?.pairs[$('btSymbol').value]) { $('btTf').value=currentState.pairs[$('btSymbol').value].timeframe||'1h'; $('btStrategy').value=currentState.pairs[$('btSymbol').value].strategyId; } });
$('btStrategy')?.addEventListener('change',()=>{ $('btStrategy').dataset.user='1'; });
$('btRun')?.addEventListener('click',async()=>{
  const b=$('btResult'); b.textContent='Backtest çalışıyor…';
  try { const q=new URLSearchParams({symbol:$('btSymbol').value,timeframe:$('btTf').value,strategy:$('btStrategy').value,capital:$('btCapital').value}); const r=await api('/api/backtest/quick?'+q); const x=r.result; const pc=v=>(v>=0?'+':'')+fmt(v,2)+'%'; b.innerHTML=`<div class="backtestGrid"><b>Getiri ${pc(x.returnPct)}</b><b>Al-tut ${pc(x.buyHoldPct)}</b><b>Max DD ${pc(x.maxDrawdownPct)}</b><b>İşlem ${x.trades}</b><b>Win ${fmt(x.winRate||0,1)}%</b><b>PF ${x.profitFactor==null?'-':fmt(x.profitFactor,2)}</b></div><p>${esc(x.note||'Sonuç geçmiş veri üzerinde simülasyondur; canlı kâr garantisi değildir.')}</p>`; }
  catch(e){b.textContent='Backtest hatası: '+e.message;}
});

// ---- Mum grafigi ----
const chartState = { key: '', candles: [], analytics: null, loadedAt: 0, loading: false, error: '', hoverIdx: -1 };

function syncChartControls(state) {
  const sel = $('chartSym');
  const symbols = Object.keys(state.pairs);
  const sig = symbols.join(',');
  if (sel.dataset.sig !== sig) {
    const prev = sel.value;
    sel.innerHTML = symbols.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    sel.dataset.sig = sig;
    if (symbols.includes(prev)) sel.value = prev;
    else if (symbols.length) { sel.value = symbols[0]; $('chartTf').value = state.pairs[symbols[0]].timeframe; }
  }
  loadChart(false);
}
$('chartSym').addEventListener('change', () => {
  const p = currentState && currentState.pairs[$('chartSym').value];
  if (p) $('chartTf').value = p.timeframe;
  chartState.hoverIdx = -1;
  loadChart(true);
});
$('chartTf').addEventListener('change', () => { chartState.hoverIdx = -1; loadChart(true); });
$('chartBars').addEventListener('change', () => { chartState.hoverIdx = -1; drawChart(); });

function renderIndicatorSnapshot(){
  const a=chartState.analytics?.snapshot; const d=chartState.analytics?.decision; const box=$('indicatorBox');
  if(!box) return;
  if(!a){box.innerHTML='';return;}
  const f=(v,n=2)=>v==null||!Number.isFinite(v)?'-':fmt(v,n);
  const action=d?.action||'hold'; const cls=action==='buy'?'u':action==='sell'?'d':'';
  box.innerHTML=[['Trend',a.trend,''],['RSI',f(a.rsi,1),a.rsi>70?'d':a.rsi<30?'u':''],['MACD',f(a.macd,4),a.macdHistogram>=0?'u':'d'],['ATR',f(a.atr,4),''],['Stoch',f(a.stoch,1),a.stoch>80?'d':a.stoch<20?'u':''],['Bot kararı',action.toUpperCase(),cls],['Neden',d?.reason||'Karar kaydı yok','']].map(([k,v,c])=>`<div><span>${esc(k)}</span><b class="${c}">${esc(v)}</b></div>`).join('');
}

async function loadChart(force) {
  const symbol = $('chartSym').value;
  const timeframe = $('chartTf').value;
  if (!symbol) { drawChart(); return; }
  const key = symbol + '|' + timeframe;
  if (!force && key === chartState.key && Date.now() - chartState.loadedAt < 60000) { drawChart(); return; } // en fazla dakikada bir istek
  if (chartState.loading) return;
  chartState.loading = true;
  try {
    const r = await api(`/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=300`);
    chartState.candles = r.candles;
    try { chartState.analytics = await api(`/api/analytics?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=300`); } catch { chartState.analytics = null; }
    renderIndicatorSnapshot();
    chartState.error = '';
  } catch (e) {
    chartState.candles = []; chartState.analytics = null;
    chartState.error = e.message;
  } finally {
    chartState.key = key;
    chartState.loadedAt = Date.now();
    chartState.loading = false;
    drawChart();
    if ($('chartSym').value + '|' + $('chartTf').value !== key) loadChart(true); // yuklenirken secim degistiyse
  }
}

function triangle(ctx, cx, cy, dir, size, fill) {
  ctx.beginPath();
  if (dir === 'up') { ctx.moveTo(cx, cy - size); ctx.lineTo(cx - size, cy + size * 0.7); ctx.lineTo(cx + size, cy + size * 0.7); }
  else { ctx.moveTo(cx, cy + size); ctx.lineTo(cx - size, cy - size * 0.7); ctx.lineTo(cx + size, cy - size * 0.7); }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawChart() {
  const cv = $('chart');
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = { up: css.getPropertyValue('--up').trim() || '#15803d', dn: css.getPropertyValue('--dn').trim() || '#b91c1c', mu: css.getPropertyValue('--mu').trim() || '#64748b', bd: css.getPropertyValue('--bd').trim() || '#d5dde8', tx: css.getPropertyValue('--tx').trim() || '#0f172a' };
  ctx.font = '11px system-ui, sans-serif';

  const n = Number($('chartBars').value) || 120;
  const vis = chartState.candles.slice(-n);
  if (!vis.length) {
    ctx.fillStyle = col.mu;
    ctx.textAlign = 'center';
    ctx.fillText(chartState.error || (chartState.loading ? 'Veri yükleniyor…' : 'Grafik için bir parite seç.'), w / 2, h / 2);
    return;
  }

  const symbol = $('chartSym').value;
  const padR = 60, padT = 6, padB = 18;
  const plotW = w - padR;
  const volH = Math.round((h - padT - padB) * 0.16);
  const priceH = h - padT - padB - volH - 4;
  const step = vis.length > 1 ? vis[1].t - vis[0].t : 3600000;
  const pos = currentState && currentState.paper.positions[symbol];

  let lo = Math.min(...vis.map((c) => c.l));
  let hi = Math.max(...vis.map((c) => c.h));
  const span0 = hi - lo || hi * 0.01;
  if (pos) { // pozisyon cizgileri aralikta yakinsa ekrana sigsin
    for (const v of [pos.entryPrice, pos.stopPrice]) if (Number.isFinite(v) && v > lo - span0 && v < hi + span0) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad; hi += pad;
  const y = (v) => padT + ((hi - v) / (hi - lo)) * priceH;
  const cw = plotW / vis.length;
  const bw = Math.max(1, cw * 0.66);
  const x = (i) => i * cw + cw / 2;

  // izgara + fiyat etiketleri
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    const yy = y(v);
    ctx.strokeStyle = col.bd; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = col.mu;
    ctx.fillText(fp(v), plotW + 4, yy + 4);
  }
  // zaman etiketleri
  ctx.textAlign = 'center';
  for (const f of [0.1, 0.4, 0.7, 0.95]) {
    const i = Math.min(vis.length - 1, Math.floor(f * vis.length));
    ctx.fillStyle = col.mu;
    ctx.fillText(new Date(vis[i].t).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), Math.min(plotW - 40, Math.max(40, x(i))), h - 5);
  }

  // hacim
  const maxV = Math.max(...vis.map((c) => c.v)) || 1;
  vis.forEach((c, i) => {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = c.c >= c.o ? col.up : col.dn;
    const vh = (c.v / maxV) * volH;
    ctx.fillRect(x(i) - bw / 2, h - padB - vh, bw, vh);
  });
  ctx.globalAlpha = 1;

  // mumlar
  vis.forEach((c, i) => {
    const color = c.c >= c.o ? col.up : col.dn;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(c.h)); ctx.lineTo(x(i), y(c.l)); ctx.stroke();
    const top = y(Math.max(c.o, c.c));
    ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(1, Math.abs(y(c.o) - y(c.c))));
  });

  // EMA overlay
  const an = chartState.analytics;
  if (an && an.indicators) {
    const drawLine=(arr, lineColor)=>{ ctx.beginPath(); let started=false; arr.slice(-vis.length).forEach((v,i)=>{ if(v==null)return; const xx=x(i), yy=y(v); if(!started){ctx.moveTo(xx,yy);started=true;}else ctx.lineTo(xx,yy);}); ctx.strokeStyle=lineColor; ctx.lineWidth=1.2; ctx.stroke(); };
    drawLine(an.indicators.ema20, '#f59e0b'); drawLine(an.indicators.ema50, '#8b5cf6');
  }

  // acik pozisyon: giris ve stop cizgileri
  const hline = (v, color, label) => {
    if (!Number.isFinite(v) || v < lo || v > hi) return;
    ctx.save();
    ctx.setLineDash([5, 4]); ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(plotW, y(v)); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color; ctx.textAlign = 'left';
    ctx.fillText(label, 4, y(v) - 3);
  };
  if (pos) { hline(pos.entryPrice, col.tx, 'giriş'); hline(pos.stopPrice, col.dn, 'stop'); }

  // alim/satim isaretleri
  const idxOf = (ms) => {
    if (ms < vis[0].t) return -1;
    for (let i = vis.length - 1; i >= 0; i--) if (vis[i].t <= ms) return i;
    return -1;
  };
  const marks = [];
  if (currentState) {
    for (const t of currentState.paper.trades) {
      if (t.symbol !== symbol) continue;
      marks.push({ ms: Date.parse(t.openedAt), price: t.entryPrice, dir: 'up' });
      marks.push({ ms: Date.parse(t.closedAt), price: t.exitPrice, dir: 'down' });
    }
    if (pos) marks.push({ ms: Date.parse(pos.openedAt), price: pos.entryPrice, dir: 'up' });
  }
  let drawn = 0;
  for (const m of marks) {
    const i = idxOf(m.ms);
    if (i < 0 || !(m.price >= lo && m.price <= hi)) continue;
    drawn++;
    triangle(ctx, x(i), y(m.price) + (m.dir === 'up' ? 9 : -9), m.dir, 6, m.dir === 'up' ? col.up : col.dn);
  }

  // dokunulan/ustune gelinen mum
  if (chartState.hoverIdx >= 0 && chartState.hoverIdx < vis.length) {
    const i = chartState.hoverIdx;
    ctx.save();
    ctx.setLineDash([3, 3]); ctx.strokeStyle = col.mu; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), padT); ctx.lineTo(x(i), h - padB); ctx.stroke();
    ctx.restore();
    const c = vis[i];
    $('chartInfo').textContent = `${new Date(c.t).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}  A ${fp(c.o)}  Y ${fp(c.h)}  D ${fp(c.l)}  K ${fp(c.c)}  Hacim ${fmt(c.v, 0)}`;
  }
  chartState.layout = { cw, n: vis.length, plotW, step };
  chartState.marksDrawn = drawn; // testler icin
}

function chartHover(ev) {
  const cv = $('chart');
  const L = chartState.layout;
  if (!L) return;
  const rect = cv.getBoundingClientRect();
  const i = Math.floor((ev.clientX - rect.left) / L.cw);
  if (i < 0 || i >= L.n) return;
  chartState.hoverIdx = i;
  drawChart();
}
$('chart').addEventListener('pointerdown', chartHover);
$('chart').addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') chartHover(e); });
window.addEventListener('resize', () => drawChart());

async function boot() {
  try {
    const state = await api('/api/state');
    strategiesCache = state.strategies;
    $('newStrategy').innerHTML = strategiesCache.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    $('newStrategy').dataset.filled = '1';
    render(state);
  } catch (e) { console.error(e); }
  connectWs();
}

boot();
