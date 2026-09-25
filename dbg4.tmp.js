const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const script = fs.readFileSync('public/app.js', 'utf8');
const now = Date.now(), HOUR = 3600e3;
const settings = { online: true, rateBTC: 7_140_000, rateGRAM: 119, rateUpdatedAt: now - HOUR, minRub: 3000, maxRub: 300000,
  guaranteeFundBtc: 0.02, adminBrokers: [1,2,3,4,5].map((i) => ({ login: 'b' + i, name: 'b' + i, online: true })) };
const points = Array.from({ length: 168 }, (_, i) => ({ at: now - (168 - i) * HOUR, btc: 7_000_000 + Math.round(Math.sin(i / 9) * 90_000) + i * 900, gram: 119 }));
(async () => {
  const clock = { t: now };
  const dom = new JSDOM(html, { url: 'https://x.example', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.Date.now = () => clock.t; w.console.warn = () => {}; w.setInterval = () => 1;
  const json = (d) => ({ ok: true, json: async () => structuredClone(d) });
  w.fetch = async (url) => {
    const p = new URL(url, w.location.href).pathname;
    if (p === '/api/init') return json({ settings, me: { id: 9 }, demo: false });
    if (p === '/api/me') return json({ orders: [], me: { id: 9 } });
    if (p === '/api/settings') return json(settings);
    if (p === '/api/rates/history') return json({ hours: 168, updatedAt: settings.rateUpdatedAt, points });
    if (p === '/api/support/messages') return json({ messages: [] });
    if (p === '/api/reviews') return json({ reviews: [], stats: { count: 0, avg: 0 } });
    if (p === '/api/captcha') return json({ id: 'c', question: '1+1' });
    if (p === '/api/broker/status') return json({ application: null });
    throw new Error('Unexpected ' + p);
  };
  w.eval(script);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const tab = async (t) => { w.document.querySelector(`.nav button[data-tab="${t}"]`).click(); await new Promise((r) => setImmediate(r)); };
  const dep = () => w.document.querySelector('#depositCard .dep-btc').textContent;
  const br = () => w.document.querySelector('.brokers-online-chip .broker-online-count').textContent;
  const dip = () => (w.document.querySelector('#rateChart .chart-dip .d-k') || { textContent: '—' }).textContent;
  let min = 1e9, max = 0, prevBr = Number(br()), maxStep = 0;
  for (let i = 0; i < 288; i += 1) { // сутки шагом 5 минут
    clock.t = now + i * 5 * 60000;
    await tab('reviews'); await tab('exchange');
    const v = Number(dep()); min = Math.min(min, v); max = Math.max(max, v);
    const b = Number(br()); maxStep = Math.max(maxStep, Math.abs(b - prevBr)); prevBr = b;
    if (i % 24 === 0) console.log(new Date(clock.t).toTimeString().slice(0, 5), dep(), 'брокеров:', br(), '|', dip());
  }
  console.log('депозит за сутки: min', min.toFixed(8), 'max', max.toFixed(8), '| макс. шаг счётчика', maxStep);
})();
