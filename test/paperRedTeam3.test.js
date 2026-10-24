const test=require('node:test');
const assert=require('node:assert/strict');
const store=require('../src/store');
const PaperEngine=require('../src/paperEngine');
const {validateCandleSeries}=require('../src/execution');
const H=3600000,T0=Date.UTC(2026,9,1);
const candle=(i,o=100)=>({t:T0+i*H,o,h:o,l:o,c:o,v:1});

test('redteam3: açık eski-quote pozisyonu motoru risk dışına itemez, kill lock konur',()=>{
 const s=store.defaultState(); s.running=true; s.settings.quoteAsset='TRY'; s.paper.cashByAsset={USDT:50,TRY:100}; s.paper.positions={'BTC/USDT':{symbol:'BTC/USDT',quantity:1,entryPrice:100,costQuote:100,quoteAsset:'USDT',highWaterMark:100}};
 const e=new PaperEngine({exchange:{quoteAssets:['USDT','TRY']},store:{save(){}},state:s}); e.ensureState();
 assert.equal(s.running,false); assert.ok(s.killSwitch); assert.match(s.killSwitch.reason,/uyumsuz açık pozisyon/);
});

test('redteam3: geri giden sistem saati Paperı kilitler',async()=>{
 const s=store.defaultState(); s.running=true; s.settings.dailyLossLimitPct=100; s.settings.killSwitchLossPct=0;
 const e=new PaperEngine({exchange:{quoteAssets:['USDT'],fetchCandles:async()=>[...Array(12)].map((_,i)=>candle(i))},store:{save(){}},state:s,nowFn:()=>T0+10*H});
 e.lastTickAt=T0+11*H; await e.tick(); assert.equal(s.running,false); assert.ok(s.killSwitch); assert.match(s.killSwitch.reason,/saati geriye gitti/);
});

test('redteam3: Paper bozuk/duplicate/sırasız candle kabul etmez',()=>{
 const bad=[candle(0),candle(1),candle(1)]; assert.throws(()=>validateCandleSeries(bad,'1h'),/timestamp|sırası/);
});

test('redteam3: Paper aşırı büyük candle cevabını reddeder',async()=>{
 const s=store.defaultState(); s.running=true; s.settings.dailyLossLimitPct=100; s.settings.killSwitchLossPct=0;
 const e=new PaperEngine({exchange:{quoteAssets:['USDT'],fetchCandles:async()=>Array.from({length:5000},(_,i)=>candle(i))},store:{save(){}},state:s,nowFn:()=>T0+10*H});
 await e.tick(); assert.equal(Object.keys(s.paper.positions).length,0); assert.match(s.decisions['BTC/USDT'].error,/geçersiz veya beklenenden büyük/);
});
