const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const receipts = require('./receipts');
const captcha = require('./captcha');
const rates = require('./rates');
const { validateInitData, parseUser } = require('./validate');
const exchangers = require('./exchangers');
const deposits = require('./deposits');
const claims = require('./claims');
const subscriptions = require('./subscriptions');
const marketplace = require('./marketplace');
const walletProvider = require('./walletProvider');
const audit = require('./audit');

const clientOrder = (o) => ({
  id: o.id,
  rub: o.rub,
  currency: o.currency,
  wallet: o.wallet,
  crypto: o.crypto,
  rate: o.rate,
  status: o.status,
  broker: o.broker || null,
  exchangerId: o.exchangerId || null,
  requisites: o.requisites,
  payRub: o.payRub,
  receipt: o.receipt || null,
  txUrl: o.txUrl || null,
  adminCalled: Boolean(o.adminCalled),
  adminCalledAt: o.adminCalledAt || null,
  review: (() => {
    const r = store.reviewForOrder(o.id);
    return r ? { id: r.id } : null;
  })(),
  claim: (() => {
    const list = (store.get().claims || []).filter((c) => String(c.orderId) === String(o.id));
    const open = list.find((c) => ['open', 'under_review'].includes(c.status));
    return open ? { id: open.id, status: open.status } : null;
  })(),
  bidUntil: o.bidUntil || null,
  acceptedBidId: o.acceptedBidId || null,
  bids: ['collecting', 'new'].includes(o.status) ? store.activeBidsForOrder(o.id).length : 0,
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

// Отклик брокера глазами клиента: цена, сколько получит, и карточка брокера.
const clientBid = (b, order) => {
  const rate = Number(b.rate) || 0;
  const byCrypto = Boolean(order.byCrypto) && Number(order.crypto) > 0;
  const crypto = byCrypto ? Number(order.crypto) : Math.floor(((Number(order.rub) || 0) / rate) * 1e8 + 1e-6) / 1e8;
  const payRub = byCrypto ? Math.ceil(crypto * rate - 1e-6) : Math.round(Number(order.rub) || 0);
  return {
    id: b.id,
    rate,
    crypto,
    payRub,
    note: b.note || '',
    createdAt: b.createdAt,
    broker: store.brokerCard(b.login),
  };
};

const offersWindowSec = (s) => {
  const v = Number(s.offerWindowSec);
  return Number.isFinite(v) && v >= 15 && v <= 3600 ? Math.round(v) : 120;
};

// Подписка глазами клиента: без служебных полей.
const publicSubscription = (sub) =>
  sub ? {
    status: sub.status,
    amount: sub.amount,
    currency: sub.currency,
    until: sub.currentPeriodEnd || null,
    lastPaymentAt: sub.lastPaymentAt || null,
    requestedAt: sub.requestedAt || null,
  } : null;

const publicBrokerApp = (a) =>
  a ? { id: a.id, status: a.status, experience: a.experience, contact: a.contact, createdAt: a.createdAt } : null;

function isValidPublicHost(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.trim();
  if (!h) return false;
  if (h.length > 253) return false;
  if (/[\s<>]/.test(h)) return false;
  if (/^(localhost|127\.|0\.0\.0\.0|\[|192\.168\.|10\.)/.test(h)) return false;
  if (h.includes('127.0.0.1')) return false;
  if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(h)) return false;
  const hostname = h.split(':')[0];
  if (!hostname.includes('.')) return false;
  if (hostname.startsWith('-') || hostname.endsWith('-')) return false;
  if (hostname.startsWith('.') || hostname.endsWith('.')) return false;
  return true;
}

function isValidWallet(wallet, currency) {
  const w = String(wallet || '').trim();
  if (w.length < 26 || w.length > 128) return false;
  if (/\s/.test(w)) return false;
  if (currency === 'BTC') {
    if (/^(bc1|[13])[a-zA-Z0-9]{25,90}$/.test(w)) return true;
    return /^[a-zA-Z0-9]{26,90}$/.test(w);
  }
  if (currency === 'GRAM') {
    if (/^[a-zA-Z0-9_-]{26,90}$/.test(w)) return true;
    if (/^0:[a-fA-F0-9]{64}$/.test(w)) return true;
    return /^[a-zA-Z0-9]{26,128}$/.test(w);
  }
  return /^[a-zA-Z0-9]{26,128}$/.test(w);
}

function createRateLimiter({ windowMs = 60000, max = 30 } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    hits.set(key, entry);
    if (hits.size > 5000 && Math.random() < 0.01) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }
    return entry.count <= max;
  };
}
const orderLimiter = createRateLimiter({ windowMs: 60000, max: 100 });
const supportLimiter = createRateLimiter({ windowMs: 60000, max: 200 });
const captchaLimiter = createRateLimiter({ windowMs: 60000, max: 300 });

