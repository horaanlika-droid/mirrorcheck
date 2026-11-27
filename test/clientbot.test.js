// Client-bot flow: /start → menu, exchange and gift card right in chat, "I paid",
// widgets behind the WIDGETS=1 flag with fallback to a plain message.
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
const currencies = require('../src/currencies');
const { createBot } = require('../src/bot');
const widget = require('../src/widget');
const botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'pricelex_test_bot' };
const bot = createBot({ botInfo });

let seq = 1000;
let calls = [];
const API_SEQ = { n: 9000 };
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, ...payload });
  if (method === 'getFile') return { ok: true, result: { file_path: `files/${payload.file_id}` } };
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
  // Restore the "live" environment just in case.
  delete process.env.WIDGETS;
  widget.__setFetch(globalThis.fetch);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-admin /start opens the client menu with c: callbacks', async () => {
  await text(999, '/start');
  const send = lastCall('sendMessage');
  assert.ok(send, 'bot replies with a message');
  assert.ok(String(send.text).includes('Pricelex Worldwide'));
  const cb = markupCallbacks(send);
  assert.ok(cb.includes('c:exchange') && cb.includes('c:orders') && cb.includes('c:support'));
  assert.ok(store.getUser(999), 'user added to the store');
});

test('admin /start still opens the operator console, not the client menu', async () => {
  await text(111, '/start');
  const send = lastCall('sendMessage');
  assert.ok(String(send.text).includes('пульт оператор')); // operator bot stays Russian
  const cb = markupCallbacks(send);
  assert.ok(cb.includes('m:orders') && !cb.some((d) => d.startsWith('c:')));
});

test('операторский бот: отдельная настройка скидки для каждой карты', async () => {
  await text(111, '/start');
  await click(111, 'm:settings');
  const screen = lastCall('editMessageText') || lastCall('sendMessage');
  const cb = markupCallbacks(screen);
  for (const key of currencies.GIFT_KEYS) {
    assert.ok(cb.includes(`s:fee_${key}`), `кнопка скидки для ${key}`);
  }
  assert.ok(String(screen.text).includes('Курс каждой карты — отдельный'));
});

test('клиентский бот показывает четыре разных курса — у каждой карты свой', async () => {
  const client = 1012;
  const original = JSON.parse(JSON.stringify(store.get().settings));
  try {
    store.mutate((db) => {
      db.settings.usdtUsd = 1.0002;
      db.settings.cardFees = { GOOGLE_USD: 0, ITUNES_USD: 10, XBOX_USD: 20, APPLE_STORE_USD: 30 };
      db.settings.cardRates = currencies.allCardRates(db.settings);
    });
    await text(client, '/start');
    await click(client, 'c:exchange');
    const screen = lastCall('editMessageText') || lastCall('sendMessage');
    const rates = [...String(screen.text).matchAll(/1 \$ = ([0-9.]+)/g)].map((m) => m[1]);
    assert.equal(rates.length, 4, 'в списке четыре строки с курсом');
    assert.equal(new Set(rates).size, 4, 'все курсы разные');
    assert.ok(String(screen.text).includes('Какую карту сдаёте?'));
    assert.ok(!/у каждой карты свой/i.test(String(screen.text)), 'не акцентируем различия курсов для клиента');
  } finally {
    store.mutate((db) => { db.settings = original; });
  }
});

test('group chats are ignored for client flow', async () => {
  await text(555, '/start', 'group');
  assert.equal(calls.length, 0);
});

