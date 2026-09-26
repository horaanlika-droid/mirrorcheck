// Полировка интерфейса по скриншотам IMG_1253–IMG_1255 и следующим просьбам:
// плашка чата в правом нижнем углу; строки не рвутся на колонки (текст
// растягивает карточку, а не ломается); медные монеты BTC/GRAM и рубль из
// монограммы логотипа — сгенерированный арт, монета выбранной валюты
// вращается; бронзовая CTA; виброотклик на нажатия и ошибки; переключатели
// отклика в профиле.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { decodePng } = require('../tools/png-key.js');

const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const html = pub('index.html');
const appJs = pub('app.js');
const glass = pub('glass.css');

const now = Date.now();
const HOUR = 3600 * 1000;
const settings = {
  online: true, rateBTC: 10_000_000, rateGRAM: 125, rateUpdatedAt: now - HOUR,
  minRub: 3000, maxRub: 300000, announcement: '', refPercent: 1, operator: '@test',
  channel: 'https://t.me/test', chat: 'https://t.me/test', botUsername: 'test_bot',
  guaranteeFundBtc: 0.01439471, brokerDepositBtc: 0.0002, brokerDepositFeePercent: 10, brokerDepositFeeMaxBtc: 0.0005,
  adminBrokers: [{ login: 'a', name: 'a', online: true, rating: 4.9, completed: 10 }],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function app(t, { telegram = true, storage = {}, brokerApp = null } = {}) {
  const d = new JSDOM(html, { url: 'https://pricelex.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => d.window.close());
  const { window } = d;
  window.console.warn = () => {};
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const impacts = [];
  if (telegram) {
    window.Telegram = {
      WebApp: {
        ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
        HapticFeedback: {
          impactOccurred: (style) => impacts.push(style),
          selectionChanged: () => impacts.push('selection'),
          notificationOccurred: (kind) => impacts.push(kind),
        },
      },
    };
  }
  const timers = [];
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000) { timers.push({ fn, ms }); return timers.length; }
    return realSetTimeout(fn, ms, ...rest);
  };
  window.setInterval = () => 1;
  window.fetch = async (url) => {
    const pathname = new URL(url, window.location.href).pathname;
    const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders: [], me: { id: 999, referredCount: 0 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/rates/history') return json({ hours: 24, updatedAt: settings.rateUpdatedAt, points: [] });
    if (pathname === '/api/support/messages') return json({ messages: [] });
    if (pathname === '/api/reviews') return json({ reviews: [], stats: { count: 0, avg: 0 } });
    if (pathname === '/api/captcha') return json({ id: 'c1', question: '1 + 1 = ?' });
    if (pathname === '/api/broker/status') return json({ application: brokerApp });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(appJs);
  await tick(); await tick(); await tick();
  const doc = window.document;
  const fire = (ms) => timers.filter((x) => x.ms === ms).map((x) => x.fn()).length;
  const open = async (go) => {
    doc.querySelector('.nav button[data-tab="profile"]').click();
    await tick();
    if (go) { doc.querySelector(`#view-profile [data-go="${go}"]`).click(); await tick(); await tick(); }
  };
  return { window, doc, impacts, fire, open };
}

// Текстовые узлы-«сироты» прямо внутри flex-строки и есть причина разъезда на колонки.
const looseText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());

// ---------- плашка чата ----------
test('плашка чата — в правом нижнем углу над таб-баром, строки не переносятся', () => {
  const fab = glass.match(/\n\.support-fab \{[^}]*\}/)[0];
  assert.match(fab, /position: fixed;/);
  assert.match(fab, /top: auto;/, 'не висит посередине экрана');
  assert.doesNotMatch(fab, /top: 50%/);
  assert.match(fab, /right: max\(var\(--fab-gap\), calc\(env\(safe-area-inset-right\) \+ 10px\)\);/, 'прижата вправо с учётом выреза');
  assert.match(fab, /bottom: calc\(var\(--fab-nav\) \+ var\(--fab-gap\) \+ env\(safe-area-inset-bottom\)\);/,
    'над таб-баром и home-индикатором');
  assert.match(fab, /--fab-nav: calc\(var\(--ui-nav-btn, 48px\) \+ 11px\);/, 'высота таб-бара следует шкале устройства');
  assert.match(fab, /width: max-content;/, 'ширина — по тексту');
  assert.match(fab, /white-space: nowrap;/);
  assert.match(glass, /\.sf-copy b \{[^}]*white-space: nowrap;/, 'заголовок одной строкой');
  assert.match(glass, /\.sf-copy small \{[^}]*white-space: nowrap;/, 'подпись одной строкой');
  assert.match(glass, /\.app\.subpage ~ \.support-fab \{ bottom: calc\(var\(--fab-gap\) \+ env\(safe-area-inset-bottom\)\); \}/,
    'на саб-страницах без таб-бара — у нижнего края');
  assert.match(glass, /\.sf-tail \{[^}]*bottom: -6px;/, 'хвостик диалога смотрит в угол');
});

test('пока плашка видна, у страницы есть запас снизу — последний блок не прячется под ней', async (t) => {
  const a = await app(t);
  const fab = a.doc.querySelector('#supportFab');
  assert.ok(!a.doc.body.classList.contains('has-fab'), 'до показа запаса нет');
  assert.equal(a.fire(20000), 1);
  await tick();
  assert.ok(fab.classList.contains('show'));
  assert.ok(a.doc.body.classList.contains('has-fab'), 'плашка показана — страница получила запас');
  assert.match(glass, /body\.has-fab \.app \{ padding-bottom: calc\(92px \+ 76px \+ env\(safe-area-inset-bottom\)\); \}/);
  fab.click();
  await tick(); await tick();
  assert.ok(!a.doc.body.classList.contains('has-fab'), 'в чате плашки нет — и запаса тоже');
  assert.match(glass, /\.demo-admin \{ right: auto; left:/, 'демо-пульт уступил правый угол');
});

// ---------- строки не рвутся ----------
test('«Как это устроено»: пункт — одна строка текста, сумма гарантии не отрывается от BTC', async (t) => {
  const a = await app(t);
  await a.open('broker');
  const items = [...a.doc.querySelectorAll('#view-broker .feat .f')];
  assert.equal(items.length, 6);
  for (const f of items) {
    assert.deepEqual([...f.children].map((c) => c.className), ['i', 'f-copy'], 'значок и один блок текста');
    assert.deepEqual(looseText(f), [], 'ни одного текстового узла вне блока текста');
  }
  const guarantee = items.find((f) => /Гарантия для клиентов/.test(f.textContent));
  const dep = guarantee.querySelector('.f-copy .dep-inline');
  assert.ok(dep, 'сумма внутри текста пункта');
  assert.match(dep.textContent, /^0\.0143\d{4} BTC$/, 'сумма и тикер — одна связка');
  assert.match(glass, /\.dep-inline, \.nw \{ white-space: nowrap; \}/);
  const deposit = items.find((f) => /Депозит и подключение/.test(f.textContent));
  assert.deepEqual([...deposit.querySelectorAll('.nw')].map((x) => x.textContent), ['0.0002 BTC', '0.0005 BTC']);
});

test('«Ваша заявка»: подпись и значение разведены, а не склеены в «Контакт035869504»', async (t) => {
  const a = await app(t, { brokerApp: { id: 1, status: 'approved', experience: 'Два года P2P', contact: '035869504', createdAt: now } });
  await a.open('broker');
  const rows = [...a.doc.querySelectorAll('#view-broker .order-meta .mrow')];
  assert.equal(rows.length, 3);
  for (const r of rows) assert.deepEqual([...r.children].map((c) => c.tagName), ['SPAN', 'B']);
  const mrow = glass.match(/\.order-meta \.mrow \{[^}]*\}/)[0];
  assert.match(mrow, /display: grid;/);
  assert.match(mrow, /grid-template-columns: 6\.5em minmax\(0, 1fr\);/, 'колонка подписей одной ширины во всех строках');
  assert.match(mrow, /column-gap: 14px;/);
  const link = a.doc.querySelector('#view-broker a.btn');
  assert.ok(link, 'одобренной заявке — кнопка «Открыть бота»');
  assert.match(glass, /a\.btn, a\.btn:hover, a\.btn:visited \{ text-decoration: none; \}/, 'кнопка-ссылка без подчёркивания');
});

test('«Инфо»: пункты безопасности и «Почему PRICELEX», шаги — без колонок', async (t) => {
  const a = await app(t);
  await a.open('info');
  const view = a.doc.querySelector('#view-info');
  const items = [...view.querySelectorAll('.feat .f')];
  assert.equal(items.length, 12, 'семь пунктов безопасности и пять — «Почему PRICELEX»');
  for (const f of items) {
    assert.deepEqual([...f.children].map((c) => c.className), ['i', 'f-copy']);
    assert.deepEqual(looseText(f), []);
  }
  assert.equal(view.querySelectorAll('.f-copy .dep-inline').length, 2, 'обе суммы депозита — внутри текста');
  const steps = [...view.querySelectorAll('.steps .step')];
  assert.equal(steps.length, 4);
  for (const s of steps) {
    assert.deepEqual([...s.children].map((c) => c.className), ['n', 'step-copy']);
    assert.deepEqual(looseText(s), []);
  }
  assert.ok(view.querySelector('.signature'), 'подпись внизу «Инфо» на месте');
});

// ---------- медные монеты ----------
function meanHue(file) {
  const img = decodePng(file);
  let sx = 0; let sy = 0; let n = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const o = i * 4;
    if (img.px[o + 3] < 200) continue;
    const r = img.px[o] / 255; const g = img.px[o + 1] / 255; const b = img.px[o + 2] / 255;
    const max = Math.max(r, g, b); const d = max - Math.min(r, g, b);
    if (d < 0.02) continue;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
    sx += Math.cos((h * Math.PI) / 180); sy += Math.sin((h * Math.PI) / 180); n += 1;
  }
  let m = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (m < 0) m += 360;
  return { hue: m, n, img };
}

