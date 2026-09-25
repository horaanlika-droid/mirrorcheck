// Сквозной сценарий брокерского контура: кабинет /broker с логином-паролем,
// взятие заявки, реквизиты, завершение, доля спреда, выплаты, депозит стажёра,
// заявка «стать брокером» из Web App, капча.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-broker-'));
process.env.DATA_DIR = dir;
process.env.BOT_TOKEN = '123456:test-token';
process.env.ADMIN_ID = '111';
process.env.BROKER_LOGIN = 'wolf';
process.env.BROKER_PASSWORD = 's3cret';

const config = require('../src/config');
const store = require('../src/store');
const bus = require('../src/bus');
const { createBot } = require('../src/bot');
const { startWeb } = require('../src/web');

const botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'pricelex_test_bot' };
const bot = createBot({ botInfo });
let seq = 100;
let calls = [];
const botQueue = bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, ...payload });
  return { ok: true, result: method === 'answerCallbackQuery' ? true : {
    message_id: ++seq, date: 1, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text,
  } };
});

function text(id, value) {
  const command = value.match(/^\/\S+/)?.[0];
  return bot.handleUpdate({ update_id: ++seq, message: {
    message_id: ++seq, date: 1, chat: { id, type: 'private' },
    from: { id, first_name: 'Brk', is_bot: false, username: 'brk' }, text: value,
    ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
  } });
}
function click(id, data) {
  return bot.handleUpdate({ update_id: ++seq, callback_query: {
    id: String(++seq), chat_instance: 'test', from: { id, first_name: 'Brk', is_bot: false }, data,
    message: { message_id: 42, date: 1, chat: { id, type: 'private' }, from: botInfo, text: 'x' },
  } });
}
function signed(id = 777) {
  const p = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Cli' }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const data = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  p.set('hash', crypto.createHmac('sha256', key).update(data).digest('hex'));
  return p.toString();
}
config.port = 0;
const server = startWeb();
const ready = once(server, 'listening');
async function api(route, { id = 777, method = 'GET', body = {} } = {}) {
  await ready;
  const url = `http://127.0.0.1:${server.address().port}${route}?initData=${encodeURIComponent(signed(id))}`;
  return fetch(url, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
}
async function captcha(id = 777) {
  const cap = await (await api('/api/captcha', { id })).json();
  const m = cap.question.match(/^(\d+)\s*([+−×])\s*(\d+)/);
  const [, a, op, b] = m;
  return { captchaId: cap.id, captchaAnswer: op === '+' ? +a + +b : op === '−' ? +a - +b : +a * +b };
}

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings seeded from env; broker creds active', () => {
  const c = store.brokerCreds();
  assert.equal(c.login, 'wolf');
  assert.equal(c.password, 's3cret');
  assert.equal(c.active, true);
  assert.equal(store.get().settings.brokerSharePercent, 70);
  assert.equal(store.get().settings.opsExpensesRub, 50);
});

test('broker login flow: wrong creds rejected, correct creds open cabinet', async () => {
  calls = [];
  await text(777, '/broker');
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /Вход в кабинет брокера/.test(c.text)));
  await text(777, 'notwolf');
  assert.ok(calls[calls.length - 1].text.includes('Логин не подходит'));
  await text(777, 'wolf');
  await text(777, 'wrongpass');
  assert.ok(calls[calls.length - 1].text.includes('Пароль не подходит'));
  await text(777, 's3cret');
  assert.ok(store.brokerSession(777).login === 'wolf');
  assert.ok(/Вход выполнен/.test(calls[calls.length - 2].text));
  const home = calls[calls.length - 1];
  assert.ok(/Кабинет брокера/.test(home.text));
  assert.ok(/стажировк/i.test(home.text)); // стажёр по умолчанию
});

