// Deterministik otomatik strateji kombinasyon + parametre + walk-forward tarayıcısı.
// Araştırma disiplini: kronolojik train/validation/OOS, validation-only model seçimi,
// çoklu sembol/TF dayanıklılığı, maliyet sonrası skor, düşük işlem sayısı cezası ve
// fold istikrarı. OOS verisi seçim sürecinde HİÇ kullanılmaz.
const fs = require('fs');
const path = require('path');
const store = require('../store');
const { loadCandles, INTERVAL_MS, DEFAULT_BASE_URL } = require('./data');
const { runBacktest } = require('./simulator');
const { buildStrategy } = require('./combinationStrategy');
const { runPortfolioBacktest } = require('./portfolioSimulator');
const { normalizePortfolioPolicy } = require('../portfolioPolicy');
const { bootstrapTradeReturns, runSensitivity, evaluateGate } = require('./strategyGate');

const MONTH = 30 * 86400000;
const clamp = (v,a,b) => Math.max(a, Math.min(b,v));

function parse(argv) {
  const o={months:60, tf:['1h','4h'], symbols:Object.keys(store.defaultState().pairs), feePct:.1, slippagePct:.05, capital:1000, maxCandidates:180, trainMonths:8, validationMonths:4, stepMonths:4, oosMonths:4, maxComb:3, minTrades:8, reserveCashPct:10, maxConcurrentPositions:3, budgetPct:30, portfolioPolicy:normalizePortfolioPolicy(null), categoryBySymbol:{}, monteCarlo:2000, baseUrl:process.env.BINANCE_BASE_URL||DEFAULT_BASE_URL, refresh:false, out:path.join(__dirname,'../../data/backtest/scanner')};
  const val=new Set(['--months','--tf','--symbols','--fee','--slip','--capital','--max-candidates','--train-months','--validation-months','--step-months','--oos-months','--max-comb','--min-trades','--reserve','--max-positions','--budget','--mc','--base','--out','--policy-json','--categories-json']);
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--refresh')o.refresh=true;
    else if(val.has(a)){
      const v=argv[++i];
      if(a==='--months')o.months=+v; if(a==='--tf')o.tf=v.split(','); if(a==='--symbols')o.symbols=v.split(',').map(x=>x.toUpperCase());
      if(a==='--fee')o.feePct=+v; if(a==='--slip')o.slippagePct=+v; if(a==='--capital')o.capital=+v; if(a==='--max-candidates')o.maxCandidates=+v;
      if(a==='--train-months')o.trainMonths=+v; if(a==='--validation-months')o.validationMonths=+v; if(a==='--step-months')o.stepMonths=+v;
      if(a==='--policy-json'){ try{o.portfolioPolicy=normalizePortfolioPolicy(JSON.parse(v));}catch(e){throw new Error('--policy-json geçersiz JSON.');} }
      if(a==='--categories-json'){ try{o.categoryBySymbol=JSON.parse(v);}catch(e){throw new Error('--categories-json geçersiz JSON.');} }
      if(a==='--oos-months')o.oosMonths=+v; if(a==='--reserve')o.reserveCashPct=+v; if(a==='--max-positions')o.maxConcurrentPositions=+v; if(a==='--budget')o.budgetPct=+v; if(a==='--mc')o.monteCarlo=+v; if(a==='--max-comb')o.maxComb=+v; if(a==='--min-trades')o.minTrades=+v; if(a==='--base')o.baseUrl=v.replace(/\/+$/,''); if(a==='--out')o.out=v;
    } else throw new Error(`Bilinmeyen seçenek: ${a}`);
  }
  if(!(o.months>0 && o.months<=120)) throw new Error('--months 0-120 ay aralığında olmalı.');
  if(o.maxComb<1||o.maxComb>3)throw new Error('--max-comb 1-3 olmalı.');
  if(o.maxCandidates<12)throw new Error('--max-candidates en az 12 olmalı.');
  if(o.minTrades<1)throw new Error('--min-trades en az 1 olmalı.');
  if(!o.portfolioPolicy || !o.portfolioPolicy.buckets) o.portfolioPolicy=normalizePortfolioPolicy({maxPositions:o.maxConcurrentPositions,reserveCashPct:o.reserveCashPct});
  o.maxConcurrentPositions=o.portfolioPolicy.maxPositions; o.reserveCashPct=o.portfolioPolicy.reserveCashPct;
  if(o.reserveCashPct<0||o.reserveCashPct>=100)throw new Error('--reserve 0-99 olmalı.');
  if(o.maxConcurrentPositions<1||o.maxConcurrentPositions>100)throw new Error('--max-positions 1-100 olmalı.');
  if(o.budgetPct<=0||o.budgetPct>100)throw new Error('--budget 0-100 olmalı.');
  if(o.monteCarlo<100||o.monteCarlo>100000)throw new Error('--mc 100-100000 olmalı.');
  if(o.trainMonths<1||o.validationMonths<1||o.oosMonths<1)throw new Error('Train/validation/OOS ayları pozitif olmalı.');
  if(o.trainMonths+o.validationMonths+o.oosMonths>o.months)throw new Error('train + validation + OOS toplamı seçilen ay penceresini aşamaz.');
  for(const t of o.tf)if(!INTERVAL_MS[t])throw new Error(`Desteklenmeyen TF: ${t}`);
  return o;
}

