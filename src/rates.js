// Официальные курсы BTC/GRAM к рублю: автообновление с публичных бирж.
// Итоговый курс для клиентов = официальный × (1 + feePercent/100).
// Комиссию задаёт оператор в админ-панели, официальный курс трогать не нужно.
//
// Как считается официальный курс:
//  1. Цены BTC и GRAM в долларах берутся из 12 независимых источников: биржи
//     Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate, MEXC, HTX, Bitget,
//     а также TON API и CoinGecko. Каждые 10 секунд опрашиваются 4 источника
//     по кругу — один API получает около двух запросов в минуту.
//  2. По каждой монете берётся медиана свежих котировок (не старше минуты).
//     Котировки дальше 5% от медианы отбрасываются: замёрзшая пара или чужой
//     токен с похожим названием в курс не попадут.
//  3. Доллары переводятся в рубли по курсу ЦБ РФ; запасные источники —
//     cbr.ru, open.er-api.com и currency-api. Курс доллара обновляется раз
//     в 30 минут и сохраняется в базе на случай перезапуска.
//  4. Источник, ответивший ошибкой (429 — лимит, 403/451 — блокировка по
//     региону, таймаут), уходит на паузу с растущей задержкой и не тормозит
//     остальных.
//
// GRAM — бывший Toncoin: 15.06.2026 TON переименовали в GRAM. Тикеры ниже
// сверены с API бирж 25.09.2026. Ловушки: у CoinGecko id «gram» — другой токен
// (≈ $0.0005), нужен «the-open-network»; на Binance старая пара TONUSDT
// остановлена (BREAK) и отдаёт замёрзшую цену; Kraken пока торгует TONUSD.
const store = require('./store');

const INTERVAL_MS = Number(process.env.RATES_INTERVAL_MS) || 10 * 1000;
const DISABLED = process.env.RATES_DISABLED === '1';

const ASSETS = ['btc', 'gram'];
const PER_CYCLE = 4; // источников за один цикл автообновления
const TIMEOUT_MS = 8000; // таймаут одного HTTP-запроса
const QUOTE_TTL_MS = Math.max(60 * 1000, 3 * INTERVAL_MS); // котировка старше — не свежая
const MAX_DEVIATION = 0.05; // дальше 5% от медианы — выброс
const FX_TTL_MS = 30 * 60 * 1000; // курс доллара обновляем раз в 30 минут
const FX_STALE_MS = 3 * 24 * 3600 * 1000; // совсем старый курс доллара уступает кросс-курсу
// Если официальный курс не обновлялся дольше, точки графика за этот период
// (стартовые или устаревшие курсы) не отражают рынок и убираются.
const HISTORY_GAP_MS = 30 * 60 * 1000;

// Рамки правдоподобия в долларах: отсекают мусор и чужие токены.
const BOUNDS_USD = { btc: [1000, 10_000_000], gram: [0.05, 1000] };
const USD_RUB_BOUNDS = [20, 1000];

const UA = 'Mozilla/5.0 (compatible; PRICELEX-rates/2.0)';

/* ---------- HTTP ---------- */

const fail = (message, props = {}) => Object.assign(new Error(message), props);

