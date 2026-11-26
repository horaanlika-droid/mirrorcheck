// Pricelex Worldwide client bot — the same exchange without the Mini App, for those who don't want to open the app.
// Flow: /start → menu → gift card → amount → Bitcoin wallet → order,
// "My orders", "Support", "Referral program", "Info". All in plain messages
// and buttons — works in any Telegram client without the Mini App and without widgets.
// Only redemption of USD gift cards (Google, iTunes, Xbox, Apple Store) for BTC payouts.
const { InlineKeyboard } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const currencies = require('./currencies');
const { esc, fmtCrypto, fmtDate, parseNum } = require('./util');
const widget = require('./widget');

const clientFlows = new Map(); // userId -> FSM state
const isPrivate = (ctx) => ctx.chat?.type === 'private' && ctx.from;
const uidOf = (ctx) => String(ctx.from.id);
const isGiftOrder = (o) => o && o.direction === 'sell';
const giftLabel = (o) => currencies.label(o.currency);
const giftUnits = (o) => Number(o.units) || 0;
const payoutOf = (o, amount = o.crypto) => fmtCrypto(amount, 'BTC', currencies.displayDecimals());

/* ---------- content ---------- */

// The gift-card advantage: a minimal digital footprint.
const GIFT_PRIVACY =
  '🛡 <b>Minimal digital footprint</b>\n' +
  '• You can buy the card with cash — it is in no way tied to your bank account or passport.\n' +
  '• We don\'t ask for documents or registration: just the card code and a Bitcoin wallet address.\n' +
  '• Payout goes straight to your wallet — no banks, no exchanges, no intermediaries.\n' +
  '• Fewer points where your data is recorded — a smaller digital footprint.';

/* ---------- state ---------- */

const ensureUser = (ctx, refParam = '') =>
  store.touchUser({ id: ctx.from.id, first_name: ctx.from.first_name || 'Client', username: ctx.from.username || null }, refParam);

const availableGift = () =>
  currencies.list().filter(
    (p) => currencies.isEnabled(store.get().settings, p.key) && currencies.rateOf(store.get().settings, p.currency) > 0
  );

/* ---------- keyboards ---------- */

function menuKb(s) {
  const kb = new InlineKeyboard()
    .text('💱 Sell a gift card', 'c:exchange').text('📦 My orders', 'c:orders').row()
    .text('💬 Support', 'c:support').text('ℹ️ Info', 'c:info').row()
    .text('🎁 Referral program', 'c:refs');
  // Telegram only accepts web_app buttons over https — otherwise the whole message is rejected and the client sees silence.
  if (s.publicUrl && /^https:\/\//i.test(s.publicUrl)) kb.row().webApp('📱 Open the app', s.publicUrl);
  return kb;
}

const backMenuKb = () => new InlineKeyboard().text('↩️ Menu', 'c:menu');

function assetKb() {
  const kb = new InlineKeyboard();
  for (const p of availableGift()) {
    kb.text(`🎁 ${p.label}`, `c:buy:${p.key}`).row();
  }
  kb.text('↩️ Menu', 'c:menu');
  return kb;
}

/* ---------- screen rendering (message is edited on callbacks) ---------- */

async function show(ctx, text, kb) {
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, opts);
    } catch (e) {
      /* message is identical or too old — just send a new one */
    }
  }
  try {
    return await ctx.reply(text, opts);
  } catch (e) {
    // Telegram rejected reply_markup (e.g. a non-https web_app link) —
    // reply without buttons so the client is not left without an answer.
    console.error('[clientbot] reply rejected by Telegram:', e && e.message);
    try {
      return await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (e2) {
      console.error('[clientbot] reply without keyboard also rejected:', e2 && e2.message);
      return null;
    }
  }
}

function clientMenu(ctx) {
  const s = store.get().settings;
  const online = s.online ? '🟢 Exchange <b>ONLINE</b>' : '🔴 Exchange <b>OFFLINE</b>';
  return show(ctx,
    `🌌 <b>Pricelex Worldwide | Official</b> — exchange\n${online}\n\n` +
    `We buy Google, iTunes, Xbox and Apple Store gift cards (US region, USD) with BTC payouts.\n` +
    `What would you like to do?`,
    menuKb(s));
}

