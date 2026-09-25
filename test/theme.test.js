// Светлая тема: слой theme.css поверх ios.css, bootstrap theme.js до стилей,
// переключатель в профиле и следование теме Telegram/системы.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const themeJs = fs.readFileSync(path.join(__dirname, '../public/theme.js'), 'utf8');
const themeCss = fs.readFileSync(path.join(__dirname, '../public/theme.css'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const referenceCss = fs.readFileSync(path.join(__dirname, '../public/reference.css'), 'utf8');
const iosCss = fs.readFileSync(path.join(__dirname, '../public/ios.css'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function dom({ telegram = null, storage = {} } = {}) {
  const d = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = d;
  window.console.warn = () => {};
  if (telegram) window.Telegram = { WebApp: telegram };
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  return d;
}

test('theme.js выполняется до стилей, theme.css подключается последним слоем', () => {
  const dev = html.indexOf('src="/devices.js"');
  const theme = html.indexOf('src="/theme.js"');
  const styles = html.indexOf('href="/style.css"');
  assert.ok(theme > dev && theme < styles, 'bootstrap темы ставит data-theme раньше первой отрисовки');
  const fix = html.indexOf('href="/fix.css"');
  const light = html.indexOf('href="/theme.css"');
  assert.ok(light > fix, 'theme.css — последний слой палитры');
});

test('resolve: выбор клиента сильнее темы Telegram, Telegram сильнее системы', () => {
  const d = dom();
  d.window.eval(themeJs);
  const { resolve } = d.window.PRICELEX_THEME;
  d.window.close();
  assert.equal(resolve('light', { telegramScheme: 'dark', systemScheme: 'dark' }), 'light');
  assert.equal(resolve('dark', { telegramScheme: 'light', systemScheme: 'light' }), 'dark');
  assert.equal(resolve('system', { telegramScheme: 'light', systemScheme: 'dark' }), 'light');
  assert.equal(resolve('system', { telegramScheme: '', systemScheme: 'light' }), 'light');
  assert.equal(resolve('system', {}), 'dark', 'без окружения тема остаётся тёмной');
  assert.equal(resolve('garbage', { telegramScheme: 'light' }), 'light');
});

test('bootstrap: без сохранённого выбора тема берётся из окружения и красит html и meta', () => {
  const d = dom({ telegram: { colorScheme: 'light' } });
  d.window.eval(themeJs);
  const root = d.window.document.documentElement;
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(root.getAttribute('data-theme-mode'), 'system');
  const meta = d.window.document.querySelector('meta[name="theme-color"]');
  assert.equal(meta.getAttribute('content'), '#f6f5f2');
  assert.equal(d.window.document.querySelector('meta[name="color-scheme"]').getAttribute('content'), 'light');
  d.window.close();

  const b = dom();
  b.window.eval(themeJs);
  assert.equal(b.window.document.documentElement.getAttribute('data-theme'), 'dark', 'jsdom без светлой системной темы — тёмная');
  b.window.close();
});

test('сохранённый режим побеждает окружение и переживает перезапуск', () => {
  const d = dom({ telegram: { colorScheme: 'dark' }, storage: { pricelex_theme: 'light' } });
  d.window.eval(themeJs);
  assert.equal(d.window.document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(d.window.PRICELEX_THEME.get().mode, 'light');
  d.window.close();
});

test('set() сохраняет режим, перекрашивает html и уведомляет подписчиков', () => {
  const d = dom();
  d.window.eval(themeJs);
  const seen = [];
  d.window.PRICELEX_THEME.subscribe((s) => seen.push(s.theme));
  d.window.PRICELEX_THEME.set('light');
  assert.equal(d.window.document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(d.window.localStorage.getItem('pricelex_theme'), 'light');
  d.window.PRICELEX_THEME.set('dark');
  assert.deepEqual(seen, ['light', 'dark']);
  assert.equal(d.window.document.documentElement.getAttribute('data-theme-mode'), 'dark');
  d.window.close();
});

test('themeChanged Telegram переключает авто-режим и не трогает ручной выбор', () => {
  let onChange = null;
  const tg = {
    colorScheme: 'dark',
    onEvent: (name, cb) => { if (name === 'themeChanged') onChange = cb; },
    setHeaderColor: () => {},
    setBackgroundColor: () => {},
  };
  const d = dom({ telegram: tg });
  d.window.eval(themeJs);
  assert.equal(d.window.document.documentElement.getAttribute('data-theme'), 'dark');
  tg.colorScheme = 'light';
  onChange();
  assert.equal(d.window.document.documentElement.getAttribute('data-theme'), 'light', 'авто следует за Telegram');

  d.window.PRICELEX_THEME.set('dark');
  tg.colorScheme = 'light';
  onChange();
  assert.equal(d.window.document.documentElement.getAttribute('data-theme'), 'dark', 'ручной выбор Telegram не перебивает');
  d.window.close();
});

test('светлая палитра объявлена токенами: поверхности, текст, каналы и акцент', () => {
  const block = themeCss.match(/html\[data-theme='light'\]\s*\{[\s\S]*?--gram-rgb:[^;]*;/);
  assert.ok(block, 'блок светлых токенов присутствует');
  const body = block[0];
  for (const token of ['--bg-1', '--surface-2', '--ink', '--txt-2', '--mut', '--tint', '--tint-fill', '--ok', '--danger', '--line-rgb', '--overlay-rgb', '--shade-rgb', '--tint-rgb']) {
    assert.match(body, new RegExp(`${token.replace('--', '--')}\\s*:`), `светлое значение ${token} задано`);
  }
  assert.match(body, /--bg-1:\s*#f6f5f2/, 'фон приложения — тёплая бумага');
  assert.match(body, /color-scheme:\s*light/, 'формы браузера следуют светлой схеме');
  // Каналы объявлены в тёмных слоях, иначе производные цвета не соберутся.
  assert.match(referenceCss, /--line-rgb:\s*228, 236, 240/);
  assert.match(referenceCss, /--tint-rgb:\s*201, 168, 126/);
  assert.match(iosCss, /--tint-fill:\s*#c9a87e/, 'заливки кнопок отделены от текстового акцента');
});

test('график и переключатель темы живут в теме: стопы классами, сегменты в профиле', () => {
  assert.match(appJs, /class="gs-line-1"/, 'стопы графика без хардкода цветов');
  assert.doesNotMatch(appJs, /stop-color="#/, 'в app.js не осталось зашитых цветов градиентов');
  assert.match(referenceCss, /\.chart \.gs-line-1 \{ stop-color: var\(--sand-5\); \}/);
  assert.match(themeCss, /\.chart \.gs-area-1/, 'светлая доводка заливки графика');
  assert.match(appJs, /id="themeSeg"/, 'переключатель темы отрисовывается в профиле');
  assert.match(appJs, /THEME_MODES = \['light', 'dark', 'system'\]/, 'есть режим «авто»');
  assert.match(appJs, /data-theme-mode=/, 'сегменты несут режим в data-атрибуте');
});

// ---------- переключатель в живом приложении ----------
const now = Date.now();
const HOUR = 3600 * 1000;
const settings = {
  online: true, rateBTC: 10_000_000, rateGRAM: 125, rateUpdatedAt: now - HOUR,
  minRub: 3000, maxRub: 300000, announcement: '', refPercent: 1, operator: '@test',
  channel: 'https://t.me/test', chat: 'https://t.me/test', botUsername: 'test_bot',
  guaranteeFundBtc: 0.02, adminBrokers: [{ login: 'a', name: 'a', online: true, rating: 4.9, completed: 10 }],
};

async function app(t, { storage = {} } = {}) {
  const d = dom({ storage });
  t.after(() => d.window.close());
  const { window } = d;
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
  window.eval(themeJs);
  window.eval(script);
  await tick(); await tick();
  window.document.querySelector('.nav button[data-tab="profile"]').click();
  await tick(); await tick();
  return d;
}

test('профиль: сегменты переключают тему и подпись следует за состоянием', async (t) => {
  const d = await app(t);
  const doc = d.window.document;
  const seg = doc.querySelector('#themeSeg');
  assert.ok(seg, 'в настройках профиля есть переключатель темы');
  assert.deepEqual([...seg.querySelectorAll('button')].map((b) => b.dataset.themeMode), ['light', 'dark', 'system']);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark', 'по умолчанию тёмная');

  seg.querySelector('[data-theme-mode="light"]').click();
  await tick();
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(doc.querySelector('#themeValue').textContent, 'Светлая');
  assert.ok(seg.querySelector('[data-theme-mode="light"]').classList.contains('on'));
  assert.equal(d.window.localStorage.getItem('pricelex_theme'), 'light');
  assert.match(doc.querySelector('#toast').textContent, /Светлая тема включена/);

  seg.querySelector('[data-theme-mode="system"]').click();
  await tick();
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark', 'авто без светлого окружения — тёмная');
  assert.equal(doc.querySelector('#themeValue').textContent, 'Тёмная · авто');
});

test('профиль: сохранённый светлый режим применяется к приложению с порога', async (t) => {
  const d = await app(t, { storage: { pricelex_theme: 'light' } });
  const doc = d.window.document;
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  assert.ok(doc.querySelector('#themeSeg [data-theme-mode="light"]').classList.contains('on'));
  assert.equal(doc.querySelector('#themeValue').textContent, 'Светлая');
});
