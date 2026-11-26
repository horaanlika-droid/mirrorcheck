// Клиентский флоу бота: /start → меню, обмен и гифт-карта прямо в чате, «Я оплатил»,
// виджеты за флагом WIDGETS=1 с откатом на обычное сообщение.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-clientbot-'));
process.env.DATA_DIR = dir;
process.env.BOT_TOKEN = '123456:test-token';
process.env.ADMIN_ID = '111';
process.env.ADMIN_IDS = '';
delete process.env.WIDGETS;

const store = require('../src/store');
const { createBot } = require('../src/bot');
const widget = require('../src/widget');
const botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'pricelex_test_bot' };
const bot = createBot({ botInfo });

let seq = 1000;
let calls = [];
const API_SEQ = { n: 9000 };
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, ...payload });
  return { ok: true, result: method === 'answerCallbackQuery' ? true : {
    message_id: ++API_SEQ.n, date: 1, chat: { id: Number(payload.chat_id) || 0, type: 'private' }, text: payload.text || '',
  } };
});

const text = (id, value, chatType = 'private') => bot.handleUpdate({ update_id: ++seq, message: {
  message_id: ++seq, date: 1, chat: { id, type: chatType },
  from: { id, first_name: 'Client', is_bot: false }, text: value,
  ...(value.match(/^\/\S+/) ? { entities: [{ type: 'bot_command', offset: 0, length: value.match(/^\/\S+/)[0].length }] } : {}),
} });
const click = (id, data) => bot.handleUpdate({ update_id: ++seq, callback_query: {
  id: String(++seq), chat_instance: 'test', from: { id, first_name: 'Client', is_bot: false }, data,
  message: { message_id: 42, date: 1, chat: { id, type: 'private' }, from: botInfo, text: 'Order' },
} });
const markupCallbacks = (call) => {
  const rows = call?.reply_markup?.inline_keyboard || [];
  return rows.flat().map((b) => b.callback_data).filter(Boolean);
};
const lastCall = (method) => [...calls].reverse().find((c) => c.method === method);

beforeEach(() => { calls = []; });
after(async () => {
  // На всякий случай возвращаем «живую» среду.
  delete process.env.WIDGETS;
  widget.__setFetch(globalThis.fetch);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-admin /start opens the client menu with c: callbacks', async () => {
  await text(999, '/start');
  const send = lastCall('sendMessage');
  assert.ok(send, 'бот отвечает сообщением');
  assert.ok(String(send.text).includes('PRICELEX'));
  const cb = markupCallbacks(send);
  assert.ok(cb.includes('c:exchange') && cb.includes('c:orders') && cb.includes('c:support'));
  assert.ok(store.getUser(999), 'пользователь добавлен в базу');
});

test('admin /start still opens the operator console, not the client menu', async () => {
  await text(111, '/start');
  const send = lastCall('sendMessage');
  assert.ok(String(send.text).includes('пульт оператор'));
  const cb = markupCallbacks(send);
  assert.ok(cb.includes('m:orders') && !cb.some((d) => d.startsWith('c:')));
});

test('group chats are ignored for client flow', async () => {
  await text(555, '/start', 'group');
  assert.equal(calls.length, 0);
});

test('info, referrals and support screens render; support message reaches the operator', async () => {
  const client = 1011;
  await text(client, '/start');
  await click(client, 'c:info');
  assert.ok(String((lastCall('editMessageText') || {}).text).includes('PRICELEX'));
  await click(client, 'c:refs');
  assert.ok(String((lastCall('editMessageText') || {}).text).includes('Реферальная'));
  calls = [];
  await click(client, 'c:support');
  await text(client, 'Где моя заявка?');
  const support = store.get().support.find((m) => String(m.userId) === String(client));
  assert.ok(support && support.text === 'Где моя заявка?');
  assert.ok(calls.some((c) => c.method === 'sendMessage' && String(c.chat_id) === '111' && String(c.text).includes('поддержки')));
});