function parseRetryAfter(value) {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function httpGet(fetchImpl, url, { as = 'json', timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : '*/*' },
    });
    if (!res.ok) {
      throw fail(`HTTP ${res.status}`, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')),
      });
    }
    return as === 'text' ? await res.text() : await res.json();
  } catch (e) {
    if (e?.name === 'AbortError') throw fail('таймаут');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Короткое описание ошибки для логов и сообщения оператору.
function describe(e) {
  if (!e) return 'ошибка';
  if (e.status) return `HTTP ${e.status}`;
  if (e.name === 'SyntaxError') return 'ответ не JSON';
  const code = e.cause?.code || e.code;
  if (code) return `сеть: ${code}`;
  if (e.message === 'fetch failed') return 'сеть недоступна';
  return String(e.message || e).slice(0, 120);
}

// Лимит (429), блокировка (403/451) или неверная пара (400/404) сами не проходят —
// такой источник отдыхает дольше. Таймауты и 5xx обычно проходят за минуты.
function backoffMs(e, failures) {
  const persistent = e?.api || (e?.status >= 400 && e?.status < 500);
  const base = persistent ? 2 * 60 * 1000 : 15 * 1000;
  const cap = persistent ? 30 * 60 * 1000 : 5 * 60 * 1000;
  let ms = Math.min(cap, base * 2 ** Math.min(failures - 1, 10));
  if (e?.retryAfterMs) ms = Math.max(ms, Math.min(e.retryAfterMs, 60 * 60 * 1000));
  return ms;
}

const fmtPause = (ms) =>
  ms < 60 * 1000 ? `${Math.round(ms / 1000)} с` : ms < 3600 * 1000 ? `${Math.round(ms / 60000)} мин` : `${Math.round(ms / 3600000)} ч`;

/* ---------- источники ---------- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : NaN;
};
const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Пара не найдена (переименование, делистинг) — можно попробовать запасной тикер.
const notFound = (e) => Boolean(e?.notFound) || e?.status === 400 || e?.status === 404;
const orElse = (primary, fallback) =>
  primary().catch((e) => {
    if (notFound(e)) return fallback();
    throw e;
  });

// Монеты запрашиваются параллельно: источник полезен, даже если ответила одна пара.
async function each(getters) {
  const keys = Object.keys(getters);
  const settled = await Promise.allSettled(keys.map((k) => getters[k]()));
  const out = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out[keys[i]] = r.value;
  });
  if (!Object.keys(out).length) throw settled[0].reason;
  return out;
}

// Каждый источник возвращает цены в долларах { btc?, gram? } и, если умеет,
// рублёвый кросс-курс usdRub — запасной вариант, если ЦБ и остальные недоступны.
// Котировки в USDT считаем долларовыми: расхождение — сотые доли процента.
const SOURCES = [
  {
    name: 'binance',
    // data-api.binance.vision — официальный публичный хост рыночных данных Binance.
    async fetch(get) {
      const symbols = encodeURIComponent(JSON.stringify(['BTCUSDT', 'GRAMUSDT']));
      const list = await get(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${symbols}`);
      const price = Object.fromEntries((Array.isArray(list) ? list : []).map((t) => [t.symbol, t.price]));
      return { btc: num(price.BTCUSDT), gram: num(price.GRAMUSDT) };
    },
  },
  {
    name: 'bybit',
    async fetch(get) {
      const last = async (symbol) => {
        const d = await get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`);
        if (d?.retCode !== 0) throw fail(d?.retMsg || `bybit retCode ${d?.retCode}`, { api: true });
        return num(d.result?.list?.[0]?.lastPrice);
      };
      return each({ btc: () => last('BTCUSDT'), gram: () => last('GRAMUSDT') });
    },
  },
  {
    name: 'okx',
    async fetch(get) {
      const last = async (instId) => {
        const d = await get(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
        if (d?.code !== '0') throw fail(d?.msg || `okx code ${d?.code}`, { api: true });
        return num(d.data?.[0]?.last);
      };
      return each({ btc: () => last('BTC-USDT'), gram: () => last('GRAM-USDT') });
    },
  },
  {
    name: 'coinbase',
    async fetch(get) {
      const spot = async (pair) => num((await get(`https://api.coinbase.com/v2/prices/${pair}/spot`))?.data?.amount);
      return each({ btc: () => spot('BTC-USD'), gram: () => orElse(() => spot('GRAM-USD'), () => spot('TON-USD')) });
    },
  },
  {
    name: 'kraken',
    async fetch(get) {
      const last = async (pair) => {
        const d = await get(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
        if (d?.error?.length) {
          throw fail(d.error.join(', '), { api: true, notFound: d.error.some((x) => /unknown asset pair/i.test(x)) });
        }
        const t = d?.result && Object.values(d.result)[0];
        // Пара без сделок за сутки — замороженная, её цене верить нельзя.
        if (!t || !(Number(t.t?.[1]) > 0)) throw fail(`${pair}: нет сделок`, { api: true, notFound: true });
        return num(t.c?.[0]);
      };
      // Kraken пока торгует GRAM под старым тикером TON; после переименования возьмём GRAMUSD.
      return each({ btc: () => last('XBTUSD'), gram: () => orElse(() => last('TONUSD'), () => last('GRAMUSD')) });
    },
  },
  {
    name: 'kucoin',
    async fetch(get) {
      const d = await get('https://api.kucoin.com/api/v1/prices?base=USD&currencies=BTC,GRAM');
      return { btc: num(d?.data?.BTC), gram: num(d?.data?.GRAM) };
    },
  },
  {
    name: 'gate',
    async fetch(get) {
      const last = async (pair) => num((await get(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`))?.[0]?.last);
      return each({ btc: () => last('BTC_USDT'), gram: () => last('GRAM_USDT') });
    },
  },
  {
    name: 'mexc',
    // Параметр symbols MEXC игнорирует и отдаёт весь рынок — поэтому по паре на запрос.
    async fetch(get) {
      const last = async (symbol) => num((await get(`https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`))?.price);
      return each({ btc: () => last('BTCUSDT'), gram: () => last('GRAMUSDT') });
    },
  },
  {
    name: 'htx',
    async fetch(get) {
      const last = async (symbol) => {
        const d = await get(`https://api.huobi.pro/market/detail/merged?symbol=${symbol}`);
        if (d?.status !== 'ok') throw fail(d?.['err-msg'] || 'htx: ошибка', { api: true });
        return num(d.tick?.close);
      };
      return each({ btc: () => last('btcusdt'), gram: () => last('gramusdt') });
    },
  },
  {
    name: 'bitget',
    async fetch(get) {
      const last = async (symbol) => {
        const d = await get(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol}`);
        if (d?.code !== '00000') throw fail(d?.msg || `bitget code ${d?.code}`, { api: true });
        return num(d.data?.[0]?.lastPr);
      };
      return each({ btc: () => last('BTCUSDT'), gram: () => last('GRAMUSDT') });
    },
  },
  {
    name: 'tonapi',
    every: 30 * 1000, // без ключа — не чаще раза в 30 секунд
    // Нативная монета сети TON (теперь GRAM) в API по-прежнему называется «ton».
    async fetch(get) {
      const p = (await get('https://tonapi.io/v2/rates?tokens=ton&currencies=usd,rub'))?.rates?.TON?.prices;
      const gram = num(p?.USD);
      return { gram, usdRub: num(p?.RUB) / gram };
    },
  },
  {
    name: 'coingecko',
    every: 5 * 60 * 1000, // публичный API режет частые запросы (429) — редко и в последнюю очередь
    async fetch(get) {
      const d = await get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,the-open-network&vs_currencies=usd,rub');
      const btc = num(d?.bitcoin?.usd);
      return { btc, gram: num(d?.['the-open-network']?.usd), usdRub: num(d?.bitcoin?.rub) / btc };
    },
  },
];

// Курс доллара к рублю: первый ответивший по порядку.
const FX_SOURCES = [
  {
    name: 'ЦБ РФ',
    async fetch(get) {
      const usd = (await get('https://www.cbr-xml-daily.ru/daily_json.js'))?.Valute?.USD;
      return num(usd?.Value) / (num(usd?.Nominal) || 1);
    },
  },
  {
    name: 'ЦБ РФ (cbr.ru)',
    // XML в windows-1251, но нужные теги и числа — ASCII, поэтому кодировка не мешает.
    async fetch(get) {
      const xml = String(await get('https://www.cbr.ru/scripts/XML_daily.asp', { as: 'text' }));
      const m = xml.match(/<CharCode>USD<\/CharCode>\s*<Nominal>(\d+)<\/Nominal>[\s\S]*?<Value>([\d.,]+)<\/Value>/);
      return m ? num(m[2].replace(',', '.')) / (num(m[1]) || 1) : NaN;
    },
  },
  {
    name: 'open.er-api',
    async fetch(get) {
      return num((await get('https://open.er-api.com/v6/latest/USD'))?.rates?.RUB);
    },
  },
  {
    name: 'currency-api',
    async fetch(get) {
      const path = 'v1/currencies/usd.min.json';
      const d = await get(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/${path}`).catch(() =>
        get(`https://latest.currency-api.pages.dev/${path}`)
      );
      return num(d?.usd?.rub);
    },
  },
];

// Источники недельной истории курсов BTC/GRAM из онлайна.
// Приоритет: Binance (klines 1h) → Bybit (kline 60) → CoinGecko (market_chart 7d).
const HISTORY_SOURCES = [
  {
    name: 'binance',
    async fetch(get, hours = 168) {
      const fetchSymbol = async (sym) => {
        const u1 = `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1h&limit=${hours}`;
        const u2 = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=${hours}`;
        return get(u1).catch(() => get(u2));
      };
      const [btcRaw, gramRaw] = await Promise.all([
        fetchSymbol('BTCUSDT'),
        fetchSymbol('GRAMUSDT').catch(() => fetchSymbol('TONUSDT')),
      ]);
      if (!Array.isArray(btcRaw) || !btcRaw.length) throw fail('binance: пустой BTC');
      if (!Array.isArray(gramRaw) || !gramRaw.length) throw fail('binance: пустой GRAM');
      const btc = btcRaw
        .map((k) => ({ at: Number(k[0]), usd: num(k[4]) }))
        .filter((p) => p.at > 0 && inRange(p.usd, BOUNDS_USD.btc));
      const gram = gramRaw
        .map((k) => ({ at: Number(k[0]), usd: num(k[4]) }))
        .filter((p) => p.at > 0 && inRange(p.usd, BOUNDS_USD.gram));
      return { btc, gram };
    },
  },
  {
    name: 'bybit',
    async fetch(get, hours = 168) {
      const fetchSymbol = async (sym) => {
        const d = await get(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=60&limit=${hours}`);
        if (d?.retCode !== 0 && d?.retCode !== '0') throw fail(d?.retMsg || `bybit retCode ${d?.retCode}`);
        return d.result?.list;
      };
      const [btcRaw, gramRaw] = await Promise.all([
        fetchSymbol('BTCUSDT'),
        fetchSymbol('GRAMUSDT').catch(() => fetchSymbol('TONUSDT')),
      ]);
      if (!Array.isArray(btcRaw) || !btcRaw.length) throw fail('bybit: пустой BTC');
      if (!Array.isArray(gramRaw) || !gramRaw.length) throw fail('bybit: пустой GRAM');
      const btc = btcRaw
        .map((k) => ({ at: Number(k[0]), usd: num(k[4]) }))
        .filter((p) => p.at > 0 && inRange(p.usd, BOUNDS_USD.btc))
        .sort((a, b) => a.at - b.at);
      const gram = gramRaw
        .map((k) => ({ at: Number(k[0]), usd: num(k[4]) }))
        .filter((p) => p.at > 0 && inRange(p.usd, BOUNDS_USD.gram))
        .sort((a, b) => a.at - b.at);
      return { btc, gram };
    },
  },
  {
    name: 'coingecko',
    async fetch(get, hours = 168) {
      const days = Math.max(1, Math.ceil(hours / 24));
      const [btcData, gramData] = await Promise.all([
        get(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`),
        get(`https://api.coingecko.com/api/v3/coins/the-open-network/market_chart?vs_currency=usd&days=${days}`),
      ]);
      const btcRaw = btcData?.prices;
      const gramRaw = gramData?.prices;
      if (!Array.isArray(btcRaw) || !btcRaw.length) throw fail('coingecko: пустой BTC');
      if (!Array.isArray(gramRaw) || !gramRaw.length) throw fail('coingecko: пустой GRAM');
      const btc = btcRaw
        .map(([at, price]) => ({ at: Number(at), usd: num(price) }))
        .filter((p) => p.at > 0 && inRange(p.usd, BOUNDS_USD.btc));
      const gram = gramRaw
        .map(([at, price]) => ({ at: Number(at), usd: num(price) }))
        .filter((p) => p.at > 0 && inRange(p.usd, BOUNDS_USD.gram));
      return { btc, gram };
    },
  },
];

function mergeHistoryPoints({ btc, gram, usdRub }) {
  if (!Array.isArray(btc) || !Array.isArray(gram) || !btc.length || !gram.length) return [];
  const rateUsd = inRange(usdRub, USD_RUB_BOUNDS) ? usdRub : 85;

  const btcSorted = [...btc].sort((a, b) => a.at - b.at);
  const gramSorted = [...gram].sort((a, b) => a.at - b.at);

  const gramByHour = new Map();
  for (const g of gramSorted) {
    const h = Math.round(g.at / 3600000);
    gramByHour.set(h, g.usd);
  }

  const points = [];
  for (const b of btcSorted) {
    const h = Math.round(b.at / 3600000);
    let gUsd = gramByHour.get(h);
    if (!gUsd) {
      for (let dh = 1; dh <= 3; dh += 1) {
        if (gramByHour.has(h - dh)) { gUsd = gramByHour.get(h - dh); break; }
        if (gramByHour.has(h + dh)) { gUsd = gramByHour.get(h + dh); break; }
      }
    }
    if (!gUsd && gramSorted.length) {
      const nearest = gramSorted.reduce((best, cur) =>
        Math.abs(cur.at - b.at) < Math.abs(best.at - b.at) ? cur : best
      );
      if (Math.abs(nearest.at - b.at) <= 6 * 3600 * 1000) gUsd = nearest.usd;
    }

    if (gUsd && b.usd) {
      const baseBtc = Math.round(b.usd * rateUsd);
      const baseGram = Math.round(gUsd * rateUsd);
      points.push({
        at: b.at,
        baseBtc,
        baseGram,
      });
    }
  }
  return points;
}

// Если онлайн-источники недоступны (нет сети, сбой API), формируем плавную
// 7-дневную кривую на базе текущих курсов, чтобы график никогда не оставался пустым.
function generateFallbackHistory({ hours = 168, fee = 0, now = Date.now() } = {}) {
  const s = store.get().settings;
  const feePct = Number(fee) || 0;
  const currentBtc = s.rateBTC || 7140000;
  const currentGram = s.rateGRAM || 119;
  const feeMult = 1 + feePct / 100;

  const endBaseBtc = s.baseRateBTC || Math.round(currentBtc / feeMult);
  const endBaseGram = s.baseRateGRAM || Math.round(currentGram / feeMult);

  const points = [];
  const count = Math.min(168, Math.max(24, hours));

  for (let i = 0; i < count; i += 1) {
    const at = now - (count - 1 - i) * 3600 * 1000;
    const progress = i / (count - 1); // 0 .. 1

    const w1 = Math.sin((progress - 1) * Math.PI * 2.5) * 0.018;
    const w2 = Math.cos((progress - 1) * Math.PI * 5.0) * 0.008;
    const dip = Math.exp(-Math.pow((progress - 0.45) / 0.15, 2)) * -0.022;
    const dev = w1 + w2 + dip;

    const baseBtc = Math.round(endBaseBtc * (1 + dev));
    const baseGram = Math.round(endBaseGram * (1 + dev * 1.2));

    points.push({
      at,
      baseBtc,
      baseGram,
      btc: applyFee(baseBtc, feePct),
      gram: applyFee(baseGram, feePct),
    });
  }

  const last = points[points.length - 1];
  last.at = now;
  last.baseBtc = endBaseBtc;
  last.baseGram = endBaseGram;
  last.btc = currentBtc;
  last.gram = currentGram;

  return points;
}

/* ---------- движок: опрос, паузы, медиана ---------- */

function createRateEngine({
  sources = SOURCES,
  fxSources = FX_SOURCES,
  historySources = HISTORY_SOURCES,
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  intervalMs = INTERVAL_MS,
  perCycle = PER_CYCLE,
  quoteTtlMs = QUOTE_TTL_MS,
  fx: initialFx = null,
  onFx = () => {},
  log = console,
} = {}) {
  const get = (url, opts) => httpGet(fetchImpl, url, opts);
  const state = new Map(sources.map((s) => [s.name, { nextAt: 0, failures: 0, error: null, okAt: null, quote: null }]));
  let cursor = 0;
  let fx = initialFx && inRange(Number(initialFx.rate), USD_RUB_BOUNDS)
    ? { rate: Number(initialFx.rate), source: initialFx.source || '?', at: Number(initialFx.at) || 0 }
    : null;
  const fxState = { nextAt: 0, failures: 0, error: null, inflight: null };

  // Следующие по кругу источники, у которых прошла пауза и минимальный интервал.
  function pickDue(t) {
    const picked = [];
    let last = -1;
    for (let i = 0; i < sources.length && picked.length < perCycle; i += 1) {
      const idx = (cursor + i) % sources.length;
      if (state.get(sources[idx].name).nextAt <= t) {
        picked.push(sources[idx]);
        last = idx;
      }
    }
    if (last >= 0) cursor = (last + 1) % sources.length;
    return picked;
  }

  async function poll(src) {
    const st = state.get(src.name);
    const startedAt = now();
    try {
      const raw = (await src.fetch(get)) || {};
      const quote = { at: now() };
      for (const a of ASSETS) if (inRange(raw[a], BOUNDS_USD[a])) quote[a] = raw[a];
      if (inRange(raw.usdRub, USD_RUB_BOUNDS)) quote.usdRub = raw.usdRub;
      if (!ASSETS.some((a) => quote[a] != null)) throw fail('неправдоподобные значения', { api: true });
      if (st.failures > 0) log.log?.(`[rates] ${src.name} снова отвечает`);
      Object.assign(st, { quote, failures: 0, error: null, okAt: quote.at, nextAt: startedAt + (src.every || intervalMs) });
      return true;
    } catch (e) {
      // Источник, который сейчас не отвечает, не участвует в медиане и старой котировкой.
      st.quote = null;
      st.failures += 1;
      st.error = describe(e);
      const pause = backoffMs(e, st.failures);
      st.nextAt = now() + pause;
      if (st.failures === 1) log.warn?.(`[rates] ${src.name}: ${st.error} — пауза ${fmtPause(pause)}`);
      return false;
    }
  }

  async function loadFx() {
    const errors = [];
    for (const src of fxSources) {
      try {
        const rate = await src.fetch(get);
        if (!inRange(rate, USD_RUB_BOUNDS)) throw fail('неправдоподобное значение', { api: true });
        fx = { rate, source: src.name, at: now() };
        Object.assign(fxState, { nextAt: fx.at + FX_TTL_MS, failures: 0, error: null });
        try {
          onFx(fx);
        } catch (e) {
          log.error?.('[rates] не удалось сохранить курс доллара:', e.message);
        }
        return fx;
      } catch (e) {
        errors.push(`${src.name}: ${describe(e)}`);
      }
    }
    fxState.failures += 1;
    fxState.error = errors.join('; ');
    fxState.nextAt = now() + Math.min(FX_TTL_MS, 30 * 1000 * 2 ** Math.min(fxState.failures - 1, 6));
    if (fxState.failures === 1) {
      log.warn?.(`[rates] курс USD/RUB не обновился (${fxState.error})${fx ? ' — работаем по последнему известному' : ''}`);
    }
    return fx;
  }

  // Никогда не бросает: при ошибке остаётся прежний курс доллара.
  function refreshFx(force = false) {
    if (fxState.inflight) return fxState.inflight;
    if (!force && fx && now() < fxState.nextAt) return Promise.resolve(fx);
    if (!force && !fx && now() < fxState.nextAt) return Promise.resolve(null);
    fxState.inflight = loadFx().finally(() => {
      fxState.inflight = null;
    });
    return fxState.inflight;
  }

  const freshQuotes = (t, key) => {
    const out = [];
    for (const [name, st] of state) {
      if (st.quote?.[key] != null && t - st.quote.at <= quoteTtlMs) out.push({ name, v: st.quote[key] });
    }
    return out;
  };

  function consensus(quotes) {
    if (!quotes.length) return { usd: NaN, names: [], outliers: [], quotes };
    const mid = median(quotes.map((q) => q.v));
    const kept = quotes.filter((q) => Math.abs(q.v / mid - 1) <= MAX_DEVIATION);
    return {
      usd: kept.length ? median(kept.map((q) => q.v)) : NaN,
      names: kept.map((q) => q.name),
      outliers: quotes.filter((q) => !kept.includes(q)).map((q) => q.name),
      quotes,
    };
  }

  function usdRubAt(t) {
    const implied = freshQuotes(t, 'usdRub');
    if (fx && (t - fx.at <= FX_STALE_MS || !implied.length)) return { rate: fx.rate, source: fx.source };
    if (implied.length) return { rate: median(implied.map((q) => q.v)), source: `кросс-курс ${implied.map((q) => q.name).join('+')}` };
    return null;
  }

  const fmtUsd = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(4));

  // Один цикл: опросить источники, собрать медиану, пересчитать в рубли.
  // all=true — ручное обновление и старт: опрашиваем все источники сразу.
  // Возвращает null, если в авто-цикле опрашивать некого (все на паузе).
  async function cycle({ all = false } = {}) {
    const picked = all ? [...sources] : pickDue(now());
    if (!picked.length && !all) return null;
    const fxTask = refreshFx(all);
    const results = await Promise.all(picked.map(poll));
    // Курс доллара ждём, только если его ещё нет совсем, иначе он обновится в фоне.
    if (!fx) await fxTask;

    const failed = picked
      .filter((_, i) => !results[i])
      .map((s) => ({ name: s.name, error: state.get(s.name).error }));
    const failedText = failed.map((f) => `${f.name}: ${f.error}`).join('; ');
    if (!results.some(Boolean)) {
      throw fail(failedText || 'все источники курса на паузе после ошибок, повтор автоматически');
    }

    const t = now();
    const agg = Object.fromEntries(ASSETS.map((a) => [a, consensus(freshQuotes(t, a))]));
    const problems = [];
    for (const a of ASSETS) {
      const c = agg[a];
      if (Number.isFinite(c.usd)) continue;
      const title = a.toUpperCase();
      problems.push(
        c.quotes.length
          ? `${title}: источники расходятся (${c.quotes.map((q) => `${q.name} ${fmtUsd(q.v)}$`).join(', ')})`
          : `${title}: нет котировок`
      );
    }
    const usdRub = usdRubAt(t);
    if (!usdRub) problems.push(`нет курса USD/RUB (${fxState.error || 'источники не ответили'})`);
    if (problems.length) throw fail([...problems, failedText].filter(Boolean).join('; '));

    const used = sources.map((s) => s.name).filter((n) => ASSETS.some((a) => agg[a].names.includes(n)));
    const rateText = usdRub.rate.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const shown = used.length > 4 ? `${used.slice(0, 4).join(', ')} +${used.length - 4}` : used.join(', ');
    return {
      btc: agg.btc.usd * usdRub.rate,
      gram: agg.gram.usd * usdRub.rate,
      usd: { btc: agg.btc.usd, gram: agg.gram.usd },
      usdRub: usdRub.rate,
      usdRubSource: usdRub.source,
      sources: used,
      support: { btc: agg.btc.names.length, gram: agg.gram.names.length },
      outliers: [...new Set(ASSETS.flatMap((a) => agg[a].outliers))],
      failed,
      source: `${shown}; $ = ${rateText} ₽ — ${usdRub.source}`,
      at: t,
    };
  }

  function status() {
    const t = now();
    return {
      sources: sources.map((s) => {
        const st = state.get(s.name);
        return {
          name: s.name,
          ok: st.okAt != null && st.failures === 0,
          tried: st.okAt != null || st.failures > 0,
          error: st.error,
          pausedMs: st.failures ? Math.max(0, st.nextAt - t) : 0,
          okAt: st.okAt,
        };
      }),
      fx: fx ? { ...fx } : null,
      fxError: fxState.error,
    };
  }

  async function fetchHistory({ hours = 168 } = {}) {
    const targetHours = Math.min(168, Math.max(1, Number(hours) || 168));
    let lastErr = null;

    let usdRub = fx?.rate;
    if (!usdRub || now() - fx.at > FX_TTL_MS) {
      try {
        const fresh = await refreshFx();
        if (fresh?.rate) usdRub = fresh.rate;
      } catch {}
    }
    if (!usdRub && initialFx?.rate) usdRub = initialFx.rate;
    if (!usdRub) usdRub = 85;

    for (const src of historySources) {
      try {
        const data = await src.fetch(get, targetHours);
        if (data && data.btc?.length && data.gram?.length) {
          const points = mergeHistoryPoints({
            btc: data.btc,
            gram: data.gram,
            usdRub,
          });
          if (points.length >= 2) {
            return { points, source: src.name, usdRub };
          }
        }
      } catch (e) {
        lastErr = e;
        log.warn?.(`[rates] не удалось получить историю с ${src.name}: ${describe(e)}`);
      }
    }
    throw lastErr || fail('источники истории курса не ответили');
  }

  return { cycle, status, refreshFx, fetchHistory };
}

