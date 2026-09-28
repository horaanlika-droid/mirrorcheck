// Модель «как такси»: клиент публикует офер, брокеры откликаются своей ценой,
// клиент принимает любое предложение — сразу или дождавшись других.
// Плюс доступ: первые 3 дня бесплатно, дальше подписка (минимальный донат на Tribute).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-bids-'));
process.env.DATA_DIR = dir;
process.env.BOT_TOKEN = '123456:test-token';
process.env.ADMIN_ID = '111';
delete process.env.TRIBUTE_URL;

const config = require('../src/config');
const store = require('../src/store');
const bus = require('../src/bus');
const { createBot } = require('../src/bot');
const { startWeb } = require('../src/web');

const botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'pricelex_test_bot' };
const bot = createBot({ botInfo });
let seq = 100;
let calls = [];
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, ...payload });
  return { ok: true, result: method === 'answerCallbackQuery' ? true : {
    message_id: ++seq, date: 1, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text,
  } };
});
function text(id, value) {
  const command = value.match(/^\/\S+/)?.[0];
  return bot.handleUpdate({ update_id: ++seq, message: {
    message_id: ++seq, date: 1, chat: { id, type: 'private' },
    from: { id, first_name: 'Cl', is_bot: false, username: 'cl' }, text: value,
    ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
  } });
}
function click(id, data) {
  return bot.handleUpdate({ update_id: ++seq, callback_query: {
    id: String(++seq), chat_instance: 'test', from: { id, first_name: 'Cl', is_bot: false }, data,
    message: { message_id: 42, date: 1, chat: { id, type: 'private' }, from: botInfo, text: 'x' },
  } });
}
function signed(id) {
  const p = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Cl' }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const data = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  p.set('hash', crypto.createHmac('sha256', key).update(data).digest('hex'));
  return p.toString();
}
config.port = 0;
const server = startWeb();
const ready = once(server, 'listening');
async function api(route, { id = 777, method = 'GET', body = {}, demo = false } = {}) {
  await ready;
  const auth = demo ? `demo[id]=${id}&demo[name]=Demo` : `initData=${encodeURIComponent(signed(id))}`;
  const url = `http://127.0.0.1:${server.address().port}${route}?${auth}`;
  return fetch(url, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
}
// Брокер с подтверждённым депозитом: лимит = депозит (ставка выше стажёрской).
function grantBroker(login, btc = 0.01) {
  store.upsertBrokerProfile(login, { depositBtc: btc, depositAt: Date.now(), internUntil: Date.now() + 30 * 86400000 });
}
async function captcha(id = 777) {
  const cap = await (await api('/api/captcha', { id })).json();
  const m = cap.question.match(/^(\d+)\s*([+−×])\s*(\d+)/);
  const [, a, op, b] = m;
  return { captchaId: cap.id, captchaAnswer: op === '+' ? +a + +b : op === '−' ? +a - +b : +a * +b };
}
async function makeOffer({ id = 777, rub = 5000, currency = 'BTC' } = {}) {
  const r = await api('/api/orders', {
    id,
    method: 'POST',
    body: { rub, currency, wallet: 'bc1' + 'a'.repeat(30), ...(await captcha(id)) },
  });
  assert.equal(r.status, 200, 'офер создаётся');
  return r.json();
}

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('офер публикуется с окном откликов и реальным рыночным курсом', async () => {
  store.mutate((db) => { db.settings.offerWindowSec = 120; db.settings.minRub = 100; });
  const body = await makeOffer({ id: 701, rub: 5000 });
  assert.equal(body.offerWindowSec, 120);
  assert.equal(body.marketRate, store.get().settings.rateBTC, 'рыночный курс — тот же, что у клиента, без наценки');
  const o = body.order;
  assert.equal(o.status, 'collecting');
  assert.equal(o.rate, store.get().settings.rateBTC);
  assert.ok(o.bidUntil > Date.now() + 110000, 'окно откликов открыто');
  assert.equal(o.broker, null);
});

test('брокер откликается своей ценой; повторный отклик обновляет цену, а не плодит записи', async () => {
  const { order } = await makeOffer({ id: 702, rub: 8000 });
  const market = store.get().settings.rateBTC;
  await text(111, '/addbroker 702'); // доступ брокера выдаёт оператор
  grantBroker('702');
  const payload = await (await api('/api/broker/me', { id: 702 })).json();
  assert.ok(payload.broker && payload.broker.login === '702', 'демо-брокер получает кабинет');

  const firstRes = await api('/api/broker/bid', { id: 702, method: 'POST', body: { orderId: order.id, rate: Math.round(market * 1.01) } });
  assert.equal(firstRes.status, 200, await firstRes.clone().text());
  const first = await firstRes.json();
  assert.equal(first.bid.rate, Math.round(market * 1.01));
  const second = await (await api('/api/broker/bid', { id: 702, method: 'POST', body: { orderId: order.id, rate: Math.round(market * 1.02) } })).json();
  assert.equal(second.bid.id, first.bid.id, 'отклик один — цена уточняется');
  assert.equal(store.bidsForOrder(order.id).filter((b) => b.status === 'active').length, 1);

  // клиент видит отклик с ценой, суммой к получению и карточкой брокера
  const view = await (await api(`/api/order/${order.id}/bids`, { id: 702 })).json();
  assert.equal(view.bids.length, 1);
  assert.equal(view.bids[0].rate, Math.round(market * 1.02));
  assert.equal(view.bids[0].payRub, 8000);
  assert.ok(view.bids[0].crypto > 0);
  assert.ok(view.bids[0].broker.login === '702');

  // брокеру приходит офер в боте, отклик виден оператору
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  assert.ok(calls.some((c) => String(c.chat_id) === '111' && /Офер/.test(c.text || '')));
});

test('цена далеко от рынка и чужой офер отклоняются', async () => {
  const { order } = await makeOffer({ id: 703, rub: 4000 });
  const market = store.get().settings.rateBTC;
  await text(111, '/addbroker 703');
  grantBroker('703');
  const wild = await api('/api/broker/bid', { id: 703, method: 'POST', body: { orderId: order.id, rate: Math.round(market * 5) } });
  assert.equal(wild.status, 400);
  const asClient = await api('/api/broker/bid', { id: 777, method: 'POST', body: { orderId: order.id, rate: market } });
  assert.equal(asClient.status, 403, 'кабинет только для брокеров');
});

test('клиент принимает отклик: брокер закрепляется, цена и сумма — из отклика, остальные отклики закрыты', async () => {
  const { order } = await makeOffer({ id: 704, rub: 9000 });
  const market = store.get().settings.rateBTC;
  await text(111, '/addbroker 705');
  await text(111, '/addbroker 706');
  grantBroker('705');
  grantBroker('706');
  store.setBrokerSession(705, '705');
  store.setBrokerSession(706, '706');
  const a = await (await api('/api/broker/bid', { id: 705, method: 'POST', body: { orderId: order.id, rate: market } })).json();
  const b = await (await api('/api/broker/bid', { id: 706, method: 'POST', body: { orderId: order.id, rate: Math.round(market * 1.015) } })).json();

  calls = [];
  const r = await (await api(`/api/order/${order.id}/accept`, { id: 704, method: 'POST', body: { bidId: b.bid.id } })).json();
  assert.equal(r.order.status, 'new');
  assert.equal(r.order.broker, '706');
  assert.equal(r.order.rate, Math.round(market * 1.015));
  assert.equal(r.order.acceptedBidId, b.bid.id);
  assert.ok(r.order.crypto > 0);
  assert.equal(store.getBid(a.bid.id).status, 'declined', 'проигравший отклик закрыт');
  assert.equal(store.getBid(b.bid.id).status, 'accepted');
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'bid_accepted', bid: store.getBid(b.bid.id), declined: ['705'] });
  assert.ok(calls.some((c) => String(c.chat_id) === '706' && /отклик принят/i.test(c.text || '')), 'победителю — реквизиты');
  assert.ok(calls.some((c) => String(c.chat_id) === '705' && /другое предложение/i.test(c.text || '')), 'проигравшему — вежливый отказ');

  // повторное принятие уже закрытого офера отклоняется
  const again = await api(`/api/order/${order.id}/accept`, { id: 704, method: 'POST', body: { bidId: a.bid.id } });
  assert.equal(again.status, 400);
});

