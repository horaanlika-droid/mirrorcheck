const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-test-'));
process.env.DATA_DIR = dir;
process.env.BOT_TOKEN = '123456:test-token';
process.env.ADMIN_ID = '111';
process.env.ADMIN_IDS = '222,111; 333';
// Реальная старая база без admins, version и adminMsgIds.
fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ seq: 2, orders: [{
  id: 1, userId: '999', userName: 'Legacy', rub: 5000, currency: 'BTC',
  wallet: 'bc1' + 'a'.repeat(30), crypto: 0.0005, rate: 10000000,
  status: 'new', createdAt: Date.now(), adminMsgId: 42,
}] }));
const config = require('../src/config');
const store = require('../src/store');
const admins = require('../src/admins');
const bus = require('../src/bus');
const { createBot } = require('../src/bot');
const { startWeb } = require('../src/web');
const botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'pricelex_test_bot' };
const bot = createBot({ botInfo });
let seq = 100;
let calls = [];
let blocked = new Set();
let unchanged = false;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, ...payload });
  if (blocked.has(String(payload.chat_id))) return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' };
  if (unchanged && method === 'editMessageText') return { ok: false, error_code: 400, description: 'Bad Request: message is not modified' };
  return { ok: true, result: method === 'answerCallbackQuery' ? true : {
    message_id: ++seq, date: 1, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text,
  } };
});

function text(id, value, chatType = 'private') {
  const command = value.match(/^\/\S+/)?.[0];
  return bot.handleUpdate({ update_id: ++seq, message: {
    message_id: ++seq, date: 1, chat: { id, type: chatType },
    from: { id, first_name: 'Test', is_bot: false }, text: value,
    ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
  } });
}
function click(id, data) {
  return bot.handleUpdate({ update_id: ++seq, callback_query: {
    id: String(++seq), chat_instance: 'test', from: { id, first_name: 'Admin', is_bot: false }, data,
    message: { message_id: 42, date: 1, chat: { id, type: 'private' }, from: botInfo, text: 'Order' },
  } });
}
function signed(id = 999) {
  const p = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Client' }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const data = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  p.set('hash', crypto.createHmac('sha256', key).update(data).digest('hex'));
  return p.toString();
}
config.port = 0;
const server = startWeb();
const ready = once(server, 'listening');
async function api(route, { id = 999, method = 'GET', body = {} } = {}) {
  await ready;
  const url = `http://127.0.0.1:${server.address().port}${route}?initData=${encodeURIComponent(signed(id))}`;
  return fetch(url, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
}
// Математическая капча защищает формы: решаем пример из вопроса.
async function captchaFields(id = 999) {
  const r = await api('/api/captcha', { id });
  assert.equal(r.status, 200);
  const cap = await r.json();
  const m = cap.question.match(/^(\d+)\s*([+−×])\s*(\d+)/);
  assert.ok(m, 'captcha question parse: ' + cap.question);
  const [, a, op, b] = m;
  const answer = op === '+' ? Number(a) + Number(b) : op === '−' ? Number(a) - Number(b) : Number(a) * Number(b);
  return { captchaId: cap.id, captchaAnswer: answer };
}
async function newOrder() {
  const r = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30), ...(await captchaFields()) } });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  // Дожидаемся очереди карточек (HTTP намеренно не ждёт Telegram).
  await bus.emit('order_event', { order, type: 'new' });
  return order;
}
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ADMIN_IDS merged/deduplicated; old database and legacy message remain compatible', async () => {
  assert.deepEqual(admins.all(), ['111', '222', '333']);
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(1), type: 'new' });
  assert.ok(calls.some((c) => c.method === 'editMessageText' && c.chat_id === '111' && c.message_id === 42));
  assert.ok(store.getOrder(1).adminMsgIds['222']);
  assert.ok(store.getOrder(1).adminMsgIds['333']);
});

