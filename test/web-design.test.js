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
  // Общий депозит всех брокеров площадки: его задаёт оператор в боте.
  guaranteeFundBtc: 0.02,
  adminBrokers: [
    { login: 'stony montana', name: 'stony montana', online: true, rating: 4.98, completed: 342 },
    { login: 'safer', name: 'safer', online: true, rating: 4.96, completed: 289 },
    { login: 'INGA352', name: 'INGA352', online: true, rating: 4.99, completed: 415 },
    { login: 'user_161931', name: 'user_161931', online: true, rating: 4.95, completed: 198 },
    { login: 'fast alberto', name: 'fast alberto', online: true, rating: 4.97, completed: 276 },
  ],
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

const reviewsFixture = [
  { id: 1, name: 'Алексей К.', rating: 5, text: 'Брокер нашёл лучший курс', createdAt: now - 24 * HOUR },
  { id: 2, name: 'Марина', rating: 4, text: 'Спокойно и честно', createdAt: now - 48 * HOUR },
];

async function app(t, { orders = completed, points: historyPoints = points, reviews = reviewsFixture, clock = null } = {}) {
  const posted = [];
  const dom = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  if (clock) window.Date.now = () => clock.t; // тест двигает время сам
  window.console.warn = () => {};
  window.setInterval = () => 1;
  window.fetch = async (url, opts) => {
    const pathname = new URL(url, window.location.href).pathname;
    const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders, me: { id: 999, referredCount: 2 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/rates/history') return json({ hours: 24, updatedAt: settings.rateUpdatedAt, points: historyPoints });
    if (pathname === '/api/support/messages') return json({ messages: [] });
    if (pathname === '/api/reviews' && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      posted.push(body);
      const o = orders.find((x) => x.id === body.orderId);
      return json({ review: { id: 99, name: 'Клиент', rating: body.rating, text: body.text, createdAt: now, orderId: o.id }, order: { ...o, review: { id: 99 } } });
    }
    if (pathname === '/api/reviews') return json({ reviews, stats: { count: reviews.length, avg: 4.5 } });
    if (pathname.startsWith('/api/order/')) return json({ order: orders[0] });
    if (pathname === '/api/captcha') return json({ id: 'cap1', question: '3 + 4 = ?' });
    if (pathname === '/api/broker/status') return json({ application: null });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(script);
  await tick();
  await tick();
  // Переключение вкладок заставляет приложение перерисовать экран текущим временем.
  const showTab = async (tab) => {
    const button = window.document.querySelector(`.nav button[data-tab="${tab}"]`);
    if (button) button.click();
    await tick();
    await tick();
  };
  return { window, document: window.document, posted, showTab };
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

test('five-tab navigation opens profile, info and support as secondary screens', async (t) => {
  const a = await app(t);
  const tabs = [...a.document.querySelectorAll('.nav button')].map((b) => b.dataset.tab);
  assert.deepEqual(tabs, ['exchange', 'history', 'reviews', 'refs', 'profile']);
  assert.equal(a.document.querySelector('#appHeader .hdr-logo').textContent, 'PRICELEX');

  a.document.querySelector('.nav button[data-tab="profile"]').click();
  assert.ok(a.document.querySelector('#view-profile .profile-identity'));
  assert.ok(a.document.querySelector('.nav').classList.contains('hidden'));
  a.document.querySelector('#view-profile [data-go="info"]').click();
  assert.equal(a.document.querySelector('#appHeader .hdr-page-title').textContent, 'Инфо');
  assert.deepEqual([...a.document.querySelectorAll('.nav button')].map((b) => b.dataset.tab), ['exchange', 'history', 'reviews', 'refs', 'info']);
  a.document.querySelector('#headerBack').click();
  assert.ok(!a.document.querySelector('#view-profile').classList.contains('hidden'));
  a.document.querySelector('#view-profile [data-go="support"]').click();
  assert.equal(a.document.querySelector('#appHeader .hdr-page-title').textContent, 'Помощь');
  assert.ok(a.document.querySelector('.nav').classList.contains('hidden'));
  a.document.querySelector('#headerBack').click();
  assert.ok(!a.document.querySelector('#view-profile').classList.contains('hidden'));
});

test('reference stylesheet is applied after the legacy component sheet', () => {
  const base = html.indexOf('href="/style.css"');
  const reference = html.indexOf('href="/reference.css"');
  assert.ok(base >= 0 && reference > base);
  const css = fs.readFileSync(path.join(__dirname, '../public/reference.css'), 'utf8');
  // Палитра референса IMG_1217: графитовая база и шампанский акцент.
  assert.match(css, /--bg-1:\s*#080d11/i);
  assert.match(css, /--sand-3:\s*#c9a87e/i);
  assert.match(css, /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
});

test('active order is a back-navigable subpage with a resume card on exchange', async (t) => {
  const active = order(99, 'new', 'BTC', 5000, 0, 0.0005);
  const a = await app(t, { orders: [active] });
  assert.equal(a.document.querySelector('#appHeader .hdr-page-title').textContent, 'Заявка');
  assert.ok(a.document.querySelector('.nav').classList.contains('hidden'));
  a.document.querySelector('#headerBack').click();
  assert.equal(a.document.querySelector('#appHeader .hdr-logo').textContent, 'PRICELEX');
  assert.ok(a.document.querySelector('#activeOrder'));
  assert.ok(!a.document.querySelector('#exForm').classList.contains('hidden'));
  a.document.querySelector('#activeOrder').click();
  assert.equal(a.document.querySelector('#appHeader .hdr-page-title').textContent, 'Заявка');
});

test('клиент видит общий депозит всех брокеров: 0.02 стоит, все знаки после него живут', async (t) => {
  const clock = { t: now };
  const a = await app(t, { clock });
  const card = a.document.querySelector('#view-exchange #depositCard');
  assert.ok(card, 'карточка гарантии стоит на экране обмена');
  assert.match(card.querySelector('.dep-copy b').textContent, /Гарантийный депозит брокеров/);
  assert.match(card.querySelector('.dep-copy span').textContent, /Общий депозит всех брокеров площадки/);
  assert.ok(card.querySelector('.dep-live'), 'у суммы есть признак живого значения');

  const amountOf = () => a.document.querySelector('#view-exchange #depositCard .dep-btc').textContent.trim();
  const first = amountOf();
  // Начало суммы — как задал оператор (0.02); все шесть знаков после него свободны.
  assert.match(first, /^0\.02\d{6}$/, 'после 0.02 видны все знаки');
  assert.ok(Number(first) >= settings.guaranteeFundBtc, 'фонд не показывается меньше заданного');
  assert.ok(Number(first) <= settings.guaranteeFundBtc * 1.16, 'и не уходит далеко вверх');

  // Смотрим час шагом 3 минуты: живут не только последние четыре знака, а весь
  // хвост после 0.02 — первый знак после него тоже успевает смениться.
  const tails = new Set([first.slice(4)]);
  for (let i = 1; i <= 20; i += 1) {
    clock.t = now + i * 3 * 60000;
    await a.showTab('reviews');
    await a.showTab('exchange');
    const value = amountOf();
    assert.match(value, /^0\.02\d{6}$/, `сумма остаётся в формате фонда: ${value}`);
    tails.add(value.slice(4));
  }
  assert.ok(tails.size >= 3, 'значения не замирают на одном числе');
  const firstDigits = new Set([...tails].map((tail) => tail[0]));
  const secondDigits = new Set([...tails].map((tail) => tail[1]));
  const middleDigits = new Set([...tails].map((tail) => tail[2] + tail[3]));
  assert.ok(firstDigits.size >= 2, 'меняется и первый знак после 0.02, а не только последние четыре');
  assert.ok(secondDigits.size >= 3, 'второй знак хвоста тоже живёт');
  assert.ok(middleDigits.size >= 4, 'середина хвоста дышит');
});

test('«Брокеров в сети» подписано словами и меняется на ±1/±2 вокруг состава', async (t) => {
  const clock = { t: now };
  const a = await app(t, { clock });
  const countOf = () => {
    const chip = a.document.querySelector('.brokers-online-chip');
    assert.match(chip.textContent, /Брокеров в сети:\s*\d+/, 'число подписано «Брокеров в сети»');
    return Number(chip.querySelector('.broker-online-count').textContent);
  };
  const first = countOf();
  assert.ok(first >= 4 && first <= 7, `число держится вокруг состава команды, получено ${first}`);

  const seen = new Set([first]);
  let prev = first;
  for (let i = 1; i <= 30; i += 1) {
    clock.t = now + i * 60000; // каждую минуту смотрим счётчик заново
    await a.showTab('reviews');
    await a.showTab('exchange');
    const value = countOf();
    assert.ok(Math.abs(value - prev) <= 2, `шаг ${prev} → ${value} не больше двух человек`);
    assert.ok(value >= 4 && value <= 7, `значение ${value} не выходит за состав команды`);
    seen.add(value);
    prev = value;
  }
  assert.ok(seen.size >= 2, 'счётчик действительно живёт');
});

test('метка просадки и лучшая цена показывают органичное время, а не ровный час', async (t) => {
  const a = await app(t);
  const label = a.document.querySelector('#rateChart .chart-dip .d-k').textContent;
  const dipTime = label.replace(/^.*·\s*/, '').trim();
  assert.match(dipTime, /^\d{2}:\d{2}$/);
  assert.doesNotMatch(dipTime, /:([0-5])[05]$/, `время просадки не ровное: ${dipTime}`);

  const signalTime = a.document.querySelector('#rateSignal .signal .s-t').textContent.replace(/^.*в\s*/, '').trim();
  assert.match(signalTime, /^\d{2}:\d{2}$/);
  assert.doesNotMatch(signalTime, /:([0-5])[05]$/, `время лучшей цены не ровное: ${signalTime}`);
});

test('chart marks the dip and calls out the best time to buy when the rate sits near the low', async (t) => {
  const shape = [0, -0.5, -1.4, -2.2, -2.6, -2.1, -1.2, -0.6, -0.4, -0.3, -2.3];
  const dipPoints = shape.map((d, i) => ({ at: now - (shape.length - i) * HOUR, btc: Math.round(10_000_000 * (1 + d / 100)), gram: 125 }));
  const a = await app(t, { points: dipPoints });
  const dip = a.document.querySelector('#rateChart .chart-dip');
  assert.ok(dip, 'просадка подписана на графике');
  assert.match(dip.textContent, new RegExp(ru(9_740_000).replace(/\u00a0/g, '\\s')));
  assert.ok(a.document.querySelector('#rateChart svg .dip-mark'));
  assert.ok(a.document.querySelector('#rateChart svg .dip-line'));
  assert.match(a.document.querySelector('#rateSignal .signal.buy').textContent, /Лучшее время для покупки/);
  assert.match(a.document.querySelector('#rateSignal .disclaimer').textContent, /Не является инвестиционной рекомендацией/);

  // Когда курс у максимума — сигнала «покупать» нет, но лучшая цена периода названа.
  const b = await app(t);
  assert.ok(!b.document.querySelector('#rateSignal .signal.buy'));
  assert.match(b.document.querySelector('#rateSignal .signal').textContent, /Лучшая цена/);
});

test('reviews tab shows reviews, lets a client review a completed order and never mentions moderation', async (t) => {
  const a = await app(t);
  a.document.querySelector('.nav button[data-tab="reviews"]').click();
  await tick(); await tick();
  const view = a.document.querySelector('#view-reviews');
  assert.equal(view.querySelectorAll('.rv-item').length, 2);
  assert.match(view.querySelector('.rv-score .metric').textContent, /4\.5/);
  assert.ok(view.querySelector('#tabRvOrder'), 'несколько завершённых обменов — можно выбрать какой оценить');
  view.querySelectorAll('#tabRvStars button')[3].click();
  view.querySelector('#tabRvText').value = 'Очень достойный сервис';
  view.querySelector('#tabRvSend').click();
  await tick(); await tick();
  assert.deepEqual(a.posted[0], { orderId: 1, rating: 4, text: 'Очень достойный сервис', startParam: '', initData: '', demo: a.posted[0].demo });
  assert.match(a.document.querySelector('#toast').textContent, /опубликован/);
  assert.equal(view.querySelectorAll('.rv-item').length, 3, 'свой отзыв сразу в ленте');
  assert.ok(!/модерац/i.test(a.document.body.textContent));
});

test('reviews tab explains that a review needs a completed exchange', async (t) => {
  const a = await app(t, { orders: [] });
  a.document.querySelector('.nav button[data-tab="reviews"]').click();
  await tick(); await tick();
  const view = a.document.querySelector('#view-reviews');
  assert.ok(!view.querySelector('.rv-form'));
  assert.match(view.textContent, /после завершённого обмена/);
});

test('info tab carries the founder speech word for word and never mentions a fee', async (t) => {
  const a = await app(t);
  a.document.querySelector('.nav button[data-tab="profile"]').click();
  a.document.querySelector('#view-profile [data-go="info"]').click();
  await tick();
  const lines = [...a.document.querySelectorAll('#speech .sp-line')].map((p) => p.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(lines, [
    'PRICELEX — это не просто обменник.',
    'Это экосистема, где каждый сотрудник прошёл непростой путь, но на этом пути он овладевал навыками в мире криптовалют.',
    'И теперь мы экономим ваше время и нервы.',
    'Мы не обменник. Мы агентство брокеров — проверенная и быстрая команда профессионалов.',
    'Да, иногда приходится подождать.',
    'Но мы знаем, кто мы. Мы отвечаем за качество репутацией.',
  ]);
  assert.ok(!/комисси/i.test(a.document.querySelector('#view-info').textContent));
  assert.equal(a.document.querySelector('#view-info .contact').href, 'https://t.me/test');
});

test('active order in details stage renders broker info, call-admin button and connects to chat on problem', async (t) => {
  const detailsOrder = {
    id: 42,
    status: 'details',
    broker: 'stony montana',
    rub: 5000,
    payRub: 5000,
    currency: 'BTC',
    crypto: 0.0005,
    wallet: 'bc1' + 'a'.repeat(38),
    requisites: 'СБП +79991112233 Т-Банк',
    createdAt: now,
  };
  const a = await app(t, { orders: [detailsOrder] });
  const exOrder = a.document.querySelector('#exOrder');
  assert.ok(exOrder);
  assert.match(exOrder.textContent, /Заявку ведёт брокер/);
  assert.match(exOrder.textContent, /stony montana/);
  const btnCall = exOrder.querySelector('#btnCallAdmin');
  assert.ok(btnCall, 'кнопка вызова админа на этапе заявки присутствует');
  assert.match(btnCall.textContent, /Позвать админа|Проблема/);
});
