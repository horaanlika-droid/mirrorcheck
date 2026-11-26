// Курсы gift-карт (VEGA-меchanics, только продажа gift → BTC). Тесты не требуют сети.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirrorcheck-rates-'));
process.env.DATA_DIR = dir;
delete process.env.BOT_TOKEN;
delete process.env.WIDGETS;

const store = require('../src/store');
const currencies = require('../src/currencies');
const rates = require('../src/rates');

const settings = {
  giftPercent: 5,
  baseRateBTC: 3_500_000,   // 1 BTC = 3 500 000 ₽
  baseRateUSD: 92.50,        // 1 USD = 92.50 ₽
  rateGOOGLEUSD: null,
  rateUpdatedAt: null,
  rateSource: null,
  GOOGLE_USD: true,
  ITUNES_USD: true,
  XBOX_USD: true,
  APPLE_STORE_USD: true,
};

beforeEach(() => {
  store.mutate((db) => {
    db.settings = { ...settings };
    db.orders = [];
  });
});

test('giftRateFromPercent: спот = baseRateUSD / baseRateBTC, затем скидка комиссии', () => {
  const spot = settings.baseRateUSD / settings.baseRateBTC; // ~2.64e-8 BTC за $1
  const expected = Math.round((spot * 0.95) * 1e12) / 1e12;
  const got = currencies.giftRateFromPercent(5, settings);
  assert.ok(got > 0);
  assert.equal(got, expected);
});

test('giftRateFromPercent при комиссии 0 равен споту (округлённому)', () => {
  const spot = settings.baseRateUSD / settings.baseRateBTC;
  assert.equal(currencies.giftRateFromPercent(0, settings), Math.round(spot * 1e12) / 1e12);
});

test('giftRateFromPercent возвращает null, если спот не задан', () => {
  assert.equal(currencies.giftRateFromPercent(5, { baseRateBTC: 0, baseRateUSD: 0 }), null);
});

test('giftPayout: выплата округляется вниз до сатоши, rub = crypto * btcRub', () => {
  const s = { ...settings, rateGOOGLEUSD: currencies.giftRateFromPercent(5, settings) };
  const rate = s.rateGOOGLEUSD;
  const payout = currencies.giftPayout(s, 10, 'GOOGLE_USD');
  assert.ok(payout);
  assert.equal(payout.rate, rate);
  assert.equal(payout.cardRate, rate);
  const expectedCrypto = Math.floor(10 * rate * 1e8 + 1e-6) / 1e8;
  assert.equal(payout.crypto, expectedCrypto);
  assert.equal(payout.btcRub, s.baseRateBTC);
  assert.equal(payout.rub, Math.round(expectedCrypto * s.baseRateBTC));
});

test('giftPayout для несуществующей валюты возвращает null', () => {
  assert.equal(currencies.giftPayout(settings, 10, 'NONEXISTENT'), null);
});

test('giftPayout при нулевом курсе возвращает null', () => {
  const empty = { ...settings, GOOGLE_USD: false };
  assert.equal(currencies.giftPayout(empty, 10, 'GOOGLE_USD'), null);
});

test('applyRates сохраняет официальные курсы и пересчитывает gift-курс', () => {
  const official = { btc: 3_600_000, usd: 95.0, source: 'cbr' };
  const res = rates.applyRates(official);
  assert.equal(res.baseRateBTC, 3_600_000);
  assert.equal(res.baseRateUSD, 95);
  assert.equal(res.rateSource, 'cbr');
  assert.ok(res.rateUpdatedAt > 0);
  const spot = 95 / 3_600_000;
  const expected = Math.round((spot * 0.95) * 1e12) / 1e12;
  assert.equal(res.rateGOOGLEUSD, expected);
});

test('recomputeGiftRate пересчитывает только gift-курс по текущей комиссии', () => {
  store.mutate((db) => {
    db.settings.baseRateBTC = 3_500_000;
    db.settings.baseRateUSD = 92.50;
    db.settings.giftPercent = 10;
  });
  const before = store.get().settings.rateGOOGLEUSD;
  const after = rates.recomputeGiftRate();
  const spot = 92.50 / 3_500_000;
  const expected = Math.round((spot * 0.9) * 1e12) / 1e12;
  assert.equal(after, expected);
  assert.notEqual(after, before);
});
