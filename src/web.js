const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const currencies = require('./currencies');
const { validateInitData, parseUser } = require('./validate');
const admins = require('./admins');

const clientOrder = (o, reviewedIds) => ({
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
  reviewed: reviewedIds ? reviewedIds.has(Number(o.id)) : !!store.getReviewByOrder(o.id),
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

// isAdmin is needed by the app to show "Admin" (chat-link editing).
// In demo mode (BOT_TOKEN unset) the admin panel is open to everyone — like the demo operator console.
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
          console.log('[Pricelex Worldwide] public address auto-detected:', url);
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
      return { user: { id: String(d.id), first_name: d.name || 'Demo', username: d.username || '' }, demo: true };
    }
    return null;
  };

  const needAuth = (req, res) => {
    const a = auth(req);
    if (!a) {
      res.status(401).json({ error: 'Не авторизован' });
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
    // In demo mode (BOT_TOKEN unset) the admin panel is open only to the demo guest and admins — clients don't see it.
    return admins.has(id) || (!config.botToken && id === '900001') ? a : null;
  };

  // Админ: все редактируемые настройки. Курс и скидка отдаются для каждой карты отдельно.
  const adminSettingsBlock = () => {
    const s = store.get().settings;
    const on = (key) => currencies.isEnabled(s, key);
    return {
      chat: s.chat,
      btcUsd: s.btcUsd,
      cardFees: Object.fromEntries(currencies.GIFT_KEYS.map((key) => [key, currencies.feeOf(s, key)])),
      cardRates: currencies.allCardRates(s),
      directions: Object.fromEntries(currencies.list().map((p) => [p.key, on(p.key)])),
      online: !!s.online,
    };
  };

  app.get('/api/admin/settings', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    res.json({ admin: adminSettingsBlock(), settings: store.publicSettings() });
  });

  const CLIENTS_ANNOUNCE_OPEN =
    '🟢 <b>Pricelex Worldwide: приём карт открыт!</b>\n\n' +
    'Снова принимаем подарочные карты Google, iTunes, Xbox и Apple Store региона США в USD 🎁\n' +
    'У каждой карты свой курс, выплата в BTC, без документов и регистрации — в приложении и в боте.';
  const DIRECTION_KEYS = currencies.list().map((p) => p.key);
  const feeValue = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 50 ? Number(v) : null);

  // Админ: частичное обновление настроек (направления, курсы карт, чат, приём заявок).
  app.post('/api/admin/settings', async (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const body = req.body || {};
    const patch = {};
    // 1) Включение/выключение направлений
    if (body.enabled && typeof body.enabled === 'object') {
      const map = {};
      for (const key of Object.keys(body.enabled)) {
        if (!DIRECTION_KEYS.includes(key)) return res.status(400).json({ error: `Неизвестное направление: ${key}` });
        if (typeof body.enabled[key] !== 'boolean') return res.status(400).json({ error: 'enabled: только true или false' });
        map[key] = body.enabled[key];
      }
      patch.enabled = map;
    }
    // 2) Индивидуальные скидки карт → у каждой карты свой курс выплаты.
    //    cardFees: { GOOGLE_USD: 5, ITUNES_USD: 12, ... } — можно менять одну карту, остальные не затрагиваются.
    let cardFeesPatch = null;
    if (body.cardFees !== undefined) {
      if (!body.cardFees || typeof body.cardFees !== 'object' || Array.isArray(body.cardFees)) {
        return res.status(400).json({ error: 'cardFees: ожидается объект с курсами по картам.' });
      }
      const map = {};
      for (const [key, value] of Object.entries(body.cardFees)) {
        if (!DIRECTION_KEYS.includes(key)) return res.status(400).json({ error: `Неизвестная карта: ${key}` });
        const v = feeValue(value);
        if (v === null) return res.status(400).json({ error: `Скидка для ${currencies.label(key)}: число от 0 до 50 (%).` });
        map[key] = v;
      }
      if (Object.keys(map).length) cardFeesPatch = map;
    }
    // Совместимость со старым полем giftPercent: применяет одну скидку ко всем картам.
    if (body.giftPercent !== undefined) {
      const v = feeValue(body.giftPercent);
      if (v === null) return res.status(400).json({ error: 'Скидка карты: число от 0 до 50 (%).' });
      cardFeesPatch = Object.fromEntries(DIRECTION_KEYS.map((key) => [key, v]));
    }
    // 3) Открытие/закрытие приёма заявок
    let openTrading = null;
    if (body.online !== undefined) {
      if (typeof body.online !== 'boolean') return res.status(400).json({ error: 'online: только true или false' });
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
    if (!Object.keys(patch).length && !cardFeesPatch) {
      return res.status(400).json({ error: 'Нечего обновлять — передайте хотя бы одно поле.' });
    }
    const wasOnline = !!store.get().settings.online;
    store.mutate((db) => {
      const s = db.settings;
      if (patch.enabled) {
        s.enabled = { ...(s.enabled || {}), ...patch.enabled };
      }
      for (const key of ['chat', 'online']) {
        if (patch[key] !== undefined) s[key] = patch[key];
      }
      if (cardFeesPatch) {
        s.cardFees = { ...(s.cardFees || {}), ...cardFeesPatch };
        s.cardRates = currencies.allCardRates(s);
      }
    });
    // Открытие приёма: рассылаем объявление клиентам.
    let announced = 0;
    if (!wasOnline && patch.online === true) {
      const results = await bus.emit('announce', { text: CLIENTS_ANNOUNCE_OPEN });
      announced = (results && results[0] && results[0].sent) || 0;
    }
    res.json({ settings: store.publicSettings(), admin: adminSettingsBlock(), announced });
  });

  // Admin: changing the chat link — instantly visible to everyone on the site and in the app.
  app.post('/api/admin/settings/chat', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (config.botToken && !admins.has(String(a.user.id))) {
      return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
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
    const reviewedIds = store.getReviewedOrderIds();
    res.json({ me: clientUser(user), orders: store.userOrders(user.id).map((o) => clientOrder(o, reviewedIds)) });
  });

  app.post('/api/orders', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const s = store.get().settings;
    const currency = String(req.body.currency || '').toUpperCase();
    const pair = currencies.find(currency);
    const wallet = String(req.body.wallet || '').trim();
    if (!s.online) return res.status(403).json({ error: 'Обмен временно недоступен' });
    if (!pair || pair.kind !== 'gift') return res.status(400).json({ error: 'Неизвестная карта' });
    if (!currencies.isEnabled(s, pair.key)) {
      return res.status(400).json({ error: `Выкуп ${pair.label} временно недоступен — выберите другую карту.` });
    }
    const user = store.touchUser(a.user, req.body.startParam || '');

    /* ---------- gift card → BTC ---------- */
    const units = Number(req.body.units ?? req.body.cryptoAmount);
    const unitsError = currencies.validateUnits(units);
    if (unitsError) return res.status(400).json({ error: unitsError });
    // Important: the card code is NOT collected at order creation. The client sends it only
    // after the operator joins — nothing is sent without the operator's command.
    // A legacy client may send the code right away: supported for compatibility.
    const giftCodeRaw = String(req.body.giftCode || '').trim();
    let giftCode = null;
    if (giftCodeRaw) {
      if (giftCodeRaw.length < 8 || giftCodeRaw.length > 200 || /\s{2,}/.test(giftCodeRaw)) {
        return res.status(400).json({ error: 'Код карты: от 8 до 200 символов, без двойных пробелов.' });
      }
      giftCode = giftCodeRaw;
    }
    const walletError = currencies.validateWallet(wallet);
    if (walletError) return res.status(400).json({ error: pair.walletError });
    const payout = currencies.giftPayout(s, units, pair.currency);
    if (!payout) {
      return res.status(400).json({ error: 'Курс выплаты в BTC временно недоступен — попробуйте позже.' });
    }
    if (!(payout.crypto > 0)) {
      return res.status(400).json({ error: 'Сумма выплаты слишком мала — увеличьте номинал карты.' });
    }
    const ttlMinutes = Number(pair.ttlMinutes) || 60;
    const order = store.createOrder({
      userId: String(user.id),
      userName: user.name,
      userUsername: user.username,
      expiresAt: Date.now() + ttlMinutes * 60 * 1000, // one hour per deal
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
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'Заявка не найдена' });
    res.json({ order: clientOrder(store.expireIfNeeded(found) || found) });
  });

  app.post('/api/order/:id/paid', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'Заявка не найдена' });
    const o = store.expireIfNeeded(found);
    // Gift card: "I paid" = the client confirms the deal.
    // An order WITHOUT a code (the new two-phase scheme) cannot be confirmed this way — first the operator
    // joins, then the client sends the code.
    if (o.status === 'new') {
      if (!o.giftCode) {
        return res.status(400).json({ error: 'Дождитесь оператора — код карты отправляется только после его запроса.' });
      }
      const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    if (o.status === 'details') {
      // Gift card in the "operator joined" status: the code has not been sent yet.
      if (!o.giftCode) {
        return res.status(400).json({ error: 'Сначала отправьте код карты — оператор на связи.' });
      }
      const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  // Card code: the client sends it ONLY after the operator joins.
  // Code received → the order moves to "paid" (code under review) — the operator gets a broadcast.
  app.post('/api/order/:id/code', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'Заявка не найдена' });
    const o = store.expireIfNeeded(found);
    if (['completed', 'rejected', 'cancelled'].includes(o.status)) {
      return res.status(400).json({ error: 'Эта заявка больше не принимает код.' });
    }
    if (o.status === 'paid') return res.json({ order: clientOrder(o) }); // idempotent
    if (!['details', 'new'].includes(o.status)) {
      return res.status(400).json({ error: 'Код сейчас не принимается — дождитесь оператора.' });
    }
    // A new two-phase order (no code yet) accepts the code only in the "details" status (operator joined).
    if (!o.giftCode && o.status !== 'details') {
      return res.status(400).json({ error: 'Дождитесь оператора — код карты отправляется только после его запроса.' });
    }
    const giftCode = String(req.body.giftCode || '').trim();
    if (giftCode.length < 8 || giftCode.length > 200 || /\s{2,}/.test(giftCode)) {
      return res.status(400).json({ error: 'Код карты: от 8 до 200 символов, без двойных пробелов.' });
    }
    const upd = store.updateOrder(o.id, { giftCode, status: 'paid', paidAt: Date.now() });
    bus.emit('order_event', { order: upd, type: 'paid' });
    return res.json({ order: clientOrder(upd) });
  });

  app.post('/api/order/:id/cancel', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'Заявка не найдена' });
    const o = store.expireIfNeeded(found);
    if (o.status === 'cancelled' && (o.cancelReason === store.EXPIRED || o.cancelReason === store.EXPIRED_LEGACY)) {
      return res.status(400).json({ error: 'Время на сделку истекло — создайте новую заявку.' });
    }
    if (['new', 'details'].includes(o.status)) {
      const upd = store.updateOrder(o.id, { status: 'cancelled' });
      bus.emit('order_event', { order: upd, type: 'cancelled' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  /* ---------- reviews ---------- */
  // Review showcase: the client leaves a review after a completed deal (one per order),
  // the operator can add any review manually via the admin panel.
  app.get('/api/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const all = store.listReviews(500);
    res.json({
      summary: store.reviewSummary(all),
      reviews: all.slice(0, 100).map(store.publicReview),
    });
  });

  app.post('/api/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const b = req.body || {};
    const order = store.getOrder(b.orderId);
    if (!order || order.userId !== String(a.user.id)) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Отзыв можно оставить после завершения сделки.' });
    }
    if (store.getReviewByOrder(order.id)) {
      return res.status(409).json({ error: 'Вы уже оставили отзыв по этой сделке.' });
    }
    const rating = Math.round(Number(b.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Оценка: от 1 до 5 звёзд.' });
    }
    const text = String(b.text || '').trim().slice(0, 1000);
    const user = store.touchUser(a.user, b.startParam || '');
    const review = store.createReview({ userId: user.id, orderId: order.id, name: user.name, rating, text, source: 'order' });
    res.json({ review: store.publicReview(review), order: clientOrder(order, new Set([Number(order.id)])) });
  });

  // Admin: full list for management (deletion) + manual adding.
  app.get('/api/admin/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const all = store.listReviews(500);
    res.json({
      summary: store.reviewSummary(all),
      reviews: all.map((r) => ({ ...store.publicReview(r), orderId: r.orderId ?? null })),
    });
  });

  app.post('/api/admin/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60) || 'Pricelex Worldwide';
    const rating = Math.round(Number(b.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Оценка: от 1 до 5 звёзд.' });
    }
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Добавьте текст отзыва.' });
    if (text.length > 1000) return res.status(400).json({ error: 'Отзыв ограничен 1000 символов.' });
    const review = store.createReview({ userId: null, orderId: null, name, rating, text, source: 'admin' });
    res.json({ review: store.publicReview(review) });
  });

  app.delete('/api/admin/reviews/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const removed = store.deleteReview(req.params.id);
    res.json({ ok: removed > 0 });
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

  // DEMO operator console: exists ONLY when BOT_TOKEN is unset (preview without the bot).
  if (!config.botToken) {
    // Demo: the operator joins the gift order — the client can now send the code.
    app.post('/api/admin/order/:id/connect', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Заявка не найдена' });
      if (o.status !== 'new') return res.status(400).json({ error: 'Заявка уже в работе' });
      const upd = store.updateOrder(o.id, { status: 'details' });
      bus.emit('order_event', { order: upd, type: 'details' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/confirm', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Заявка не найдена' });
      const upd = store.updateOrder(o.id, { status: 'completed' });
      bus.emit('order_event', { order: upd, type: 'completed' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/reject', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Заявка не найдена' });
      const upd = store.updateOrder(o.id, { status: 'rejected' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/cancel', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Заявка не найдена' });
      const upd = store.updateOrder(o.id, { status: 'cancelled' });
      bus.emit('order_event', { order: upd, type: 'cancelled' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/support/:userId/reply', (req, res) => {
      const userId = String(req.params.userId);
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
      const msg = store.createSupportMessage(userId, 'admin', text);
      bus.emit('support_message', { message: msg, user: { id: userId } });
      res.json({ message: msg });
    });
  }

  const publicDir = path.join(__dirname, '..', 'public');
  const indexFile = path.join(publicDir, 'index.html');

  app.get('/health', (_req, res) => res.json({ ok: true, name: 'Pricelex Worldwide' }));
  app.use(express.static(publicDir));
  app.use((req, res) => res.sendFile(indexFile));

  const server = app.listen(config.port, config.host, () => {
    console.log(
      `[Pricelex Worldwide] web server listening on ${config.host}:${config.port} (port source: ${config.portSource})`
    );
    console.log('[Pricelex Worldwide] откройте этот адрес в браузере — должна быть страница обмена, а не «Bot is running»');
  });
  server.on('error', (e) => {
    console.error(`[Pricelex Worldwide] could not bind ${config.host}:${config.port}:`, e.message);
    if (e && e.code === 'EADDRINUSE') {
      console.error(
        '[Pricelex Worldwide] Порт занят. На бот-хостинге укажите Main File = index.js и не задавайте PORT вручную — нужен SERVER_PORT панели.'
      );
    }
    process.exit(1);
  });
  return server;
}

module.exports = { startWeb };
