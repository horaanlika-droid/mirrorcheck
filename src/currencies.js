// Реестр направлений: только USD-подарочные карты → USDT (BEP-20).
// Здесь задаются ключи настроек, точность, правила адреса и номиналы.
// key — стабильный идентификатор направления (используется в настройках и заявках).
//
// direction — всегда 'sell': клиент отдаёт код USD-карты, получает USDT в сети BNB Smart Chain.
// У КАЖДОЙ карты свой курс: своя скидка к споту cardFees[key] и свой итоговый
// курс выплаты cardRates[key] (USDT за $1 номинала). Общего курса больше нет.
const PAYOUT_CURRENCY = 'USDT';
const PAYOUT_NETWORK = 'BEP20'; // поле network в заявке на выкуп — сеть выплаты
const PAYOUT_DECIMALS = 6;      // точность сервиса, не количество знаков токена в блокчейне
const WALLET_PATTERN = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;
const WALLET_ERROR = 'Укажите ненулевой адрес для USDT (BEP-20): 0x и 40 шестнадцатеричных символов.';
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
    network: PAYOUT_NETWORK,
    coin,
    symbol,
    label,
    name: `${label} USD`,
    kind: 'gift',
    payoutCurrency: PAYOUT_CURRENCY,
    payoutDecimals: PAYOUT_DECIMALS,
    decimals: 0, // номинал хранится целым числом долларов
    display: 0,
    rateDecimals: PAYOUT_DECIMALS,
    // Индексы в settings.cardRates / settings.cardFees — у каждой карты своя ячейка.
    rateKey: key,
    feeKey: key,
    rateLabel: 'USDT за $1 номинала',
    unit: 'USD',
    step: 10,
    minUnits: 10,
    walletOptional: false,
    walletHint: 'Выберите для получения USDT сеть BNB Smart Chain (BEP-20). Адрес начинается с 0x.',
    walletPattern: WALLET_PATTERN.source,
    walletError: WALLET_ERROR,
    infoNote: CARD_INFO_NOTE,
    currencyNote: 'Проверьте регион карты: США, валюта номинала — USD ($).',
    ttlMinutes: 60,
    note: 'Оператор проверит код карты вручную и выплатит USDT (BEP-20) на указанный кошелёк.',
  };
}

const PAIRS = {
  // Все карты выплачиваются в USDT (BEP-20), но курс считается отдельно для каждого бренда.
  GOOGLE_USD: giftPair('GOOGLE_USD', 'Google Gift Card', 'google', '🎁'),
  ITUNES_USD: giftPair('ITUNES_USD', 'iTunes Gift Card', 'itunes', '🎵'),
  XBOX_USD: giftPair('XBOX_USD', 'Xbox Gift Card', 'xbox', '🎮'),
  APPLE_STORE_USD: giftPair('APPLE_STORE_USD', 'Apple Store Gift Card', 'apple', '🍎'),
};

const LIST = Object.values(PAIRS);

const norm = (v) => String(v ?? '').trim().toUpperCase();

// Ключ направления определяется картой, а не сетью выплаты.
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
// полем giftPercent, которое мигрируется в store.js.
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

// Финальный клиентский курс карты (USDT за $1 номинала с учётом её скидки).
// null — направление пока не настроено или выключено.
function rateOf(settings, currency) {
  const pair = find(currency);
  if (!pair || !settings) return null;
  if (!isEnabled(settings, pair.key) || !giftSpotRate(settings)) return null;
  return positiveRate(settings.cardRates?.[pair.key]);
}

const isGift = (currency) => !!find(currency);

const gift = (key = GIFT_KEY) => PAIRS[norm(key)] || PAIRS[GIFT_KEY];

// У новых заявок единственное направление выплаты. Старые читаем как записаны:
// до USDT (BEP-20) у выплат в BTC поле network было пустым.
const payoutCurrency = () => PAYOUT_CURRENCY;
function payoutCurrencyOf(order) {
  if (!order) return null;
  if (order.payoutCurrency) return order.payoutCurrency;
  if (order.currency && !isGift(order.currency) && order.direction !== 'sell') return order.currency;
  return order.network ? 'USDT' : 'BTC';
}
function payoutLabelOf(order) {
  const cur = payoutCurrencyOf(order);
  if (cur !== 'USDT' || !order.network) return cur;
  return `${cur} (${order.network === PAYOUT_NETWORK ? 'BEP-20' : order.network})`;
}
const payoutDecimals = (cur = PAYOUT_CURRENCY) => cur === PAYOUT_CURRENCY ? PAYOUT_DECIMALS : 8;

// Молчание означает единственную доступную сеть, явный запрос другой сети — ошибка.
function supportsPayout({ payoutCurrency, network, payoutNetwork }) {
  const supportedNetwork = (v) => v == null || [PAYOUT_NETWORK, 'BEP-20'].includes(norm(v));
  return (payoutCurrency == null || norm(payoutCurrency) === PAYOUT_CURRENCY) &&
    supportedNetwork(network) && supportedNetwork(payoutNetwork);
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

// Проверить по адресу можно только формат: другие EVM-сети также используют 0x.
function validateWallet(wallet) {
  return WALLET_PATTERN.test(String(wallet ?? '').trim()) ? null : WALLET_ERROR;
}

// Публичное описание направлений для клиента: только итоговый курс каждой карты.
// Скидка (fee) клиенту не показывается никогда — её видит только оператор.
function publicRates(settings) {
  return LIST.map((p) => ({
    key: p.key,
    direction: 'sell',
    currency: p.currency,
    network: p.network,
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
    payoutCurrency: p.payoutCurrency,
    payoutDecimals: p.payoutDecimals,
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

// Цена 1 USDT в USD. Отсекаем нечисловые и явно посторонние котировки.
function usdtUsdQuote(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0.1 && n <= 10 ? n : null;
}

// Сколько USDT приходится на $1 номинала до скидки карты.
function giftSpotRate(settings) {
  const quote = usdtUsdQuote(settings?.usdtUsd);
  return quote ? 1 / quote : null;
}

// USDT за $1 номинала после скидки percent.
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

// Сколько USDT получит клиент за выбранную карту. Округляем выплату вниз до точности сервиса.
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
  const scale = 10 ** pair.payoutDecimals;
  const baseCrypto = Math.floor(n * baseRate * scale + 1e-6) / scale;
  const crypto = appliedPercent > 0 ? Math.floor(n * effectiveRate * scale + 1e-6) / scale : baseCrypto;
  const bonusCrypto = appliedPercent > 0 ? Math.max(0, Math.round((crypto - baseCrypto) * scale) / scale) : 0;
  return {
    crypto,
    baseCrypto,
    bonusCrypto,
    rate: effectiveRate,
    baseRate,
    cardRate: baseRate,
    promoPercent: appliedPercent,
    payoutCurrency: pair.payoutCurrency,
    network: pair.network,
    usdtUsd: settings.usdtUsd,
  };
}

function giftPayouts(settings) {
  if (!settings) return [];
  return GIFT_KEYS
    .map((key) => ({ currency: key, payoutCurrency: PAYOUT_CURRENCY, network: PAYOUT_NETWORK, rate: rateOf(settings, key), enabled: isEnabled(settings, key) }))
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
  PAYOUT_CURRENCY,
  PAYOUT_NETWORK,
  PAYOUT_DECIMALS,
  payoutDecimals,
  payoutCurrency,
  payoutCurrencyOf,
  payoutLabelOf,
  supportsPayout,
  usdtUsdQuote,
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
  decimalsOf: payoutDecimals,
  displayDecimals: payoutDecimals,
  validateWallet,
};