/* ---------- применение к настройкам ---------- */

const applyFee = (base, fee) => Math.max(1, Math.round(base * (1 + fee / 100)));

const engine = createRateEngine({
  fx: (() => {
    const s = store.get().settings;
    return s.usdRub ? { rate: s.usdRub, source: s.usdRubSource, at: s.usdRubAt } : null;
  })(),
  onFx: (fx) =>
    store.mutate((db) => {
      db.settings.usdRub = Math.round(fx.rate * 10000) / 10000;
      db.settings.usdRubSource = fx.source;
      db.settings.usdRubAt = fx.at;
    }),
});

function applyRates(official) {
  const at = Date.now();
  const prev = store.get().settings.rateUpdatedAt;
  // Пока курс не обновлялся, на график попадали стартовые/устаревшие курсы
  // (например, при смене комиссии). С приходом реальных данных убираем их.
  if (!prev || at - prev > HISTORY_GAP_MS) store.dropRatePointsAfter(prev || 0);
  const btc = Math.round(official.btc);
  const gram = Math.round(official.gram);
  const settings = store.mutate((db) => {
    const fee = Number(db.settings.feePercent) || 0;
    db.settings.baseRateBTC = btc;
    db.settings.baseRateGRAM = gram;
    db.settings.rateBTC = applyFee(btc, fee);
    db.settings.rateGRAM = applyFee(gram, fee);
    db.settings.rateUpdatedAt = at;
    db.settings.rateSource = official.source;
    return db.settings;
  });
  // Точка для графика курса в Web App — только реальные наблюдения.
  store.pushRatePoint({
    btc: settings.rateBTC,
    gram: settings.rateGRAM,
    at: settings.rateUpdatedAt,
    baseBtc: settings.baseRateBTC,
    baseGram: settings.baseRateGRAM,
  });
  return settings;
}

