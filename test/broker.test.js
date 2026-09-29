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
  assert.ok(/Депозит не внесён/.test(home.text)); // без депозита — подсказка пополнить
  assert.ok(!/стажировк/i.test(home.text));
});

test('broker cannot take orders without deposit; top-up → admin confirms → limit = own deposit', async () => {
  // создаём большую заявку через Web API
  store.mutate((db) => { db.settings.minRub = 100; db.settings.brokerDepositAddress = 'bc1qplatformdepositaddr0000000000000000'; });
  const r = await api('/api/orders', { method: 'POST', body: { rub: 20000, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30), ...(await captcha()) } });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  // брокер пытается взять — должна быть ошибка про депозит
  calls = [];
  await click(777, `b:o:${order.id}:take`);
  assert.ok(calls.some((c) => /депозит/i.test(c.text)));
  assert.equal(store.getOrder(order.id).broker, null);

  // экран депозита: без $20, без сбора и без стажировки
  calls = [];
  await click(777, 'b:deposit');
  const menu = calls[calls.length - 1].text;
  assert.match(menu, /Ваш депозит/);
  assert.doesNotMatch(menu, /Сбор|стажир|\$20/i);

  // брокер пополняет депозит на выбранную сумму ≈ 10 000 ₽
  const rate = store.get().settings.rateBTC;
  const amount = Math.round((10000 / rate) * 1e8) / 1e8;
  calls = [];
  await click(777, 'b:dep:add');
  assert.ok(calls.some((c) => /Пришлите сумму в BTC/.test(c.text || '')));
  await text(777, String(amount));
  const dep = store.brokerDepositsByStatus('pending')[0];
  assert.ok(dep && dep.login === 'wolf');
  assert.equal(dep.btc, amount);
  const adminMsg = calls.find((c) => c.chat_id === '111' && /Пополнение депозита брокера/.test(c.text));
  assert.ok(adminMsg);
  assert.doesNotMatch(adminMsg.text, /Сбор|стажёр/i);
  calls = [];
  await click(111, `bd:${dep.id}:ok`);
  assert.equal(store.getBrokerDeposit(dep.id).status, 'confirmed');
  assert.equal(store.brokerProfile('wolf').depositBtc, amount);
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /подтверждено/.test(c.text)));

  // повторное пополнение суммируется
  const extra = store.createBrokerDeposit({ login: 'wolf', tgId: 777, btc: 0.00001 });
  await click(111, `bd:${extra.id}:ok`);
  assert.equal(store.brokerProfile('wolf').depositBtc, Math.round((amount + 0.00001) * 1e8) / 1e8);
  store.debitBrokerDeposit('wolf', 0.00001);

  // заявка больше депозита — нельзя
  calls = [];
  await click(777, `b:o:${order.id}:take`);
  assert.ok(calls.some((c) => /больше свободной части/i.test(c.text)));
  assert.equal(store.getOrder(order.id).broker, null);

  // маленькую — можно: брокер откликается своей ценой (+5% к рынку)
  const r2 = await api('/api/orders', { method: 'POST', body: { rub: 3000, currency: 'BTC', wallet: 'bc1' + 'b'.repeat(30), ...(await captcha()) } });
  const { order: small } = await r2.json();
  store.setBrokerPrice('wolf', { currency: 'BTC', rate: Math.round(store.get().settings.rateBTC * 1.05) });
  calls = [];
  await click(777, `b:o:${small.id}:take`);
  // отклик не закрепляет заявку: клиент выбирает предложение сам
  assert.equal(store.getOrder(small.id).broker, null);
  assert.equal(store.getOrder(small.id).status, 'collecting');
  const bid = store.bidsForOrder(small.id).find((b) => b.status === 'active');
  assert.ok(bid && bid.login === 'wolf' && bid.rate > store.get().settings.rateBTC);
  assert.ok(calls.some((c) => /Отклик отправлен/i.test(c.text || '')));
  // клиент получает уведомление о предложении
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /Новое предложение/.test(c.text || '')));
  // клиент принимает отклик — брокер закрепляется, цена берётся из отклика
  const accepted = store.acceptBid(small.id, bid.id);
  assert.equal(accepted.ok, true);
  assert.equal(store.getOrder(small.id).broker, 'wolf');
  assert.equal(store.getOrder(small.id).rate, bid.rate);
  assert.equal(store.getOrder(small.id).status, 'new');
  // открытая сделка занимает часть депозита
  assert.equal(store.brokerLimit('wolf').lockedRub, 3000);
  // брокер выдаёт реквизиты (кнопка в уведомлении о принятом отклике)
  calls = [];
  await click(777, `b:o:${small.id}:req`);
  assert.ok(calls.some((c) => /реквизиты/i.test(c.text || '')));
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
  // спред: цена отклика брокера выше рыночной; доля — 70% (gross−ops)
  const est = ledger[0];
  const done = store.getOrder(small.id); // после принятия отклика цена и сумма пересчитаны
  const official = Number(done.officialRate) || done.rate;
  const gross = Math.max(0, Math.round((done.payRub || 3000) - done.crypto * official));
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

