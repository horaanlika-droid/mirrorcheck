// Официальные курсы BTC/GRAM к рублю: автообновление с публичных бирж.
// Итоговый курс для клиентов = официальный × (1 + feePercent/100).
// Комиссию задаёт оператор в админ-панели, официальный курс трогать не нужно.
const store = require('./store');

// Курс обновляется каждые 10 секунд: клиент видит живую цену, график плотнеет.
// Источники ротируются, чтобы ни один API не получал больше ~2 запросов/мин.
const INTERVAL_MS = Number(process.env.RATES_INTERVAL_MS) || 10 * 1000;
const DISABLED = process.env.RATES_DISABLED === '1';

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'PRICELEX-exchange/1.0', accept: 'application/json' },
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

// CoinGecko: прямые пары к рублю.
async function fromCoinGecko() {
  const d = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,gram&vs_currencies=rub'
  );
  return { btc: num(d?.bitcoin?.rub), gram: num(d?.gram?.rub) };
}

// Coinbase: кросс-курсы BTC→RUB и GRAM→RUB.
async function fromCoinbase() {
  const [btc, gram] = await Promise.all([
    fetchJson('https://api.coinbase.com/v2/exchange-rates?currency=BTC'),
    fetchJson('https://api.coinbase.com/v2/exchange-rates?currency=GRAM'),
  ]);
  return { btc: num(btc?.data?.rates?.RUB), gram: num(gram?.data?.rates?.RUB) };
}

// Kraken (USD-пары) × курс ЦБ (USD→RUB).
async function fromKrakenCbr() {
  const [ticker, cbr] = await Promise.all([
    fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,GRAMUSD'),
    fetchJson('https://www.cbr-xml-daily.ru/daily_json.js'),
  ]);
  const usd = num(cbr?.Valute?.USD?.Value);
  const btcUsd = num(ticker?.result?.XXBTZUSD?.c?.[0]);
  const gramUsd = num(
    ticker?.result?.GRAMUSD?.c?.[0] || ticker?.result?.XGRAMZUSD?.c?.[0]
  );
  return { btc: btcUsd * usd, gram: gramUsd * usd };
}

const SOURCES = [
  ['coingecko', fromCoinGecko],
  ['coinbase', fromCoinbase],
  ['kraken+cbr', fromKrakenCbr],
];

// Грубая проверка правдоподобности, чтобы мусор из API не попал в курсы.
// У GRAM другой порядок цены, чем у LTC, поэтому диапазон пары шире.
function sane({ btc, gram }) {
  const ratio = btc / gram;
  return (
    Number.isFinite(btc) && Number.isFinite(gram) &&
    btc > 10000 && gram > 0.01 && ratio > 1000 && ratio < 10000000
  );
}

let sourceCursor = 0;

async function fetchOfficial() {
  const errors = [];
  // Начинаем каждый цикл со следующего источника: нагрузка распределяется равномерно.
  const order = SOURCES.map((_, i) => SOURCES[(sourceCursor + i) % SOURCES.length]);
  for (const [name, fn] of order) {
    try {
      const r = await fn();
      if (sane(r)) {
        sourceCursor = (sourceCursor + 1) % SOURCES.length;
        return { btc: Math.round(r.btc), gram: Math.round(r.gram), source: name };
      }
      errors.push(`${name}: неправдоподобные значения`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(errors.join('; ') || 'нет источников курса');
}

const applyFee = (base, fee) => Math.max(1, Math.round(base * (1 + fee / 100)));

function applyRates(official) {
  const settings = store.mutate((db) => {
    const fee = Number(db.settings.feePercent) || 0;
    db.settings.baseRateBTC = Math.round(official.btc);
    db.settings.baseRateGRAM = Math.round(official.gram);
    db.settings.rateBTC = applyFee(official.btc, fee);
    db.settings.rateGRAM = applyFee(official.gram, fee);
    db.settings.rateUpdatedAt = Date.now();
    db.settings.rateSource = official.source;
    return db.settings;
  });
  // Точка для графика курса в Web App — только реальные наблюдения.
  store.pushRatePoint({ btc: settings.rateBTC, gram: settings.rateGRAM, at: settings.rateUpdatedAt });
  return settings;
}

// Пересчёт итоговых курсов после смены комиссии (официальные не трогаем).
function recomputeWithFee() {
  const s = store.mutate((db) => {
    const set = db.settings;
    const fee = Number(set.feePercent) || 0;
    if (set.baseRateBTC) set.rateBTC = applyFee(set.baseRateBTC, fee);
    if (set.baseRateGRAM) set.rateGRAM = applyFee(set.baseRateGRAM, fee);
    return set;
  });
  // Оператор изменил курс для клиентов — это тоже точка на графике.
  store.pushRatePoint({ btc: s.rateBTC, gram: s.rateGRAM });
  return s;
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

module.exports = { startRates, refreshRates, recomputeWithFee, applyFee, fetchOfficial };
