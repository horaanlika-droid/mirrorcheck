// Реестр направлений: USD-подарочные карты → USDT (BEP-20 моментально без комиссии,
// а также TRC-20 / ERC-20 / TON и Bitcoin BTC с вычетом комиссии сети).
// Здесь задаются ключи настроек, точность, правила адреса, сети выплат и номиналы.
// key — стабильный идентификатор направления (используется в настройках и заявках).
//
// direction — всегда 'sell': клиент отдаёт код USD-карты, получает выбранную криптовалюту.
// У КАЖДОЙ карты свой курс: своя скидка к споту cardFees[key] и свой итоговый
// курс выплаты cardRates[key] (USDT за $1 номинала).
const PAYOUT_CURRENCY = 'USDT';
const PAYOUT_NETWORK = 'BEP20'; // сеть по умолчанию (моментальный вывод без комиссии)
const PAYOUT_DECIMALS = 6;      // точность USDT сервиса
const BTC_DECIMALS = 8;         // точность BTC (сатоши)
const WALLET_PATTERN = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;
const WALLET_ERROR = 'Укажите ненулевой адрес для USDT (BEP-20): 0x и 40 шестнадцатеричных символов.';

// Доступные способы выплаты. BEP-20 — единственный моментальный вывод с нулевой комиссией сети;
// BTC, TRC-20, ERC-20 и TON идут с комиссией сети (вычитается из суммы выплаты).
const PAYOUT_OPTIONS = {
  USDT_BEP20: {
    id: 'USDT_BEP20',
    payoutCurrency: 'USDT',
    network: 'BEP20',
    label: 'USDT (BEP-20)',
    shortLabel: 'BEP-20',
    coin: 'usdt',
    symbol: '₮',
    decimals: PAYOUT_DECIMALS,
    instant: true,
    defaultFee: 0,
    maxFee: 0,
    feeUnit: 'USDT',
    badge: 'Моментально · без комиссии',
    walletPlaceholder: '0x…',
    walletHint: 'Моментальный вывод без комиссии сети. Выберите получение USDT в сети BNB Smart Chain (BEP-20). Адрес начинается с 0x.',
    walletPattern: WALLET_PATTERN,
    walletError: WALLET_ERROR,
    txExample: 'https://bscscan.com/tx/0x…',
  },
  USDT_TRC20: {
    id: 'USDT_TRC20',
    payoutCurrency: 'USDT',
    network: 'TRC20',
    label: 'USDT (TRC-20)',
    shortLabel: 'TRC-20',
    coin: 'usdt',
    symbol: '₮',
    decimals: PAYOUT_DECIMALS,
    instant: false,
    defaultFee: 1.5,
    maxFee: 100,
    feeUnit: 'USDT',
    badge: 'По комиссии сети',
    walletPlaceholder: 'T…',
    walletHint: 'Вывод USDT в сети TRON (TRC-20) с вычетом комиссии сети. Адрес начинается с T (34 символа).',
    walletPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    walletError: 'Укажите корректный адрес для USDT (TRC-20): начинается с T, 34 символа.',
    txExample: 'https://tronscan.org/#/transaction/…',
  },
  USDT_ERC20: {
    id: 'USDT_ERC20',
    payoutCurrency: 'USDT',
    network: 'ERC20',
    label: 'USDT (ERC-20)',
    shortLabel: 'ERC-20',
    coin: 'usdt',
    symbol: '₮',
    decimals: PAYOUT_DECIMALS,
    instant: false,
    defaultFee: 3,
    maxFee: 100,
    feeUnit: 'USDT',
    badge: 'По комиссии сети',
    walletPlaceholder: '0x…',
    walletHint: 'Вывод USDT в сети Ethereum (ERC-20) с вычетом комиссии сети. Адрес начинается с 0x.',
    walletPattern: WALLET_PATTERN,
    walletError: 'Укажите ненулевой адрес для USDT (ERC-20): 0x и 40 шестнадцатеричных символов.',
    txExample: 'https://etherscan.io/tx/0x…',
  },
  USDT_TON: {
    id: 'USDT_TON',
    payoutCurrency: 'USDT',
    network: 'TON',
    label: 'USDT (TON)',
    shortLabel: 'TON',
    coin: 'usdt',
    symbol: '₮',
    decimals: PAYOUT_DECIMALS,
    instant: false,
    defaultFee: 0.5,
    maxFee: 100,
    feeUnit: 'USDT',
    badge: 'По комиссии сети',
    walletPlaceholder: 'UQ… или EQ…',
    walletHint: 'Вывод USDT в сети TON с вычетом комиссии сети. Адрес начинается с UQ или EQ (48 символов).',
    walletPattern: /^(?:EQ|UQ)[A-Za-z0-9_-]{46}$/,
    walletError: 'Укажите корректный адрес для USDT (TON): начинается с UQ или EQ, 48 символов.',
    txExample: 'https://tonviewer.com/transaction/…',
  },
  BTC: {
    id: 'BTC',
    payoutCurrency: 'BTC',
    network: 'BTC',
    label: 'Bitcoin (BTC)',
    shortLabel: 'BTC',
    coin: 'btc',
    symbol: '₿',
    decimals: BTC_DECIMALS,
    instant: false,
    defaultFee: 0.00005,
    maxFee: 0.05,
    feeUnit: 'BTC',
    badge: 'По комиссии сети',
    walletPlaceholder: 'bc1… / 1… / 3…',
    walletHint: 'Вывод в Bitcoin (BTC) с вычетом комиссии сети. Адрес начинается с bc1, 1 или 3.',
    walletPattern: /^(?:bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{25,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
    walletError: 'Укажите корректный Bitcoin-адрес (начинается с bc1, 1 или 3).',
    txExample: 'https://mempool.space/tx/…',
  },
};

const PAYOUT_OPTION_LIST = Object.values(PAYOUT_OPTIONS);
const PAYOUT_IDS = PAYOUT_OPTION_LIST.map((o) => o.id);
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

// У новых заявок валюта и сеть задаются при создании (по умолчанию USDT BEP-20).
// Старые читаем как записаны: до появления поля network выплаты в BTC были с network = null.
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
  const opt = findPayoutOption({ payoutCurrency: cur, network: order.network });
  if (opt) return opt.label;
  return `${cur} (${order.network === PAYOUT_NETWORK ? 'BEP-20' : order.network})`;
}
const payoutDecimals = (cur = PAYOUT_CURRENCY) => cur === PAYOUT_CURRENCY ? PAYOUT_DECIMALS : BTC_DECIMALS;

const normalizeNetworkAlias = (v) => {
  const s = norm(v);
  if (!s) return null;
  if (s === 'BEP-20' || s === 'BEP20' || s === 'BSC') return 'BEP20';
  if (s === 'TRC-20' || s === 'TRC20' || s === 'TRON') return 'TRC20';
  if (s === 'ERC-20' || s === 'ERC20' || s === 'ETH') return 'ERC20';
  if (s === 'TON') return 'TON';
  if (s === 'BTC' || s === 'BITCOIN') return 'BTC';
  return s;
};

// Определяем выбранную сеть/валюту выплаты. Молчание означает моментальный USDT (BEP-20) без комиссии.
function findPayoutOption(input) {
  if (!input) return PAYOUT_OPTIONS.USDT_BEP20;
  if (typeof input === 'string') {
    const k = norm(input);
    if (PAYOUT_OPTIONS[k]) return PAYOUT_OPTIONS[k];
    const net = normalizeNetworkAlias(k);
    if (net === 'BTC') return PAYOUT_OPTIONS.BTC;
    if (net) return PAYOUT_OPTION_LIST.find((o) => o.network === net) || null;
    return null;
  }
  if (input.id && PAYOUT_OPTIONS[norm(input.id)]) return PAYOUT_OPTIONS[norm(input.id)];
  if (input.payoutId != null) {
    return PAYOUT_OPTIONS[norm(input.payoutId)] || null;
  }
  const curRaw = input.payoutCurrency != null ? norm(input.payoutCurrency) : null;
  const netRaw = input.network != null
    ? normalizeNetworkAlias(input.network)
    : input.payoutNetwork != null
      ? normalizeNetworkAlias(input.payoutNetwork)
      : null;
  if (input.network != null && input.payoutNetwork != null && normalizeNetworkAlias(input.network) !== normalizeNetworkAlias(input.payoutNetwork)) {
    return null;
  }
  if (curRaw === null && netRaw === null) return PAYOUT_OPTIONS.USDT_BEP20;
  if (curRaw === 'BTC' || curRaw === 'BITCOIN') {
    if (netRaw !== null && netRaw !== 'BTC') return null;
    return PAYOUT_OPTIONS.BTC;
  }
  if (curRaw === null || curRaw === 'USDT') {
    if (netRaw === null) return PAYOUT_OPTIONS.USDT_BEP20;
    if (netRaw === 'BTC' && curRaw === 'USDT') return null;
    return PAYOUT_OPTION_LIST.find((o) => o.network === netRaw) || null;
  }
  return null;
}

function supportsPayout(reqBody) {
  return !!findPayoutOption(reqBody);
}

// Цена 1 BTC в USD.
function btcUsdQuote(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1000 && n <= 10_000_000 ? n : null;
}

function isPayoutEnabled(settings, optionOrId) {
  const opt = typeof optionOrId === 'object' ? optionOrId : findPayoutOption(optionOrId);
  if (!opt) return false;
  if (opt.id === 'USDT_BEP20') {
    return !settings?.payoutEnabled || settings.payoutEnabled.USDT_BEP20 !== false;
  }
  if (settings?.payoutEnabled && settings.payoutEnabled[opt.id] === false) return false;
  if (opt.payoutCurrency === 'BTC' && !btcUsdQuote(settings?.btcUsd)) return false;
  return true;
}

function clampNetworkFee(value, opt) {
  if (!opt || opt.instant || opt.id === 'USDT_BEP20') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return opt.defaultFee;
  const max = opt.maxFee || 100;
  return Math.round(Math.min(n, max) * 10 ** opt.decimals) / 10 ** opt.decimals;
}

function networkFeeOf(settings, optionOrId) {
  const opt = typeof optionOrId === 'object' ? optionOrId : findPayoutOption(optionOrId);
  if (!opt || opt.instant || opt.id === 'USDT_BEP20') return 0;
  const raw = settings?.networkFees && typeof settings.networkFees === 'object'
    ? settings.networkFees[opt.id]
    : undefined;
  return raw === undefined ? opt.defaultFee : clampNetworkFee(raw, opt);
}

function publicPayoutOptions(settings) {
  return PAYOUT_OPTION_LIST.map((opt) => ({
    id: opt.id,
    payoutCurrency: opt.payoutCurrency,
    network: opt.network,
    label: opt.label,
    shortLabel: opt.shortLabel,
    coin: opt.coin,
    symbol: opt.symbol,
    decimals: opt.decimals,
    instant: opt.instant,
    networkFee: networkFeeOf(settings, opt),
    feeUnit: opt.feeUnit,
    badge: opt.badge,
    walletPlaceholder: opt.walletPlaceholder,
    walletHint: opt.walletHint,
    walletPattern: opt.walletPattern.source,
    walletError: opt.walletError,
    txExample: opt.txExample,
    enabled: isPayoutEnabled(settings, opt),
  }));
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

// Проверка адреса кошелька под выбранную сеть/валюту выплаты.
function validateWallet(wallet, payoutOptionOrNetwork = null) {
  const opt = (typeof payoutOptionOrNetwork === 'object' && payoutOptionOrNetwork && payoutOptionOrNetwork.walletPattern)
    ? payoutOptionOrNetwork
    : (findPayoutOption(payoutOptionOrNetwork) || PAYOUT_OPTIONS.USDT_BEP20);
  return opt.walletPattern.test(String(wallet ?? '').trim()) ? null : opt.walletError;
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

// Уменьшаем комиссию карты на указанное число процентных пунктов (не процентов от комиссии).
function rateAfterFeeDiscount(settings, currency, discountPercent = 1) {
  const pair = find(currency);
  if (!pair || pair.kind !== 'gift') return { rate: null, feeDiscountPercent: 0 };
  const fee = feeOf(settings, pair.key);
  const requested = clampFee(discountPercent);
  const feeDiscountPercent = Math.min(fee, requested);
  return {
    rate: feeDiscountPercent > 0 ? giftRateFromPercent(fee - feeDiscountPercent, settings) : rateOf(settings, pair.key),
    feeDiscountPercent,
  };
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

// Сколько криптовалюты получит клиент за выбранную карту и сеть выплаты.
// BEP-20: моментальный вывод с нулевой комиссией сети.
// BTC / TRC-20 / ERC-20 / TON: из суммы выплаты вычитается комиссия сети.
// feeDiscountPercent уменьшает комиссию карты на процентные пункты; промокод затем
// применяется к уже сниженному курсу.
function giftPayout(settings, units, currency = GIFT_KEY, promoPercent = 0, feeDiscountPercent = 0, payoutOptionOrNetwork = null) {
  const pair = find(currency);
  if (!pair || pair.kind !== 'gift') return null;
  const opt = (typeof payoutOptionOrNetwork === 'object' && payoutOptionOrNetwork && payoutOptionOrNetwork.id)
    ? payoutOptionOrNetwork
    : (findPayoutOption(payoutOptionOrNetwork) || PAYOUT_OPTIONS.USDT_BEP20);
  const regularRate = rateOf(settings, pair.currency);
  const discount = rateAfterFeeDiscount(settings, pair.key, feeDiscountPercent);
  const baseUsdtRate = discount.feeDiscountPercent > 0 ? discount.rate : regularRate;
  if (!(baseUsdtRate > 0)) return null;
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return null;

  let convertFactor = 1;
  let btcUsd = null;
  if (opt.payoutCurrency === 'BTC') {
    btcUsd = btcUsdQuote(settings?.btcUsd);
    const usdtUsd = usdtUsdQuote(settings?.usdtUsd) || 1;
    if (!(btcUsd > 0)) return null;
    convertFactor = usdtUsd / btcUsd;
  }

  const p = Number(promoPercent);
  const appliedPercent = Number.isFinite(p) && p > 0 ? Math.min(p, 50) : 0;
  const baseRate = Math.round((baseUsdtRate * convertFactor) * 1e12) / 1e12;
  const effectiveUsdtRate = appliedPercent > 0 ? applyPromoToRate(baseUsdtRate, appliedPercent) : baseUsdtRate;
  const effectiveRate = appliedPercent > 0 ? Math.round((effectiveUsdtRate * convertFactor) * 1e12) / 1e12 : baseRate;

  const scale = 10 ** opt.decimals;
  const baseGross = Math.floor(n * baseRate * scale + 1e-6) / scale;
  const grossCrypto = appliedPercent > 0 ? Math.floor(n * effectiveRate * scale + 1e-6) / scale : baseGross;
  const networkFee = networkFeeOf(settings, opt);
  const baseNet = Math.max(0, Math.round((baseGross - networkFee) * scale) / scale);
  const crypto = Math.max(0, Math.round((grossCrypto - networkFee) * scale) / scale);
  const bonusCrypto = appliedPercent > 0 ? Math.max(0, Math.round((grossCrypto - baseGross) * scale) / scale) : 0;
  return {
    crypto,
    grossCrypto,
    baseCrypto: baseNet,
    bonusCrypto,
    networkFee,
    instant: opt.instant,
    payoutId: opt.id,
    payoutDecimals: opt.decimals,
    rate: effectiveRate,
    baseRate,
    cardRate: baseRate,
    regularRate: opt.payoutCurrency === 'BTC' ? Math.round((regularRate * convertFactor) * 1e12) / 1e12 : regularRate,
    feeDiscountPercent: discount.feeDiscountPercent,
    promoPercent: appliedPercent,
    payoutCurrency: opt.payoutCurrency,
    network: opt.network,
    usdtUsd: settings.usdtUsd,
    btcUsd,
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
  rateAfterFeeDiscount,
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
  BTC_DECIMALS,
  PAYOUT_OPTIONS,
  PAYOUT_OPTION_LIST,
  PAYOUT_IDS,
  findPayoutOption,
  isPayoutEnabled,
  clampNetworkFee,
  networkFeeOf,
  publicPayoutOptions,
  btcUsdQuote,
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
