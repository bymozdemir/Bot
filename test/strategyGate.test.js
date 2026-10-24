const test=require('node:test');
const assert=require('node:assert/strict');
const {runPortfolioBacktest}=require('../src/backtest/portfolioSimulator');
const {bootstrapTradeReturns,runSensitivity,evaluateGate}=require('../src/backtest/strategyGate');

const H=3600000;
// Sabit baslangic zamani: Date.now() her cagrida farkli milisaniye verebilir; portfoy simulatoru tum coinlerin
// mum zamanlarinin birebir ayni olmasini ister, bu yuzden test rastgele (zamanlamaya bagli) basarisiz oluyordu.
const T0=Date.UTC(2024,0,1);
function candles(n,base=100){return Array.from({length:n},(_,i)=>{const c=base+i*.02;return {t:T0+i*H,o:c,h:c*1.01,l:c*.99,c,v:100};});}
function strat(){return {defaultParams:{stopLossPct:3,takeProfitPct:6,trailingStop:false},minCandles:()=>5,evaluate(){return {action:'hold',reason:'test'};}};}

test('shared portfolio respects reserve and max concurrent positions',()=>{
 const ds={A:{candles:candles(30,100)},B:{candles:candles(30,110)},C:{candles:candles(30,120)},D:{candles:candles(30,130)}};
 const r=runPortfolioBacktest({datasets:ds,symbols:Object.keys(ds),strategy:strat(),capital:1000,reserveCashPct:10,maxConcurrentPositions:3,budgetPct:30});
 assert.ok(r.peakOpenPositions<=3); assert.ok(r.finalEquity===1000); assert.ok(r.constraints.reserveCashPct===10);
});

test('monte carlo is deterministic and reports negative-tail risk',()=>{
 const trades=Array.from({length:20},(_,i)=>({pnlPct:i%2?2:-1}));
 const a=bootstrapTradeReturns(trades,500,123),b=bootstrapTradeReturns(trades,500,123);
 assert.deepEqual(a,b); assert.equal(a.iterations,500); assert.ok(Number.isFinite(a.p05));
});

test('sensitivity covers five risk perturbations',()=>{
 const ds={A:{candles:candles(40)}}; const candidate={id:'x',conditions:[],risk:{stopLossPct:3,takeProfitPct:6,trailingStop:false}};
 const r=runSensitivity({datasets:ds,symbols:['A'],startIndex:0,endIndex:39,candidate,capital:1000,feePct:.1,slippagePct:.05,reserveCashPct:10,maxConcurrentPositions:3,budgetPct:30});
 assert.equal(r.rows.length,5); assert.equal(r.rows[2].factor,1); assert.ok(Number.isFinite(r.worstReturnPct));
});

test('live gate stays closed when OOS/MC evidence is weak',()=>{
 const g=evaluateGate({oos:{returnPct:1,trades:10,maxDrawdownPct:-5,profitFactor:1.3},monteCarlo:{p05:-20,negativePct:65},sensitivity:{positivePct:60,worstReturnPct:-20},portfolioConfig:{maxConcurrentPositions:3,reserveCashPct:10},minTrades:30});
 assert.equal(g.eligible,false); assert.ok(g.failed.includes('OOS_TRADES')); assert.ok(g.failed.includes('MC_P05_POSITIVE'));
});
