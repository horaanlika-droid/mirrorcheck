// Курсы BTC/GRAM: 12 источников цен, медиана с отсевом выбросов, курс доллара
// с резервами, паузы для отказавших API. Сеть подменяется: ответы повторяют
// реальные форматы API (сняты 25.09.2026), время управляется вручную.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-rates-'));
process.env.RATES_DISABLED = '1';
process.env.BOT_TOKEN = '123456:test-token';
process.env.ADMIN_ID = '111';
const store = require('../src/store');
const rates = require('../src/rates');
const { createBot } = require('../src/bot');

const CBR_USD = 84.9057;
// Реальные цены 25.09.2026 ~07:45 UTC (часть BTC-котировок достроена в пределах спреда).
const PRICES = {
  binance: { btc: 83825.01, gram: 1.403 },
  bybit: { btc: 83830, gram: 1.405 },
  okx: { btc: 83820.1, gram: 1.405 },
  coinbase: { btc: 83894.035, gram: 1.404 },
  kraken: { btc: 83809.9, gram: 1.405 },
  kucoin: { btc: 83881.2280801018586529, gram: 1.4035787999999999 },
  gate: { btc: 83822.5, gram: 1.4034 },
  mexc: { btc: 83826.12, gram: 1.404 },
  htx: { btc: 83818.2, gram: 1.4031 },
  bitget: { btc: 83824.9, gram: 1.404 },
  tonapi: { gram: 1.404859514 },
  coingecko: { btc: 83822, gram: 1.4 },
};
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const all = (asset, prices = PRICES) => Object.values(prices).map((p) => p[asset]).filter((x) => x != null);

const json = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const netError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

// XML ЦБ в windows-1251: кириллица — не UTF-8, теги и числа — ASCII.
const cbrXml = () =>
  Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="25.09.2026" name="Foreign Currency Market">' +
      '<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>'),
    Buffer.from([0xc4, 0xee, 0xeb, 0xeb, 0xe0, 0xf0, 0x20, 0xd1, 0xd8, 0xc0]),
    Buffer.from('</Name><Value>84,9057</Value><VunitRate>84,9057</VunitRate></Valute></ValCurs>'),
  ]);

const HOSTS = {
  'data-api.binance.vision': 'binance',
  'api.bybit.com': 'bybit',
  'www.okx.com': 'okx',
  'api.coinbase.com': 'coinbase',
  'api.kraken.com': 'kraken',
  'api.kucoin.com': 'kucoin',
  'api.gateio.ws': 'gate',
  'api.mexc.com': 'mexc',
  'api.huobi.pro': 'htx',
  'api.bitget.com': 'bitget',
  'tonapi.io': 'tonapi',
  'api.coingecko.com': 'coingecko',
  'www.cbr-xml-daily.ru': 'cbr',
  'www.cbr.ru': 'cbrxml',
  'open.er-api.com': 'erapi',
  'cdn.jsdelivr.net': 'jsdelivr',
  'latest.currency-api.pages.dev': 'pages',
};

