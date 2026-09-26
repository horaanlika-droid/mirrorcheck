// Тема одна — тёмная: ни светлой палитры, ни переключателя, ни bootstrap'а
// с разрешением режима. Токены объявлены безусловно в слоях
// style/reference/ios, хром Telegram красится app.js в цвет темы.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const html = pub('index.html');
const appJs = pub('app.js');
const referenceCss = pub('reference.css');
const iosCss = pub('ios.css');
const styleCss = pub('style.css');
const devicesCss = pub('devices.css');
const fixCss = pub('fix.css');

// Все слои, которые реально доезжают до браузера.
const layers = { 'index.html': html, 'style.css': styleCss, 'reference.css': referenceCss, 'ios.css': iosCss, 'devices.css': devicesCss, 'fix.css': fixCss, 'app.js': appJs };

test('светлой темы нет: ни файлов палитры, ни подключения в разметке', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, '../public/theme.css')), 'слой светлых токенов удалён');
  assert.ok(!fs.existsSync(path.join(__dirname, '../public/theme.js')), 'bootstrap переключения темы удалён');
  assert.doesNotMatch(html, /href="\/theme\.css"/, 'светлый слой не подключается');
  assert.doesNotMatch(html, /src="\/theme\.js"/, 'скрипт переключения темы не подключается');
});

test('тёмная палитра объявлена безусловно и не зависит от атрибутов', () => {
  assert.match(html, /<html[^>]*data-theme="dark"/, 'разметка сразу помечена тёмной темой');
  for (const [name, src] of Object.entries(layers)) {
    if (!name.endsWith('.css')) continue;
    assert.doesNotMatch(src, /data-theme='light'/, `${name}: нет светлых токенов`);
    assert.doesNotMatch(src, /data-theme="light"/, `${name}: нет светлых токенов`);
  }
  assert.match(html, /<meta name="theme-color" content="#080d11"/, 'хром браузера — графитовый');
  assert.match(html, /<meta name="color-scheme" content="dark"/, 'формы браузера — тёмные');
  // Каналы объявлены в тёмных слоях, иначе производные цвета не соберутся.
  assert.match(referenceCss, /--line-rgb:\s*228, 236, 240/);
  assert.match(referenceCss, /--tint-rgb:\s*201, 168, 126/);
  assert.match(iosCss, /--tint-fill:\s*#c9a87e/, 'заливки кнопок отделены от текстового акцента');
});

test('переключателя темы нет ни в профиле, ни в API приложения', () => {
  assert.doesNotMatch(appJs, /THEME_MODES/, 'режимов темы больше нет');
  assert.doesNotMatch(appJs, /id="themeSeg"/, 'сегменты переключателя не рисуются');
  assert.doesNotMatch(appJs, /PRICELEX_THEME/, 'публичного API темы больше нет');
  assert.doesNotMatch(appJs, /pricelex_theme/, 'сохранённого выбора темы больше нет');
  assert.doesNotMatch(iosCss, /\.theme-picker/, 'стилей переключателя больше нет');
});

test('график по-прежнему красится из токенов, без хардкода цветов', () => {
  assert.match(appJs, /class="gs-line-1"/, 'стопы графика без хардкода цветов');
  assert.doesNotMatch(appJs, /stop-color="#/, 'в app.js не осталось зашитых цветов градиентов');
  assert.match(referenceCss, /\.chart \.gs-line-1 \{ stop-color: var\(--sand-5\); \}/);
});

test('хром Telegram красится в цвет тёмной темы после ready()', () => {
  assert.match(appJs, /CHROME_COLOR = '#080d11'/);
  assert.match(appJs, /tg\.setHeaderColor\(CHROME_COLOR\)/);
  assert.match(appJs, /tg\.setBackgroundColor\(CHROME_COLOR\)/);
  const ready = appJs.indexOf('tg.ready()');
  assert.ok(ready > 0 && appJs.indexOf('tg.setHeaderColor') > ready, 'цвета ставятся после ready()');
});

// ---------- профиль в живом приложении ----------
const now = Date.now();
const HOUR = 3600 * 1000;
const settings = {
  online: true, rateBTC: 10_000_000, rateGRAM: 125, rateUpdatedAt: now - HOUR,
  minRub: 3000, maxRub: 300000, announcement: '', refPercent: 1, operator: '@test',
  channel: 'https://t.me/test', chat: 'https://t.me/test', botUsername: 'test_bot',
  guaranteeFundBtc: 0.02, adminBrokers: [{ login: 'a', name: 'a', online: true, rating: 4.9, completed: 10 }],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function app(t, { telegram = null, storage = {} } = {}) {
  const d = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => d.window.close());
  const { window } = d;
  window.console.warn = () => {};
  if (telegram) window.Telegram = { WebApp: telegram };
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  window.setInterval = () => 1;
  window.fetch = async (url) => {
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
  await tick(); await tick();
  window.document.querySelector('.nav button[data-tab="profile"]').click();
  await tick(); await tick();
  return d;
}

test('профиль: настроек без переключателя темы, приложение остаётся тёмным', async (t) => {
  const d = await app(t, { telegram: { colorScheme: 'light' } });
  const doc = d.window.document;
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark', 'светлая тема Telegram игнорируется');
  assert.equal(doc.querySelector('#themeSeg'), null, 'переключателя нет в разметке');
  const rows = [...doc.querySelectorAll('.profile-settings .profile-row-copy b')].map((b) => b.textContent);
  assert.deepEqual(rows, ['Уведомления', 'Звук кассы', 'Виброотклик', 'Язык'],
    'в настройках — уведомления, отклик (звук кассы и вибрация) и язык');
  assert.match(doc.querySelector('#view-profile').textContent, /Русский/);
});

test('профиль: сохранённый когда-то режим темы не влияет на палитру', async (t) => {
  const d = await app(t, { storage: { pricelex_theme: 'light' } });
  const doc = d.window.document;
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(doc.querySelector('#themeSeg'), null);
});
