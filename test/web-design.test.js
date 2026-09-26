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
  const timers = [];
  const dom = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  if (clock) window.Date.now = () => clock.t; // тест двигает время сам
  window.console.warn = () => {};
  window.setInterval = () => 1;
  // Таймеры копим, а не исполняем: тест сам решает, когда «прошли 20 секунд».
  window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
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
  const fire = (ms) => {
    const due = timers.filter((x) => x.ms === ms);
    due.forEach((x) => x.fn());
    return due.length;
  };
  return { window, document: window.document, posted, showTab, timers, fire };
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
  // iOS-слой подключается последним: системный шрифт, плоские поверхности, бронзовый tint.
  const ios = html.indexOf('href="/ios.css"');
  assert.ok(ios > reference);
  const iosCss = fs.readFileSync(path.join(__dirname, '../public/ios.css'), 'utf8');
  assert.match(iosCss, /--tint:\s*#c9a87e/i);
  assert.match(iosCss, /-apple-system/);
  assert.ok(!html.includes('fonts.googleapis.com'), 'внешние шрифты не грузятся — только системный SF');
});

test('логотип — прозрачный PNG без кленового листа над короной', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../public/img/logo-mark.png')));
  assert.ok(!fs.existsSync(path.join(__dirname, '../public/img/logo.jpg')));
  assert.ok(!html.includes('logo.jpg') && !script.includes('logo.jpg'));
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

test('депозит брокеров вписан тихой строкой: 0.0200 стоит, живут только последние четыре знака — пошагово, ± несколько сатоши', async (t) => {
  const clock = { t: now };
  const a = await app(t, { clock });
  const exchange = a.document.querySelector('#view-exchange');
  assert.ok(!exchange.querySelector('#depositCard'), 'депозит не выделен отдельной карточкой');
  assert.doesNotMatch(exchange.textContent, /живая сумма|меняется вместе с рынком/,
    'про живую сумму и рынок клиенту не сообщается');

  // Единственное упоминание — мелкая приглушённая строка в форме обмена.
  const lineOf = () => a.document.querySelector('#view-exchange #exForm .dep-line');
  const line = lineOf();
  assert.ok(line, 'депозит вписан строкой в форму обмена');
  assert.match(line.textContent, /Сделка застрахована общим депозитом брокеров площадки/);
  assert.deepEqual([...line.children].map((el) => el.className), ['dep-btc'],
    'внутри строки выделена только цифра, и та же строкой');

  const amountOf = () => lineOf().querySelector('.dep-btc').textContent.trim();
  const sat = (value) => Math.round(Number(value) * 1e8);
  const first = amountOf();
  // Начало суммы — как задал оператор (0.0200); живут только последние четыре знака.
  assert.match(first, /^0\.0200\d{4}$/, 'после 0.02 первые два знака стоят, живут последние четыре');
  assert.ok(Number(first) >= settings.guaranteeFundBtc, 'фонд не показывается меньше заданного');
  assert.ok(sat(first) < settings.guaranteeFundBtc * 1e8 + 10000, 'хвост не выходит за четыре знака');

  // Один и тот же момент времени — одна и та же цифра: число не разыгрывается заново.
  await a.showTab('reviews');
  await a.showTab('exchange');
  assert.equal(amountOf(), first, 'перерисовка в тот же момент не меняет сумму');

  // Десять минут шагом 4.5 с (так тикают живые числа в приложении): каждое движение —
  // небольшой шаг вверх или вниз от предыдущего значения, а не прыжок к случайной цифре.
  let prev = sat(first);
  let ups = 0;
  let downs = 0;
  let biggest = 0;
  const seen = new Set([prev]);
  for (let i = 1; i <= 133; i += 1) {
    clock.t = now + i * 4500;
    await a.showTab('reviews');
    await a.showTab('exchange');
    const value = amountOf();
    assert.match(value, /^0\.0200\d{4}$/, `начало суммы не трогается: ${value}`);
    const cur = sat(value);
    const delta = cur - prev;
    biggest = Math.max(biggest, Math.abs(delta));
    if (delta > 0) ups += 1;
    else if (delta < 0) downs += 1;
    seen.add(cur);
    prev = cur;
  }
  assert.ok(biggest >= 1 && biggest <= 20, `шаг остаётся небольшим: самый крупный ${biggest} сатоши`);
  assert.ok(seen.size >= 20, `сумма не замирает: ${seen.size} значений за десять минут`);
  assert.ok(ups >= 3 && downs >= 3, `ход идёт и вверх, и вниз: +${ups} / −${downs}`);

  // За сутки хвост уходит и в другие тысячи — живут все четыре знака, но только они:
  // «0.0200» впереди не меняется никогда.
  const heads = new Set();
  const thousands = new Set();
  for (let h = 0; h <= 24; h += 1) {
    clock.t = now + h * 3600 * 1000;
    await a.showTab('reviews');
    await a.showTab('exchange');
    const value = amountOf();
    heads.add(value.slice(0, 6));
    thousands.add(value[6]);
  }
  assert.deepEqual([...heads], ['0.0200'], 'первые два знака после 0.02 стоят на месте');
  assert.ok(thousands.size >= 2, 'за сутки меняется и четвёртый знак с конца');

  // Оформление строки — приглушённый текст без плашки, подложки и акцента: строка
  // не выделяется ни цветом, ни иконкой, ни отдельным блоком.
  const css = fs.readFileSync(path.join(__dirname, '../public/reference.css'), 'utf8');
  const rule = css.match(/\.dep-line\s*\{([^}]*)\}/);
  assert.ok(rule, 'строка депозита описана в reference.css');
  assert.doesNotMatch(rule[1], /--sand|--ok|--warn|--danger|--amber|background|border|shadow/,
    'у строки нет акцентного цвета, подложки и обводки');
  assert.doesNotMatch(css, /\.deposit-card|\.stage-deposit|\.dep-tail|\.dep-live|\.dep-shield/,
    'выделенные блоки и цветной хвост суммы убраны из оформления');
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
    'PRICELEX — private crypto brokerage.',
    'Одна площадка — две стороны сделки: клиент и брокер. Сразу видно, что получает каждый.',
    'Клиенту: живой брокер ведёт обмен от заявки до выплаты — объясняет шаги, проверяет реквизиты, доводит операцию до результата.',
    'Брокеру: работа в рамках своего депозита и на собственный капитал — без начальника и десяти согласований.',
    'Клиенту: сумма к оплате известна заранее, а на каждом шаге остаётся след — заявка, чек, ссылка на транзакцию.',
    'Брокеру: не нужно объяснять человеку, который вчера узнал, что такое USDT, почему возможность есть именно сейчас. Ты увидел возможность — ты должен быть способен действовать.',
    'Здесь деньги — это инструмент. А главное преимущество — скорость, опыт и понимание рынка.',
    'Нам не нужен тот, кто хочет научиться. Нам нужен тот, кто уже умеет: держит несколько источников одновременно, знает рынок, понимает ликвидность и считает риск до того, как нажмёт кнопку.',
    'И не теряется, когда возможность живёт несколько минут.',
    'Если ты такой брокер — PRICELEX тебе подходит. Если вам нужен такой брокер — подходит и вам.',
    'Не потому что мы обещаем лёгкие деньги. А потому что мы создаём среду, где опыт и капитал работают профессионально — по обе стороны сделки.',
    'Мы отвечаем за качество репутацией и гарантийным депозитом — и просим вас держать свои ключи при себе. Как именно это устроено — в блоке «Безопасность» ниже.',
    'PRICELEX. Private crypto brokerage.',
  ]);
  assert.equal(a.document.querySelector('#speech .sp-sign').textContent.trim(), 'since 2025', 'речь подписана годом');
  assert.ok(!/тихие деньги/i.test(a.document.querySelector('#view-info').textContent), 'прежний девиз из продукта убран');
  assert.ok(!/комисси/i.test(a.document.querySelector('#view-info').textContent));
  const contacts = [...a.document.querySelectorAll('#view-info .contact')];
  assert.equal(contacts.length, 2, 'связь — только поддержка и штаб-квартира');
  assert.match(contacts[0].textContent, /Поддержка/);
  assert.match(contacts[1].textContent, /Штаб-квартира/);
});

