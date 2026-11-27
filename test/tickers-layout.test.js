// Бегущие строки (две штуки, по типу talalay) и перемещение блоков местами в админке.
const { test, after, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-tickers-layout-'));
process.env.DATA_DIR = dir;
delete process.env.BOT_TOKEN;
delete process.env.ADMIN_ID;
delete process.env.ADMIN_IDS;

const store = require('../src/store');
const { createApp } = require('../src/web');

let server = null;
let baseUrl = '';

const ADMIN_DEMO = { id: '900001', name: 'Operator' };
const CLIENT_DEMO = { id: '900002', name: 'Client' };

async function req(method, endpoint, { demo = ADMIN_DEMO, body } = {}) {
  const q = new URLSearchParams({ 'demo[id]': demo.id, 'demo[name]': demo.name });
  const sep = endpoint.includes('?') ? '&' : '?';
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  const res = await fetch(`${baseUrl}${endpoint}${sep}${q}`, {
    method,
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(Object.assign({ demo }, body || {})) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  store.mutate((db) => {
    db.settings.ticker = [...store.DEFAULT_TICKER];
    db.settings.tickerEnabled = true;
    db.settings.marquee = [...store.DEFAULT_MARQUEE];
    db.settings.marqueeEnabled = true;
    db.settings.blockOrder = store.normalizeBlockOrder(store.DEFAULT_BLOCK_ORDER);
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('публичные и админские настройки отдают две бегущие строки и порядок блоков по умолчанию', async () => {
  const pub = await req('GET', '/api/settings', { demo: CLIENT_DEMO });
  assert.equal(pub.status, 200);
  assert.ok(Array.isArray(pub.data.ticker) && pub.data.ticker.length > 0);
  assert.equal(pub.data.tickerEnabled, true);
  assert.ok(Array.isArray(pub.data.marquee) && pub.data.marquee.length > 0);
  assert.equal(pub.data.marqueeEnabled, true);
  assert.deepEqual(pub.data.blockOrder, store.DEFAULT_BLOCK_ORDER);

  const adm = await req('GET', '/api/admin/settings');
  assert.equal(adm.status, 200);
  assert.deepEqual(adm.data.admin.ticker, store.DEFAULT_TICKER);
  assert.deepEqual(adm.data.admin.marquee, store.DEFAULT_MARQUEE);
  assert.deepEqual(adm.data.admin.blockOrder, store.DEFAULT_BLOCK_ORDER);
});

test('админ редактирует текст обеих бегущих строк, переключает их и сбрасывает; клиент не имеет доступа', async () => {
  const forbid = await req('PUT', '/api/admin/tickers', {
    demo: CLIENT_DEMO,
    body: { ticker: ['ВЗЛОМ'] },
  });
  assert.equal(forbid.status, 403);

  // Редактирование многострочным текстом и массивом
  const upd = await req('PUT', '/api/admin/tickers', {
    body: {
      ticker: 'ПЕРВАЯ *ФРАЗА*\nВТОРАЯ ФРАЗА',
      marquee: ['Быстрый *обмен*', 'Сеть *BEP-20*'],
    },
  });
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.data.settings.ticker, ['ПЕРВАЯ *ФРАЗА*', 'ВТОРАЯ ФРАЗА']);
  assert.deepEqual(upd.data.settings.marquee, ['Быстрый *обмен*', 'Сеть *BEP-20*']);

  // Выключение одной строки и валидация пустого ввода
  const toggleOff = await req('PUT', '/api/admin/tickers', {
    body: { tickerEnabled: false },
  });
  assert.equal(toggleOff.status, 200);
  assert.equal(toggleOff.data.settings.tickerEnabled, false);
  assert.equal(toggleOff.data.settings.marqueeEnabled, true);

  const emptyErr = await req('PUT', '/api/admin/tickers', {
    body: { marquee: '   \n  ' },
  });
  assert.equal(emptyErr.status, 400);

  // Сброс к исходным фразам через null
  const reset = await req('PUT', '/api/admin/tickers', {
    body: { ticker: null, tickerEnabled: true, marquee: null },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.settings.tickerEnabled, true);
  assert.deepEqual(reset.data.settings.ticker, store.DEFAULT_TICKER);
  assert.deepEqual(reset.data.settings.marquee, store.DEFAULT_MARQUEE);
});

test('админ перемещает блоки местами и сбрасывает порядок; невалидные ID отклоняются', async () => {
  const forbid = await req('PUT', '/api/admin/layout', {
    demo: CLIENT_DEMO,
    body: { section: 'home', order: ['cards', 'hero', 'marquee', 'steps', 'buyNote'] },
  });
  assert.equal(forbid.status, 403);

  const customHome = ['cards', 'marquee', 'hero', 'buyNote', 'steps'];
  const upd = await req('PUT', '/api/admin/layout', {
    body: { section: 'home', order: customHome },
  });
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.data.settings.blockOrder.home, customHome);
  assert.deepEqual(upd.data.settings.blockOrder.form, store.DEFAULT_BLOCK_ORDER.form);

  // Перестановка в форме обмена через blockOrder
  const customForm = ['formWallet', 'formCalc', 'formInfo'];
  const updForm = await req('PUT', '/api/admin/layout', {
    body: { blockOrder: { form: customForm } },
  });
  assert.equal(updForm.status, 200);
  assert.deepEqual(updForm.data.settings.blockOrder.home, customHome);
  assert.deepEqual(updForm.data.settings.blockOrder.form, customForm);

  // Неизвестный блок или дубликат — 400
  const badBlock = await req('PUT', '/api/admin/layout', {
    body: { section: 'home', order: ['hero', 'unknownBlock'] },
  });
  assert.equal(badBlock.status, 400);

  const dupBlock = await req('PUT', '/api/admin/layout', {
    body: { section: 'home', order: ['hero', 'hero'] },
  });
  assert.equal(dupBlock.status, 400);

  // Сброс порядка
  const reset = await req('PUT', '/api/admin/layout', {
    body: { reset: true },
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data.settings.blockOrder, store.DEFAULT_BLOCK_ORDER);
});

test('HTML и клиентское приложение рендерят две бегущие строки и блоки в заданном порядке', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const orderChatJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'order-chat.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  const dom = new JSDOM(html, { url: baseUrl, runScripts: 'outside-only' });
  const doc = dom.window.document;
  const intervals = [];
  const timeouts = [];

  try {
    assert.ok(doc.getElementById('topTicker'), 'верхняя бегущая строка #topTicker присутствует');
    assert.ok(doc.querySelector('#admTabs .adm-tab[data-tab="blocks"]'), 'вкладка блоков присутствует');
    assert.ok(doc.querySelector('#admTabs .adm-tab[data-tab="tickers"]'), 'вкладка бегущих строк присутствует');
    assert.ok(doc.getElementById('admLayoutToggle'), 'кнопка перемещения блоков на экране присутствует');
    assert.ok(doc.getElementById('admLayoutDone'), 'кнопка завершения режима блоков присутствует');
    assert.ok(doc.getElementById('admTickerInput'), 'поле редактирования верхней бегущей строки присутствует');
    assert.ok(doc.getElementById('admMarqueeInput'), 'поле редактирования крупной бегущей строки присутствует');
    assert.ok(doc.getElementById('tickerEditSheet'), 'модалка инлайн-редактирования бегущей строки присутствует');

    // Сохраняем кастомный порядок и кастомные бегущие строки на сервере
    await req('PUT', '/api/admin/tickers', {
      body: {
        ticker: 'ТОП *СТРОКА*',
        marquee: ['Большая *строка* витрины'],
      },
    });
    await req('PUT', '/api/admin/layout', {
      body: { section: 'home', order: ['cards', 'marquee', 'hero', 'steps', 'buyNote'] },
    });

    // Исполняем клиентский JS в JSDOM с реальным fetch на тестовый сервер
    const origSetInterval = dom.window.setInterval.bind(dom.window);
    const origSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setInterval = (fn, ms, ...args) => {
      const id = origSetInterval(fn, ms, ...args);
      intervals.push(id);
      return id;
    };
    dom.window.setTimeout = (fn, ms, ...args) => {
      const id = origSetTimeout(fn, ms, ...args);
      timeouts.push(id);
      return id;
    };
    dom.window.fetch = (input, init) => fetch(new URL(String(input), baseUrl).toString(), init);
    dom.window.requestAnimationFrame = (cb) => dom.window.setTimeout(cb, 0);
    dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
    dom.window.eval(orderChatJs);
    dom.window.eval(appJs);

    // Дожидаемся асинхронной инициализации /api/init и /api/me
    for (let i = 0; i < 60; i++) {
      if (doc.querySelector('#assetPicker [data-block]')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 60));

    // Проверяем верхнюю бегущую строку
    const tickerHtml = doc.getElementById('topTicker').innerHTML;
    assert.ok(tickerHtml.includes('ТОП <em>СТРОКА</em>'), 'верхняя строка отрендерена с акцентом');

    // Проверяем крупную бегущую строку и порядок блоков на главной
    const blocks = [...doc.querySelectorAll('#assetPicker > [data-block]')].map((el) => el.dataset.block);
    assert.deepEqual(blocks, ['cards', 'marquee', 'hero', 'steps', 'buyNote']);

    const marqueeEl = doc.querySelector('#assetPicker .kinetic');
    assert.ok(marqueeEl, 'крупная бегущая строка .kinetic присутствует');
    assert.ok(marqueeEl.innerHTML.includes('Большая <em>строка</em> витрины'), 'крупная строка отрендерена с акцентом');

    // Проверяем admin UI: переключение на вкладки «Блоки» и «Строки», сохранение и режим на экране
    const domAdm = new JSDOM(html, { url: baseUrl, runScripts: 'outside-only' });
    const admIntervals = [];
    const admTimeouts = [];
    try {
      domAdm.window.localStorage.setItem('pricelex_demo', JSON.stringify({ id: Number(ADMIN_DEMO.id), name: ADMIN_DEMO.name }));
      const origAdmInterval = domAdm.window.setInterval.bind(domAdm.window);
      const origAdmTimeout = domAdm.window.setTimeout.bind(domAdm.window);
      domAdm.window.setInterval = (fn, ms, ...args) => {
        const id = origAdmInterval(fn, ms, ...args);
        admIntervals.push(id);
        return id;
      };
      domAdm.window.setTimeout = (fn, ms, ...args) => {
        const id = origAdmTimeout(fn, ms, ...args);
        admTimeouts.push(id);
        return id;
      };
      domAdm.window.fetch = (input, init) => fetch(new URL(String(input), baseUrl).toString(), init);
      domAdm.window.requestAnimationFrame = (cb) => domAdm.window.setTimeout(cb, 0);
      domAdm.window.cancelAnimationFrame = (id) => domAdm.window.clearTimeout(id);
      domAdm.window.eval(orderChatJs);
      domAdm.window.eval(appJs);

      const admDoc = domAdm.window.document;
      for (let i = 0; i < 60; i++) {
        if (admDoc.getElementById('lcOpenAdmin')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 60));

      // Открываем админ-панель и вкладку «Строки»
      const openBtn = admDoc.getElementById('lcOpenAdmin');
      assert.ok(openBtn, 'кнопка админ-панели #lcOpenAdmin присутствует');
      openBtn.click();
      await new Promise((r) => setTimeout(r, 80));

      admDoc.querySelector('#admTabs .adm-tab[data-tab="tickers"]').click();
      admDoc.getElementById('admTickerInput').value = 'АДМИН *ТЕСТ*';
      admDoc.getElementById('admTickerSave').click();
      for (let i = 0; i < 40; i++) {
        if (admDoc.getElementById('topTicker').innerHTML.includes('АДМИН <em>ТЕСТ</em>')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(
        admDoc.getElementById('topTicker').innerHTML.includes('АДМИН <em>ТЕСТ</em>'),
        'админ-панель сохраняет и сразу обновляет бегущую строку'
      );

      // Открываем вкладку «Блоки» и нажимаем кнопку перемещения вверх на втором блоке
      admDoc.querySelector('#admTabs .adm-tab[data-tab="blocks"]').click();
      const secondUp = admDoc.querySelector('[data-adm-block-list="home"] [data-adm-up="1"]');
      assert.ok(secondUp, 'кнопка поднятия блока в админке присутствует');
      secondUp.click();
      for (let i = 0; i < 40; i++) {
        const cur = [...admDoc.querySelectorAll('#assetPicker > [data-block]')].map((el) => el.dataset.block);
        if (cur[0] === 'marquee') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const reordered = [...admDoc.querySelectorAll('#assetPicker > [data-block]')].map((el) => el.dataset.block);
      assert.deepEqual(reordered, ['marquee', 'cards', 'hero', 'steps', 'buyNote']);

      // Режим перестановки прямо на экране
      admDoc.getElementById('admLayoutToggle').click();
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(admDoc.body.classList.contains('layout-edit-on'), 'режим редактирования блоков включён');
      assert.ok(admDoc.querySelector('#assetPicker .adm-block-bar'), 'панель перетаскивания блока на экране отображается');
      admDoc.getElementById('admLayoutDone').click();
      assert.ok(!admDoc.body.classList.contains('layout-edit-on'), 'режим редактирования блоков выключен');
    } finally {
      admIntervals.forEach((id) => domAdm.window.clearInterval(id));
      admTimeouts.forEach((id) => domAdm.window.clearTimeout(id));
      await new Promise((r) => setTimeout(r, 30));
      domAdm.window.close();
    }
  } finally {
    intervals.forEach((id) => dom.window.clearInterval(id));
    timeouts.forEach((id) => dom.window.clearTimeout(id));
    await new Promise((r) => setTimeout(r, 30));
    dom.window.close();
  }
});
