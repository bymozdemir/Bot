const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const LiveEngine = require('../src/liveEngine');

function exchange() {
  return {
    id:'test', name:'Test', quoteAssets:['USDT'],
    capabilities:{clientOrderId:true,orderQuery:true,balanceQuery:true,openOrdersQuery:true,userDataStream:true},
    async fetchBalance(){return {USDT:{free:1000,locked:0,total:1000}}},
    async fetchOpenOrders(){return []},
    async getOrder(){return {status:'FILLED',executedQty:1,cummulativeQuoteQty:100}},
    async fetchCandles(){return []}, async fetchTicker(){return {price:100}},
    async fetchSymbolRules(){return {stepSize:.001,minQty:.001,minNotional:10}},
    async createMarketOrder(){throw new Error('order should not be sent')},
    async createStopOrder(){throw new Error('stop should not be sent')},
    async cancelOrder(){return {status:'CANCELED'}}
  };
}
function engine(state){return new LiveEngine({exchange:exchange(),state,store:{save(){}},allowLive:true});}

test('live: bozuk risk ayarları başlangıçta fail-closed olur', async()=>{
  const fields=['maxConcurrentPositions','reserveCashPct','dailyLossLimitPct','killSwitchLossPct','maxTradeQuote'];
  for(const field of fields){
    const s=store.defaultState(); s.settings.mode='live'; s.settings[field]=NaN;
    const e=engine(s);
    await assert.rejects(()=>e.start(), /Canlı risk ayarları geçersiz/);
    assert.equal(s.running,false);
  }
});

test('live: reserveCashPct 100 üstü veya negatifse emir kapısı açılmaz', async()=>{
  for(const value of [-1,101]){
    const s=store.defaultState(); s.settings.mode='live'; s.settings.reserveCashPct=value;
    const e=engine(s); await assert.rejects(()=>e.start(), /reserveCashPct/);
  }
});

test('live: maxTradeQuote NaN olunca limitsiz işleme dönüşmez', async()=>{
  const s=store.defaultState(); s.settings.mode='live'; s.settings.maxTradeQuote=NaN;
  const e=engine(s); await assert.rejects(()=>e.start(), /maxTradeQuote/);
});

test('live: pair budgetPct 100 üstü/bozuksa alış kilitlenir', async()=>{
  for(const value of [101,NaN,0,-1]){
    const s=store.defaultState(); s.settings.mode='live'; s.live.safeToTrade=true;
    const e=engine(s);
    await assert.rejects(()=>e.buy('BTC/USDT',{budgetPct:value},{stopLossPct:5},100,'test',e.epoch), /budgetPct/);
    assert.equal(s.live.safeToTrade,false);
  }
});

test('live: risk ayarı çalışma sırasında bozulursa ikinci risk kapısı botu durdurur', async()=>{
  const s=store.defaultState(); s.settings.mode='live'; s.running=true;
  s.live.startingEquity=1000; s.live.dayKey='2026-10-03'; s.live.dayStartEquity=1000;
  s.live.lastBalance={USDT:{free:1000,locked:0,total:1000}};
  s.settings.dailyLossLimitPct=NaN;
  const e=engine(s); await e._checkRiskGate();
  assert.equal(s.running,false); assert.equal(s.live.safeToTrade,false); assert.ok(s.killSwitch);
});


test('live: gerçek borsada API izinleri sorgulanamıyorsa fail-closed', async()=>{
  const s=store.defaultState(); s.settings.mode='live';
  const e=engine(s); e.exchange.id='real-exchange';
  await assert.rejects(()=>e._assertApiKeySafe(), /Canlı başlangıç engellendi.*doğrulanamıyor/);
  assert.equal(s.live.apiRestrictionsChecked,false);
});

test('live: API izin yanıtı belirsizse fail-closed, çekim kapalıysa doğrulanır', async()=>{
  const s=store.defaultState(); s.settings.mode='live';
  const e=engine(s); e.exchange.id='real-exchange';
  e.exchange.fetchApiRestrictions=async()=>({});
  await assert.rejects(()=>e._assertApiKeySafe(), /yanıtı kesin değil/);
  e.exchange.fetchApiRestrictions=async()=>({enableWithdrawals:false});
  await e._assertApiKeySafe();
  assert.equal(s.live.apiRestrictionsChecked,true);
});

test('live: sıfır bakiyeye düşen quote toplam zarar limitini tetikler', async()=>{
  const s=store.defaultState(); s.settings.mode='live'; s.running=true;
  s.settings.killSwitchLossPct=10; s.settings.dailyLossLimitPct=10;
  s.live.startingEquity=1000; s.live.dayStartEquity=1000;
  s.live.startingEquityByQuote={USDT:1000}; s.live.dayStartEquityByQuote={USDT:1000};
  s.live.dayKey='2026-10-16'; s.live.lastBalance={USDT:{free:0,locked:0,total:0}};
  const e=engine(s); await e._checkRiskGate();
  assert.ok(s.killSwitch); assert.equal(s.running,false);
});


test('live: emir dolumu eski bakiye görüntüsünü geçersiz kılar ve yeni emirleri kilitler', ()=>{
  const s=store.defaultState(); s.live.safeToTrade=true;
  const e=engine(s); e.lastReconcileAt=123456;
  e._onOrderUpdate({symbol:'BTC/USDT',status:'FILLED',meta:{role:'entry'},clientOrderId:'entry-test'});
  assert.equal(e.lastReconcileAt,0);
  assert.equal(s.live.safeToTrade,false);
  assert.match(s.live.lockReason,/bakiye mutabakatı/);
});