// Фейковая сеть: ответы в форматах настоящих API. override[name] — Response,
// Error или функция (url) => Response | Error | undefined (undefined — обычный ответ).
function market({ prices = PRICES, override = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const name = HOSTS[u.host];
    calls.push({ name, url });
    let o = override[name];
    if (typeof o === 'function') o = o(url);
    if (o instanceof Error) throw o;
    if (o) return o;
    const p = prices[name] || {};
    const q = u.searchParams;
    const pick = (sym) => (/^(BTC|XBT|btc)/.test(sym) ? p.btc : p.gram);
    switch (name) {
      case 'binance':
        return json(JSON.parse(q.get('symbols')).map((s) => ({ symbol: s, price: String(pick(s)) })));
      case 'bybit':
        return json({ retCode: 0, retMsg: 'OK', result: { category: 'spot', list: [{ symbol: q.get('symbol'), lastPrice: String(pick(q.get('symbol'))) }] } });
      case 'okx':
        return json({ code: '0', msg: '', data: [{ instType: 'SPOT', instId: q.get('instId'), last: String(pick(q.get('instId'))) }] });
      case 'coinbase': {
        const [base] = u.pathname.split('/')[3].split('-');
        return json({ data: { amount: String(pick(base)), base, currency: 'USD' } });
      }
      case 'kraken': {
        const pair = q.get('pair');
        if (pair === 'GRAMUSD') return json({ error: ['EQuery:Unknown asset pair'] });
        const key = pair === 'XBTUSD' ? 'XXBTZUSD' : pair;
        return json({ error: [], result: { [key]: { c: [String(pick(pair)), '0.1'], t: [723, 2207] } } });
      }
      case 'kucoin':
        return json({ code: '200000', data: { BTC: String(p.btc), GRAM: String(p.gram) } });
      case 'gate':
        return json([{ currency_pair: q.get('currency_pair'), last: String(pick(q.get('currency_pair'))) }]);
      case 'mexc':
        return json({ symbol: q.get('symbol'), price: String(pick(q.get('symbol'))) });
      case 'htx':
        return json({ ch: `market.${q.get('symbol')}.detail.merged`, status: 'ok', ts: 1, tick: { close: pick(q.get('symbol')) } });
      case 'bitget':
        return json({ code: '00000', msg: 'success', data: [{ symbol: q.get('symbol'), lastPr: String(pick(q.get('symbol'))) }] });
      case 'tonapi':
        return json({ rates: { TON: { prices: { RUB: p.gram * 84.4971, USD: p.gram } } } });
      case 'coingecko':
        return json({ bitcoin: { usd: p.btc, rub: p.btc * 84.876 }, 'the-open-network': { usd: p.gram, rub: p.gram * 84.876 } });
      case 'cbr':
        return json({ Date: '2026-09-25T11:30:00+03:00', Valute: { USD: { CharCode: 'USD', Nominal: 1, Value: CBR_USD } } });
      case 'cbrxml':
        return new Response(cbrXml(), { headers: { 'content-type': 'application/xml; charset=windows-1251' } });
      case 'erapi':
        return json({ result: 'success', rates: { RUB: 84.485696 } });
      case 'jsdelivr':
      case 'pages':
        return json({ date: '2026-09-24', usd: { rub: 84.84031964 } });
      default:
        throw netError();
    }
  };
  return { fetchImpl, calls };
}

const quiet = { log() {}, warn() {}, error() {} };
function engine(opts = {}) {
  const clock = { t: 1_790_000_000_000 };
  const net = market(opts);
  const e = rates.createRateEngine({ fetchImpl: net.fetchImpl, now: () => clock.t, log: quiet, ...opts.engine });
  return { e, net, clock };
}

test('all 12 sources with real payloads: median of dollar quotes × ЦБ РФ', async () => {
  const { e } = engine();
  const r = await e.cycle({ all: true });
  assert.deepEqual(r.failed, []);
  assert.equal(r.sources.length, 12);
  assert.equal(r.support.btc, 11, 'у TON API нет BTC');
  assert.equal(r.support.gram, 12);
  assert.equal(r.usdRub, CBR_USD);
  assert.equal(r.usdRubSource, 'ЦБ РФ');
  assert.ok(Math.abs(r.btc - median(all('btc')) * CBR_USD) < 1e-6);
  assert.ok(Math.abs(r.gram - median(all('gram')) * CBR_USD) < 1e-9);
  // Реалистичный порядок цифр: BTC ≈ 7,1 млн ₽, GRAM (бывший TON) ≈ 119 ₽.
  assert.equal(Math.round(r.gram), 119);
  assert.ok(r.btc > 7_000_000 && r.btc < 7_200_000, String(r.btc));
  assert.equal(r.source, 'binance, bybit, okx, coinbase +8; $ = 84,91 ₽ — ЦБ РФ');
});

