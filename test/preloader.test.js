// Прелоадер: блик по кромке герба (слои, маска-кольцо, синхронный проход
// света) и вибрация загрузки — толчок на старте, импульс под луч, отклик
// в конце. Таймеры подменяются, Telegram.HapticFeedback — заглушка.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const html = pub('index.html');
const iosCss = pub('ios.css');
const devicesCss = pub('devices.css');
const appJs = pub('app.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settings = {
  online: true, rateBTC: 10_000_000, rateGRAM: 125, rateUpdatedAt: Date.now(),
  minRub: 3000, maxRub: 300000, announcement: '', refPercent: 1, operator: '@test',
  channel: 'https://t.me/test', chat: 'https://t.me/test', botUsername: 'test_bot',
  guaranteeFundBtc: 0.02, adminBrokers: [],
};

// Длительность цикла блика из CSS — по ней сверяется тактильный рисунок.
function shineMs() {
  const m = iosCss.match(/@keyframes preloader-shine \{[\s\S]*?\}\n/) && iosCss.match(/animation: preloader-shine ([\d.]+)s/);
  assert.ok(m, 'длительность цикла блика задана в ios.css');
  return Math.round(parseFloat(m[1]) * 1000);
}

function boot({ reduced = false, telegram = true, fail = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.console.warn = () => {};
  if (reduced) {
    window.matchMedia = (q) => ({ matches: /prefers-reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  }
  const impacts = [];
  if (telegram) {
    window.Telegram = {
      WebApp: {
        ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
        HapticFeedback: {
          impactOccurred: (style) => impacts.push(style),
          selectionChanged: () => impacts.push('selection'),
          notificationOccurred: (kind) => impacts.push(kind),
        },
      },
    };
  }
  const timers = new Map();
  let nextId = 1;
  window.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.setInterval = () => 1;
  window.fetch = async (url) => {
    if (fail) throw new Error('offline');
    const pathname = new URL(url, window.location.href).pathname;
    const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders: [], me: { id: 999, referredCount: 0 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/rates/history') return json({ hours: 24, updatedAt: settings.rateUpdatedAt, points: [] });
    if (pathname === '/api/support/messages') return json({ messages: [] });
    if (pathname === '/api/reviews') return json({ reviews: [], stats: { count: 0, avg: 0 } });
    if (pathname === '/api/captcha') return json({ id: 'c1', question: '1 + 1 = ?' });
    if (pathname === '/api/broker/status') return json({ application: null });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(appJs);
  return { dom, window, impacts, timers };
}

const runUpTo = ({ timers }, limit) => [...timers.values()]
  .filter((t) => t.ms <= limit)
  .sort((a, b) => a.ms - b.ms)
  .forEach((t) => t.fn());

test('блик: три слоя — ореол за гербом, отсвет по металлу и кромка по контуру', () => {
  assert.match(html, /<div class="preloader-logo-wrap">/, 'логотип обёрнут для блика');
  assert.match(html, /class="preloader-logo-glow" aria-hidden="true"><i><\/i><\/span>/, 'ореол — слой за гербом');
  assert.match(html, /class="preloader-logo-sheen" aria-hidden="true"><\/span>/, 'внутренний отсвет — слой над гербом');
  assert.match(html, /class="preloader-logo-edge" aria-hidden="true"><\/span>/, 'кромка — верхний слой');

  // Ореол размыт и лежит под гербом: наружу выходит только свет за кромкой.
  const glow = iosCss.match(/\.preloader-logo-glow \{[\s\S]*?\}/)[0];
  assert.match(glow, /filter: blur\(9px\)/, 'ореол размыт — свет расходится за силуэт');
  assert.match(glow, /z-index: 0/, 'ореол под гербом');
  assert.match(glow, /mix-blend-mode: screen/, 'свет прибавляется к фону');
  assert.match(iosCss, /\.preloader-logo \{[\s\S]*?z-index: 1;/, 'герб перекрывает середину ореола');

  // Кромка: маска-кольцо из двух копий силуэта, свет не срезан границей лого.
  const edge = iosCss.match(/\.preloader-logo-edge \{\n  inset: -3%[\s\S]*?\n\}/)[0];
  assert.match(edge, /mask-image: url\('\/img\/logo-mark\.png'\), url\('\/img\/logo-mark\.png'\)/, 'маска — альфа самого герба, две копии');
  // Слой сам на 6% шире герба, поэтому в долях слоя кольцо — 99% и 92.5%:
  // это ~105% и ~98% от самого логотипа, то есть свет ложится на контур.
  assert.match(edge, /mask-size: 99% 99%, 92\.5% 92\.5%/, 'внешняя копия больше силуэта, внутренняя чуть меньше');
  assert.match(edge, /mask-composite: exclude;/, 'кольцо: силуэт минус сжатый силуэт');
  assert.match(edge, /-webkit-mask-composite: xor;/, 'то же для WebKit');
  assert.match(edge, /inset: -3%/, 'слой шире логотипа — блик выходит за него');
  assert.match(edge, /z-index: 3/, 'кромка — над гербом');
  assert.doesNotMatch(iosCss, /\.preloader-logo-wrap::after/, 'старого блика поверх всего логотипа нет');

  // Все слои едут одной полосой: общая геометрия и одна анимация.
  assert.match(iosCss, /\.preloader-logo-glow i,\n\.preloader-logo-sheen,\n\.preloader-logo-edge \{[\s\S]*?background-size: 300% 100%;/);
  assert.match(iosCss, /animation: preloader-shine 2\.6s/);
  assert.match(iosCss, /@keyframes preloader-shine \{/);

  // Планшетная шкала держит пропорции герба: маска считается в процентах.
  assert.match(devicesCss, /html\[data-device\] \.preloader-logo \{ width: 160px; height: auto; \}/);
});

test('блик замирает статичной подсветкой при prefers-reduced-motion', () => {
  const block = iosCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)[0];
  assert.match(block, /\.preloader-logo-edge \{ animation: none; background-position: 50% 0; \}/);
});

test('вибрация прелоадинга: толчок на старте, импульс под луч, отклик в конце', async (t) => {
  const env = boot();
  t.after(() => env.dom.window.close());
  const cycle = shineMs();
  const beats = [...env.timers.values()].map((x) => x.ms).sort((a, b) => a - b);
  assert.ok(beats.includes(140), `стартовый толчок поставлен: ${beats.join(', ')}`);
  const onCrest = beats.find((ms) => ms > 500 && ms < cycle);
  assert.ok(onCrest, 'импульс под проход блика по гербу внутри первого цикла');
  assert.ok(onCrest > cycle * 0.2 && onCrest < cycle * 0.5, `импульс попадает в проход света по гербу: ${onCrest} мс из ${cycle} мс`);

  runUpTo(env, onCrest);
  assert.deepEqual(env.impacts, ['soft', 'light'], 'сначала мягкий толчок, затем импульс под луч');

  await tick(); await tick();
  const pre = env.window.document.getElementById('preloader');
  assert.ok(pre.classList.contains('done'), 'прелоадер скрыт');
  assert.equal(env.impacts[env.impacts.length - 1], 'selection', 'готовность отзывается лёгким откликом');
  assert.ok(![...env.timers.values()].some((x) => x.ms > onCrest && x.ms < 4000), 'остаток рисунка снят вместе с прелоадером');
});

test('вибрация молчит при prefers-reduced-motion и без Telegram', async (t) => {
  const quiet = boot({ reduced: true });
  t.after(() => quiet.dom.window.close());
  assert.deepEqual(quiet.impacts, [], 'при запрете движения рисунок не ставится');
  runUpTo(quiet, 2000);
  await tick(); await tick(); await tick();
  assert.ok(quiet.window.document.getElementById('preloader').classList.contains('done'), 'прелоадер снят');
  assert.deepEqual(quiet.impacts, [], 'и готовность не отзывается вибрацией');

  const plain = boot({ telegram: false });
  t.after(() => plain.dom.window.close());
  runUpTo(plain, 2000);
  await tick(); await tick(); await tick();
  assert.deepEqual(plain.impacts, [], 'без HapticFeedback и вибратора тишина, а не ошибка');
});

test('ошибка загрузки скрывает прелоадер без «готового» отклика', async (t) => {
  const env = boot({ fail: true });
  t.after(() => env.dom.window.close());
  runUpTo(env, 200);
  env.impacts.length = 0;
  await tick(); await tick(); await tick();
  assert.ok(env.window.document.getElementById('preloader').classList.contains('done'), 'прелоадер снят');
  assert.deepEqual(env.impacts, [], 'сбой не отзывается как готовность');
});
