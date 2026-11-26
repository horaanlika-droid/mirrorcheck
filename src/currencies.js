// Реестр направлений: только USD-подарочные карты → BTC.
// Здесь задаются ключи настроек, точность, правила адреса и номиналы.
// key — стабильный идентификатор направления (используется в настройках и заявках).
//
// direction — всегда 'sell': клиент отдаёт код USD-карты, получает BTC.
// У КАЖДОЙ карты свой курс: своя скидка к споту cardFees[key] и свой итоговый
// курс выплаты cardRates[key] (BTC за $1 номинала). Общего курса больше нет.
const GIFT_KEY = 'GOOGLE_USD';
const GIFT_KEYS = ['GOOGLE_USD', 'ITUNES_USD', 'XBOX_USD', 'APPLE_STORE_USD'];
const GIFT_ALIASES = {
  GOOGLE: 'GOOGLE_USD',
  GOOGLE_GIFT_CARD: 'GOOGLE_USD',
  GIFTCARD: 'GOOGLE_USD',
  ITUNES: 'ITUNES_USD',
  ITUNES_GIFT_CARD: 'ITUNES_USD',
  XBOX: 'XBOX_USD',
  XBOX_GIFT_CARD: 'XBOX_USD',
  APPLE: 'APPLE_STORE_USD',
  APPLE_STORE: 'APPLE_STORE_USD',
  APPLE_STORE_GIFT_CARD: 'APPLE_STORE_USD',
};

const CARD_INFO_NOTE =
  'Где и по какому курсу вы купили карту — нам не важно. Берите её где удобно: на любом маркетплейсе, ' +
  'в магазине цифровых кодов, у знакомых или за наличные. Мы не спрашиваем чек и цену покупки. ' +
  'Важно только, чтобы карта была рабочей: регион США, номинал в USD ($), полный неиспользованный баланс.';

function giftPair(key, label, coin, symbol) {
  return {
    key,
    direction: 'sell',
    currency: key,
    network: null,
    coin,
    symbol,
    label,
    name: `${label} USD`,
    kind: 'gift',
    payoutCurrency: 'BTC',
    payoutDecimals: 8,
    decimals: 0, // номинал хранится целым числом долларов
    display: 0,
    rateDecimals: 8,
    // Индексы в settings.cardRates / settings.cardFees — у каждой карты своя ячейка.
    rateKey: key,
    feeKey: key,
    rateLabel: 'BTC за $1 номинала',
    unit: 'USD',
    step: 10,
    minUnits: 10,
    walletOptional: false,
    walletHint: 'Адрес Bitcoin-кошелька (bc1… / 1… / 3…)',
    walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    walletError: 'Проверьте адрес Bitcoin-кошелька — он выглядит неверно.',
    infoNote: CARD_INFO_NOTE,
    currencyNote: 'Проверьте регион карты: США, валюта номинала — USD ($).',
    ttlMinutes: 60,
    note: 'Оператор проверит код карты вручную и выплатит BTC на указанный кошелёк.',
  };
}

const PAIRS = {
  // Все карты выплачиваются в BTC, но курс считается отдельно для каждого бренда.
  GOOGLE_USD: giftPair('GOOGLE_USD', 'Google Gift Card', 'google', '🎁'),
  ITUNES_USD: giftPair('ITUNES_USD', 'iTunes Gift Card', 'itunes', '🎵'),
  XBOX_USD: giftPair('XBOX_USD', 'Xbox Gift Card', 'xbox', '🎮'),
  APPLE_STORE_USD: giftPair('APPLE_STORE_USD', 'Apple Store Gift Card', 'apple', '🍎'),
};

const LIST = Object.values(PAIRS);

const norm = (v) => String(v ?? '').trim().toUpperCase();

// Ключ направления из валюты. Сети у карт нет — криптовалюты больше не принимаются.
function keyOf(currency) {
  const cur = norm(currency);
  if (GIFT_KEYS.includes(cur)) return cur;
  if (GIFT_ALIASES[cur]) return GIFT_ALIASES[cur];
  return null;
}

const find = (currency) => PAIRS[keyOf(currency)] || null;
const get = (key) => PAIRS[keyOf(key)] || null;
const list = () => LIST;

