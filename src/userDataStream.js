// Binance Spot User Data Stream istemcisi.
// Güncel yöntem: userDataStream.subscribe.signature.
// Eski listenKey ve SAPI userListenToken yolu kullanılmaz.

const crypto = require('crypto');

class BinanceUserDataStream {
  constructor({ exchange, orderManager, state, store, WebSocketImpl, nowFn, reconnectMs = 3000, connectionRefreshMs = 23 * 60 * 60 * 1000, subscribeTimeoutMs = 15000, handshakeTimeoutMs = 10000 } = {}) {
    if (!exchange || typeof exchange.createUserDataStreamSignature !== 'function') {
      throw new Error('UserDataStream için imzalı Binance User Data Stream desteği gerekli.');
    }
    if (!orderManager || typeof orderManager.applyExecutionReport !== 'function') {
      throw new Error('UserDataStream için OrderManager gerekli.');
    }
    this.exchange = exchange;
    this.orderManager = orderManager;
    this.state = state || {};
    this.store = store || { save() {} };
    // Node.js sunucusunda WHATWG WebSocket yerine ws kullanılır; motor ws.on() sözleşmesine dayanır.
    this.WebSocketImpl = WebSocketImpl || null;
    this.nowFn = nowFn || (() => Date.now());
    this.reconnectMs = reconnectMs;
    this.connectionRefreshMs = connectionRefreshMs;
    this.subscribeTimeoutMs = subscribeTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.refreshTimer = null;
    this.ws = null;
    this.running = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.subscriptionId = null;
    this.lastEventTime = 0;
  }

  // Disk yazimi basarisiz olursa (ENOSPC...) akis islemleri DURMAMALI: aksi halde olay isleyicilerinde istisna firlar,
  // yurutme raporlari uygulanmaz ve surec yakalanmamis istisnayla cokebilir. Hata durum nesnesinde saklanir.
  _save(patch) {
    this.state.liveStream = { ...(this.state.liveStream || {}), ...patch };
    try { this.store.save(this.state); this.lastSaveError = null; }
    catch (err) { this.lastSaveError = err?.message || String(err); }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._save({ running: true, connected: false, error: null });
    try {
      await this._connect();
    } catch (err) {
      // Ilk baglanti/abonelik basarisizsa akis "calisiyor" diye ISARETLI KALMAMALI: aksi halde kullanici tekrar
      // baslat dediginde start() 'zaten calisiyor' sanip hic baglanmadan doner, bot baglantisiz ve sessiz kalir.
      const message = err?.message || String(err);
      await this.stop().catch(() => {});
      this._save({ running: false, connected: false, error: message });
      throw err;
    }
  }

