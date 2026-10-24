const ExchangeAdapter=require('./base');
class MidasAdapter extends ExchangeAdapter{
 constructor(){super();this.id='midas';this.name='Midas';this.quoteAssets=['TRY'];this.capabilities={clientOrderId:false,orderQuery:false,balanceQuery:false,openOrdersQuery:false,userDataStream:false,oco:false,nativeTrailingOco:false,marketOrderBook:false,publicMarketData:false,protectiveStopImplemented:false,liveTradingVerified:false};}
 normalizeSymbol(){throw new Error('Midas için botun kullanabileceği resmî kripto Spot API doğrulanmadı.');}
 async fetchCandles(){throw new Error('Midas API entegrasyonu kapalı: resmî kripto piyasa verisi API sözleşmesi doğrulanmadı.');}
 async fetchTicker(){throw new Error('Midas API entegrasyonu kapalı: resmî kripto piyasa verisi API sözleşmesi doğrulanmadı.');}
 async fetchAllTickers24h(){throw new Error('Midas API entegrasyonu kapalı: resmî kripto piyasa verisi API sözleşmesi doğrulanmadı.');}
 async fetchSymbolRules(){throw new Error('Midas API entegrasyonu kapalı: resmî kripto Spot API doğrulanmadı.');}
 async fetchOrderBook(){throw new Error('Midas API entegrasyonu kapalı: resmî kripto Spot API doğrulanmadı.');}
 async fetchBalance(){throw new Error('Midas canlı işlem entegrasyonu kapalı: resmî API doğrulanmadı.');}
 async fetchOpenOrders(){throw new Error('Midas canlı işlem entegrasyonu kapalı: resmî API doğrulanmadı.');}
 async createMarketOrder(){throw new Error('Midas canlı işlem entegrasyonu kapalı: resmî API doğrulanmadı.');}
 async createStopOrder(){throw new Error('Midas canlı işlem entegrasyonu kapalı: resmî API doğrulanmadı.');}
 async getOrder(){throw new Error('Midas canlı işlem entegrasyonu kapalı: resmî API doğrulanmadı.');}
 async cancelOrder(){throw new Error('Midas canlı işlem entegrasyonu kapalı: resmî API doğrulanmadı.');}
}
module.exports=MidasAdapter;
