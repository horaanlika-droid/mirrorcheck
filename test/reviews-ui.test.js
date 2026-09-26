// Вкладка «Отзывы» при сотнях отзывов: лента страницами («Показать ещё»),
// сводка и распределение — по всей витрине, опрос не теряет догруженное,
// свой отзыв пересчитывает сводку. Сервер — заглушка с курсором как в API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const html = pub('index.html');
const appJs = pub('app.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const now = Date.UTC(2026, 8, 26, 9);
const settings = {
  online: true, rateBTC: 10_000_000, rateGRAM: 125, rateUpdatedAt: now, minRub: 3000, maxRub: 300000,
  announcement: '', refPercent: 1, operator: '', channel: '', chat: '', botUsername: 'test_bot',
  adminBrokers: [{ login: 'a', name: 'a', online: true, rating: 4.9, completed: 10 }],
};

// 65 отзывов: 50×5★, 8×4★, 3×3★, 2×2★, 2×1★ — средняя 4.6. Три отзыва в одну секунду.
function makeServer() {
  const ratings = [...Array(50).fill(5), ...Array(8).fill(4), ...Array(3).fill(3), ...Array(2).fill(2), ...Array(2).fill(1)];
  const list = ratings.map((rating, i) => ({
    id: i + 1, name: `Клиент ${i + 1}`, rating, text: `Отзыв номер ${i + 1}`,
    createdAt: i >= 30 && i <= 32 ? now - 30 * 3600e3 : now - (i + 1) * 3600e3, reply: null,
  }));
  const sorted = () => [...list].sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id));
  const calls = [];
  const handle = (url) => {
    const u = new URL(url, 'https://pricelex.example');
    const limit = Math.min(50, Number(u.searchParams.get('limit')) || 20);
    const before = u.searchParams.get('before');
    calls.push(before);
    const all = sorted();
    let start = 0;
    if (before) {
      const [at, id] = before.split(':').map(Number);
      start = all.findIndex((r) => r.createdAt < at || (r.createdAt === at && r.id < id));
      if (start < 0) start = all.length;
    }
    const page = all.slice(start, start + limit);
    const hasMore = start + page.length < all.length;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of all) dist[r.rating] += 1;
    const avg = Math.round((all.reduce((s, r) => s + r.rating, 0) / all.length) * 10) / 10;
    const last = page[page.length - 1];
    return { reviews: page, stats: { count: all.length, avg, dist }, hasMore, next: hasMore ? `${last.createdAt}:${last.id}` : null };
  };
  return { list, sorted, calls, handle };
}