test('info, referrals and support screens render; support message reaches the operator', async () => {
  const client = 1011;
  await text(client, '/start');
  await click(client, 'c:info');
  assert.ok(String((lastCall('editMessageText') || {}).text).includes('Pricelex Worldwide'));
  await click(client, 'c:refs');
  assert.ok(String((lastCall('editMessageText') || {}).text).includes('Реферальная'));
  calls = [];
  await click(client, 'c:support');
  await text(client, 'Где моя заявка?');
  const support = store.get().support.find((m) => String(m.userId) === String(client));
  assert.ok(support && support.text === 'Где моя заявка?');
  assert.ok(calls.some((c) => c.method === 'sendMessage' && String(c.chat_id) === '111' && String(c.text).includes('поддержки'))); // operator bot stays Russian
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
  assert.ok(String(screen.text).includes('Правила передачи карты'), 'сначала открываются правила');
  assert.ok(String(screen.text).includes('Минимальный цифровой след'), 'в карточке упомянут цифровой след');
  assert.ok(String(screen.text).includes('Ничего не отправляйте'));
  assert.doesNotMatch(String(screen.text), /commission|fee|комисси/i, 'клиент не видит скидку');

  // Rules → amount. The code is NOT asked at order creation.
  await click(client, 'c:giftnom:GOOGLE_USD');
  screen = lastCall('editMessageText');
  assert.ok(markupCallbacks(screen).includes('c:units:GOOGLE_USD:10'));
  assert.doesNotMatch(String(screen.text), /commission|fee|комисси/i, 'в курсе не раскрывается скидка');
  await click(client, 'c:units:GOOGLE_USD:10');
  const askWallet = lastCall('editMessageText');
  assert.match(String(askWallet.text), /кошел/i, 'после номинала спрашивают только кошелёк');
  assert.ok(!/код|code/i.test(String(askWallet.text)), 'до создания заявки код не спрашивают');
  assert.match(askWallet.text, /BNB Smart Chain \(BEP-20\)/);
  await text(client, 'bc1' + 'a'.repeat(30));
  assert.ok(!store.get().orders.some((o) => String(o.userId) === String(client)));
  assert.match(lastCall('sendMessage').text, /0x/);
  await text(client, '0x' + 'a'.repeat(40));
  const created = store.get().orders.find((o) => String(o.userId) === String(client));
  assert.ok(created, 'order created');
  assert.equal(created.direction, 'sell');
  assert.equal(created.units, 10);
  assert.equal(created.currency, 'GOOGLE_USD');
  assert.equal(created.payoutCurrency, 'USDT');
  assert.equal(created.crypto, Math.floor(10 * created.rate * 1e6 + 1e-6) / 1e6, 'выплата считается по курсу этой карты');
  assert.equal(created.network, 'BEP20');
  assert.equal(created.giftCode ?? null, null, 'order has no code — the code comes only after the operator joins');
  assert.equal(created.status, 'new');

  // The code cannot be sent before the operator joins.
  await click(client, `c:sendcode:${created.id}`);
  assert.match(String(lastCall('editMessageText').text), /подключения оператора/i);
  assert.equal(store.getOrder(created.id).status, 'new');
  assert.equal(store.getOrder(created.id).giftCode ?? null, null);

  // The operator joins (in production — the "🤝 Connect" button in the operator bot).
  store.updateOrder(created.id, { status: 'details' });
  await click(client, `c:sendcode:${created.id}`);
  assert.match(String(lastCall('editMessageText').text), /Оператор в заявке/);
  await text(client, 'XXXX-YYYY-ZZZZ-0001');
  assert.equal(store.getOrder(created.id).status, 'paid');
  assert.equal(store.getOrder(created.id).giftCode, 'XXXX-YYYY-ZZZZ-0001');
  // The operator was notified with the code.
  assert.ok(calls.some((c) => c.method === 'sendMessage' && String(c.chat_id) === '111' && String(c.text).includes(`#${created.id}`)));
});

test('iTunes, Xbox and Apple Store each create a USDT (BEP-20) gift order with the selected brand', async () => {
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
    await text(client, '0x' + 'a'.repeat(40));
    const order = store.get().orders.find((o) => String(o.userId) === String(client));
    assert.ok(order, `${label} order created`);
    assert.equal(order.currency, key);
    assert.equal(order.payoutCurrency, 'USDT');
    assert.equal(order.network, 'BEP20');
    assert.equal(order.units, 10);
    assert.equal(order.crypto, Math.floor(10 * order.rate * 1e6 + 1e-6) / 1e6);
    const adminCard = calls.find((c) => c.method === 'sendMessage' && String(c.chat_id) === '111' && String(c.text).includes(`#${order.id}`));
    assert.ok(adminCard && String(adminCard.text).includes(label), `operator sees ${label}`);
  }
});

test('expired gift link and unknown order do not crash the client', async () => {
  await text(1002, '/start');
  await click(1002, 'c:order:999999');
  const screen = lastCall('editMessageText') || lastCall('sendMessage');
  assert.ok(String(screen.text).includes('Заявка не найдена'));
});

