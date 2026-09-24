// Проверки нового дизайна: герой-карточка курса, график по реальной истории
// и сводка в истории обменов. Сеть и таймеры подменяются, как в web-app.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const now = Date.now();
const HOUR = 3600 * 1000;

const settings = {
  online: true,
  rateBTC: 10_000_000,
  rateGRAM: 125,
  rateUpdatedAt: now - 2 * HOUR,
  minRub: 3000,
  maxRub: 300000,
  announcement: 'PRICELEX',
  refPercent: 1,
  operator: '@test',
  channel: 'https://t.me/test',
  chat: 'https://t.me/test',
  botUsername: 'pricelex_test_bot',
};

const points = Array.from({ length: 8 }, (_, i) => ({
  at: now - (8 - i) * HOUR,
  btc: 9_900_000 + i * 20_000,
  gram: 120 + i,
}));

const wallet = 'bc1' + 'a'.repeat(38);
const order = (id, status, currency, rub, daysAgo, crypto) => ({
  id,
  status,
  currency,
  rub,
  payRub: status === 'completed' ? rub : null,
  crypto,
  wallet,
  rate: currency === 'BTC' ? 10_000_000 : 125,
  requisites: null,
  receipt: null,
  txUrl: null,
  createdAt: now - daysAgo * 24 * HOUR,
  updatedAt: now - daysAgo * 24 * HOUR,
});

const completed = [
  order(1, 'completed', 'BTC', 100_000, 3, 0.01),
  order(2, 'completed', 'BTC', 50_000, 2, 0.005),
  order(3, 'completed', 'GRAM', 30_000, 1, 240),
];

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ru = (n) => n.toLocaleString('ru-RU');

async function app(t, { orders = completed, points: historyPoints = points } = {}) {
  const dom = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.console.warn = () => {};
  window.setInterval = () => 1;
  window.fetch = async (url) => {
    const pathname = new URL(url, window.location.href).pathname;
    const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders, me: { id: 999, referredCount: 2 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/rates/history') return json({ hours: 24, updatedAt: settings.rateUpdatedAt, points: historyPoints });
    if (pathname === '/api/support/messages') return json({ messages: [] });
    if (pathname.startsWith('/api/order/')) return json({ order: orders[0] });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(script);
  await tick();
  await tick();
  return { window, document: window.document };
}

test('hero card shows the live rate, delta and a chart built from real observations', async (t) => {
  const a = await app(t);
  const hero = a.document.querySelector('#view-exchange .card-hero');
  assert.ok(hero, 'герой-карточка курса отрисована');

  // Курс и подпись.
  assert.equal(a.document.querySelector('#heroRate').textContent, ru(settings.rateBTC));
  assert.match(a.document.querySelector('#heroSub').textContent, /за 1 BTC/);
  assert.match(a.document.querySelector('#heroUpdated').textContent, /ч назад|мин назад|только что/);

  // Изменение курса считается по фактическим точкам (9 900 000 → 10 040 000).
  const delta = a.document.querySelector('#heroDelta .delta');
  assert.match(delta.className, /up/);
  assert.match(delta.textContent, /0\.14 %|1\.41 %/);
  assert.match(delta.textContent, /за 7 ч/);

  // График: заливка + линия + маркер и тултип с текущим значением.
  assert.ok(a.document.querySelector('#rateChart svg path.line'));
  assert.ok(a.document.querySelector('#rateChart svg path.area'));
  assert.ok(a.document.querySelector('#rateChart svg circle.dot-core'));
  assert.equal(a.document.querySelectorAll('#rateChart svg line.grid-v').length, 5);
  assert.match(a.document.querySelector('#rateChart .chart-tip .t-v').textContent, new RegExp(ru(10_040_000).replace(/\u00a0/g, '\\s')));
  assert.equal(a.document.querySelectorAll('#rateAxis span').length, 3);

  // Точки не выдумываются: пока данные отсутствуют — показываем пояснение, а не кривую.
  const b = await app(t, { points: [] });
  assert.ok(!b.document.querySelector('#rateChart svg path.line'), 'без истории линия не рисуется');
  assert.match(b.document.querySelector('#rateChart .chart-note').textContent, /история/i);
  assert.ok(b.document.querySelector('#heroDelta .delta.flat'));
  assert.equal(b.document.querySelector('#heroRate').textContent, ru(settings.rateBTC));
});

test('currency switch re-renders the hero, chart and calculator together', async (t) => {
  const a = await app(t);
  a.document.querySelectorAll('#segCur button')[1].click();
  await tick();
  assert.equal(a.document.querySelector('#heroRate').textContent, ru(settings.rateGRAM));
  assert.match(a.document.querySelector('#heroSub').textContent, /за 1 GRAM/);
  assert.match(a.document.querySelector('#rateChart .chart-tip .t-v').textContent, new RegExp(ru(127)));
  assert.match(a.document.querySelector('#cryptoLimits').textContent, /GRAM/);
  assert.ok(a.document.querySelectorAll('#segCur button')[1].classList.contains('on'));
  assert.ok(!a.document.querySelectorAll('#segCur button')[0].classList.contains('on'));
});

test('history tab summarises volume, lists orders and can filter completed ones', async (t) => {
  const a = await app(t);
  a.document.querySelector('.nav button[data-tab="history"]').click();
  await tick();
  const view = a.document.querySelector('#view-history');
  assert.ok(view.querySelector('.card-hero'), 'сводка по объёму отрисована');
  assert.match(view.querySelector('.card-hero .metric').textContent, new RegExp(ru(180_000)));
  assert.match(view.querySelector('.card-hero .metric-sub').textContent, /0\.015000 BTC|0\.015 BTC/);
  assert.ok(view.querySelector('#volChart svg path.line'), 'график объёмов по завершённым обменам');
  assert.equal(view.querySelectorAll('.h-item').length, 3);

  // Фильтр «Завершённые» не теряет строки, но отсекает незавершённые.
  view.querySelectorAll('#histSeg button')[1].click();
  await tick();
  assert.equal(view.querySelectorAll('.h-item').length, 3);
  assert.match(view.querySelector('.h-item .chip').textContent, /Завершён/);
});

test('empty history keeps a friendly state and does not render a chart', async (t) => {
  const a = await app(t, { orders: [] });
  a.document.querySelector('.nav button[data-tab="history"]').click();
  await tick();
  const view = a.document.querySelector('#view-history');
  assert.match(view.textContent, /История пока пуста/);
  assert.ok(!view.querySelector('#volChart'));
});
