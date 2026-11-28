const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-deal-chat-'));
process.env.DATA_DIR = dir;
process.env.ALLOW_DEMO_AUTH = '1'; // демо-личность для тестов вместо cookie-сессии
delete process.env.BOT_TOKEN;
process.env.ADMIN_ID = '900001'; // оператор демо-панели — только реальный администратор
process.env.ADMIN_IDS = '';
const store = require('../src/store');
const { createApp } = require('../src/web');
const files = require('../src/attachments');
const { esc, fmtDate, fmtSize } = require('../src/util');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aVkAAAAASUVORK5CYII=';
const upload = { name: 'Снимок карты.png', data: png };
const owner = '900002', stranger = '900003', operator = '900001';
// Без параметра demo запрос идёт как анонимный клиент (свой профиль, без доступа к чужой заявке).
const CLIENT_DEMO = { id: '900002' };
let server, url, order, other;

// createApp() уже смонтировал middleware — потеря одного запроса здесь.
const request = (endpoint, who, body) => fetch(url + endpoint + `?demo[id]=${who || CLIENT_DEMO.id}`,
  body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  order = store.createOrder({ userId: owner, currency: 'GOOGLE_USD' });
  other = store.createOrder({ userId: stranger, currency: 'ITUNES_USD' });
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { force: true, recursive: true });
});

test('файл без подписи, обычный текст и ответ оператора с PDF живут в одном диалоге', async () => {
  const thread = `/api/order/${order.id}/messages`;
  const post = await request(thread, owner, { attachment: upload, from: 'admin' });
  assert.equal(post.status, 200);
  const { message } = await post.json();
  assert.equal(message.from, 'user');
  assert.equal(message.text, '');
  assert.deepEqual(message.attachment, { name: upload.name, size: Buffer.from(png, 'base64').length, type: 'image/png' });
  const saved = store.getOrderMessages(order.id)[0].attachment;
  assert.deepEqual(fs.readFileSync(files.filePath(saved)), Buffer.from(png, 'base64'));
  assert.ok(!JSON.stringify(store.get()).includes(png), 'файл не раздувает JSON-базу');

  assert.equal((await request(thread, owner, { text: 'Получили?' })).status, 200);
  const pdf = Buffer.from('%PDF-1.4\n%%EOF');
  assert.equal((await request(`/api/admin/order/${order.id}/messages`, operator, {
    text: 'Да, вот документ', attachment: { name: 'Ответ.pdf', data: pdf.toString('base64') },
  })).status, 200);
  const { messages } = await (await request(thread, owner)).json();
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], message);
  assert.equal(messages[1].attachment, undefined);
  assert.equal(messages[2].from, 'admin');
  assert.equal(messages[2].text, 'Да, вот документ');
  for (const who of [owner, operator]) {
    const res = await request(`${thread}/${messages[2].id}/attachment`, who);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^attachment;/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), pdf);
  }
  assert.equal(order.status, 'new');
  assert.equal(order.giftCode, null);
  assert.equal(order.receipt, null);
  assert.deepEqual(store.getSupportMessages(owner), []);
});

test('вложения проверяют доступ и принадлежность сообщения именно этой заявке', async () => {
  const thread = `/api/order/${order.id}/messages`;
  const { message } = await (await request(thread, owner, { attachment: upload })).json();
  // Без demo-параметра сервер выдаёт анонимную cookie: чужое вложение всё равно недоступно.
  assert.equal((await fetch(`${url}${thread}/${message.id}/attachment`)).status, 401);
  assert.equal((await request(`${thread}/${message.id}/attachment`, stranger)).status, 404);
  assert.equal((await request(`/api/order/${other.id}/messages/${message.id}/attachment`, stranger)).status, 404);
  assert.equal((await request(thread, stranger)).status, 404);
  assert.equal((await request(thread, stranger, { attachment: upload })).status, 404);
  assert.equal((await request(`/api/admin/order/${order.id}/messages`, owner, { attachment: upload })).status, 403);
});

test('пустые, неподдерживаемые и слишком большие вложения не сохраняются', async () => {
  const count = store.getOrderMessages(order.id).length;
  for (const [body, status] of [
    [{ text: '  ' }, 400],
    [{ attachment: { name: 'фото.png', data: 'not base64' } }, 400],
    [{ attachment: { name: 'фото.png', data: Buffer.from('не изображение').toString('base64') } }, 400],
    [{ attachment: upload, text: 'я'.repeat(2001) }, 400],
    [{ attachment: { name: 'big.pdf', data: Buffer.alloc(files.MAX_BYTES + 1).toString('base64') } }, 413],
  ]) assert.equal((await request(`/api/order/${order.id}/messages`, owner, body)).status, status);
  assert.equal(store.getOrderMessages(order.id).length, count);
});

test('форма диалога отправляет выбранный файл без текста и не переносит черновик между сделками', async () => {
  const dom = new JSDOM('<section id="thread"></section>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(__dirname, '../public/order-chat.js'), 'utf8'));
  const root = w.document.querySelector('#thread');
  const calls = [], messages = [];
  const api = async (path, opts) => {
    if (!opts) return { messages: path.includes('/42/') ? [...messages] : [] };
    calls.push([path, opts.body]);
    messages.push({ id: 17, text: '', from: 'user', at: Date.now(), attachment: { name: 'Снимок.png', size: 2 } });
    return { message: messages[0] };
  };
  const chat = w.createOrderChat({ api, esc, fmtSize, fmtDate, readAsBase64: async () => png, icons: { send: '→' } });
  chat.show(root, 42, false);
  const picker = root.querySelector('input[type=file]'), send = root.querySelector('[type=submit]');
  assert.ok(send.disabled);
  assert.equal(root.querySelector('[data-operator]'), null);
  const file = new w.File(['test'], 'Снимок.png', { type: 'image/png' });
  Object.defineProperty(picker, 'files', { get: () => [file] });
  picker.dispatchEvent(new w.Event('change'));
  assert.match(root.querySelector('.deal-picked').textContent, /Снимок.png/);
  assert.equal(send.disabled, false);
  await root.querySelector('form').onsubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/api/order/42/messages', { text: '', attachment: { name: file.name, data: png } }]]);
  assert.match(root.querySelector('[data-message="17"]').textContent, /Снимок.png/);
  root.querySelector('textarea').value = 'черновик';
  chat.show(root, 42, false);
  assert.equal(root.querySelector('textarea').value, 'черновик');
  chat.show(root, 43, false);
  assert.equal(root.querySelector('textarea').value, '');
  assert.equal(root.querySelector('input[type=file]').files.length, 0);
  assert.equal(root.querySelector('[data-message="17"]'), null);
  dom.window.close();
});