test('widget send is attempted when WIDGETS=1 and falls back to text on Telegram error', async () => {
  const client = 1003;
  await text(client, '/start');
  await click(client, 'c:exchange');
  await click(client, 'c:buy:GOOGLE_USD');
  await click(client, 'c:giftnom');
  await click(client, 'c:units:10');
  await text(client, '0x' + 'b'.repeat(40));
  const order = store.get().orders.find((o) => String(o.userId) === String(client));
  assert.ok(order);

  // 1) WIDGETS is not set — the widget is not attempted at all.
  delete process.env.WIDGETS;
  let widgetSends = 0;
  widget.__setFetch(async () => { widgetSends += 1; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; });
  calls = [];
  await click(client, `c:order:${order.id}`);
  assert.equal(widgetSends, 0, 'widgets are off by default');
  assert.ok(calls.some((c) => (c.method === 'editMessageText' || c.method === 'sendMessage') && String(c.text).includes(`#${order.id}`)));

  // 2) WIDGETS=1, Telegram replies INPUT_MEDIA_WIDGET_NOT_ALLOWED — fall back to the plain card.
  process.env.WIDGETS = '1';
  widget.__setFetch(async () => ({ ok: true, json: async () => ({ ok: false, error_code: 403, description: 'Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED' }) }));
  calls = [];
  await click(client, `c:order:${order.id}`);
  assert.ok(calls.some((c) => (c.method === 'editMessageText' || c.method === 'sendMessage') && String(c.text).includes(`#${order.id}`)), 'falls back to a plain message');

  // 3) WIDGETS=1, the widget is accepted — the text card is not sent.
  const sentPayloads = [];
  widget.__setFetch(async (url, opts) => {
    sentPayloads.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 777 } }) };
  });
  calls = [];
  await click(client, `c:order:${order.id}`);
  assert.equal(sentPayloads.length, 1);
  assert.ok(String(sentPayloads[0].url).includes('sendWidget'));
  assert.equal(sentPayloads[0].body.allow_queries, true, 'otherwise taps will not reach the bot');
  assert.ok(String(sentPayloads[0].body.html).includes('Pricelex Worldwide'));
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
  await text(client, '0x' + 'c'.repeat(40));
  const order = store.get().orders.find((o) => String(o.userId) === String(client));
  assert.ok(order);
  // "I paid" in the widget works for an order with a code (compatibility with legacy clients):
  // in the two-phase scheme without a code the pay button is not shown and the tap is rejected.
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
  assert.ok(edit, 'button/text state refreshed in the message');
  assert.equal(edit.body.chat_id, client);
  assert.equal(edit.body.message_id, 777);
  assert.ok(String(edit.body.chat_data).includes(`"id":${order.id}`));
  // "I paid" straight from the widget moves the order to paid.
  await bot.handleUpdate({ update_id: ++seq + 1000, widget_query: {
    id: 'wq-2', type: { type: 'data' }, data: `paid:${order.id}`,
    from: { id: client, first_name: 'Client', is_bot: false },
    chat: { id: client, type: 'private' }, message_id: 777, chat_instance: 'test',
  } });
  assert.equal(store.getOrder(order.id).status, 'paid');
  delete process.env.WIDGETS;
});

test('виджет курсов передаёт четыре отдельных курса — по одному на карту', () => {
  const original = JSON.parse(JSON.stringify(store.get().settings));
  try {
    store.mutate((db) => {
      db.settings.usdtUsd = 1.0002;
      db.settings.cardFees = { GOOGLE_USD: 0, ITUNES_USD: 9, XBOX_USD: 18, APPLE_STORE_USD: 27 };
      db.settings.cardRates = currencies.allCardRates(db.settings);
    });
    const data = widget._ratesChatData();
    assert.equal(data.r.length, 4, 'в виджете четыре строки карт');
    assert.equal(new Set(data.r.map((row) => row[1])).size, 4, 'курсы не равны друг другу');
    assert.deepEqual(data.r.map((row) => row[0]), ['Google', 'iTunes', 'Xbox', 'Apple Store']);
    const html = widget._ratesHtml();
    assert.ok(html.includes('КУРСЫ КАРТ') && html.includes('США · USD'), 'виджет на русском');
    assert.ok(widget._buildWidget(html, data), 'виджет укладывается в лимиты Bot API');
  } finally {
    store.mutate((db) => { db.settings = original; });
  }
});

test('widget «paid» is rejected for someone else’s order', async () => {
  const owner = 1005;
  const stranger = 1006;
  await text(owner, '/start');
  await click(owner, 'c:exchange');
  await click(owner, 'c:buy:GOOGLE_USD');
  await click(owner, 'c:giftnom');
  await click(owner, 'c:units:10');
  await text(owner, '0x' + 'd'.repeat(40));
  const order = store.get().orders.find((o) => String(o.userId) === String(owner));

  const res = await (async () => {
    // Directly through the widget handler: someone else's userId → not_found.
    const clientbot = require('../src/clientbot');
    return clientbot.clientPaidWidget({ from: { id: stranger, first_name: 'Mallory' } }, order.id);
  })();
  assert.deepEqual(res, { ok: 0, error: 'not_found' });
  assert.equal(store.getOrder(order.id).status, 'new');
});