function assetScreen(ctx) {
  const s = store.get().settings;
  if (!s.online) {
    return show(ctx, '⛔ <b>Exchange is temporarily unavailable.</b>\nWe will be back soon — please check again later.', backMenuKb());
  }
  if (!availableGift().length) {
    return show(ctx, '💱 <b>Directions are temporarily unavailable.</b>\nPlease check back soon.', backMenuKb());
  }
  return show(ctx, '💱 <b>Choose a card</b>\n\nPick which card you are selling:', assetKb());
}

/* ---------- order: gift card → BTC ---------- */

// The first thing the client sees: the card-transfer rules dialog.
function giftRules(ctx, pair) {
  clientFlows.delete(uidOf(ctx));
  const label = pair?.label || currencies.gift().label;
  return show(ctx,
    `🎁 <b>Sell ${esc(label)}</b>\n\n` +
    `<b>Card transfer rules:</b>\n` +
    `1. The card must be a <b>${esc(label)}</b> for the <b>US</b> region, in <b>USD</b>, with a full unused balance. Cards from other regions or currencies are not accepted.\n` +
    `2. First the order is created, then <b>the operator joins</b>. <b>Don't send anything and don't share the code with anyone until they ask.</b>\n` +
    `3. You send the card code here (or in the app) <b>only after the operator joins</b>. They will verify the card (usually 5–15 minutes).\n` +
    `4. Payout is in <b>BTC</b> to your Bitcoin wallet. The amount is based on the current BTC/USD rate.\n` +
    `5. Support never asks for the code or money outside the order. Don't share the code with anyone except the operator within the order.\n` +
    `6. You have <b>1 hour</b> from order creation to complete the deal. If the card is invalid, the order is rejected without payout.\n\n` +
    GIFT_PRIVACY,
    new InlineKeyboard().text('✅ Got it — choose amount', `c:giftnom:${pair.key}`).row().text('↩️ Back to cards', 'c:exchange'));
}

function giftIntro(ctx, pair) {
  const s = store.get().settings;
  const rate = currencies.rateOf(s, pair.currency);
  clientFlows.set(uidOf(ctx), { type: 'gift_select', key: pair.key });
  const kb = new InlineKeyboard()
    .text('$10', `c:units:${pair.key}:10`).text('$20', `c:units:${pair.key}:20`).text('$50', `c:units:${pair.key}:50`).text('$100', `c:units:${pair.key}:100`).row()
    .text('Other amount', `c:giftnum:${pair.key}`).row()
    .text('↩️ Back to cards', 'c:exchange');
  return show(ctx,
    `${esc(pair.label)} → BTC\n\n` +
    `You give us the code for a ${esc(pair.label)} card denominated in <b>USD</b> — we pay out BTC to your Bitcoin wallet.\n\n` +
    `💱 Payout rate: <b>1 $ = ${esc(fmtCrypto(rate, 'BTC', 8))}</b>. The BTC/USD rate updates automatically.\n` +
    `⏱ 1 hour per deal from creation.\n` +
    `✅ US-region cards in US dollars (USD) only.\n\n` +
    GIFT_PRIVACY + `\n\n` +
    `Choose the amount:`,
    kb);
}

// The order is created WITHOUT a code: the client sends it only after the operator joins.
function askGiftWallet(ctx, units, pair) {
  clientFlows.set(uidOf(ctx), { type: 'gift_wallet', units, key: pair.key });
  return show(ctx,
    `👛 <b>Bitcoin wallet address</b>\n\n` +
    `Where should we send the BTC? Send your Bitcoin address: <b>bc1…</b>, <b>1…</b> or <b>3…</b>.\n\n` +
    `/cancel — cancel`,
    new InlineKeyboard().text('↩️ Back to amount', `c:giftnom:${pair.key}`));
}