test('user scenario: CoinGecko 429, Coinbase 400, Kraken without GRAMUSD — rate still updates', async () => {
  const { e, clock, net } = engine({
    override: {
      coingecko: json({ status: { error_code: 429 } }, 429, { 'retry-after': '600' }),
      coinbase: json({ error: 'base currency not recognized' }, 400),
    },
  });
  const r = await e.cycle({ all: true });
  assert.deepEqual(r.failed.map((f) => `${f.name}: ${f.error}`).sort(), ['coinbase: HTTP 400', 'coingecko: HTTP 429']);
  assert.ok(r.sources.includes('kraken'), 'Kraken отдаёт GRAM под тикером TONUSD');
  assert.ok(net.calls.some((c) => c.url.includes('pair=TONUSD')));
  assert.equal(Math.round(r.gram), 119);
  // CoinGecko просил подождать 10 минут — до этого его не трогаем.
  const cg = e.status().sources.find((s) => s.name === 'coingecko');
  assert.equal(cg.ok, false);
  assert.ok(cg.pausedMs >= 600_000, String(cg.pausedMs));
  for (let i = 0; i < 40; i += 1) {
    clock.t += 10_000;
    await e.cycle().catch(() => {});
  }
  const cgCalls = net.calls.filter((c) => c.name === 'coingecko').length;
  assert.equal(cgCalls, 1, 'за 400 секунд паузы — ни одного повторного запроса');
});

test('a frozen pair and a look-alike token are filtered out', async () => {
  const prices = {
    ...PRICES,
    binance: { btc: 83825.01, gram: 1.6 }, // как замороженная TONUSDT (status BREAK) на Binance
    coingecko: { btc: 83822, gram: 0.00052 }, // как токен с id «gram» — не наш GRAM
  };
  const { e } = engine({ prices });
  const r = await e.cycle({ all: true });
  assert.deepEqual(r.outliers, ['binance']);
  assert.equal(r.support.gram, 10);
  assert.equal(Math.round(r.gram), 119);
  assert.ok(r.sources.includes('coingecko'), 'BTC от CoinGecko по-прежнему в деле');
});

