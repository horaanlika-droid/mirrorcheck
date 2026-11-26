// Курсы Pricelex Worldwide: у КАЖДОЙ подарочной карты свой курс выплаты. Тесты не требуют сети.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirrorcheck-rates-'));
process.env.DATA_DIR = dir;
delete process.env.BOT_TOKEN;
delete process.env.WIDGETS;

const store = require('../src/store');
const currencies = require('../src/currencies');
const rates = require('../src/rates');

const baseSettings = () => ({
  btcUsd: 35_000, // прямой спот BTC/USD
  // Разные скидки → разные курсы для каждого бренда.
  cardFees: { GOOGLE_USD: 5, ITUNES_USD: 10, XBOX_USD: 20, APPLE_STORE_USD: 0 },
  cardRates: {},
  enabled: { GOOGLE_USD: true, ITUNES_USD: true, XBOX_USD: true, APPLE_STORE_USD: true },
  rateUpdatedAt: null,
  rateSource: null,
  online: true,
});

function writeSettings(settings) {
  store.mutate((db) => {
    db.settings = settings;
    db.orders = [];
  });
}

beforeEach(() => {
  const s = baseSettings();
  s.cardRates = currencies.allCardRates(s);
  writeSettings(s);
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('giftRateFromPercent: спот = 1 / BTCUSD, затем применяется скидка', () => {
  const spot = 1 / baseSettings().btcUsd;
  const expected = Math.round((spot * 0.95) * 1e12) / 1e12;
  const got = currencies.giftRateFromPercent(5, baseSettings());
  assert.ok(got > 0);
  assert.equal(got, expected);
});

test('giftRateFromPercent при скидке 0 равен споту (округлённому)', () => {
  const spot = 1 / baseSettings().btcUsd;
  assert.equal(currencies.giftRateFromPercent(0, baseSettings()), Math.round(spot * 1e12) / 1e12);
});

test('giftRateFromPercent возвращает null, если спот не задан', () => {
  assert.equal(currencies.giftRateFromPercent(5, { btcUsd: 0 }), null);
});

test('allCardRates: у каждой карты свой курс по её собственной скидке', () => {
  const s = store.get().settings;
  const spot = 1 / s.btcUsd;
  const expected = (fee) => Math.round((spot * (1 - fee / 100)) * 1e12) / 1e12;
  assert.equal(s.cardRates.GOOGLE_USD, expected(5));
  assert.equal(s.cardRates.ITUNES_USD, expected(10));
  assert.equal(s.cardRates.XBOX_USD, expected(20));
  assert.equal(s.cardRates.APPLE_STORE_USD, expected(0));
  const unique = new Set(Object.values(s.cardRates));
  assert.equal(unique.size, currencies.GIFT_KEYS.length, 'все четыре курса разные');
  assert.ok(s.cardRates.GOOGLE_USD > s.cardRates.ITUNES_USD);
  assert.ok(s.cardRates.ITUNES_USD > s.cardRates.XBOX_USD);
  assert.equal(currencies.feeOf(s, 'XBOX_USD'), 20);
  assert.equal(currencies.feeOf(s, 'APPLE_STORE_USD'), 0);
});

test('rateOf/giftPayout используют курс выбранной карты, а не общий', () => {
  const s = store.get().settings;
  const google = currencies.giftPayout(s, 10, 'GOOGLE_USD');
  const xbox = currencies.giftPayout(s, 10, 'XBOX_USD');
  assert.ok(google && xbox);
  assert.equal(google.rate, s.cardRates.GOOGLE_USD);
  assert.equal(xbox.rate, s.cardRates.XBOX_USD);
  assert.equal(google.cardRate, s.cardRates.GOOGLE_USD);
  assert.notEqual(google.crypto, xbox.crypto, 'выплаты за разные карты различаются');
  assert.equal(google.crypto, Math.floor(10 * s.cardRates.GOOGLE_USD * 1e8 + 1e-6) / 1e8);
  assert.equal(google.btcUsd, s.btcUsd);
  assert.equal('rub' in google, false);
  assert.equal(currencies.rateOf(s, 'ITUNES_USD'), s.cardRates.ITUNES_USD);
});

test('giftPayout для несуществующей валюты возвращает null', () => {
  assert.equal(currencies.giftPayout(store.get().settings, 10, 'NONEXISTENT'), null);
});

test('giftPayout при нулевом курсе карты возвращает null', () => {
  const s = { ...store.get().settings, cardRates: { ...store.get().settings.cardRates, GOOGLE_USD: 0 } };
  assert.equal(currencies.giftPayout(s, 10, 'GOOGLE_USD'), null);
  // Остальные карты продолжают работать — общий курс больше не отключает всё.
  assert.ok(currencies.giftPayout(s, 10, 'XBOX_USD'));
});

test('applyRates сохраняет BTC/USD и пересчитывает курс каждой карты с её скидкой', () => {
  const official = { btcUsd: 36_000, source: 'kraken+coinbase' };
  const res = rates.applyRates(official);
  assert.equal(res.btcUsd, 36_000);
  assert.equal(res.rateSource, 'kraken+coinbase');
  assert.ok(res.rateUpdatedAt > 0);
  const spot = 1 / 36_000;
  const expected = (fee) => Math.round((spot * (1 - fee / 100)) * 1e12) / 1e12;
  assert.equal(res.cardRates.GOOGLE_USD, expected(5));
  assert.equal(res.cardRates.ITUNES_USD, expected(10));
  assert.equal(res.cardRates.XBOX_USD, expected(20));
  assert.equal(res.cardRates.APPLE_STORE_USD, expected(0));
});

test('recomputeGiftRates меняет курс только той карты, чью скидку поправили', () => {
  const before = { ...store.get().settings.cardRates };
  store.mutate((db) => { db.settings.cardFees.ITUNES_USD = 30; });
  const afterRates = rates.recomputeGiftRates();
  const spot = 1 / store.get().settings.btcUsd;
  assert.equal(afterRates.ITUNES_USD, Math.round((spot * 0.7) * 1e12) / 1e12);
  assert.equal(afterRates.GOOGLE_USD, before.GOOGLE_USD);
  assert.equal(afterRates.XBOX_USD, before.XBOX_USD);
  assert.equal(afterRates.APPLE_STORE_USD, before.APPLE_STORE_USD);
});

test('совместимость со старыми настройками: giftPercent и общий rateGOOGLEUSD', () => {
  const legacy = { btcUsd: 35_000, giftPercent: 12, rateGOOGLEUSD: 0.000025 };
  assert.equal(currencies.feeOf(legacy, 'GOOGLE_USD'), 12);
  assert.equal(currencies.feeOf(legacy, 'XBOX_USD'), 12);
  assert.equal(currencies.rateOf(legacy, 'GOOGLE_USD'), 0.000025);
  assert.equal(currencies.giftRateFor(legacy, 'ITUNES_USD'), currencies.giftRateFromPercent(12, legacy));
});

test('миграция старой базы: общая скидка становится скидкой каждой карты', () => {
  const { execFileSync } = require('node:child_process');
  const legacyDir = fs.mkdtempSync(path.join(dir, 'legacy-'));
  fs.writeFileSync(path.join(legacyDir, 'db.json'), JSON.stringify({
    settings: { btcUsd: 40_000, giftPercent: 15, rateGOOGLEUSD: 0.00002, online: true },
    orders: [],
  }));
  const out = execFileSync(process.execPath, ['-e',
    "const s=require('./src/store'); console.log(JSON.stringify({fees:s.get().settings.cardFees,rates:s.get().settings.cardRates,legacy:s.get().settings.giftPercent,old:s.get().settings.rateGOOGLEUSD}));",
  ], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: legacyDir }, encoding: 'utf8' });
  const got = JSON.parse(out.trim());
  for (const key of currencies.GIFT_KEYS) {
    assert.equal(got.fees[key], 15, `скидка ${key} перенесена`);
    assert.equal(got.rates[key], currencies.giftRateFromPercent(15, { btcUsd: 40_000 }));
  }
  assert.equal(got.legacy, undefined);
  assert.equal(got.old, undefined);
});

