const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const currencies = require('./currencies');
const { validateInitData, parseUser } = require('./validate');
const admins = require('./admins');
const rates = require('./rates');

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
    // In demo mode (BOT_TOKEN unset) the admin panel is open only to the demo guest and admins — clients don't see it.
    return admins.has(id) || (!config.botToken && id === '900001') ? a : null;
  };

  // Admin: current values of all editable settings.
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
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Pricelex Worldwide operator only' });
    res.json({ admin: adminSettingsBlock(), settings: store.publicSettings() });
  });

  const CLIENTS_ANNOUNCE_OPEN =
    '🟢 <b>Pricelex Worldwide: gift cards are open!</b>\n\n' +
    'We are accepting USD gift card redemption orders again — Google, iTunes, Xbox and Apple Store 🎁\n' +
    'BTC payouts, no documents or registration — in the app and in the bot.';
const DIRECTION_KEYS = currencies.list().map((p) => p.key);
  const feeValue = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 50 ? Number(v) : null);

  // Admin: partial settings update (chat, card directions, card fee, online).
  app.post('/api/admin/settings', async (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Pricelex Worldwide operator only' });
    const body = req.body || {};
    const patch = {};
    // 1) Directions (on/off)
    if (body.enabled && typeof body.enabled === 'object') {
      const map = {};
      for (const key of Object.keys(body.enabled)) {
        if (!DIRECTION_KEYS.includes(key)) return res.status(400).json({ error: `Unknown direction: ${key}` });
        if (typeof body.enabled[key] !== 'boolean') return res.status(400).json({ error: 'enabled: true/false only' });
        map[key] = body.enabled[key];
      }
      patch.enabled = map;
    }
    // 2) Gift card: fee (0–50% of the BTC equivalent of the face value).
    if (body.giftPercent !== undefined) {
      const v = feeValue(body.giftPercent);
      if (v === null) return res.status(400).json({ error: 'Card fee must be a number from 0 to 50 (%).' });
      patch.giftPercent = v;
    }
    // 3) Open/close redemption
    let openTrading = null;
    if (body.online !== undefined) {
      if (typeof body.online !== 'boolean') return res.status(400).json({ error: 'online: true/false only' });
      openTrading = body.online;
    }
    // 4) Chat link
    if (body.chat !== undefined) {
      const chat = String(body.chat || '').trim().slice(0, 300);
      if (chat.length < 8 || !(chat.startsWith('https://') || /^@[A-Za-z0-9_]{5,32}$/.test(chat))) {
        return res.status(400).json({ error: 'Provide a t.me/… link or an @… username' });
      }
      patch.chat = chat;
    }
    if (openTrading !== null) patch.online = openTrading;
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Nothing to update — send at least one field.' });
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
      // The card fee recalculates the final BTC rate per $1.
      if (patch.giftPercent !== undefined) {
        rates.recomputeGiftRate();
      }
    });
    // Opening trading: broadcast the redemption announcement to clients.
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
      return res.status(403).json({ error: 'Pricelex Worldwide operator only' });
    }
    const chat = String(req.body?.chat || '').trim().slice(0, 300);
      if (chat.length < 8 || !(chat.startsWith('https://') || /^@[A-Za-z0-9_]{5,32}$/.test(chat))) {
      return res.status(400).json({ error: 'Provide a t.me/… link or an @… username (e.g. https://t.me/+abc or @support_team)' });
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
    if (!s.online) return res.status(403).json({ error: 'Exchange is temporarily unavailable' });
    if (!pair || pair.kind !== 'gift') return res.status(400).json({ error: 'Unknown currency' });
    if (!currencies.isEnabled(s, pair.key)) {
      return res.status(400).json({ error: `${pair.label} redemption is temporarily unavailable — choose another card.` });
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
        return res.status(400).json({ error: 'Gift card code: 8–200 characters, no double spaces.' });
      }
      giftCode = giftCodeRaw;
    }
    const walletError = currencies.validateWallet(wallet);
    if (walletError) return res.status(400).json({ error: pair.walletError });
    const payout = currencies.giftPayout(s, units, pair.currency);
    if (!payout) {
      return res.status(400).json({ error: 'BTC payout rate is temporarily unavailable — please try again later.' });
    }
    if (!(payout.crypto > 0)) {
      return res.status(400).json({ error: 'Payout amount is too small — increase the card amount.' });
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
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    res.json({ order: clientOrder(store.expireIfNeeded(found) || found) });
  });

  app.post('/api/order/:id/paid', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    const o = store.expireIfNeeded(found);
    // Gift card: "I paid" = the client confirms the deal.
    // An order WITHOUT a code (the new two-phase scheme) cannot be confirmed this way — first the operator
    // joins, then the client sends the code.
    if (o.status === 'new') {
      if (!o.giftCode) {
        return res.status(400).json({ error: 'Wait for the operator to join — the card code is sent only after they ask.' });
      }
      const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    if (o.status === 'details') {
      // Gift card in the "operator joined" status: the code has not been sent yet.
      if (!o.giftCode) {
        return res.status(400).json({ error: 'Send the card code first — the operator is online.' });
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
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    const o = store.expireIfNeeded(found);
    if (['completed', 'rejected', 'cancelled'].includes(o.status)) {
      return res.status(400).json({ error: 'This order no longer accepts a code.' });
    }
    if (o.status === 'paid') return res.json({ order: clientOrder(o) }); // idempotent
    if (!['details', 'new'].includes(o.status)) {
      return res.status(400).json({ error: 'The code is not accepted right now — wait for the operator.' });
    }
    // A new two-phase order (no code yet) accepts the code only in the "details" status (operator joined).
    if (!o.giftCode && o.status !== 'details') {
      return res.status(400).json({ error: 'Wait for the operator to join — the card code is sent only after they ask.' });
    }
    const giftCode = String(req.body.giftCode || '').trim();
    if (giftCode.length < 8 || giftCode.length > 200 || /\s{2,}/.test(giftCode)) {
      return res.status(400).json({ error: 'Gift card code: 8–200 characters, no double spaces.' });
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
    if (o.status === 'cancelled' && (o.cancelReason === store.EXPIRED || o.cancelReason === store.EXPIRED_LEGACY)) {
      return res.status(400).json({ error: 'Time to complete the deal has expired — please create a new order.' });
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
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'You can leave a review after the deal is completed.' });
    }
    if (store.getReviewByOrder(order.id)) {
      return res.status(409).json({ error: 'You already left a review for this deal.' });
    }
    const rating = Math.round(Number(b.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1 to 5 stars.' });
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
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Pricelex Worldwide operator only' });
    const all = store.listReviews(500);
    res.json({
      summary: store.reviewSummary(all),
      reviews: all.map((r) => ({ ...store.publicReview(r), orderId: r.orderId ?? null })),
    });
  });

  app.post('/api/admin/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Pricelex Worldwide operator only' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60) || 'Pricelex Worldwide';
    const rating = Math.round(Number(b.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1 to 5 stars.' });
    }
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Add the review text.' });
    if (text.length > 1000) return res.status(400).json({ error: 'Reviews are limited to 1000 characters.' });
    const review = store.createReview({ userId: null, orderId: null, name, rating, text, source: 'admin' });
    res.json({ review: store.publicReview(review) });
  });

  app.delete('/api/admin/reviews/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Pricelex Worldwide operator only' });
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
    if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
    if (text.length > 2000) return res.status(400).json({ error: 'Message is too long (up to 2000 characters)' });
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
      if (!o) return res.status(404).json({ error: 'not found' });
      if (o.status !== 'new') return res.status(400).json({ error: 'Order is already in progress' });
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

  app.get('/health', (_req, res) => res.json({ ok: true, name: 'Pricelex Worldwide' }));
  app.use(express.static(publicDir));
  app.use((req, res) => res.sendFile(indexFile));

  const server = app.listen(config.port, config.host, () => {
    console.log(
      `[Pricelex Worldwide] web server listening on ${config.host}:${config.port} (port source: ${config.portSource})`
    );
    console.log('[Pricelex Worldwide] open this URL in a browser — you should see the exchange page, not "Bot is running"');
  });
  server.on('error', (e) => {
    console.error(`[Pricelex Worldwide] could not bind ${config.host}:${config.port}:`, e.message);
    if (e && e.code === 'EADDRINUSE') {
      console.error(
        '[Pricelex Worldwide] Port is busy. On a bot hosting panel set Main File = index.js and do not set PORT manually — you need the panel’s SERVER_PORT.'
      );
    }
    process.exit(1);
  });
  return server;
}

module.exports = { startWeb };