test('монеты BTC, GRAM и RUB: сгенерированный медный арт с прозрачностью, одним металлом', () => {
  const coins = ['coin-btc.png', 'coin-gram.png', 'coin-rub.png'].map((f) => ({ f, ...meanHue(path.join(__dirname, '../public/img', f)) }));
  for (const c of coins) {
    const { width, height, px } = c.img;
    assert.ok(width <= 256 && height <= 256 && width >= 96, `${c.f}: интерфейсный размер ${width}×${height}`);
    let transparent = 0;
    for (let i = 0; i < width * height; i += 1) if (px[i * 4 + 3] === 0) transparent += 1;
    assert.ok(transparent > width * height * 0.12, `${c.f}: углы вокруг монеты прозрачные`);
    assert.ok(c.n > 2000, `${c.f}: монета, а не пустышка`);
    assert.ok(c.hue > 24 && c.hue < 32, `${c.f}: медно-бронзовый тон ${c.hue.toFixed(1)}°`);
  }
  const spread = Math.max(...coins.map((c) => c.hue)) - Math.min(...coins.map((c) => c.hue));
  assert.ok(spread < 3, 'все монеты из одного металла');
});

test('рубль — медная монета из монограммы логотипа в поле «Вы отдаёте»', async (t) => {
  const a = await app(t);
  const ic = a.doc.querySelector('#exForm .field .coin-ic.rub');
  assert.ok(ic, 'поле «Вы отдаёте» несёт иконку монеты');
  assert.ok(ic.classList.contains('coin-art'), 'монета подключена как арт');
  assert.ok(ic.querySelector('img'), 'в поле — картинка монеты, а не глиф');
  assert.match(ic.querySelector('img').getAttribute('src'), /\/img\/coin-rub\.png$/);
  assert.equal(ic.querySelectorAll('.coin3d-spin > img.coin3d-face').length, 2, 'у монеты две стороны');
  assert.ok(ic.querySelector('.coin3d-edge'), 'и ребро — монета объёмная');
});