test('gift flow end-to-end: menu → exchange → Google Gift Card → paid → operator notified', async () => {
  const client = 1001;
  await text(client, '/start');
  await click(client, 'c:exchange');
  let screen = lastCall('editMessageText') || lastCall('sendMessage');
  assert.ok(markupCallbacks(screen).includes('c:buy:GOOGLE_USD'));

  await click(client, 'c:buy:GOOGLE_USD');
  screen = lastCall('editMessageText');
  assert.ok(String(screen.text).includes('Google Gift Card'));
  assert.ok(String(screen.text).includes('Правила передачи карты'), 'первым открывается диалог с правилами');
  assert.ok(String(screen.text).includes('Минимальный цифровой след'), 'цифровой след упомянут в карточке подарка');
  assert.ok(String(screen.text).includes('Ничего не отправляйте'));
  assert.doesNotMatch(String(screen.text), /комисси/i, 'клиенту не показываем комиссию');

  // Правила → номинал. Код при создании заявки НЕ спрашивают.
  await click(client, 'c:giftnom:GOOGLE_USD');
  screen = lastCall('editMessageText');
  assert.ok(markupCallbacks(screen).includes('c:units:GOOGLE_USD:10'));
  assert.doesNotMatch(String(screen.text), /комисси/i, 'курс показа не раскрывает комиссию');
  await click(client, 'c:units:GOOGLE_USD:10');
  const askWallet = lastCall('editMessageText');
  assert.match(String(askWallet.text), /кошельк/i, 'после номинала спрашивают только кошелёк');
  assert.ok(!String(askWallet.text).includes('Код карты'), 'код до создания заявки не запрашивают');
  // Bitcoin-адрес.
  await text(client, 'bc1' + 'a'.repeat(30));
  const created = store.get().orders.find((o) => String(o.userId) === String(client));
  assert.ok(created, 'заявка создана');
  assert.equal(created.direction, 'sell');
  assert.equal(created.units, 10);
  assert.equal(created.currency, 'GOOGLE_USD');
  assert.equal(created.payoutCurrency, 'BTC');
  assert.equal(created.crypto, Math.floor(10 * created.rate * 1e8 + 1e-6) / 1e8, 'BTC-выплата рассчитывается по общему курсу');
  assert.equal(created.network, null);
  assert.equal(created.giftCode ?? null, null, 'заявка без кода — код только после подключения оператора');
  assert.equal(created.status, 'new');

  // До подключения оператора код отправить нельзя.
  await click(client, `c:sendcode:${created.id}`);
  assert.match(String(lastCall('editMessageText').text), /после подключения оператора/i);
  assert.equal(store.getOrder(created.id).status, 'new');
  assert.equal(store.getOrder(created.id).giftCode ?? null, null);

  // Оператор подключается (в проде — кнопка «🤝 Подключить» в боте оператора).
  store.updateOrder(created.id, { status: 'details' });
  await click(client, `c:sendcode:${created.id}`);
  assert.match(String(lastCall('editMessageText').text), /Оператор в заявке/);
  await text(client, 'XXXX-YYYY-ZZZZ-0001');
  assert.equal(store.getOrder(created.id).status, 'paid');
  assert.equal(store.getOrder(created.id).giftCode, 'XXXX-YYYY-ZZZZ-0001');
  // Оператору улетело уведомление с кодом.
  assert.ok(calls.some((c) => c.method === 'sendMessage' && String(c.chat_id) === '111' && String(c.text).includes(`#${created.id}`)));
});

test('iTunes, Xbox and Apple Store each create a BTC gift order with the selected brand', async () => {
  const products = [
    ['ITUNES_USD', 'iTunes Gift Card', 1101],
    ['XBOX_USD', 'Xbox Gift Card', 1102],
    ['APPLE_STORE_USD', 'Apple Store Gift Card', 1103],
  ];
  for (const [key, label, client] of products) {
    await text(client, '/start');
    await click(client, 'c:exchange');
    await click(client, `c:buy:${key}`);
    const rules = lastCall('editMessageText');
    assert.ok(String(rules.text).includes(label));
    await click(client, `c:giftnom:${key}`);
    const nominal = lastCall('editMessageText');
    assert.ok(String(nominal.text).includes(label));
    await click(client, `c:units:${key}:10`);
    await text(client, 'bc1' + 'a'.repeat(30));
    const order = store.get().orders.find((o) => String(o.userId) === String(client));
    assert.ok(order, `${label} order created`);
    assert.equal(order.currency, key);
    assert.equal(order.payoutCurrency, 'BTC');
    assert.equal(order.network, null);
    assert.equal(order.units, 10);
    assert.equal(order.crypto, Math.floor(10 * order.rate * 1e8 + 1e-6) / 1e8);
    const adminCard = calls.find((c) => c.method === 'sendMessage' && String(c.chat_id) === '111' && String(c.text).includes(`#${order.id}`));
    assert.ok(adminCard && String(adminCard.text).includes(label), `operator sees ${label}`);
  }
});

test('expired gift link and unknown order do not crash the client', async () => {
  await text(1002, '/start');
  await click(1002, 'c:order:999999');
  const screen = lastCall('editMessageText') || lastCall('sendMessage');
  assert.ok(String(screen.text).includes('не найдена'));
});

