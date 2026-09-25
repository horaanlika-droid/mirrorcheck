const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const settings = {
  online: true, rateBTC: 10000000, rateGRAM: 125, rateUpdatedAt: 1,
  minRub: 3000, maxRub: 300000,
  announcement: 'PRICELEX', refPercent: 1, operator: '@test', channel: 'https://t.me/test', chat: 'https://t.me/test',
};
const initial = {
  id: 1, status: 'new', currency: 'BTC', rub: 5000, crypto: 0.0005,
  wallet: 'bc1' + 'a'.repeat(30), createdAt: 1, updatedAt: 1, requisites: null, payRub: null, receipt: null,
};
const details = { ...initial, status: 'details', requisites: 'СБП: +7 900 000-00-00\nТестовый банк', payRub: 5000, updatedAt: 2, receipt: { name: 'check.pdf', size: 2048, at: 2 } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function app(t, order = initial) {
  const dom = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  let refresh;
  let handler = () => null;
  window.console.warn = () => {};
  window.setInterval = (fn) => { refresh = fn; return 1; };
  const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
  window.fetch = async (url, options) => {
    const pathname = new URL(url, window.location.href).pathname;
    calls.push({ pathname, ...options });
    const custom = handler(pathname, options);
    if (custom) return custom;
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders: [order], me: { id: 999 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/order/1') return json({ order });
    if (pathname === '/api/captcha') return json({ id: 'cap1', question: '3 + 4 = ?' });
    if (pathname === '/api/broker/status') return json({ application: null });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(script);
  await tick();
  assert.ok(refresh, 'application initialized polling');
  return { window, calls, json, refresh: () => refresh(), handle: (fn) => { handler = fn; }, document: window.document };
}

test('renders requisites on poll even when settings request fails; fetch bypasses cache', async (t) => {
  const a = await app(t);
  assert.match(a.document.querySelector('#exOrder').textContent, /Заявку ведёт брокер/);
  a.handle((url) => {
    if (url === '/api/settings') return Promise.reject(new Error('offline'));
    if (url === '/api/order/1') return a.json({ order: details });
  });
  await a.refresh();
  assert.equal(a.document.querySelector('#reqBox').textContent, details.requisites);
  assert.ok(a.document.querySelector('#btnPaid'));
  assert.ok(a.calls.every((c) => c.cache === 'no-store' && c.signal));
});

test('slow settings do not block repeated order updates or create overlapping order requests', async (t) => {
  const a = await app(t);
  const pendingSettings = deferred();
  const pendingOrder = deferred();
  let orderCalls = 0;
  a.handle((url) => {
    if (url === '/api/settings') return pendingSettings.promise;
    if (url === '/api/order/1') { orderCalls++; return pendingOrder.promise; }
  });
  const first = a.refresh();
  await a.refresh();
  assert.equal(orderCalls, 1);
  pendingOrder.resolve(a.json({ order: details }));
  await tick();
  assert.ok(a.document.querySelector('#reqBox'));
  a.handle((url) => {
    if (url === '/api/order/1') { orderCalls++; return a.json({ order: { ...details, payRub: 5100 } }); }
  });
  await a.refresh();
  assert.equal(orderCalls, 2);
  assert.match(a.document.querySelector('.pay-amount').textContent, /5\s100/);
  pendingSettings.resolve(a.json(settings));
  await first;
});

test('displays connection error and refreshes immediately when connection returns', async (t) => {
  const a = await app(t);
  a.handle((url) => url === '/api/order/1' ? Promise.reject(new Error('offline')) : null);
  await a.refresh();
  assert.ok(!a.document.querySelector('#syncStatus').classList.contains('hidden'));
  a.handle((url) => url === '/api/order/1' ? a.json({ order: details }) : null);
  a.window.dispatchEvent(new a.window.Event('online'));
  await tick();
  assert.ok(a.document.querySelector('#syncStatus').classList.contains('hidden'));
  assert.equal(a.document.querySelector('#reqBox').textContent, details.requisites);
});

test('returning to Mini App refreshes status without waiting for timer', async (t) => {
  const a = await app(t);
  a.handle((url) => url === '/api/order/1' ? a.json({ order: details }) : null);
  a.document.dispatchEvent(new a.window.Event('visibilitychange'));
  await tick();
  assert.ok(a.document.querySelector('#btnPaid'));
});

test('late GET cannot overwrite a successful payment action', async (t) => {
  const a = await app(t, details);
  const pending = deferred();
  a.handle((url) => {
    if (url === '/api/order/1') return pending.promise;
    if (url === '/api/order/1/paid') return a.json({ order: { ...details, status: 'paid' } });
  });
  const polling = a.refresh();
  a.document.querySelector('#btnPaid').click();
  await tick();
  assert.match(a.document.querySelector('#exOrder').textContent, /Подтверждаем оплату/);
  pending.resolve(a.json({ order: details }));
  await polling;
  assert.match(a.document.querySelector('#exOrder').textContent, /Подтверждаем оплату/);
  assert.equal(a.document.querySelector('#btnPaid'), null);
});

test('payment without a receipt is blocked until a PDF is attached', async (t) => {
  const noReceipt = { ...details, receipt: null, updatedAt: 3 };
  const a = await app(t, noReceipt);
  assert.ok(a.document.querySelector('#btnPick'));
  assert.ok(a.document.querySelector('#inReceipt'));
  a.document.querySelector('#btnPaid').click();
  await tick();
  assert.match(a.document.querySelector('#toast').textContent, /PDF/);
  assert.ok(!a.calls.some((c) => c.pathname.endsWith('/paid')));
  assert.ok(a.document.querySelector('#btnPaid'));
});

test('paid stage without a receipt offers late upload', async (t) => {
  const paidNoReceipt = { ...details, status: 'paid', receipt: null, updatedAt: 4 };
  const a = await app(t, paidNoReceipt);
  assert.ok(a.document.querySelector('#btnSendReceipt'));
  assert.match(a.document.querySelector('#fileName').textContent, /не прикреплён/);
});

test('failed payment action gives feedback and keeps requisites available', async (t) => {
  const a = await app(t, details);
  a.handle((url) => url.endsWith('/paid') ? Promise.reject(new Error('offline')) : null);
  a.document.querySelector('#btnPaid').click();
  await tick();
  assert.match(a.document.querySelector('#toast').textContent, /Не удалось отправить действие/);
  assert.ok(a.document.querySelector('#btnPaid'));
  assert.equal(a.document.querySelector('#reqBox').textContent, details.requisites);
});

test('info explains why only BTC and GRAM; preloader dismisses after init', async (t) => {
  const a = await app(t);
  const info = a.document.querySelector('#view-info').textContent;
  assert.match(info, /Почему только BTC и GRAM/);
  assert.match(info, /since 2025/i);
  assert.match(info, /Bitcoin/);
  const pre = a.document.querySelector('#preloader');
  assert.ok(!pre || pre.classList.contains('done'));
});

test('review reply from PRICELEX is rendered under the review', async (t) => {
  const a = await app(t, { ...initial, status: 'completed' });
  a.handle((url) => {
    if (url === '/api/reviews') return a.json({
      reviews: [{
        id: 7, name: 'Игорь', rating: 5, text: 'Всё чётко', createdAt: Date.UTC(2026, 8, 20),
        reply: { text: 'Благодарим за доверие.', at: Date.UTC(2026, 8, 21) },
      }],
      stats: { count: 1, avg: 5 },
    });
  });
  a.document.querySelector('button[data-tab="reviews"]').click();
  await tick();
  const item = a.document.querySelector('.rv-item');
  assert.ok(item);
  assert.match(item.textContent, /Всё чётко/);
  assert.match(item.querySelector('.rv-reply').textContent, /Благодарим за доверие/);
  assert.match(item.querySelector('.rv-reply').textContent, /PRICELEX/);
});

test('calculator converts both ways and never mentions any fee', async (t) => {
  const done = { ...initial, status: 'completed' };
  const a = await app(t, done);
  const rub = a.document.querySelector('#inRub');
  const crypto = a.document.querySelector('#inCrypto');
  assert.ok(rub && crypto, 'both inputs rendered');
  // Рубли → крипта.
  rub.value = '5000';
  rub.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(crypto.value, '0.0005');
  // Крипта → рубли к оплате (наценка уже внутри курса, видна только итоговая сумма).
  crypto.value = '0.001';
  crypto.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(rub.value, '10000');
  // Смена валюты пересчитывает пассивное поле, активное не трогает.
  a.document.querySelectorAll('#segCur button')[1].click();
  assert.equal(crypto.value, '0.001');
  assert.equal(rub.value, String(Math.ceil(0.001 * settings.rateGRAM - 1e-6)));
  assert.match(a.document.querySelector('#cryptoLimits').textContent, /GRAM/);
  assert.ok(!/комисси/i.test(a.document.querySelector('#view-exchange').textContent));
});

test('order screen keeps the platform-wide broker deposit as a quiet line', async (t) => {
  const a = await app(t, details);
  const line = a.document.querySelector('#exOrder .dep-line');
  assert.ok(line, 'гарантийный депозит тихо упомянут в заявке');
  assert.match(line.textContent, /Сделка застрахована общим депозитом брокеров площадки/);
  assert.ok(!a.document.querySelector('#exOrder .stage-deposit'), 'депозит не выделен отдельной плашкой');
  const amount = line.querySelector('.dep-btc').textContent.trim();
  assert.match(amount, /^0\.0200\d{4}$/, 'начало суммы ровное (0.0200), живут только последние четыре знака');
  assert.notEqual(amount.slice(-4), '0000', 'хвост не оставлен ровными нулями');
});
