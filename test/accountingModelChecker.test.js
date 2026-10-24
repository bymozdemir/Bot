const test = require('node:test');
const assert = require('node:assert/strict');
const {
  netBaseReceived,
  netQuoteFlow,
  positionReductionOnSell,
  proportionalCostBasis,
  realizedPnl,
  totalThirdAssetCommission
} = require('../src/financial');

const EPS = 1e-9;
const ASSETS = ['USDT', 'BTC', 'BNB'];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
}

function approx(a, b, eps = EPS) {
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)), `expected ${a} ~= ${b}`);
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// Bağımsız defter: üretim financial.js fonksiyonlarını kullanmaz.
function applyFill(ledger, fill) {
  const { side, qty, price, feeAsset, fee } = fill;
  const grossQuote = qty * price;
  const baseFee = feeAsset === 'BTC' ? fee : 0;
  const quoteFee = feeAsset === 'USDT' ? fee : 0;

  ledger.BTC = ledger.BTC || 0;
  ledger.USDT = ledger.USDT || 0;
  ledger.BNB = ledger.BNB || 0;

  if (side === 'buy') {
    ledger.USDT -= grossQuote + quoteFee;
    ledger.BTC += qty - baseFee;
  } else {
    ledger.BTC -= qty + baseFee;
    ledger.USDT += grossQuote - quoteFee;
  }
  if (feeAsset === 'BNB') ledger.BNB -= fee;

  return ledger;
}

function equity(ledger, prices) {
  return ledger.USDT + ledger.BTC * prices.BTCUSDT + ledger.BNB * prices.BNBUSDT;
}

function makeFill(r, side, price) {
  const qty = 0.001 + r() * 0.05;
  const feeMode = Math.floor(r() * 3);
  const feeRate = 0.0005 + r() * 0.0015;
  let feeAsset = feeMode === 0 ? 'USDT' : feeMode === 1 ? 'BTC' : 'BNB';
  let fee = side === 'buy' && feeAsset === 'BTC'
    ? qty * feeRate
    : side === 'sell' && feeAsset === 'BTC'
      ? qty * feeRate
      : qty * price * feeRate;
  if (feeAsset === 'BNB') fee /= (300 + r() * 100);
  return { side, qty, price, feeAsset, fee };
}

function positionApplyIndependent(position, fill) {
  const gross = fill.qty;
  const baseFee = fill.feeAsset === 'BTC' ? fill.fee : 0;
  if (fill.side === 'buy') {
    const received = gross - baseFee;
    const quoteCost = gross * fill.price + (fill.feeAsset === 'USDT' ? fill.fee : 0);
    const oldQty = position.quantity;
    const oldCost = position.costQuote;
    position.quantity += received;
    position.costQuote += quoteCost;
    if (position.quantity > 0) position.entryPrice = position.costQuote / position.quantity;
    return { kind: 'buy', gross, received, quoteCost, baseFee };
  }

  const outflow = gross + baseFee;
  const sold = Math.min(position.quantity, gross);
  const actualOutflow = Math.min(position.quantity, outflow);
  const costBasis = position.quantity > 0 ? position.costQuote * (actualOutflow / position.quantity) : 0;
  const quoteProceeds = Math.max(0, gross * fill.price - (fill.feeAsset === 'USDT' ? fill.fee : 0)
    - (fill.feeAsset === 'BNB' ? fill.fee * 350 : 0));
  const pnl = quoteProceeds - costBasis;
  position.quantity = Math.max(0, position.quantity - actualOutflow);
  position.costQuote = Math.max(0, position.costQuote - costBasis);
  if (position.quantity === 0) position.entryPrice = 0;
  else position.entryPrice = position.costQuote / position.quantity;
  return { kind: 'sell', gross, sold, actualOutflow, costBasis, quoteProceeds, pnl, baseFee };
}

test('accounting model checker: base/quote/third-asset commission formulas conserve balances', () => {
  const prices = { BTCUSDT: 50000, BNBUSDT: 350 };
  const scenarios = [
    { side: 'buy', qty: 0.01, price: 50000, feeAsset: 'USDT', fee: 0.5 },
    { side: 'buy', qty: 0.01, price: 50000, feeAsset: 'BTC', fee: 0.00001 },
    { side: 'buy', qty: 0.01, price: 50000, feeAsset: 'BNB', fee: 0.05 },
    { side: 'sell', qty: 0.01, price: 51000, feeAsset: 'USDT', fee: 0.51 },
    { side: 'sell', qty: 0.01, price: 51000, feeAsset: 'BTC', fee: 0.00001 },
    { side: 'sell', qty: 0.01, price: 51000, feeAsset: 'BNB', fee: 0.05 }
  ];

  for (const f of scenarios) {
    const commission = { byAsset: { [f.feeAsset]: f.fee } };
    const grossQuote = f.qty * f.price;
    const independent = clone({ USDT: 1000, BTC: 1, BNB: 1 });
    const expected = clone(independent);
    applyFill(expected, f);

    const netBase = netBaseReceived(f.side, f.qty, 'BTC', commission);
    const netQuote = netQuoteFlow(f.side, grossQuote, 'USDT', commission);
    if (f.side === 'buy') {
      approx(netBase, f.qty - (f.feeAsset === 'BTC' ? f.fee : 0));
      approx(netQuote, grossQuote + (f.feeAsset === 'USDT' ? f.fee : 0));
    } else {
      approx(netBase, f.qty);
      approx(netQuote, grossQuote - (f.feeAsset === 'USDT' ? f.fee : 0));
      approx(positionReductionOnSell(f.qty, f.feeAsset === 'BTC' ? f.fee : 0), f.qty + (f.feeAsset === 'BTC' ? f.fee : 0));
    }

    const valuationPrices = { BTCUSDT: f.price, BNBUSDT: prices.BNBUSDT };
    const before = equity(independent, valuationPrices);
    const after = equity(expected, valuationPrices);
    const expectedFeeValue = f.feeAsset === 'USDT' ? f.fee : f.feeAsset === 'BTC' ? f.fee * f.price : f.fee * prices.BNBUSDT;
    approx(before - after, expectedFeeValue, 1e-8);
  }
});