test('dollar rate falls back: cbr.ru XML → open.er-api → currency-api → cross rate', async () => {
  const down = json('Service Unavailable', 503);
  let r = await engine({ override: { cbr: down } }).e.cycle({ all: true });
  assert.equal(r.usdRubSource, 'ЦБ РФ (cbr.ru)');
  assert.equal(r.usdRub, CBR_USD);

  r = await engine({ override: { cbr: down, cbrxml: netError(), erapi: down, jsdelivr: netError() } }).e.cycle({ all: true });
  assert.equal(r.usdRubSource, 'currency-api');
  assert.equal(r.usdRub, 84.84031964);

  const noFx = { cbr: down, cbrxml: down, erapi: down, jsdelivr: down, pages: down };
  r = await engine({ override: noFx }).e.cycle({ all: true });
  assert.match(r.usdRubSource, /^кросс-курс tonapi\+coingecko$/);
  assert.ok(Math.abs(r.usdRub - (84.4971 + 84.876) / 2) < 1e-6);

  await assert.rejects(
    engine({ override: { ...noFx, tonapi: down, coingecko: down } }).e.cycle({ all: true }),
    /нет курса USD\/RUB \(ЦБ РФ: HTTP 503; ЦБ РФ \(cbr\.ru\): HTTP 503/
  );
});

test('auto cycles poll 4 sources at a time in rotation: 2–3 requests per API per minute', async () => {
  const { e, net, clock } = engine();
  const polled = [];
  for (let i = 0; i < 6; i += 1) {
    const before = net.calls.length;
    await e.cycle();
    polled.push([...new Set(net.calls.slice(before).map((c) => c.name).filter((n) => !['cbr'].includes(n)))]);
    clock.t += 10_000;
  }
  assert.deepEqual(polled[0], ['binance', 'bybit', 'okx', 'coinbase']);
  assert.deepEqual(polled[1], ['kraken', 'kucoin', 'gate', 'mexc']);
  assert.deepEqual(polled[2], ['htx', 'bitget', 'tonapi', 'coingecko']);
  assert.deepEqual(polled[3], ['binance', 'bybit', 'okx', 'coinbase']);
  // CoinGecko ждёт 5 минут — его место в круге занимает следующая биржа.
  assert.deepEqual(polled[5], ['htx', 'bitget', 'tonapi', 'binance']);
  assert.ok(polled.every((p) => p.length <= 4));
  // За минуту (6 циклов) каждую биржу опросили 2–3 раза, CoinGecko — один раз.
  const per = (n) => polled.filter((p) => p.includes(n)).length;
  for (const s of rates.SOURCES.filter((x) => !x.every)) {
    assert.ok(per(s.name) >= 2 && per(s.name) <= 3, `${s.name}: ${per(s.name)}`);
  }
  assert.equal(per('tonapi'), 2);
  assert.equal(per('coingecko'), 1);
  assert.equal(net.calls.filter((c) => c.name === 'cbr').length, 1, 'курс ЦБ кэшируется');
});

test('a failing source pauses with growing backoff and comes back when healthy', async () => {
  let broken = true;
  const { e, net, clock } = engine({
    override: { okx: () => (broken ? json('Bad Gateway', 502) : undefined) },
    engine: { perCycle: 12 },
  });
  await e.cycle({ all: true });
  const okx = () => e.status().sources.find((s) => s.name === 'okx');
  assert.equal(okx().error, 'HTTP 502');
  assert.equal(okx().pausedMs, 15_000);
  const okxCalls = () => net.calls.filter((c) => c.name === 'okx').length;
  const n = okxCalls();
  clock.t += 10_000;
  await e.cycle();
  assert.equal(okxCalls(), n, 'во время паузы не опрашиваем');
  clock.t += 10_000;
  await e.cycle();
  assert.equal(okxCalls(), n + 2, 'пауза прошла — снова пробуем (BTC и GRAM)');
  assert.equal(okx().pausedMs, 30_000, 'вторая ошибка — пауза вдвое дольше');
  broken = false;
  clock.t += 30_000;
  const r = await e.cycle();
  assert.ok(r.sources.includes('okx'));
  assert.equal(okx().ok, true);
});

test('a source that stops answering leaves the median right away', async () => {
  let broken = false;
  const { e, clock } = engine({ override: { binance: () => (broken ? json('Service Unavailable', 503) : undefined) } });
  let r = await e.cycle({ all: true });
  assert.ok(r.sources.includes('binance'));
  broken = true;
  clock.t += 5_000;
  r = await e.cycle({ all: true });
  assert.ok(!r.sources.includes('binance'), 'котировка пятисекундной давности не используется после ошибки');
  assert.equal(r.support.btc, 10);
});

test('renamed tickers: Kraken switches to GRAMUSD, Coinbase falls back to TON-USD', async () => {
  const { e, net } = engine({
    override: {
      kraken: (url) => (url.includes('TONUSD') ? json({ error: ['EQuery:Unknown asset pair'] }) : url.includes('GRAMUSD')
        ? json({ error: [], result: { GRAMUSD: { c: ['1.405', '1'], t: [10, 100] } } }) : undefined),
      coinbase: (url) => (url.includes('GRAM-USD') ? json({ errors: [{ id: 'not_found' }] }, 404) : undefined),
    },
  });
  const r = await e.cycle({ all: true });
  assert.equal(r.support.gram, 12);
  assert.ok(net.calls.some((c) => c.url.includes('pair=GRAMUSD')));
  assert.ok(net.calls.some((c) => c.url.includes('/TON-USD/spot')));
});

test('Kraken pair without trades in 24h is treated as frozen', async () => {
  const { e } = engine({
    override: {
      kraken: (url) => (url.includes('TONUSD') ? json({ error: [], result: { TONUSD: { c: ['1.60', '0'], t: [0, 0] } } }) : undefined),
    },
  });
  const r = await e.cycle({ all: true });
  assert.equal(r.support.gram, 11, 'замороженный TONUSD не участвует, GRAMUSD у Kraken ещё нет');
  assert.equal(Math.round(r.gram), 119);
});

test('refreshRates saves the official rate with fee, USD/RUB and a clean chart history', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = market().fetchImpl;
  const hour = 3600 * 1000;
  store.mutate((db) => {
    db.settings.feePercent = 2;
    db.settings.rateUpdatedAt = null;
    // До исправления курс не обновлялся: на графике только стартовые курсы при смене комиссии.
    db.rateHistory = [{ at: Date.now() - 2 * hour, btc: 10_250_000, gram: 7450 }];
  });

  const { settings, official } = await rates.refreshRates();
  const btc = Math.round(median(all('btc')) * CBR_USD);
  assert.equal(settings.baseRateBTC, btc);
  assert.equal(settings.baseRateGRAM, 119);
  assert.equal(settings.rateBTC, rates.applyFee(btc, 2));
  assert.equal(settings.rateGRAM, 121);
  assert.equal(settings.usdRub, CBR_USD);
  assert.equal(settings.usdRubSource, 'ЦБ РФ');
  assert.match(settings.rateSource, /binance.*ЦБ РФ/);
  assert.ok(Date.now() - settings.rateUpdatedAt < 5000);
  assert.deepEqual(official.failed, []);
  const history = store.get().rateHistory;
  assert.equal(history.length, 1, 'стартовые точки убраны, осталась первая реальная');
  assert.deepEqual({ btc: history[0].btc, gram: history[0].gram }, { btc: settings.rateBTC, gram: 121 });

  // Клиент видит только итоговые курсы — служебные поля не утекают.
  const pub = store.publicSettings();
  assert.equal(pub.rateGRAM, 121);
  assert.equal(pub.usdRub, undefined);
  assert.equal(pub.baseRateGRAM, undefined);
});

