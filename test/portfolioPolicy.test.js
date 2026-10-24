const test=require('node:test'); const assert=require('node:assert/strict');
const {normalizePortfolioPolicy,canOpenPosition}=require('../src/portfolioPolicy');
test('kullanıcı portföy politikasında sayı ve yüzdeleri kendi belirler',()=>{
 const p=normalizePortfolioPolicy({maxPositions:25,reserveCashPct:17,buckets:{core:{label:'İyi',maxPositions:15,maxCapitalPct:55},speculative:{label:'Spek',maxPositions:20,maxCapitalPct:35}}});
 assert.equal(p.maxPositions,25); assert.equal(p.reserveCashPct,17); assert.equal(p.buckets.core.maxPositions,15); assert.equal(p.buckets.speculative.maxPositions,20); assert.equal(p.buckets.core.maxCapitalPct,55);
});
test('kategori sayısı ve sermaye sınırı birlikte uygulanır',()=>{
 const policy={maxPositions:10,reserveCashPct:10,buckets:{core:{maxPositions:2,maxCapitalPct:60},speculative:{maxPositions:5,maxCapitalPct:30}}};
 const pairs={A:{portfolioClass:'speculative'},B:{portfolioClass:'speculative'},C:{portfolioClass:'core'}};
 const positions={A:{costQuote:100},B:{costQuote:100},C:{costQuote:200}};
 assert.equal(canOpenPosition({symbol:'D',pair:pairs.A,positions,pairs,policy,equity:1000,requestedCost:101}).ok,false);
 assert.equal(canOpenPosition({symbol:'E',pair:{portfolioClass:'core'},positions,pairs,policy,equity:1000,requestedCost:100}).ok,true);
});
test('kategori seçilmemiş parite güvenli şekilde ana kategoriye düşer',()=>{ const p=normalizePortfolioPolicy(null); const r=canOpenPosition({symbol:'BTC/USDT',pair:{},positions:{},pairs:{'BTC/USDT':{}},policy:p,equity:1000,requestedCost:100}); assert.equal(r.bucket,'core'); });