test('монета вращается только у выбранной валюты — и начинает оборот в момент выбора', async (t) => {
  const a = await app(t);
  const [btc, gram] = [...a.doc.querySelectorAll('#segCur button')];
  for (const b of [btc, gram]) {
    const coin = b.querySelector('.coin3d');
    assert.ok(coin, 'в кнопке — медная монета');
    assert.equal(coin.querySelectorAll('.coin3d-spin > img.coin3d-face').length, 2, 'у монеты две стороны');
    assert.ok(coin.querySelector('.coin3d-spin > .coin3d-back'), 'оборотная сторона развёрнута');
    assert.ok(coin.querySelector('.coin3d-edge'), 'и ребро — видно на развороте');
  }
  assert.match(btc.querySelector('img').getAttribute('src'), /\/img\/coin-btc\.png$/);
  assert.match(gram.querySelector('img').getAttribute('src'), /\/img\/coin-gram\.png$/);
  assert.equal(btc.querySelector('.seg-label').textContent, 'BTC');
  assert.ok(btc.classList.contains('on') && !gram.classList.contains('on'));
  assert.equal(btc.getAttribute('aria-pressed'), 'true');

  // Вращение привязано к выбранной кнопке: сменился .on — вращается другая монета.
  assert.match(glass, /\.seg\.currency-segment button\.on \.coin3d-spin \{\n\s*animation: coin-turn 2\.6s cubic-bezier\(\.45, \.05, \.3, 1\) infinite;/);
  assert.match(glass, /@keyframes coin-turn \{\n\s*from \{ transform: rotateY\(0deg\); \}\n\s*to \{ transform: rotateY\(360deg\); \}/);
  assert.doesNotMatch(glass, /\.seg\.currency-segment button(:not\(\.on\))? \.coin3d-spin \{[^}]*animation/, 'невыбранная монета стоит');
  assert.match(glass, /\.coin3d-back \{ transform: rotateY\(180deg\) translateZ\(1px\); \}/);
  assert.match(glass, /backface-visibility: hidden;/);
  assert.match(glass, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.seg\.currency-segment button\.on \.coin3d-spin,\n\s*\.coin-ic\.coin-swap \.coin3d-spin \{ animation: none; \}/,
    'при запрете движения монеты стоят');

  gram.click();
  await tick();
  assert.ok(gram.classList.contains('on') && !btc.classList.contains('on'), 'выбор переехал — вращается GRAM');
  assert.equal(gram.getAttribute('aria-pressed'), 'true');
  assert.equal(btc.getAttribute('aria-pressed'), 'false');
  // Монеты в полях сменились и переворачиваются один раз.
  for (const id of ['#getIc', '#walIc']) {
    const ic = a.doc.querySelector(id);
    assert.equal(ic.dataset.cur, 'GRAM');
    assert.ok(ic.classList.contains('coin-swap'), `${id}: переворот при смене валюты`);
    assert.match(ic.querySelector('img').getAttribute('src'), /coin-gram\.png$/);
  }
  // Ввод суммы не пересоздаёт монеты (иначе переворот дёргался бы на каждую цифру).
  const img = a.doc.querySelector('#getIc img');
  const input = a.doc.querySelector('#inRub');
  input.value = '5000';
  input.dispatchEvent(new a.window.Event('input'));
  assert.equal(a.doc.querySelector('#getIc img'), img);
});

test('выбор валюты — бронзовая таблетка с плитой, кнопка текста не переносит', () => {
  const on = glass.match(/\.seg\.currency-segment button\.on \{[^}]*\}/)[0];
  assert.match(on, /var\(--bronze-plate\) center \/ 100% 100% no-repeat/);
  assert.match(on, /color: var\(--bronze-ink\);/);
  assert.match(glass, /\.seg\.currency-segment button \{[^}]*white-space: nowrap;/);
  const iosCss = pub('ios.css');
  assert.match(iosCss, /background: linear-gradient\(135deg, var\(--sand-1\) 0%, var\(--tint-fill\) 78%\);/,
    'общий сегмент (история и т.п.) остался шампанским');
});

// ---------- виброотклик ----------
test('виброотклик: любое нажатие отзывается, но ровно один раз', async (t) => {
  const a = await app(t);
  a.impacts.length = 0;
  a.doc.querySelector('#segCur button[data-c="GRAM"]').click();
  assert.deepEqual(a.impacts, ['selection'], 'выбор валюты — отклик выбора, без дубля от общего обработчика');

  a.impacts.length = 0;
  await new Promise((r) => setTimeout(r, 120));
  a.doc.querySelector('#howItWorks').click(); // ведёт в «Инфо»
  assert.deepEqual(a.impacts, ['light'], 'кнопка со своим откликом — один импульс');
  await tick();
  assert.ok(!a.doc.querySelector('#view-info').classList.contains('hidden'));
  a.impacts.length = 0;
  await new Promise((r) => setTimeout(r, 120));
  a.doc.querySelector('#view-info .rules summary').click();
  assert.deepEqual(a.impacts, ['light'], 'у пункта правил своего отклика нет — отозвался общий обработчик');
});

test('ошибка в форме обмена отзывается вибрацией ошибки', async (t) => {
  const a = await app(t);
  a.impacts.length = 0;
  a.doc.querySelector('#inRub').value = '100';
  a.doc.querySelector('#btnGo').click();
  await tick();
  assert.match(a.doc.querySelector('#fErr').textContent, /Минимальная сумма обмена/);
  assert.deepEqual(a.impacts, ['error'], 'ошибка проверки — notificationOccurred(error), без лишнего толчка');
});

test('профиль: «Звук кассы» и «Виброотклик» переключаются и запоминаются', async (t) => {
  const a = await app(t);
  await a.open();
  const sound = a.doc.querySelector('#profileSound');
  const vibe = a.doc.querySelector('#profileHaptics');
  assert.equal(sound.getAttribute('role'), 'switch');
  assert.equal(sound.getAttribute('aria-checked'), 'true', 'по умолчанию звук включён');
  assert.equal(vibe.getAttribute('aria-checked'), 'true', 'и вибрация включена');
  sound.click();
  assert.equal(a.window.localStorage.getItem('pricelex_sound'), 'off');
  assert.equal(sound.getAttribute('aria-checked'), 'false');
  assert.ok(sound.querySelector('.profile-toggle').classList.contains('off'));

  await new Promise((r) => setTimeout(r, 120));
  vibe.click();
  assert.equal(a.window.localStorage.getItem('pricelex_haptics'), 'off');
  a.impacts.length = 0;
  await new Promise((r) => setTimeout(r, 120));
  a.doc.querySelector('#profileLogout').click();
  assert.deepEqual(a.impacts, [], 'вибрация выключена — нажатия молчат');
  vibe.click();
  assert.deepEqual(a.impacts, ['medium'], 'включили — сразу пробный отклик');
});