function choose(arr,k,start=0,prefix=[],out=[]){if(prefix.length===k){out.push(prefix.slice());return out;}for(let i=start;i<arr.length;i++)choose(arr,k,i+1,prefix.concat(arr[i]),out);return out;}

function atoms(){
 const a=[];
 for(const period of [7,14,21]) for(const level of [25,30,35]) a.push({type:'rsi_oversold',period,level,label:`RSI${period}<${level}`});
 for(const p of [50,100,200]) for(const b of [0,1]) a.push({type:'ema_trend',period:p,bufferPct:b,label:`fiyat>EMA${p}${b?' +'+b+'%':''}`});
 for(const x of [[8,21,5],[12,26,9],[16,34,9]]) a.push({type:'macd_up',fast:x[0],slow:x[1],signal:x[2],label:`MACD ${x.join('/')}`});
 for(const p of [14,20,30]) for(const m of [1.5,2,2.5]) a.push({type:'bb_recover',period:p,mult:m,label:`BB${p}x${m} toparlanma`});
 for(const p of [7,14,21]) for(const l of [15,20,25]) a.push({type:'stoch_oversold',period:p,level:l,label:`Stoch${p}<${l}`});
 for(const p of [50,100,200]) a.push({type:'price_sma',period:p,bufferPct:0,label:`fiyat>SMA${p}`});
 // Kısa vade momentum ve trend gücü adayları; RSI/EMA ailesinden farklı doğrulama sağlar.
 for(const [fast,slow] of [[8,21],[9,21],[12,26]]) a.push({type:'ema_cross',fast,slow,label:`EMA${fast}/${slow} yukarı kesişim`});
 for(const period of [14,20]) for(const level of [18,20,25]) a.push({type:'adx_min',period,level,label:`ADX${period}>=${level}`});
 return a;
}

// Tam kombinasyon uzayı yaklaşık 100k risk/exit varyantına çıktığı için varsayılan
// tarama kontrollü örnekleme yapar. ÖNEMLİ: her karmaşıklık sınıfında listenin başını
// almak yerine indeksleri tüm uzaya yayar; böylece maxCandidates ilk birkaç RSI atomuna
// yığılmaz. Aynı çağrı her zaman aynı adayları üretir (deterministik).
function evenlySample(group, count) {
  if(count>=group.length) return group.slice();
  if(count<=0) return [];
  const out=[];
  for(let i=0;i<count;i++){
    const idx=Math.floor((i*(group.length-1))/Math.max(1,count-1));
    out.push(group[idx]);
  }
  return out;
}

