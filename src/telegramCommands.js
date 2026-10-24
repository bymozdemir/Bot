'use strict';
const { formatIstanbulTime } = require('./istanbulTime');
const { splitMessage, stripTags } = require('./notify');
const fmt = require('./notifyFormat');

// Read-only Telegram command responder. Only the configured TELEGRAM_CHAT_ID may use it.
// Polling is used for Termux installs; no public webhook/server endpoint is needed.
function createTelegramCommands({ env = process.env, fetchFn = globalThis.fetch, logger = console, getStatus = () => ({}), startBot = async () => { throw new Error('Başlatma işlemi yapılandırılmadı.'); }, stopBot = async () => { throw new Error('Durdurma işlemi yapılandırılmadı.'); }, listStrategies = () => [], timeframes = [], validateTimeframe = () => null, addPair = async () => { throw new Error('Coin ekleme işlemi yapılandırılmadı.'); }, removePair = async () => { throw new Error('Coin silme işlemi yapılandırılmadı.'); }, setPairEnabled = async () => { throw new Error('Coin durdurma/açma işlemi yapılandırılmadı.'); }, muteNotifications = null, unmuteNotifications = null, getNotifyInfo = () => ({}), getDailySummaryText = null, pollTimeoutSeconds = 20 } = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  const base = 'https://api.telegram.org';
  let stopped = true;
  let offset = 0;
  let loopPromise = null;
  let warned = false;
  // Wizard state lives only in memory. A restart cancels an unconfirmed setup.
  let setup = null;
  const SETUP_TTL_MS = 15 * 60 * 1000;
  // Coin silme onayı da yalnızca bellekte tutulur; yeniden başlatma onaysız silmeyi iptal eder.
  let pendingRemove = null;
  const REMOVE_TTL_MS = 5 * 60 * 1000;
  // CANLI modda /coin_ac riski artirir (gercek parayla yeniden alim): onay gerektirir. Yalnizca bellekte tutulur.
  let pendingEnable = null;
  const ENABLE_TTL_MS = 5 * 60 * 1000;

  async function api(method, body, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${base}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}), signal: controller.signal
      });
      let data;
      try { data = await response.json(); } catch { throw new Error(`Telegram ${method}: invalid JSON (HTTP ${response.status})`); }
      if (!response.ok || data.ok !== true) throw new Error(`Telegram ${method}: ${data.description || `HTTP ${response.status}`}`);
      return data.result;
    } finally { clearTimeout(timer); }
  }

  // Dinamik icerik kacirilarak HTML'e cevrilir; yalnizca ilk satir (baslik) kalin yapilir.
  const htmlTitle = (plain) => {
    const lines = String(plain).split('\n');
    lines[0] = `<b>${fmt.esc(lines[0])}</b>`;
    for (let i = 1; i < lines.length; i++) lines[i] = fmt.esc(lines[i]);
    return { html: lines.join('\n') };
  };
  const isLiveStatus = (s) => String((s || {}).mode || 'paper').toLowerCase() === 'live';
  const modeWord = (s) => (isLiveStatus(s) ? 'CANLI' : 'PAPER');

  function formatAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'bilinmiyor';
    if (n !== 0 && Math.abs(n) < 0.000001) return n.toLocaleString('en-US', { maximumFractionDigits: 20, useGrouping: false });
    return n.toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: false });
  }

  function formatBalance() {
    const s = getStatus() || {};
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const cash = Number(s.cash);
    const holdings = Array.isArray(s.holdings) ? s.holdings : [];
    const live = isLiveStatus(s);
    const lines = [`💰 ${modeWord(s)} BAKİYE / VARLIKLAR`, `Kontrol zamanı (İstanbul): ${formatIstanbulTime()}`];
    if (Number.isFinite(cash)) lines.push(`Kullanılabilir nakit: ${formatAmount(cash)} ${quote}`);
    else if (live) lines.push('Borsa bakiyesi henüz okunmadı (ilk hesap mutabakatı bekleniyor).');
    if (!holdings.length) {
      lines.push('', 'Açık varlık/pozisyon bulunmuyor.');
    } else {
      lines.push('', 'Açık pozisyonlar:');
      for (const h of holdings) {
        const symbol = String(h.symbol || 'Bilinmeyen varlık');
        const base = String(h.baseAsset || symbol.split('/')[0] || '').toUpperCase();
        const quantity = formatAmount(h.quantity);
        const value = Number(h.marketValue);
        const cost = Number(h.costQuote);
        const q = String(h.quoteAsset || quote).toUpperCase();
        let line = `• ${base}: ${quantity} ${base}`;
        if (Number.isFinite(value) && value >= 0) line += ` | güncel değer: ${formatAmount(value)} ${q}`;
        else if (Number.isFinite(cost)) line += ` | kayıtlı maliyet: ${formatAmount(cost)} ${q} (güncel fiyat yok)`;
        if (Number.isFinite(cost)) line += ` | maliyet: ${formatAmount(cost)} ${q}`;
        lines.push(line);
      }
    }
    if (Number.isFinite(Number(s.totalEquity))) lines.push('', `Tahmini toplam özkaynak: ${formatAmount(s.totalEquity)} ${quote}`);
    lines.push('', live
      ? `Not: Değerler borsa bakiyesi ve botun canlı pozisyon kayıtlarından gelir${s.lastReconcileAt ? ` (son mutabakat: ${formatIstanbulTime(s.lastReconcileAt)})` : ''}; güncel fiyat yoksa maliyet gösterilir.`
      : 'Not: Değerler Paper kayıtlarından hesaplanır; güncel fiyat yoksa maliyet gösterilir.');
    return lines.join('\n');
  }

  function formatStatus() {
    const s = getStatus() || {};
    const mode = String(s.mode || 'paper').toUpperCase();
    const running = s.running ? 'ÇALIŞIYOR' : 'DURDU';
    const kill = s.killSwitch ? 'AÇIK — işlemler engelli' : 'kapalı';
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const cash = Number(s.cash);
    const cashText = Number.isFinite(cash) ? `${cash.toFixed(2)} ${quote}` : 'bilinmiyor';
    const positions = Number.isFinite(Number(s.positions)) ? String(Number(s.positions)) : 'bilinmiyor';
    const live = isLiveStatus(s);
    const lines = [
      '🤖 AL-SAT BOT DURUMU',
      `Mod: ${mode}`,
      `Bot: ${running}`,
      `Kill switch: ${kill}`,
      `Borsa: ${String(s.exchange || 'bilinmiyor')}`,
      `${live ? 'Canlı nakit (kullanılabilir)' : 'Paper nakit'}: ${cashText}`
    ];
    if (Number.isFinite(Number(s.totalEquity))) lines.push(`Tahmini özkaynak: ${formatAmount(s.totalEquity)} ${quote}`);
    lines.push(`Açık pozisyon: ${positions}`);
    if (live) lines.push(`Canlı işlem kapısı: ${s.safeToTrade === true ? 'AÇIK (güvenli)' : `KİLİTLİ${s.lockReason ? ` — ${String(s.lockReason).slice(0, 200)}` : ''}`}`);
    if (Number.isFinite(Number(s.lastTickAt)) && Number(s.lastTickAt) > 0) lines.push(`Son kontrol turu (İstanbul): ${formatIstanbulTime(Number(s.lastTickAt))}`);
    lines.push(`Kontrol zamanı (İstanbul): ${formatIstanbulTime()}`, '', 'Salt-okunur durum sorgusu. Telegram üzerinden alım/satım komutu çalıştırılmaz.');
    return lines.join('\n');
  }

  function isPaper() { return String((getStatus() || {}).mode || 'paper').toLowerCase() === 'paper'; }

  function setupExpired() {
    if (setup && Date.now() - setup.createdAt > SETUP_TTL_MS) setup = null;
    return !setup;
  }

  function askCurrentSetupQuestion() {
    if (!setup) return '';
    if (setup.step === 'timeframe') return `\nMum aralığını seç: ${(timeframes || []).join(', ')}. Örnek: 15m`;
    if (setup.step === 'budget') {
      const max = Number((getStatus() || {}).settings?.defaultBudgetPct);
      return `\nBu coin için portföy bütçe payını yüzde olarak yaz (1-${Number.isFinite(max) && max > 0 ? max : 100}). Bu değer varsayılan bütçe payını aşamaz; global risk limitleri değişmez.`;
    }
    if (setup.step === 'trailingStop') return `\nTrailing stop bu coin için açık mı olsun? evet/hayır yaz. Stratejinin kodda tanımlı diğer indikatör ve parametre değerleri değişmeyecek. Varsayılan: ${setup.params.trailingStop ? 'açık' : 'kapalı'}.`;
    if (setup.step === 'confirm') {
      const lines = [
        '🧾 COIN AYAR ÖZETİ — henüz eklenmedi',
        `Parite: ${setup.symbol}`,
        `Strateji: ${setup.strategy.name} (${setup.strategy.id})`,
        `Mum aralığı: ${setup.timeframe}`,
        `Bütçe payı: %${setup.budgetPct}`,
        'İndikatör ayarları: kodda tanımlı hazır varsayılanlar (değiştirilmedi).',
        `Trailing stop: ${setup.params.trailingStop ? 'AÇIK' : 'KAPALI'}`,
        '',
        'Eklemek için /onayla yaz. İptal etmek için /iptal yaz.',
        'Global günlük zarar limiti, kill switch, azami pozisyon ve işlem üst sınırı değiştirilmeyecek.'
      ];
      return lines.join('\n');
    }
    return '';
  }

  function beginCoinSetup(symbol) {
    if (!isPaper()) return '⛔ Güvenlik nedeniyle Telegram üzerinden coin ekleme yalnızca Paper modda yapılabilir.';
    const status = getStatus() || {};
    const norm = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,10}$/.test(norm)) return 'Parite biçimi hatalı. Örnek: /coin_ekle PEPE/USDT';
    if (status.pairs && Object.prototype.hasOwnProperty.call(status.pairs, norm)) return `${norm} zaten listede.`;
    const quoteAssets = Array.isArray(status.quoteAssets) ? status.quoteAssets : [];
    if (quoteAssets.length && !quoteAssets.includes(norm.split('/')[1])) return `Bu borsada desteklenen kasa birimleri: ${quoteAssets.join(', ')}.`;
    const choices = (listStrategies() || []);
    if (!choices.length) return 'Strateji listesi alınamadı; coin ekleme başlatılmadı.';
    setup = { symbol: norm, choices, step: 'strategy', createdAt: Date.now() };
    return `🛠 ${norm} coin ekleme sihirbazı\nKodda bulunan hazır stratejilerden birini seç. İndikatör hesap ayarları kodun varsayılanlarında kalır; senden yalnızca strateji, mum süresi, bütçe ve trailing stop seçimi istenir.\n\n${choices.map((x, i) => `${i + 1}. ${x.name} (${x.id})\n   ${x.description || ''}`).join('\n')}\n\nSeçmek için listedeki numarayı yaz. İptal: /iptal`;
  }

  function handleSetupReply(input) {
    if (setupExpired()) return null;
    const value = String(input || '').trim();
    if (value.toLowerCase() === '/iptal') { setup = null; return 'Coin ekleme iptal edildi. Herhangi bir ayar kaydedilmedi.'; }
    if (value.toLowerCase() === '/coin_ekle') return 'Kullanım: /coin_ekle PEPE/USDT';
    if (setup.step === 'strategy') {
      const idx = Number(value);
      if (!Number.isInteger(idx) || idx < 1 || idx > setup.choices.length) return `Geçersiz seçim. 1-${setup.choices.length} arasında bir numara yaz.`;
      setup.strategy = setup.choices[idx - 1];
      setup.params = { ...(setup.strategy.defaultParams || {}) };
      setup.paramIndex = 0;
      setup.step = 'timeframe';
      return `Seçilen strateji: ${setup.strategy.name}.\nİndikatör ayarları kodda tanımlı varsayılanlarla kullanılacak.\n${askCurrentSetupQuestion()}`;
    }
    if (setup.step === 'timeframe') {
      if (!(timeframes || []).includes(value)) return `Geçersiz mum aralığı. Seçenekler: ${(timeframes || []).join(', ')}`;
      const tfError = validateTimeframe({ timeframe: value, strategyId: setup.strategy.id });
      if (tfError) return tfError;
      setup.timeframe = value;
      setup.step = 'budget';
      return askCurrentSetupQuestion();
    }
    if (setup.step === 'budget') {
      const n = Number(value.replace(',', '.'));
      const max = Number((getStatus() || {}).settings?.defaultBudgetPct);
      const ceiling = Number.isFinite(max) && max > 0 ? Math.min(100, max) : 100;
      if (!Number.isFinite(n) || n < 1 || n > ceiling) return `Bütçe payı 1 ile ${ceiling} arasında olmalı. Global ayarlar değiştirilmez; bu coin için daha düşük pay seçebilirsin.`;
      setup.budgetPct = n;
      setup.step = 'trailingStop';
      return askCurrentSetupQuestion();
    }
    if (setup.step === 'trailingStop') {
      const v = value.toLocaleLowerCase('tr-TR');
      if (['evet', 'e', 'true', '1', 'açık', 'acik'].includes(v)) setup.params.trailingStop = true;
      else if (['hayır', 'hayir', 'h', 'false', '0', 'kapalı', 'kapali'].includes(v)) setup.params.trailingStop = false;
      else return 'Trailing stop için evet veya hayır yaz.';
      if (!Object.prototype.hasOwnProperty.call(setup.strategy.defaultParams || {}, 'trailingStop')) {
        if (setup.params.trailingStop) return 'Bu strateji trailing stop ayarını desteklemiyor. Hayır yazarak kapalı devam edebilirsin.';
        setup.params.trailingStop = false;
      }
      setup.step = 'confirm';
      return askCurrentSetupQuestion();
    }
    return 'Bekleyen bir ayar adımı yok. /coin_ekle PEPE/USDT ile başla.';
  }

  function normSymbolArg(arg) {
    const sym = String(arg || '').trim().toUpperCase();
    return /^[A-Z0-9]{2,20}\/[A-Z0-9]{2,10}$/.test(sym) ? sym : null;
  }

  function enableExpired() {
    if (pendingEnable && Date.now() - pendingEnable.createdAt > ENABLE_TTL_MS) pendingEnable = null;
    return !pendingEnable;
  }

  function removeExpired() {
    if (pendingRemove && Date.now() - pendingRemove.createdAt > REMOVE_TTL_MS) pendingRemove = null;
    return !pendingRemove;
  }

  function hasPair(status, sym) {
    return Boolean(status.pairs && typeof status.pairs === 'object' && Object.prototype.hasOwnProperty.call(status.pairs, sym));
  }

  function formatPairs() {
    const s = getStatus() || {};
    const pairs = s.pairs && typeof s.pairs === 'object' ? s.pairs : {};
    const keys = Object.keys(pairs).sort();
    if (!keys.length) return 'Listede takip edilen coin yok. /coin_ekle PEPE/USDT ile ekleyebilirsin.';
    const held = new Set((Array.isArray(s.holdings) ? s.holdings : []).map((h) => String(h.symbol)));
    const lines = [`📋 TAKİP EDİLEN COİNLER (${keys.length})`];
    for (const k of keys) {
      const p = pairs[k] || {};
      const state = p.enabled === false ? '⏸ durduruldu' : '▶ aktif';
      const pos = held.has(k) ? ' | açık pozisyon var' : '';
      lines.push(`• ${k} — ${p.strategyId || '?'}, ${p.timeframe || '?'}, bütçe %${p.budgetPct ?? '?'} — ${state}${pos}`);
    }
    lines.push('', 'Komutlar: /coin_sil, /coin_durdur, /coin_ac (örnek: /coin_durdur PEPE/USDT)');
    return lines.join('\n');
  }

  function beginCoinRemove(arg) {
    if (!isPaper()) return '⛔ Güvenlik nedeniyle Telegram üzerinden coin silme yalnızca Paper modda yapılabilir.';
    const sym = normSymbolArg(arg);
    if (!sym) return 'Parite biçimi hatalı. Örnek: /coin_sil PEPE/USDT';
    const status = getStatus() || {};
    if (!hasPair(status, sym)) return `${sym} listede değil. Mevcut liste için /coinler yaz.`;
    const holding = (Array.isArray(status.holdings) ? status.holdings : []).find((h) => String(h.symbol) === sym);
    setup = null; pendingEnable = null;
    pendingRemove = { symbol: sym, createdAt: Date.now() };
    const lines = [`🗑 ${sym} listeden SİLİNECEK — henüz silinmedi.`];
    if (holding) {
      const base = String(holding.baseAsset || sym.split('/')[0]).toUpperCase();
      lines.push(`Açık paper pozisyon var: ${formatAmount(holding.quantity)} ${base}. Silinirse son bilinen fiyattan kapatılır, tutar nakde döner ve kâr/zarar gerçekleşir.`);
    } else {
      lines.push('Açık pozisyon yok.');
    }
    lines.push('', 'Onaylamak için /onayla, vazgeçmek için /iptal yaz (5 dakika içinde).');
    return lines.join('\n');
  }

  function formatTrades(arg) {
    const s = getStatus() || {};
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const trades = Array.isArray(s.trades) ? s.trades : [];
    let n = Number.parseInt(String(arg || '').trim(), 10);
    if (!Number.isInteger(n) || n < 1) n = 5;
    n = Math.min(n, 15);
    if (!trades.length) return 'Henüz kapanmış işlem yok.';
    const lines = [`🧾 SON ${Math.min(n, trades.length)} KAPANAN İŞLEM`];
    for (const t of trades.slice(0, n)) {
      const pnl = Number(t.pnl);
      const pct = Number(t.pnlPct);
      const sign = pnl >= 0 ? '+' : '';
      const icon = pnl >= 0 ? '🟢' : '🔴';
      const when = t.closedAt ? formatIstanbulTime(t.closedAt) : '';
      const reason = String(t.reason || '').slice(0, 70);
      lines.push(`${icon} ${t.symbol}: ${Number.isFinite(pct) ? `${sign}${pct.toFixed(2)}%` : '?'} (${Number.isFinite(pnl) ? `${sign}${pnl.toFixed(2)}` : '?'} ${quote})${when ? ` — ${when}` : ''}${reason ? `\n   ${reason}` : ''}`);
    }
    return lines.join('\n');
  }

  function formatReport() {
    const s = getStatus() || {};
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const st = s.stats && typeof s.stats === 'object' ? s.stats : {};
    const count = Number(st.trades) || 0;
    const wins = Number(st.wins) || 0;
    const grossWin = Number(st.grossWin) || 0;
    const grossLoss = Number(st.grossLoss) || 0;
    const start = Number(s.startingBalance);
    const equity = Number(s.totalEquity);
    const lines = [`📊 ${modeWord(s)} RAPOR`, `Kontrol zamanı (İstanbul): ${formatIstanbulTime()}`];
    if (Number.isFinite(start) && start > 0) lines.push(`Başlangıç bakiyesi: ${formatAmount(start)} ${quote}`);
    if (Number.isFinite(equity)) {
      lines.push(`Tahmini özkaynak: ${formatAmount(equity)} ${quote}`);
      if (Number.isFinite(start) && start > 0) {
        const ret = (equity / start - 1) * 100;
        lines.push(`Toplam getiri: ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`);
      }
    }
    lines.push(`Açık pozisyon: ${Number.isFinite(Number(s.positions)) ? Number(s.positions) : 'bilinmiyor'}`);
    lines.push(`Kapanan işlem: ${count}`);
    if (count > 0) {
      lines.push(`Kazanma oranı: %${(wins / count * 100).toFixed(1)} (${wins}/${count})`);
      if (grossLoss > 0) lines.push(`Kâr faktörü: ${(grossWin / grossLoss).toFixed(2)}`);
      if (Number.isFinite(Number(st.pctSum))) lines.push(`Ortalama işlem: ${(Number(st.pctSum) / count).toFixed(2)}%`);
    }
    lines.push('', isLiveStatus(s)
      ? 'Not: Canlı hesabın gerçekleşen işlemleridir; küçük işlem sayısı güvenilir bir sonuç vermez.'
      : 'Not: Paper simülasyonudur; küçük işlem sayısı güvenilir bir sonuç vermez.');
    return lines.join('\n');
  }

  // ---- Yeni salt-okunur komutlar: /pozisyonlar, /loglar, /ayarlar, /sessiz, /ozet ----

  function formatPositions() {
    const s = getStatus() || {};
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const holdings = Array.isArray(s.holdings) ? s.holdings : [];
    const nowMs = Date.now();
    const title = `📌 ${fmt.b(`AÇIK POZİSYONLAR (${holdings.length}) — ${modeWord(s)}`)}`;
    if (!holdings.length) return { html: `${title}\nAçık pozisyon yok.\n${fmt.stamp(nowMs)}` };
    const lines = [title];
    let totalPnl = 0; let pnlCount = 0;
    for (const h of holdings) {
      const base = String(h.baseAsset || String(h.symbol).split('/')[0] || '').toUpperCase();
      const q = String(h.quoteAsset || quote).toUpperCase();
      lines.push(`• ${fmt.b(h.symbol)}: ${fmt.code(fmt.qty(h.quantity))} ${fmt.esc(base)}`);
      const flow = [];
      if (Number.isFinite(Number(h.entryPrice))) flow.push(`Giriş ${fmt.code(fmt.price(h.entryPrice))}`);
      if (Number.isFinite(Number(h.lastPrice))) flow.push(`Şimdi ${fmt.code(fmt.price(h.lastPrice))}`);
      const up = Number(h.unrealizedPct); const upn = Number(h.unrealizedPnl);
      let line2 = flow.join(' → ');
      if (Number.isFinite(up) && Number.isFinite(upn)) {
        line2 += `${line2 ? ' ' : ''}(${fmt.esc(fmt.pct(up))}, ${fmt.esc(fmt.signed(upn))} ${fmt.esc(q)}) ${upn >= 0 ? '🟢' : '🔴'}`;
        if (q === quote) { totalPnl += upn; pnlCount += 1; }
      } else if (!line2) line2 = 'güncel fiyat yok';
      lines.push(`  ${line2}`);
      const extra = [];
      if (Number.isFinite(Number(h.stopPrice)) && Number(h.stopPrice) > 0) {
        const dist = Number.isFinite(Number(h.lastPrice)) && Number(h.lastPrice) > 0 ? ` (${fmt.pct((Number(h.stopPrice) / Number(h.lastPrice) - 1) * 100, 1)})` : '';
        extra.push(`Stop ${fmt.code(fmt.price(h.stopPrice))}${fmt.esc(dist)}`);
      }
      const dur = fmt.duration(h.openedAt, nowMs);
      if (dur) extra.push(`Süre ${fmt.esc(dur)}`);
      if (isLiveStatus(s)) extra.push(h.protected ? '🛡 borsada stop emri var' : '⚠ stop emri kaydı yok');
      if (extra.length) lines.push(`  ${extra.join(' | ')}`);
    }
    if (pnlCount) lines.push('', `Toplam açık K/Z: ${fmt.b(`${fmt.signed(totalPnl)} ${quote}`)} (gerçekleşmemiş)`);
    lines.push(fmt.stamp(nowMs));
    return { html: lines.join('\n') };
  }

  function formatLogs(arg) {
    const s = getStatus() || {};
    const tokens = String(arg || '').toLowerCase().split(/\s+/).filter(Boolean);
    const onlyProblems = tokens.some((t) => ['hata', 'uyari', 'uyarı', 'error', 'sorun'].includes(t));
    let n = tokens.map((t) => Number.parseInt(t, 10)).find((x) => Number.isInteger(x) && x > 0);
    n = Math.min(n || 10, 25);
    const all = Array.isArray(s.recentLog) ? s.recentLog : [];
    const logs = (onlyProblems ? all.filter((e) => e && (e.level === 'error' || e.level === 'warn')) : all).slice(0, n);
    const title = `🧾 ${fmt.b(`SON ${logs.length} LOG${onlyProblems ? ' (yalnızca hata/uyarı)' : ''}`)}`;
    if (!logs.length) return { html: `${title}\n${onlyProblems ? 'Kayıtlı hata/uyarı yok. 👍' : 'Kayıtlı log yok.'}` };
    const icon = { error: '🔴', warn: '🟡' };
    const lines = [title];
    for (const e of logs) {
      const ms = Date.parse(e.t);
      const when = Number.isFinite(ms) ? formatIstanbulTime(ms) : '';
      const short = when ? `${when.slice(0, 5)} ${when.slice(9)}` : '';
      lines.push(`${icon[e.level] || '⚪'} ${fmt.esc(short)} ${fmt.esc(String(e.msg || '').replace(/\s+/g, ' ').slice(0, 180))}`);
    }
    lines.push('', 'İpucu: /loglar hata — yalnızca hata/uyarılar; /loglar 20 — son 20 kayıt (en fazla 25).');
    return { html: lines.join('\n') };
  }

  function formatSettings() {
    const s = getStatus() || {};
    const st = s.settings && typeof s.settings === 'object' ? s.settings : {};
    const info = getNotifyInfo() || {};
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const val = (v, suffix = '') => (Number.isFinite(Number(v)) ? `${Number(v)}${suffix}` : 'bilinmiyor');
    const pairs = s.pairs && typeof s.pairs === 'object' ? Object.values(s.pairs) : [];
    const active = pairs.filter((p) => p && p.enabled !== false).length;
    const ok = (v) => (v ? '✅' : '❌');
    const lines = [`⚙️ AYARLAR (salt-okunur) — ${modeWord(s)}`,
      `Borsa: ${String(s.exchange || 'bilinmiyor')} | Kasa birimi: ${quote}`,
      `Kontrol aralığı: ${val(st.pollSeconds, ' sn')}${st.timeframe ? ` | Varsayılan mum: ${st.timeframe}` : ''}`,
      `Günlük zarar limiti: ${val(st.dailyLossLimitPct, '%')} | Kill switch (toplam zarar): ${val(st.killSwitchLossPct, '%')}`,
      `Azami eşzamanlı pozisyon: ${val(st.maxConcurrentPositions)} | Nakit rezervi: ${val(st.reserveCashPct, '%')}`,
      `İşlem üst sınırı: ${Number(st.maxTradeQuote) > 0 ? `${st.maxTradeQuote} ${quote}` : 'sınırsız'}${Number.isFinite(Number(st.maxOpenOrders)) ? ` | Açık emir üst sınırı: ${st.maxOpenOrders}` : ''}`,
      `Takip edilen coin: ${pairs.length} (aktif ${active})`];
    if (!isLiveStatus(s) && Number.isFinite(Number(st.paperFeePct))) lines.push(`Paper komisyon: %${Number(st.paperFeePct)} | kayma: %${Number.isFinite(Number(st.paperSlippagePct)) ? Number(st.paperSlippagePct) : '?'}`);
    lines.push('', `Bildirim kanalları: Telegram ${ok(info.telegram !== false)} | Termux ${ok(info.termux)} | Nabız (healthcheck) ${ok(info.healthcheck)}`);
    lines.push(info.muted && info.mutedUntil ? `Sessiz mod: AÇIK (bitiş ${formatIstanbulTime(info.mutedUntil)}); kritik uyarılar yine sesli` : 'Sessiz mod: kapalı');
    if (info.dailySummary) lines.push(`Günlük özet: ${info.dailySummary.enabled ? `açık, her gün ${info.dailySummary.time} (İstanbul)` : 'kapalı'}`);
    if (Number(info.pending) > 0) lines.push(`⏱ Gönderilemeyen ${Number(info.pending)} kritik bildirim bekliyor; bağlantı gelince otomatik iletilir.`);
    if (info.channels && info.channels.telegram && info.channels.telegram.failures > 0) lines.push(`⚠ Telegram bildirim gönderimi son zamanlarda ${info.channels.telegram.failures} kez başarısız oldu.`);
    lines.push('', 'Ayarlar panelden değiştirilir; Telegram yalnızca gösterir.');
    return lines.join('\n');
  }

  function handleMute(arg) {
    if (typeof muteNotifications !== 'function') return 'Sessiz mod bu kurulumda kullanılamıyor.';
    const raw = String(arg || '').trim().toLowerCase();
    const info = getNotifyInfo() || {};
    if (['kapat', 'bitir', 'iptal', 'sesli', 'normal'].includes(raw)) {
      if (typeof unmuteNotifications === 'function') unmuteNotifications();
      return '🔔 Sessiz mod kapatıldı. Bildirimler normal (sesli) gelir.';
    }
    if (raw === 'durum') {
      return info.muted && info.mutedUntil
        ? `🔕 Sessiz mod AÇIK, bitiş: ${formatIstanbulTime(info.mutedUntil)}. Kritik uyarılar yine sesli gelir. Kapatmak için: /sessiz kapat`
        : '🔔 Sessiz mod kapalı. Açmak için: /sessiz 2 (saat)';
    }
    const hours = raw === '' ? 2 : Number(raw.replace(',', '.'));
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 24) return 'Kullanım: /sessiz [saat] — 0.25 ile 24 arası (varsayılan 2). Kapatmak için: /sessiz kapat';
    const until = muteNotifications({ hours });
    return `🔕 Sessiz mod ${hours} saat açık (bitiş: ${formatIstanbulTime(until)}).\nAlım/satım ve bilgi mesajları ses/titreşim olmadan gelir. KRİTİK uyarılar (stop-loss, kill switch, kilitlenme, çökme) yine sesli gelir. Yeniden başlatma sessiz modu sıfırlar.`;
  }

  async function setCoinEnabled(arg, enabled) {
    const paper = isPaper();
    const sym = normSymbolArg(arg);
    const cmd = enabled ? '/coin_ac' : '/coin_durdur';
    if (!sym) return `Parite biçimi hatalı. Örnek: ${cmd} PEPE/USDT`;
    const status = getStatus() || {};
    if (!hasPair(status, sym)) return `${sym} listede değil. Mevcut liste için /coinler yaz.`;
    // CANLI modda yeniden açma riski ARTIRIR (gerçek parayla yeni alım): açık onay gerekir. Durdurma ise riski azaltır
    // (yalnızca yeni alımı keser, açık pozisyonun stopunu/çıkışını etkilemez) ve onaysız çalışır.
    if (!paper && enabled) {
      setup = null; pendingRemove = null;
      pendingEnable = { symbol: sym, createdAt: Date.now() };
      return `⚠ CANLI MOD: ${sym} yeniden açılacak — henüz açılmadı.\nAçılırsa bot bu coin için GERÇEK parayla yeni alım yapabilir.\nOnaylamak için /onayla, vazgeçmek için /iptal yaz (${Math.round(ENABLE_TTL_MS / 60000)} dk içinde).`;
    }
    try {
      const result = await setPairEnabled({ symbol: sym, enabled });
      const live = paper ? '' : ' Pozisyon KAPATILMAZ; bot onun stop-loss/çıkış kurallarını işletmeye devam eder.';
      return `${enabled ? '▶' : '⏸'} ${sym} ${enabled ? 'yeniden aktif: yeni alım sinyalleri işlenir.' : `durduruldu: yeni alım yapılmaz. Açık pozisyon varsa çıkış sinyali/stop ile yönetilmeye devam eder.${live}`}${result && result.message ? `\n${result.message}` : ''}`;
    } catch (err) {
      return `⛔ İşlem yapılamadı: ${String(err && err.message || err).slice(0, 700)}`;
    }
  }

  // Yanit: duz metin (string) ya da { html }. 4096 sinirini asan yanitlar satir sinirindan bolunur;
  // Telegram HTML etiketini reddederse etiketsiz duz metne dusulur.
  async function sendReply(reply) {
    const isHtml = Boolean(reply) && typeof reply === 'object' && typeof reply.html === 'string';
    const text = isHtml ? reply.html : String(reply);
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.length > 1 ? `(${i + 1}/${parts.length}) ` : '';
      const body = { chat_id: chatId, text: prefix + parts[i], disable_web_page_preview: true };
      if (isHtml) body.parse_mode = 'HTML';
      try {
        await api('sendMessage', body, 10000);
      } catch (err) {
        if (!isHtml || !/parse|entit|tag/i.test(String(err && err.message))) throw err;
        await api('sendMessage', { chat_id: chatId, text: prefix + stripTags(parts[i]), disable_web_page_preview: true }, 10000);
      }
    }
  }

  async function processUpdate(update) {
    const message = update && (update.message || update.edited_message);
    if (!message || !message.chat || message.chat.id === undefined || !message.text) return false;
    // Fail closed: never respond to an unconfigured or different chat.
    if (!chatId || String(message.chat.id) !== chatId) return false;
    const text = String(message.text).trim();
    const command = text.split(/\s+/, 1)[0].split('@')[0].toLowerCase();
    let reply;
    if (command === '/coin_ekle' || command === '/coin-ekle') {
      pendingRemove = null; pendingEnable = null;
      reply = beginCoinSetup(text.split(/\s+/).slice(1).join(' '));
    } else if (command === '/coin_sil' || command === '/coin-sil') {
      reply = beginCoinRemove(text.split(/\s+/).slice(1).join(' '));
    } else if (command === '/onayla' && pendingEnable) {
      if (enableExpired()) reply = 'Onayın süresi doldu. Coin açılmadı. /coin_ac SEMBOL ile yeniden başla.';
      else {
        const pending = pendingEnable;
        pendingEnable = null;
        try {
          const result = await setPairEnabled({ symbol: pending.symbol, enabled: true });
          reply = `▶ ${pending.symbol} yeniden aktif: yeni alım sinyalleri işlenir.${result && result.message ? `\n${result.message}` : ''}`;
        } catch (err) { reply = `⛔ İşlem yapılamadı: ${String(err && err.message || err).slice(0, 700)}\nHiçbir değişiklik yapılmadı.`; }
      }
    } else if (command === '/onayla' && pendingRemove) {
      if (removeExpired()) reply = 'Silme onayının süresi doldu. Hiçbir coin silinmedi. /coin_sil PEPE/USDT ile yeniden başla.';
      else if (!isPaper()) { pendingRemove = null; reply = '⛔ Mod Paper değil; coin silme reddedildi. Hiçbir coin silinmedi.'; }
      else {
        const pending = pendingRemove;
        try {
          const result = await removePair({ symbol: pending.symbol });
          pendingRemove = null;
          reply = `✅ ${pending.symbol} Paper listesinden silindi.${result && result.message ? `\n${result.message}` : ''}`;
        } catch (err) {
          pendingRemove = null;
          reply = `⛔ Coin silinemedi: ${String(err && err.message || err).slice(0, 700)}\nHiçbir değişiklik yapılmadı; düzeltip yeniden deneyebilirsin.`;
        }
      }
    } else if (command === '/onayla') {
      if (!setup || setupExpired() || setup.step !== 'confirm') reply = 'Onaylanacak tamamlanmış ayar bulunmuyor. /coin_ekle PEPE/USDT ile başla.';
      else if (!isPaper()) { setup = null; reply = '⛔ Mod Paper değil; coin ekleme reddedildi. Hiçbir ayar kaydedilmedi.'; }
      else {
        const pending = setup;
        try {
          const result = await addPair({ symbol: pending.symbol, strategyId: pending.strategy.id, timeframe: pending.timeframe, budgetPct: pending.budgetPct, params: pending.params });
          setup = null;
          reply = `✅ ${pending.symbol} Paper listesine eklendi.
Strateji: ${pending.strategy.name}
Mum aralığı: ${pending.timeframe}
Bütçe payı: %${pending.budgetPct}
Trailing stop: ${pending.params.trailingStop ? 'AÇIK' : 'KAPALI'}
İndikatörler: kodda tanımlı varsayılan değerler
${result && result.message ? result.message : 'Global güvenlik limitleri korunuyor.'}`;
        } catch (err) { reply = `⛔ Coin eklenemedi: ${String(err && err.message || err).slice(0, 700)}
Ayarlar kaydedilmedi; düzeltip yeniden deneyebilirsin veya /iptal yaz.`; }
      }
    } else if (command === '/iptal') { setup = null; pendingRemove = null; pendingEnable = null; reply = 'Bekleyen coin ekleme/silme/açma işlemi iptal edildi. Hiçbir ayar değiştirilmedi.';
    } else if (setup && !command.startsWith('/')) {
      reply = handleSetupReply(text);
      if (reply === null) reply = 'Ayar sihirbazının süresi doldu. Hiçbir ayar kaydedilmedi. /coin_ekle PEPE/USDT ile yeniden başla.';
    } else if (command === '/start' || command === '/help' || command === '/yardim' || command === '/yardım') {
      reply = 'AL-SAT botu hazır. Komutlar:\n/basla — Paper botunu başlat\n/bitir — bot motorunu durdur\n/durum — mevcut durumu göster\n/bakiye — nakit ve açık varlıkları göster\n/rapor — getiri, kazanma oranı, kâr faktörü\n/islemler [adet] — son kapanan işlemler (varsayılan 5, en fazla 15)\n/coinler — takip edilen coinleri listele\n/coin_ekle PEPE/USDT — Paper coin ekleme sihirbazı (hazır indikatör ayarları)\n/coin_sil PEPE/USDT — coini listeden sil (onay ister; açık pozisyon varsa son fiyattan kapatılır)\n/coin_durdur PEPE/USDT — yeni alımı durdur (silmeden)\n/coin_ac PEPE/USDT — durdurulan coini yeniden aç\n/onayla — bekleyen ekleme/silme işlemini onayla\n/iptal — bekleyen işlemi iptal et\n/pozisyonlar — açık pozisyonlar (giriş, güncel fiyat, K/Z, stop, süre)\n/loglar [adet|hata] — son log kayıtları\n/ayarlar — risk limitleri ve bildirim ayarları (salt-okunur)\n/ozet — günlük özeti şimdi gönder\n/sessiz [saat|kapat|durum] — rutin bildirimleri sessize al (kritik uyarılar yine sesli)\n/yardim — bu yardım\n\nEkleme ve silme açık onaydan sonra yapılır; Telegram canlı işlem başlatamaz veya manuel alım/satım emri veremez.';
    } else if (command === '/status' || command === '/durum') {
      reply = htmlTitle(formatStatus());
    } else if (command === '/bakiye' || command === '/balance') {
      reply = htmlTitle(formatBalance());
    } else if (command === '/basla') {
      const status = getStatus() || {};
      if (String(status.mode || 'paper').toLowerCase() !== 'paper') {
        reply = 'Güvenlik nedeniyle Telegram üzerinden yalnızca Paper mod başlatılabilir. Canlı mod başlatılmadı.';
      } else if (status.running) {
        reply = 'Bot zaten çalışıyor.\n\n' + formatStatus();
      } else {
        try {
          await startBot();
          reply = '▶ Paper bot başlatma isteği başarıyla uygulandı.\n\n' + formatStatus();
        } catch (err) {
          reply = `⛔ Bot başlatılamadı: ${String(err && err.message || err).slice(0, 700)}`;
        }
      }
    } else if (command === '/bitir') {
      const status = getStatus() || {};
      if (!status.running) {
        reply = 'Bot zaten durmuş. Telegram komut dinleyicisi açık kalıyor.\n\n' + formatStatus();
      } else {
        try {
          await stopBot('Telegram /bitir komutu');
          const after = getStatus() || status;
          const liveWarn = isLiveStatus(after) && Number(after.positions) > 0
            ? '⚠ Canlı pozisyonların borsadaki stop emirleri yerinde kalır ama bot artık izlemiyor.\n\n' : '';
          reply = '⏹ Bot motoru durduruldu. Telegram komut dinleyicisi açık kalıyor; yeniden başlatmak için /basla yazabilirsin.\n' + liveWarn + '\n' + formatStatus();
        } catch (err) {
          reply = `⛔ Bot durdurulamadı: ${String(err && err.message || err).slice(0, 700)}`;
        }
      }
    } else if (command === '/coinler' || command === '/pariteler') {
      reply = formatPairs();
    } else if (command === '/coin_durdur' || command === '/coin-durdur') {
      reply = await setCoinEnabled(text.split(/\s+/).slice(1).join(' '), false);
    } else if (command === '/coin_ac' || command === '/coin-ac' || command === '/coin_aç') {
      reply = await setCoinEnabled(text.split(/\s+/).slice(1).join(' '), true);
    } else if (command === '/islemler' || command === '/işlemler') {
      reply = htmlTitle(formatTrades(text.split(/\s+/).slice(1).join(' ')));
    } else if (command === '/rapor') {
      reply = htmlTitle(formatReport());
    } else if (command === '/pozisyonlar' || command === '/pozisyon' || command === '/positions') {
      reply = formatPositions();
    } else if (command === '/loglar' || command === '/log' || command === '/logs') {
      reply = formatLogs(text.split(/\s+/).slice(1).join(' '));
    } else if (command === '/ayarlar' || command === '/ayar') {
      reply = htmlTitle(formatSettings());
    } else if (command === '/sessiz') {
      reply = handleMute(text.split(/\s+/).slice(1).join(' '));
    } else if (command === '/ozet' || command === '/özet') {
      if (typeof getDailySummaryText !== 'function') reply = 'Günlük özet bu kurulumda kullanılamıyor.';
      else {
        try { reply = { html: String(await getDailySummaryText()) }; }
        catch (err) { reply = `⛔ Özet oluşturulamadı: ${String(err && err.message || err).slice(0, 300)}`; }
      }
    } else {
      return false;
    }
    await sendReply(reply);
    return true;
  }

  async function pollOnce() {
    const updates = await api('getUpdates', { offset, timeout: pollTimeoutSeconds, allowed_updates: ['message', 'edited_message'] }, (pollTimeoutSeconds + 10) * 1000);
    for (const update of updates || []) {
      if (Number.isSafeInteger(update.update_id)) offset = Math.max(offset, update.update_id + 1);
      try { await processUpdate(update); }
      catch (err) { logger.warn(`[telegram-komut] yanıt gönderilemedi: ${String(err && err.message || err).replace(token, '***')}`); }
    }
  }

  async function run() {
    while (!stopped) {
      try { await pollOnce(); warned = false; }
      catch (err) {
        if (!warned) {
          warned = true;
          logger.warn(`[telegram-komut] Telegram sorgusu başarısız: ${String(err && err.message || err).replace(token, '***')}`);
        }
        await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); if (timer.unref) timer.unref(); });
      }
    }
  }

  function start() {
    if (!token || !chatId || !stopped) return false;
    stopped = false;
    // getUpdates ve webhook ayni anda kullanilamaz. Termux'taki bu uygulama polling
    // kullandigi icin eski webhook'u (bekleyen guncellemeleri silmeden) kaldir.
    loopPromise = (async () => {
      try { await api('deleteWebhook', { drop_pending_updates: false }, 10000); }
      catch (err) { logger.warn(`[telegram-komut] webhook temizlenemedi: ${String(err && err.message || err).replace(token, '***')}`); }
      if (!stopped) await run();
    })();
    if (loopPromise && typeof loopPromise.catch === 'function') loopPromise.catch(() => {});
    logger.log('[telegram-komut] etkin: /basla, /bitir, /durum, /bakiye, /rapor, /islemler, /coinler, /coin_ekle, /coin_sil, /coin_durdur, /coin_ac, /onayla, /iptal, /pozisyonlar, /loglar, /ayarlar, /ozet, /sessiz, /yardim');
    return true;
  }
  async function stop() { stopped = true; if (loopPromise) await Promise.race([loopPromise, new Promise((r) => setTimeout(r, 1000))]); loopPromise = null; }

  return { start, stop, processUpdate, formatStatus, formatBalance, configured: () => Boolean(token && chatId), getPendingSetup: () => setup, getPendingRemove: () => pendingRemove, getPendingEnable: () => pendingEnable };
}

module.exports = { createTelegramCommands };
