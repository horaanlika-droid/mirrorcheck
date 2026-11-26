// Прямое рыночное ценообразование USD/BTC для выплат за подарочные карты.
// Спот один, а курс выплаты у КАЖДОЙ карты свой: spot × (1 − cardFees[key] / 100).
const store = require('./store');
const currencies = require('./currencies');

const INTERVAL_MS = Number(process.env.RATES_INTERVAL_MS) || 5 * 60 * 1000;
const DISABLED = process.env.RATES_DISABLED === '1';
const SOURCES = [
  ['coingecko', async () => {
    const d = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    return Number(d?.bitcoin?.usd);
  }],
  ['kraken', async () => {
    const d = await fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
    return Number(d?.result?.XXBTZUSD?.c?.[0]);
  }],
  ['coinbase', async () => {
    const d = await fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
    return Number(d?.price);
  }],
  ['binance', async () => {
    const d = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    return Number(d?.price);
  }],
];

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'PricelexWorldwide-exchange/1.0', accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function clean(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 10_000 && n <= 1_000_000 ? n : null;
}

async function fetchOfficial() {
  const values = [];
  const errors = [];
  await Promise.all(SOURCES.map(async ([name, fetchRate]) => {
    try {
      const btcUsd = clean(await fetchRate());
      if (btcUsd) values.push({ source: name, btcUsd });
      else errors.push(`${name}: invalid BTC/USD quote`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }));
  if (!values.length) throw new Error(errors.join('; ') || 'no BTC/USD sources available');
  // Медиана даёт устойчивый центральный курс и не зависит от одной площадки.
  const sorted = values.map((v) => v.btcUsd).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const btcUsd = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { btcUsd, source: values.map((v) => v.source).join('+') };
}

function applyRates(official) {
  return store.mutate((db) => {
    const s = db.settings;
    s.btcUsd = Math.round(Number(official.btcUsd) * 100) / 100;
    s.cardRates = currencies.allCardRates(s);
    s.rateUpdatedAt = Date.now();
    s.rateSource = official.source;
    return s;
  });
}

// Пересчитать курсы всех карт по их индивидуальным скидкам (после правки настроек).
function recomputeGiftRates() {
  return store.mutate((db) => {
    const s = db.settings;
    s.cardRates = currencies.allCardRates(s);
    return s.cardRates;
  });
}

async function refreshRates() {
  const official = await fetchOfficial();
  return { settings: applyRates(official), source: official.source };
}

function startRates() {
  if (DISABLED) {
    console.log('[rates] автообновление отключено (RATES_DISABLED=1)');
    return null;
  }
  console.log(`[rates] обновление BTC/USD каждые ${Math.round(INTERVAL_MS / 1000)} с`);
  refreshRates()
    .then(({ source }) => console.log('[rates] BTC/USD обновлён из:', source))
    .catch((e) => console.error('[rates] первое обновление не удалось; используем сохранённый курс:', e.message));
  const timer = setInterval(() => {
    refreshRates()
      .then(({ source }) => console.log('[rates] BTC/USD обновлён из:', source))
      .catch((e) => console.error('[rates] обновление не удалось:', e.message));
  }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = { startRates, refreshRates, recomputeGiftRates, applyRates, fetchOfficial };
