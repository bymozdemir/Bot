const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const PaperEngine = require('../src/paperEngine');

const H=3600000, T0=Date.UTC(2026,9,1);
const c=(i,o=100)=>({t:T0+i*H,o,h:o,l:o,c:o,v:1});

function mk(){ const s=store.defaultState(); s.settings.dailyLossLimitPct=100; s.settings.killSwitchLossPct=10; s.settings.reserveCashPct=0; s.settings.quoteAsset='USDT'; s.pairs={'BTC/USDT':{...s.pairs['BTC/USDT'],enabled:true,budgetPct:100}}; s.running=true; return s; }

test('redteam: TRY kasası liquidation risk hesabına eklenmez',()=>{
 const s=mk(); s.paper.cashByAsset={USDT:50,TRY:10000}; s.paper.startingBalanceByAsset={USDT:50,TRY:10000}; s.paper.positions={'BTC/USDT':{symbol:'BTC/USDT',quantity:1,entryPrice:100,quoteAsset:'USDT',costQuote:100}};
 const e=new PaperEngine({exchange:{quoteAssets:['USDT','TRY']},store:{save(){}},state:s});
 assert.ok(e.liquidationEquity({'BTC/USDT':100}) < 200);
});

test('redteam: kill switch önce kalıcı kilidi yazar',()=>{
 const s=mk(); s.paper.cashByAsset.USDT=0; s.paper.startingBalanceByAsset.USDT=100; s.paper.positions={'BTC/USDT':{symbol:'BTC/USDT',quantity:1,entryPrice:100,quoteAsset:'USDT',costQuote:100}}; s.paper.lastPrices={'BTC/USDT':50};
 let disk=null; const e=new PaperEngine({exchange:{quoteAssets:['USDT']},store:{save(x){disk=JSON.parse(JSON.stringify(x));}},state:s,nowFn:()=>T0});
 e.closeAll=()=>{ throw new Error('simulated crash during liquidation'); };
 assert.throws(()=>e.checkLossLimits(e.liquidationEquity(s.paper.lastPrices)),/simulated crash/);
 assert.equal(disk.killSwitch!=null,true); assert.equal(disk.running,false);
});

test('redteam: forming mum yoksa yeni BUY/SELL kapanış fiyatından uygulanmaz',async()=>{
 const s=mk(); const strategy=require('../src/strategies').registry[s.pairs['BTC/USDT'].strategyId]; const old=strategy.evaluate; strategy.evaluate=()=>({action:'buy',reason:'redteam'});
 try { const e=new PaperEngine({exchange:{quoteAssets:['USDT'],fetchCandles:async()=>Array.from({length:12},(_,i)=>c(i)),fetchSymbolRules:async()=>({minNotional:10})},store:{save(){}},state:s,nowFn:()=>T0+13*H}); await e.tick(); assert.equal(Object.keys(s.paper.positions).length,0); } finally { strategy.evaluate=old; }
});

test('redteam: state risk ayarlarında üst sınır uygulanır',()=>{
 const s=mk(); s.settings.paperFeePct=999; s.settings.paperSlippagePct=999; s.settings.reserveCashPct=999; s.settings.maxConcurrentPositions=99999; const e=new PaperEngine({exchange:{quoteAssets:['USDT']},store:{save(){}},state:s}); e.ensureState(); assert.equal(s.settings.paperFeePct,0.1); assert.equal(s.settings.paperSlippagePct,0.05); assert.equal(s.settings.reserveCashPct,10); assert.equal(s.settings.maxConcurrentPositions,3); });