async function app(t, srv, { orders = [] } = {}) {
  const dom = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.console.warn = () => {};
  window.setInterval = () => 1;
  const posted = [];
  window.fetch = async (url, opts) => {
    const pathname = new URL(url, window.location.href).pathname;
    const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders, me: { id: 999, referredCount: 0 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/rates/history') return json({ hours: 24, updatedAt: now, points: [] });
    if (pathname === '/api/support/messages') return json({ messages: [] });
    if (pathname === '/api/reviews' && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      posted.push(body);
      const review = { id: 900, name: 'Клиент', rating: body.rating, text: body.text, createdAt: now + 1000, reply: null };
      srv.list.push(review);
      return json({ review: { ...review, orderId: body.orderId }, order: { ...orders[0], review: { id: 900 } } });
    }
    if (pathname === '/api/reviews') return json(srv.handle(url));
    if (pathname === '/api/broker/status') return json({ application: null });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(appJs);
  await tick(); await tick();
  const doc = window.document;
  const openReviews = async () => {
    if (!doc.querySelector('#view-reviews').classList.contains('hidden')) {
      doc.querySelector('.nav button[data-tab="history"]').click(); // уйти и вернуться = свежий запрос
      await tick();
    }
    doc.querySelector('.nav button[data-tab="reviews"]').click();
    await tick(); await tick(); await tick();
  };
  const ids = () => [...doc.querySelectorAll('#rvList .rv-item .rv-body')].map((p) => Number(p.textContent.match(/\d+/)[0]));
  const more = async () => {
    doc.querySelector('#rvMore').click();
    await tick(); await tick(); await tick();
  };
  return { window, doc, openReviews, ids, more, posted };
}

test('лента отзывов страницами: 20 свежих, «Показать ещё» дописывает следующие без дублей', async (t) => {
  const srv = makeServer();
  const a = await app(t, srv);
  await a.openReviews();
  const view = a.doc.querySelector('#view-reviews');
  assert.equal(view.querySelectorAll('.rv-item').length, 20, 'первая страница — 20 отзывов');
  const btn = a.doc.querySelector('#rvMore');
  assert.ok(btn, 'есть кнопка «Показать ещё»');
  assert.match(btn.textContent, /Показать ещё/);
  assert.equal(btn.querySelector('.rv-more-left').textContent, '45', 'сколько ещё впереди');
  assert.equal(srv.calls[0], null, 'первая страница — без курсора');

  const firstCard = view.querySelector('.rv-item');
  await a.more();
  assert.equal(view.querySelectorAll('.rv-item').length, 40);
  assert.equal(view.querySelector('.rv-item'), firstCard, 'карточки дописаны, экран не перерисован');
  assert.match(srv.calls[srv.calls.length - 1], /^\d+:\d+$/, 'следующая страница — по курсору next');
  assert.equal(a.doc.querySelector('#rvMore .rv-more-left').textContent, '25');
  await a.more();
  await a.more();
  assert.equal(view.querySelectorAll('.rv-item').length, 65, 'все 65 отзывов');
  assert.equal(a.doc.querySelector('#rvMore'), null, 'кнопка ушла — дальше ничего нет');
  assert.deepEqual(a.ids(), srv.sorted().map((r) => r.id), 'порядок как на сервере, отзывы в одну секунду не потерялись');
});

test('сводка и распределение — по всей витрине, а не по загруженной странице', async (t) => {
  const srv = makeServer();
  const a = await app(t, srv);
  await a.openReviews();
  const view = a.doc.querySelector('#view-reviews');
  assert.equal(view.querySelector('.rv-score .metric').textContent, '4.6');
  assert.match(view.querySelector('.rv-score .metric-sub').textContent, /^65 отзывов/);
  const pct = [...view.querySelectorAll('.rv-dist-percent')].map((x) => x.textContent);
  assert.deepEqual(pct, ['77%', '12%', '5%', '3%', '3%'], 'по 65 отзывам, хотя на экране 20 пятёрок');
});

test('опрос обновляет первую страницу и не теряет догруженное', async (t) => {
  const srv = makeServer();
  const a = await app(t, srv);
  await a.openReviews();
  await a.more();
  assert.equal(a.ids().length, 40);
  srv.list.push({ id: 100, name: 'Новый', rating: 2, text: 'Отзыв номер 100', createdAt: now, reply: null });
  await a.openReviews(); // повторный заход на вкладку — тот же запрос первой страницы, что и опрос
  const ids = a.ids();
  assert.equal(ids[0], 100, 'свежий отзыв сверху');
  assert.equal(ids.length, 41, 'догруженные 20 остались');
  assert.equal(new Set(ids).size, 41, 'без дублей на стыке страниц');
  assert.equal(a.doc.querySelector('#rvMore .rv-more-left').textContent, '25');
  await a.more();
  await a.more();
  assert.deepEqual(a.ids(), srv.sorted().map((r) => r.id), 'дальше лента продолжается с того же места');
});

test('свой отзыв сразу в ленте, сводка пересчитана по распределению всей витрины', async (t) => {
  const srv = makeServer();
  const order = {
    id: 5, status: 'completed', review: null, rub: 5000, payRub: 5000, currency: 'BTC', crypto: 0.0005,
    wallet: 'bc1q' + 'x'.repeat(38), rate: 10_000_000, createdAt: now - 86400e3,
  };
  const a = await app(t, srv, { orders: [order] });
  await a.openReviews();
  const view = a.doc.querySelector('#view-reviews');
  view.querySelectorAll('#tabRvStars button')[4].click();
  view.querySelector('#tabRvText').value = 'Всё прошло отлично';
  view.querySelector('#tabRvSend').click();
  await tick(); await tick();
  assert.equal(a.posted.length, 1);
  assert.equal(view.querySelector('.rv-item .rv-body').textContent, 'Всё прошло отлично');
  assert.match(view.querySelector('.rv-score .metric-sub').textContent, /^66 отзывов/, '65 + свой, а не 21 загруженный');
  assert.equal(view.querySelector('.rv-score .metric').textContent, '4.6', '(297 + 5) / 66');
  const pct = [...view.querySelectorAll('.rv-dist-percent')].map((x) => x.textContent);
  assert.deepEqual(pct, ['77%', '12%', '5%', '3%', '3%'], '51/66 пятёрок — всё ещё 77%');
  assert.ok(a.doc.querySelector('#rvMore'), 'дальше лента по-прежнему догружается');
  assert.ok(!/модерац/i.test(a.doc.body.textContent));
});
