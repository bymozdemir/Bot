const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BinanceUserDataStream } = require('../src/userDataStream');
const ex = { createUserDataStreamSignature: () => ({}), getUserDataWsUrl: () => 'ws://x' };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function round(i) {
 const sockets=[];
 class FakeWS extends EventEmitter {
  constructor(){super();this.n=sockets.length;sockets.push(this);this.closed=false;setImmediate(()=>this.emit('open'));}
  send(data){const id=JSON.parse(data).id;setImmediate(()=>this.emit('message',JSON.stringify({id,status:200,result:{subscriptionId:this.n}})));}
  close(){if(this.closed)return;this.closed=true;setTimeout(()=>this.emit('close'), 15 + (i%5)*5);}
  terminate(){this.close();}
 }
 const st = new BinanceUserDataStream({exchange:ex,orderManager:{applyExecutionReport(){}},state:{},store:{save(){}},WebSocketImpl:FakeWS,reconnectMs:2,subscribeTimeoutMs:200});
 await st.start();
 st.ws.emit('message',JSON.stringify({event:{e:'eventStreamTerminated',E:i+1}}));
 await wait(50);
 const open=sockets.filter(s=>!s.closed);
 assert.equal(open.length,1,`round ${i}: expected one live socket; open=${open.length}, total=${sockets.length}`);
 assert.equal(st.ws,open[0],`round ${i}: current socket mismatch`);
 await st.stop();
 await wait(2);
 assert.equal(sockets.filter(s=>!s.closed).length,0,`round ${i}: leaked socket`);
}
(async()=>{for(let i=1;i<=100;i++)await round(i); console.log('PASS: 100 race stress iterations; zero failures, zero leaked sockets');})().catch(e=>{console.error(e);process.exitCode=1;});