test('info speech addresses the client on safety: keys, requisites, escrow, real channels', async (t) => {
  const a = await app(t);
  a.document.querySelector('.nav button[data-tab="profile"]').click();
  a.document.querySelector('#view-profile [data-go="info"]').click();
  await tick();
  const info = a.document.querySelector('#view-info');
  const cards = [...info.querySelectorAll('.card')];
  const card = cards[1];
  assert.ok(card, 'блок безопасности следует сразу за речью');
  assert.match(card.querySelector('.card-title').textContent, /Безопасность/);
  const text = card.textContent.replace(/\s+/g, ' ');
  assert.match(text, /Реквизиты сообщает только брокер внутри вашей заявки/);
  assert.match(text, /не спрашивает seed-фразу, приватный ключ, пароль от кошелька и код из SMS/);
  assert.match(text, /первые и последние шесть символов/);
  assert.match(text, /заморожены на гарантийном счёте/);
  assert.match(text, /гарантийный депозит брокеров — 0\.02\d+ BTC/, 'размер депозита подставляется живой');
  assert.match(text, /Официального канала и общего чата у нас нет/, 'канал и чат разоблачены как подделка');
  assert.match(text, /инвестиционных рекомендаций здесь нет/);
  assert.match(text, /не является банком, платёжной системой/, 'дисклеймер в тон правилам');
  const links = [...card.querySelectorAll('a.inline-link')].map((x) => x.href);
  assert.deepEqual(links, [], 'ссылок на канал и чат в блоке безопасности больше нет');
});