const isEnabled = (settings, key) => {
  const pair = get(key);
  if (!pair) return false;
  const enabled = settings && settings.enabled;
  return !enabled || enabled[pair.key] !== false;
};

// Скидка конкретной карты к споту, % (0–50). Для старых баз подстраховываемся
// legacy-полями giftPercent / rateGOOGLEUSD, которые мигрируются в store.js.
const clampFee = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 50) : 0;
};

function feeOf(settings, currency) {
  const pair = find(currency) || get(currency);
  if (!pair || !settings) return 0;
  if (settings.cardFees && typeof settings.cardFees === 'object') return clampFee(settings.cardFees[pair.key]);
  return clampFee(settings.giftPercent);
}

const positiveRate = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Финальный клиентский курс карты (BTC за $1 номинала с учётом её скидки).
// null — направление пока не настроено или выключено.
function rateOf(settings, currency) {
  const pair = find(currency);
  if (!pair || !settings) return null;
  if (!isEnabled(settings, pair.key)) return null;
  let rate;
  if (settings.cardRates && typeof settings.cardRates === 'object') {
    rate = Number(settings.cardRates[pair.key]);
  } else {
    rate = Number(settings.rateGOOGLEUSD); // база до миграции: общий курс
  }
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

const isGift = (currency) => !!find(currency);

const gift = (key = GIFT_KEY) => PAIRS[norm(key)] || PAIRS[GIFT_KEY];

// Новые заявки по картам выплачиваются только в BTC.
const payoutCurrency = (currency) => 'BTC';
const payoutCurrencyOf = (order) => order ? 'BTC' : null;

function payoutDecimals() {
  return 8;
}

// Шаг номинала (кратно).
const stepOf = () => 10;

const minUnitsOf = () => 10;

// Округляет номинал вниз до разрешённого значения (кратно $10, не меньше $10).
function floorUnits(units) {
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 10 + 1e-9) * 10;
}

// Возвращает текст ошибки или null, если номинал подходит направлению.
function validateUnits(units) {
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return 'Укажите номинал карты.';
  if (n < 10) return 'Минимальный номинал — $10.';
  if (Math.abs(n / 10 - Math.round(n / 10)) > 1e-9) return 'Номинал должен быть кратен $10.';
  return null;
}

function symbol(currency) {
  const pair = find(currency);
  return pair ? pair.symbol : '🪙';
}

function decimalsOf() {
  return 8;
}

function displayDecimals() {
  return 8;
}

// Возвращает текст ошибки или null, если Bitcoin-адрес корректен.
function validateWallet(wallet) {
  const w = String(wallet ?? '').trim();
  if (!w) return 'Укажите адрес кошелька для выплаты.';
  if (/\s/.test(w)) return 'В адресе кошелька не должно быть пробелов.';
  if (w.length < 26 || w.length > 128) return 'Проверьте адрес Bitcoin-кошелька — он выглядит неверно.';
  if (!/^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(w)) return 'Проверьте адрес Bitcoin-кошелька — он выглядит неверно.';
  return null;
}

// Публичное описание направлений для клиента: только итоговый курс каждой карты.
// Скидка (fee) клиенту не показывается никогда — её видит только оператор.
function publicRates(settings) {
  return LIST.map((p) => ({
    key: p.key,
    direction: 'sell',
    currency: p.currency,
    network: null,
    label: p.label,
    name: p.name,
    symbol: p.symbol,
    coin: p.coin,
    decimals: p.decimals,
    display: p.display,
    walletHint: p.walletHint,
    walletPattern: p.walletPattern,
    walletError: p.walletError,
    kind: 'gift',
    payoutCurrency: 'BTC',
    payoutDecimals: 8,
    unit: 'USD',
    rateLabel: p.rateLabel,
    infoNote: p.infoNote || null,
    currencyNote: p.currencyNote || null,
    ttlMinutes: p.ttlMinutes || null,
    step: p.step || null,
    minUnits: p.minUnits || null,
    walletOptional: !!p.walletOptional,
    note: p.note || null,
    rate: rateOf(settings, p.currency),
    enabled: isEnabled(settings, p.key),
  }));
}

// Прямая BTC-стоимость одного доллара США: 1 / BTCUSD.
function giftSpotRate(settings) {
  if (!settings) return null;
  const btcUsd = positiveRate(settings.btcUsd);
  return btcUsd > 0 ? 1 / btcUsd : null;
}