test('accounting model checker: 50000 rastgele fill dizisinde bakiye ve pozisyon invariantları', () => {
  const r = rng(0xA11C0DE);
  let checked = 0;
  for (let trial = 0; trial < 50000; trial++) {
    const ledger = { USDT: 10000, BTC: 0.2, BNB: 2 };
    const position = { quantity: 0.2, costQuote: 8000, entryPrice: 40000 };
    let minUSDT = ledger.USDT, minBTC = ledger.BTC, minBNB = ledger.BNB;
    const count = 1 + Math.floor(r() * 12);

    for (let i = 0; i < count; i++) {
      const side = r() < 0.5 ? 'buy' : 'sell';
      const price = 30000 + r() * 50000;
      const fill = makeFill(r, side, price);

      // İşlemi gerçek bir hesap gibi sadece yeterli bakiye varsa uygula.
      const grossQuote = fill.qty * fill.price;
      const quoteNeed = side === 'buy' ? grossQuote + (fill.feeAsset === 'USDT' ? fill.fee : 0) : 0;
      const baseNeed = side === 'sell' ? fill.qty + (fill.feeAsset === 'BTC' ? fill.fee : 0) : 0;
      const feeNeed = fill.feeAsset === 'BNB' ? fill.fee : 0;
      if (ledger.USDT + EPS < quoteNeed || ledger.BTC + EPS < baseNeed || ledger.BNB + EPS < feeNeed) continue;

      const before = clone(ledger);
      applyFill(ledger, fill);
      const result = positionApplyIndependent(position, fill);

      minUSDT = Math.min(minUSDT, ledger.USDT);
      minBTC = Math.min(minBTC, ledger.BTC);
      minBNB = Math.min(minBNB, ledger.BNB);

      assert.ok(Number.isFinite(ledger.USDT) && Number.isFinite(ledger.BTC) && Number.isFinite(ledger.BNB));
      assert.ok(ledger.USDT >= -EPS, `negative USDT trial=${trial}`);
      assert.ok(ledger.BTC >= -EPS, `negative BTC trial=${trial}`);
      assert.ok(ledger.BNB >= -EPS, `negative BNB trial=${trial}`);
      assert.ok(position.quantity >= -EPS, `negative position trial=${trial}`);
      assert.ok(position.costQuote >= -EPS, `negative cost basis trial=${trial}`);
      assert.ok(result.pnl === undefined || Number.isFinite(result.pnl));

      // Üretim formülleri bağımsız defterle aynı net miktarları vermeli.
      const commission = { byAsset: { [fill.feeAsset]: fill.fee } };
      const prodNetBase = netBaseReceived(side, fill.qty, 'BTC', commission);
      const prodNetQuote = netQuoteFlow(side, grossQuote, 'USDT', commission);
      const independentNetBase = side === 'buy' ? fill.qty - (fill.feeAsset === 'BTC' ? fill.fee : 0) : fill.qty;
      const independentNetQuote = side === 'buy'
        ? grossQuote + (fill.feeAsset === 'USDT' ? fill.fee : 0)
        : grossQuote - (fill.feeAsset === 'USDT' ? fill.fee : 0);
      approx(prodNetBase, independentNetBase, 1e-10);
      approx(prodNetQuote, independentNetQuote, 1e-8);
      checked++;
    }

    assert.ok(minUSDT >= -EPS && minBTC >= -EPS && minBNB >= -EPS);
  }
  assert.ok(checked > 100000, `too few executable fills: ${checked}`);
});

test('accounting model checker: üçüncü varlık komisyonu fiyat yoksa güvenli biçimde unresolved kalır', () => {
  const c = { byAsset: { BNB: 0.05 } };
  const complete = totalThirdAssetCommission(c, 'BTC', 'USDT', { BNB: { direct: 350 } });
  assert.equal(complete.complete, true);
  approx(complete.value, 17.5);

  const incomplete = totalThirdAssetCommission(c, 'BTC', 'USDT', {});
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.value, null);
});

test('accounting model checker: cost basis ve realized P/L parçalı satışlarda double-count yapmaz', () => {
  const initial = { quantity: 1, costQuote: 40000 };
  const first = proportionalCostBasis(initial, 0.3);
  approx(first, 12000);
  const after = { quantity: 0.7, costQuote: 28000 };
  const second = realizedPnl(after, 0.7, 35000);
  approx(second.costBasis, 28000);
  approx(second.pnl, 7000);
  approx(first + second.costBasis, 40000);
});
