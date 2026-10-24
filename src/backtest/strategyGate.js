// Strategy safety gate: shared portfolio + blind OOS + Monte Carlo + sensitivity.
const { runPortfolioBacktest } = require('./portfolioSimulator');
const { buildStrategy } = require('./combinationStrategy');

function pct(v){return Number.isFinite(v)?v:0;}
// Doğrusal enterpolasyonlu yüzdelik dilim. ESKİ HATA: `x[b]+(x[b+1]??x[b]-x[b])*f` işlem önceliği
// yüzünden x[b] + x[b+1]*f hesaplıyordu (medyan/p05/p95 yanlış raporlanıyordu; örn. 1..10 medyanı 5.5 yerine 8).
function quantile(a,q){if(!a.length)return 0;const x=a.slice().sort((m,n)=>m-n),i=(x.length-1)*q,b=Math.floor(i),f=i-b;const hi=x[b+1]===undefined?x[b]:x[b+1];return x[b]+(hi-x[b])*f;}
function bootstrapTradeReturns(trades, iterations=2000, seed=0x9e3779b9){
  const r=trades.map(t=>Number(t.pnlPct)).filter(Number.isFinite); if(r.length<5)return {iterations:0,median:0,p05:0,negativePct:100};
  let s=seed>>>0; const rnd=()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;};
  const totals=[]; for(let k=0;k<iterations;k++){let total=1;for(let i=0;i<r.length;i++)total*=1+r[Math.floor(rnd()*r.length)]/100;totals.push((total-1)*100);}
  const negative=totals.filter(x=>x<0).length/totals.length*100;
  return {iterations,median:quantile(totals,.5),p05:quantile(totals,.05),p95:quantile(totals,.95),negativePct:negative};
}
function perturbRisk(base, factor){return {...base,stopLossPct:Math.max(.25,Number(base.stopLossPct||3)*factor),takeProfitPct:Math.max(0,Number(base.takeProfitPct||0)*factor)};}
function runSensitivity({datasets,symbols,startIndex,endIndex,candidate,capital,feePct,slippagePct,reserveCashPct,maxConcurrentPositions,budgetPct,portfolioPolicy,pairs}){
  const factors=[.8,.9,1,1.1,1.2], rows=[]; const strategy=buildStrategy(candidate);
  for(const f of factors){const r=runPortfolioBacktest({datasets,symbols,startIndex,endIndex,strategy,params:perturbRisk(candidate.risk,f),capital,feePct,slippagePct,reserveCashPct,maxConcurrentPositions,budgetPct,portfolioPolicy,pairs});rows.push({factor:f,returnPct:r.returnPct,maxDrawdownPct:r.maxDrawdownPct,trades:r.trades,profitFactor:r.profitFactor});}
  const positive=rows.filter(r=>r.returnPct>0).length;
  return {rows,positivePct:positive/rows.length*100,worstReturnPct:Math.min(...rows.map(r=>r.returnPct)),returnStdPct:Math.sqrt(rows.reduce((s,r)=>s+r.returnPct*r.returnPct,0)/rows.length-Math.pow(rows.reduce((s,r)=>s+r.returnPct,0)/rows.length,2))};
}
function evaluateGate({oos,monteCarlo,sensitivity,portfolioConfig,minTrades=30}){
  const k={
    OOS_POSITIVE:oos.returnPct>0,
    OOS_TRADES:oos.trades>=minTrades,
    OOS_DD:oos.maxDrawdownPct>=-25,
    OOS_PF:Number.isFinite(oos.profitFactor)&&oos.profitFactor>=1.15,
    MC_P05_POSITIVE:monteCarlo.p05>0,
    MC_NEGATIVE_LT50:monteCarlo.negativePct<50,
    PARAM_POSITIVE_80:sensitivity.positivePct>=80,
    PARAM_WORST_RETURN:sensitivity.worstReturnPct>-10,
    PORTFOLIO_CONSTRAINTS:portfolioConfig.maxConcurrentPositions>=1&&portfolioConfig.maxConcurrentPositions<=100&&portfolioConfig.reserveCashPct>=0&&portfolioConfig.reserveCashPct<100&&Object.values(portfolioConfig.buckets||{}).every(b=>Number(b.maxPositions)>=0&&Number(b.maxCapitalPct)>=0&&Number(b.maxCapitalPct)<=100)
  };
  return {eligible:Object.values(k).every(Boolean),checks:k,failed:Object.entries(k).filter(([,v])=>!v).map(([k])=>k)};
}
module.exports={bootstrapTradeReturns,runSensitivity,evaluateGate,quantile};
