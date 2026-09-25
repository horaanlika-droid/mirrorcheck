// Объёмные бронзовые иконки и логотип (ref IMG_1229) + кнопки-пилюли и
// воздушная типографика (ref IMG_1230): арт с прозрачностью, навигация и
// этапы подключают файлы, стили живут в ios/devices-слоях.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { decodePng } = require('../tools/png-key.js');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const iosCss = fs.readFileSync(path.join(__dirname, '../public/ios.css'), 'utf8');
const devicesCss = fs.readFileSync(path.join(__dirname, '../public/devices.css'), 'utf8');

const ART = ['logo-mark.png', 'tab-exchange.png', 'tab-history.png', 'tab-reviews.png', 'tab-refs.png', 'tab-profile.png', 'hero-shield.png', 'hero-coins.png'];

function alphaStats(file) {
  const img = decodePng(file);
  let transparent = 0;
  let opaque = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const a = img.px[i * 4 + 3];
    if (a === 0) transparent += 1;
    else if (a === 255) opaque += 1;
  }
  return { width: img.width, height: img.height, transparent, opaque };
}

test('3D-арт: PNG с прозрачным фоном, плотным силуэтом и интерфейсным размером', () => {
  for (const f of ART) {
    const st = alphaStats(path.join(__dirname, '../public/img', f));
    const total = st.width * st.height;
    assert.ok(st.transparent > total * 0.15, `${f}: фон выключен в альфу`);
    assert.ok(st.opaque > total * 0.08, `${f}: силуэт непрозрачен`);
    assert.ok(st.width <= 256 && st.height <= 256, `${f}: размер для интерфейса, не исходник`);
  }
});

function meanHue(file) {
  const img = decodePng(file);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const o = i * 4;
    if (img.px[o + 3] < 200) continue;
    const r = img.px[o] / 255;
    const g = img.px[o + 1] / 255;
    const b = img.px[o + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d < 0.02) continue; // почти ахроматические пиксели тон не несут
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    sx += Math.cos((h * Math.PI) / 180);
    sy += Math.sin((h * Math.PI) / 180);
    n += 1;
  }
  assert.ok(n > 100, 'достаточно цветных пикселей для замера');
  let mean = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (mean < 0) mean += 360;
  return mean;
}

test('весь арт сведён к одному оттенку бронзы: разброс набора минимален', () => {
  const hues = ART.map((f) => meanHue(path.join(__dirname, '../public/img', f)));
  for (const h of hues) assert.ok(h > 25 && h < 45, `оттенк в шампанской полосе: ${h.toFixed(1)}°`);
  const spread = Math.max(...hues) - Math.min(...hues);
  assert.ok(spread < 6, `набор не различается по оттенкам: разброс ${spread.toFixed(2)}°`);
});