test('widget send is attempted when WIDGETS=1 and falls back to text on Telegram error', async () => {
  const client = 1003;
  await text(client, '/start');
  await click(client, 'c:exchange');
  await click(client, 'c:buy:GOOGLE_USD');
  await click(client, 'c:giftnom');
  await click(client, 'c:units:10');
  await text(client, 'bc1' + 'b'.repeat(30));
  const order = store.get().orders.find((o) => String(o.userId) === String(client));
  assert.ok(order);

  // 1) WIDGETS не задан — виджет не пробуем вообще.
  delete process.env.WIDGETS;
  let widgetSends = 0;
  widget.__setFetch(async () => { widgetSends += 1; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; });
  calls = [];
  await click(client, `c:order:${order.id}`);
  assert.equal(widgetSends, 0, 'виджеты по умолчанию выключены');
  assert.ok(calls.some((c) => (c.method === 'editMessageText' || c.method === 'sendMessage') && String(c.text).includes(`#${order.id}`)));

  // 2) WIDGETS=1, Telegram отвечает INPUT_MEDIA_WIDGET_NOT_ALLOWED — откат на обычную карточку.
  process.env.WIDGETS = '1';
  widget.__setFetch(async () => ({ ok: true, json: async () => ({ ok: false, error_code: 403, description: 'Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED' }) }));
  calls = [];
  await click(client, `c:order:${order.id}`);
  assert.ok(calls.some((c) => (c.method === 'editMessageText' || c.method === 'sendMessage') && String(c.text).includes(`#${order.id}`)), 'откат на обычное сообщение');

  // 3) WIDGETS=1, виджет принят — текстовая карточка не отправляется.
  const sentPayloads = [];
  widget.__setFetch(async (url, opts) => {
    sentPayloads.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 777 } }) };
  });
  calls = [];
  await click(client, `c:order:${order.id}`);
  assert.equal(sentPayloads.length, 1);
  assert.ok(String(sentPayloads[0].url).includes('sendWidget'));
  assert.equal(sentPayloads[0].body.allow_queries, true, 'иначе тапы не дойдут до бота');
  assert.ok(String(sentPayloads[0].body.html).includes('PRICELEX'));
  assert.ok(Buffer.byteLength(sentPayloads[0].body.html, 'utf8') <= 32768);
  assert.ok(Buffer.byteLength(sentPayloads[0].body.chat_data, 'utf8') <= 1024);
  assert.ok(!calls.some((c) => (c.method === 'editMessageText' || c.method === 'sendMessage') && String(c.text).includes(`Заявка #${order.id}`)));
  delete process.env.WIDGETS;
});

test('widget_query is answered and message state refreshed via editMessageWidgetData', async () => {
  const client = 1004;
  await text(client, '/start');
  await click(client, 'c:exchange');
  await click(client, 'c:buy:GOOGLE_USD');
  await click(client, 'c:giftnom');
  await click(client, 'c:units:10');
  await text(client, 'bc1' + 'c'.repeat(30));
  const order = store.get().orders.find((o) => String(o.userId) === String(client));
  assert.ok(order);
  // «Я оплатил» в виджете работает для заявки с кодом (совместимость со старыми клиентами):
  // в двухфазной схеме без кода кнопка оплаты не показывается и тап отклоняется.
  store.updateOrder(order.id, { giftCode: 'WQ-CODE-0003' });

  const widgetCalls = [];
  widget.__setFetch(async (url, opts) => {
    widgetCalls.push({ url, body: JSON.parse(opts.body) });
    if (String(url).includes('answerWidgetQuery')) return { ok: true, json: async () => ({ ok: true, result: true }) };
    if (String(url).includes('editMessageWidgetData')) return { ok: true, json: async () => ({ ok: true, result: true }) };
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  });

  await bot.handleUpdate({ update_id: ++seq, widget_query: {
    id: 'wq-1', type: { type: 'data' }, data: `ref:${order.id}`,
    from: { id: client, first_name: 'Client', is_bot: false },
    chat: { id: client, type: 'private' }, message_id: 777, chat_instance: 'test',
  } });

  assert.ok(widgetCalls.some((c) => String(c.url).includes('answerWidgetQuery') && c.body.widget_query_id === 'wq-1'));
  const edit = widgetCalls.find((c) => String(c.url).includes('editMessageWidgetData'));
  assert.ok(edit, 'состояние кнопки/текста обновлено в сообщении');
  assert.equal(edit.body.chat_id, client);
  assert.equal(edit.body.message_id, 777);
  assert.ok(String(edit.body.chat_data).includes(`"id":${order.id}`));
  // «Я оплатил» прямо из виджета переводит заявку в paid.
  await bot.handleUpdate({ update_id: ++seq + 1000, widget_query: {
    id: 'wq-2', type: { type: 'data' }, data: `paid:${order.id}`,
    from: { id: client, first_name: 'Client', is_bot: false },
    chat: { id: client, type: 'private' }, message_id: 777, chat_instance: 'test',
  } });
  assert.equal(store.getOrder(order.id).status, 'paid');
  delete process.env.WIDGETS;
});

test('widget «paid» is rejected for someone else’s order', async () => {
  const owner = 1005;
  const stranger = 1006;
  await text(owner, '/start');
  await click(owner, 'c:exchange');
  await click(owner, 'c:buy:GOOGLE_USD');
  await click(owner, 'c:giftnom');
  await click(owner, 'c:units:10');
  await text(owner, 'bc1' + 'd'.repeat(30));
  const order = store.get().orders.find((o) => String(o.userId) === String(owner));

  const res = await (async () => {
    // Напрямую через обработчик виджета: чужой userId → not_found.
    const clientbot = require('../src/clientbot');
    return clientbot.clientPaidWidget({ from: { id: stranger, first_name: 'Mallory' } }, order.id);
  })();
  assert.deepEqual(res, { ok: 0, error: 'not_found' });
  assert.equal(store.getOrder(order.id).status, 'new');
});
