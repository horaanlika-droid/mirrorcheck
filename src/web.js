const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const currencies = require('./currencies');
const { validateInitData, parseUser } = require('./validate');
const admins = require('./admins');
const rates = require('./rates');

const clientOrder = (o) => ({
  id: o.id,
  direction: o.direction || 'sell',
  currency: o.currency,
  network: o.network || null,
  currencyLabel: currencies.label(o.currency),
  payoutCurrency: 'BTC',
  units: o.units ?? null,
  giftCode: o.giftCode || null,
  expiresAt: o.expiresAt ?? null,
  paidAt: o.paidAt || null,
  cancelReason: o.cancelReason || null,
  wallet: o.wallet,
  crypto: o.crypto,
  rate: o.rate,
  status: o.status,
  requisites: o.requisites,
  receipt: o.receipt || null,
  txUrl: o.txUrl || null,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

// isAdmin нужен приложению, чтобы показать «Админку» (правка ссылки на чат).
// В демо-режиме (BOT_TOKEN не задан) админка открыта всем — как и демо-пульт оператора.
const clientUser = (u) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  referrer: u.referrer,
  referredCount: u.referredCount || 0,
  isAdmin: admins.has(String(u.id)) || (!config.botToken && String(u.id) === '900001'),
});

function startWeb() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('query parser', 'extended');
  app.use(express.json({ limit: '12mb' }));

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, private');
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html' || req.path === '/app.js')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'GET') {
      const proto = String(req.get('x-forwarded-proto') || 'https').split(',')[0].trim();
      const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
      if (
        host &&
        !/^(localhost|127\.|0\.0\.0\.0|\[|192\.168\.|10\.)/.test(host) &&
        !host.includes('127.0.0.1')
      ) {
        const url = `${proto}://${host}`.replace(/\/+$/, '');
        if (url !== store.get().settings.publicUrl) {
          store.mutate((db) => {
            db.settings.publicUrl = url;
          });
          console.log('[PRICELEX] публичный адрес определён автоматически:', url);
          bus.emit('public_url', url);
        }
      }
    }
    next();
  });

  const auth = (req) => {
    const body = req.body || {};
    const q = req.query || {};
    const initData = body.initData || q.initData || '';
    if (config.botToken) {
      if (initData && validateInitData(initData, config.botToken)) {
        return { user: parseUser(initData), demo: false };
      }
      return null;
    }
    const d = body.demo || q.demo;
    if (d && d.id) {
      return { user: { id: String(d.id), first_name: d.name || 'Демо', username: d.username || '' }, demo: true };
    }
    return null;
  };

  const needAuth = (req, res) => {
    const a = auth(req);
    if (!a) {
      res.status(401).json({ error: 'unauthorized' });
      return null;
    }
    return a;
  };

  app.post('/api/init', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.body.startParam || '');
    res.json({ me: clientUser(user), settings: store.publicSettings(), demo: a.demo });
  });

  app.get('/api/settings', (req, res) => res.json(store.publicSettings()));

  const isAdminRequest = (req) => {
    const a = auth(req);
    if (!a) return null;
    const id = String(a.user.id);
    // В демо-режиме (BOT_TOKEN не задан) админка открыта только демо-гостю и админам — клиенты её не видят.
    return admins.has(id) || (!config.botToken && id === '900001') ? a : null;
  };

  // Админка: текущие значения всех редактируемых настроек.
  const adminSettingsBlock = () => {
    const s = store.get().settings;
    const on = (key) => currencies.isEnabled(s, key);
    return {
      chat: s.chat,
      giftPercent: s.giftPercent ?? 0,
      rateGOOGLEUSD: s.rateGOOGLEUSD ?? null,
      directions: Object.fromEntries(currencies.list().map((p) => [p.key, on(p.key)])),
      online: !!s.online,
    };
  };

  app.get('/api/admin/settings', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора PRICELEX' });
    res.json({ admin: adminSettingsBlock(), settings: store.publicSettings() });
  });

  const CLIENTS_ANNOUNCE_OPEN =
    '🟢 <b>PRICELEX: выкуп карт открыт!</b>\n\n' +
    'Снова принимаем заявки на выкуп USD gift-карт Google, iTunes, Xbox и Apple Store 🎁\n' +
    'Выплата в BTC без документов и регистрации — в приложении и в боте.';
