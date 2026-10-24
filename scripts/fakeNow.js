// node --require scripts/fakeNow.js : FAKE_NOW (ISO) ile "simdi"yi kaydirir; zaman yine akar.
// Gercek saate bagli (zaman bombasi) testleri yakalamak icin: bkz. scripts/testClock.js
const RealDate = Date;
const offset = process.env.FAKE_NOW ? RealDate.parse(process.env.FAKE_NOW) - RealDate.now() : 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a); }
  static now() { return RealDate.now() + offset; }
}
global.Date = FakeDate;
