// Отзывы в боте оператора: меню ⭐ Отзывы, добавление (оценка → имя → текст) и удаление.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-bot-reviews-'));
process.env.DATA_DIR = dir;
process.env.BOT_TOKEN = '123456:test-token';
process.env.ADMIN_ID = '111';
process.env.ADMIN_IDS = '';

const store = require('../src/store');
const { createBot } = require('../src/bot');
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

const text = (id, value) => bot.handleUpdate({ update_id: ++seq, message: {
  message_id: ++seq, date: 1, chat: { id, type: 'private' },
  from: { id, first_name: 'Оператор', is_bot: false }, text: value,
  ...(value.match(/^\/\S+/) ? { entities: [{ type: 'bot_command', offset: 0, length: value.match(/^\/\S+/)[0].length }] } : {}),
} });
const click = (id, data) => bot.handleUpdate({ update_id: ++seq, callback_query: {
  id: String(++seq), chat_instance: 'test', from: { id, first_name: 'Оператор', is_bot: false }, data,
  message: { message_id: 42, date: 1, chat: { id, type: 'private' }, from: botInfo, text: 'Reviews' },
} });
const markupCallbacks = (call) => (call?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);
const lastCall = (method) => [...calls].reverse().find((c) => c.method === method);

beforeEach(() => { calls = []; });
after(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('меню оператора ведёт на вкладку отзывов', async () => {
  await text(111, '/start');
  assert.ok(markupCallbacks(lastCall('sendMessage')).includes('m:reviews'));
  await click(111, 'm:reviews');
  const view = lastCall('editMessageText');
  assert.ok(String(view.text).includes('Отзывы'));
  const cb = markupCallbacks(view);
  assert.ok(cb.includes('rv:add'));
});

test('оператор добавляет отзыв: оценка → имя → текст', async () => {
  await click(111, 'm:reviews');
  await click(111, 'rv:add');
  const ratingKb = markupCallbacks(lastCall('editMessageText'));
  assert.ok(ratingKb.includes('rv:rate:5'));

  await click(111, 'rv:rate:5');
  assert.match(String(lastCall('sendMessage').text), /имя клиента/i);

  await text(111, 'Алексей');
  assert.match(String(lastCall('sendMessage').text), /текст отзыва/i);

  await text(111, 'Обменял карту $50 — BTC пришли за 10 минут.');
  const review = store.listReviews(10).find((r) => r.name === 'Алексей');
  assert.ok(review, 'отзыв сохранён');
  assert.equal(review.rating, 5);
  assert.equal(review.source, 'admin');
  assert.ok(calls.some((c) => String(c.text).includes('Отзыв опубликован')), 'оператор получает подтверждение');
});

test('отзыв виден на витрине и удаляется оператором', async () => {
  const review = store.listReviews(10)[0];
  assert.ok(review);
  assert.equal(store.reviewStats().count, 1);

  await click(111, 'm:reviews');
  await click(111, `rv:del:${review.id}`);
  assert.ok(String(lastCall('editMessageText').text).includes('Удалить отзыв'));
  await click(111, `rv:delok:${review.id}`);
  assert.equal(store.listReviews(10).length, 0);
  assert.equal(store.reviewStats().count, 0);
});

test('слишком короткий текст отзыва не принимается', async () => {
  await click(111, 'm:reviews');
  await click(111, 'rv:add');
  await click(111, 'rv:rate:4');
  await text(111, 'Мария');
  await text(111, 'ок');
  assert.match(String(lastCall('sendMessage').text), /от 5 до 600/);
  assert.equal(store.listReviews(10).length, 0);
});