const DIRECTION_KEYS = currencies.list().map((p) => p.key);
  const feeValue = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 50 ? Number(v) : null);

  // Админка: частичное обновление настроек (чат, направления карт, комиссия карты, онлайн).
  app.post('/api/admin/settings', async (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора PRICELEX' });
    const body = req.body || {};
    const patch = {};
    // 1) Направления (вкл/выкл)
    if (body.enabled && typeof body.enabled === 'object') {
      const map = {};
      for (const key of Object.keys(body.enabled)) {
        if (!DIRECTION_KEYS.includes(key)) return res.status(400).json({ error: `Неизвестное направление: ${key}` });
        if (typeof body.enabled[key] !== 'boolean') return res.status(400).json({ error: 'enabled: только true/false' });
        map[key] = body.enabled[key];
      }
      patch.enabled = map;
    }
    // 2) Гифт-карта: комиссия (0–50% от BTC-эквивалента номинала).
    if (body.giftPercent !== undefined) {
      const v = feeValue(body.giftPercent);
      if (v === null) return res.status(400).json({ error: 'Комиссия карты — число от 0 до 50 (%).' });
      patch.giftPercent = v;
    }
    // 3) Открытие/закрытие выкупа
    let openTrading = null;
    if (body.online !== undefined) {
      if (typeof body.online !== 'boolean') return res.status(400).json({ error: 'online: только true/false' });
      openTrading = body.online;
    }
    // 4) Ссылка на чат
    if (body.chat !== undefined) {
      const chat = String(body.chat || '').trim().slice(0, 300);
      if (chat.length < 8 || !(chat.startsWith('https://') || /^@[A-Za-z0-9_]{5,32}$/.test(chat))) {
        return res.status(400).json({ error: 'Укажите ссылку t.me/… или юзернейм @…' });
      }
      patch.chat = chat;
    }
    if (openTrading !== null) patch.online = openTrading;
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Нечего обновлять — пришлите хотя бы одно поле.' });
    }
    const wasOnline = !!store.get().settings.online;
    store.mutate((db) => {
      const s = db.settings;
      if (patch.enabled) {
        s.enabled = { ...(s.enabled || {}), ...patch.enabled };
      }
      for (const key of ['giftPercent', 'chat', 'online']) {
        if (patch[key] !== undefined) s[key] = patch[key];
      }
      // Комиссия карты пересчитывает итоговый курс BTC за $1.
      if (patch.giftPercent !== undefined) {
        rates.recomputeGiftRate();
      }
    });
    // Открытие торгов: рассылаем клиентам объявление о начале выкупа.
    let announced = 0;
    if (!wasOnline && patch.online === true) {
      const results = await bus.emit('announce', { text: CLIENTS_ANNOUNCE_OPEN });
      announced = (results && results[0] && results[0].sent) || 0;
    }
    res.json({ settings: store.publicSettings(), admin: adminSettingsBlock(), announced });
  });

  // Админка: смена ссылки на чат — сразу видна всем на сайте и в приложении.
  app.post('/api/admin/settings/chat', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (config.botToken && !admins.has(String(a.user.id))) {
      return res.status(403).json({ error: 'Только для оператора PRICELEX' });
    }
    const chat = String(req.body?.chat || '').trim().slice(0, 300);
      if (chat.length < 8 || !(chat.startsWith('https://') || /^@[A-Za-z0-9_]{5,32}$/.test(chat))) {
      return res.status(400).json({ error: 'Укажите ссылку t.me/… или юзернейм @… (например https://t.me/+abc или @support_team)' });
    }
    store.mutate((db) => { db.settings.chat = chat; });
    res.json({ settings: store.publicSettings() });
  });

  app.get('/api/me', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.query.startParam || '');
    res.json({ me: clientUser(user), orders: store.userOrders(user.id).map(clientOrder) });
  });

  app.post('/api/orders', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const s = store.get().settings;
    const currency = String(req.body.currency || '').toUpperCase();
    const pair = currencies.find(currency);
    const wallet = String(req.body.wallet || '').trim();
    if (!s.online) return res.status(403).json({ error: 'Обмен временно недоступен' });
    if (!pair || pair.kind !== 'gift') return res.status(400).json({ error: 'Неизвестная валюта' });
    if (!currencies.isEnabled(s, pair.key)) {
      return res.status(400).json({ error: `Выкуп ${pair.label} временно не проводится — выберите другую карту.` });
    }
    const user = store.touchUser(a.user, req.body.startParam || '');

    /* ---------- гифт-карта → BTC ---------- */
    const units = Number(req.body.units ?? req.body.cryptoAmount);
    const unitsError = currencies.validateUnits(units);
    if (unitsError) return res.status(400).json({ error: unitsError });
    // Важно: код карты НЕ собираем при создании заявки. Клиент присылает его только
    // после того, как оператор подключится — ничего не отправляется без команды оператора.
    // Старый клиент может прислать код сразу: поддерживаем для совместимости.
    const giftCodeRaw = String(req.body.giftCode || '').trim();
    let giftCode = null;
    if (giftCodeRaw) {
      if (giftCodeRaw.length < 8 || giftCodeRaw.length > 200 || /\s{2,}/.test(giftCodeRaw)) {
        return res.status(400).json({ error: 'Код подарочной карты: 8–200 символов, без двойных пробелов.' });
      }
      giftCode = giftCodeRaw;
    }
    const walletError = currencies.validateWallet(wallet);
    if (walletError) return res.status(400).json({ error: pair.walletError });
    const payout = currencies.giftPayout(s, units, pair.currency);
    if (!payout) {
      return res.status(400).json({ error: 'Курс BTC для выплаты временно недоступен — попробуйте позже.' });
    }
    if (!(payout.crypto > 0)) {
      return res.status(400).json({ error: 'Слишком маленькая сумма к выплате — увеличьте номинал карты.' });
    }
    const ttlMinutes = Number(pair.ttlMinutes) || 60;
    const order = store.createOrder({
      userId: String(user.id),
      userName: user.name,
      userUsername: user.username,
      expiresAt: Date.now() + ttlMinutes * 60 * 1000, // час на сделку
      units,
      currency: pair.currency,
      giftCode,
      wallet,
      rate: payout.rate,
      crypto: payout.crypto,
      referrer: user.referrer,
    });
    bus.emit('order_event', { order, type: 'new' });
    return res.json({ order: clientOrder(order) });
  });

  app.get('/api/order/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    res.json({ order: clientOrder(store.expireIfNeeded(found) || found) });
  });

  app.post('/api/order/:id/paid', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    const o = store.expireIfNeeded(found);
    // Гифт-карта: «Я оплатил» = клиент подтверждает сделку.
    // Заявка БЕЗ кода (новая двухфазная схема) так не подтверждается — сначала оператор
    // подключается, потом клиент присылает код.
    if (o.status === 'new') {
      if (!o.giftCode) {
        return res.status(400).json({ error: 'Дождитесь подключения оператора — код карты отправляется только после его команды.' });
      }
      const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    if (o.status === 'details') {
      // Гифт-карта в статусе «оператор подключился»: код ещё не прислан.
      if (!o.giftCode) {
        return res.status(400).json({ error: 'Сначала отправьте код карты — оператор на связи.' });
      }
      const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  // Код карты: клиент присылает его ТОЛЬКО после подключения оператора.
  // Прислан код → заявка переходит в «paid» (код на проверку) — оператор получает broadcast.
  app.post('/api/order/:id/code', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    const o = store.expireIfNeeded(found);
    if (['completed', 'rejected', 'cancelled'].includes(o.status)) {
      return res.status(400).json({ error: 'По этой заявке код уже не принимается.' });
    }
    if (o.status === 'paid') return res.json({ order: clientOrder(o) }); // идемпотентно
    if (!['details', 'new'].includes(o.status)) {
      return res.status(400).json({ error: 'Код сейчас не принимается — дождитесь оператора.' });
    }
    // Новая двухфазная заявка (ещё без кода) принимает код только в статусе «details» (оператор подключился).
    if (!o.giftCode && o.status !== 'details') {
      return res.status(400).json({ error: 'Дождитесь подключения оператора — код карты отправляется только после его команды.' });
    }
    const giftCode = String(req.body.giftCode || '').trim();
    if (giftCode.length < 8 || giftCode.length > 200 || /\s{2,}/.test(giftCode)) {
      return res.status(400).json({ error: 'Код подарочной карты: 8–200 символов, без двойных пробелов.' });
    }
    const upd = store.updateOrder(o.id, { giftCode, status: 'paid', paidAt: Date.now() });
    bus.emit('order_event', { order: upd, type: 'paid' });
    return res.json({ order: clientOrder(upd) });
  });

  app.post('/api/order/:id/cancel', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    const o = store.expireIfNeeded(found);
    if (o.status === 'cancelled' && o.cancelReason === store.EXPIRED) {
      return res.status(400).json({ error: `${store.EXPIRED} — создайте новую заявку.` });
    }
    if (['new', 'details'].includes(o.status)) {
      const upd = store.updateOrder(o.id, { status: 'cancelled' });
      bus.emit('order_event', { order: upd, type: 'cancelled' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  /* ---------- support chat ---------- */
  app.get('/api/support/messages', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const msgs = store.getSupportMessages(a.user.id);
    res.json({ messages: msgs });
  });

  app.post('/api/support/message', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    if (text.length > 2000) return res.status(400).json({ error: 'Сообщение слишком длинное (до 2000 символов)' });
    store.touchUser(a.user, req.body.startParam || '');
    const msg = store.createSupportMessage(a.user.id, 'user', text);
    bus.emit('support_message', { message: msg, user: a.user });
    res.json({ message: msg });
  });

  app.post('/api/support/read', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    res.json({ ok: true });
  });

  // ДЕМО-пульт оператора: существует ТОЛЬКО когда BOT_TOKEN не задан (превью без бота).
  if (!config.botToken) {
    // Демо: оператор подключается к gift-заявке — клиент получает возможность отправить код.
    app.post('/api/admin/order/:id/connect', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      if (o.status !== 'new') return res.status(400).json({ error: 'Заявка уже в работе' });
      const upd = store.updateOrder(o.id, { status: 'details' });
      bus.emit('order_event', { order: upd, type: 'details' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/confirm', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const upd = store.updateOrder(o.id, { status: 'completed' });
      bus.emit('order_event', { order: upd, type: 'completed' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/reject', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const upd = store.updateOrder(o.id, { status: 'rejected' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/cancel', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const upd = store.updateOrder(o.id, { status: 'cancelled' });
      bus.emit('order_event', { order: upd, type: 'cancelled' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/support/:userId/reply', (req, res) => {
      const userId = String(req.params.userId);
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'empty' });
      const msg = store.createSupportMessage(userId, 'admin', text);
      bus.emit('support_message', { message: msg, user: { id: userId } });
      res.json({ message: msg });
    });
  }

  const publicDir = path.join(__dirname, '..', 'public');
  const indexFile = path.join(publicDir, 'index.html');

  app.get('/health', (_req, res) => res.json({ ok: true, name: 'PRICELEX' }));
  // Reuse the original dollar-note artwork already tracked in the repository.
  app.get('/dollar-background.jpeg', (_req, res) =>
    res.sendFile(path.join(__dirname, '..', 'IMG_1211.jpeg'))
  );
  app.use(express.static(publicDir));
  app.use((req, res) => res.sendFile(indexFile));

  const server = app.listen(config.port, config.host, () => {
    console.log(
      `[PRICELEX] веб-сервер слушает ${config.host}:${config.port} (источник порта: ${config.portSource})`
    );
    console.log('[PRICELEX] откройте этот URL в браузере — должна открыться страница обменника, а не «Bot is running»');
  });
  server.on('error', (e) => {
    console.error(`[PRICELEX] не удалось занять ${config.host}:${config.port}:`, e.message);
    if (e && e.code === 'EADDRINUSE') {
      console.error(
        '[PRICELEX] Порт занят. На бот-хостинге в Startup укажите Main File = index.js и не задавайте PORT вручную — нужен SERVER_PORT панели.'
      );
    }
    process.exit(1);
  });
  return server;
}

module.exports = { startWeb };