test('штаб-квартира: адрес в контактах и в правилах, ссылка ведёт на карту', async (t) => {
  const a = await app(t);
  a.document.querySelector('.nav button[data-tab="profile"]').click();
  a.document.querySelector('#view-profile [data-go="info"]').click();
  await tick();
  const info = a.document.querySelector('#view-info');
  const hq = [...info.querySelectorAll('a.contact')].find((x) => /Штаб-квартира/.test(x.textContent));
  assert.ok(hq, 'строка со штаб-квартирой есть среди контактов');
  assert.match(hq.textContent, /Street 11B 243\/3 — Umm Al Sheif — Dubai — ОАЭ/);
  assert.match(hq.href, /^https:\/\/www\.google\.com\/maps\/search\//, 'адрес открывается на карте');
  assert.match(hq.href, /Umm%20Al%20Sheif/, 'запрос на карту нормализован, а не взят из строки как есть');
  assert.equal(hq.getAttribute('rel'), 'noopener');
  assert.match(info.textContent, /Деятельность Платформа ведёт из штаб-квартиры: Street 11B 243\/3/, 'тот же адрес — в общих положениях');
  assert.match(info.textContent, /вне его Платформа с Пользователем не общается и ничего не запрашивает/);
  assert.equal(info.querySelectorAll('a.contact').length, 2, 'поддержка и адрес — канал и чат убраны');
});

test('официальный канал, общий чат и кнопка «Написать в поддержку из приложения» убраны', async (t) => {
  const a = await app(t);
  a.document.querySelector('.nav button[data-tab="profile"]').click();
  a.document.querySelector('#view-profile [data-go="info"]').click();
  await tick();
  const info = a.document.querySelector('#view-info');
  const contacts = [...info.querySelectorAll('.contact')];
  assert.ok(!contacts.some((c) => /Официальный канал|Чат PRICELEX/i.test(c.textContent)), 'канала и чата в контактах нет');
  assert.ok(!info.querySelector('#goSupport'), 'кнопка «Написать в поддержку из приложения» убрана');
  assert.ok(!/Написать в поддержку из приложения/.test(info.textContent));
  assert.match(info.textContent, /Канала и общего чата у PRICELEX нет/, 'раздел «Связь с нами» предупреждает о двойниках');
});

test('плавающая кнопка чата появляется после паузы 20 секунд и открывает чат', async (t) => {
  const a = await app(t);
  const fab = a.document.querySelector('#supportFab');
  assert.ok(fab, 'плашка смонтирована сразу после запуска');
  assert.ok(!fab.classList.contains('show'), 'сразу не показана — не мешает осмотреться');
  assert.ok(a.timers.some((x) => x.ms === 20000), 'появление отложено на 20 секунд');
  assert.equal(a.fire(20000), 1, 'ровно один таймер на показ плашки');
  await tick();
  assert.ok(fab.classList.contains('show'), 'через 20 секунд плашка выехала сбоку');
  fab.click();
  await tick(); await tick();
  assert.ok(!a.document.querySelector('#view-support').classList.contains('hidden'), 'клик открывает чат поддержки');
  assert.ok(!fab.classList.contains('show'), 'внутри чата плашка уезжает — дублировать себя нечем');
  a.document.querySelector('#headerBack').click();
  await tick(); await tick();
  assert.ok(fab.classList.contains('show'), 'после возврата из чата плашка снова на месте');
});

test('кнопка «Найти реквизиты» — литая бронзовая CTA с бликом', async (t) => {
  const a = await app(t);
  const btn = a.document.querySelector('#btnGo');
  assert.ok(btn, 'кнопка формы обмена на месте');
  assert.ok(btn.classList.contains('btn-cta'), 'главное действие оформлено отдельной CTA');
  const glass = fs.readFileSync(path.join(__dirname, '../public/glass.css'), 'utf8');
  const cta = glass.match(/\.btn\.btn-cta \{[^}]*\}/);
  assert.ok(cta, 'CTA описана в glass.css');
  assert.match(cta[0], /var\(--bronze-plate\) center \/ 100% 100% no-repeat/, 'брашированная бронзовая плита');
  assert.match(cta[0], /linear-gradient\(135deg, var\(--bronze-1\) 0%, var\(--bronze-2\) 55%, var\(--bronze-3\) 100%\)/,
    'бронзовый градиент под плитой — на случай, пока картинка не загрузилась');
  assert.match(cta[0], /color: var\(--bronze-ink\)/, 'тёмные чернила на бронзе');
  assert.match(glass, /--bronze-plate: url\('\/img\/bronze-plate\.jpg'\);/);
  assert.ok(fs.statSync(path.join(__dirname, '../public/img/bronze-plate.jpg')).size < 80 * 1024, 'плита лёгкая');
  assert.match(glass, /btn-cta-gloss/, 'по кнопке периодически идёт блик');
  assert.match(glass, /\.btn\.btn-cta:disabled \{[^}]*opacity/, 'выключенное состояние приглушено');
});

