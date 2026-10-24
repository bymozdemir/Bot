const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../src/strategies');
const s = strategies.get('aggressive_breakout');
const base = Date.now() - 300 * 3600000;
function candles(n, fn) { return Array.from({length:n},(_,i)=>({t:base+i*3600000,...fn(i)})); }
test('aggressive strategy registered with bounded params and risk exits',()=>{
  assert.ok(strategies.list().some(x=>x.id==='aggressive_breakout'));
  assert.equal(strategies.validateParams(s.id,{...s.defaultParams}),null);
  assert.match(strategies.validateParams(s.id,{...s.defaultParams,rsiMin:80,rsiMax:70}),/RSI/);
  const d=s.evaluate({candles:candles(3,i=>({o:100,h:100,l:100,c:50,v:1})),position:{entryPrice:100,stopPrice:97,highWaterMark:100,quantity:1},params:s.defaultParams});
  assert.equal(d.action,'sell');
});
test('aggressive strategy does not buy without breakout and volume confirmation',()=>{
  const cs=candles(100,i=>{const c=100+i*.05;return {o:c,h:c+.2,l:c-.2,c,v:10};});
  const d=s.evaluate({candles:cs,position:null,params:s.defaultParams});
  assert.equal(d.action,'hold');
});

test('aggressive breakout supplies an ATR-aware initial stop distance on a valid buy signal', () => {
  const cs = [];
  let close = 100;
  const base = Date.now() - 200 * 3600000;
  for (let i = 0; i < 100; i++) {
    const change = i % 3 === 0 ? -0.003 : 0.001;
    const open = close;
    close *= 1 + change;
    cs.push({ t: base + i * 3600000, o: open, h: Math.max(open, close) * 1.0005, l: Math.min(open, close) * 0.9995, c: close, v: 10 });
  }
  const priorHigh = Math.max(...cs.slice(79, 99).map(c => c.h));
  const last = cs[99];
  last.c = priorHigh * 1.003;
  last.h = last.c * 1.0005;
  last.l = last.c * 0.9995;
  last.v = 20;
  const d = s.evaluate({ candles: cs, position: null, params: s.defaultParams });
  assert.equal(d.action, 'buy');
  assert.ok(Number.isFinite(d.suggestedStopDistance));
  assert.ok(d.suggestedStopDistance > 0);
  assert.ok(d.suggestedStopPrice < d.price);
});
