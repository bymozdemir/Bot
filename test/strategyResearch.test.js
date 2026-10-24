const test = require('node:test');
const assert = require('node:assert/strict');
const { INTERVAL_MS } = require('../src/backtest/data');
const { atoms, parse } = require('../src/backtest/strategyScanner');
const { buildStrategy } = require('../src/backtest/combinationStrategy');

test('research mum aralıkları: Binance sabit aralıklı 1m-1w listesi kapsanır', () => {
  for (const tf of ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w']) {
    assert.ok(INTERVAL_MS[tf] > 0, `${tf} tanımlı değil`);
  }
  assert.equal(INTERVAL_MS['1m'], 60_000);
  assert.equal(INTERVAL_MS['3m'], 180_000);
  assert.equal(INTERVAL_MS['1w'], 604_800_000);
});

test('strateji tarayıcısı EMA kesişimi ve ADX trend gücü koşulları üretir', () => {
  const a = atoms();
  assert.ok(a.some(x => x.type === 'ema_cross' && x.fast === 9 && x.slow === 21));
  assert.ok(a.some(x => x.type === 'adx_min' && x.period === 14 && x.level === 20));
});

test('scanner yeni 1m/3m/5m aralıklarını geçerli kabul eder', () => {
  for (const tf of ['1m','3m','5m','15m','1h','4h','1d','1w']) {
    const parsed = parse(['--tf', tf, '--months','16','--train-months','8','--validation-months','4','--oos-months','4']);
    assert.deepEqual(parsed.tf, [tf]);
  }
});

test('ADX koşulu yeterli trend verisiyle hesaplanır, yetersiz veride güvenli hold döner', () => {
  const candidate = { id:'test-adx', name:'ADX test', conditions:[{type:'adx_min',period:14,level:20,label:'ADX>=20'}], risk:{stopLossPct:2,takeProfitPct:4,trailingStop:false}, exit:'macd_down' };
  const strategy = buildStrategy(candidate);
  const short = Array.from({length:20}, (_,i) => ({t:i*60000,o:100+i,h:102+i,l:99+i,c:101+i,v:10}));
  assert.equal(strategy.evaluate({candles:short,position:null,params:strategy.defaultParams}).action, 'hold');
  const trend = Array.from({length:100}, (_,i) => ({t:i*60000,o:100+i,h:102+i,l:99+i,c:101+i,v:10}));
  assert.doesNotThrow(() => strategy.evaluate({candles:trend,position:null,params:strategy.defaultParams}));
});