test('правила платформы не сворачиваются сами: раскрытие переживает перерисовку', async (t) => {
  const a = await app(t);
  const openInfo = async () => {
    // На саб-страницах нижняя навигация скрыта — идём из неё только если её видно.
    const profile = a.document.querySelector('#view-profile');
    if (profile.classList.contains('hidden')) {
      a.document.querySelector('.nav button[data-tab="profile"]').click();
      await tick();
    }
    a.document.querySelector('#view-profile [data-go="info"]').click();
    await tick();
  };
  await openInfo();
  const rules = a.document.querySelector('#view-info .rules');
  rules.open = true;
  rules.dispatchEvent(new a.window.Event('toggle'));
  await tick();
  a.document.querySelector('#headerBack').click();
  await tick();
  await openInfo();
  const rules2 = a.document.querySelector('#view-info .rules');
  assert.ok(rules2.open, 'раскрытые правила пережили перерисовку');
  // Юридическая часть проговорена для всех участников процесса.
  const legal = a.document.querySelector('#view-info').textContent.replace(/\s+/g, ' ');
  assert.match(legal, /1\. Термины и участники/);
  assert.match(legal, /3\. Права и обязанности сторон/);
  assert.match(legal, /Пользователь:/);
  assert.match(legal, /Брокер:/);
  assert.match(legal, /Платформа:/);
  assert.match(legal, /9\. Заключительные положения/);
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

test('капча: поле ответа стоит вплотную к примеру, а не у края строки', async (t) => {
  const a = await app(t);
  const box = a.document.querySelector('#capOrder');
  assert.ok(box, 'блок капчи отрисован на форме обмена');
  const label = box.querySelector('.cap-label');
  const input = box.querySelector('input');
  assert.ok(label && input, 'в блоке есть подпись и поле ответа');
  assert.match(label.textContent, /3 \+ 4 = \?/, 'в подписи — сам пример');
  assert.ok(label.querySelector('.cap-expr'), 'пример выделен в подписи отдельно');
  // Порядок в разметке: пример, сразу за ним поле — между ними только gap.
  assert.equal(label.nextElementSibling, input, 'поле идёт сразу за примером');
  assert.ok(label.textContent.trimEnd().endsWith('?'), 'за примером в подписи больше ничего нет');
});

test('капча: подпись не растягивается на всю строку и не уносит поле вправо', () => {
  const iosCss = fs.readFileSync(path.join(__dirname, '../public/ios.css'), 'utf8');
  const styleCss = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  for (const [name, css] of [['ios.css', iosCss], ['style.css', styleCss]]) {
    const cap = css.match(/\.cap-label \{[^}]*\}/)[0];
    assert.doesNotMatch(cap, /flex: 1 1 auto/, `${name}: подпись не занимает всю строку`);
    assert.match(cap, /flex: 0 1 auto/, `${name}: подпись сжимается по тексту`);
  }
  assert.match(iosCss, /\.captcha \{[^}]*gap: 8px;/, 'между примером и полем — маленький отступ');
  assert.match(iosCss, /\.captcha input \{[^}]*flex: 0 0 auto;/, 'поле ответа не растягивается');
});

test('знак обмена в шапке: вместо монет — анимация в палитре приложения', async (t) => {
  const a = await app(t);
  const head = a.document.querySelector('.exchange-heading-left');
  assert.ok(head, 'шапка экрана обмена отрисована');
  assert.equal(head.querySelector('img'), null, 'три монеты из шапки убраны');
  const svg = head.querySelector('.exchange-badge svg.ex-swap');
  assert.ok(svg, 'на их месте — знак обмена');
  // Сама геометрия: две стрелки, разворот и блик.
  assert.equal(svg.querySelectorAll('.ex-arw path').length, 4, 'две стрелки описаны путями');
  assert.ok(svg.querySelector('.ex-swap-ring'), 'есть вращающаяся группа');
  assert.ok(svg.querySelector('.ex-sheen-band'), 'есть полоса блика');
  assert.ok(svg.querySelector('.ex-arw-hi[mask="url(#exSheenMask)"]'), 'блик идёт по самим стрелкам');
});

test('знак обмена красивется токенами и замирает при prefers-reduced-motion', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const iosCss = fs.readFileSync(path.join(__dirname, '../public/ios.css'), 'utf8');
  const devicesCss = fs.readFileSync(path.join(__dirname, '../public/devices.css'), 'utf8');
  // Цветов в разметке нет: стопы градиента и маски раскрашены классами.
  assert.doesNotMatch(appJs, /stop-color="#/, 'в разметке знака нет зашитых цветов');
  assert.match(iosCss, /\.ex-stop-1 \{ stop-color: var\(--sand-1\); \}/, 'градиент — шампанский');
  assert.match(iosCss, /\.ex-stop-2 \{ stop-color: var\(--tint-fill\); \}/);
  assert.match(iosCss, /\.ex-arw-hi \{ stroke: rgba\(var\(--tint-hi-rgb\), \.95\); \}/, 'блик — тёплый белый');
  // Движение: пол-оборота с паузой и блик в такт.
  assert.match(iosCss, /\.ex-swap-ring \{[^}]*animation: ex-swap [\d.]+s/);
  assert.match(iosCss, /@keyframes ex-swap \{/);
  assert.match(iosCss, /@keyframes ex-sheen \{/);
  assert.match(devicesCss, /html\[data-device\] \.exchange-badge \{ width: calc\(var\(--ui-title\) \+ 2px\)/, 'знак растёт вместе с заголовком');
});