test('broker cannot take big orders without deposit; deposit request → admin confirms → intern limits', async () => {
  // создаём большую заявку через Web API
  const s = store.get().settings;
  store.mutate((db) => { db.settings.minRub = 100; });
  const r = await api('/api/orders', { method: 'POST', body: { rub: 20000, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30), ...(await captcha()) } });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  // брокер пытается взять — должна быть ошибка про депозит
  calls = [];
  await click(777, `b:o:${order.id}:take`);
  assert.ok(calls.some((c) => /депозит/i.test(c.text)));
  assert.equal(store.getOrder(order.id).broker, null);

  // экран депозита сразу показывает сбор и сумму к переводу
  calls = [];
  await click(777, 'b:deposit');
  const menu = calls[calls.length - 1].text;
  assert.match(menu, /Сбор за подключение/);
  assert.match(menu, /0\.00022 BTC/); // депозит 0.0002 + сбор 0.00002
  assert.match(menu, /Возвращается <b>0\.0002 BTC<\/b>/); // сбор не возвращается

  // брокер заявляет депозит → админ подтверждает → стажёр, лимит малых сумм
  calls = [];
  await click(777, 'b:dep:made');
  const dep = store.brokerDepositsByStatus('pending')[0];
  assert.ok(dep && dep.login === 'wolf');
  // сбор 10% от депозита фиксируется в заявке, к переводу — депозит + сбор
  assert.equal(dep.btc, 0.0002);
  assert.equal(dep.feeBtc, 0.00002);
  assert.equal(dep.totalBtc, 0.00022);
  assert.equal(dep.feePercent, 10);
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /депозит 0\.0002 BTC \+ сбор 0\.00002 BTC/.test(c.text)));
  const adminMsg = calls.find((c) => c.chat_id === '111' && /Депозит стажёра/.test(c.text));
  assert.ok(adminMsg);
  assert.match(adminMsg.text, /Сбор за подключение/);
  assert.match(adminMsg.text, /К зачислению всего: <b>0\.00022 BTC<\/b>/);
  calls = [];
  await click(111, `bd:${dep.id}:ok`);
  assert.equal(store.getBrokerDeposit(dep.id).status, 'confirmed');
  const p = store.brokerProfile('wolf');
  assert.ok(p.depositBtc > 0 && p.internUntil > Date.now());
  assert.equal(store.brokerIsIntern('wolf'), true);
  // возврату подлежит ровно депозит, без сбора
  assert.equal(p.depositBtc, dep.btc);
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /Депозит.*подтверждён/.test(c.text)));

  // всё ещё нельзя брать крупные заявки (лимит стажёра)
  calls = [];
  await click(777, `b:o:${order.id}:take`);
  assert.ok(calls.some((c) => /стажировк/i.test(c.text)));
  assert.equal(store.getOrder(order.id).broker, null);

  // маленькую — можно
  const r2 = await api('/api/orders', { method: 'POST', body: { rub: 3000, currency: 'BTC', wallet: 'bc1' + 'b'.repeat(30), ...(await captcha()) } });
  const { order: small } = await r2.json();
  calls = [];
  await click(777, `b:o:${small.id}:take`);
  assert.equal(store.getOrder(small.id).broker, 'wolf');
  assert.ok(calls.some((c) => /реквизиты/i.test(c.text || '')));
  // реквизиты
  await text(777, 'СБП +7 900 111-22-33 Тинькофф Иван И.');
  const upd = store.getOrder(small.id);
  assert.equal(upd.status, 'details');
  assert.equal(upd.payRub, 3000);

  // клиент оплачивает → брокер подтверждает → зачисление доли спреда
  await bus.emit('order_event', { order: upd, type: 'paid' });
  store.updateOrder(small.id, { status: 'paid' });
  const before = store.brokerEarnedBtc('wolf');
  calls = [];
  await click(777, `b:o:${small.id}:confirm`);
  assert.equal(store.getOrder(small.id).status, 'completed');
  const earned = store.brokerEarnedBtc('wolf');
  assert.ok(earned > before, 'broker earned: ' + earned);
  const ledger = store.brokerLedgerFor('wolf');
  assert.equal(ledger.length, 1);
  // спред: клиентский курс выше официального на feePercent; доля — 70% (gross−ops)
  const est = ledger[0];
  const official = Number(small.officialRate) || (small.rate / (1 + (store.get().settings.feePercent || 0) / 100));
  const gross = Math.max(0, Math.round(3000 - small.crypto * official));
  const expectedRub = Math.round((gross - Math.min(gross, 50)) * 0.7);
  assert.equal(est.rub, expectedRub);
  assert.equal(est.spread, gross);
  assert.equal(est.ops, Math.min(gross, 50));
  // повторный confirm у завершённой — тот же текст, но двойного начисления нет (идемпотентность в store)
  assert.equal(store.accrueBroker(store.getOrder(small.id)), null);
  assert.equal(store.brokerLedgerFor('wolf').length, 1);
});