test('owner adds/removes persistent admins; operators, strangers and groups cannot grant access', async () => {
  await text(111, '/addadmin 444');
  assert.ok(admins.has(444));
  await text(444, '/addadmin 555');
  await text(999, '/addadmin 666');
  await text(111, '/addadmin 777', 'group');
  assert.ok(!admins.has(555) && !admins.has(666) && !admins.has(777));
  await text(111, '/addadmin @username');
  await text(111, '/addadmin -1');
  await text(111, '/addadmin 444');
  assert.equal(admins.all().filter((id) => id === '444').length, 1);
  await text(111, '/removeadmin 222');
  assert.ok(admins.has(222));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const persisted = execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/admins').all()))"], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.ok(JSON.parse(persisted).includes('444'));
  await text(111, '/removeadmin 444');
  assert.ok(!admins.has(444));
});

test('new orders reach all admins; unchanged cards do not generate duplicate messages', async () => {
  const o = await newOrder();
  const stored = store.getOrder(o.id);
  assert.deepEqual(Object.keys(stored.adminMsgIds).sort(), admins.all().sort());
  assert.equal(new Set(Object.values(stored.adminMsgIds)).size, 3);
  calls = [];
  unchanged = true;
  await bus.emit('order_event', { order: stored, type: 'new' });
  unchanged = false;
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 0);
});

test('requisites publish atomically after one admin text, visible in authenticated API and Telegram', async () => {
  const o = await newOrder();
  await click(222, `o:${o.id}:req`);
  assert.equal(store.getOrder(o.id).status, 'new');
  const req = 'СБП: +7 900 000-00-00\nБанк: Тест\nПолучатель: <Иван & Co>';
  calls = [];
  await text(222, req);
  const response = await api(`/api/order/${o.id}`);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const { order } = await response.json();
  assert.equal(order.status, 'details');
  assert.equal(order.requisites, req);
  assert.equal(order.payRub, 5000);
  assert.equal(order.adminMsgIds, undefined);
  assert.ok(calls.some((c) => c.chat_id === '999' && c.text.includes('&lt;Иван &amp; Co&gt;')));
  assert.equal((await api(`/api/order/${o.id}`, { id: 888 })).status, 404);
  const unauthorized = await fetch(`http://127.0.0.1:${server.address().port}/api/order/${o.id}?initData=invalid`);
  assert.equal(unauthorized.status, 401);
  // Перезагрузка приложения восстанавливает заявку через /api/me.
  const profile = await (await api('/api/me')).json();
  assert.equal(profile.orders.find((x) => x.id === o.id).requisites, req);
});

test('custom amount is selected BEFORE publication; invalid amount and oversized requisites are rejected', async () => {
  const o = await newOrder();
  await click(111, `o:${o.id}:quote`);
  await text(111, '5000 мусор');
  assert.equal(store.getOrder(o.id).status, 'new');
  await text(111, '5 123');
  await text(111, 'x'.repeat(901));
  assert.equal(store.getOrder(o.id).requisites, null);
  await text(111, 'Банк, номер, получатель');
  assert.equal(store.getOrder(o.id).payRub, 5123);
  assert.equal(store.getOrder(o.id).status, 'details');
});

test('blocked admin/client do not prevent other admins or Web App from receiving requisites', async () => {
  blocked = new Set(['111', '999']);
  const o = await newOrder();
  await click(222, `o:${o.id}:req`);
  await text(222, 'Реквизиты для приложения');
  blocked.clear();
  const { order } = await (await api(`/api/order/${o.id}`)).json();
  assert.equal(order.status, 'details');
  assert.ok(store.getOrder(o.id).adminMsgIds['333']);
  assert.ok(calls.some((c) => c.chat_id === 222 && c.text?.includes('Личное сообщение не доставлено')));
});

test('parallel operators cannot overwrite requisites or stale amount drafts', async () => {
  const o = await newOrder();
  await click(111, `o:${o.id}:req`);
  await click(222, `o:${o.id}:req`);
  await Promise.all([text(111, 'Первый оператор'), text(222, 'Второй оператор')]);
  assert.equal(store.getOrder(o.id).requisites, 'Первый оператор');
  await click(111, `o:${o.id}:amt`);
  await click(222, `o:${o.id}:amt`);
  await text(222, '5100');
  await text(111, '5200');
  assert.equal(store.getOrder(o.id).payRub, 5100);
});