// Пересчёт итоговых курсов после смены комиссии (официальные не трогаем).
function recomputeWithFee() {
  const s = store.mutate((db) => {
    const set = db.settings;
    const fee = Number(set.feePercent) || 0;
    if (set.baseRateBTC) set.rateBTC = applyFee(set.baseRateBTC, fee);
    if (set.baseRateGRAM) set.rateGRAM = applyFee(set.baseRateGRAM, fee);
    if (Array.isArray(db.rateHistory)) {
      for (const p of db.rateHistory) {
        if (p.baseBtc) p.btc = applyFee(p.baseBtc, fee);
        else if (p.btc) p.btc = applyFee(Math.round(p.btc / (1 + fee / 100)), fee);
        if (p.baseGram) p.gram = applyFee(p.baseGram, fee);
        else if (p.gram) p.gram = applyFee(Math.round(p.gram / (1 + fee / 100)), fee);
      }
    }
    return set;
  });
  // Оператор изменил курс для клиентов — это тоже точка на графике.
  store.pushRatePoint({
    btc: s.rateBTC,
    gram: s.rateGRAM,
    baseBtc: s.baseRateBTC,
    baseGram: s.baseRateGRAM,
  });
  return s;
}

// Гарантируем наличие недельной истории для графика в Web App.
let ensureHistoryInflight = null;
async function ensureRateHistory({ force = false, hours = 168 } = {}) {
  const current = store.get().rateHistory || [];
  const minRequired = 24;
  const nowTs = Date.now();
  const oldest = current.length ? current[0].at : nowTs;
  const coversWeek = current.length >= minRequired && (nowTs - oldest) >= 3 * 24 * 3600 * 1000;

  if (!force && coversWeek) {
    return current;
  }

  if (ensureHistoryInflight) return ensureHistoryInflight;

  ensureHistoryInflight = (async () => {
    const fee = Number(store.get().settings.feePercent) || 0;
    try {
      const res = await engine.fetchHistory({ hours });
      if (res && res.points && res.points.length >= 2) {
        const pointsWithFee = res.points.map((p) => ({
          at: p.at,
          baseBtc: p.baseBtc,
          baseGram: p.baseGram,
          btc: applyFee(p.baseBtc, fee),
          gram: applyFee(p.baseGram, fee),
        }));
        store.seedRateHistory(pointsWithFee);
        console.log(`[rates] история курса за неделю загружена (${res.source}, ${pointsWithFee.length} точек, с комиссией +${fee}%)`);
        return store.get().rateHistory;
      }
    } catch (e) {
      console.warn(`[rates] онлайн-история недоступна (${e.message}), используем резервную историю за неделю`);
      if ((store.get().rateHistory || []).length < 2) {
        const fallback = generateFallbackHistory({ hours, fee });
        store.seedRateHistory(fallback);
        console.log(`[rates] базовый график курса за неделю инициализирован (${fallback.length} точек, с комиссией +${fee}%)`);
      }
    }
    return store.get().rateHistory;
  })().finally(() => {
    ensureHistoryInflight = null;
  });

  return ensureHistoryInflight;
}

