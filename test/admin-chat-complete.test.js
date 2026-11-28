// Оператор завершает сделку прямо в диалоге: подтверждает проверку карты и выдаёт
// валюту, не выходя из переписки. Клиент получает уведомление о выплате.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-admin-complete-'));
process.env.DATA_DIR = dir;
process.env.ALLOW_DEMO_AUTH = '1';
process.env.BOT_TOKEN = '123456:test-token';
process.env.ADMIN_ID = '111';
process.env.ADMIN_IDS = '';
delete process.env.WIDGETS;

const store = require('../src/store');
const { createBot } = require('../src/bot');
const botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'plx_test_bot' };
const bot = createBot({ botInfo });

let seq = 2000;
let calls = [];
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, ...payload });
  if (method === 'answerCallbackQuery') return { ok: true, result: true };
  return {
    ok: true,
    result: {
      message_id: ++seq, date: 1,
      chat: { id: Number(payload.chat_id) || 0, type: 'private' },
      text: payload.text || '',
    },
  };
});

const text = (id, value) => bot.handleUpdate({
  update_id: ++seq,
  message: {
    message_id: ++seq, date: 1, chat: { id, type: 'private' },
    from: { id, first_name: id === 111 ? 'Admin' : 'Client', is_bot: false }, text: value,
    ...(value.match(/^\/\S+/) ? { entities: [{ type: 'bot_command', offset: 0, length: value.match(/^\/\S+/)[0].length }] } : {}),
  },
});
const click = (id, data) => bot.handleUpdate({
  update_id: ++seq,
  callback_query: {
    id: String(++seq), chat_instance: 'test', data,
    from: { id, first_name: id === 111 ? 'Admin' : 'Client', is_bot: false },
    message: { message_id: 42, date: 1, chat: { id, type: 'private' }, from: botInfo, text: 'Order' },
  },
});
const lastCall = (method) => [...calls].reverse().find((c) => c.method === method);
const markupCallbacks = (call) => (call?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);
const callbacksOf = (list) => (list?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);

beforeEach(() => { calls = []; });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function paidOrder(userId = '880') {
  store.touchUser({ id: userId, first_name: 'Client' }, '');
  const order = store.createOrder({
    userId, currency: 'GOOGLE_USD', units: 100, rate: 1, crypto: 99.5, grossCrypto: 100,
    networkFee: 0.5, network: 'TRC20', payoutId: 'USDT_TRC20', payoutCurrency: 'USDT',
    wallet: 'T' + '9aBcDeFgHiJkLmNoPqRsTuVwXyZ123456',
    giftCode: 'AAAA-BBBB-CCCC-DDDD',
  });
  store.updateOrder(order.id, { status: 'paid', paidAt: Date.now() });
  return store.getOrder(order.id);
}

test('в диалоге сделки оператор видит кнопку выдачи валюты', async () => {
  const order = paidOrder('881');
  await click(111, `o:${order.id}:chat`);
  const chat = lastCall('sendMessage') || lastCall('editMessageText');
  assert.ok(chat, 'диалог открыт');
  const cb = markupCallbacks(chat);
  assert.ok(cb.includes(`o:${order.id}:confirm`), 'кнопка «выдать» есть прямо в диалоге');
  assert.ok(cb.includes(`o:${order.id}:unpaid`), 'кнопка «карта недействительна» есть');
  assert.match(String(chat.text), /Проверено — выдать/);
});

test('завершение из диалога: подтверждение суммы, выплата и уведомление клиенту', async () => {
  const order = paidOrder('882');
  calls = [];
  await click(111, `o:${order.id}:confirm`);

  // 1) Сначала — подтверждение суммы и адреса, без изменения статуса.
  const prompt = lastCall('sendMessage');
  assert.ok(prompt, 'бот спрашивает подтверждение');
  assert.match(String(prompt.text), /выдать 99\.5 USDT/i);
  assert.match(String(prompt.text), /Кошелёк/);
  assert.equal(store.getOrder(order.id).status, 'paid', 'статус не меняется до подтверждения');
  assert.ok(markupCallbacks(prompt).includes(`o:${order.id}:paid_yes`));

  // 2) Подтверждение — сделка завершена.
  calls = [];
  await click(111, `o:${order.id}:paid_yes`);
  assert.equal(store.getOrder(order.id).status, 'completed', 'сделка завершена');
  const done = lastCall('sendMessage');
  assert.match(String(done.text), /валюта выдана/i);
  assert.match(String(done.text), /99\.5 USDT/);
  // Ссылка на блокчейн предлагается сразу
  assert.ok(markupCallbacks(done).includes(`o:${order.id}:tx`));
  assert.ok(markupCallbacks(done).includes(`o:${order.id}:chat`), 'можно вернуться в диалог сделки');

  // 3) Клиент в Telegram получил уведомление о выплате на свой кошелёк.
  const clientMsg = calls.find((c) => c.method === 'sendMessage' && String(c.chat_id) === '882');
  assert.ok(clientMsg, 'клиенту отправлено сообщение');
  assert.match(String(clientMsg.text), /Заявка #\d+ завершена/);
  assert.match(String(clientMsg.text), /Выплата .*99\.5 USDT/);
  assert.match(String(clientMsg.text), /T9aBcDeFgHiJkLmNoPqRsTuVwXyZ123456/);
});

test('повторная выдача невозможна: статус completed уже стоит', async () => {
  const order = paidOrder('883');
  await click(111, `o:${order.id}:confirm`);
  await click(111, `o:${order.id}:paid_yes`);
  const versionAfter = store.getOrder(order.id).version;

  calls = [];
  await click(111, `o:${order.id}:paid_yes`);
  assert.equal(store.getOrder(order.id).status, 'completed');
  assert.equal(store.getOrder(order.id).version, versionAfter, 'повторная выдача не меняет заявку');
  const msg = lastCall('sendMessage') || lastCall('editMessageText');
  assert.match(String(msg.text), /уже завершена/i);
});

test('завершить можно только оплаченную заявку', async () => {
  store.touchUser({ id: '884', first_name: 'Client' }, '');
  const pending = store.createOrder({ userId: '884', currency: 'GOOGLE_USD', units: 20, rate: 1, crypto: 20, wallet: '0x' + 'a'.repeat(40) });
  calls = [];
  await click(111, `o:${pending.id}:confirm`);
  assert.equal(store.getOrder(pending.id).status, 'new', 'новая заявка не завершается');
  const msg = lastCall('sendMessage');
  assert.match(String(msg.text), /нельзя завершить/i);
  assert.match(String(msg.text), /Я оплатил/);
});

test('в диалоге есть действия и для остальных статусов', async () => {
  store.touchUser({ id: '885', first_name: 'Client' }, '');
  const fresh = store.createOrder({ userId: '885', currency: 'ITUNES_USD', units: 10, rate: 1, crypto: 10, wallet: '0x' + 'b'.repeat(40) });
  await click(111, `o:${fresh.id}:chat`);
  let cb = callbacksOf(lastCall('sendMessage'));
  assert.ok(cb.includes(`o:${fresh.id}:connect`), 'новая заявка: подключить');
  assert.ok(cb.includes(`o:${fresh.id}:reject`), 'новая заявка: отклонить');

  store.updateOrder(fresh.id, { status: 'details' });
  calls = [];
  await click(111, `o:${fresh.id}:chat`);
  cb = callbacksOf(lastCall('sendMessage'));
  assert.ok(cb.includes(`o:${fresh.id}:reject`), 'ожидание кода: отклонить');
  assert.ok(!cb.includes(`o:${fresh.id}:confirm`), 'пока карта не оплачена — выдавать нечего');
});