test('cancelled orders cannot be revived by pending text or old buttons', async () => {
  const o = await newOrder();
  await click(111, `o:${o.id}:req`);
  await api(`/api/order/${o.id}/cancel`, { method: 'POST' });
  await text(111, 'Устаревшие реквизиты');
  for (const action of ['req', 'amt', 'confirm', 'reject', 'unpaid']) await click(222, `o:${o.id}:${action}`);
  assert.equal(store.getOrder(o.id).status, 'cancelled');
  assert.equal(store.getOrder(o.id).requisites, null);
});

test('removed admin cannot finish an existing flow; unauthorized callbacks do not mutate orders', async () => {
  const o = await newOrder();
  await text(111, '/addadmin 444');
  await click(444, `o:${o.id}:req`);
  await text(111, '/removeadmin 444');
  await text(444, 'Не должны сохраниться');
  await click(999, `o:${o.id}:confirm`);
  await text(111, '/addadmin 444');
  await text(444, 'Старый ввод тоже не должен сохраниться');
  await text(111, '/removeadmin 444');
  assert.equal(store.getOrder(o.id).status, 'new');
});

test('payment requires a PDF receipt; invalid files rejected, receipt reaches admins and owner', async () => {
  const pdf = Buffer.from('%PDF-1.4\n% fake receipt\n').toString('base64');
  const o = await newOrder();
  await click(111, `o:${o.id}:req`);
  await text(111, 'Реквизиты');
  // Без чека оплатить нельзя.
  const nopdf = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(nopdf.status, 400);
  assert.equal(store.getOrder(o.id).status, 'details');
  // Не-PDF отклоняется.
  const badExt = await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'check.txt', data: Buffer.from('hello').toString('base64') } });
  assert.equal(badExt.status, 400);
  const badMagic = await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'check.pdf', data: Buffer.from('not a pdf').toString('base64') } });
  assert.equal(badMagic.status, 400);
  assert.equal(store.getOrder(o.id).receipt, null);
  // Валидный чек принимается и рассылается всем админам файлом.
  calls = [];
  const ok = await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'check.pdf', data: pdf } });
  assert.equal(ok.status, 200);
  const { order } = await ok.json();
  assert.equal(order.receipt.name, 'check.pdf');
  assert.ok(order.receipt.size > 0);
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'receipt' });
  for (const id of admins.all()) {
    assert.ok(calls.some((c) => c.method === 'sendDocument' && String(c.chat_id) === String(id)));
  }
  // Скачивание чека владельцем.
  const dl = await api(`/api/order/${o.id}/receipt`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /pdf/);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api(`/api/order/${o.id}/receipt`, { id: 888 })).status, 404);
  // Теперь оплата проходит.
  const paid = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(paid.status, 200);
  assert.equal(store.getOrder(o.id).status, 'paid');
  // Кнопка «Получить чек» отправляет файл запросившему админу.
  calls = [];
  await click(222, `o:${o.id}:receipt`);
  assert.ok(calls.some((c) => c.method === 'sendDocument' && String(c.chat_id) === '222'));
});

test('paid notifications reach every admin; stale amount cannot undo payment; confirmation is idempotent', async () => {
  const o = await newOrder();
  await click(111, `o:${o.id}:req`);
  await text(111, 'Реквизиты');
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'check.pdf', data: pdf } });
  await click(111, `o:${o.id}:amt`);
  calls = [];
  await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'paid' });
  for (const id of admins.all()) assert.ok(calls.some((c) => c.chat_id === id && c.text?.includes('Клиент нажал')));
  await text(111, '6000');
  assert.equal(store.getOrder(o.id).status, 'paid');
  assert.equal(store.getOrder(o.id).payRub, 5000);
  calls = [];
  await Promise.all([click(111, `o:${o.id}:confirm`), click(222, `o:${o.id}:confirm`)]);
  assert.equal(store.getOrder(o.id).status, 'completed');
  assert.equal(calls.filter((c) => c.text?.includes('Отправьте клиенту вручную')).length, 1);
  const { order } = await (await api(`/api/order/${o.id}`)).json();
  assert.equal(order.status, 'completed');
});