test('refreshRates reports every failed source and keeps previous rates', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const down = json('nope', 403);
  const net = market({
    override: Object.fromEntries(Object.values(HOSTS).filter((n) => !['cbr'].includes(n)).map((n) => [n, down])),
  });
  globalThis.fetch = net.fetchImpl;
  const before = { ...store.get().settings };
  await assert.rejects(rates.refreshRates(), (e) => {
    for (const name of rates.SOURCES.map((s) => s.name)) assert.match(e.message, new RegExp(`${name}: HTTP 403`));
    return true;
  });
  const after = store.get().settings;
  assert.equal(after.rateGRAM, before.rateGRAM);
  assert.equal(after.rateUpdatedAt, before.rateUpdatedAt);
  assert.equal(rates.status().sources.every((s) => !s.ok), true);
});

// Побайтно реальные ответы API, снятые 25.09.2026 (у ЦБ оставлен только доллар).
// Bybit отвечает 403 от CloudFront — так его видит заблокированный регион.
const LIVE = {
  'data-api.binance.vision': '[{"symbol":"BTCUSDT","price":"84065.04000000"},{"symbol":"GRAMUSDT","price":"1.40700000"}]',
  'instId=BTC-USDT': '{"code":"0","data":[{"instType":"SPOT","instId":"BTC-USDT","last":"84070.9","lastSz":"0.06810322","askPx":"84071","askSz":"0.61943805","bidPx":"84070.9","bidSz":"4.80941911","open24h":"84515.8","high24h":"84944.4","low24h":"82874.5","volCcy24h":"511984068.580413188","vol24h":"6094.07117965","ts":"1790323049365","sodUtc0":"84409.9","sodUtc8":"84419.6"}],"msg":""}',
  'instId=GRAM-USDT': '{"code":"0","data":[{"instType":"SPOT","instId":"GRAM-USDT","last":"1.405","lastSz":"62.648","askPx":"1.405","askSz":"3330.904","bidPx":"1.404","bidSz":"55.225","open24h":"1.425","high24h":"1.445","low24h":"1.391","volCcy24h":"3657264.524931","vol24h":"2583217.242","ts":"1790322097076","sodUtc0":"1.41","sodUtc8":"1.433"}],"msg":""}',
  '/BTC-USD/spot': '{"data":{"amount":"83894.035","base":"BTC","currency":"USD"}}',
  '/GRAM-USD/spot': '{"data":{"amount":"1.404","base":"GRAM","currency":"USD"}}',
  'pair=XBTUSD': '{"error":[],"result":{"XXBTZUSD":{"a":["84036.10000","2","2.000"],"b":["84036.00000","1","1.000"],"c":["84036.00000","0.00112355"],"v":["702.24523395","3307.38151293"],"p":["84259.58809","84073.56822"],"t":[33153,135029],"l":["83740.10000","82832.30000"],"h":["84861.80000","84914.80000"],"o":"84380.00000"}}}',
  'pair=TONUSD': '{"error":[],"result":{"TONUSD":{"a":["1.4050000","538","538.000"],"b":["1.4040000","214","214.000"],"c":["1.4050000","47.70593"],"v":["91659.15983","354583.90125"],"p":["1.4104726","1.4171926"],"t":[723,2207],"l":["1.4020000","1.3900000"],"h":["1.4250000","1.4440000"],"o":"1.4090000"}}}',
  'api.kucoin.com': '{"code":"200000","data":{"BTC":"83881.2280801018586529","GRAM":"1.4035787999999999"}}',
  'currency_pair=BTC_USDT': '[{"currency_pair":"BTC_USDT","last":"84053.3","lowest_ask":"84050","lowest_size":"2.192231","highest_bid":"84049.9","highest_size":"2.306681","change_percentage":"-0.57","base_volume":"6330.010284","quote_volume":"532061973.7836039","high_24h":"84938.1","low_24h":"82888"}]',
  'currency_pair=GRAM_USDT': '[{"currency_pair":"GRAM_USDT","last":"1.4034","lowest_ask":"1.4029","lowest_size":"72.9","highest_bid":"1.4025","highest_size":"301.2","change_percentage":"-1.4","base_volume":"2304945.1","quote_volume":"3263772.29359","high_24h":"1.4441","low_24h":"1.3897"}]',
  'mexc.com/api/v3/ticker/price?symbol=BTCUSDT': '{"symbol":"BTCUSDT","price":"84068.67"}',
  'mexc.com/api/v3/ticker/price?symbol=GRAMUSDT': '{"symbol":"GRAMUSDT","price":"1.404"}',
  'symbol=btcusdt': '{"ch":"market.btcusdt.detail.merged","status":"ok","ts":1790323052264,"tick":{"id":387681286196,"version":387681286196,"open":84471.06,"close":84034.23,"low":82888.0,"high":84887.08,"amount":5169.616031551308,"vol":4.3473748973130167E8,"count":98674,"bid":[84040.57,0.546776],"ask":[84040.58,0.017973]}}',
  'symbol=gramusdt': '{"ch":"market.gramusdt.detail.merged","status":"ok","ts":1790322243480,"tick":{"id":11885244224,"version":11885244224,"open":1.4244,"close":1.4031,"low":1.3941,"high":1.4419,"amount":45440.28838928563,"vol":64294.728390727345,"count":1293,"bid":[1.4031,171.8656355387391],"ask":[1.4069,755.6893]}}',
  'bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT': '{"code":"00000","msg":"success","requestTime":1790323053046,"data":[{"open":"84504.37","symbol":"BTCUSDT","high24h":"84944.94","low24h":"82887.7","lastPr":"84072.34","quoteVolume":"251790497.152011","baseVolume":"2995.267254","usdtVolume":"251790497.1520102","ts":"1790323052194","bidPr":"84072.34","askPr":"84072.35","bidSz":"1.754581","askSz":"0.021297","openUtc":"84409.37","changeUtc24h":"-0.00399","change24h":"-0.00511"}]}',
  'bitget.com/api/v2/spot/market/tickers?symbol=GRAMUSDT': '{"code":"00000","msg":"success","requestTime":1790322243939,"data":[{"open":"1.422","symbol":"GRAMUSDT","high24h":"1.444","low24h":"1.391","lastPr":"1.404","quoteVolume":"765072","baseVolume":"539253.2","usdtVolume":"765071.99437","ts":"1790322243045","bidPr":"1.403","askPr":"1.404","bidSz":"235.08","askSz":"1958.05","openUtc":"1.41","changeUtc24h":"-0.00426","change24h":"-0.01266"}]}',
  'tonapi.io': '{"rates":{"TON":{"prices":{"RUB":118.70884871575025,"USD":1.404859514},"diff_24h":{"RUB":"−1.11%","USD":"−1.42%"},"diff_7d":{"USD":"+3.40%","RUB":"+3.41%"},"diff_30d":{"RUB":"−0.70%","USD":"−1.50%"}}}}',
  // Заодно ответ содержит чужой токен с id «gram» — он не должен попасть в курс.
  'api.coingecko.com': '{"bitcoin":{"usd":83822,"rub":7114519},"the-open-network":{"usd":1.4,"rub":119.2},"gram":{"rub":0.04413449,"usd":0.00051999}}',
  'cbr-xml-daily.ru': '{"Date":"2026-09-25T11:30:00+03:00","PreviousDate":"2026-09-24T11:30:00+03:00","Timestamp":"2026-09-24T20:00:00+03:00","Valute":{"USD":{"ID":"R01235","NumCode":"840","CharCode":"USD","Nominal":1,"Name":"Доллар США","Value":84.9057,"Previous":84.3969}}}',
};