test('клиентский бот: применение промокода увеличивает выплату USDT и отображается оператору', async () => {
  const client = 1099;
  const promo = store.createPromo({ code: 'TG5', percent: 5, maxUses: 1 });
  try {
    await text(client, '/start');
    await click(client, 'c:exchange');
    await click(client, 'c:buy:GOOGLE_USD');
    await click(client, 'c:giftnom:GOOGLE_USD');
    await click(client, 'c:promo:GOOGLE_USD');
    calls = [];
    await text(client, 'tg5');
    const screen = lastCall('sendMessage');
    assert.ok(String(screen.text).includes('TG5') && String(screen.text).includes('+5%'));

    await click(client, 'c:units:GOOGLE_USD:100');
    await text(client, '0x' + 'e'.repeat(40));
    const order = store.get().orders.find((o) => String(o.userId) === String(client));
    assert.ok(order, 'заявка с промокодом создана');
    assert.equal(order.promoCode, 'TG5');
    assert.equal(order.promoPercent, 5);
    assert.ok(order.crypto > order.baseCrypto, 'выплата с промокодом выше базовой');
    assert.equal(store.getPromo(promo.id).usedCount, 1);

    const adminCard = calls.find((c) => c.method === 'sendMessage' && String(c.chat_id) === '111' && String(c.text).includes(`#${order.id}`));
    assert.ok(adminCard && String(adminCard.text).includes('TG5'), 'оператор видит промокод в карточке заявки');

    // Отмена заявки возвращает лимит промокода
    await click(client, `c:cancel:${order.id}`);
    assert.equal(store.getOrder(order.id).status, 'cancelled');
    assert.equal(store.getPromo(promo.id).usedCount, 0);
  } finally {
    store.deletePromo(promo.id);
  }
});


test('диалог в Telegram: клиент и оператор обмениваются фото и файлами в выбранной сделке', async (t) => {
  const client = 1177;
  const order = store.createOrder({ userId: String(client), currency: 'XBOX_USD' });
  const photo = { photo: [{ file_id: 'image', file_size: 4, width: 1, height: 1 }] };
  const document = { document: { file_id: 'paper', file_name: 'Ответ.pdf', file_size: 16 } };
  t.mock.method(globalThis, 'fetch', async (url) => new Response(String(url).endsWith('/paper')
    ? Buffer.from('%PDF-1.4\n%%EOF') : Buffer.from([255, 216, 255, 217])));
  const media = (id, fields) => bot.handleUpdate({ update_id: ++seq, message: {
    message_id: ++seq, date: 1, chat: { id, type: 'private' }, from: { id, first_name: 'Test', is_bot: false }, ...fields,
  } });
  await media(client, photo);
  await click(1178, `c:chat:${order.id}`);
  await media(1178, photo);
  assert.deepEqual(store.getOrderMessages(order.id), [], 'без выбора своей сделки файл не отправляется');
  await click(client, `c:chat:${order.id}`);
  await media(client, photo);
  let messages = store.getOrderMessages(order.id);
  assert.equal(messages[0].attachment.type, 'image/jpeg');
  assert.equal(messages[0].text, '');
  assert.ok(calls.some((c) => c.method === 'sendDocument' && String(c.chat_id) === '111' && markupCallbacks(c).includes(`o:${order.id}:chat`)));
  await click(111, `o:${order.id}:chat`);
  await media(111, { ...document, caption: 'Посмотрите документ' });
  messages = store.getOrderMessages(order.id);
  assert.equal(messages[1].from, 'admin');
  assert.equal(messages[1].text, 'Посмотрите документ');
  assert.equal(messages[1].attachment.name, 'Ответ.pdf');
  assert.ok(calls.some((c) => c.method === 'sendDocument' && Number(c.chat_id) === client && c.caption.includes('Посмотрите документ')));
  await click(client, `c:chat:${order.id}`);
  const fileButton = `c:file:${order.id}:${messages[1].id}`;
  assert.ok(markupCallbacks(lastCall('sendMessage')).includes(fileButton));
  await click(client, fileButton);
  assert.equal(Number(lastCall('sendDocument').chat_id), client);
  assert.equal(lastCall('sendDocument').document.filename, 'Ответ.pdf');
  await click(1178, fileButton);
  assert.match(lastCall('sendMessage').text, /Вложение не найдено/);
  await text(client, 'Спасибо!');
  await text(client, '/cancel');
  await media(client, photo);
  assert.equal(store.getOrderMessages(order.id).length, 3);
  assert.equal(store.getOrder(order.id).status, 'new');
});