function createGiftOrder(ctx, units, wallet, pair) {
  const s = store.get().settings;
  if (!s.online) return { error: 'Exchange is temporarily unavailable — please try again later.' };
  if (!pair || pair.kind !== 'gift') return { error: 'Unknown gift card type.' };
  if (!currencies.isEnabled(s, pair.key)) return { error: 'This card is currently unavailable for sale.' };
  const unitsError = currencies.validateUnits(units);
  if (unitsError) return { error: unitsError };
  const walletError = currencies.validateWallet(wallet);
  if (walletError) return { error: walletError };
  const payout = currencies.giftPayout(s, units, pair.currency);
  if (!payout || !(payout.crypto > 0)) {
    return { error: 'BTC payout rate is temporarily unavailable — please try again later.' };
  }
  const usr = ensureUser(ctx);
  const order = store.createOrder({
    userId: uidOf(ctx),
    userName: ctx.from.first_name || 'Client',
    userUsername: ctx.from.username || null,
    expiresAt: Date.now() + (Number(pair.ttlMinutes) || 60) * 60 * 1000,
    units,
    currency: pair.currency,
    wallet,
    rate: payout.rate,
    crypto: payout.crypto,
    referrer: usr && usr.referrer,
  });
  bus.emit('order_event', { order, type: 'new' });
  return { order };
}

/* ---------- "My orders" ---------- */

const statusIcon = (o) => {
  if (o.status === 'completed') return '🟢';
  if (o.status === 'rejected' || o.status === 'cancelled') return '⚪';
  if (o.status === 'paid') return '⏳';
  if (o.status === 'details') return '🤝';
  return '🕐';
};
const amountOf = (o) => `🎁 $${giftUnits(o)}`;
const shortOf = (o) => giftLabel(o);

function ordersList(ctx) {
  const all = store.userOrders(uidOf(ctx));
  const active = all.filter((o) => !['completed', 'rejected', 'cancelled'].includes(o.status));
  const recent = all.filter((o) => ['completed', 'rejected', 'cancelled'].includes(o.status)).slice(0, 3);
  const shown = [...active, ...recent].slice(0, 8);
  if (!shown.length) {
    return show(ctx,
      '📦 <b>You have no orders yet.</b>\nCreate your first exchange — it will appear here.',
      new InlineKeyboard().text('💱 Sell a gift card', 'c:exchange').text('↩️ Menu', 'c:menu'));
  }
  const kb = new InlineKeyboard();
  for (const o of shown) {
    kb.text(`${statusIcon(o)} #${o.id} · ${shortOf(o)} · ${amountOf(o)}`, `c:order:${o.id}`).row();
  }
  kb.text('💱 Sell a gift card', 'c:exchange').text('↩️ Menu', 'c:menu');
  return show(ctx, `📦 <b>Your orders</b>\n\n${active.length ? `Active: ${active.length}` : 'No active orders'}. Tap an order to open it:`, kb);
}

async function loadOwnOrder(ctx, id) {
  const o = store.getOrder(id);
  if (!o || String(o.userId) !== uidOf(ctx)) return null;
  return store.expireIfNeeded(o) || o;
}

const orderActionsKb = (o) => {
  const kb = new InlineKeyboard();
  if (o.status === 'details' && !o.giftCode) {
    // The operator has joined — the client sends the code.
    kb.text('🎟 Send the card code', `c:sendcode:${o.id}`);
  } else if (o.status === 'details') {
    kb.text('🔄 Refresh', `c:order:${o.id}`);
  } else if (o.status === 'new') {
    if (o.giftCode) kb.text('✅ I paid', `c:paid:${o.id}`); // compatibility with legacy orders
    else kb.text('🔄 Refresh', `c:order:${o.id}`);
  } else if (o.status === 'paid') {
    kb.text('🔄 Refresh', `c:order:${o.id}`);
  }
  if (['new', 'details'].includes(o.status)) kb.text('❌ Cancel', `c:cancel:${o.id}`);
  kb.row().text('📦 My orders', 'c:orders').text('↩️ Menu', 'c:menu');
  return kb;
};

