'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchWithRetry } = require('../src/util/retry');
const { runPortfolioBacktest } = require('../src/backtest/portfolioSimulator');
const bars = () => Array.from({length:12},(_,i)=>({t:1700000000000+i*3600000,o:100,h:101,l:99,c:100,v:10}));
const strategy = {defaultParams:{},minCandles:()=>2,evaluate:()=>({action:'hold'})};
function run(datasets, extra={}) { return runPortfolioBacktest({datasets,symbols:Object.keys(datasets),strategy,...extra}); }
test('portfolio accepts bare arrays and does not mutate caller',()=>{
 const a=bars(); const before=JSON.stringify(a);
 assert.equal(run({A:a}).finalEquity,1000);
 assert.equal(JSON.stringify(a),before);
});
test('portfolio rejects timestamp mismatch, duplicate bars and invalid OHLC',()=>{
 let a=bars(), b=bars(); b[4].t+=1;
 assert.throws(()=>run({A:{candles:a},B:{candles:b}}),/eşzamanlı/);
 a=bars(); a[3].t=a[2].t;
 assert.throws(()=>run({A:a}),/sıralı/);
 a=bars(); a[4].c=NaN;
 assert.throws(()=>run({A:a}),/OHLC/);
 a=bars(); a[4].h=90;
 assert.throws(()=>run({A:a}),/OHLC/);
});
test('portfolio rejects invalid financial inputs and window bounds',()=>{
 for(const extra of [{capital:-1},{feePct:-1},{slippagePct:NaN},{startIndex:-1},{endIndex:2.5}]) assert.throws(()=>run({A:bars()},extra));
});
for (const status of [302,307,308]) test(`HTTP ${status} cannot forward credentials or replay an order`,async()=>{
 let targetCalls=0;
 const srv=http.createServer((req,res)=>{
  if(req.url==='/target'){targetCalls++;res.end('{}');return;}
  res.writeHead(status,{location:'/target'});res.end();
 });
 await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
 try {
  await assert.rejects(fetchWithRetry(`http://127.0.0.1:${srv.address().port}/source`,{method:'POST',headers:{'X-MBX-APIKEY':'dummy-test-key'},body:'order=test',redirect:'follow'},{retries:0,timeoutMs:1000}));
  assert.equal(targetCalls,0);
 } finally {srv.closeAllConnections?.();await new Promise(resolve=>srv.close(resolve));}
});
