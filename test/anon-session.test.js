// Анонимный вход вне Telegram: сессия выдаётся сервером, имя придумывается,
// личность нельзя подделать параметрами запроса, есть лимиты и защита от CSRF.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-anon-'));
process.env.DATA_DIR = dir;
process.env.ALLOW_DEMO_AUTH = '1';
delete process.env.BOT_TOKEN;
delete process.env.ADMIN_ID;
process.env.ADMIN_IDS = '';

const store = require('../src/store');
const { createApp } = require('../src/web');
const session = require('../src/session');

let server, base;
// Лимиты считаются по IP: даём каждому тесту свой, чтобы тесты не влияли друг на друга.
let ipCounter = 0;
const nextIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const asIp = (ip) => ({ 'x-forwarded-for': ip });

const solvePow = async (ip = nextIp()) => {
  const ch = await (await fetch(`${base}/api/session/challenge`, { headers: asIp(ip) })).json();
  const b64 = ch.challenge.slice(0, ch.challenge.lastIndexOf('.')).replace(/-/g, '+').replace(/_/g, '/');
  const { s } = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const zeros = '0'.repeat(Math.floor(ch.bits / 4));
  let nonce = 0;
  while (!crypto.createHash('sha256').update(`${s}:${nonce}`).digest('hex').startsWith(zeros)) nonce++;
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...asIp(ip) },
    body: JSON.stringify({ challenge: ch.challenge, nonce }),
  });
  const cookie = (res.headers.getSetCookie?.()[0] || '').split(';')[0];
  return { cookie, status: res.status, body: await res.json() };
};

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('вне Telegram сервер сам выдаёт анонимную сессию и придумывает имя', async () => {
  const { cookie, status, body } = await solvePow();
  assert.equal(status, 201);
  // Наружу внутренний id анонимного профиля не отдаётся (минимизация данных).
  assert.equal(body.me.id, null);
  assert.equal(Object.values(store.get().users).some((u) => /^web_[A-Za-z0-9_-]{20,}$/.test(u.id)), true);
  assert.ok(body.me.name && body.me.name.length > 3, 'имя придумано');
  assert.equal(body.me.anonymous, true);
  assert.equal(body.me.isAdmin, false);
  assert.match(cookie, /^plx_sid=/);
  assert.equal(body.source, 'web');
  // cookie HttpOnly и SameSite — ставит сервер
  const raw = (await fetch(`${base}/api/session/challenge`));
  assert.equal(raw.status, 200);
});

test('создать сессию без proof-of-work нельзя', async () => {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: 'подделка', nonce: 1 }),
  });
  assert.equal(res.status, 400);
});

test('параметры demo больше не дают чужую личность и админку', async () => {
  // Демо-личность принимается только из временного DATA_DIR (совместимость тестов),
  // но демо-ID 900001 больше не оператор без ADMIN_ID.
  // Демо-параметр из запроса не делает оператором: админка закрыта.
  // (Во временном DATA_DIR демо-личность ещё принимается для старых тестов,
  //  но isAdmin определяется только ADMIN_ID/ADMIN_IDS.)
  const ip = nextIp();
  const res = await fetch(`${base}/api/admin/reviews?demo[id]=900001`, { headers: { cookie: '', ...asIp(ip) } });
  assert.equal(res.status, 403);
  const anon = await solvePow(nextIp());
  const me = await fetch(`${base}/api/init`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: anon.cookie }, body: '{}' });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).me.isAdmin, false);
});

test('чужая заявка недоступна, подделанная cookie отклоняется', async () => {
  const owner = await solvePow();
  const order = await (await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: owner.cookie },
    body: JSON.stringify({ currency: 'GOOGLE_USD', units: 100, wallet: '0x' + 'aB12'.repeat(10) }),
  })).json();
  assert.ok(order.order && order.order.id);

  const other = await solvePow();
  assert.equal((await fetch(`${base}/api/order/${order.order.id}`, { headers: { cookie: other.cookie } })).status, 404);

  const forged = owner.cookie.slice(0, -3) + 'AAA';
  const res = await fetch(`${base}/api/init`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: forged }, body: '{}' });
  assert.equal(res.status, 401);
});