function orderDetailText(o) {
  const head = `<b>Order #${o.id}</b> · ${esc(fmtDate(o.createdAt))}\n`;
  if (o.status === 'new') {
    if (o.giftCode) {
      // Compatibility with legacy orders where the code was provided at creation time.
      return head +
        `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
        `🎟 The code <code>${esc(o.giftCode)}</code> is already with the operator.\n` +
        `When you are ready to hand over the card — tap "I paid".`;
    }
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `⏳ <b>Waiting for the operator to join</b> — usually a few minutes.\n` +
      `<b>Don't send anything and don't share the code</b> until the operator asks for it in this order.`;
  }
  if (o.status === 'details' && !o.giftCode) {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🤝 <b>Operator is online.</b> They are waiting for the card code.\n` +
      `Tap "🎟 Send the card code" and send the code in one message.`;
  }
  if (o.status === 'details' && o.giftCode) {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🔎 Code sent — the card is under review. Usually 5–15 minutes.`;
  }
  if (o.status === 'paid') {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🔎 Card under review: the operator will verify the region (<b>USA</b>), currency (<b>USD</b>), amount and balance.\n` +
      `Usually 5–15 minutes.`;
  }
  if (o.status === 'completed') {
    return head + `🟢 <b>Completed.</b> Payout of ${payoutOf(o)} sent to your wallet:\n<code>${esc(o.wallet)}</code>${o.txUrl ? `\n🔗 ${esc(o.txUrl)}` : ''}`;
  }
  return head + `${o.status === 'rejected' ? '🔴 Rejected by the operator.' : '⚪ Cancelled.'}${o.cancelReason ? `\nReason: ${esc(o.cancelReason)}` : ''}`;
}

async function orderDetail(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Order not found.', backMenuKb());
  // If widgets are enabled and Telegram accepts them — show the order card inside the message.
  const sent = await widget.trySendOrderWidget(ctx, o);
  if (sent) return;
  return show(ctx, orderDetailText(o), orderActionsKb(o));
}

/* ---------- client actions ---------- */

async function clientPaid(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Order not found.', backMenuKb());
  if (o.status === 'new' && o.giftCode) {
    const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
    bus.emit('order_event', { order: upd, type: 'paid' });
    return show(ctx, `🔎 <b>Order #${o.id}</b>\nCode sent for review. Usually 5–15 minutes — the operator will verify the card and pay out ${payoutOf(o)}.`, new InlineKeyboard().text('📦 My orders', 'c:orders').text('↩️ Menu', 'c:menu'));
  }
  return show(ctx, orderDetailText(o), orderActionsKb(o));
}

async function clientCancel(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Order not found.', backMenuKb());
  if (!['new', 'details'].includes(o.status)) {
    return show(ctx, 'Only a new or code-pending order can be cancelled.', orderActionsKb(o));
  }
  if (o.status === 'cancelled' && (o.cancelReason === store.EXPIRED || o.cancelReason === store.EXPIRED_LEGACY)) {
    return show(ctx, 'Time to complete the deal has expired. Please create a new order.', backMenuKb());
  }
  const upd = store.updateOrder(o.id, { status: 'cancelled' });
  bus.emit('order_event', { order: upd, type: 'cancelled' });
  return show(ctx, `⚪ <b>Order #${o.id} cancelled.</b>`, new InlineKeyboard().text('💱 New exchange', 'c:exchange').text('↩️ Menu', 'c:menu'));
}

/* ---------- misc: info, referrals, support ---------- */

function infoScreen(ctx) {
  const s = store.get().settings;
  return show(ctx,
    `ℹ️ <b>Pricelex Worldwide | Official</b>\n\n` +
    `Check the order for the exact payout rate and fee — payouts are in BTC only.\n\n` +
    `Status: ${s.online ? '🟢 Online' : '🔴 Offline'}\n\n` +
    `📇 Operator: ${esc(s.operator)}\n📣 Channel: ${esc(s.channel)}\n💬 Chat: ${esc(s.chat)}`,
    backMenuKb());
}

function refsScreen(ctx) {
  const s = store.get().settings;
  const me = store.getUser(uidOf(ctx));
  const botUsername = s.botUsername || null;
  const link = botUsername ? `https://t.me/${esc(botUsername)}?start=ref${uidOf(ctx)}` : null;
  return show(ctx,
    `🎁 <b>Referral program</b>\n\n` +
    `Invite friends — earn <b>${esc(s.refPercent)}%</b> from each of their exchanges.\n` +
    `Your link ties a friend to you forever.\n\n` +
    (link ? `Your link:\n<code>${link}</code>\n\n` : 'Your link will appear once the bot is connected.\n\n') +
    `Invited: <b>${me?.referredCount || 0}</b>`,
    backMenuKb());
}

function supportPrompt(ctx) {
  clientFlows.set(uidOf(ctx), { type: 'support' });
  return show(ctx,
    `💬 <b>Pricelex Worldwide Support</b>\n\nWrite your question in one message — we will pass it to the operator.\nThe reply will arrive here and in the app.\n\n/cancel — cancel`,
    new InlineKeyboard().text('↩️ Menu', 'c:menu'));
}

/* ---------- widget actions (no rendering — the widget refreshes itself) ---------- */

async function clientPaidWidget(ctxLike, id) {
  const userId = String(ctxLike.from?.id || '');
  const found = store.getOrder(id);
  const o = found && String(found.userId) === userId ? store.expireIfNeeded(found) || found : null;
  if (!o) return { ok: 0, error: 'not_found' };
  if (o.status !== 'new' || !o.giftCode) return { ok: 0, error: 'not_allowed' };
  const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
  bus.emit('order_event', { order: upd, type: 'paid' });
  return { ok: 1, order: upd };
}

async function clientCancelWidget(ctxLike, id) {
  const userId = String(ctxLike.from?.id || '');
  const found = store.getOrder(id);
  const o = found && String(found.userId) === userId ? store.expireIfNeeded(found) || found : null;
  if (!o) return { ok: 0, error: 'not_found' };
  if (!['new', 'details'].includes(o.status)) return { ok: 0, error: 'not_allowed' };
  const upd = store.updateOrder(o.id, { status: 'cancelled' });
  bus.emit('order_event', { order: upd, type: 'cancelled' });
  return { ok: 1, order: upd };
}

/* ---------- entry: /start, /menu ---------- */

async function clientStart(ctx, refParam = '') {
  if (!isPrivate(ctx)) return;
  ensureUser(ctx, refParam);
  // If widgets are enabled and Telegram accepts them — show the live rates widget instead of the menu.
  if (await widget.trySendRatesWidget(ctx)) return;
  return clientMenu(ctx);
}

/* ---------- incoming routing ---------- */

async function handleClientCallback(ctx, d) {
  if (!isPrivate(ctx)) return ctx.answerCallbackQuery({ text: '' }).catch(() => {});
  await ctx.answerCallbackQuery().catch(() => {});
  if (d === 'c:menu') return clientMenu(ctx);
  if (d === 'c:exchange') return assetScreen(ctx);
  if (d === 'c:orders') return ordersList(ctx);
  if (d === 'c:info') return infoScreen(ctx);
  if (d === 'c:refs') return refsScreen(ctx);
  if (d === 'c:support') return supportPrompt(ctx);
  if (d === 'c:giftnom' || d.startsWith('c:giftnom:')) {
    const key = d === 'c:giftnom' ? currencies.GIFT_KEY : d.slice('c:giftnom:'.length);
    const pair = currencies.get(key);
    const s = store.get().settings;
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    if (!currencies.isEnabled(s, pair.key) || !currencies.rateOf(s, pair.currency)) {
      return show(ctx, 'This card is currently unavailable. Choose another card or try again later.', assetKb());
    }
    return giftIntro(ctx, pair);
  }
  if (d === 'c:giftnum' || d.startsWith('c:giftnum:')) {
    const flow = clientFlows.get(uidOf(ctx));
    const key = d === 'c:giftnum' ? flow?.key || currencies.GIFT_KEY : d.slice('c:giftnum:'.length);
    const pair = currencies.get(key);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    clientFlows.set(uidOf(ctx), { type: 'gift_units', key: pair.key });
    return show(ctx,
      'Enter the card amount in $ (multiple of $10, minimum $10):\n\n/cancel — cancel',
      new InlineKeyboard().text('↩️ Back to amount', `c:giftnom:${pair.key}`));
  }
  if (d.startsWith('c:units:')) {
    const parts = d.split(':');
    const flow = clientFlows.get(uidOf(ctx));
    const key = parts.length >= 4 ? parts[2] : flow?.key || currencies.GIFT_KEY;
    const rawUnits = parts.length >= 4 ? parts[3] : parts[2];
    const units = parseInt(rawUnits, 10);
    const pair = currencies.get(key);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    const s = store.get().settings;
    if (!currencies.isEnabled(s, pair.key) || !currencies.rateOf(s, pair.currency)) {
      return show(ctx, 'This card is currently unavailable. Choose another card or try again later.', assetKb());
    }
    if (!Number.isFinite(units) || currencies.validateUnits(units)) return giftIntro(ctx, pair);
    return askGiftWallet(ctx, units, pair);
  }
  if (d.startsWith('c:buy:')) {
    const pair = currencies.get(d.slice('c:buy:'.length));
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    const s = store.get().settings;
    if (!currencies.isEnabled(s, pair.key) || !currencies.rateOf(s, pair.currency)) {
      return show(ctx, `${esc(pair.label)} is currently unavailable for purchase. Choose another card.`, assetKb());
    }
    return giftRules(ctx, pair);
  }
  if (d.startsWith('c:order:')) return orderDetail(ctx, Number(d.slice(8)));
  if (d.startsWith('c:sendcode:')) {
    const id = Number(d.slice(11));
    const o = await loadOwnOrder(ctx, id);
    if (!o || !isGiftOrder(o)) return show(ctx, '🚫 Order not found.', backMenuKb());
    if (o.status !== 'details') return show(ctx, 'The code can be sent only after the operator joins.', orderActionsKb(o));
    clientFlows.set(uidOf(ctx), { type: 'gift_send_code', orderId: o.id });
    return show(ctx,
      `🎟 <b>${esc(giftLabel(o))} card code for $${giftUnits(o)}</b>\n\nThe operator is in the order and waiting for the code. Send the card code (e.g. XXXX-XXXX-XXXX-XXXX) in one message.\n\n/cancel — cancel`,
      new InlineKeyboard().text('↩️ Back to order', `c:order:${o.id}`));
  }
  if (d.startsWith('c:paid:')) return clientPaid(ctx, Number(d.slice(7)));
  if (d.startsWith('c:cancel:')) return clientCancel(ctx, Number(d.slice(9)));
  return clientMenu(ctx);
}

async function handleClientText(ctx) {
  if (!isPrivate(ctx)) return;
  const text = (ctx.message.text || '').trim();
  // /cancel at any point of a flow — bail back to the menu.
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^(отмен\w*|cancel)$/i.test(text)) {
    clientFlows.delete(uidOf(ctx));
    return clientMenu(ctx);
  }
  const f = clientFlows.get(uidOf(ctx));
  const s = store.get().settings;
  if (!f) {
    return ctx.reply('I am here to help with your exchange 🌌\nOpen the menu — or tap /menu.', { reply_markup: menuKb(s) });
  }
  if (f.type === 'gift_units') {
    const pair = currencies.get(f.key || currencies.GIFT_KEY);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    const n = parseNum(text);
    const units = currencies.floorUnits(n);
    if (!Number.isFinite(n) || currencies.validateUnits(units)) {
      return ctx.reply('Minimum amount is $10, in steps of $10. Example: 20');
    }
    return askGiftWallet(ctx, units, pair);
  }
  if (f.type === 'gift_wallet') {
    const wallet = text.trim();
    const units = f.units;
    const pair = currencies.get(f.key || currencies.GIFT_KEY);
    const { order, error } = createGiftOrder(ctx, units, wallet, pair);
    if (error) return ctx.reply(`⚠️ ${error}`);
    clientFlows.delete(uidOf(ctx));
    return show(ctx,
      `✅ <b>Order #${order.id} created!</b>\n\n` +
      `🎁 ${esc(giftLabel(order))} <b>$${giftUnits(order)}</b> → <b>${payoutOf(order)}</b>\n\n` +
      `⏳ <b>Waiting for the operator to join</b> — wait for their signal in this chat.\n` +
      `<b>Don't send anything and don't share the card code</b> until the operator asks. You have 1 hour per deal.`,
      new InlineKeyboard().text('📦 My orders', 'c:orders').text('❌ Cancel', `c:cancel:${order.id}`));
  }
  if (f.type === 'gift_send_code') {
    const code = text.replace(/\s+/g, ' ').trim();
    if (code.length < 8 || code.length > 200 || /\s{2,}/.test(code)) {
      return ctx.reply('The code is too short or has double spaces (minimum 8 characters). Try again:');
    }
    const o = await loadOwnOrder(ctx, f.orderId);
    if (!o) { clientFlows.delete(uidOf(ctx)); return show(ctx, '🚫 Order not found.', backMenuKb()); }
    if (!isGiftOrder(o)) { clientFlows.delete(uidOf(ctx)); return show(ctx, 'This is not a gift order.', backMenuKb()); }
    if (o.status === 'paid') { clientFlows.delete(uidOf(ctx)); return show(ctx, orderDetailText(o), orderActionsKb(o)); }
    if (o.status !== 'details' && o.status !== 'new') {
      clientFlows.delete(uidOf(ctx));
      return show(ctx, 'The code is not accepted for this order right now.', orderActionsKb(o));
    }
    if (o.status === 'new' && !o.giftCode) {
      return ctx.reply('⏳ The operator has not joined yet. <b>Don\'t send anything</b> — wait for their signal.');
    }
    const upd = store.updateOrder(o.id, { giftCode: code, status: 'paid', paidAt: Date.now() });
    clientFlows.delete(uidOf(ctx));
    bus.emit('order_event', { order: upd, type: 'paid' });
    return show(ctx,
      `🔎 <b>Order #${o.id}: code sent to the operator.</b>\nVerification usually takes 5–15 minutes. Payout — ${payoutOf(upd)}.`,
      new InlineKeyboard().text('📦 My orders', 'c:orders').text('↩️ Menu', 'c:menu'));
  }
  if (f.type === 'support') {
    ensureUser(ctx);
    const message = store.createSupportMessage(uidOf(ctx), 'user', text.slice(0, 2000));
    bus.emit('support_message', { message, user: { id: uidOf(ctx), first_name: ctx.from.first_name, username: ctx.from.username || null } });
    clientFlows.delete(uidOf(ctx));
    return show(ctx, '✅ <b>Passed to the operator.</b>\nWe will reply here and in the app support chat.', backMenuKb());
  }
  clientFlows.delete(uidOf(ctx));
  return ctx.reply('Something went wrong — let\'s start over.', { reply_markup: menuKb(s) });
}

/* PDF receipt from the client: receipts are not required for gift orders — kept as a stub for legacy clients. */
async function handleClientDocument(ctx, bot) {
  if (!isPrivate(ctx)) return;
  return ctx.reply('No receipt needed: the card code you send after the operator joins is enough.\n/cancel — cancel');
}

module.exports = {
  clientStart, // entry point for /start and /menu (ensureUser + widget-or-menu)
  sendClientMenu: clientMenu, // plain menu screen — used from the widget ("Exchange")
  handleClientCallback,
  handleClientText,
  handleClientDocument,
  clientPaidWidget,
  clientCancelWidget,
  GIFT_PRIVACY,
};
