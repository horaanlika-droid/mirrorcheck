// Курсы Pricelex Worldwide: gift cards → BTC по прямому BTC/USD споту. Тесты не требуют сети.
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
  btcUsd: 35_000,            // direct BTC/USD spot
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

test('giftRateFromPercent: spot = 1 / BTCUSD, then applies the discount', () => {
  const spot = 1 / settings.btcUsd;
  const expected = Math.round((spot * 0.95) * 1e12) / 1e12;
  const got = currencies.giftRateFromPercent(5, settings);
  assert.ok(got > 0);
  assert.equal(got, expected);
});

test('giftRateFromPercent при комиссии 0 равен споту (округлённому)', () => {
  const spot = 1 / settings.btcUsd;
  assert.equal(currencies.giftRateFromPercent(0, settings), Math.round(spot * 1e12) / 1e12);
});

test('giftRateFromPercent возвращает null, если спот не задан', () => {
  assert.equal(currencies.giftRateFromPercent(5, { btcUsd: 0 }), null);
});

test('giftPayout: rounds down to satoshis and exposes direct BTC/USD only', () => {
  const s = { ...settings, rateGOOGLEUSD: currencies.giftRateFromPercent(5, settings) };
  const rate = s.rateGOOGLEUSD;
  const payout = currencies.giftPayout(s, 10, 'GOOGLE_USD');
  assert.ok(payout);
  assert.equal(payout.rate, rate);
  assert.equal(payout.cardRate, rate);
  const expectedCrypto = Math.floor(10 * rate * 1e8 + 1e-6) / 1e8;
  assert.equal(payout.crypto, expectedCrypto);
  assert.equal(payout.btcUsd, s.btcUsd);
  assert.equal('rub' in payout, false);
});

test('giftPayout для несуществующей валюты возвращает null', () => {
  assert.equal(currencies.giftPayout(settings, 10, 'NONEXISTENT'), null);
});

test('giftPayout при нулевом курсе возвращает null', () => {
  const empty = { ...settings, GOOGLE_USD: false };
  assert.equal(currencies.giftPayout(empty, 10, 'GOOGLE_USD'), null);
});

test('applyRates сохраняет BTC/USD и пересчитывает курс карты', () => {
  const official = { btcUsd: 36_000, source: 'kraken+coinbase' };
  const res = rates.applyRates(official);
  assert.equal(res.btcUsd, 36_000);
  assert.equal(res.rateSource, 'kraken+coinbase');
  assert.ok(res.rateUpdatedAt > 0);
  const spot = 1 / 36_000;
  const expected = Math.round((spot * 0.95) * 1e12) / 1e12;
  assert.equal(res.rateGOOGLEUSD, expected);
});

test('recomputeGiftRate пересчитывает только gift-курс по текущей комиссии', () => {
  store.mutate((db) => {
    db.settings.btcUsd = 35_000;
    db.settings.giftPercent = 10;
  });
  const before = store.get().settings.rateGOOGLEUSD;
  const after = rates.recomputeGiftRate();
  const spot = 1 / 35_000;
  const expected = Math.round((spot * 0.9) * 1e12) / 1e12;
  assert.equal(after, expected);
  assert.notEqual(after, before);
});