test('payout below minimum refused; above → admin marks paid; broker notified', async () => {
  // занизим баланс, чтобы проверить отказ
  store.mutate((db) => { db.settings.brokerMinPayoutBtc = 0.01; });
  calls = [];
  await click(777, 'b:withdraw');
  assert.ok(calls[calls.length - 1].text.includes('минимум'));
  store.mutate((db) => { db.settings.brokerMinPayoutBtc = 0.00000001; });
  calls = [];
  await click(777, 'b:withdraw');
  assert.ok(/Пришлите BTC-адрес/.test(calls[calls.length - 1].text));
  await text(777, 'bc1qbrokerwalletaddress000000000000000000');
  const payout = store.payoutsByLogin('wolf')[0];
  assert.ok(payout && payout.kind === 'earning' && payout.status === 'pending');
  assert.ok(calls.some((c) => c.chat_id === '111' && /Выплата брокеру/.test(c.text)));
  // баланс зарезервирован
  assert.ok(store.brokerAvailableBtc('wolf') < store.brokerEarnedBtc('wolf'));
  calls = [];
  await click(111, `bp:${payout.id}:paid`);
  assert.equal(store.getPayout(payout.id).status, 'paid');
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /исполнена/i.test(c.text)));
  // после выплаты доступно 0
  assert.equal(store.brokerAvailableBtc('wolf'), 0);
});

test('deposit refund only after internship ends', async () => {
  calls = [];
  await click(777, 'b:dep:refund');
  assert.ok(/вернётся через/i.test(calls[calls.length - 1].text));
  // искусственно завершим стажировку
  store.upsertBrokerProfile('wolf', { internUntil: Date.now() - 1000 });
  await click(777, 'b:dep:refund');
  assert.ok(/Пришлите BTC-адрес/.test(calls[calls.length - 1].text));
  await text(777, 'bc1qrefundwalletaddress00000000000000000');
  const payout = store.payoutsByLogin('wolf').find((x) => x.kind === 'deposit');
  assert.ok(payout && payout.status === 'pending');
  await click(111, `bp:${payout.id}:paid`);
  // депозит списан из профиля
  assert.equal(store.brokerProfile('wolf').depositBtc, 0);
  // повторный возврат не предлагается
  const r = store.brokerDepositRefundable('wolf');
  assert.equal(r.ok, false);
});

test('broker apply via web: captcha required, duplicate 409, admin approves → user notified', async () => {
  // без капчи — отказ
  const noCap = await api('/api/broker/apply', { method: 'POST', body: { experience: 'Два года P2P-опыта, обороты', contact: '@cand' } });
  assert.equal(noCap.status, 400);
  // с капчей — ок
  const r = await api('/api/broker/apply', { method: 'POST', body: { experience: 'Два года P2P-опыта, обороты до 5 млн', contact: '@cand', ...(await captcha(888)) }, id: 888 });
  assert.equal(r.status, 200);
  const { application } = await r.json();
  assert.equal(application.status, 'pending');
  // повтор — 409
  const dup = await api('/api/broker/apply', { method: 'POST', body: { experience: 'ещё опыт ещё опыт ещё', contact: '@cand2', ...(await captcha(888)) }, id: 888 });
  assert.equal(dup.status, 409);
  // карточка админу уже ушла по bus-событию — заявка видна в меню; одобряем
  calls = [];
  await click(111, 'm:brokers');
  assert.ok(calls.some((c) => /Заявок «стать брокером»|стать брокером/i.test(c.text || '')));
  await click(111, `bb:${application.id}:ok`);
  assert.equal(store.getBrokerApp(application.id).status, 'approved');
  assert.ok(calls.some((c) => String(c.chat_id) === '888' && /одобрена/i.test(c.text)));
  // статус в Web API
  const st = await (await api('/api/broker/status', { id: 888 })).json();
  assert.equal(st.application.status, 'approved');
});

