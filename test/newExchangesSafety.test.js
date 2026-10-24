const test=require('node:test');const assert=require('node:assert/strict');const {registry,createExchange,listExchanges}=require('../src/exchanges');
const ids=['coinbaseexchange','kraken','bitstamp','okx','okxtr','bybittr','midas'];
test('yeni yedi borsa registry ve panel listesinde görünür',()=>{for(const id of ids){assert.ok(registry[id],`${id} registry'de yok`);assert.ok(listExchanges().some(x=>x.id===id),`${id} listede yok`);assert.equal(createExchange(id).id,id);}});
test('yeni borsaların hiçbiri doğrulanmadan canlı işlem yeteneği ilan etmez (Stage 4: özel API kodu var, kanıt yok)',()=>{for(const id of ids){const ex=createExchange(id);assert.equal(ex.capabilities.liveTradingVerified,false,id);assert.notEqual(ex.capabilities.recoveryByFingerprint,true,id);if(id==='midas'){assert.equal(ex.capabilities.clientOrderId,false,id);assert.equal(ex.capabilities.orderQuery,false,id);}else{assert.equal(ex.capabilities.privateApiImplemented,true,id);assert.equal(ex.capabilities.clientOrderId,true,id);}}});
test('sembol normalizasyonu boş veya biçimsiz sembolleri reddeder',()=>{for(const id of ids.filter(x=>x!=='midas')){const ex=createExchange(id);assert.throws(()=>ex.normalizeSymbol('BTC'),undefined,id);assert.throws(()=>ex.normalizeSymbol(''),undefined,id);}});
test('Midas API doğrulanmadığı için fail-closed davranır',async()=>{const ex=createExchange('midas');await assert.rejects(()=>ex.fetchTicker('BTC/TRY'),/doğrulanmadı/);await assert.rejects(()=>ex.createMarketOrder('BTC/TRY','buy',1),/doğrulanmadı/);});
test('yeni borsalarda anahtarsız özel çağrılar ağ isteği yapmadan reddedilir',async()=>{const old=global.fetch;let calls=0;global.fetch=async()=>{calls++;throw new Error('ağ çağrılmamalı');};try{for(const id of ids.filter(x=>x!=='midas')){const ex=createExchange(id);await assert.rejects(()=>ex.createMarketOrder('BTC/USDT','buy',1,'cid-x'),/API key|passphrase|gerekli/i,id);await assert.rejects(()=>ex.fetchBalance(),/API key|passphrase|gerekli/i,id);}}finally{global.fetch=old;}assert.equal(calls,0);});

test('Kraken BTC sembolünü XBT olarak normalize eder',()=>{
  const ex=createExchange('kraken');
  assert.equal(ex.normalizeSymbol('BTC/USD'),'XBTUSD');
  assert.equal(ex.normalizeSymbol('DOGE/USD'),'XDGUSD');
});

test('Kraken API hata alanı başarılı boş yanıt gibi kabul edilmez',async()=>{
  const ex=createExchange('kraken');
  ex._get=async()=>({error:['EQuery:Unknown asset pair'],result:{}});
  await assert.rejects(()=>ex.fetchTicker('BTC/USD'),/Unknown asset pair/);
});

test('Bybit TR varsayılanı resmî belgedeki Türkiye alan adıdır; global host kabul edilmez',()=>{
  const ex=createExchange('bybittr');
  assert.equal(new URL(ex.baseUrl).hostname,'api.bybit.tr');
  assert.throws(()=>createExchange('bybittr',{baseUrl:'https://api.bybit.com'}),/izin verilen host/);
});

test('OKX TR bölgesel adaptörü varsayılan olarak resmî TR API alan adını kullanır',()=>{
  const ex=createExchange('okxtr');
  assert.equal(new URL(ex.baseUrl).hostname,'tr.okx.com');
});

test('yeni adaptörlerde piyasa verisi yanıtı mock ile doğrulanır, ağ/anahtar gerekmez',async()=>{
  const cases=[
    ['coinbaseexchange','/products/BTC-USD/ticker',{price:'10',bid:'9',ask:'11',volume:'4'}],
    ['kraken','/0/public/Ticker',{error:[],result:{XXBTZUSD:{c:['10'],b:['9'],a:['11'],v:['2','4'],p:['9','10']}}}],
    ['bitstamp','/ticker/btcusd/',{last:'10',bid:'9',ask:'11',volume:'4'}],
    ['okx','/api/v5/market/ticker',{code:'0',data:[{last:'10',bidPx:'9',askPx:'11',vol24h:'4'}]}],
    ['okxtr','/api/v5/market/ticker',{code:'0',data:[{last:'10',bidPx:'9',askPx:'11',vol24h:'4'}]}]
  ];
  for(const [id,path,payload] of cases){
    const ex=createExchange(id); let seen='';
    ex._get=async(p)=>{seen=p;return payload;};
    const symbol=id==='coinbaseexchange'||id==='bitstamp'?'BTC/USD':'BTC/USD';
    const result=await ex.fetchTicker(symbol);
    assert.equal(seen,path,`${id} endpoint`);
    assert.equal(result.price,10,`${id} price`);
    assert.equal(result.bid,9,`${id} bid`);
    assert.equal(result.ask,11,`${id} ask`);
  }
});
