// Официальные курсы BTC/LTC к рублю: автообновление с публичных бирж.
// Итоговый курс для клиентов = официальный × (1 + feePercent/100).
// Комиссию задаёт оператор в админ-панели, официальный курс трогать не нужно.
const store = require('./store');

const INTERVAL_MS = Number(process.env.RATES_INTERVAL_MS) || 5 * 60 * 1000;
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
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin&vs_currencies=rub'
  );
  return { btc: num(d?.bitcoin?.rub), ltc: num(d?.litecoin?.rub) };
}

// Coinbase: кросс-курсы BTC→RUB и LTC→RUB.
async function fromCoinbase() {
  const [btc, ltc] = await Promise.all([
    fetchJson('https://api.coinbase.com/v2/exchange-rates?currency=BTC'),
    fetchJson('https://api.coinbase.com/v2/exchange-rates?currency=LTC'),
  ]);
  return { btc: num(btc?.data?.rates?.RUB), ltc: num(ltc?.data?.rates?.RUB) };
}

// Kraken (USD-пары) × курс ЦБ (USD→RUB).
async function fromKrakenCbr() {
  const [ticker, cbr] = await Promise.all([
    fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,LTCUSD'),
    fetchJson('https://www.cbr-xml-daily.ru/daily_json.js'),
  ]);
  const usd = num(cbr?.Valute?.USD?.Value);
  const btcUsd = num(ticker?.result?.XXBTZUSD?.c?.[0]);
  const ltcUsd = num(ticker?.result?.XLTCZUSD?.c?.[0]);
  return { btc: btcUsd * usd, ltc: ltcUsd * usd };
}

const SOURCES = [
  ['coingecko', fromCoinGecko],
  ['coinbase', fromCoinbase],
  ['kraken+cbr', fromKrakenCbr],
];

// Грубая проверка правдоподобности, чтобы мусор из API не попал в курсы.
function sane({ btc, ltc }) {
  return (
    Number.isFinite(btc) && Number.isFinite(ltc) &&
    btc > 10000 && ltc > 100 && btc / ltc > 50 && btc / ltc < 50000
  );
}

async function fetchOfficial() {
  const errors = [];
  for (const [name, fn] of SOURCES) {
    try {
      const r = await fn();
      if (sane(r)) return { btc: Math.round(r.btc), ltc: Math.round(r.ltc), source: name };
      errors.push(`${name}: неправдоподобные значения`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(errors.join('; ') || 'нет источников курса');
}

const applyFee = (base, fee) => Math.max(1, Math.round(base * (1 + fee / 100)));

function applyRates(official) {
  return store.mutate((db) => {
    const fee = Number(db.settings.feePercent) || 0;
    db.settings.baseRateBTC = Math.round(official.btc);
    db.settings.baseRateLTC = Math.round(official.ltc);
    db.settings.rateBTC = applyFee(official.btc, fee);
    db.settings.rateLTC = applyFee(official.ltc, fee);
    db.settings.rateUpdatedAt = Date.now();
    db.settings.rateSource = official.source;
    return db.settings;
  });
}

// Пересчёт итоговых курсов после смены комиссии (официальные не трогаем).
function recomputeWithFee() {
  return store.mutate((db) => {
    const s = db.settings;
    const fee = Number(s.feePercent) || 0;
    if (s.baseRateBTC) s.rateBTC = applyFee(s.baseRateBTC, fee);
    if (s.baseRateLTC) s.rateLTC = applyFee(s.baseRateLTC, fee);
    return s;
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

module.exports = { startRates, refreshRates, recomputeWithFee, applyFee, fetchOfficial };
