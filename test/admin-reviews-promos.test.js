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
process.env.ALLOW_DEMO_AUTH = '1'; // демо-личность для тестов вместо cookie-сессии
delete process.env.BOT_TOKEN;
process.env.ADMIN_ID = '900001';
process.env.ADMIN_IDS = '';

const store = require('../src/store');
const currencies = require('../src/currencies');
const { createApp, parseTimestamp } = require('../src/web');

let server = null;
let baseUrl = '';

// Демо-гость 900001 больше не оператор: админка — только для реальных администраторов.
const OPERATOR_ADMIN = { id: '900001', name: 'Operator' };
const CLIENT_DEMO = { id: '900002', name: 'Client' };

async function req(method, endpoint, { demo = OPERATOR_ADMIN, body } = {}) {
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
    db.settings.usdtUsd = 1;
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
  // При паритете USDT/USD: $100 со скидкой карты 10% = 90 USDT, с бонусом +10% = 99 USDT.
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
  assert.equal(okCheck.data.payout.baseCrypto, 90);
  assert.equal(okCheck.data.payout.crypto, 99);
  assert.equal(okCheck.data.payout.bonusCrypto, 9);

  // Создаём заявку с промокодом
  const wallet = '0x' + 'aB12'.repeat(10);
  const ordRes = await req('POST', '/api/orders', {
    demo: CLIENT_DEMO,
    body: { currency: 'GOOGLE_USD', units: 100, wallet, promoCode: 'bonus10' },
  });
  assert.equal(ordRes.status, 200);
  const order = ordRes.data.order;
  assert.equal(order.payoutCurrency, 'USDT');
  assert.equal(order.network, 'BEP20');
  assert.equal(order.promoCode, 'BONUS10');
  assert.equal(order.promoPercent, 10);
  assert.equal(order.baseCrypto, 90);
  assert.equal(order.crypto, 99);

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

test('каждый пятый завершённый обмен конкретного клиента уменьшает комиссию на 1 п.п.', async () => {
  const wallet = '0x' + 'aB12'.repeat(10);
  store.mutate((db) => {
    for (let id = 1; id <= 4; id++) {
      db.orders.push({ id: 1000 + id, userId: CLIENT_DEMO.id, status: 'completed' });
    }
  });

  const profile = await req('GET', '/api/me', { demo: CLIENT_DEMO });
  assert.equal(profile.data.loyalty.completedExchanges, 4);
  assert.equal(profile.data.loyalty.eligible, true);
  assert.equal(profile.data.loyalty.rates.GOOGLE_USD, 0.91);
  assert.equal(profile.data.loyalty.feeDiscounts.GOOGLE_USD, 1);

  const cancelledAttempt = await req('POST', '/api/orders', {
    demo: CLIENT_DEMO,
    body: { currency: 'GOOGLE_USD', units: 100, wallet },
  });
  await req('POST', `/api/order/${cancelledAttempt.data.order.id}/cancel`, { demo: CLIENT_DEMO });

  const fifth = await req('POST', '/api/orders', {
    demo: CLIENT_DEMO,
    body: { currency: 'GOOGLE_USD', units: 100, wallet },
  });
  assert.equal(fifth.status, 200);
  assert.equal(fifth.data.order.crypto, 91);
  assert.equal(fifth.data.order.loyaltyDiscountPercent, 1);
  assert.equal(fifth.data.order.loyaltyExchangeNumber, 5);

  await req('POST', `/api/admin/order/${fifth.data.order.id}/confirm`);
  const after = await req('GET', '/api/me', { demo: CLIENT_DEMO });
  assert.equal(after.data.loyalty.completedExchanges, 5);
  assert.equal(after.data.loyalty.eligible, false);

  const sixth = await req('POST', '/api/orders', {
    demo: CLIENT_DEMO,
    body: { currency: 'GOOGLE_USD', units: 100, wallet },
  });
  assert.equal(sixth.data.order.crypto, 90);
  assert.equal(sixth.data.order.loyaltyDiscountPercent, 0);

  const anotherClient = await req('POST', '/api/orders', {
    demo: { id: '900003', name: 'Another client' },
    body: { currency: 'GOOGLE_USD', units: 100, wallet },
  });
  assert.equal(anotherClient.data.order.crypto, 90, 'счётчик ведётся отдельно для каждого клиента');
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

test('руководство пользователя показывается перед сделкой: прокрутка до конца и отметка ознакомления', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Шапка sheet — заголовок сменился на «Руководство пользователя».
  assert.equal(doc.getElementById('giftRulesTitle')?.textContent, 'Руководство пользователя');
  const homepageGuideLink = doc.getElementById('userGuideLink');
  assert.equal(homepageGuideLink?.tagName, 'A', 'руководство доступно с главной страницы по гиперссылке');
  assert.equal(homepageGuideLink?.getAttribute('href'), '#giftRules');
  // Тело руководства со всеми разделами и обязательный согласительный чекбокс.
  assert.ok(doc.getElementById('guideBody'), 'контейнер руководства #guideBody присутствует');
  assert.ok(doc.querySelector('#guideBody .guide-section:last-child .guide-tagline'), 'руководство заканчивается финальным блоком');
  assert.ok(doc.getElementById('guideConsent'), 'чекбокс ознакомления #guideConsent присутствует');
  assert.ok(doc.getElementById('guideHint'), 'подсказка-гейт #guideHint присутствует');
  // Кнопка подтверждения по умолчанию заблокирована — пока гайд не прокручен и не отмечен.
  const confirm = doc.getElementById('giftRulesConfirm');
  assert.ok(confirm.hasAttribute('disabled'), 'кнопка создания заявки заблокирована до прокрутки и отметки');
  // Прежние блочные правила «Как передать карту» заменены руководством.
  assert.equal(doc.querySelector('#giftRules .rules-body'), null);
  assert.equal(doc.getElementById('giftRulesBrand'), null);
  // Разделы о курсе и выплатах в USDT добавлены в руководство.
  const headings = [...doc.querySelectorAll('#guideBody .guide-section .guide-h')].map((h) => h.textContent);
  assert.ok(headings.some((h) => h.includes('Почему курс PRICELEX может быть выше рыночного')), 'раздел о курсе присутствует');
  assert.ok(headings.some((h) => h.includes('Важная информация о выплатах в USDT')), 'раздел о выплатах присутствует');
  // Финальный блок-прощание остаётся последним разделом руководства.
  assert.ok(doc.querySelector('#guideBody .guide-section:last-child .guide-tagline'), 'руководство заканчивается финальным блоком');
  // Режим инлайн-редактирования: кнопка-переключатель в панели текстов и плавающая
  // кнопка «Готово» для выхода из режима.
  assert.ok(doc.getElementById('admInlineToggle'), 'кнопка входа в инлайн-режим присутствует');
  assert.ok(doc.getElementById('admInlineDone').classList.contains('hidden'), 'кнопка «Готово» скрыта по умолчанию');
});

test('тексты интерфейса доступны оператору, сохраняются и сбрасываются; клиент менять их не может', async () => {
  const list = await req('GET', '/api/admin/texts');
  assert.equal(list.status, 200);
  const item = list.data.texts.find((t) => t.text === 'ПРИВАТНЫЙ ОБМЕН ЦИФРОВЫХ ПОДАРОЧНЫХ КАРТ');
  assert.ok(item);
  // Единица редактирования — целый блок из нескольких абзацев: секция руководства
  // (заголовок + абзацы + списки) собирается целиком одним id, а отдельные абзацы
  // и пункты внутри неё не являются самостоятельными редактируемыми единицами.
  const sec1 = list.data.texts.find((t) => t.text.startsWith('1. Поддерживаемые подарочные карты'));
  assert.ok(sec1, 'секция 1 руководства — один блок');
  assert.ok(sec1.text.includes('Требования к номиналу'), 'блок секции 1 включает абзац о номинале');
  assert.ok(sec1.text.includes('Apple US'), 'блок секции 1 включает пункт списка');
  assert.ok(sec1.text.includes('\n'), 'блок секции многострочный (несколько абзацев)');
  assert.equal(list.data.texts.some((t) => t.text === 'Требования к номиналу: сумма подарочной карты должна быть кратна 10 USD.'), false, 'отдельный абзац не является самостоятельным блоком');
  assert.equal(list.data.texts.some((t) => t.text === '13. Почему курс PRICELEX может быть выше рыночного?'), false, 'отдельный заголовок секции не является самостоятельным блоком');
  const sec13 = list.data.texts.find((t) => t.text.startsWith('13. Почему курс'));
  assert.ok(sec13, 'секция 13 — один блок');
  assert.ok(sec13.text.includes('Минимальный цифровой след'), 'блок секции 13 включает пункт списка с <b>-вводкой');
  const sec14 = list.data.texts.find((t) => t.text.startsWith('14. Важная информация'));
  assert.ok(sec14, 'секция 14 — один блок');
  assert.ok(sec14.text.includes('BNB Smart Chain (BEP-20)'), 'блок секции 14 включает предупреждение о сети выплаты');
  // Серверный info-note карты рендерится в DOM и редактируется как целый блок.
  const info = list.data.texts.find((t) => t.text.includes('Где и по какому курсу вы купили карту — нам не важно'));
  assert.ok(info, 'CARD_INFO_NOTE должен быть в каталоге целым блоком');
  assert.equal((await req('GET', '/api/admin/texts', { demo: CLIENT_DEMO })).status, 403);
  assert.equal((await req('PUT', '/api/admin/texts', { demo: CLIENT_DEMO, body: { id: item.id, value: 'Новое название' } })).status, 403);
  assert.equal ( (await req('PUT', '/api/admin/texts', { body: { id: 'unknown', value: 'Текст' } })).status, 400);
  assert.equal((await req('PUT', '/api/admin/texts', { body: { id: item.id, value: '' } })).status, 400);
  const saved = await req('PUT', '/api/admin/texts', { body: { id: item.id, value: '<b>Новое название</b>' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.settings.texts.find((t) => t.text === item.text), { text: item.text, value: '<b>Новое название</b>' });
  const reset = await req('PUT', '/api/admin/texts', { body: { id: item.id, value: null } });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.settings.texts.some((t) => t.text === item.text), false);
  // Секция руководства — один блок из нескольких абзацев: override сохраняется и
  // сбрасывается как единое целое, переводы строк сохраняются.
  const multi = 'Первая строка секции.\nВторая строка секции.\nТретья строка секции.';
  const secSaved = await req('PUT', '/api/admin/texts', { body: { id: sec14.id, value: multi } });
  assert.equal(secSaved.status, 200);
  assert.equal(secSaved.data.settings.texts.find((t) => t.text === sec14.text).value, multi);
  // Длинный блок (до 2000 символов) принимается — секция может быть длинной.
  const longVal = 'X'.repeat(2000);
  const longSaved = await req('PUT', '/api/admin/texts', { body: { id: sec1.id, value: longVal } });
  assert.equal(longSaved.status, 200);
  // Сверх лимита — отвергается.
  const tooLong = await req('PUT', '/api/admin/texts', { body: { id: sec1.id, value: 'Y'.repeat(2001) } });
  assert.equal(tooLong.status, 400);
  const secReset = await req('PUT', '/api/admin/texts', { body: { id: sec14.id, value: null } });
  assert.equal(secReset.status, 200);
  const longReset = await req('PUT', '/api/admin/texts', { body: { id: sec1.id, value: null } });
  assert.equal(longReset.status, 200);
});


test('BEP-20 моментальный без комиссии; TRC-20, ERC-20, TON и BTC с вычетом комиссии сети', async () => {
  const bepWallet = '0x' + 'abcD'.repeat(10);
  const trcWallet = 'T' + '9aBcDeFgHiJkLmNoPqRsTuVwXyZ123456'; // 34 chars Base58
  const btcWallet = 'bc1q' + 'a'.repeat(35);
  const tonWallet = 'EQ' + 'aB_c-123'.repeat(5) + '123456';
  const create = (body) => req('POST', '/api/orders', { demo: CLIENT_DEMO, body: { currency: 'GOOGLE_USD', units: 100, ...body } });

  // Неподдерживаемые сети или несоответствующие адреса кошельков отклоняются.
  assert.equal((await create({ wallet: bepWallet, network: 'SOLANA' })).status, 400);
  assert.equal((await create({ wallet: bepWallet, payoutId: 'USDT_TRC20' })).status, 400);
  assert.equal((await create({ wallet: trcWallet, payoutId: 'USDT_BEP20' })).status, 400);
  assert.equal((await create({ wallet: btcWallet, payoutId: 'USDT_BEP20' })).status, 400);
  assert.equal((await create({ wallet: bepWallet.slice(1), payoutId: 'USDT_BEP20' })).status, 400);

  // 1) USDT (BEP-20) — моментально и строго без комиссии сети (networkFee === 0).
  const bep = await create({ wallet: bepWallet, network: 'BEP-20', payoutCurrency: 'USDT' });
  assert.equal(bep.status, 200);
  assert.equal(bep.data.order.payoutId, 'USDT_BEP20');
  assert.equal(bep.data.order.network, 'BEP20');
  assert.equal(bep.data.order.networkFee, 0);
  assert.equal(bep.data.order.instant, true);
  assert.equal(bep.data.order.crypto, 90);
  assert.equal(bep.data.order.grossCrypto, 90);
  assert.equal(bep.data.order.payoutLabel, 'USDT (BEP-20)');

  // 2) USDT (TRC-20) — вычитается комиссия сети (по умолчанию 1.5 USDT).
  const trc = await create({ wallet: trcWallet, payoutId: 'USDT_TRC20' });
  assert.equal(trc.status, 200);
  assert.equal(trc.data.order.payoutId, 'USDT_TRC20');
  assert.equal(trc.data.order.network, 'TRC20');
  assert.equal(trc.data.order.networkFee, 1.5);
  assert.equal(trc.data.order.instant, false);
  assert.equal(trc.data.order.grossCrypto, 90);
  assert.equal(trc.data.order.crypto, 88.5);
  assert.equal(trc.data.order.payoutLabel, 'USDT (TRC-20)');

  // 3) USDT (ERC-20) и USDT (TON) — вычитается комиссия сети.
  const erc = await create({ wallet: bepWallet, network: 'ERC20', payoutCurrency: 'USDT' });
  assert.equal(erc.status, 200);
  assert.equal(erc.data.order.network, 'ERC20');
  assert.equal(erc.data.order.networkFee, 3);
  assert.equal(erc.data.order.crypto, 87);

  const ton = await create({ wallet: tonWallet, network: 'TON', payoutCurrency: 'USDT' });
  assert.equal(ton.status, 200);
  assert.equal(ton.data.order.network, 'TON');
  assert.equal(ton.data.order.networkFee, 0.5);
  assert.equal(ton.data.order.crypto, 89.5);

  // 4) Bitcoin (BTC) — пересчёт по курсу BTC/USD и вычет комиссии сети BTC.
  const btc = await create({ wallet: btcWallet, payoutCurrency: 'BTC' });
  assert.equal(btc.status, 200);
  assert.equal(btc.data.order.payoutId, 'BTC');
  assert.equal(btc.data.order.payoutCurrency, 'BTC');
  assert.equal(btc.data.order.network, 'BTC');
  assert.equal(btc.data.order.payoutDecimals, 8);
  assert.equal(btc.data.order.networkFee, 0.00005);
  assert.ok(btc.data.order.grossCrypto > btc.data.order.crypto);
  assert.ok(Math.abs((btc.data.order.grossCrypto - btc.data.order.crypto) - 0.00005) < 1e-8);

  // 5) Оператор не может задать комиссию или отключить BEP-20 (400), но может менять комиссии/статус других сетей и курс BTC.
  assert.equal((await req('POST', '/api/admin/settings', { body: { networkFees: { USDT_BEP20: 5 } } })).status, 400);
  assert.equal((await req('POST', '/api/admin/settings', { body: { payoutEnabled: { USDT_BEP20: false } } })).status, 400);
  const upd = await req('POST', '/api/admin/settings', {
    body: {
      btcUsd: 90000,
      networkFees: { USDT_BEP20: 0, USDT_TRC20: 2.5, BTC: 0.0001 },
      payoutEnabled: { USDT_BEP20: true, USDT_ERC20: false },
    },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.admin.networkFees.USDT_BEP20, 0, 'BEP-20 всегда 0 комиссии');
  assert.equal(upd.data.admin.payoutEnabled.USDT_BEP20, true, 'BEP-20 нельзя выключить');
  assert.equal(upd.data.admin.networkFees.USDT_TRC20, 2.5);
  assert.equal(upd.data.admin.btcUsd, 90000);
  assert.equal((await create({ wallet: bepWallet, network: 'ERC20' })).status, 400, 'выключенная сеть отклоняется');
  const trcAfter = await create({ wallet: trcWallet, network: 'TRC20' });
  assert.equal(trcAfter.status, 200);
  assert.equal(trcAfter.data.order.networkFee, 2.5);
  assert.equal(trcAfter.data.order.crypto, 87.5);
  // Восстановим настройки, чтобы не влиять на другие тесты.
  await req('POST', '/api/admin/settings', {
    body: { networkFees: { USDT_TRC20: 1.5, BTC: 0.00005 }, payoutEnabled: { USDT_ERC20: true } },
  });

  // Обратная совместимость со старой историей заявок (без payoutId / с null network).
  store.mutate((db) => db.orders.push({ id: 888, userId: CLIENT_DEMO.id, direction: 'sell', currency: 'XBOX_USD', network: null, crypto: 0.00000035, status: 'completed' }));
  const history = await req('GET', '/api/me', { demo: CLIENT_DEMO });
  const old = history.data.orders.find((o) => o.id === 888);
  assert.equal(old.payoutCurrency, 'BTC');
  assert.equal(old.payoutDecimals, 8);
  assert.equal(old.crypto, 0.00000035);
});
