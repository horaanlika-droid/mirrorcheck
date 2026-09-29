const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
const settings = { online: true, rateBTC: 10000000, rateGRAM: 125, minRub: 3000, maxRub: 300000 };
const broker = (login, rating, BTC = 10000000, extra = {}) => ({ login, name: login, rating, BTC, deals: 10, online: true, ...extra });

async function app(t, offers, { fail = false } = {}) {
  const dom = new JSDOM(read('index.html'), { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  let refresh;
  let requests = 0;
  w.setInterval = (fn) => { refresh = fn; return 1; };
  w.console.warn = () => {};
  w.fetch = async (url) => {
    const pathname = new URL(url, w.location.href).pathname;
    const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders: [], me: { id: 999 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/offers') {
      requests++;
      if (fail) throw new Error('offline');
      return json({ offers, market: { BTC: 10000000, GRAM: 125 } });
    }
    if (pathname === '/api/captcha') return json({ id: 'cap1', question: '3 + 4 = ?' });
    if (pathname === '/api/rates/history') return json({ points: [] });
    if (pathname === '/api/broker/status') return json({ application: null });
    throw new Error('Unexpected request: ' + pathname);
  };
  w.eval(read('app.js'));
  await tick(); await tick();
  return { w, doc: w.document, refresh: () => refresh(), requests: () => requests, recover: () => { fail = false; } };
}
const names = (doc) => [...doc.querySelectorAll('.top-broker-copy b')].map((b) => b.textContent);

test('top five ranks real available quotes by rating, then completed deals, without duplicates', async (t) => {
  const a = await app(t, [
    broker('six', 4.5), broker('third', 4.9), broker('first', 5),
    broker('second', 4.9, 9900000, { deals: 50 }), broker('fourth', 4.8), broker('fifth', 4.6),
    broker('offline', 5, 9500000, { online: false }), broker('disabled', 5, 9600000, { active: false }),
    broker('zero', 5, 0), broker('negative', 5, -10), broker('nan', 5, 'bad'),
    broker('infinite', 5, Infinity), broker('unrated', null), broker('bad rating', 6),
    broker('first', 5),
  ]);
  assert.deepEqual(names(a.doc), ['first', 'second', 'third', 'fourth', 'fifth']);
  assert.equal(a.doc.querySelectorAll('.broker-pin').length, 5);
  assert.match(a.doc.querySelector('.top-explainer').textContent, /рейтинг/);
  for (const c of a.doc.querySelectorAll('.broker-pin')) {
    assert.ok(Number.isFinite(Number(c.getAttribute('cx'))));
    assert.ok(Number(c.getAttribute('cx')) >= 24 && Number(c.getAttribute('cx')) <= 276);
  }
});

test('equal prices share a price coordinate but occupy separate lanes; selection links list and graph', async (t) => {
  const a = await app(t, [broker('a', 5), broker('b', 4.9)]);
  const pins = [...a.doc.querySelectorAll('.broker-pin')];
  assert.equal(pins[0].getAttribute('cx'), pins[1].getAttribute('cx'));
  assert.notEqual(pins[0].getAttribute('cy'), pins[1].getAttribute('cy'));
  a.doc.querySelector('[data-top-broker="1"]').click();
  assert.equal(a.doc.querySelectorAll('.broker-plot.selected').length, 1);
  assert.equal(a.doc.querySelector('.broker-plot.selected').dataset.brokerPlot, '1');
  assert.match(a.doc.querySelector('#topSelection').textContent, /^b:/);
  assert.equal(a.doc.querySelector('[data-top-broker="1"]').getAttribute('aria-pressed'), 'true');
  const point = a.doc.querySelector('[data-broker-plot="0"]');
  point.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(point.getAttribute('aria-pressed'), 'true');
  assert.equal(a.doc.querySelector('[data-top-broker="0"]').getAttribute('aria-pressed'), 'true');
  assert.match(a.doc.querySelector('#topSelection').textContent, /^a:/);
});

test('currency switch updates prices, rankings and empty state without clearing entered amount', async (t) => {
  const a = await app(t, [broker('btc only', 5), broker('both', 4.8, 10100000, { GRAM: 120 })]);
  const input = a.doc.querySelector('#inRub');
  input.value = '5000';
  input.dispatchEvent(new a.w.Event('input'));
  a.doc.querySelector('[data-c="GRAM"]').click();
  assert.deepEqual(names(a.doc), ['both']);
  assert.match(a.doc.querySelector('#topSelection').textContent, /120.*GRAM/);
  assert.equal(input.value, '5000');
  assert.match(a.doc.querySelector('.top-footnote').textContent, /Доступно 1 из 5/);
  assert.equal(a.doc.querySelectorAll('.broker-pin').length, 1);
});

test('empty offers are not replaced by fabricated brokers; failed fetch can be retried', async (t) => {
  const empty = await app(t, []);
  assert.equal(empty.doc.querySelectorAll('.broker-pin').length, 0);
  assert.match(empty.doc.querySelector('.top-empty').textContent, /Пока нет предложений/);
  const failed = await app(t, [broker('recovered', 5)], { fail: true });
  assert.match(failed.doc.querySelector('.top-empty').textContent, /Не удалось загрузить/);
  failed.recover();
  failed.doc.querySelector('#retryOffers').click();
  await tick(); await tick();
  assert.deepEqual(names(failed.doc), ['recovered']);
  assert.equal(failed.requests(), 2);
});

test('broker names are escaped in SVG and buttons, and quote refresh updates graph', async (t) => {
  const offers = [broker('<img src=x onerror=alert(1)>', 5)];
  const a = await app(t, offers);
  assert.equal(a.doc.querySelector('#topBrokers img'), null);
  assert.equal(names(a.doc)[0], offers[0].name);
  offers[0].BTC = 8000000;
  await a.refresh(); await tick();
  assert.match(a.doc.querySelector('#topSelection').textContent, /8\s000\s000/);
});

test('three steps have accessible field labels and preserve ordinary exchange calculation', async (t) => {
  const a = await app(t, []);
  assert.equal(a.doc.querySelectorAll('.exchange-journey .step-number').length, 3);
  for (const id of ['inRub', 'inCrypto', 'inWallet']) assert.ok(a.doc.querySelector(`label[for="${id}"]`));
  const input = a.doc.querySelector('#inRub');
  input.value = '5000';
  input.dispatchEvent(new a.w.Event('input'));
  assert.equal(Number(a.doc.querySelector('#inCrypto').value), .0005);
  a.doc.querySelector('#btnGo').click();
  assert.match(a.doc.querySelector('#fErr').textContent, /кошелька/);
  assert.equal(a.doc.querySelector('#fErr').getAttribute('role'), 'alert');
});