test('прелоадер: блик скользит по силуэту герба через альфа-маску логотипа', () => {
  assert.match(html, /<div class="preloader-logo-wrap">/, 'логотип обёрнут для блика');
  assert.match(iosCss, /\.preloader-logo-wrap::after \{/, 'блик — слой над логотипом');
  assert.match(iosCss, /mask: url\('\/img\/logo-mark\.png'\) center \/ contain no-repeat;/, 'маска — альфа самого герба');
  assert.match(iosCss, /mix-blend-mode: screen;/, 'свет прибавляется к металлу');
  assert.match(iosCss, /@keyframes preloader-shine \{/, 'анимация проскальзывания');
});

test('кнопки и сегменты — шампанские пилюли по референсу IMG_1230', () => {
  assert.match(iosCss, /\.btn \{ min-height: 50px; border-radius: 999px;/, 'кнопки-пилюли');
  assert.match(iosCss, /\.btn-primary \{\n\s*color: var\(--tint-fill-ink\);\n\s*background: linear-gradient\(135deg, var\(--sand-1\) 0%, var\(--tint-fill\) 55%, var\(--sand-2\) 100%\);/, 'главная кнопка — шампанский градиент');
  assert.match(iosCss, /\.seg \{ gap: 2px; padding: 3px; border: 0; border-radius: 999px;/, 'трек сегментов — пилюля');
  assert.match(iosCss, /background: linear-gradient\(135deg, var\(--sand-1\) 0%, var\(--tint-fill\) 78%\);/, 'активный сегмент — шампанская таблетка');
  assert.match(iosCss, /\.nav button \.nav-art \{/, 'объёмные иконки навигации описаны');
  assert.match(devicesCss, /html\[data-device\] \.nav button \.nav-art \{/, 'шкала иконок следует устройству');
  // Воздушная типографика: крупные числа и заголовки без тяжёлого жирного.
  assert.match(iosCss, /\.metric \{ font-size: clamp\(32px, 9vw, 40px\); font-weight: 600; letter-spacing: -\.02em; \}/);
  assert.match(iosCss, /\.exchange-heading h1 \{ font-size: 34px; font-weight: 600;/);
});

// ---------- живое приложение ----------
const now = Date.now();
const HOUR = 3600 * 1000;
const settings = {
  online: true, rateBTC: 10_000_000, rateGRAM: 125, rateUpdatedAt: now - HOUR,
  minRub: 3000, maxRub: 300000, announcement: '', refPercent: 1, operator: '@test',
  channel: 'https://t.me/test', chat: 'https://t.me/test', botUsername: 'test_bot',
  guaranteeFundBtc: 0.02, adminBrokers: [{ login: 'a', name: 'a', online: true, rating: 4.9, completed: 10 }],
};
const wallet = 'bc1' + 'a'.repeat(38);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function app(t, orders = [], { order = null } = {}) {
  const d = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => d.window.close());
  const { window } = d;
  window.console.warn = () => {};
  window.setInterval = () => 1;
  window.fetch = async (url) => {
    const pathname = new URL(url, window.location.href).pathname;
    const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders, me: { id: 999, referredCount: 0 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/rates/history') return json({ hours: 24, updatedAt: settings.rateUpdatedAt, points: [] });
    if (pathname === '/api/support/messages') return json({ messages: [] });
    if (pathname === '/api/reviews') return json({ reviews: [], stats: { count: 0, avg: 0 } });
    if (pathname === '/api/captcha') return json({ id: 'c1', question: '1 + 1 = ?' });
    if (pathname === '/api/broker/status') return json({ application: null });
    if (pathname.startsWith('/api/order/')) return json({ order: order || orders[0] });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(appJs);
  await tick(); await tick();
  return d;
}

test('навигация собрана из объёмных иконок, инфо получает щит', async (t) => {
  const d = await app(t);
  const doc = d.window.document;
  const srcs = () => [...doc.querySelectorAll('#nav button .nav-art')].map((i) => i.getAttribute('src'));
  assert.deepEqual(srcs(), ['/img/tab-exchange.png', '/img/tab-history.png', '/img/tab-reviews.png', '/img/tab-refs.png', '/img/tab-profile.png']);
  doc.querySelector('.nav button[data-tab="profile"]').click();
  await tick();
  doc.querySelector('#view-profile [data-go="info"]').click();
  await tick();
  assert.equal(srcs()[4], '/img/hero-shield.png', 'пункт «Инфо» со щитом');
});

test('шапка обмена с монетами, завершение заявки — объёмный щит', async (t) => {
  const paid = {
    id: 7, status: 'paid', currency: 'BTC', rub: 100_000, payRub: 100_000, crypto: 0.01,
    wallet, rate: 10_000_000, requisites: 'СБП +79991112233', receipt: 'r.pdf', txUrl: null,
    createdAt: now - 24 * HOUR, updatedAt: now - HOUR, broker: 'safer',
  };
  const done = { ...paid, status: 'completed', updatedAt: now };
  const d = await app(t, [paid], { order: done });
  const doc = d.window.document;
  assert.equal(doc.querySelector('.exchange-logo-badge').getAttribute('src'), '/img/hero-coins.png');
  assert.ok(!doc.querySelector('#exOrder .okmark-art'), 'пока оплата не подтверждена — щита нет');
  //_pollOrder подтягивает завершение при возвращении вкладки_
  doc.dispatchEvent(new d.window.Event('visibilitychange'));
  await tick(); await tick(); await tick();
  const art = doc.querySelector('#exOrder .okmark-art');
  assert.ok(art, 'завершённая заявка показывает объёмный щит');
  assert.equal(art.getAttribute('src'), '/img/hero-shield.png');
});
