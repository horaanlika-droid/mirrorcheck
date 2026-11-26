// Отзывы: клиент оставляет отзыв только после завершённой сделки (и только один),
// оператор добавляет и удаляет отзывы из админки; витрина отдаёт среднюю оценку.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-reviews-'));
process.env.DATA_DIR = dir;
process.env.BOT_TOKEN = '';
process.env.ADMIN_ID = '';
process.env.ADMIN_IDS = '';
const port = 20000 + Math.floor(Math.random() * 20000);
process.env.SERVER_PORT = String(port);

const store = require('../src/store');
const { startWeb } = require('../src/web');

const ADMIN_ID = '900001';
const base = `http://127.0.0.1:${port}`;
const auth = (extra = '') => `demo[id]=${ADMIN_ID}&demo[name]=Tester${extra ? '&' + extra : ''}`;
const get = async (p) => {
  const res = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}${auth()}`);
  return { status: res.status, body: await res.json() };
};
const post = async (p, body = {}) => {
  const res = await fetch(`${base}${p}?${auth()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

let server = null;
const ready = (async () => {
  server = startWeb();
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
})();

after(async () => {
  await ready.catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

const completedOrder = (status = 'completed') =>
  store.createOrder({
    userId: ADMIN_ID,
    userName: 'Тестовый клиент',
    units: 50,
    currency: 'GOOGLE_USD',
    wallet: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    rate: 0.0000005,
    crypto: 0.000025,
  }) && store.updateOrder(store.get().orders.at(-1).id, { status });

test('витрина отзывов изначально пуста', async () => {
  await ready;
  const { status, body } = await get('/api/reviews');
  assert.equal(status, 200);
  assert.deepEqual(body.reviews, []);
  assert.equal(body.stats.count, 0);
});

test('отзыв принимается только по завершённой заявке', async () => {
  await ready;
  const active = completedOrder('paid');
  const { status, body } = await post(`/api/order/${active.id}/review`, { rating: 5, text: 'Отлично' });
  assert.equal(status, 400);
  assert.match(body.error, /завершённой/);
});

test('клиент оставляет отзыв один раз, витрина считает среднюю', async () => {
  await ready;
  const order = completedOrder('completed');
  const first = await post(`/api/order/${order.id}/review`, { rating: 5, text: 'Обменял карту $50 — BTC пришли быстро.' });
  assert.equal(first.status, 200);
  assert.equal(first.body.order.review.rating, 5);
  assert.equal(first.body.stats.count, 1);
  assert.equal(first.body.stats.avg, 5);

  const second = await post(`/api/order/${order.id}/review`, { rating: 1, text: 'Ещё раз' });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /уже оставлен/);

  const list = await get('/api/reviews');
  assert.equal(list.body.reviews.length, 1);
  assert.equal(list.body.reviews[0].name, 'Тестовый клиент');
  assert.equal(list.body.reviews[0].text, 'Обменял карту $50 — BTC пришли быстро.');
  assert.equal(list.body.reviews[0].userId, undefined, 'внутренние поля не отдаются на витрину');
});

test('оценка вне диапазона 1–5 отклоняется', async () => {
  await ready;
  const order = completedOrder('completed');
  const { status } = await post(`/api/order/${order.id}/review`, { rating: 7, text: 'Что-то' });
  assert.equal(status, 400);
});

test('админка добавляет и удаляет отзывы', async () => {
  await ready;
  const before = (await get('/api/admin/reviews')).body;
  const added = await post('/api/admin/reviews', { name: 'Алексей', rating: 4, text: 'Всё ок, оператор на связи.' });
  assert.equal(added.status, 200);
  assert.equal(added.body.stats.count, before.stats.count + 1);
  const manual = added.body.reviews.find((r) => r.name === 'Алексей');
  assert.equal(manual.source, 'admin');

  const removed = await post(`/api/admin/reviews/${manual.id}/delete`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.reviews.some((r) => r.id === manual.id), false);
  assert.equal(removed.body.stats.count, before.stats.count);
});

test('админка отвечает на отзывы', async () => {
  await ready;
  const added = await post('/api/admin/reviews', { name: 'Мария', rating: 5, text: 'Быстрая выплата в BTC.' });
  const review = added.body.reviews.find((r) => r.name === 'Мария');
  const replied = await post(`/api/admin/reviews/${review.id}/reply`, { reply: 'Спасибо за отзыв!' });
  assert.equal(replied.status, 200);
  assert.equal(replied.body.review.reply, 'Спасибо за отзыв!');
  const list = await get('/api/reviews');
  assert.equal(list.body.reviews.find((r) => r.id === review.id).reply, 'Спасибо за отзыв!');
});