const REVIEWS_PAGE = 20;
const REVIEWS_PAGE_MAX = 50;

function startWeb() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('query parser', 'extended');
  app.use(express.json({ limit: '12mb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-XSS-Protection', '0');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.path === '/' || req.path === '/index.html') {
      res.set('X-Frame-Options', 'ALLOWALL');
    }
    next();
  });

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, private');
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html' || req.path === '/app.js' || req.path === '/devices.js')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'GET') {
      const proto = String(req.get('x-forwarded-proto') || 'https').split(',')[0].trim();
      const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
      if (isValidPublicHost(host)) {
        const safeProto = proto === 'http' ? 'http' : 'https';
        const url = `${safeProto}://${host}`.replace(/\/+$/, '');
        if (url !== store.get().settings.publicUrl) {
          try {
            new URL(url);
            store.mutate((db) => {
              db.settings.publicUrl = url;
            });
            bus.emit('public_url', url);
          } catch {}
        }
      }
    }
    next();
  });

  app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Неверный формат запроса' });
    }
    next(err);
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

  // ---------- existing routes ----------
  app.post('/api/init', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.body.startParam || '');
    const broker = brokerFor(a);
    res.json({
      me: clientUser(user),
      settings: store.publicSettings(),
      demo: a.demo,
      broker: broker ? { login: broker.login, name: broker.name } : null,
      access: store.accessFor(user),
    });
  });

  app.get('/api/settings', (req, res) => res.json(store.publicSettings()));

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

  app.get('/api/captcha', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!captchaLimiter(ip)) {
      return res.status(429).json({ error: 'Слишком много запросов, подождите' });
    }
    res.json(captcha.issue());
  });

  const needCaptcha = (req, res) => {
    if (captcha.verify(req.body?.captchaId, req.body?.captchaAnswer)) return true;
    res.status(400).json({ error: 'Неверный ответ на проверочный вопрос', captcha: true });
    return false;
  };

  /* ---------- доступ: бесплатные 3 дня, дальше подписка ---------- */
  // Подписка одна на человека и открывает обе стороны: обмен клиенту и кабинет
  // брокера. Оформляется минимальным месячным донатом на Tribute — ссылку хост
  // задаёт переменной окружения (TRIBUTE_URL).

  const ensureAccess = (user, res) => {
    const access = store.accessFor(user);
    if (access.ok) return access;
    res.status(402).json({
      error: access.state === 'pending'
        ? 'Оплата на проверке — включим доступ сразу после подтверждения'
        : `Бесплатные ${access.trialDays} дн. закончились — оформите подписку`,
      access,
    });
    return null;
  };

  app.post('/api/orders', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!orderLimiter(a.user.id || ip)) {
      return res.status(429).json({ error: 'Слишком много заявок, подождите минуту' });
    }
    if (!needCaptcha(req, res)) return;
    const s = store.get().settings;
    const gateUser = store.touchUser(a.user, req.body.startParam || '');
    if (!ensureAccess(gateUser, res)) return;
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
    if (!isValidWallet(wallet, currency)) return res.status(400).json({ error: 'Проверьте адрес кошелька' });
    const user = gateUser;
    const officialRate = currency === 'BTC' ? s.baseRateBTC : s.baseRateGRAM;
    const order = store.createOrder({
      userId: String(user.id),
      userName: user.name,
      userUsername: user.username,
      rub,
      currency,
      wallet,
      rate,
      officialRate: officialRate || rate,
      crypto: crypto ?? rub / rate,
      byCrypto: !hasRub,
      referrer: user.referrer,
    });
    // Офер уходит брокерам: они присылают свою цену, клиент выбирает отклик.
    bus.emit('order_event', { order, type: 'new' });
    res.json({ order: clientOrder(order), offerWindowSec: offerWindowSec(), marketRate: rate });
  });

  app.get('/api/order/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    res.json({
      order: clientOrder(o),
      bids: bidsForClient(o),
      offerWindowSec: offerWindowSec(),
      marketRate: o.currency === 'GRAM' ? store.get().settings.rateGRAM : store.get().settings.rateBTC,
    });
  });

  // Клиент принял отклик брокера: цена — из отклика, дальше брокер выдаёт реквизиты.
  app.post('/api/order/:id/accept', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (!ensureAccess(store.touchUser(a.user), res)) return;
    const r = store.acceptBid(o.id, req.body?.bidId);
    if (!r.ok) {
      const errors = {
        taken: 'По этому оферу уже выбран брокер',
        closed: 'Офер уже закрыт',
        bid: 'Отклик больше не активен — выберите другой',
        order: 'Заявка не найдена',
      };
      return res.status(400).json({ error: errors[r.reason] || 'Не удалось принять отклик' });
    }
    bus.emit('order_event', { order: r.order, type: 'bid_accepted', bid: r.bid, declined: r.declined });
    res.json({ order: clientOrder(r.order), marketRate: r.bid.marketRate || null });
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
    // Try to find exchanger by broker login
    const ex = exchangers.getExchangerByLogin(broker);
    let patch = { broker };
    if (ex && ex.status === 'approved') {
      patch.exchangerId = ex.id;
    }
    const upd = store.updateOrder(o.id, patch);
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
    res.set('Content-Disposition', `attachment; filename=\"check-${o.id}.pdf\"`);
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

  // Пользователь может отменить заявку в любое время (кроме терминальных)
  app.post('/api/order/:id/cancel', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (['completed', 'rejected', 'cancelled'].includes(o.status)) {
      return res.json({ order: clientOrder(o) });
    }
    // Разрешаем отмену в любое время до завершения
    const upd = store.updateOrder(o.id, { status: 'cancelled' });
    // Если есть открытое обращение — резерв остаётся заблокированным до решения человека
    if (upd.exchangerId) {
      const openClaim = claims.listClaims({ orderId: upd.id }).find((c) => ['open', 'under_review', 'approved'].includes(c.status) && !c.payout);
      if (!openClaim) {
        try { deposits.releaseForOrder(upd.exchangerId, upd.id); } catch {}
      }
    }
    bus.emit('order_event', { order: upd, type: 'cancelled' });
    return res.json({ order: clientOrder(upd) });
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

  // Обращение о выплате из залога — неполучение BTC достаточно
  app.post('/api/order/:id/claim', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    // Можно подать если BTC не получен — статус cancelled, completed без tx, paid, details
    // Не задаём срок подачи обращения и не вводим новые условия допуска
    if (!o.broker && !o.exchangerId) return res.status(400).json({ error: 'По заявке ещё не назначен обменник' });
    const reason = req.body?.reason || 'btc_not_received';
    const description = req.body?.description || '';
    try {
      // Определяем exchangerId
      let exchangerId = o.exchangerId;
      if (!exchangerId && o.broker) {
        const ex = exchangers.getExchangerByLogin(o.broker);
        if (ex) exchangerId = ex.id;
        else {
          // fallback: используем broker как exchangerId string для старых данных
          exchangerId = o.broker;
        }
      }
      const claim = claims.createClaim({
        orderId: o.id,
        userId: a.user.id,
        exchangerId,
        reason,
        description,
      });
      // Переводим депозит в claim_pending (внутри createClaim уже делается, но дублируем для старых)
      try { deposits.holdForClaim(o.id, a.user.id); } catch {}
      bus.emit('claim_event', { claim, type: 'new' });
      res.json({ claim });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/reviews', (req, res) => {
    const a = auth(req);
    const limit = Math.min(REVIEWS_PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || REVIEWS_PAGE));
    const before = store.parseReviewCursor(req.query.before);
    if (before === undefined) return res.status(400).json({ error: 'Некорректный параметр before' });
    res.json(store.publicReviews(limit, a ? a.user.id : null, { before }));
  });

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

  // Окно откликов и публичный список откликов по заявке клиента.
  const offerWindowSec = () => offersWindowSec(store.get().settings);
  const bidsForClient = (o) =>
    (['collecting', 'new', 'details', 'paid'].includes(o.status)
      ? store.bidsForOrder(o.id).filter((b) => b.status === 'accepted' || b.status === 'active').map((b) => clientBid(b, o))
      : []);

  // Состояние доступа и подписки: приложение показывает окно оплаты.
  app.get('/api/subscription', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.query.startParam || '');
    res.json({ access: store.accessFor(user), subscription: publicSubscription(store.userSub(user.id)) });
  });

  // «Я оплатил»: доступ включит оператор после проверки платежа на Tribute.
  app.post('/api/subscription/paid', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.body?.startParam || '');
    const access = store.accessFor(user);
    if (access.ok && access.state === 'active') {
      return res.json({ access, subscription: publicSubscription(store.userSub(user.id)), already: true });
    }
    const sub = store.requestUserSubPayment(user.id, {
      amount: Number(req.body?.amount) || access.amountRub,
      method: req.body?.method,
    });
    bus.emit('subscription_event', { user, sub, type: 'request' });
    res.json({ access: store.accessFor(user), subscription: publicSubscription(sub) });
  });

  /* ---------- ЛК брокера в Web App ---------- */
  // Брокер заходит в приложение по своему Telegram ID: доступ выдан админом
  // командой /addbroker, логин совпадает с ID. В демо-режиме (без BOT_TOKEN)
  // кабинет открыт, чтобы его можно было посмотреть без бота.
  const brokerFor = (a) => {
    if (!a || !a.user) return null;
    const login = String(a.user.id);
    const account = store.brokerAccountByLogin(login) || store.brokerAccountByTg(login);
    if (account && account.active !== false) {
      return { login: account.login, name: account.name || login };
    }
    const session = store.brokerSession(login);
    if (session && session.login) {
      const prof = store.brokerProfile(session.login);
      return { login: session.login, name: (prof && prof.name) || session.login };
    }
    if (a.demo || !config.botToken) {
      // В демо-режиме кабинет открыт: заводим демо-брокера один раз.
      if (!store.brokerAccountByLogin(login)) {
        store.upsertBrokerAccount(login, { name: a.user.first_name || 'Демо-брокер', username: a.user.username || null });
      }
      return { login, name: a.user.first_name || 'Демо-брокер' };
    }
    return null;
  };

  const needBroker = (req, res) => {
    const a = needAuth(req, res);
    if (!a) return null;
    const broker = brokerFor(a);
    if (!broker) {
      res.status(403).json({ error: 'Кабинет доступен брокерам PRICELEX' });
      return null;
    }
    return { ...a, broker };
  };

  const marketRateFor = (currency) => {
    const s = store.get().settings;
    return currency === 'GRAM' ? Number(s.rateGRAM) || 0 : Number(s.rateBTC) || 0;
  };

  // Офер глазами брокера: сумма, валюта, сколько уже откликнулось и его лимит.
  const brokerOfferView = (o, login) => {
    const can = store.brokerCanTake(login, o.rub);
    const own = store.bidsForOrder(o.id).find((b) => b.login === login && b.status === 'active') || null;
    return {
      id: o.id,
      rub: o.rub,
      currency: o.currency,
      crypto: o.crypto,
      marketRate: marketRateFor(o.currency),
      bids: store.activeBidsForOrder(o.id).length,
      createdAt: o.createdAt,
      bidUntil: o.bidUntil || null,
      canTake: can.ok,
      limitNote: can.ok ? null : can.text,
      myBid: own ? { id: own.id, rate: own.rate, updatedAt: own.updatedAt } : null,
      status: o.status,
    };
  };

  const brokerPayload = (broker) => {
    const s = store.get().settings;
    const login = broker.login;
    const price = store.brokerPrice(login) || {};
    const marketBtc = Number(s.rateBTC) || 0;
    const marketGram = Number(s.rateGRAM) || 0;
    const offers = store.get().orders
      .filter((o) => ['collecting', 'new'].includes(o.status) && !o.broker)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 12)
      .map((o) => brokerOfferView(o, login));
    const mine = store.get().orders
      .filter((o) => o.broker === login && ['new', 'details', 'paid'].includes(o.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 12)
      .map((o) => brokerOfferView(o, login));
    return {
      broker: store.brokerCard(login),
      stats: store.brokerStats(login),
      price: {
        BTC: Number(price.BTC) || marketBtc,
        GRAM: Number(price.GRAM) || marketGram,
        updatedAt: price.updatedAt || null,
        custom: Boolean(price.BTC || price.GRAM),
      },
      market: { BTC: marketBtc, GRAM: marketGram, updatedAt: s.rateUpdatedAt || null },
      priceHistory: store.brokerPricePoints(login, 240),
      marketHistory: store.rateHistorySince(Date.now() - 7 * 24 * 3600 * 1000, 180),
      offers,
      mine,
      reviews: store.reviewsForBroker(login).slice(0, 20).map((r) => store.publicReview(r)),
    };
  };

  app.get('/api/broker/me', (req, res) => {
    const a = needBroker(req, res);
    if (!a) return;
    const user = store.touchUser(a.user);
    const access = store.accessFor(user);
    if (!access.ok) return res.status(402).json({ error: 'Нужна подписка PRICELEX', access });
    res.json({ ...brokerPayload(a.broker), access });
  });

  // Рабочая цена брокера: по ней он откликается на оферы по умолчанию.
  app.post('/api/broker/price', (req, res) => {
    const a = needBroker(req, res);
    if (!a) return;
    if (!ensureAccess(store.touchUser(a.user), res)) return;
    const currency = req.body?.currency === 'GRAM' ? 'GRAM' : 'BTC';
    const rate = Number(req.body?.rate);
    const market = marketRateFor(currency);
    if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: 'Укажите цену больше нуля' });
    if (market && (rate < market * 0.5 || rate > market * 2)) {
      return res.status(400).json({ error: 'Цена слишком далеко от рыночного курса — проверьте значение' });
    }
    store.setBrokerPrice(a.broker.login, { currency, rate });
    res.json(brokerPayload(a.broker));
  });

  // Отклик на офер клиента: цена брокера, по умолчанию — его рабочая цена.
  app.post('/api/broker/bid', (req, res) => {
    const a = needBroker(req, res);
    if (!a) return;
    if (!ensureAccess(store.touchUser(a.user), res)) return;
    const o = store.getOrder(req.body?.orderId);
    if (!o) return res.status(404).json({ error: 'Офер не найден' });
    if (o.broker) return res.status(400).json({ error: 'По этому оферу уже выбран брокер' });
    if (!['collecting', 'new'].includes(o.status)) return res.status(400).json({ error: 'Офер уже закрыт' });
    const can = store.brokerCanTake(a.broker.login, o.rub);
    if (!can.ok) return res.status(403).json({ error: can.text });
    const market = marketRateFor(o.currency);
    const price = store.brokerPrice(a.broker.login) || {};
    const fromPrice = Number(price[o.currency]) || 0;
    const rate = Number(req.body?.rate) || fromPrice || market;
    if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: 'Укажите цену больше нуля' });
    if (market && (rate < market * 0.5 || rate > market * 2)) {
      return res.status(400).json({ error: 'Цена слишком далеко от рыночного курса — проверьте значение' });
    }
    const r = store.placeBid({
      orderId: o.id,
      login: a.broker.login,
      name: a.broker.name,
      rate,
      note: req.body?.note,
      marketRate: market,
    });
    if (!r.ok) return res.status(400).json({ error: 'Не удалось отправить отклик' });
    bus.emit('order_event', { order: store.getOrder(o.id), type: 'bid', bid: r.bid });
    res.json({ bid: r.bid, payload: brokerPayload(a.broker) });
  });

  // Отклики на свой офер — для живой ленты в приложении.
  app.get('/api/order/:id/bids', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    res.json({
      bids: bidsForClient(o),
      offerWindowSec: offerWindowSec(),
      marketRate: marketRateFor(o.currency),
      order: clientOrder(o),
    });
  });

  // ---------- Франшизы и обменники ----------
  app.post('/api/exchangers/register', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!needCaptcha(req, res)) return;
    try {
      const legal = req.body?.legal;
      const experience = req.body?.experience || '';
      const contact = req.body?.contact || '';
      if (!legal) return res.status(400).json({ error: 'Укажите юридические реквизиты' });
      // Запрет на seed/private key в запросе
      const bodyStr = JSON.stringify(req.body).toLowerCase();
      if (bodyStr.includes('seed') || bodyStr.includes('mnemonic') || bodyStr.includes('private key') || bodyStr.includes('приватный ключ')) {
        // Проверяем, что это не просто упоминание в keyHolders basis? Но лучше отклонить если есть поля seed
        if (req.body.seed || req.body.seedPhrase || req.body.privateKey || req.body.mnemonic) {
          return res.status(400).json({ error: 'Приложение не собирает seed-фразы и приватные ключи' });
        }
      }
      const user = store.touchUser(a.user, req.body.startParam || '');
      const ex = exchangers.createExchanger({
        tgId: user.id,
        userId: user.id,
        legal,
        experience,
        contact,
      });
      audit.log({ actorId: user.id, action: 'exchanger_registered', targetType: 'exchanger', targetId: ex.id, details: { companyName: ex.legal.companyName } });
      bus.emit('exchanger_event', { exchanger: ex, type: 'new' });
      res.json({ exchanger: ex });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/exchangers/me', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const ex = exchangers.getExchangerByTgId(a.user.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    res.json({ exchanger: ex });
  });

  app.get('/api/exchangers/offers', (req, res) => {
    // Маркетплейс: предложения обменников и сравнение
    const data = marketplace.getOfferComparison();
    res.json(data);
  });

  app.get('/api/exchangers/:id', (req, res) => {
    const a = auth(req);
    // Публичные данные для approved, приватные только для владельца/админа
    const ex = exchangers.getExchangerById(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    if (ex.status === 'approved') {
      // Публичная часть
      return res.json({
        exchanger: {
          id: ex.id,
          companyName: ex.legal?.companyName,
          publicBtcAddresses: ex.legal?.publicBtcAddresses,
          networks: ex.legal?.networks,
          status: ex.status,
          createdAt: ex.createdAt,
        },
      });
    }
    // Для не-одобренных — только владелец
    if (!a || String(ex.tgId) !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    res.json({ exchanger: ex });
  });

  app.get('/api/exchangers/:id/deposits', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    try {
      exchangers.assertOwnership(req.params.id, a.user.id);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }
    const list = deposits.getDeposits(req.params.id);
    res.json({
      deposits: list,
      available: deposits.getAvailableBalance(req.params.id),
      reserved: deposits.getReservedBalance(req.params.id),
      exposure: deposits.getTotalExposure(req.params.id),
      confirmationRule: walletProvider.getConfirmationRule(),
      providerInfo: walletProvider.getProviderInfo(),
    });
  });

  app.post('/api/exchangers/:id/wallet', async (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    try {
      exchangers.assertOwnership(req.params.id, a.user.id);
      const ex = await exchangers.createWalletForExchanger(req.params.id, a.user.id);
      res.json({ exchanger: ex, wallet: ex.wallet });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/exchangers/:id/deposits/simulate', async (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    try {
      exchangers.assertOwnership(req.params.id, a.user.id);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }
    if (walletProvider.isMainnetEnabled()) {
      return res.status(403).json({ error: 'Симуляция недоступна в mainnet режиме' });
    }
    const amount = Number(req.body?.amountBtc);
    const confirmations = Number(req.body?.confirmations) || 0;
    if (!(amount > 0)) return res.status(400).json({ error: 'amountBtc должен быть положительным' });
    const ex = exchangers.getExchangerById(req.params.id);
    if (!ex || !ex.wallet) return res.status(400).json({ error: 'Сначала создайте кошелёк' });
    const provider = walletProvider.getProvider();
    await provider.simulateDeposit(ex.wallet.address, amount, confirmations, req.body?.txId);
    const dep = deposits.createDeposit({
      exchangerId: ex.id,
      amountBtc: amount,
      txId: req.body?.txId,
      confirmations,
    });
    res.json({ deposit: dep, balance: await provider.getBalance(ex.wallet.address) });
  });

  app.get('/api/exchangers/:id/orders', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    try {
      exchangers.assertOwnership(req.params.id, a.user.id);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }
    const orders = (store.get().orders || []).filter((o) => String(o.exchangerId) === String(req.params.id) || String(o.broker) === String(exchangers.getExchangerById(req.params.id)?.login));
    res.json({ orders: orders.map(clientOrder) });
  });

  app.get('/api/exchangers/:id/claims', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    try {
      exchangers.assertOwnership(req.params.id, a.user.id);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }
    res.json({ claims: claims.listClaims({ exchangerId: req.params.id }) });
  });

  app.get('/api/exchangers/:id/subscription', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    try {
      exchangers.assertOwnership(req.params.id, a.user.id);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }
    res.json({
      subscription: subscriptions.getSubscription(req.params.id),
      config: subscriptions.getSubscriptionConfig(),
      access: subscriptions.isAccessAllowed(req.params.id),
    });
  });

  app.get('/api/claims', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    res.json({ claims: claims.listClaims({ userId: a.user.id }) });
  });

  app.get('/api/claims/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const c = claims.getClaim(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    // Изоляция: пользователь видит только свои, обменник — только свои
    if (String(c.userId) !== String(a.user.id)) {
      const ex = exchangers.getExchangerByTgId(a.user.id);
      if (!ex || String(ex.id) !== String(c.exchangerId)) return res.status(404).json({ error: 'not found' });
    }
    res.json({ claim: c });
  });

  app.get('/api/wallet/provider-info', (req, res) => {
    res.json(walletProvider.getProviderInfo());
  });

  app.post('/api/tribute/webhook', (req, res) => {
    // Событие может относиться к пользователю (клиент или брокер) — тогда
    // подписка включается по его Telegram ID, без участия оператора.
    const ev = req.body || {};
    const uid = ev.data && (ev.data.telegramId || ev.data.telegram_id || ev.data.userId || ev.data.user_id);
    if (uid && ['payment.succeeded', 'subscription.renewed'].includes(ev.type)) {
      const days = Number(ev.data?.days) || 30;
      const sub = store.activateUserSub(uid, { days, amount: ev.data?.amount, externalId: ev.data?.id, by: 'tribute' });
      bus.emit('subscription_event', { user: { id: String(uid) }, sub, type: 'activated' });
      return res.json({ ok: true, subscription: publicSubscription(sub) });
    }
    // Проверка подписи должна быть здесь в реальности; пока — тестовая
    try {
      const event = req.body;
      const sub = subscriptions.handleTributeWebhook(event);
      res.json({ ok: true, subscription: sub });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/support/messages', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const msgs = store.getSupportMessages(a.user.id);
    res.json({ messages: msgs });
  });

  app.post('/api/support/message', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const ip = a.user.id || req.ip || 'unknown';
    if (!supportLimiter(ip)) {
      return res.status(429).json({ error: 'Слишком много сообщений, подождите' });
    }
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
      if (upd.exchangerId) {
        const openClaim = claims.listClaims({ orderId: upd.id }).find((c) => ['open', 'under_review', 'approved'].includes(c.status) && !c.payout);
        if (!openClaim) { try { deposits.releaseForOrder(upd.exchangerId, upd.id); } catch {} }
      }
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
    // Demo admin for exchangers
    app.post('/api/admin/exchangers/:id/approve', (req, res) => {
      try {
        const ex = exchangers.updateExchangerStatus(req.params.id, 'approved', 'demo_admin', req.body?.reason);
        res.json({ exchanger: ex });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/admin/exchangers/:id/reject', (req, res) => {
      try {
        const ex = exchangers.updateExchangerStatus(req.params.id, 'rejected', 'demo_admin', req.body?.reason);
        res.json({ exchanger: ex });
      } catch (e) { res.status(400).json({ error: e.message }); }
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