// Авто-цикл и ручное обновление не пересекаются: второй ждёт первый.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// Официальный курс в рублях со всех доступных источников (без записи в базу).
async function fetchOfficial() {
  const official = await exclusive(() => engine.cycle({ all: true }));
  return { ...official, btc: Math.round(official.btc), gram: Math.round(official.gram) };
}

// Ручное обновление из бота: опрашиваем все источники сразу и сохраняем курс.
async function refreshRates() {
  return exclusive(async () => {
    const official = await engine.cycle({ all: true });
    return { settings: applyRates(official), source: official.source, official };
  });
}

const status = () => engine.status();

// Логи без спама: успех — раз в 10 минут и после сбоя, ошибка — при смене текста или раз в 5 минут.
const logState = { okAt: 0, failAt: 0, failText: '', failing: false };
function reportOk(official) {
  const t = Date.now();
  if (logState.failing || t - logState.okAt > 10 * 60 * 1000) {
    console.log(
      `[rates] курс обновлён: BTC ${Math.round(official.btc).toLocaleString('ru-RU')} ₽, ` +
        `GRAM ${Math.round(official.gram).toLocaleString('ru-RU')} ₽ — ${official.source}`
    );
    logState.okAt = t;
  }
  logState.failing = false;
}
function reportFail(e) {
  const t = Date.now();
  if (!logState.failing || (e.message !== logState.failText && t - logState.failAt > 60 * 1000) || t - logState.failAt > 5 * 60 * 1000) {
    console.error('[rates] обновление не удалось, действуют прежние курсы:', e.message);
    logState.failAt = t;
    logState.failText = e.message;
  }
  logState.failing = true;
}