test('byte-exact live payloads (25.09.2026) give BTC ≈ 7.14 mln ₽ and GRAM 119 ₽', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('api.bybit.com')) {
      return new Response('{\n    error:The Amazon CloudFront distribution is configured to block access from your country\n}', { status: 403 });
    }
    const key = Object.keys(LIVE).find((k) => url.includes(k));
    if (!key) throw netError();
    return new Response(LIVE[key], { headers: { 'content-type': 'application/json' } });
  };
  const e = rates.createRateEngine({ fetchImpl, now: () => 1_790_323_060_000, log: quiet });
  const r = await e.cycle({ all: true });
  assert.deepEqual(r.failed, [{ name: 'bybit', error: 'HTTP 403' }]);
  assert.equal(r.support.btc, 10);
  assert.equal(r.support.gram, 11);
  assert.deepEqual(r.outliers, []);
  assert.equal(r.usd.btc, (84036 + 84053.3) / 2);
  assert.equal(r.usd.gram, 1.404);
  assert.equal(Math.round(r.btc), Math.round(84044.65 * 84.9057));
  assert.equal(Math.round(r.gram), 119);
  assert.equal(rates.applyFee(Math.round(r.gram), 2), 121, 'клиентский курс GRAM с комиссией 2%');
});

test('operator: «🔄 Обновить курс» shows the median, USD/RUB and who did not answer', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = market({ override: { coingecko: json({}, 429), bybit: json('blocked', 403) } }).fetchImpl;
  const bot = createBot({ botInfo: { id: 123456, is_bot: true, first_name: 'Test', username: 'pricelex_test_bot' } });
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, ...payload });
    return { ok: true, result: method === 'answerCallbackQuery' ? true : { message_id: sent.length, date: 1, chat: { id: 111, type: 'private' }, text: payload.text } };
  });
  await bot.handleUpdate({ update_id: 1, callback_query: {
    id: '1', chat_instance: 'test', from: { id: 111, first_name: 'Admin', is_bot: false }, data: 's:refresh',
    message: { message_id: 42, date: 1, chat: { id: 111, type: 'private' }, text: 'Настройки' },
  } });
  const reply = sent.find((m) => m.method === 'sendMessage');
  assert.match(reply.text, /^✅ Официальный курс обновлён: ₿ 7\s1\d\d\s\d{3} ₽ · G 119 ₽$/m);
  assert.match(reply.text, /^Медиана по 10 ист\.: binance, okx, coinbase, kraken, kucoin, gate, mexc, htx, bitget, tonapi$/m);
  assert.match(reply.text, /^Курс доллара: 84,91 ₽ \(ЦБ РФ\)$/m);
  assert.match(reply.text, /⏸ Не ответили: bybit \(HTTP 403\), coingecko \(HTTP 429\) — повторим автоматически\.$/);
  const panel = sent.find((m) => m.method === 'editMessageText');
  assert.match(panel.text, /Официальный курс \(авто\): <b>₿ 7\s1\d\d\s\d{3} ₽ · G 119 ₽<\/b>/);
  assert.match(panel.text, /💱 Курс доллара: 84,91 ₽ \(ЦБ РФ, \d\d\.\d\d \d\d:\d\d\)/);
  assert.match(panel.text, /🛰 Источники курса на связи: <b>10 из 12<\/b> · на паузе: bybit \(HTTP 403\), coingecko \(HTTP 429\)/);
  assert.match(panel.text, /💵 Курс для клиентов: <b>₿ 7\s[12]\d\d\s\d{3} ₽ · G 121 ₽<\/b>/);
});
