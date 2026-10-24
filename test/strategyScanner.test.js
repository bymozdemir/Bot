const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildStrategy } = require('../src/backtest/combinationStrategy');
const { parse } = require('../src/backtest/strategyScanner');

test('automatic combination strategy has bounded deterministic risk params', () => {
  const candidate = {
    id:'t', name:'RSI + EMA',
    conditions:[{type:'rsi_oversold',period:14,level:30,label:'RSI14<30'},{type:'ema_trend',period:200,bufferPct:0,label:'fiyat>EMA200'}],
    exit:'rsi_overbought', exitRsiPeriod:14, exitRsi:70,
    risk:{stopLossPct:3,takeProfitPct:6,trailingStop:false}
  };
  const s=buildStrategy(candidate);
  assert.equal(s.defaultParams.stopLossPct,3);
  assert.equal(s.defaultParams.takeProfitPct,6);
  assert.equal(s.minCandles({})>=50,true);
});

test('combination strategy does not buy until every AND condition passes', () => {
  const candidate={id:'t',name:'x',conditions:[{type:'price_sma',period:3,bufferPct:0,label:'SMA3'},{type:'ema_trend',period:3,bufferPct:0,label:'EMA3'}],exit:'rsi_overbought',exitRsiPeriod:14,exitRsi:70,risk:{stopLossPct:3,takeProfitPct:6,trailingStop:false}};
  const s=buildStrategy(candidate);
  const candles=Array.from({length:60},(_,i)=>{const c=1+i*0.01;return {t:i,o:c,h:c*1.01,l:c*.99,c,v:1};});
  const d=s.evaluate({candles,position:null,params:s.defaultParams});
  assert.ok(['buy','hold'].includes(d.action));
  assert.equal(d.action,'buy');
});

const scanner = require('../src/backtest/strategyScanner');

test('scanner aday örneklemesi deterministik ve üç karmaşıklık sınıfını dengeli kapsar', () => {
  const a = scanner.candidates(180);
  const b = scanner.candidates(180);
  assert.deepEqual(a, b);
  assert.equal(a.length, 180);
  assert.ok(a.some(x => x.complexity === 1));
  assert.ok(a.some(x => x.complexity === 2));
  assert.ok(a.some(x => x.complexity === 3));
  assert.ok(new Set(a.map(x => x.conditions.map(c => c.type).join('|'))).size > 20);
});

test('scanner 12/24/60 ay pencerelerini kabul eder, gereksiz 60 ay kilidi yoktur', () => {
  for (const months of [12,24,60]) {
    const o = scanner.parse(['--months', String(months), '--train-months', '4', '--validation-months', '4', '--oos-months', '4']);
    assert.equal(o.months, months);
  }
});

test('scanner walk-forward foldları kronolojik, çakışmasız ve blind OOS öncesinde biter', () => {
  const r = scanner.buildFolds({length: 17500,startIndex:300,months:24,trainMonths:8,validationMonths:4,stepMonths:4,oosMonths:4,stepMs:3600000});
  assert.ok(r.folds.length >= 1);
  for (let i=0;i<r.folds.length;i++) {
    const f=r.folds[i];
    assert.ok(f.trainStart < f.trainEnd);
    assert.ok(f.trainEnd <= f.valEnd);
    assert.ok(f.valEnd <= r.oosStart);
    if (i) assert.ok(r.folds[i-1].trainStart < f.trainStart);
  }
  assert.ok(r.folds.at(-1).valEnd <= r.oosStart);
});

test('scanner maliyet sonrası dayanıklılık skoru az işlemli şanslı adayı cezalandırır', () => {
  const low = scanner.aggregate([
    {symbol:'A',returnPct:30,buyHoldPct:0,maxDrawdownPct:-2,trades:1,winRatePct:100,profitFactor:10},
    {symbol:'B',returnPct:30,buyHoldPct:0,maxDrawdownPct:-2,trades:1,winRatePct:100,profitFactor:10},
    {symbol:'C',returnPct:30,buyHoldPct:0,maxDrawdownPct:-2,trades:1,winRatePct:100,profitFactor:10}
  ], 8);
  const robust = scanner.aggregate([
    {symbol:'A',returnPct:12,buyHoldPct:0,maxDrawdownPct:-6,trades:30,winRatePct:55,profitFactor:1.8},
    {symbol:'B',returnPct:10,buyHoldPct:0,maxDrawdownPct:-7,trades:28,winRatePct:54,profitFactor:1.7},
    {symbol:'C',returnPct:8,buyHoldPct:0,maxDrawdownPct:-8,trades:25,winRatePct:52,profitFactor:1.6}
  ], 8);
  assert.ok(scanner.score(robust) > scanner.score(low));
});

test('scanner veri hizası bozulduğunda sessizce devam etmez', () => {
  const good = {symbol:'A',data:{candles:Array.from({length:20},(_,i)=>({t:i*3600000})),startIndex:0}};
  const bad = {symbol:'B',data:{candles:Array.from({length:20},(_,i)=>({t:i===10?11*3600000:i*3600000})),startIndex:0}};
  assert.throws(() => scanner.assertAlignedDatasets([good,bad],'1h'), /zaman serisinde boşluk/);
});

test('scanner ortak portföy ve Monte Carlo parametrelerini parse eder', () => {
  const o = scanner.parse(['--months','60','--reserve','10','--max-positions','3','--budget','30','--mc','500']);
  assert.equal(o.reserveCashPct,10); assert.equal(o.maxConcurrentPositions,3); assert.equal(o.budgetPct,30); assert.equal(o.monteCarlo,500);
});

test('scanner kullanıcı tanımlı portföy politikası ve kategori eşlemesini kabul eder',()=>{
 const o=parse(['--policy-json','{"maxPositions":25,"reserveCashPct":12,"buckets":{"core":{"maxPositions":15,"maxCapitalPct":60},"speculative":{"maxPositions":20,"maxCapitalPct":28}}}','--categories-json','{"AAA/USDT":"speculative","BBB/USDT":"core"}']);
 assert.equal(o.portfolioPolicy.maxPositions,25); assert.equal(o.portfolioPolicy.buckets.speculative.maxPositions,20); assert.equal(o.categoryBySymbol['AAA/USDT'],'speculative');
});