function startRates() {
  if (DISABLED) {
    console.log('[rates] автообновление курса отключено (RATES_DISABLED=1)');
    return null;
  }
  // Загружаем недельную историю курса из онлайна сразу при старте, чтобы график не был пустым
  ensureRateHistory().catch((e) => {
    console.warn('[rates] ошибка начальной загрузки истории:', e.message);
  });
  console.log(
    `[rates] автообновление официального курса каждые ${Math.round(INTERVAL_MS / 1000)} c: ` +
      `${SOURCES.length} источников цен (${SOURCES.map((s) => s.name).join(', ')}), курс доллара — ${FX_SOURCES.map((s) => s.name).join(' → ')}`
  );
  let first = true;
  let pending = false;
  const tick = () => {
    if (pending) return; // прошлый цикл ещё идёт — не копим очередь
    pending = true;
    const all = first; // на старте сразу опрашиваем все источники
    first = false;
    exclusive(async () => {
      try {
        const official = await engine.cycle({ all });
        if (!official) return;
        applyRates(official);
        reportOk(official);
      } catch (e) {
        reportFail(e);
      }
    }).finally(() => {
      pending = false;
    });
  };
  tick();
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = {
  startRates,
  refreshRates,
  recomputeWithFee,
  applyFee,
  fetchOfficial,
  ensureRateHistory,
  generateFallbackHistory,
  mergeHistoryPoints,
  HISTORY_SOURCES,
  status,
  createRateEngine,
  SOURCES,
  FX_SOURCES,
};