test('офер с суммой в монете сохраняет монету: принятие отклика меняет только сумму к оплате', async () => {
  const cryptoAmount = 0.0004;
  const r = await api('/api/orders', {
    id: 707, method: 'POST',
    body: { cryptoAmount, currency: 'BTC', wallet: 'bc1' + 'b'.repeat(30), ...(await captcha(707)) },
  });
  const { order } = await r.json();
  assert.equal(order.crypto, cryptoAmount);
  const market = store.get().settings.rateBTC;
  await text(111, '/addbroker 708');
  grantBroker('708');
  const bid = await (await api('/api/broker/bid', { id: 708, method: 'POST', body: { orderId: order.id, rate: Math.round(market * 1.03) } })).json();
  const accepted = await (await api(`/api/order/${order.id}/accept`, { id: 707, method: 'POST', body: { bidId: bid.bid.id } })).json();
  assert.equal(accepted.order.crypto, cryptoAmount, 'монета остаётся прежней');
  assert.equal(accepted.order.payRub, Math.ceil(cryptoAmount * Math.round(market * 1.03) - 1e-6));
});

test('3 дня бесплатно: свежий доступ открыт, после срока офер не создать', async () => {
  const fresh = store.touchUser({ id: 720, first_name: 'Новый' });
  const access = store.accessFor(fresh);
  assert.equal(access.ok, true);
  assert.equal(access.state, 'trial');
  assert.equal(access.trialDays, 3);
  assert.ok(access.hoursLeft <= 72 && access.hoursLeft > 71);

  // тот же человек через 4 дня
  store.mutate((db) => {
    db.users['720'].trialStartedAt = Date.now() - 4 * 24 * 3600 * 1000;
  });
  const expired = store.accessFor(store.getUser(720));
  assert.equal(expired.ok, false);
  assert.equal(expired.state, 'expired');

  const blocked = await api('/api/orders', {
    id: 720, method: 'POST',
    body: { rub: 5000, currency: 'BTC', wallet: 'bc1' + 'c'.repeat(30), ...(await captcha(720)) },
  });
  assert.equal(blocked.status, 402);
  const body = await blocked.json();
  assert.equal(body.access.state, 'expired');
  assert.equal(body.access.amountRub, store.get().settings.subscriptionAmountRub);
});

