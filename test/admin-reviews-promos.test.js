// Админ-панель: создание и редактирование отзывов с произвольной датой/временем,
// а также создание, редактирование и применение промокодов на скидку при обмене.
const { test, after, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-admin-features-'));
process.env.DATA_DIR = dir;
delete process.env.BOT_TOKEN;
delete process.env.ADMIN_ID;
delete process.env.ADMIN_IDS;

const store = require('../src/store');
const currencies = require('../src/currencies');
const { createApp, parseTimestamp } = require('../src/web');

let server = null;
let baseUrl = '';

const ADMIN_DEMO = { id: '900001', name: 'Operator' };
const CLIENT_DEMO = { id: '900002', name: 'Client' };

async function req(method, endpoint, { demo = ADMIN_DEMO, body } = {}) {
  const q = new URLSearchParams({ 'demo[id]': demo.id, 'demo[name]': demo.name });
  const sep = endpoint.includes('?') ? '&' : '?';
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  const res = await fetch(`${baseUrl}${endpoint}${sep}${q}`, {
    method,
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(Object.assign({ demo }, body || {})) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  store.mutate((db) => {
    db.settings.btcUsd = 100_000;
    db.settings.cardFees = { GOOGLE_USD: 10, ITUNES_USD: 15, XBOX_USD: 20, APPLE_STORE_USD: 5 };
    db.settings.cardRates = currencies.allCardRates(db.settings);
    db.settings.online = true;
    db.reviews = [];
    db.reviewSeq = 1;
    db.promos = [];
    db.promoSeq = 1;
    db.orders = [];
    db.seq = 1;
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- parseTimestamp ---------- */

test('parseTimestamp: поддерживает epoch ms, ISO и DD.MM.YYYY HH:mm, отклоняет мусор', () => {
  assert.deepEqual(parseTimestamp(''), { provided: false, value: null });
  assert.deepEqual(parseTimestamp(null), { provided: false, value: null });

  const ts = Date.UTC(2026, 4, 20, 14, 35, 0);
  assert.deepEqual(parseTimestamp(ts), { provided: true, value: ts });
  assert.deepEqual(parseTimestamp('2026-05-20T14:35:00Z'), { provided: true, value: ts });

  const ru = parseTimestamp('20.05.2026 14:35');
  assert.equal(ru.provided, true);
  assert.equal(ru.error, undefined);
  const d = new Date(ru.value);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 4);
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 35);

  assert.ok(parseTimestamp('not-a-date').error);
  assert.ok(parseTimestamp('31.02.2026 10:00').error);
  assert.ok(parseTimestamp(Date.UTC(1990, 0, 1)).error);
});

/* ---------- Админ: отзывы с датой и временем + редактирование ---------- */

test('админ может создавать отзывы с конкретной датой и временем и они сортируются хронологически', async () => {
  const olderTs = Date.UTC(2026, 2, 10, 9, 15, 0);
  const newerTs = Date.UTC(2026, 5, 18, 18, 45, 0);

  const r1 = await req('POST', '/api/admin/reviews', {
    body: { name: 'Иван', rating: 5, text: 'Отличный сервис', at: olderTs },
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.review.at, olderTs);
  assert.equal(r1.data.review.name, 'Иван');

  const r2 = await req('POST', '/api/admin/reviews', {
    body: { name: 'Мария', rating: 4, text: 'Быстрая выплата', at: '2026-06-18T18:45:00Z' },
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.review.at, newerTs);

  // На витрине и в админке первым идёт более новый отзыв (Мария), вторым — Иван.
  const pub = await req('GET', '/api/reviews', { demo: CLIENT_DEMO });
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.data.reviews.map((x) => [x.name, x.at]), [
    ['Мария', newerTs],
    ['Иван', olderTs],
  ]);

  const adm = await req('GET', '/api/admin/reviews');
  assert.equal(adm.status, 200);
  assert.deepEqual(adm.data.reviews.map((x) => [x.name, x.at]), [
    ['Мария', newerTs],
    ['Иван', olderTs],
  ]);
});

test('админ может редактировать имя, оценку, текст и дату/время существующего отзыва', async () => {
  const initialTs = Date.UTC(2026, 3, 1, 12, 0, 0);
  const updatedTs = Date.UTC(2026, 7, 25, 21, 10, 0);

  const created = await req('POST', '/api/admin/reviews', {
    body: { name: 'Алексей', rating: 4, text: 'Нормально', at: initialTs },
  });
  const id = created.data.review.id;

  // Создаём второй отзыв между датами, чтобы проверить пересортировку после редактирования.
  await req('POST', '/api/admin/reviews', {
    body: { name: 'Ольга', rating: 5, text: 'Всё супер', at: Date.UTC(2026, 5, 1, 10, 0, 0) },
  });

  const upd = await req('PUT', `/api/admin/reviews/${id}`, {
    body: { name: 'Алексей К.', rating: 5, text: 'Отличный обмен, пришло быстро!', at: updatedTs },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.review.name, 'Алексей К.');
  assert.equal(upd.data.review.rating, 5);
  assert.equal(upd.data.review.text, 'Отличный обмен, пришло быстро!');
  assert.equal(upd.data.review.at, updatedTs);

  const list = await req('GET', '/api/reviews', { demo: CLIENT_DEMO });
  assert.equal(list.data.reviews[0].id, id, 'после переноса даты вперёд отзыв стал первым');
  assert.equal(list.data.summary.avg, 5);

  // Редактирование отзыва от клиентской заявки (может иметь пустой текст).
  const orderReview = store.createReview({
    userId: '900002',
    orderId: 77,
    name: 'Клиент',
    rating: 5,
    text: '',
    source: 'order',
    at: initialTs,
  });
  const updOrderRev = await req('PATCH', `/api/admin/reviews/${orderReview.id}`, {
    body: { text: '', at: Date.UTC(2026, 8, 1, 8, 30, 0) },
  });
  assert.equal(updOrderRev.status, 200);
  assert.equal(updOrderRev.data.review.at, Date.UTC(2026, 8, 1, 8, 30, 0));
  assert.equal(updOrderRev.data.review.orderId, 77);
});

test('валидация и права доступа на редактирование/создание отзывов', async () => {
  const forbid = await req('POST', '/api/admin/reviews', {
    demo: CLIENT_DEMO,
    body: { name: 'Хакер', rating: 5, text: 'Текст' },
  });
  assert.equal(forbid.status, 403);

  const badDate = await req('POST', '/api/admin/reviews', {
    body: { name: 'Иван', rating: 5, text: 'Текст', at: 'не-дата' },
  });
  assert.equal(badDate.status, 400);

  const missing = await req('PUT', '/api/admin/reviews/999', {
    body: { name: 'Нет', rating: 5, text: 'Текст' },
  });
  assert.equal(missing.status, 404);

  const created = await req('POST', '/api/admin/reviews', {
    body: { name: 'Иван', rating: 5, text: 'Хорошо' },
  });
  const forbidEdit = await req('PUT', `/api/admin/reviews/${created.data.review.id}`, {
    demo: CLIENT_DEMO,
    body: { text: 'Изменено' },
  });
  assert.equal(forbidEdit.status, 403);
});

/* ---------- Админ и клиент: промокоды на скидку на обмен ---------- */

test('админ создаёт, редактирует, ставит на паузу и удаляет промокоды', async () => {
  const expTs = Date.now() + 24 * 3600 * 1000;
  const created = await req('POST', '/api/admin/promos', {
    body: { code: 'vip5', percent: 5, maxUses: 10, minUnits: 20, expiresAt: expTs },
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.promo.code, 'VIP5', 'код нормализуется в верхний регистр');
  assert.equal(created.data.promo.percent, 5);
  assert.equal(created.data.promo.maxUses, 10);
  assert.equal(created.data.promo.minUnits, 20);
  assert.equal(created.data.promo.expiresAt, expTs);
  assert.equal(created.data.promo.active, true);

  // Дубликат в другом регистре отклонён
  const dup = await req('POST', '/api/admin/promos', {
    body: { code: 'VIP5', percent: 10 },
  });
  assert.equal(dup.status, 409);

  // Неадмин не может управлять промокодами
  const forbid = await req('GET', '/api/admin/promos', { demo: CLIENT_DEMO });
  assert.equal(forbid.status, 403);

  // Пауза через PATCH
  const id = created.data.promo.id;
  const paused = await req('PATCH', `/api/admin/promos/${id}`, { body: { active: false } });
  assert.equal(paused.status, 200);
  assert.equal(paused.data.promo.active, false);

  // Клиент получает ошибку для приостановленного промокода
  const chkPaused = await req('POST', '/api/promo/check', {
    demo: CLIENT_DEMO,
    body: { code: 'vip5', currency: 'GOOGLE_USD', units: 50 },
  });
  assert.equal(chkPaused.status, 400);
  assert.match(chkPaused.data.error, /отключ/i);

  // Включаем обратно и меняем процент через PUT
  const resumed = await req('PUT', `/api/admin/promos/${id}`, {
    body: { code: 'VIP10', percent: 10, active: true, maxUses: null, minUnits: 50 },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.promo.code, 'VIP10');
  assert.equal(resumed.data.promo.percent, 10);
  assert.equal(resumed.data.promo.maxUses, null);
  assert.equal(resumed.data.promo.minUnits, 50);

  // Удаление
  const del = await req('DELETE', `/api/admin/promos/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.ok, true);
  const list = await req('GET', '/api/admin/promos');
  assert.equal(list.data.promos.length, 0);
});

test('проверка промокода и создание заявки с промокодом: выплата выше на указанный %, лимит и возврат при отмене', async () => {
  // Спот 100 000 $/BTC, Google fee 10% -> базовый курс 0.000009 BTC/$.
  // За карту $100 базовая выплата = 0.0009 BTC.
  // С промокодом +10% курс = 0.0000099 BTC/$, выплата = 0.00099 BTC.
  const created = await req('POST', '/api/admin/promos', {
    body: { code: 'BONUS10', percent: 10, maxUses: 1, minUnits: 50 },
  });
  assert.equal(created.status, 200);

  // Номинал меньше minUnits — ошибка
  const tooLow = await req('POST', '/api/promo/check', {
    demo: CLIENT_DEMO,
    body: { code: 'BONUS10', currency: 'GOOGLE_USD', units: 20 },
  });
  assert.equal(tooLow.status, 400);
  assert.match(tooLow.data.error, /\$50/);

  // Подходящий номинал — успешная проверка, внутренний счётчик не утекает
  const okCheck = await req('POST', '/api/promo/check', {
    demo: CLIENT_DEMO,
    body: { code: 'bonus10', currency: 'GOOGLE_USD', units: 100 },
  });
  assert.equal(okCheck.status, 200);
  assert.equal(okCheck.data.promo.code, 'BONUS10');
  assert.equal(okCheck.data.promo.percent, 10);
  assert.equal('usedCount' in okCheck.data.promo, false);
  assert.equal(okCheck.data.payout.baseCrypto, 0.0009);
  assert.equal(okCheck.data.payout.crypto, 0.00099);
  assert.equal(okCheck.data.payout.bonusCrypto, 0.00009);

  // Создаём заявку с промокодом
  const wallet = 'bc1' + 'q'.repeat(30);
  const ordRes = await req('POST', '/api/orders', {
    demo: CLIENT_DEMO,
    body: { currency: 'GOOGLE_USD', units: 100, wallet, promoCode: 'bonus10' },
  });
  assert.equal(ordRes.status, 200);
  const order = ordRes.data.order;
  assert.equal(order.promoCode, 'BONUS10');
  assert.equal(order.promoPercent, 10);
  assert.equal(order.baseCrypto, 0.0009);
  assert.equal(order.crypto, 0.00099);

  // Лимит 1 исчерпан — вторая заявка с тем же промокодом отклонена
  const second = await req('POST', '/api/orders', {
    demo: CLIENT_DEMO,
    body: { currency: 'GOOGLE_USD', units: 100, wallet, promoCode: 'BONUS10' },
  });
  assert.equal(second.status, 400);
  assert.match(second.data.error, /Лимит/i);

  // Отмена первой заявки возвращает использование промокода
  const cancelled = await req('POST', `/api/order/${order.id}/cancel`, { demo: CLIENT_DEMO });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.order.status, 'cancelled');

  // Повторная проверка снова проходит!
  const afterCancel = await req('POST', '/api/promo/check', {
    demo: CLIENT_DEMO,
    body: { code: 'BONUS10', currency: 'GOOGLE_USD', units: 100 },
  });
  assert.equal(afterCancel.status, 200);
});

test('истёкший промокод не применяется и не проходит проверку', async () => {
  const pastTs = Date.now() - 60_000;
  const created = await req('POST', '/api/admin/promos', {
    body: { code: 'OLD5', percent: 5, expiresAt: pastTs },
  });
  assert.equal(created.status, 200);

  const check = await req('POST', '/api/promo/check', {
    demo: CLIENT_DEMO,
    body: { code: 'OLD5', currency: 'GOOGLE_USD', units: 100 },
  });
  assert.equal(check.status, 400);
  assert.match(check.data.error, /истёк/i);
});

test('HTML админ-панели содержит вкладку промокодов и поля даты/времени и редактирования отзывов', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Вкладка промокодов и её элементы
  assert.ok(doc.querySelector('#admTabs .adm-tab[data-tab="promos"]'));
  assert.ok(doc.querySelector('.adm-pane[data-pane="promos"]'));
  for (const id of ['admPromoCode', 'admPromoPercent', 'admPromoMaxUses', 'admPromoMinUnits', 'admPromoExpires', 'admPromoGen', 'admPromoSave', 'admPromoCancel', 'admPromoList']) {
    assert.ok(doc.getElementById(id), `элемент #${id} присутствует`);
  }

  // Поля даты/времени и редактирования во вкладке отзывов
  assert.equal(doc.getElementById('admRevAt')?.getAttribute('type'), 'datetime-local');
  for (const id of ['admRevNow', 'admRevEditBanner', 'admRevCancel', 'admRevEditReset', 'admRevName', 'admRevText', 'admRevAdd', 'admRevList']) {
    assert.ok(doc.getElementById(id), `элемент #${id} присутствует`);
  }
});
