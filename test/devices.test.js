// Размеры интерфейса под устройства: iPhone, iPad, Android.
// Слой devices.js помечает <html data-device="…">, devices.css по нему
// переключает шкалу колонки, полей, кнопок и заголовков.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const devicesJs = fs.readFileSync(path.join(__dirname, '../public/devices.js'), 'utf8');
const devicesCss = fs.readFileSync(path.join(__dirname, '../public/devices.css'), 'utf8');

function loadDevices() {
  const dom = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(devicesJs);
  return dom;
}

// Первый блок вида `html[data-device='…'] { … }` — его токены.
function deviceTokens(device) {
  const m = devicesCss.match(new RegExp(`html\\[data-device='${device}'\\]\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(m, `блок шкалы для ${device} описан в devices.css`);
  const tokens = {};
  for (const pair of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;,\n]+)/g)) {
    tokens[pair[1]] = pair[2].trim();
  }
  return tokens;
}

test('device-слои подключаются последними: devices.css поверх ios.css, devices.js до app.js', () => {
  const ios = html.indexOf('href="/ios.css"');
  const devices = html.indexOf('href="/devices.css"');
  assert.ok(ios >= 0 && devices > ios, 'devices.css подключается после ios.css');
  const devJs = html.indexOf('src="/devices.js"');
  const appJs = html.indexOf('src="/app.js"');
  assert.ok(devJs >= 0 && appJs > devJs, 'devices.js выполняется до app.js');
});

test('класс устройства: iPhone, iPad и Android определяются по платформе и экрану', (t) => {
  const dom = loadDevices();
  t.after(() => dom.window.close());
  const { detect } = dom.window.PRICELEX_DEVICE;

  // Android — по платформе Telegram и по user agent браузера.
  assert.equal(detect({ platform: 'android' }), 'android');
  assert.equal(detect({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }), 'android');

  // iPhone и iPad — по user agent.
  assert.equal(detect({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), 'iphone');
  assert.equal(detect({ ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }), 'ipad');

  // Telegram на iOS отдаёт platform «ios» и для телефона, и для планшета —
  // различаем по стороне экрана.
  assert.equal(detect({ platform: 'ios', screenMin: 390 }), 'iphone');
  assert.equal(detect({ platform: 'ios', screenMin: 820 }), 'ipad');

  // iPadOS в браузере маскируется под macOS, но поддерживает мультитач.
  assert.equal(detect({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', touchPoints: 5 }), 'ipad');
  assert.equal(detect({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', touchPoints: 0 }), 'iphone');

  // Прочие окна: узкое — телефонная шкала, широкое — планшетная.
  assert.equal(detect({ ua: 'jsdom', width: 360 }), 'iphone');
  assert.equal(detect({ ua: 'jsdom', width: 900 }), 'ipad');
});

test('страница получает data-device и умеет переключать его', (t) => {
  const dom = loadDevices();
  t.after(() => dom.window.close());
  const root = dom.window.document.documentElement;
  const allowed = new Set(['iphone', 'ipad', 'android']);
  assert.ok(allowed.has(root.getAttribute('data-device')), 'на загрузке <html data-device="…"> выставлен');

  assert.equal(dom.window.PRICELEX_DEVICE.apply({ platform: 'android' }), 'android');
  assert.equal(root.getAttribute('data-device'), 'android');
  assert.equal(dom.window.PRICELEX_DEVICE.apply({ platform: 'ios', screenMin: 820 }), 'ipad');
  assert.equal(root.getAttribute('data-device'), 'ipad');
  assert.equal(dom.window.PRICELEX_DEVICE.apply({ platform: 'ios', screenMin: 390 }), 'iphone');
  assert.equal(root.getAttribute('data-device'), 'iphone');
});

test('у iPhone, Android и iPad разные размеры интерфейса', () => {
  const iphone = deviceTokens('iphone');
  const android = deviceTokens('android');
  const ipad = deviceTokens('ipad');

  // Колонка контента: телефон iPhone, чуть шире Android, планшет iPad.
  assert.equal(iphone['--app-w'], '480px');
  assert.equal(android['--app-w'], '520px');
  assert.equal(ipad['--app-w'], '700px');

  // Цели касания и поля: у Android крупнее iPhone (сетка 8dp), у iPad — крупнее всех.
  for (const token of ['--ui-btn', '--ui-field', '--ui-pad']) {
    const px = (v) => parseInt(v, 10);
    assert.ok(px(android[token]) > px(iphone[token]), `${token}: у Android крупнее, чем у iPhone`);
    assert.ok(px(ipad[token]) > px(android[token]), `${token}: у iPad крупнее, чем у Android`);
  }

  // Планшетная типографика, график и tab bar у iPad крупнее обеих телефонных шкал.
  for (const token of ['--ui-title', '--ui-h2', '--ui-chart', '--ui-nav-btn', '--ui-nav-ic']) {
    const px = (v) => parseInt(v, 10);
    assert.ok(px(ipad[token]) > px(iphone[token]), `${token}: у iPad крупнее, чем у iPhone`);
    assert.ok(px(ipad[token]) > px(android[token]), `${token}: у iPad крупнее, чем у Android`);
  }

  // Android говорит по-своему: системный Roboto без внешних шрифтов.
  assert.match(android['--font-sans'], /roboto/i);
  assert.ok(!devicesCss.includes('fonts.googleapis.com'), 'внешние шрифты не грузятся');
});

test('ширина окна тоже масштабирует интерфейс: компактные телефоны и планшетная сетка', () => {
  // Маленькие экраны (iPhone SE/mini, бюджетные Android) сжимают шкалу.
  assert.match(devicesCss, /@media \(max-width: 379px\)/);
  assert.match(devicesCss, /@media \(max-width: 379px\)[^}]*--ui-gutter:\s*13px/);

  // Широкие экраны (iPad в т.ч. на Android, десктопный браузер) получают
  // планшетную колонку и двухколоночные ленты.
  assert.match(devicesCss, /@media \(min-width: 700px\)/);
  assert.match(devicesCss, /@media \(min-width: 700px\)[^@]*#histList/);
  assert.match(devicesCss, /@media \(min-width: 700px\)[^@]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
});
