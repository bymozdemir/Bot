// Shared-cash portfolio simulator for strategy validation.
// Unlike runBacktest(), this simulates the bot's portfolio constraints:
// one quote cash pool, reserve cash, max concurrent positions, per-pair budget caps.
// Doldurma kurali: sinyal KAPANISTA uretilir, emir bir SONRAKI mumun ACILISINDA (kayma+komisyonla) dolar.
const { candleLimit } = require('../strategies');
const { buyFill, sellFill, intrabarRiskExit, breakEvenBufferPct } = require('../execution');
const { normalizePortfolioPolicy, canOpenPosition } = require('../portfolioPolicy');

function maxDrawdownPct(series, start) {
  let peak = start, worst = 0;
  for (const v of series) { if (v > peak) peak = v; const dd=(v/peak-1)*100; if(dd<worst)worst=dd; }
  return worst;
}

function runPortfolioBacktest({ datasets, symbols, startIndex=0, endIndex, strategy, params={}, capital=1000, feePct=0.1, slippagePct=0.05, reserveCashPct=10, maxConcurrentPositions=3, budgetPct=30, initialCashBySymbol=null, portfolioPolicy=null, pairs=null, categoryBySymbol=null }) {
  if (!datasets || !symbols?.length) throw new Error('Portföy testi için sembol verisi gerekli.');
  // Normalize without mutating caller data; all execution paths use { candles }.
  datasets = Object.fromEntries(symbols.map(symbol => [symbol, {
    candles: Array.isArray(datasets[symbol]) ? datasets[symbol] : datasets[symbol]?.candles
  }]));
  const first = datasets[symbols[0]]?.candles;
  if (!Array.isArray(first) || !first.length) throw new Error('Portföy testi için veri yok.');
  const end = endIndex == null ? first.length - 1 : endIndex;
  if (!Number.isInteger(startIndex) || startIndex < 0 || !Number.isInteger(end) || end <= startIndex) throw new Error('Portföy test penceresi geçersiz.');
  if (!Number.isFinite(capital) || capital <= 0 || !Number.isFinite(feePct) || feePct < 0 || feePct >= 100 || !Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct >= 100) throw new Error('Portföy sermaye/komisyon/kayma geçersiz.');
  for (const symbol of symbols) {
    const cs = datasets[symbol].candles;
    if (!Array.isArray(cs) || cs.length <= end) throw new Error(`${symbol}: portföy penceresi dışında.`);
    // Index-based portfolio valuation requires synchronized, strictly ordered bars.
    // Include warmup bars: corrupt warmup data also corrupts indicator signals.
    for (let i = 0; i <= end; i++) {
      const c = cs[i];
      if (!c || !Number.isFinite(c.t) || (i > 0 && c.t <= cs[i-1].t) || c.t !== first[i]?.t) throw new Error(`${symbol}: mum zamanları sıralı/eşzamanlı değil (${i}).`);
      if (!['o','h','l','c'].every(k => Number.isFinite(c[k]) && c[k] > 0) || c.h < Math.max(c.o,c.c) || c.l > Math.min(c.o,c.c) || c.l > c.h) throw new Error(`${symbol}: geçersiz OHLC (${i}).`);
    }
  }
  const policy=normalizePortfolioPolicy(portfolioPolicy || {maxPositions:maxConcurrentPositions,reserveCashPct,buckets:{core:{maxPositions:0,maxCapitalPct:100},speculative:{maxPositions:0,maxCapitalPct:100}}});
  const pairMap=pairs || Object.fromEntries(symbols.map(symbol=>[symbol,{portfolioClass:categoryBySymbol?.[symbol]||'core'}]));
  maxConcurrentPositions=policy.maxPositions; reserveCashPct=policy.reserveCashPct;
  const fee=feePct/100, slip=slippagePct/100;
  const p={...strategy.defaultParams,...params};
  const limit=candleLimit(strategy,p);
  let cash=capital;
  const positions={};
  const trades=[];
  let feesPaid=0, slipCost=0;
  const equity=[];
  const signalCount={};
  const openCount={};

  // Use the same conservative estimated liquidation equity as Paper risk gates:
  // open positions are valued after exit slippage and exit fee, cash is already net.
  const mark=(i)=>cash+Object.values(positions).reduce((sum,pos)=>{ const px=Number(datasets[pos.symbol].candles[i].c); if(!(px>0)) return sum; const exitFill=sellFill(px,slippagePct); return sum+pos.quantity*exitFill*(1-fee); },0);
  const close=(symbol,ref,i,reason,forced=false)=>{
    const pos=positions[symbol]; if(!pos)return false;
    const fill=sellFill(ref,slippagePct), gross=pos.quantity*fill, feeAmt=gross*fee, net=gross-feeAmt;
    if(!Number.isFinite(net)||net<0)return false;
    feesPaid+=feeAmt; slipCost+=(ref-fill)*pos.quantity;
    const pnl=net-pos.cost;
    trades.push({symbol,openedAt:pos.openedAt,closedAt:datasets[symbol].candles[i].t,entryPrice:pos.entryPrice,exitPrice:fill,pnl,pnlPct:pnl/pos.cost*100,bars:i-pos.openedIndex,reason,forced});
    cash+=net; delete positions[symbol]; return true;
  };
  // Alim butcesi paper motoruyla (src/paperEngine.js tryBuy) ayni mantiktadir: butce, KALAN NAKDIN degil
  // portfoy ozkaynaginin yuzdesidir; rezerv de ozkaynaktan hesaplanir. Eskiden nakdin yuzdesi alindigi icin
  // ayni portfoyde sirayla acilan pozisyonlar 30 -> 21 -> 14.7 seklinde kuculuyor, paper ile tutarsiz sonuc veriyordu.
  const open=(symbol,ref,i,reason,suggestedStopDistance)=>{
    if(positions[symbol] || Object.keys(positions).length>=maxConcurrentPositions)return false;
    // Emir mumun ACILISINDA dolar; o anda bilinen son deger bir onceki kapanistir (ileriye bakma yok).
    const equityNow=mark(Math.max(startIndex,i-1));
    // Paper budget uses the day-start equity as its budget/reserve base; this backtest window has no day rollover.
    const budgetBase=capital;
    const spendable=Math.max(0,cash-budgetBase*(reserveCashPct/100));
    const budget=Math.min(spendable,budgetBase*(budgetPct/100));
    if(!(budget>0))return false;
    const policyCheck=canOpenPosition({symbol,pair:pairMap[symbol],positions,pairs:pairMap,policy,equity:equityNow,requestedCost:budget});
    if(!policyCheck.ok)return false;
    const fill=buyFill(ref,slippagePct), quantity=budget/(fill*(1+fee)), feeAmt=quantity*fill*fee;
    if(!Number.isFinite(quantity)||quantity<=0)return false;
    feesPaid+=feeAmt; slipCost+=(fill-ref)*quantity;
    const pctStop=Number.isFinite(Number(p.stopLossPct))?fill*(1-Number(p.stopLossPct)/100):null;
    const d=Number(suggestedStopDistance); const strategyStop=Number.isFinite(d)&&d>0?fill-d:null;
    const stopPrice=Number.isFinite(pctStop)&&Number.isFinite(strategyStop)?Math.max(pctStop,strategyStop):(Number.isFinite(pctStop)?pctStop:strategyStop);
    positions[symbol]={symbol,entryPrice:fill,quantity,cost:budget,stopPrice,highWaterMark:fill,breakEvenBufferPct:breakEvenBufferPct(feePct,slippagePct),openedIndex:i,openedAt:datasets[symbol].candles[i].t,reason};
    cash-=budget; return true;
  };

  const sortedSymbols=symbols.slice().sort();
  let pending={}; // symbol -> {action,reason}: onceki KAPANISTA verilen emirler, bu mumun ACILISINDA dolar
  for(let i=startIndex;i<=end;i++){
    // 1) Onceki kapanista verilen emirler bu mumun acilisinda dolar (tek-parite backtest ve paper motoruyla ayni kural).
    //    Once satislar (nakit serbest kalir), sonra alimlar; sembol sirasi deterministiktir.
    for(const symbol of sortedSymbols){
      const o=pending[symbol]; if(!o||o.action!=='sell'||!positions[symbol])continue;
      close(symbol,datasets[symbol].candles[i].o,i,o.reason);
    }
    for(const symbol of sortedSymbols){
      const o=pending[symbol]; if(!o||o.action!=='buy'||positions[symbol])continue;
      open(symbol,datasets[symbol].candles[i].o,i,o.reason,o.suggestedStopDistance);
    }
    pending={};
    // 2) Mum ici risk cikislari (stop / kar koruma / trailing). Yeni acilan pozisyon da ayni mumda taranir (kotu senaryo).
    for(const symbol of Object.keys(positions)){
      const c=datasets[symbol].candles[i];
      const hit=intrabarRiskExit(positions[symbol],c,p,true);
      if(hit) close(symbol,hit.ref,i,hit.reason);
    }
    // 3) Kapanista sinyal uret; emir bir SONRAKI mumun acilisinda dolacak. Son mumda yeni emir verilmez.
    if(i<end){
      for(const symbol of sortedSymbols){
        const cs=datasets[symbol].candles;
        const window=cs.slice(Math.max(0,i+1-limit),i+1);
        if(window.length<strategy.minCandles(p)) continue;
        const pos=positions[symbol]||null;
        const view=pos?{entryPrice:pos.entryPrice,quantity:pos.quantity,stopPrice:pos.stopPrice,highWaterMark:pos.highWaterMark,breakEvenBufferPct:pos.breakEvenBufferPct}:null;
        const d=strategy.evaluate({candles:window,position:view,params:p});
        signalCount[symbol]=(signalCount[symbol]||0)+(d.action==='buy'?1:0);
        if(d.action==='sell'&&pos) pending[symbol]={action:'sell',reason:d.reason};
        else if(d.action==='buy'&&!pos) pending[symbol]={action:'buy',reason:d.reason,suggestedStopDistance:d.suggestedStopDistance};
      }
    }
    equity.push(mark(i));
    openCount[i]=Object.keys(positions).length;
  }
  for(const symbol of Object.keys(positions)) close(symbol,datasets[symbol].candles[end].c,end,'test sonu (açık pozisyon kapatıldı)',true);
  equity[equity.length-1]=cash;
  const wins=trades.filter(t=>t.pnl>0), losses=trades.filter(t=>t.pnl<=0);
  const grossWin=wins.reduce((s,t)=>s+t.pnl,0), grossLoss=-losses.reduce((s,t)=>s+t.pnl,0);
  const bh={}, bhGross={};
  for(const symbol of symbols){
    const cs=datasets[symbol].candles;
    const a=Number(cs[startIndex].o), b=Number(cs[end].c);
    // Ham fiyat getirisi ayri tutulur; karsilastirmada stratejiyle ayni fee/slippage uygulanir.
    if(Number.isFinite(a)&&a>0&&Number.isFinite(b)&&b>0){
      bhGross[symbol]=(b/a-1)*100;
      const buyPrice=a*(1+slip), sellPrice=b*(1-slip);
      const qty=1/(buyPrice*(1+fee));
      const netProceeds=qty*sellPrice*(1-fee);
      bh[symbol]=(netProceeds-1)*100;
    } else { bhGross[symbol]=null; bh[symbol]=null; }
  }
  return {
    capital,finalEquity:cash,returnPct:(cash/capital-1)*100,maxDrawdownPct:maxDrawdownPct(equity,capital),
    trades:trades.length,winRatePct:trades.length?wins.length/trades.length*100:null,profitFactor:grossLoss>0?grossWin/grossLoss:null,
    avgTradePct:trades.length?trades.reduce((s,t)=>s+t.pnlPct,0)/trades.length:null,worstTradePct:trades.length?Math.min(...trades.map(t=>t.pnlPct)):null,
    feesPct:feesPaid/capital*100,slippagePct:slipCost/capital*100,positiveTradePct:trades.length?wins.length/trades.length*100:0,
    symbols:symbols.slice(),buyHoldBySymbol:bh,buyHoldBySymbolGrossPct:bhGross,signalCount,tradeList:trades,equity,peakOpenPositions:Math.max(0,...Object.values(openCount)),
    constraints:{reserveCashPct,maxConcurrentPositions,budgetPct,policy}
  };
}

module.exports={runPortfolioBacktest,maxDrawdownPct};
