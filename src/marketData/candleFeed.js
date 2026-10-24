// WebSocket mum akisi + REST gecmis tamamlama (Hummingbot CandlesBase fikrinden esinlenildi).
//
// GUVENLIK ILKESI: akis yalnizca bir HIZLANDIRICIDIR, tek gercek kaynak degil.
//   getCandles() yalnizca su hepsi dogruysa mum dondurur: baglanti acik, gecmis REST ile tamamlanmis,
//   son olay taze, yeterli sayida ve aralikli mum var. Aksi halde null doner ve cagiran normal REST yoluna duser.
//   Donen mumlar cagiranin mevcut dogrulayicilarindan (sira, hizalama, taze/gelecek kontrolu) yine gecer.
//
// Kopma/yeniden baglanma sonrasi akis bos aralik birakmis olabilir: bu durumda her anahtar "hazir degil"e
// alinir, REST ile gecmis yeniden doldurulur ve ancak sonra tekrar servis edilir.

const DEFAULT_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '8h': 28800000, '12h': 43200000, '1d': 86400000, '3d': 259200000, '1w': 604800000 };

class CandleStore {
  constructor({ intervalMs, maxCandles = 1000 }) {
    this.intervalMs = intervalMs;
    this.maxCandles = maxCandles;
    this.rows = [];
    this.ready = false;
    this.lastEventAt = 0;
  }
  static _valid(r) {
    return r && [r.t, r.o, r.h, r.l, r.c, r.v].every((x) => Number.isFinite(Number(x))) && Number(r.o) > 0 && Number(r.h) >= Number(r.l) && Number(r.c) > 0;
  }
  static _norm(r) { return { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }; }

  applyKline(k, now) {
    if (!CandleStore._valid(k)) return false;
    const row = CandleStore._norm(k);
    if (row.t % this.intervalMs !== 0) return false; // hizasiz zaman damgasi: akisi guvenme
    const last = this.rows[this.rows.length - 1];
    if (!last || row.t > last.t) this.rows.push(row);
    else if (row.t === last.t) this.rows[this.rows.length - 1] = row;
    else {
      const i = this.rows.findIndex((x) => x.t === row.t);
      if (i >= 0) this.rows[i] = row; // gec gelen guncelleme
      else return false;               // gecmise yeni mum eklenmez (gecmisi REST tamamlar)
    }
    if (this.rows.length > this.maxCandles) this.rows.splice(0, this.rows.length - this.maxCandles);
    this.lastEventAt = now;
    return true;
  }

  // REST gecmisi akisla birlestirir; ayni t icin KAPANMIS mumda REST, olusan (son) mumda daha yeni olan kazanir.
  mergeHistory(restRows) {
    const byT = new Map();
    for (const r of restRows) if (CandleStore._valid(r)) byT.set(Number(r.t), CandleStore._norm(r));
    const streamLast = this.rows[this.rows.length - 1];
    for (const r of this.rows) {
      const isForming = streamLast && r.t === streamLast.t;
      if (!byT.has(r.t) || isForming) byT.set(r.t, r);
    }
    this.rows = [...byT.values()].sort((a, b) => a.t - b.t).slice(-this.maxCandles);
  }

  isAligned() {
    for (let i = 1; i < this.rows.length; i++) {
      const d = this.rows[i].t - this.rows[i - 1].t;
      if (d <= 0 || d % this.intervalMs !== 0) return false;
    }
    return true;
  }
  // Binance bakim araliklarinda mum olmayabilir (REST dogrulayicisi da tam kat bosluga izin verir);
  // ama yalnizca tek-adim (araliksiz) son kisim "taze akis" icin yeterli sayilir.
  tail(limit) { return this.rows.slice(-limit).map((r) => ({ ...r })); }
}