test('captcha is single-use and wrong answers rejected', async () => {
  const cap = await captcha();
  const bad = await api('/api/broker/apply', { method: 'POST', body: { experience: 'опыт опыт опыт опыт', contact: '@x', captchaId: cap.captchaId, captchaAnswer: cap.captchaAnswer + 1 }, id: 777 });
  assert.equal(bad.status, 400);
  // правильный ответ, но повторно та же пара — уже сгорела
  const stale = await api('/api/broker/apply', { method: 'POST', body: { experience: 'опыт опыт опыт опыт', contact: '@x', ...cap }, id: 777 });
  assert.equal(stale.status, 400);
});

test('new order events ping broker sessions; paid pings the owning broker only', async () => {
  const s = store.get().settings;
  store.mutate((db) => { db.settings.minRub = 100; });
  const r = await api('/api/orders', { method: 'POST', body: { rub: 2000, currency: 'BTC', wallet: 'bc1' + 'c'.repeat(30), ...(await captcha()) } });
  const { order } = await r.json();
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /Новая заявка/.test(c.text)));
  // чужой «paid» брокера не будит
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'paid' });
  assert.ok(!calls.some((c) => String(c.chat_id) === '777'));
  // свой «paid» — будит
  store.updateOrder(order.id, { broker: 'wolf' });
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'paid' });
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /оплатил/i.test(c.text)));
});

test('logout drops session; /broker after logout asks login again', async () => {
  await click(777, 'b:logout');
  assert.equal(store.brokerSession(777), null);
  calls = [];
  await text(777, '/broker');
  assert.ok(calls.some((c) => /Вход в кабинет брокера/.test(c.text)));
});

test('admin disables broker login — sessions stop working', async () => {
  store.mutate((db) => { db.settings.brokerActive = false; });
  calls = [];
  await text(777, '/broker');
  assert.ok(calls.some((c) => /не настроен|закрыт|ожидайте|не актив/i.test(c.text || '')));
  store.mutate((db) => { db.settings.brokerActive = true; });
});

test('avg exchange time: auto from deals, manual override via setting', () => {
  store.mutate((db) => { db.settings.avgExchangeMin = 0; });
  const auto = store.publicSettings().avgExchangeMin;
  assert.ok(Number.isFinite(auto) && auto >= 1);
  store.mutate((db) => { db.settings.avgExchangeMin = 12; });
  assert.equal(store.publicSettings().avgExchangeMin, 12);
  store.mutate((db) => { db.settings.avgExchangeMin = 0; });
});

test('client calls admin on problem: admin notified and support messages created', async () => {
  const r = await api('/api/orders', { method: 'POST', body: { rub: 3000, currency: 'BTC', wallet: 'bc1' + 'd'.repeat(30), ...(await captcha()) } });
  const { order } = await r.json();
  calls = [];
  const callRes = await api(`/api/order/${order.id}/call-admin`, { method: 'POST' });
  assert.equal(callRes.status, 200);
  const data = await callRes.json();
  assert.equal(data.order.adminCalled, true);
  // admins received alert
  assert.ok(calls.some((c) => /Позвать администратора|вызвал администратора/i.test(c.text)));
  // support messages exist
  const stored = store.getOrder(order.id);
  const msgs = store.getSupportMessages(stored.userId);
  assert.ok(msgs.some((m) => /Вызов администратора/.test(m.text)));
  assert.ok(msgs.some((m) => /Администратор PRICELEX подключается/.test(m.text)));
});