function candidates(maxCandidates,maxComb=3){
 const risks=[{stopLossPct:2,takeProfitPct:4,trailingStop:false},{stopLossPct:3,takeProfitPct:6,trailingStop:false},{stopLossPct:4,takeProfitPct:8,trailingStop:false},{stopLossPct:5,takeProfitPct:10,trailingStop:true}];
 const exits=[{exit:'macd_down',exitMacd:{fast:12,slow:26,signal:9}},{exit:'rsi_overbought',exitRsiPeriod:14,exitRsi:70},{exit:'bb_middle',exitBbPeriod:20,exitBbMult:2}];
 const as=atoms(), combos=[]; for(let k=1;k<=maxComb;k++) combos.push(...choose(as,k));
 const groups=[];
 for(const k of [1,2,3].filter(k=>k<=maxComb)){
   const group=[];
   for(const c of combos.filter(x=>x.length===k)) for(const e of exits) for(const r of risks)
     group.push({complexity:k,name:c.map(x=>x.label).join(' + '),conditions:c,exit:e.exit,exitMacd:e.exitMacd,exitRsiPeriod:e.exitRsiPeriod,exitRsi:e.exitRsi,exitBbPeriod:e.exitBbPeriod,exitBbMult:e.exitBbMult,risk:r});
   groups.push(group);
 }
 const out=[];
 const base=Math.floor(maxCandidates/groups.length), rem=maxCandidates%groups.length;
 groups.forEach((g,i)=>out.push(...evenlySample(g,base+(i<rem?1:0))));
 return out.map((x,i)=>({id:`auto_${i+1}`,...x}));
}

function assertAlignedDatasets(sets, tf) {
  if(!sets.length) throw new Error(`${tf}: sembol yok.`);
  const ref=sets[0].data.candles;
  if(ref.length<20) throw new Error(`${tf}: yeterli mum yok.`);
  for(const x of sets){
    const d=x.data;
    if(!d.candles?.length) throw new Error(`${tf}/${x.symbol}: veri yok.`);
    const step=d.candles.length>1?d.candles[1].t-d.candles[0].t:null;
    if(step!==INTERVAL_MS[tf]) throw new Error(`${tf}/${x.symbol}: zaman adımı beklenenden farklı.`);
    if(d.candles[0].t!==ref[0].t || d.candles[d.candles.length-1].t!==ref[ref.length-1].t) throw new Error(`${tf}: semboller aynı zaman sınırında değil.`);
    for(let i=1;i<d.candles.length;i++) if(d.candles[i].t-d.candles[i-1].t!==step) throw new Error(`${tf}/${x.symbol}: zaman serisinde boşluk var.`);
  }
}

function buildFolds({length,startIndex,months,trainMonths,validationMonths,stepMonths,oosMonths,stepMs}) {
  const end=length-1;
  const oosStart=clamp(end-Math.round(oosMonths*MONTH/stepMs),startIndex+1,end-1);
  const trainBars=Math.round(trainMonths*MONTH/stepMs), valBars=Math.round(validationMonths*MONTH/stepMs), stepBars=Math.round(stepMonths*MONTH/stepMs);
  if(trainBars<1||valBars<1||stepBars<1) throw new Error('Walk-forward pencere boyları geçersiz.');
  const folds=[]; let trainStart=startIndex;
  while(trainStart+trainBars+valBars<=oosStart){
    const trainEnd=trainStart+trainBars;
    const valEnd=trainEnd+valBars;
    if(!(trainStart<trainEnd&&trainEnd<=valEnd&&valEnd<=oosStart)) throw new Error('Geçersiz kronolojik fold.');
    folds.push({trainStart,trainEnd,valEnd}); trainStart+=stepBars;
  }
  if(!folds.length) throw new Error(`${months} aylık pencerede train/validation fold üretilemedi.`);
  return {folds,oosStart};
}