test('reverse calculator: crypto amount converts to rubles to pay; fee stays hidden', async () => {
  const s = store.get().settings;
  const wallet = 'bc1' + 'a'.repeat(30);
  const r = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.001, currency: 'BTC', wallet, ...(await captchaFields()) } });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.crypto, 0.001);
  assert.equal(order.rub, Math.ceil(0.001 * s.rateBTC - 1e-6));
  assert.equal(order.rate, s.rateBTC);
  // Клиенту нигде не светим комиссию и базовые курсы.
  assert.equal(order.feePercent, undefined);
  assert.equal(order.baseRateBTC, undefined);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.feePercent, undefined);
  assert.equal(pub.baseRateBTC, undefined);
  assert.equal(pub.baseRateGRAM, undefined);
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
});

test('reverse calculator rejects out-of-range and invalid crypto amounts', async () => {
  const s = store.get().settings;
  const wallet = 'gram1' + 'a'.repeat(30);
  const tiny = await api('/api/orders', { method: 'POST', body: { cryptoAmount: s.minRub / s.rateGRAM / 2, currency: 'GRAM', wallet, ...(await captchaFields()) } });
  assert.equal(tiny.status, 400);
  const huge = await api('/api/orders', { method: 'POST', body: { cryptoAmount: s.maxRub / s.rateGRAM * 2, currency: 'GRAM', wallet, ...(await captchaFields()) } });
  assert.equal(huge.status, 400);
  for (const bad of [0, -1, 'мусор', '', null]) {
    const res = await api('/api/orders', { method: 'POST', body: { cryptoAmount: bad, currency: 'GRAM', wallet, ...(await captchaFields()) } });
    assert.equal(res.status, 400);
  }
  // Старый формат (только рубли) продолжает работать.
  const legacy = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'GRAM', wallet, ...(await captchaFields()) } });
  assert.equal(legacy.status, 200);
  const { order } = await legacy.json();
  assert.equal(order.crypto, 5000 / s.rateGRAM);
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
});

test('rate history endpoint serves real observations for the Web App chart', async () => {
  const port = server.address().port;
  const base = Date.now() - 6 * 3600 * 1000;
  store.mutate((db) => { db.rateHistory = []; });
  // Мусор и неполные точки не попадают в историю.
  assert.equal(store.pushRatePoint({ btc: 0, gram: 0 }), null);
  assert.equal(store.pushRatePoint({ btc: 500, gram: NaN }), null);
  for (let i = 0; i < 12; i += 1) {
    store.pushRatePoint({ btc: 10_000_000 + i * 1000, gram: 120 + i, at: base + i * 1800_000 });
  }
  // Дубль в пределах 30 секунд не создаёт новую точку.
  const before = store.get().rateHistory.length;
  store.pushRatePoint({ btc: 10_000_000 + 11_000, gram: 131, at: base + 11 * 1800_000 + 5000 });
  assert.equal(store.get().rateHistory.length, before);

  const r = await fetch(`http://127.0.0.1:${port}/api/rates/history?hours=24`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-store/);
  const { points, hours } = await r.json();
  assert.equal(hours, 24);
  assert.equal(points.length, 12);
  assert.deepEqual(points[0], { at: base, btc: 10_000_000, gram: 120 });
  assert.equal(points[points.length - 1].btc, 10_000_000 + 11_000);
  assert.equal(points[0].btc, 10_000_000);

  // Окно ограничивает историю по времени.
  const narrow = await (await fetch(`http://127.0.0.1:${port}/api/rates/history?hours=1`)).json();
  assert.ok(narrow.points.every((p) => p.at >= Date.now() - 3600_000));

  // Прореживание сохраняет последнюю точку — по ней строится маркер «сейчас».
  store.mutate((db) => {
    db.rateHistory = Array.from({ length: 400 }, (_, i) => ({ at: base + i * 60_000, btc: 9_000_000 + i, gram: 100 + i }));
  });
  const dense = await (await fetch(`http://127.0.0.1:${port}/api/rates/history?hours=24`)).json();
  assert.ok(dense.points.length <= 181, `ожидалось <= 181 точек, получено ${dense.points.length}`);
  assert.equal(dense.points[dense.points.length - 1].btc, 9_000_399);

  // Когда пользователь заходит с пустой историей — подгружается недельная история с процентом
  store.mutate((db) => {
    db.rateHistory = [];
    db.settings.feePercent = 2;
  });
  const weekly = await (await fetch(`http://127.0.0.1:${port}/api/rates/history`)).json();
  assert.equal(weekly.hours, 168);
  assert.ok(weekly.points.length >= 2, 'график не пустой');
  assert.ok(weekly.points[0].btc > 0 && weekly.points[0].gram > 0);
});