// BTC за $1 номинала после скидки percent.
function giftRateFromPercent(percent, settings) {
  const p = Number(percent);
  const safe = Number.isFinite(p) ? Math.min(Math.max(p, 0), 50) : 0;
  const spot = giftSpotRate(settings);
  if (!(spot > 0)) return null;
  return Math.round((spot * (1 - safe / 100)) * 1e12) / 1e12;
}

// Курс конкретной карты по её собственной скидке.
function giftRateFor(settings, key) {
  const pair = get(key) || gift(key);
  return giftRateFromPercent(feeOf(settings, pair.key), settings);
}

// Все курсы разом: { GOOGLE_USD: rate, ITUNES_USD: rate, ... }.
function allCardRates(settings) {
  const out = {};
  for (const p of LIST) out[p.key] = giftRateFor(settings, p.key);
  return out;
}

// Обратный расчёт: какой скидке в процентах соответствует курс.
function giftPercentFromRate(rate, settings) {
  const r = Number(rate);
  const spot = giftSpotRate(settings);
  if (!(r > 0) || !(spot > 0) || r > spot) return 0;
  return Math.round((1 - r / spot) * 10000) / 100;
}

// Применение промокода к базовому курсу карты: увеличивает итоговый курс на percent%.
function applyPromoToRate(baseRate, percent) {
  const r = Number(baseRate);
  const p = Number(percent);
  if (!(r > 0)) return null;
  if (!Number.isFinite(p) || p <= 0) return r;
  const safe = Math.min(Math.max(p, 0), 50);
  return Math.round((r * (1 + safe / 100)) * 1e12) / 1e12;
}

// Сколько BTC получит клиент за выбранную карту. Выплата округляется вниз до сатоши.
// При переданном promoPercent (>0) итоговый курс увеличивается на указанный процент.
function giftPayout(settings, units, currency = GIFT_KEY, promoPercent = 0) {
  const pair = find(currency);
  if (!pair || pair.kind !== 'gift') return null;
  const baseRate = rateOf(settings, pair.currency);
  if (!(baseRate > 0)) return null;
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = Number(promoPercent);
  const appliedPercent = Number.isFinite(p) && p > 0 ? Math.min(p, 50) : 0;
  const effectiveRate = appliedPercent > 0 ? applyPromoToRate(baseRate, appliedPercent) : baseRate;
  const baseCrypto = Math.floor(n * baseRate * 1e8 + 1e-6) / 1e8;
  const crypto = appliedPercent > 0 ? Math.floor(n * effectiveRate * 1e8 + 1e-6) / 1e8 : baseCrypto;
  const bonusCrypto = appliedPercent > 0 ? Math.max(0, Math.round((crypto - baseCrypto) * 1e8) / 1e8) : 0;
  return {
    crypto,
    baseCrypto,
    bonusCrypto,
    rate: effectiveRate,
    baseRate,
    cardRate: baseRate,
    promoPercent: appliedPercent,
    btcUsd: positiveRate(settings.btcUsd),
  };
}

function giftPayouts(settings) {
  if (!settings) return [];
  return GIFT_KEYS
    .map((key) => ({ currency: key, network: null, rate: rateOf(settings, key), enabled: isEnabled(settings, key) }))
    .filter((p) => p.rate);
}

module.exports = {
  PAIRS,
  LIST,
  publicRates,
  keyOf,
  find,
  get,
  list,
  isEnabled,
  rateOf,
  feeOf,
  clampFee,
  label: (currency) => { const p = find(currency); return p ? p.label : norm(currency); },
  shortLabel: (currency) => { const p = find(currency); return p ? p.key.replace('_', ' · ') : norm(currency); },
  symbol,
  isGift,
  GIFT_KEY,
  GIFT_KEYS,
  CARD_INFO_NOTE,
  gift,
  payoutDecimals,
  payoutCurrency,
  payoutCurrencyOf,
  giftSpotRate,
  giftRateFromPercent,
  giftRateFor,
  allCardRates,
  giftPercentFromRate,
  applyPromoToRate,
  giftPayout,
  giftPayouts,
  stepOf,
  minUnitsOf,
  floorUnits,
  validateUnits,
  decimalsOf,
  displayDecimals,
  validateWallet,
};