test('deposit withdrawal: free part any time, debited after admin pays', async () => {
  const before = store.brokerProfile('wolf').depositBtc;
  assert.ok(before > 0);
  calls = [];
  await click(777, 'b:dep:refund');
  assert.ok(/Пришлите BTC-адрес/.test(calls[calls.length - 1].text));
  await text(777, 'bc1qrefundwalletaddress00000000000000000');
  const payout = store.payoutsByLogin('wolf').find((x) => x.kind === 'deposit');
  assert.ok(payout && payout.status === 'pending');
  // пока вывод в работе, лимит его уже не учитывает
  assert.ok(store.brokerLimit('wolf').depositBtc < before + 1e-12);
  await click(111, `bp:${payout.id}:paid`);
  assert.equal(store.brokerProfile('wolf').depositBtc, Math.max(0, Math.round((before - payout.btc) * 1e8) / 1e8));
  store.upsertBrokerProfile('wolf', { depositBtc: 0 });
  assert.equal(store.brokerDepositRefundable('wolf').ok, false);
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
  // без депозита брокеру оферы не шлём
  store.upsertBrokerProfile('wolf', { depositBtc: 0 });
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  assert.ok(!calls.some((c) => String(c.chat_id) === '777' && /Офер/.test(c.text)));
  // с депозитом — шлём; и назначенному по ID брокеру без открытой сессии тоже
  store.upsertBrokerProfile('wolf', { depositBtc: 1 });
  store.upsertBrokerAccount('4242', { name: 'Новый' });
  store.upsertBrokerProfile('4242', { depositBtc: 1 });
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  assert.ok(calls.some((c) => String(c.chat_id) === '777' && /Офер/.test(c.text)));
  assert.ok(calls.some((c) => String(c.chat_id) === '4242' && /Офер/.test(c.text)), 'назначенный брокер без сессии тоже получает офер');
  store.dropBrokerAccount('4242');
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

test('брокер по user ID: /addbroker без пароля, /removebroker снимает доступ', async () => {
  // админ назначает нового брокера по Telegram ID — логин и пароль не нужны
  calls = [];
  await text(111, '/addbroker 555');
  const acc = store.brokerAccountByTg('555');
  assert.ok(acc && acc.login === '555' && acc.active !== false, 'аккаунт создан, логин = ID');
  assert.ok(calls.some((c) => String(c.chat_id) === '111' && /Брокер назначен/.test(c.text)), 'админ получил подтверждение');
  assert.ok(calls.some((c) => String(c.chat_id) === '555' && /доступ брокера PRICELEX/.test(c.text)), 'брокер получил уведомление');
  // 555 открывает /broker — сразу кабинет, без ввода логина и пароля
  calls = [];
  await text(555, '/broker');
  assert.ok(calls.some((c) => String(c.chat_id) === '555' && /Кабинет брокера/.test(c.text)), 'вход без пароля');
  assert.equal(store.brokerSession(555).login, '555', 'сессия зарегистрировалась сама');
  assert.ok(store.brokerProfile('555'), 'и профиль по логину-ID');
  // повторное назначение не плодит дубликат
  await text(111, '/addbroker 555');
  assert.equal(store.brokerAccounts().filter((b) => b.tgId === '555').length, 1);
  // невалидный ID — понятная ошибка
  calls = [];
  await text(111, '/addbroker abc');
  assert.ok(calls.some((c) => /числовой Telegram ID/.test(c.text)));
  // не-админ не может назначать брокеров
  calls = [];
  await text(555, '/addbroker 777');
  assert.ok(!calls.some((c) => String(c.chat_id) === '111' && /Брокер назначен/.test(c.text)));
  assert.equal(store.brokerAccountByTg('777'), null);
  // снятие доступа: сессия сброшена, /broker снова просит вход
  calls = [];
  await text(111, '/removebroker 555');
  assert.equal(store.brokerAccountByTg('555'), null, 'доступ закрыт');
  assert.equal(store.brokerSession(555), null, 'сессия сброшена');
  await text(555, '/broker');
  assert.ok(calls.some((c) => String(c.chat_id) === '555' && /Вход в кабинет брокера/.test(c.text)), 'снова экран входа');
});

test('брокер по ID работает и при выключенных мастер-кредах; посторонний видит приглашение', async () => {
  store.mutate((db) => { db.settings.brokerActive = false; db.settings.brokerLogin = ''; db.settings.brokerPassword = ''; });
  try {
    // посторонний без приглашения — заглушка про приглашение, а не про «не настроен»
    calls = [];
    await text(666, '/broker');
    assert.ok(calls.some((c) => String(c.chat_id) === '666' && /приглашении|ожидайте контакта/i.test(c.text)));
    // назначенному по ID вход не зависит от мастер-кредов
    await text(111, '/addbroker 666');
    calls = [];
    await text(666, '/broker');
    assert.ok(calls.some((c) => String(c.chat_id) === '666' && /Кабинет брокера/.test(c.text)), 'ID-брокер вошёл без пароля');
    assert.equal(store.brokerSession(666).login, '666');
  } finally {
    store.mutate((db) => { db.settings.brokerActive = true; db.settings.brokerLogin = 'wolf'; db.settings.brokerPassword = 's3cret'; });
    store.dropBrokerAccount(666);
  }
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

test('broker chat: broker writes, admin replies into broker chat', async () => {
  // Входим брокером и открываем «💬 Чат»: первый шаг — собеседование, а не реквизиты.
  calls = [];
  await text(777, '/broker');
  await text(777, 'wolf');
  await text(777, 's3cret');
  await click(777, 'b:chat');

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

test('no internship, fixed $20 deposit or connection fee in settings', () => {
  const pub = store.publicSettings();
  for (const k of ['brokerDepositUsd', 'brokerDepositBtc', 'brokerDepositFeePercent', 'brokerDepositFeeMaxBtc', 'internDays', 'internMaxRub']) {
    assert.equal(pub[k], undefined, k);
  }
  assert.equal(typeof store.brokerIsIntern, 'undefined');
});