  async _connect() {
    if (!this.running || this.connecting) return;
    if (!this.WebSocketImpl) {
      try { this.WebSocketImpl = require('ws'); }
      catch (err) { throw new Error('WebSocket desteği için ws paketi gerekli. npm install çalıştır.'); }
    }
    this.connecting = true;
    try {
      if (typeof this.exchange.syncTime === 'function') {
        try { await this.exchange.syncTime(); } catch (_) { /* saat servisi yoksa onceki ofset kullanilir */ }
      }
      // handshakeTimeout: TCP/TLS el sikismasi takilirsa 'connecting' sonsuza dek true kalip yeniden baglanmayi kilitlerdi.
      if (this.ws) { try { this.ws.close(); } catch (_) { /* yoksay */ } }   // eski soket sizmasin
      const ws = new this.WebSocketImpl(this.exchange.getUserDataWsUrl(), { handshakeTimeout: this.handshakeTimeoutMs });
      this.ws = ws;
      let opened = false;
      let subscribed = false;
      // Abonelik yaniti hic gelmezse beklemek sonsuza dek surerdi (start() asili kalir, canli kapi belirsiz).
      let subTimer = null;
      const subscribeTimeout = new Promise((_, rej) => {
        subTimer = setTimeout(() => {
          try { if (typeof ws.terminate === 'function') ws.terminate(); else ws.close(); } catch (_) { /* yoksay */ }
          rej(new Error('User Data Stream aboneliği zaman aşımına uğradı.'));
        }, this.subscribeTimeoutMs);
      });
      const subscribePromise = new Promise((resolve, reject) => {
        ws.on('open', () => {
          opened = true;
          const id = crypto.randomBytes(8).toString('hex');
          let params;
          try {
            const timestamp = typeof this.exchange.getUserDataStreamTimestamp === 'function'
              ? this.exchange.getUserDataStreamTimestamp(this.nowFn())
              : this.nowFn();
            params = this.exchange.createUserDataStreamSignature({ timestamp, recvWindow: 5000 });
          } catch (err) {
            reject(err);
            return;
          }
          ws.send(JSON.stringify({
            id,
            method: 'userDataStream.subscribe.signature',
            params
          }));
        });
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            this._handleMessage(msg);
            if (msg.status === 200 && msg.result && Object.prototype.hasOwnProperty.call(msg.result, 'subscriptionId')) {
              subscribed = true;
              this.subscriptionId = msg.result.subscriptionId;
              this._save({ connected: true, subscriptionId: this.subscriptionId, lastConnectedAt: new Date(this.nowFn()).toISOString(), error: null });
              this._scheduleConnectionRefresh();
              resolve();
            } else if (msg.status && msg.status >= 400) {
              reject(new Error(msg.error?.msg || 'User Data Stream aboneliği reddedildi.'));
            }
          } catch (err) {
            this._save({ error: `WebSocket mesajı okunamadı: ${err.message}` });
          }
        });
        ws.on('error', (err) => {
          this._save({ connected: false, error: err?.message || String(err) });
          if (!opened) reject(err);
        });
        ws.on('close', () => {
          if (!opened) reject(new Error('User Data Stream WebSocket bağlantısı abonelikten önce kapandı.'));
          // Gecikmis (eski) soketin kapanis olayi, yerine gecmis YENI baglantiyi null'lamamali ve ikinci bir yeniden
          // baglanma zamanlamamali (aksi halde cift/sizan baglanti olusur).
          if (this.ws !== ws) return;
          this.ws = null;
          this.subscriptionId = null;
          this._clearConnectionRefresh();
          this._save({ connected: false, lastDisconnectedAt: new Date(this.nowFn()).toISOString() });
          if (this.running) this._scheduleReconnect();
        });
      });
      try { await Promise.race([subscribePromise, subscribeTimeout]); }
      catch (err) {
        // Abonelik reddedildi/zaman asimi: acik kalan soket temizlenir; yoksa her deneme bir baglanti sizdirir.
        if (this.ws === ws) this.ws = null;
        try { if (typeof ws.terminate === 'function') ws.terminate(); else ws.close(); } catch (_) { /* yoksay */ }
        throw err;
      }
      finally { if (subTimer) clearTimeout(subTimer); }
      if (!subscribed) throw new Error('User Data Stream aboneliği doğrulanamadı.');
    } finally {
      this.connecting = false;
    }
  }

  _scheduleConnectionRefresh() {
    this._clearConnectionRefresh();
    if (!this.running || !(this.connectionRefreshMs > 0)) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (!this.running || !this.ws) return;
      this._save({ connected: false, error: 'WebSocket yaşam süresi yaklaşınca kontrollü yeniden bağlanılıyor.' });
      try { this.ws.close(); } catch (_) {}
    }, this.connectionRefreshMs);
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
  }

  _clearConnectionRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  _scheduleReconnect(delay = this.reconnectMs) {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect().catch((err) => {
        this._save({ connected: false, error: err?.message || String(err) });
        this._scheduleReconnect();
      });
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  _handleMessage(msg) {
    const event = msg && msg.event ? msg.event : msg;
    if (!event || typeof event !== 'object' || !event.e) return;
    this.lastEventTime = Number(event.E || this.nowFn());

    // Yurutme raporu ONCE uygulanir (kayit/disk sorunu olayi yutmamali), sonra akis durumu kaydedilir.
    if (event.e === 'executionReport') {
      try { this.orderManager.applyExecutionReport(event); }
      finally { this._save({ lastEventAt: new Date(this.lastEventTime).toISOString() }); }
    } else {
      this._save({ lastEventAt: new Date(this.lastEventTime).toISOString() });
    }
    if (event.e === 'eventStreamTerminated') {
      this._save({ connected: false, error: 'Binance User Data Stream sona erdi; yeniden bağlanılıyor.' });
      if (this.ws) { try { this.ws.close(); } catch (_) {} }
      this._scheduleReconnect(0);
    }
  }

  async stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this._clearConnectionRefresh();
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
    this.ws = null;
    this.subscriptionId = null;
    this._save({ running: false, connected: false });
  }
}

module.exports = { BinanceUserDataStream };