test('подписка: «я оплатил» → оператор подтверждает → доступ открыт на 30 дней', async () => {
  const id = 721;
  store.mutate((db) => {
    db.users[String(id)] = { ...(db.users[String(id)] || { id: String(id), name: 'Клиент' }), trialStartedAt: Date.now() - 5 * 86400000 };
  });
  const state = await (await api('/api/subscription', { id })).json();
  assert.equal(state.access.ok, false);

  calls = [];
  const paid = await (await api('/api/subscription/paid', { id, method: 'POST', body: {} })).json();
  assert.equal(paid.access.state, 'pending');
  assert.equal(paid.subscription.status, 'pending');
  assert.equal(paid.subscription.amount, store.get().settings.subscriptionAmountRub);
  assert.ok(calls.some((c) => String(c.chat_id) === '111' && /Заявка на подписку/.test(c.text || '')), 'оператору приходит карточка');

  // оператор подтверждает — доступ включается на 30 дней и пользователь получает письмо
  calls = [];
  await click(111, `sub:${id}:ok`);
  const after = store.accessFor(store.getUser(id));
  assert.equal(after.ok, true);
  assert.equal(after.state, 'active');
  const days = (after.until - Date.now()) / 86400000;
  assert.ok(days > 29 && days <= 30, `подписка на месяц, получено ${days}`);
  assert.ok(calls.some((c) => String(c.chat_id) === String(id) && /Подписка PRICELEX активна/.test(c.text || '')));

  // теперь офер создаётся без ограничений
  const r = await api('/api/orders', {
    id, method: 'POST',
    body: { rub: 5000, currency: 'BTC', wallet: 'bc1' + 'd'.repeat(30), ...(await captcha(id)) },
  });
  assert.equal(r.status, 200);
});

test('подписка одна на человека: брокер без доступа не откликается, после оплаты — откликается', async () => {
  const id = 722;
  store.mutate((db) => { db.users[String(id)] = { id: String(id), name: 'Брокер', trialStartedAt: Date.now() - 6 * 86400000 }; });
  const { order } = await makeOffer({ id: 723, rub: 6000 });
  await text(111, `/addbroker ${id}`);
  grantBroker(String(id));

  const gated = await api('/api/broker/me', { id });
  assert.equal(gated.status, 402);
  const blockedBid = await api('/api/broker/bid', { id, method: 'POST', body: { orderId: order.id, rate: store.get().settings.rateBTC } });
  assert.equal(blockedBid.status, 402);

  store.activateUserSub(id, { days: 30, by: 'test' });
  const lk = await (await api('/api/broker/me', { id })).json();
  assert.ok(lk.broker.login === String(id));
  assert.ok(Array.isArray(lk.offers) && lk.offers.some((o) => o.id === order.id), 'офер виден в кабинете');
  const bid = await api('/api/broker/bid', { id, method: 'POST', body: { orderId: order.id, rate: store.get().settings.rateBTC } });
  assert.equal(bid.status, 200);
});

test('вебхук Tribute включает подписку пользователю по его Telegram ID', async () => {
  const id = 724;
  store.mutate((db) => { db.users[String(id)] = { id: String(id), name: 'Клиент', trialStartedAt: Date.now() - 10 * 86400000 }; });
  assert.equal(store.accessFor(store.getUser(id)).ok, false);
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/tribute/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'payment.succeeded', data: { telegramId: id, amount: 5000, id: 'trb-1' } }),
  });
  assert.equal(r.status, 200);
  const access = store.accessFor(store.getUser(id));
  assert.equal(access.ok, true);
  assert.equal(access.state, 'active');
});
