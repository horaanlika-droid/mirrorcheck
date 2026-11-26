// Официальные курсы BTC → ₽ и USD → ₽: автообновление с публичных источников.
// Выплата за gift-карту считается по кроссу USD/RUB ÷ BTC/RUB с комиссией giftPercent.
// Источник курса доллара для карт — ЦБ РФ (номинал карты указан в долларах).
const store = require('./store');
const currencies = require('./currencies');

const INTERVAL_MS = Number(process.env.RATES_INTERVAL_MS) || 5 * 60 * 1000;
const DISABLED = process.env.RATES_DISABLED === '1';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether&vs_currencies=rub';
const CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
const KRAKEN_URL = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD';

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'VEGA-exchange/1.0', accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

// CoinGecko: прямые пары к рублю (bitcoin, tether ≈ доллар).
async function fromCoinGecko() {
  const d = await fetchJson(COINGECKO_URL);
  return { btc: num(d?.bitcoin?.rub), usd: num(d?.tether?.rub) };
}

// ЦБ РФ: официальный курс доллара. Основной источник для gift-карт.
async function fromCbrUsd() {
  const cbr = await fetchJson(CBR_URL);
  const usd = num(cbr?.Valute?.USD?.Value);
  return { usd };
}

// Kraken (BTC/USD) × курс ЦБ (USD → RUB): запасной вариант для BTC.
async function fromKrakenCbr() {
  const [ticker, cbr] = await Promise.all([
    fetchJson(KRAKEN_URL),
    fetchJson(CBR_URL),
  ]);
  const usd = num(cbr?.Valute?.USD?.Value);
  const btcUsd = num(ticker?.result?.XXBTZUSD?.c?.[0]);
  return { btc: btcUsd * usd, usd };
}

// Источники возвращают частичный результат: курсы разных монет можно брать из разных источников.
const SOURCES = [
  ['coingecko', fromCoinGecko],
  ['cbr-usd', fromCbrUsd],
  ['kraken+cbr', fromKrakenCbr],
];

// Грубая проверка правдоподобности, чтобы мусор из API не попал в курсы.
function clean(part) {
  const out = {};
  const btc = Number(part?.btc);
  const usd = Number(part?.usd);
  if (Number.isFinite(btc) && btc > 10000 && btc < 1e9) out.btc = btc;
  if (Number.isFinite(usd) && usd > 20 && usd < 400) out.usd = usd;
  return out;
}

async function fetchOfficial() {
  const errors = [];
  const parts = {};
  await Promise.all(
    SOURCES.map(async ([name, fn]) => {
      try {
        const checked = clean(await fn());
        if (!Object.keys(checked).length) {
          errors.push(`${name}: неправдоподобные значения`);
          return;
        }
        parts[name] = checked;
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    })
  );

  const result = {};
  const sources = [];
  // BTC: первый источник, который дал курс BTC → ₽.
  for (const [name] of SOURCES) {
    const part = parts[name];
    if (!part || part.btc === undefined) continue;
    result.btc = part.btc;
    sources.push(name.split('-')[0]);
    break;
  }
  // USD: ЦБ РФ, затем рыночные оценки доллара (для gift-карт — приоритет ЦБ).
  for (const name of ['cbr-usd', 'kraken+cbr', 'coingecko']) {
    const part = parts[name];
    if (!part) continue;
    const usd = part.usd !== undefined ? part.usd : name === 'coingecko' ? part.tether : undefined;
    if (usd === undefined) continue;
    result.usd = usd;
    sources.push(name.split('-')[0]);
    break;
  }

  if (result.btc === undefined || result.usd === undefined) {
    throw new Error(errors.join('; ') || 'нет источников курса');
  }
  result.source = [...new Set(sources)].join('+') || 'manual';
  return result;
}

function applyRates(official) {
  return store.mutate((db) => {
    const s = db.settings;
    s.baseRateBTC = Math.round(official.btc);
    s.baseRateUSD = Math.round(official.usd * 100) / 100;
    // BTC-выплата за карту пересчитывается по официальным курсам и комиссии gift.
    s.rateGOOGLEUSD = currencies.giftRateFromPercent(s.giftPercent, s);
    s.rateUpdatedAt = Date.now();
    s.rateSource = official.source;
    return s;
  });
}

// Пересчёт только курса gift-карт после изменения комиссии или резервного курса USD.
function recomputeGiftRate() {
  return store.mutate((db) => {
    const s = db.settings;
    s.rateGOOGLEUSD = currencies.giftRateFromPercent(s.giftPercent, s);
    return s.rateGOOGLEUSD;
  });
}

async function refreshRates() {
  const official = await fetchOfficial();
  return { settings: applyRates(official), source: official.source };
}

function startRates() {
  if (DISABLED) {
    console.log('[rates] автообновление курса отключено (RATES_DISABLED=1)');
    return null;
  }
  console.log(`[rates] автообновление официального курса каждые ${Math.round(INTERVAL_MS / 1000)} c`);
  refreshRates()
    .then(({ source }) => console.log('[rates] курс обновлён, источник:', source))
    .catch((e) => console.error('[rates] первичное обновление не удалось, оставлены текущие курсы:', e.message));
  const timer = setInterval(() => {
    refreshRates()
      .then(({ source }) => console.log('[rates] курс обновлён, источник:', source))
      .catch((e) => console.error('[rates] обновление не удалось:', e.message));
  }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = {
  startRates,
  refreshRates,
  recomputeGiftRate,
  applyRates,
  fetchOfficial,
};