test('reviews: only after a completed own order, one per order, hidden until moderated by any admin', async () => {
  const o = await newOrder();
  const send = (body, id = 999) => api('/api/reviews', { id, method: 'POST', body: { orderId: o.id, rating: 5, text: 'Всё прошло отлично', ...body } });
  assert.equal((await send({})).status, 403, 'до завершения обмена отзыв недоступен');
  store.updateOrder(o.id, { status: 'completed' });
  assert.equal((await send({}, 1234)).status, 403, 'чужая заявка');
  assert.equal((await send({ rating: 6 })).status, 400);
  assert.equal((await send({ text: 'ok' })).status, 400);

  calls = [];
  const r = await send({ text: 'Брокер нашёл лучший курс <b>спасибо</b>' });
  assert.equal(r.status, 200);
  const { review, order } = await r.json();
  assert.equal(store.getReview(review.id).status, 'pending');
  assert.ok(!('status' in review), 'клиенту статус модерации не отдаётся');
  assert.deepEqual(order.review, { id: review.id });
  assert.equal((await send({})).status, 409, 'второй отзыв по той же заявке');

  // Карточка модерации ушла всем админам, HTML клиента экранирован.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cards = calls.filter((c) => c.method === 'sendMessage' && /Новый отзыв/.test(c.text));
  assert.deepEqual(cards.map((c) => String(c.chat_id)).sort(), admins.all().sort());
  assert.ok(cards.every((c) => c.text.includes('&lt;b&gt;спасибо&lt;/b&gt;')));

  const pub = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/reviews`)).json());
  const asAuthor = async () => (await (await api('/api/reviews')).json());
  const asStranger = async () => (await (await api('/api/reviews', { id: 4321 })).json());
  assert.ok(!(await pub()).reviews.some((x) => x.id === review.id), 'до модерации гости отзыв не видят');
  assert.ok(!(await asStranger()).reviews.some((x) => x.id === review.id), 'другие клиенты — тоже');
  const mine = (await asAuthor()).reviews.find((x) => x.id === review.id);
  assert.ok(mine, 'автор сразу видит свой отзыв опубликованным');
  assert.ok(!('status' in mine));

  await click(999, `rv:${review.id}:approve`); // посторонний не может модерировать
  assert.equal(store.getReview(review.id).status, 'pending');

  calls = [];
  await click(222, `rv:${review.id}:approve`);
  assert.equal(store.getReview(review.id).status, 'approved');
  assert.ok((await pub()).reviews.some((x) => x.id === review.id));
  assert.ok(!calls.some((c) => c.method === 'sendMessage' && String(c.chat_id) === '999'), 'клиенту ничего не сообщаем о модерации');
  assert.ok(calls.some((c) => c.method === 'editMessageText' && String(c.chat_id) === '111'), 'карточки других админов синхронизированы');

  await click(111, `rv:${review.id}:reject`);
  assert.equal(store.getReview(review.id).status, 'rejected');
  assert.ok(!(await pub()).reviews.some((x) => x.id === review.id));
  assert.ok((await asAuthor()).reviews.some((x) => x.id === review.id), 'даже скрытый отзыв автор продолжает видеть');
});

test('admin adds a review in the bot and edits name, rating, text, date and time (MSK)', async () => {
  await click(111, 'rv:add');
  await text(111, 'Алексей К.');
  await click(111, 'rva:rate:4');
  await text(111, 'Сделка прошла спокойно и быстро');
  await text(111, '01.09.2026 14:30');
  const r = store.reviewsByStatus().find((x) => x.name === 'Алексей К.');
  assert.ok(r, 'отзыв создан');
  assert.equal(r.status, 'approved');
  assert.equal(r.source, 'admin');
  assert.equal(r.rating, 4);
  assert.equal(r.createdAt, Date.UTC(2026, 8, 1, 11, 30), '14:30 по Москве = 11:30 UTC');

  await click(222, `rv:${r.id}:name`);
  await text(222, 'Алексей');
  await click(222, `rv:${r.id}:rate:5`);
  await click(222, `rv:${r.id}:text`);
  await text(222, 'Новый текст отзыва');
  await click(222, `rv:${r.id}:date`);
  await text(222, '31.02.2026 10:00'); // несуществующая дата — отклоняется, ввод продолжается
  await text(222, '15.08.2025 09:05');
  const upd = store.getReview(r.id);
  assert.equal(upd.name, 'Алексей');
  assert.equal(upd.rating, 5);
  assert.equal(upd.text, 'Новый текст отзыва');
  assert.equal(upd.createdAt, Date.UTC(2025, 7, 15, 6, 5));

  await click(111, `rv:${r.id}:delok`);
  assert.equal(store.getReview(r.id), null);
});

test('public address is never shown; support contact defaults to empty (чат в приложении)', async () => {
  const s = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.ok(!('publicUrl' in s));
  assert.equal(s.operator, '');
  calls = [];
  await bus.emit('public_url', 'https://secret.example');
  await click(111, 'm:links');
  assert.ok(!calls.some((c) => /secret\.example|Публичный адрес/.test(c.text || '')));
});

test('settings: announcement, operator and channel save to the real keys', async () => {
  await click(111, 's:ann');
  await text(111, 'Новое объявление PRICELEX');
  assert.equal(store.get().settings.announcement, 'Новое объявление PRICELEX');
  assert.equal(store.get().settings.ann, undefined);

  await click(111, 's:op');
  await text(111, '@pricelex_help');
  assert.equal(store.get().settings.operator, '@pricelex_help');
  assert.equal(store.get().settings.op, undefined);

  await click(111, 's:ch');
  await text(111, 'https://t.me/pricelex_new');
  assert.equal(store.get().settings.channel, 'https://t.me/pricelex_new');
  assert.equal(store.get().settings.ch, undefined);

  const s = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(s.announcement, 'Новое объявление PRICELEX');
  assert.equal(s.operator, '@pricelex_help');
  assert.equal(s.channel, 'https://t.me/pricelex_new');
});

test('admin replies to a review with editable date; public API hides author', async () => {
  const r = store.createReview({
    name: 'Игорь', rating: 5, text: 'Отличная сделка, всё чисто',
    status: 'approved', source: 'admin',
  });
  await click(111, `rv:${r.id}:reply`);
  await text(111, 'Благодарим за доверие — всегда на связи.');
  await click(111, 'rvr:now');
  const saved = store.getReview(r.id);
  assert.equal(saved.reply.text, 'Благодарим за доверие — всегда на связи.');
  assert.ok(Number.isFinite(saved.reply.at) && Math.abs(saved.reply.at - Date.now()) < 5000);
  assert.equal(saved.reply.by, '111');

  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/reviews`)).json();
  const item = pub.reviews.find((x) => x.id === r.id);
  assert.ok(item);
  assert.equal(item.reply.text, saved.reply.text);
  assert.equal(item.reply.at, saved.reply.at);
  assert.ok(!('by' in item.reply));

  await click(222, `rv:${r.id}:replyedit`);
  await text(222, 'Обновили ответ.');
  await click(222, `rv:${r.id}:replydate`);
  await text(222, '21.09.2026 10:15');
  const upd = store.getReview(r.id);
  assert.equal(upd.reply.text, 'Обновили ответ.');
  assert.equal(upd.reply.at, Date.UTC(2026, 8, 21, 7, 15));
  assert.equal(upd.reply.by, '222');

  calls = [];
  await click(111, `rv:${r.id}`);
  assert.ok(calls.some((c) => c.method === 'editMessageText' && /Ответ PRICELEX/.test(c.text) && /Обновили ответ/.test(c.text)));

  await click(111, `rv:${r.id}:replydel`);
  assert.equal(store.getReview(r.id).reply, null);
});