class CandleFeed {
  constructor({ wsUrl, WebSocketImpl, fetchRest, symbolToStream, nowFn = Date.now, reconnectMs = 3000, maxStaleMs = 120000, backfillRetryMs = 15000, onLog = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
    if (!wsUrl) throw new Error('CandleFeed: wsUrl gerekli.');
    if (typeof fetchRest !== 'function') throw new Error('CandleFeed: fetchRest gerekli.');
    this.wsUrl = wsUrl;
    this.WebSocketImpl = WebSocketImpl || null;
    this.fetchRest = fetchRest;
    this.symbolToStream = symbolToStream || ((s) => String(s).replace('/', '').toLowerCase());
    this.nowFn = nowFn;
    this.reconnectMs = reconnectMs;
    this.maxStaleMs = maxStaleMs;
    this.backfillRetryMs = backfillRetryMs;
    this.log = onLog;
    this.timers = timers;
    this.stores = new Map();   // key -> { symbol, tf, limit, store, backfilling, nextBackfillAt }
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.closed = false;
    this.reconnectTimer = null;
    this.msgId = 1;
    this.stats = { messages: 0, rejectedMessages: 0, reconnects: 0, backfills: 0, backfillErrors: 0, servedFromFeed: 0, fallbacks: 0 };
  }

  static key(symbol, tf) { return `${symbol}|${tf}`; }
  _streamName(entry) { return `${this.symbolToStream(entry.symbol)}@kline_${entry.tf}`; }

  // Parite/aralik icin akis ve gecmis tamamlamayi baslatir (bloke etmez). Tekrar cagrilmasi zararsiz.
  ensure(symbol, tf, limit) {
    if (this.closed) return;
    const intervalMs = DEFAULT_MS[tf];
    if (!intervalMs) return;
    const key = CandleFeed.key(symbol, tf);
    let entry = this.stores.get(key);
    if (!entry) {
      entry = { symbol, tf, limit, store: new CandleStore({ intervalMs, maxCandles: Math.max(1000, limit) }), backfilling: false, nextBackfillAt: 0, subscribed: false };
      this.stores.set(key, entry);
    }
    entry.limit = Math.max(entry.limit, limit);
    if (this.connected) this._subscribe(entry);
    else this._connect();
    // Baglanti acilmadan gecmis tamamlamak bosuna REST istegidir (hazir sayilmaz); 'open' olayi hepsini tamamlar.
    if (this.connected && !entry.store.ready) this._backfill(entry);
  }

  async _backfill(entry) {
    const now = this.nowFn();
    if (entry.backfilling || now < entry.nextBackfillAt) return;
    entry.backfilling = true;
    try {
      this.stats.backfills++;
      const rows = await this.fetchRest(entry.symbol, entry.tf, Math.min(1000, Math.max(entry.limit, 50)));
      if (Array.isArray(rows) && rows.length) {
        entry.store.mergeHistory(rows);
        // Baglanti bu sirada koptuysa gecmis eski olabilir: yalnizca bagliyken hazir say.
        if (this.connected && entry.store.isAligned()) {
          entry.store.ready = true;
          // Sessiz (islemsiz) bir paritede "bayat" sayilma sayaci gecmis tamamlanmadan baslar.
          entry.store.lastEventAt = Math.max(entry.store.lastEventAt, this.nowFn());
        }
      }
    } catch (e) {
      this.stats.backfillErrors++;
      entry.nextBackfillAt = this.nowFn() + this.backfillRetryMs;
      this.log(`mum gecmisi tamamlanamadi ${entry.symbol} ${entry.tf}: ${e.message}`);
    } finally {
      entry.backfilling = false;
    }
  }

  getCandles(symbol, tf, limit) {
    const entry = this.stores.get(CandleFeed.key(symbol, tf));
    const fallback = () => { this.stats.fallbacks++; return null; };
    if (!entry || !this.connected || !entry.store.ready) return fallback();
    if (this.nowFn() - entry.store.lastEventAt > this.maxStaleMs) {
      entry.store.ready = false;
      entry.nextBackfillAt = Math.max(entry.nextBackfillAt, this.nowFn() + this.backfillRetryMs); // REST'i her cagrida dovme
      return fallback();
    }
    if (entry.store.rows.length < limit || !entry.store.isAligned()) return fallback();
    this.stats.servedFromFeed++;
    return entry.store.tail(limit);
  }

  _requireWs() {
    if (!this.WebSocketImpl) {
      try { this.WebSocketImpl = require('ws'); }
      catch (_) { throw new Error('WebSocket desteği için ws paketi gerekli. npm install çalıştır.'); }
    }
  }

  _connect() {
    if (this.closed || this.connecting || this.connected) return;
    try { this._requireWs(); } catch (e) { this.log(e.message); return; }
    this.connecting = true;
    let ws;
    try { ws = new this.WebSocketImpl(this.wsUrl, { handshakeTimeout: 10000 }); }
    catch (e) { this.connecting = false; this.log(`WebSocket baslatilamadi: ${e.message}`); this._scheduleReconnect(); return; }
    this.ws = ws;
    ws.on('open', () => {
      this.connecting = false;
      this.connected = true;
      for (const entry of this.stores.values()) { entry.subscribed = false; entry.store.ready = false; }
      for (const entry of this.stores.values()) { this._subscribe(entry); this._backfill(entry); }
    });
    ws.on('message', (raw) => this._onMessage(raw));
    const onDown = (why) => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false; this.connecting = false; this.ws = null;
      for (const entry of this.stores.values()) { entry.store.ready = false; entry.subscribed = false; }
      if (was) this.log(`WebSocket koptu (${why}); REST'e dusuluyor`);
      this._scheduleReconnect();
    };
    ws.on('close', () => onDown('close'));
    ws.on('error', (e) => onDown(`hata: ${e && e.message}`));
  }

  _subscribe(entry) {
    if (!this.connected || !this.ws || entry.subscribed) return;
    try {
      this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [this._streamName(entry)], id: this.msgId++ }));
      entry.subscribed = true;
    } catch (e) { this.log(`abonelik gonderilemedi: ${e.message}`); }
  }

  _onMessage(raw) {
    this.stats.messages++;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { this.stats.rejectedMessages++; return; }
    const data = msg && (msg.data || msg);
    if (!data || data.e !== 'kline' || !data.k) return; // abonelik yaniti vb.
    const k = data.k;
    const entry = this.stores.get(CandleFeed.key(this._symbolFromStream(data.s), k.i));
    if (!entry) { this.stats.rejectedMessages++; return; }
    const ok = entry.store.applyKline({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v }, this.nowFn());
    if (!ok) this.stats.rejectedMessages++;
  }

  _symbolFromStream(binanceSymbol) {
    const up = String(binanceSymbol || '').toUpperCase();
    for (const entry of this.stores.values()) if (this.symbolToStream(entry.symbol).toUpperCase() === up) return entry.symbol;
    return up;
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.stats.reconnects++;
    this.reconnectTimer = this.timers.setTimeout(() => { this.reconnectTimer = null; this._connect(); }, this.reconnectMs);
    if (this.reconnectTimer && typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) { this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = this.ws; this.ws = null; this.connected = false;
    try { if (ws) ws.close(); } catch (_) { /* yoksay */ }
  }
}

module.exports = { CandleFeed, CandleStore };
