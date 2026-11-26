// Реестр направлений обмена: только USD gift-карты → BTC.
// Одно место, где описаны ключи настроек, точность, правила адресов и номиналов.
// key — стабильный идентификатор направления (используется в настройках и заявках).
//
// direction — всегда 'sell': клиент отдаёт код USD-подарочной карты, получает выплату в BTC.
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
    decimals: 0, // номинал храним целым числом долларов
    display: 0,
    rateDecimals: 8,
    // Общий BTC-курс за $1 для USD gift-карт с учётом giftPercent.
    rateKey: 'rateGOOGLEUSD',
    baseKey: null,
    feeKey: 'giftPercent',
    rateLabel: 'BTC за $1 номинала',
    unit: 'USD',
    step: 10,
    minUnits: 10,
    walletOptional: false,
    walletHint: 'Адрес Bitcoin-кошелька (bc1… / 1… / 3…)',
    walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    walletError: 'Проверьте адрес Bitcoin-кошелька — он выглядит некорректно.',
    infoNote:
      'Карту можно купить на любом маркетплейсе — Яндекс Маркет, Ozon, Wildberries и т. д. ' +
      'Нужна карта для региона США с номиналом в USD; карты других регионов и валют не принимаются.',
    currencyNote: 'Проверьте регион карты: США, валюта номинала — USD ($).',
    ttlMinutes: 60,
    note: 'Код карты оператор проверит вручную и выплатит BTC на указанный кошелёк.',
  };
}

const PAIRS = {
  // Все подарочные карты выплачиваются в BTC по общему USD/BTC-курсу.
  GOOGLE_USD: giftPair('GOOGLE_USD', 'Google Gift Card', 'google', '🎁'),
  ITUNES_USD: giftPair('ITUNES_USD', 'iTunes Gift Card', 'itunes', '🎵'),
  XBOX_USD: giftPair('XBOX_USD', 'Xbox Gift Card', 'xbox', '🎮'),
  APPLE_STORE_USD: giftPair('APPLE_STORE_USD', 'Apple Store Gift Card', 'apple', '🍎'),
};

const LIST = Object.values(PAIRS);

const norm = (v) => String(v ?? '').trim().toUpperCase();

// Ключ направления из валюты. Сети у gift-карт нет — криптовалюты больше не принимаются.
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

// Итоговый курс для клиента (BTC за $1 номинала с комиссией). null — направление ещё не настроено.
function rateOf(settings, currency) {
  const pair = find(currency);
  if (!pair || !settings) return null;
  if (!isEnabled(settings, pair.key)) return null;
  const rate = Number(settings[pair.rateKey]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

const isGift = (currency) => !!find(currency);

const gift = (key = GIFT_KEY) => PAIRS[norm(key)] || PAIRS[GIFT_KEY];

// Новые gift-заявки выплачиваются только в BTC.
const payoutCurrency = (currency) => 'BTC';
const payoutCurrencyOf = (order) => order ? 'BTC' : null;

function payoutDecimals() {
  return 8;
}

// Шаг номинала (кратность).
const stepOf = () => 10;

const minUnitsOf = () => 10;

// Приводит номинал вниз к разрешённому значению (кратно $10, не меньше $10).
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
  if (Math.abs(n / 10 - Math.round(n / 10)) > 1e-9) return 'Сумма должна быть кратна $10.';
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

// Возвращает текст ошибки или null, если адрес Bitcoin-кошелька подходит.
function validateWallet(wallet) {
  const w = String(wallet ?? '').trim();
  if (!w) return 'Укажите адрес кошелька для выплаты.';
  if (/\s/.test(w)) return 'Адрес кошелька не должен содержать пробелов.';
  if (w.length < 26 || w.length > 128) return 'Проверьте адрес Bitcoin-кошелька — он выглядит некорректно.';
  if (!/^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(w)) return 'Проверьте адрес Bitcoin-кошелька — он выглядит некорректно.';
  return null;
}

// Публичное описание направлений для клиента: только итоговый курс с комиссией.
// Комиссия giftPercent не светится — её видит лишь оператор в боте.
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
    rateLabel: 'BTC за $1 номинала',
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

const positiveRate = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Direct BTC value of one US dollar: 1 / BTCUSD.
function giftSpotRate(settings) {
  if (!settings) return null;
  const btcUsd = positiveRate(settings.btcUsd);
  return btcUsd > 0 ? 1 / btcUsd : null;
}

// BTC за $1 номинала после скидки giftPercent.
function giftRateFromPercent(percent, settings) {
  const p = Number(percent);
  const safe = Number.isFinite(p) ? Math.min(Math.max(p, 0), 50) : 0;
  const spot = giftSpotRate(settings);
  if (!(spot > 0)) return null;
  return Math.round((spot * (1 - safe / 100)) * 1e12) / 1e12;
}

// Обратный пересчёт: какой процент скидки соответствует BTC-курсу.
function giftPercentFromRate(rate, settings) {
  const r = Number(rate);
  const spot = giftSpotRate(settings);
  if (!(r > 0) || !(spot > 0) || r > spot) return 0;
  return Math.round((1 - r / spot) * 10000) / 100;
}

// Сколько BTC получит клиент за выбранную карту. Выплата округляется вниз до сатоши.
function giftPayout(settings, units, currency = GIFT_KEY) {
  const pair = find(currency);
  if (!pair || pair.kind !== 'gift') return null;
  const cardRate = rateOf(settings, pair.currency);
  if (!(cardRate > 0)) return null;
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return null;
  const crypto = Math.floor(n * cardRate * 1e8 + 1e-6) / 1e8;
  return {
    crypto,
    rate: cardRate,
    cardRate,
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
  label: (currency) => { const p = find(currency); return p ? p.label : norm(currency); },
  shortLabel: (currency) => { const p = find(currency); return p ? p.key.replace('_', ' · ') : norm(currency); },
  symbol,
  isGift,
  GIFT_KEY,
  GIFT_KEYS,
  gift,
  payoutDecimals,
  payoutCurrency,
  payoutCurrencyOf,
  giftSpotRate,
  giftRateFromPercent,
  giftPercentFromRate,
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