function safeAvg(values){return values.length?values.reduce((s,v)=>s+v,0)/values.length:0;}
function median(values){if(!values.length)return 0;const a=values.slice().sort((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function std(values){if(values.length<2)return 0;const m=safeAvg(values);return Math.sqrt(safeAvg(values.map(v=>(v-m)**2)));}

function aggregate(rows, minTrades=8){
 const returns=rows.map(x=>x.returnPct), scores=[];
 const perSymbol=rows.map(x=>({symbol:x.symbol,returnPct:x.returnPct,trades:x.trades,maxDrawdownPct:x.maxDrawdownPct,profitFactor:x.profitFactor}));
 const pf=rows.map(x=>x.profitFactor).filter(Number.isFinite);
 const tradeCount=rows.reduce((s,x)=>s+x.trades,0);
 const positiveSymbols=rows.filter(x=>x.returnPct>0).length;
 return {
   returnPct:safeAvg(returns), medianReturnPct:median(returns), returnStdPct:std(returns), worstSymbolReturnPct:returns.length?Math.min(...returns):0,
   maxDrawdownPct:safeAvg(rows.map(x=>x.maxDrawdownPct)), worstMaxDrawdownPct:rows.length?Math.min(...rows.map(x=>x.maxDrawdownPct)):0,
   trades:tradeCount, winRatePct:safeAvg(rows.filter(x=>x.winRatePct!=null).map(x=>x.winRatePct)), buyHoldPct:safeAvg(rows.map(x=>x.buyHoldPct)),
   profitFactor:safeAvg(pf), positivePct:rows.length?positiveSymbols/rows.length*100:0,
   minTrades, lowTradePenalty:tradeCount<minTrades,
   perSymbol
 };
}

// Tek bir sayı yerine maliyet sonrası getiri + benchmark farkı + PF + işlem örneklemi +
// DD + semboller arası dayanıklılık + varyans birlikte kullanılır. Ham return tek başına
// aday seçemez. Çok az işlem yapan "şanslı" adaylar sert cezalandırılır.
function score(r){
 if(!r||!Number.isFinite(r.returnPct))return -1e9;
 const pf=Number.isFinite(r.profitFactor)?Math.min(r.profitFactor,4):0;
 const dd=Math.abs(r.maxDrawdownPct);
 const beats=r.returnPct-r.buyHoldPct;
 const tradeFactor=Math.min(r.trades/Math.max(8,r.minTrades||8),1);
 const lowTrade=r.trades<Math.max(3,Math.floor((r.minTrades||8)/2));
 const positive=r.positivePct||0;
 const worst=r.worstSymbolReturnPct||0;
 let s=r.returnPct + beats*.35 + pf*2 + tradeFactor*1.5 - dd*.30 - (r.returnStdPct||0)*.20 + (positive-50)*.025 + Math.min(0,worst)*.15;
 if(r.trades<(r.minTrades||8)) s-=((r.minTrades||8)-r.trades)*1.5;
 if(lowTrade) s-=25;
 return s;
}

function validationRank(rows){
 const scores=rows.map(x=>score(x.validation));
 const avg=safeAvg(scores), med=median(scores), stability=scores.filter(x=>x>0).length/(scores.length||1);
 return med*.55+avg*.30-stdev(scores)*.15+stability*2;
}
function stdev(a){return std(a);}

async function main(){
 const o=parse(process.argv.slice(2)); fs.mkdirSync(o.out,{recursive:true});
 const cache=path.join(o.out,'veri'); const datasets={};
 for(const tf of o.tf)for(const symbol of o.symbols){console.error(`Veri indiriliyor: ${symbol} ${tf}`);datasets[`${symbol}|${tf}`]=await loadCandles({symbol,interval:tf,months:o.months,baseUrl:o.baseUrl,cacheDir:cache,refresh:o.refresh});}
 const cands=candidates(o.maxCandidates,o.maxComb); console.error(`Aday kombinasyon: ${cands.length} (karmaşıklık sınıfları dengeli, deterministik örnekleme)`);
 const report={config:o,candidates:cands.length,timeframes:{},portfolioCompatibility:{compatible:true,requiredBeforeLive:true,model:'shared-cash',reserveCashPct:o.reserveCashPct,maxConcurrentPositions:o.maxConcurrentPositions,budgetPct:o.budgetPct,policy:o.portfolioPolicy}};
 for(const tf of o.tf){
  const sets=o.symbols.map(symbol=>({symbol,data:datasets[`${symbol}|${tf}`]})); assertAlignedDatasets(sets,tf);
  const sample=sets[0].data.candles, stepMs=sample[1].t-sample[0].t;
  const wfConfig=buildFolds({length:sample.length,startIndex:sets[0].data.startIndex,months:o.months,trainMonths:o.trainMonths,validationMonths:o.validationMonths,stepMonths:o.stepMonths,oosMonths:o.oosMonths,stepMs});
  const {folds,oosStart}=wfConfig; const foldReports=[];
  // Her foldda tüm adaylar train'de sıralanır, sonra seçilenler değil TÜM adaylar
  // validation'da değerlendirilir. Böylece validation, train kazananlarının küçük
  // ve yanlı bir alt kümesine dönüşmez. OOS hâlâ tamamen dokunulmamıştır.
  const validationBook=new Map(cands.map(c=>[c.id,{cand:c,folds:[]}]))
  for(const f of folds){
    const trainRows=[];
    for(const cand of cands){
      const s=buildStrategy(cand); const runs=[];
      for(const x of sets){const d=x.data; const r=runBacktest({candles:d.candles,startIndex:Math.max(d.startIndex,f.trainStart),strategy:s,params:s.defaultParams,capital:o.capital,feePct:o.feePct,slippagePct:o.slippagePct}); runs.push({...r,symbol:x.symbol});}
      const agg=aggregate(runs,o.minTrades); trainRows.push({cand,score:score(agg),train:agg});
    }
    trainRows.sort((a,b)=>b.score-a.score);
    for(const item of trainRows){
      const cand=item.cand, s=buildStrategy(cand), runs=[];
      for(const x of sets){const d=x.data;const r=runBacktest({candles:d.candles,startIndex:Math.max(d.startIndex,f.trainEnd),strategy:s,params:cand.risk,capital:o.capital,feePct:o.feePct,slippagePct:o.slippagePct});runs.push({...r,symbol:x.symbol});}
      const validation=aggregate(runs,o.minTrades);
      const portfolioValidation=runPortfolioBacktest({datasets:Object.fromEntries(sets.map(x=>[x.symbol,x.data])),symbols:o.symbols,startIndex:Math.max(...sets.map(x=>x.data.startIndex),f.trainEnd),endIndex:f.valEnd-1,strategy:s,params:cand.risk,capital:o.capital,feePct:o.feePct,slippagePct:o.slippagePct,reserveCashPct:o.reserveCashPct,maxConcurrentPositions:o.maxConcurrentPositions,budgetPct:o.budgetPct,portfolioPolicy:o.portfolioPolicy,pairs:Object.fromEntries(o.symbols.map(symbol=>[symbol,{portfolioClass:o.categoryBySymbol?.[symbol]||'core'}]))});
      validationBook.get(cand.id).folds.push({fold:f,train:item.train,trainScore:item.score,validation,portfolioValidation});
    }
    const top=trainRows[0]; const topVal=validationBook.get(top.cand.id).folds.at(-1).validation;
    foldReports.push({trainStart:f.trainStart,trainEnd:f.trainEnd,valEnd:f.valEnd,selectedByTrain:top.cand,train:top.train,validationOfTrainWinner:topVal,trainScore:top.score});
    console.error(`${tf} fold ${foldReports.length}: ${top.cand.name} | train ${top.train.returnPct.toFixed(2)}% | validation ${topVal.returnPct.toFixed(2)}%`);
  }
  const finalists=[...validationBook.values()].map(x=>{
    const vs=x.folds.map(z=>z.validation), pvs=x.folds.map(z=>z.portfolioValidation), ranks=pvs.map(v=>score({...v,buyHoldPct:0,worstSymbolReturnPct:v.returnPct,positivePct:v.returnPct>0?100:0,minTrades:o.minTrades}));
    return {cand:x.cand,folds:x.folds,validationScore:validationRank(x.folds),portfolioValidationScore:safeAvg(ranks),validationAggregate:{returnPct:safeAvg(vs.map(v=>v.returnPct)),medianReturnPct:median(vs.map(v=>v.returnPct)),positiveFoldPct:vs.length?vs.filter(v=>v.returnPct>0).length/vs.length*100:0,worstFoldReturnPct:vs.length?Math.min(...vs.map(v=>v.returnPct)):0,medianScore:median(ranks),scoreStdPct:std(ranks)},portfolioValidationAggregate:{returnPct:safeAvg(pvs.map(v=>v.returnPct)),medianReturnPct:median(pvs.map(v=>v.returnPct)),positiveFoldPct:pvs.length?pvs.filter(v=>v.returnPct>0).length/pvs.length*100:0,worstFoldReturnPct:pvs.length?Math.min(...pvs.map(v=>v.returnPct)):0,trades:pvs.reduce((s,v)=>s+v.trades,0),maxDrawdownPct:Math.min(...pvs.map(v=>v.maxDrawdownPct)),profitFactor:safeAvg(pvs.map(v=>Number.isFinite(v.profitFactor)?v.profitFactor:0))}};
  }).sort((a,b)=>b.portfolioValidationScore-a.portfolioValidationScore || b.validationScore-a.validationScore);
  const winner=finalists[0];
  // FINAL BLIND OOS: winner only; winner was selected exclusively from validation.
  const oos=[];for(const x of sets){const d=x.data;oos.push({...runBacktest({candles:d.candles,startIndex:Math.max(d.startIndex,oosStart),strategy:buildStrategy(winner.cand),params:winner.cand.risk,capital:o.capital,feePct:o.feePct,slippagePct:o.slippagePct}),symbol:x.symbol});}
  const portfolioOos=runPortfolioBacktest({datasets:Object.fromEntries(sets.map(x=>[x.symbol,x.data])),symbols:o.symbols,startIndex:Math.max(...sets.map(x=>x.data.startIndex),oosStart),endIndex:sample.length-1,strategy:buildStrategy(winner.cand),params:winner.cand.risk,capital:o.capital,feePct:o.feePct,slippagePct:o.slippagePct,reserveCashPct:o.reserveCashPct,maxConcurrentPositions:o.maxConcurrentPositions,budgetPct:o.budgetPct,portfolioPolicy:o.portfolioPolicy,pairs:Object.fromEntries(o.symbols.map(symbol=>[symbol,{portfolioClass:o.categoryBySymbol?.[symbol]||'core'}]))});
  const monteCarlo=bootstrapTradeReturns(portfolioOos.tradeList,o.monteCarlo,0x51a7e);
  const sensitivity=runSensitivity({datasets:Object.fromEntries(sets.map(x=>[x.symbol,x.data])),symbols:o.symbols,startIndex:Math.max(...sets.map(x=>x.data.startIndex),oosStart),endIndex:sample.length-1,candidate:winner.cand,capital:o.capital,feePct:o.feePct,slippagePct:o.slippagePct,reserveCashPct:o.reserveCashPct,maxConcurrentPositions:o.maxConcurrentPositions,budgetPct:o.budgetPct,portfolioPolicy:o.portfolioPolicy,pairs:Object.fromEntries(o.symbols.map(symbol=>[symbol,{portfolioClass:o.categoryBySymbol?.[symbol]||'core'}]))});
  const gate=evaluateGate({oos:portfolioOos,monteCarlo,sensitivity,portfolioConfig:o.portfolioPolicy,minTrades:Math.max(30,o.minTrades*3)});
  report.timeframes[tf]={folds:foldReports,candidateValidationRanking:finalists.slice(0,10).map(x=>({id:x.cand.id,name:x.cand.name,validationScore:x.validationScore,portfolioValidationScore:x.portfolioValidationScore,validationAggregate:x.validationAggregate,portfolioValidationAggregate:x.portfolioValidationAggregate})),finalCandidate:winner.cand,validationScore:winner.validationScore,portfolioValidationScore:winner.portfolioValidationScore,validationSummary:winner.validationAggregate,oosStart,oos:aggregate(oos,o.minTrades),oosBySymbol:oos,portfolioOos,monteCarlo,sensitivity,liveGate:gate};
 }
 const stamp=new Date().toISOString().replace(/[:T]/g,'-').slice(0,16);const file=path.join(o.out,`scanner-${stamp}.json`);fs.writeFileSync(file,JSON.stringify(report,null,2));
 console.log(JSON.stringify({candidates:cands.length,timeframes:Object.fromEntries(Object.entries(report.timeframes).map(([tf,x])=>[tf,{finalCandidate:x.finalCandidate.name,validationScore:x.validationScore,portfolioValidationScore:x.portfolioValidationScore,validationSummary:x.validationSummary,oos:x.oos,portfolioOos:x.portfolioOos,liveGate:x.liveGate}]))},null,2));console.error(`Sonuç: ${file}`);
}

if(require.main===module) main().catch(e=>{console.error('Scanner hata:',e.stack||e.message);process.exit(1);});
module.exports={parse,atoms,candidates,evenlySample,assertAlignedDatasets,buildFolds,aggregate,score,validationRank};