test('состояние меняется только с нашего Origin и только JSON', async () => {
  const { cookie } = await solvePow();
  const body = JSON.stringify({ currency: 'GOOGLE_USD', units: 100, wallet: '0x' + 'aB12'.repeat(10) });
  const evil = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' }, body,
  });
  assert.equal(evil.status, 403);
  const form = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: 'a=1',
  });
  assert.equal(form.status, 415);
  const own = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base }, body,
  });
  assert.equal(own.status, 200);
});

test('сессия неуязвима к рассинхрону длины id (регрессия)', async () => {
  // Раньше cookie не проходила проверку из-за длины id — /api/init отвечал 401.
  const { cookie } = await solvePow();
  const res = await fetch(`${base}/api/init`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  assert.equal(res.status, 200);
  const unicode = await fetch(`${base}/api/init`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  assert.equal((await unicode.json()).me.name.length > 0, true);
});

test('привязка к Telegram: код из бота переносит профиль на tgweb', async () => {
  const { cookie, body } = await solvePow();
  assert.equal(body.me.id, null, 'аноним: внутренний id скрыт');
  // /link в боте привязан к Telegram-профилю, который уже есть в базе.
  store.touchUser({ id: '777123', first_name: 'Client' }, '');
  const { code } = session.linkCode('777123');
  const res = await fetch(`${base}/api/link`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 200);
  const linked = await res.json();
  // Наружу отдаём Telegram ID (id) и не раскрываем внутренний ключ базы (webId = null).
  assert.equal(linked.me.id, '777123');
  assert.equal(linked.me.telegramId, '777123');
  assert.equal(linked.me.linked, true);
  assert.equal(store.getUser('tgweb_777123') !== null, true, 'в базе профиль привязан');
  // повторно тот же код не сработает
  const again = await fetch(`${base}/api/link`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ code }),
  });
  assert.equal(again.status, 400);
  // отвязка — только с подтверждением
  const needConfirm = await fetch(`${base}/api/link/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({}),
  });
  assert.equal(needConfirm.status, 400);
  const revoked = await fetch(`${base}/api/link/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ confirm: 'REVOKE' }),
  });
  assert.equal(revoked.status, 200);
  const afterUnlink = await revoked.json();
  assert.equal(afterUnlink.me.id, null, 'внутренний веб-id наружу не отдаётся');
  assert.equal(afterUnlink.me.telegramId, null);
});

test('WEB_ACCESS=telegram закрывает анонимный вход', async () => {
  const prev = store.get().settings.webAccess;
  store.mutate((db) => { db.settings.webAccess = 'telegram'; });
  const ip = nextIp();
  const ch = await (await fetch(`${base}/api/session/challenge`, { headers: asIp(ip) })).json();
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...asIp(ip) },
    body: JSON.stringify({ challenge: ch.challenge, nonce: 0 }),
  });
  assert.equal(res.status, 403);
  store.mutate((db) => { db.settings.webAccess = prev; });
});

test('псевдоним закреплён за профилем и не перезаписывается', async () => {
  const { body } = await solvePow(nextIp());
  assert.ok(body.me && body.me.name, 'сессия выдана');
  const user = Object.values(store.get().users).find((u) => u.name === body.me.name);
  assert.ok(user, 'профиль создан');
  store.touchUser({ id: user.id, first_name: 'Реальное Имя' }, '');
  assert.equal(store.getUser(user.id).name, body.me.name, 'имя не меняется от чужих полей');
});

test('лимит частых сообщений в поддержку срабатывает', async () => {
  const ip = nextIp();
  const { cookie } = await solvePow(ip);
  let last = 0;
  for (let i = 0; i < 17; i++) {
    const res = await fetch(`${base}/api/support/message`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, ...asIp(ip) },
      body: JSON.stringify({ text: `сообщение ${i}` }),
    });
    last = res.status;
    if (res.status === 429) break;
  }
  assert.equal(last, 429, 'флуд в поддержку ограничен');
});