test('broker chat: interview first step, admin replies into broker chat', async () => {
  // Входим брокером и открываем «💬 Чат»: первый шаг — собеседование, а не реквизиты.
  calls = [];
  await text(777, '/broker');
  await text(777, 'wolf');
  await text(777, 's3cret');
  await click(777, 'b:chat');
  const intro = calls[calls.length - 1].text;
  assert.match(intro, /собеседован/i, 'первый шаг кабинета — собеседование');
  assert.match(intro, /депозит/);
  assert.match(intro, /заявк/i, 'объяснено, что заявки приходят в рамках суммы депозита');
  assert.match(intro, /доверие/i, 'доверие растёт — площадка закрывает часть депозита');

  // Брокер пишет площадке: сообщение ложится в его персональную ветку и видно админу.
  calls = [];
  await click(777, 'b:chat:reply');
  await text(777, 'Два года P2P-сделок, обороты до 5 млн');
  const adminCard = calls.find((c) => String(c.chat_id) === '111' && /Чат брокера/.test(c.text || ''));
  assert.ok(adminCard, 'админ видит карточку чата брокера');
  assert.match(adminCard.text, /wolf/);
  const rk = adminCard.reply_markup && adminCard.reply_markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('bchat:'));
  assert.ok(rk, 'у админа есть кнопка открыть чат брокера');

  // Админ открывает чат и отвечает.
  calls = [];
  await click(111, rk.callback_data);
  const adminView = calls.find((c) => c.method === 'sendMessage');
  assert.ok(adminView, 'админ открыл чат брокера');
  assert.match(adminView.text, /Чат с брокером/);
  await click(111, 'bchre:777:wolf');
  await text(111, 'Реквизиты на депозит высланы личным сообщением');
  const brokerSees = store.getSupportMessages('777').filter((m) => m.from === 'admin' && m.broker === 'wolf');
  assert.ok(brokerSees.length && /Реквизиты на депозит/.test(brokerSees[brokerSees.length - 1].text));
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /PRICELEX:/.test(c.text)));

  // Брокер снова открывает чат — видит ответ площадки.
  calls = [];
  await click(777, 'b:chat');
  assert.match(calls[calls.length - 1].text, /Реквизиты на депозит/);
});

test('connection fee: 10% of deposit, capped at 0.0005 BTC', () => {
  const saved = {
    percent: store.get().settings.brokerDepositFeePercent,
    max: store.get().settings.brokerDepositFeeMaxBtc,
  };
  store.mutate((db) => { db.settings.brokerDepositFeePercent = 10; db.settings.brokerDepositFeeMaxBtc = 0.0005; });
  // 10% от базового депозита — ниже потолка
  assert.equal(store.brokerDepositFeeFor(0.0002), 0.00002);
  assert.equal(store.brokerDepositTotalBtc(0.0002), 0.00022);
  // крупный депозит упирается в потолок 0.0005
  assert.equal(store.brokerDepositFeeFor(0.01), 0.0005);
  assert.equal(store.brokerDepositTotalBtc(0.01), 0.0105);
  // 0 в настройке предела = без предела
  store.mutate((db) => { db.settings.brokerDepositFeeMaxBtc = 0; });
  assert.equal(store.brokerDepositFeeFor(0.01), 0.001);
  // 0% = сбора нет, к переводу ровно депозит
  store.mutate((db) => { db.settings.brokerDepositFeePercent = 0; db.settings.brokerDepositFeeMaxBtc = 0.0005; });
  assert.equal(store.brokerDepositFeeFor(0.0002), 0);
  assert.equal(store.brokerDepositTotalBtc(0.0002), 0.0002);
  // настройки публичные — Web App знает условия до подачи анкеты
  const pub = store.publicSettings();
  assert.equal(pub.brokerDepositFeePercent, 0);
  store.mutate((db) => {
    db.settings.brokerDepositFeePercent = saved.percent;
    db.settings.brokerDepositFeeMaxBtc = saved.max;
  });
});
