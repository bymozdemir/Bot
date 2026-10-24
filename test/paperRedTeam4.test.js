const test=require('node:test');
const assert=require('node:assert/strict');
const store=require('../src/store');
const PaperEngine=require('../src/paperEngine');
const H=3600000;
function mkState(){const s=store.defaultState();s.running=true;s.settings.dailyLossLimitPct=100;s.settings.killSwitchLossPct=0;s.settings.reserveCashPct=0;s.settings.quoteAsset='USDT';s.pairs={'BTC/USDT':{...s.pairs['BTC/USDT'],enabled:true,budgetPct:100}};return s;}
function candles(now,price){const base=now-300*H;const a=[];for(let i=0;i<300;i++)a.push({t:base+i*H,o:price,h:price,l:price,c:price,v:1});a.push({t:now,o:price,h:price,l:price,c:price,v:1});return a;}

test('redteam4: cashByAsset string/array/null state normalize olmadan erişime düşmez',()=>{
 for(const bad of ['x',[],null]){const s=mkState();s.paper.cashByAsset=bad;const e=new PaperEngine({exchange:{quoteAssets:['USDT']},store:{save(){}},state:s});assert.doesNotThrow(()=>e.ensureState());assert.equal(typeof s.paper.cashByAsset,'object');assert.equal(Array.isArray(s.paper.cashByAsset),false);}
});

test('redteam4: 30 günlük kaos: şok, outage, restart, rollover, çoklu kararlar',async()=>{
 let now=Date.now(); let price=100; let s=mkState();
 const strategy=require('../src/strategies').registry[s.pairs['BTC/USDT'].strategyId]; const old=strategy.evaluate;
 let seed=0x12345678; const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 const makeEx=()=>({quoteAssets:['USDT'],fetchCandles:async()=>{if(rnd()<0.06) throw new Error('synthetic outage'); if(rnd()<0.08) price*=rnd()<0.5?0.2:5; price=Math.min(1e8,Math.max(0.01,price)); return candles(now,price);},fetchSymbolRules:async()=>({minNotional:10,stepSize:0})});
 try{
  strategy.evaluate=()=>({action:rnd()<0.18?'buy':rnd()<0.35?'sell':'hold',reason:'chaos'});
  for(let i=0;i<720;i++){
   now += H; if(rnd()<0.15) price*=0.5+rnd(); if(rnd()<0.08) price*=1.5+rnd()*2; price=Math.min(1e8,Math.max(0.01,price));
   const e=new PaperEngine({exchange:makeEx(),store:{save(x){s=JSON.parse(JSON.stringify(x));}},state:s,nowFn:()=>now});
   await e.tick();
   assert.ok(Number.isFinite(Number(s.paper.cash))); assert.ok(Number(s.paper.cash)>=0); assert.ok(Object.keys(s.paper.positions).length<=3);
   // Muhasebe değişmezi (eskiden bu test yalnızca log basıyordu, zarar/muhasebe doğruluğunu denetlemiyordu):
   //   nakit + açık pozisyonların maliyeti == başlangıç bakiyesi + gerçekleşen net K/Z (kazançlar - kayıplar)
   // Fiyat 1e8 mertebesine çıksa da hiçbir tur parayı yok edemez ya da yaratamaz.
   {
    const st=s.paper.stats||{}; const start=Number(s.paper.startingBalanceByAsset?.USDT);
    const open=Object.values(s.paper.positions).reduce((a,p)=>a+Number(p.costQuote),0);
    const lhs=Number(s.paper.cashByAsset.USDT)+open; const rhs=start+Number(st.grossWin||0)-Number(st.grossLoss||0);
    const tol=1e-8*Math.max(1,Math.abs(lhs),Math.abs(rhs));
    assert.ok(Number.isFinite(lhs)&&Number.isFinite(rhs), `tur ${i}: muhasebe değeri sonlu değil`);
    assert.ok(Math.abs(lhs-rhs)<=tol, `tur ${i}: muhasebe kaydı bozuldu: nakit+pozisyon=${lhs} beklenen=${rhs}`);
    for(const p of Object.values(s.paper.positions)){ assert.ok(p.quantity>0&&p.entryPrice>0&&p.costQuote>0, `tur ${i}: geçersiz pozisyon`); }
    assert.ok(Number.isFinite(Number(s.paper.costs?.fees))&&Number(s.paper.costs.fees)>=0, `tur ${i}: komisyon toplamı geçersiz`);
   }
   if(i%24===23){s=JSON.parse(JSON.stringify(s)); if(!s.killSwitch)s.running=true;}
   if(s.killSwitch) { s.killSwitch=null; s.running=true; s.settings.killSwitchLossPct=0; s.settings.dailyLossLimitPct=100; }
  }
 } finally {strategy.evaluate=old;}
});

test('redteam4: aşırı finite fiyat fill sonrası NaN/Infinity üretemez',()=>{ const s=mkState(); const e=new PaperEngine({exchange:{quoteAssets:['USDT']},store:{save(){}},state:s}); const pos={symbol:'BTC/USDT',quantity:10,entryPrice:1e308,costQuote:1e308,quoteAsset:'USDT',highWaterMark:1e308}; s.paper.positions['BTC/USDT']=pos; s.paper.cashByAsset.USDT=0; const r=e.sellAt('BTC/USDT',pos,1e308,'extreme'); assert.equal(r,false); assert.ok(Number.isFinite(s.paper.cashByAsset.USDT)); assert.equal(s.paper.positions['BTC/USDT']!==undefined,true); });
