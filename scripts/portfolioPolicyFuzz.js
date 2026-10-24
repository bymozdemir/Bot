const assert=require('assert');
const {normalizePortfolioPolicy,canOpenPosition}=require('../src/portfolioPolicy');
let seed=(Number(process.env.POLICY_FUZZ_SEED)||0xA11CE551)>>>0;
const rnd=()=>{seed^=seed<<13;seed>>>=0;seed^=seed>>>17;seed>>>=0;seed^=seed<<5;seed>>>=0;return seed/4294967296};
const N=Number(process.env.POLICY_FUZZ_STEPS||1000000);let blocked=0,allowed=0;
for(let i=0;i<N;i++){
 const max=1+((rnd()*100)|0), reserve=(rnd()*99), coreMax=(rnd()*31)|0, specMax=(rnd()*31)|0, coreCap=rnd()*100, specCap=rnd()*100;
 const policy=normalizePortfolioPolicy({maxPositions:max,reserveCashPct:reserve,buckets:{core:{maxPositions:coreMax,maxCapitalPct:coreCap},speculative:{maxPositions:specMax,maxCapitalPct:specCap}}});
 const pairs={}; const positions={}; const count=Math.min((rnd()*max)|0,40); for(let j=0;j<count;j++){const sym=`S${j}`;const cat=rnd()<.5?'core':'speculative';pairs[sym]={portfolioClass:cat};positions[sym]={costQuote:rnd()*1000};}
 const sym='NEW';const cat=rnd()<.5?'core':'speculative';pairs[sym]={portfolioClass:cat};const equity=1+rnd()*50000,cost=rnd()*1000;
 const r=canOpenPosition({symbol:sym,pair:pairs[sym],positions,pairs,policy,equity,requestedCost:cost});
 assert.equal(typeof r.ok,'boolean'); assert.ok(policy.maxPositions>=1&&policy.maxPositions<=100); assert.ok(policy.reserveCashPct>=0&&policy.reserveCashPct<100);
 for(const b of Object.values(policy.buckets)){assert.ok(b.maxPositions>=0&&b.maxPositions<=100);assert.ok(b.maxCapitalPct>=0&&b.maxCapitalPct<=100);}
 r.ok?allowed++:blocked++;
}
console.log(JSON.stringify({steps:N,allowed,blocked,seed}));
