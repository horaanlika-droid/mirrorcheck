const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const receipts = require('./receipts');
const { validateInitData, parseUser } = require('./validate');

const clientOrder = (o) => ({
  id: o.id,
  rub: o.rub,
  currency: o.currency,
  wallet: o.wallet,
  crypto: o.crypto,
  rate: o.rate,
  status: o.status,
  requisites: o.requisites,
  payRub: o.payRub,
  receipt: o.receipt || null,
  txUrl: o.txUrl || null,
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

  // Реальная история курса для графика в приложении: точки пишутся при каждом
  // успешном автообновлении курса, поэтому график всегда отражает факт.
  app.get('/api/rates/history', (req, res) => {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
    const since = Date.now() - hours * 3600 * 1000;
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

  app.post('/api/orders', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
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
    const order = store.createOrder({
      userId: String(user.id),
      userName: user.name,
      userUsername: user.username,
      rub,
      currency,
      wallet,
      rate,
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
    app.post('/api/admin/order/:id/req', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const upd = store.updateOrder(o.id, {
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
