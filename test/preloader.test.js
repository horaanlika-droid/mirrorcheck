// Прелоадер: статичный кадр — большое лого, полный текст (PRICELEX · Private
// Crypto Brokerage · Since 2025) и никакого «загрузочного» движения. Кадр
// держится подольше и уходит целиком, когда данные готовы. Тактильный отклик —
// толчок на старте и ответ на готовности. Таймеры подменяются,
// Telegram.HapticFeedback — заглушка.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const html = pub('index.html');
const styleCss = pub('style.css');
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

function boot({ reduced = false, telegram = true, fail = false, browser = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.console.warn = () => {};
  if (browser) Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 Chrome/130' });
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

// Только те правила, что относятся к прелоадеру: по ним сверяем «нет анимаций».
const preloaderRules = (css) => css.split(/\n(?=\S)/).filter((b) => /\.preloader/.test(b)).join('\n');

test('прелоадер: большое лого и полный текст — PRICELEX, Private Crypto Brokerage, Since 2025', () => {
  assert.match(html, /class="preloader-wordmark" src="\/img\/logo-full\.png"/);
  assert.match(html, /alt="PRICELEX — Since 2025" width="1200" height="561"/);
  assert.match(html, /<div class="preloader-tag">Private Crypto Brokerage<\/div>/);
  assert.doesNotMatch(html, /preloader-logo-wrap|preloader-logo-sheen|preloader-bar|preloader-progress/);
  assert.match(pub('glass.css'), /\.preloader-inner \{[^}]*animation: none;/);
  assert.doesNotMatch(html, /class="preloader-brand"|class="preloader-est"/,
    'полное название и год уже внутри логотипа, не дублируются');
});

test('инфографика не соприкасается с буквами: зазор задан явно и хранится фикс-слоем', () => {
  const fixCss = pub('fix.css');
  assert.match(fixCss, /\.preloader-logo \{[^}]*margin-bottom: 46px !important;/s, 'фикс-слой гарантирует воздух до букв');
  assert.match(fixCss, /@media \(min-width: 700px\) \{\s*\.preloader-logo \{\s*margin-bottom: 60px !important;/s, 'на планшете зазор растёт вместе с гербом');
});

test('шкалы: лого крупное и не прижато к буквам', () => {
  // Базовая шкала —Fluid-размер и большой зазор до набора.
  const base = styleCss.match(/\.preloader-logo \{[\s\S]*?\}/)[0];
  assert.match(base, /width: clamp\(196px, 54vw, 264px\); height: auto; object-fit: contain;/, 'лого большое');
  assert.match(base, /margin: 0 auto 46px;/, 'между графикой и буквами — воздух');
  assert.match(base, /filter: none;/, 'герб без фильтров и подсветок');

  // iOS-шкала держит ту же пропорцию.
  const ios = iosCss.match(/\.preloader-logo \{[^\n]*\}/)[0];
  assert.match(ios, /width: 214px; height: auto; margin-bottom: 40px;/, 'iOS: крупное лого и отступ до букв');
  assert.match(ios, /filter: none;/, 'iOS: герб статичен и без фильтров');

  // Планшет: лого растёт вместе с кадром, зазор до букв — тоже.
  const tablet = devicesCss.match(/html\[data-device\] \.preloader-logo \{[^\n]*\}/)[0];
  assert.match(tablet, /width: 300px; height: auto; margin-bottom: 56px;/, 'планшет: пропорции и воздух сохранены');
});

test('прелоадер не анимируется: ни блика, ни заполнения, ни бесконечных циклов', () => {
  assert.doesNotMatch(iosCss, /@keyframes preloader-shine/, 'анимация блика удалена из css');
  assert.doesNotMatch(styleCss, /@keyframes preloader-fill/, 'анимация заполнения бара удалена из css');
  assert.doesNotMatch(preloaderRules(iosCss), /animation: (?!none)/, 'в iOS-правилах прелоадера нет ни одной анимации');
  assert.doesNotMatch(preloaderRules(styleCss), /animation: (?!none)[^;]*infinite/, 'бесконечных циклов на прелоадинге нет');
  // Единственное движение — прозрачность появления и ухода.
  assert.match(styleCss, /@keyframes preloader-in \{\n\s*from \{ opacity: 0; \}\n\s*to \{ opacity: 1; \}\n\}/, 'только смена прозрачности');
  assert.match(styleCss, /\.preloader \{\n\s*position: fixed;[\s\S]*?transition: opacity \.8s var\(--ease-o\), visibility \.8s;/, 'уход — медленное растворение');
});

test('при prefers-reduced-motion кадр статичен полностью', () => {
  const blocks = [...iosCss.matchAll(/@media \(prefers-reduced-motion: reduce\) \{\n([\s\S]*?)\n\}/g)]
    .map((m) => m[0])
    .filter((b) => /\.preloader/.test(b));
  assert.equal(blocks.length, 1, 'для прелоадера задан один блок без движения');
  assert.match(blocks[0], /\.preloader-inner \{ animation: none; \}/, 'появление выключено');
  assert.match(blocks[0], /\.preloader \{ transition: none; \}/, 'уход без перехода');
});

test('тактильный отклик: толчок на старте и ответ на готовности — без импульсов «под луч»', async (t) => {
  const env = boot();
  t.after(() => env.dom.window.close());
  const beats = [...env.timers.values()].map((x) => x.ms).sort((a, b) => a - b);
  assert.ok(beats.includes(140), `стартовый толчок поставлен: ${beats.join(', ')}`);
  assert.ok(!beats.some((ms) => ms > 140 && ms < 1200), 'промежуточных импульсов под анимацию нет');

  runUpTo(env, 200);
  assert.deepEqual(env.impacts, ['soft'], 'на старте — только мягкий толчок');

  await tick(); await tick();
  const pre = env.window.document.getElementById('preloader');
  assert.ok(pre.classList.contains('done'), 'прелоадер скрыт');
  assert.deepEqual(env.impacts, ['soft', 'selection'], 'готовность отзывается лёгким откликом');
  assert.equal(pre.getAttribute('aria-hidden'), 'true', 'кадр выведен из области объявления');
});

test('кадр держится дольше и не ждёт дольше страховочного таймаута', () => {
  const m = appJs.match(/const minDuration = (\d+);/);
  assert.ok(m, 'минимальная длительность прелоадинга задана в app.js');
  assert.ok(Number(m[1]) >= 5200, `кадр держится не меньше 5.2 с: ${m[1]} мс`);
  assert.match(appJs, /const preloaderFallback = setTimeout\(\(\) => hidePreloader\(\), 8000\);/,
    'страховочный таймаут на случай медленного init остался');
});

test('отклик молчит при prefers-reduced-motion и без Telegram', async (t) => {
  const quiet = boot({ reduced: true });
  t.after(() => quiet.dom.window.close());
  assert.deepEqual(quiet.impacts, [], 'при запрете движения отклик не ставится');
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


test('браузер: готовый интерфейс остаётся за логотипом до конца 5.2-секундной паузы', async (t) => {
  const env = boot({ browser: true });
  t.after(() => env.dom.window.close());
  await tick(); await tick();
  const pre = env.window.document.getElementById('preloader');
  assert.equal(pre.classList.contains('done'), false);
  const hold = [...env.timers.values()].find(({ ms }) => ms > 4800 && ms <= 5200);
  assert.ok(hold, 'оставшаяся пауза поставлена даже при быстром API');
  hold.fn();
  assert.equal(pre.classList.contains('done'), true);
  assert.equal(pre.getAttribute('aria-hidden'), 'true');
});
