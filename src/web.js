const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const receipts = require('./receipts');
const captcha = require('./captcha');
const rates = require('./rates');
const { validateInitData, parseUser } = require('./validate');

const clientOrder = (o) => ({
  id: o.id,
  rub: o.rub,
  currency: o.currency,
  wallet: o.wallet,
  crypto: o.crypto,
  rate: o.rate,
  status: o.status,
  broker: o.broker || null,
  requisites: o.requisites,
  payRub: o.payRub,
  receipt: o.receipt || null,
  txUrl: o.txUrl || null,
  adminCalled: Boolean(o.adminCalled),
  adminCalledAt: o.adminCalledAt || null,
  review: (() => {
    const r = store.reviewForOrder(o.id);
    return r ? { id: r.id } : null; // статус модерации клиенту не раскрываем
  })(),
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

const clientUser = (u) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  referrer: u.referrer,
  referredCount: u.referredCount || 0,
});

const publicBrokerApp = (a) =>
  a ? { id: a.id, status: a.status, experience: a.experience, contact: a.contact, createdAt: a.createdAt } : null;

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
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html' || req.path === '/app.js' || req.path === '/devices.js' || req.path === '/theme.js')) {
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
          // Адрес нигде не показывается: он нужен только для кнопки меню Telegram.
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

  // Реальная история курса для графика в приложении: точки берутся из онлайна
  // за неделю с нашим процентом сверху и пополняются при каждом автообновлении.
  app.get('/api/rates/history', async (req, res) => {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 168));
    const since = Date.now() - hours * 3600 * 1000;
    if (rates.ensureRateHistory) {
      const cur = store.get().rateHistory || [];
      if (cur.length < 2) {
        await rates.ensureRateHistory({ hours }).catch(() => {});
      }
    }
    res.json({
      hours,
      updatedAt: store.get().settings.rateUpdatedAt,
      points: store.rateHistorySince(since, 180),
    });
  });

  app.get('/api/me', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.query.startParam || '');
    res.json({ me: clientUser(user), orders: store.userOrders(user.id).map(clientOrder) });
  });

  // Математическая капча: вопрос на создание заявки и форму «стать брокером».
  app.get('/api/captcha', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    res.json(captcha.issue());
  });

  const needCaptcha = (req, res) => {
    if (captcha.verify(req.body?.captchaId, req.body?.captchaAnswer)) return true;
    res.status(400).json({ error: 'Неверный ответ на проверочный вопрос', captcha: true });
    return false;
  };

  app.post('/api/orders', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!needCaptcha(req, res)) return;
    const s = store.get().settings;
    const currency = req.body.currency;
    const wallet = String(req.body.wallet || '').trim();
    if (!s.online) return res.status(403).json({ error: 'Обмен временно недоступен' });
    if (!['BTC', 'GRAM'].includes(currency)) return res.status(400).json({ error: 'Неизвестная валюта' });
    const rate = currency === 'BTC' ? s.rateBTC : s.rateGRAM;
    let rub = Number(req.body.rub);
    let crypto = null;
    const hasRub = req.body.rub !== undefined && req.body.rub !== null && req.body.rub !== '';
    if (hasRub) {
      if (!isFinite(rub) || rub <= 0) return res.status(400).json({ error: `Минимальная сумма — ${s.minRub} ₽` });
    } else {
      const amount = Number(req.body.cryptoAmount);
      if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: `Минимальная сумма — ${s.minRub} ₽` });
      rub = Math.ceil(amount * rate - 1e-6);
      if (!isFinite(rub)) return res.status(400).json({ error: `Максимальная сумма — ${s.maxRub} ₽` });
      crypto = amount;
    }
    if (rub < s.minRub) return res.status(400).json({ error: `Минимальная сумма — ${s.minRub} ₽` });
    if (rub > s.maxRub) return res.status(400).json({ error: `Максимальная сумма — ${s.maxRub} ₽` });
    if (wallet.length < 26 || wallet.length > 128 || /\s/.test(wallet))
      return res.status(400).json({ error: 'Проверьте адрес кошелька' });
    const user = store.touchUser(a.user, req.body.startParam || '');
    const officialRate = currency === 'BTC' ? s.baseRateBTC : s.baseRateGRAM;
    const order = store.createOrder({
      userId: String(user.id),
      userName: user.name,
      userUsername: user.username,
      rub,
      currency,
      wallet,
      rate,
      officialRate: officialRate || null,
      crypto: crypto ?? rub / rate,
      referrer: user.referrer,
    });
    bus.emit('order_event', { order, type: 'new' });
    res.json({ order: clientOrder(order) });
  });

  app.get('/api/order/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    res.json({ order: clientOrder(o) });
  });

  app.post('/api/order/:id/assign-broker', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (o.status !== 'new') return res.status(400).json({ error: 'Заявка уже обрабатывается' });
    let broker = req.body?.broker;
    if (!broker || !store.isAdminBroker(broker)) {
      broker = store.getRandomAdminBroker();
    }
    const upd = store.updateOrder(o.id, { broker });
    bus.emit('order_event', { order: upd, type: 'broker_assigned' });
    res.json({ order: clientOrder(upd) });
  });

  app.post('/api/order/:id/receipt', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (!['details', 'paid'].includes(o.status)) {
      return res.status(400).json({ error: 'Чек можно прикрепить только после выдачи реквизитов' });
    }
    const filename = String(req.body?.filename || '').slice(0, 120);
    let data = String(req.body?.data || '');
    if (!/\.pdf$/i.test(filename)) return res.status(400).json({ error: 'Нужен файл в формате PDF' });
    const m = data.match(/^data:application\/pdf;base64,/i);
    if (m) data = data.slice(m[0].length);
    if (!data || data.length > Math.ceil(receipts.MAX_BYTES * 4 / 3) + 1024) {
      return res.status(400).json({ error: 'PDF должен весить до 8 МБ' });
    }
    let buf;
    try {
      buf = Buffer.from(data, 'base64');
    } catch {
      return res.status(400).json({ error: 'Не удалось прочитать файл' });
    }
    if (buf.length === 0 || buf.length > receipts.MAX_BYTES) {
      return res.status(400).json({ error: 'PDF должен весить до 8 МБ' });
    }
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({ error: 'Файл не похож на PDF' });
    }
    try {
      receipts.save(o.id, buf);
    } catch (e) {
      console.error('[web] receipt save:', e.message);
      return res.status(500).json({ error: 'Не удалось сохранить чек, попробуйте позже' });
    }
    const upd = store.setReceipt(o.id, { name: filename, size: buf.length, at: Date.now() });
    bus.emit('order_event', { order: upd, type: 'receipt' });
    res.json({ order: clientOrder(upd) });
  });

  app.get('/api/order/:id/receipt', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (!o.receipt || !receipts.exists(o.id)) return res.status(404).json({ error: 'Чек не найден' });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="check-${o.id}.pdf"`);
    res.sendFile(receipts.filePath(o.id));
  });

  app.post('/api/order/:id/paid', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (o.status === 'details') {
      if (!o.receipt) {
        return res.status(400).json({ error: 'Сначала прикрепите чек в формате PDF' });
      }
      const upd = store.updateOrder(o.id, { status: 'paid' });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  app.post('/api/order/:id/cancel', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (['new', 'details'].includes(o.status)) {
      const upd = store.updateOrder(o.id, { status: 'cancelled' });
      bus.emit('order_event', { order: upd, type: 'cancelled' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  app.post('/api/order/:id/call-admin', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    const upd = store.updateOrder(o.id, { adminCalled: true, adminCalledAt: Date.now() });
    const brokerName = upd.broker || 'не назначен';
    const userMsg = store.createSupportMessage(
      a.user.id,
      'user',
      `🆘 Вызов администратора по заявке #${o.id}. Брокер сделки: ${brokerName}. Нужна помощь в сделке / возникли проблемы.`
    );
    const adminMsg = store.createSupportMessage(
      a.user.id,
      'admin',
      `🛡️ Вызов принят. Администратор PRICELEX подключается к чату по заявке #${o.id}. Напоминаем: брокер торгует под гарантией своего депозита, поэтому средства клиента защищены. Напишите, пожалуйста, в чём возникла проблема — мы поможем завершить обмен или компенсируем средства из депозита брокера.`
    );
    bus.emit('support_message', { message: userMsg, user: a.user });
    bus.emit('support_message', { message: adminMsg, user: { id: a.user.id } });
    bus.emit('order_event', { order: upd, type: 'admin_called' });
    res.json({ ok: true, order: clientOrder(upd) });
  });

  /* ---------- отзывы ---------- */
  // Посетители видят только одобренные отзывы, автор — ещё и свои (как опубликованные).
  app.get('/api/reviews', (req, res) => {
    const a = auth(req);
    res.json(store.publicReviews(100, a ? a.user.id : null));
  });

  // Отзыв можно оставить только по своей завершённой заявке — один на заявку.
  app.post('/api/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.body?.orderId);
    if (!o || o.userId !== String(a.user.id)) {
      return res.status(403).json({ error: 'Отзыв можно оставить только после вашего обмена' });
    }
    if (o.status !== 'completed') {
      return res.status(403).json({ error: 'Отзыв доступен после завершения обмена' });
    }
    if (store.reviewForOrder(o.id)) return res.status(409).json({ error: 'Отзыв по этой заявке уже оставлен' });
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Поставьте оценку от 1 до 5' });
    const text = String(req.body?.text || '').trim();
    if (text.length < 5) return res.status(400).json({ error: 'Напишите хотя бы пару слов (от 5 символов)' });
    if (text.length > store.REVIEW_TEXT_MAX) return res.status(400).json({ error: `Отзыв слишком длинный (до ${store.REVIEW_TEXT_MAX} символов)` });
    const user = store.touchUser(a.user, req.body.startParam || '');
    const review = store.createReview({ userId: user.id, orderId: o.id, name: user.name, rating, text, source: 'user' });
    bus.emit('review_event', { review, type: 'new' });
    res.json({ review: { ...store.publicReview(review), orderId: review.orderId }, order: clientOrder(o) });
  });

  /* ---------- заявка «стать брокером» ---------- */
  // Кандидат рассказывает про опыт и оставляет контакт; заявка уходит администрации.
  app.post('/api/broker/apply', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!needCaptcha(req, res)) return;
    const experience = String(req.body?.experience || '').trim();
    const contact = String(req.body?.contact || '').trim();
    if (experience.length < 10) return res.status(400).json({ error: 'Расскажите про опыт чуть подробнее (от 10 символов)' });
    if (experience.length > 1500) return res.status(400).json({ error: 'Описание опыта — до 1500 символов' });
    if (contact.length < 3) return res.status(400).json({ error: 'Оставьте контакт для связи' });
    if (contact.length > 200) return res.status(400).json({ error: 'Контакт — до 200 символов' });
    const existing = store.brokerAppFor(a.user.id);
    if (existing && existing.status === 'pending') {
      return res.status(409).json({ error: 'Ваша заявка уже на рассмотрении' });
    }
    const user = store.touchUser(a.user, req.body.startParam || '');
    const app0 = store.createBrokerApp({
      userId: String(user.id), name: user.name, username: user.username, experience, contact,
    });
    bus.emit('broker_event', { app: app0, type: 'new' });
    res.json({ application: publicBrokerApp(app0) });
  });

  app.get('/api/broker/status', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    res.json({ application: publicBrokerApp(store.brokerAppFor(a.user.id)) });
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
    app.post('/api/admin/order/:id/broker', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const broker = req.body?.broker || store.getRandomAdminBroker();
      const upd = store.updateOrder(o.id, { broker });
      bus.emit('order_event', { order: upd, type: 'broker_assigned' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/req', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const upd = store.updateOrder(o.id, {
        broker: o.broker || store.getRandomAdminBroker(),
        requisites: req.body.requisites || 'СБП: +7 999 123-45-67\nБанк: Т-Банк\nПолучатель: PRICELEX OFFICIAL',
        payRub: Number(req.body.payRub) || o.rub,
        status: 'details',
      });
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
    app.post('/api/admin/order/:id/tx', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const url = String(req.body?.txUrl || '').trim().slice(0, 800);
      if (!url) return res.status(400).json({ error: 'Ссылка не может быть пустой' });
      const upd = store.updateOrder(o.id, { txUrl: url });
      bus.emit('order_event', { order: upd, type: 'tx' });
      res.json({ order: clientOrder(upd) });
    });
    // Демо-модерация: публикует все отзывы, ожидающие проверки.
    app.post('/api/admin/reviews/approve-pending', (_req, res) => {
      const list = store.reviewsByStatus('pending').map((r) => store.updateReview(r.id, { status: 'approved' }));
      res.json({ approved: list.length });
    });
    app.post('/api/admin/review/:id/reply', (req, res) => {
      const r = store.getReview(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const text = String(req.body?.text || '').trim();
      if (!text) {
        const upd = store.updateReview(r.id, { reply: null });
        return res.json({ review: store.publicReview(upd) });
      }
      if (text.length > store.REVIEW_TEXT_MAX) {
        return res.status(400).json({ error: `Ответ слишком длинный (до ${store.REVIEW_TEXT_MAX} символов)` });
      }
      const at = Number.isFinite(Number(req.body?.at)) ? Number(req.body.at) : Date.now();
      const upd = store.updateReview(r.id, { reply: { text, at, by: 'demo' } });
      res.json({ review: store.publicReview(upd) });
    });
    app.post('/api/admin/settings', (req, res) => {
      const next = {};
      if (req.body?.announcement != null) next.announcement = String(req.body.announcement).slice(0, 500);
      if (req.body?.operator != null) next.operator = String(req.body.operator).trim().slice(0, 500);
      if (req.body?.channel != null) next.channel = String(req.body.channel).trim().slice(0, 500);
      if (Object.keys(next).length) store.mutate((db) => Object.assign(db.settings, next));
      res.json({ settings: store.publicSettings() });
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