test('новая база сохраняет разные скидки карт при загрузке', () => {
  const { execFileSync } = require('node:child_process');
  const freshDir = fs.mkdtempSync(path.join(dir, 'fresh-'));
  fs.writeFileSync(path.join(freshDir, 'db.json'), JSON.stringify({
    settings: {
      btcUsd: 50_000,
      cardFees: { GOOGLE_USD: 2, ITUNES_USD: 7, XBOX_USD: 12, APPLE_STORE_USD: 30 },
      cardRates: {},
      online: true,
    },
    orders: [],
  }));
  const out = execFileSync(process.execPath, ['-e',
    "const s=require('./src/store'); console.log(JSON.stringify({fees:s.get().settings.cardFees,rates:s.get().settings.cardRates}));",
  ], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: freshDir }, encoding: 'utf8' });
  const got = JSON.parse(out.trim());
  assert.deepEqual(got.fees, { GOOGLE_USD: 2, ITUNES_USD: 7, XBOX_USD: 12, APPLE_STORE_USD: 30 });
  assert.equal(got.rates.GOOGLE_USD, currencies.giftRateFromPercent(2, { btcUsd: 50_000 }));
  assert.equal(got.rates.APPLE_STORE_USD, currencies.giftRateFromPercent(30, { btcUsd: 50_000 }));
  assert.equal(new Set(Object.values(got.rates)).size, 4, 'курсы не сливаются в один');
});
