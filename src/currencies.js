// Direction registry: USD gift cards only → BTC.
// The single place where setting keys, precision, address rules and denominations are defined.
// key — stable direction identifier (used in settings and orders).
//
// direction — always 'sell': the client gives the USD gift-card code, gets paid in BTC.
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
    decimals: 0, // the face value is stored as a whole number of dollars
    display: 0,
    rateDecimals: 8,
    // Shared BTC rate per $1 for USD gift cards, accounting for giftPercent.
    rateKey: 'rateGOOGLEUSD',
    baseKey: null,
    feeKey: 'giftPercent',
    rateLabel: 'BTC per $1 of face value',
    unit: 'USD',
    step: 10,
    minUnits: 10,
    walletOptional: false,
    walletHint: 'Bitcoin wallet address (bc1… / 1… / 3…)',
    walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    walletError: 'Check the Bitcoin wallet address — it looks invalid.',
    infoNote:
      'You can buy a card at any marketplace — Yandex Market, Ozon, Wildberries, and others. ' +
      'A US-region card denominated in USD is required; cards from other regions or currencies are not accepted.',
    currencyNote: 'Check the card region: USA, nominal currency — USD ($).',
    ttlMinutes: 60,
    note: 'The operator will verify the card code manually and pay out BTC to the specified wallet.',
  };
}

const PAIRS = {
  // All gift cards are paid out in BTC at the shared USD/BTC rate.
  GOOGLE_USD: giftPair('GOOGLE_USD', 'Google Gift Card', 'google', '🎁'),
  ITUNES_USD: giftPair('ITUNES_USD', 'iTunes Gift Card', 'itunes', '🎵'),
  XBOX_USD: giftPair('XBOX_USD', 'Xbox Gift Card', 'xbox', '🎮'),
  APPLE_STORE_USD: giftPair('APPLE_STORE_USD', 'Apple Store Gift Card', 'apple', '🍎'),
};

const LIST = Object.values(PAIRS);

const norm = (v) => String(v ?? '').trim().toUpperCase();

// Direction key from the currency. Gift cards have no network — cryptocurrencies are no longer accepted.
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

// Final client rate (BTC per $1 of face value including the fee). null — the direction is not configured yet.
function rateOf(settings, currency) {
  const pair = find(currency);
  if (!pair || !settings) return null;
  if (!isEnabled(settings, pair.key)) return null;
  const rate = Number(settings[pair.rateKey]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

const isGift = (currency) => !!find(currency);

const gift = (key = GIFT_KEY) => PAIRS[norm(key)] || PAIRS[GIFT_KEY];

// New gift orders are paid out in BTC only.
const payoutCurrency = (currency) => 'BTC';
const payoutCurrencyOf = (order) => order ? 'BTC' : null;

function payoutDecimals() {
  return 8;
}

// Face-value step (multiple).
const stepOf = () => 10;

const minUnitsOf = () => 10;

// Rounds the face value down to an allowed value (multiple of $10, at least $10).
function floorUnits(units) {
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 10 + 1e-9) * 10;
}

// Returns an error message or null if the face value fits the direction.
function validateUnits(units) {
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return 'Enter the card amount.';
  if (n < 10) return 'Minimum amount is $10.';
  if (Math.abs(n / 10 - Math.round(n / 10)) > 1e-9) return 'The amount must be a multiple of $10.';
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

// Returns an error message or null if the Bitcoin wallet address is valid.
function validateWallet(wallet) {
  const w = String(wallet ?? '').trim();
  if (!w) return 'Enter the payout wallet address.';
  if (/\s/.test(w)) return 'The wallet address must not contain spaces.';
  if (w.length < 26 || w.length > 128) return 'Check the Bitcoin wallet address — it looks invalid.';
  if (!/^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(w)) return 'Check the Bitcoin wallet address — it looks invalid.';
  return null;
}

// Public direction description for the client: only the final rate including the fee.
// The giftPercent fee is never shown — only the operator in the bot sees it.
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
    rateLabel: 'BTC per $1 of face value',
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

// BTC per $1 of face value after the giftPercent discount.
function giftRateFromPercent(percent, settings) {
  const p = Number(percent);
  const safe = Number.isFinite(p) ? Math.min(Math.max(p, 0), 50) : 0;
  const spot = giftSpotRate(settings);
  if (!(spot > 0)) return null;
  return Math.round((spot * (1 - safe / 100)) * 1e12) / 1e12;
}

// Inverse calculation: which discount percent corresponds to a BTC rate.
function giftPercentFromRate(rate, settings) {
  const r = Number(rate);
  const spot = giftSpotRate(settings);
  if (!(r > 0) || !(spot > 0) || r > spot) return 0;
  return Math.round((1 - r / spot) * 10000) / 100;
}

// How much BTC the client gets for the chosen card. The payout is rounded down to the satoshi.
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
