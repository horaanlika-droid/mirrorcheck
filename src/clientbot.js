// Клиентский бот VEGA — тот же обменник без Mini App, для тех, кто не хочет открывать приложение.
// Флоу: /start → меню → подарочная карта → номинал → Bitcoin-кошелёк → заявка,
// «Мои заявки», «Поддержка», «Реферальная программа», «Инфо». Всё на обычных сообщениях
// и кнопках — работает у любого клиента Telegram без Mini App и без виджетов.
// Только выкуп USD gift-карт Google, iTunes, Xbox и Apple Store с выплатой в BTC.
const { InlineKeyboard } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const currencies = require('./currencies');
const { esc, fmtRub, fmtCrypto, fmtDate, parseNum } = require('./util');
const widget = require('./widget');

const clientFlows = new Map(); // userId -> FSM state
const isPrivate = (ctx) => ctx.chat?.type === 'private' && ctx.from;
const uidOf = (ctx) => String(ctx.from.id);
const isGiftOrder = (o) => o && o.direction === 'sell';
const giftLabel = (o) => currencies.label(o.currency);
const giftUnits = (o) => Number(o.units) || 0;
const payoutOf = (o, amount = o.crypto) => fmtCrypto(amount, 'BTC', currencies.displayDecimals());

/* ---------- контент ---------- */

// Преимущество гифт-карт в минимизации цифрового следа.
const GIFT_PRIVACY =
  '🛡 <b>Минимальный цифровой след</b>\n' +
  '• Карту можно купить за наличные — она ничем не связана с вашим банковским счётом и паспортом.\n' +
  '• Мы не запрашиваем документы и регистрацию: только код карты и адрес Bitcoin-кошелька.\n' +
  '• Выплата идёт сразу на ваш кошелёк — без банков, бирж и посредников.\n' +
  '• Меньше точек, где фиксируются ваши данные, — меньше цифрового следа.';

/* ---------- состояние ---------- */

const ensureUser = (ctx, refParam = '') =>
  store.touchUser({ id: ctx.from.id, first_name: ctx.from.first_name || 'Клиент', username: ctx.from.username || null }, refParam);

const availableGift = () =>
  currencies.list().filter(
    (p) => currencies.isEnabled(store.get().settings, p.key) && currencies.rateOf(store.get().settings, p.currency) > 0
  );

/* ---------- клавиатуры ---------- */

function menuKb(s) {
  const kb = new InlineKeyboard()
    .text('💱 Выкупить карту', 'c:exchange').text('📦 Мои заявки', 'c:orders').row()
    .text('💬 Поддержка', 'c:support').text('ℹ️ Инфо', 'c:info').row()
    .text('🎁 Реферальная программа', 'c:refs');
  // Telegram шлёт web_app только по https — иначе всё сообщение отклоняется и клиент видит тишину.
  if (s.publicUrl && /^https:\/\//i.test(s.publicUrl)) kb.row().webApp('📱 Открыть приложение', s.publicUrl);
  return kb;
}

const backMenuKb = () => new InlineKeyboard().text('↩️ В меню', 'c:menu');

function assetKb() {
  const kb = new InlineKeyboard();
  for (const p of availableGift()) {
    kb.text(`🎁 ${p.label}`, `c:buy:${p.key}`).row();
  }
  kb.text('↩️ В меню', 'c:menu');
  return kb;
}

/* ---------- показ экранов (редактируем сообщение на колбэках) ---------- */

async function show(ctx, text, kb) {
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, opts);
    } catch (e) {
      /* сообщение уже такое или слишком старое — просто отправим новое */
    }
  }
  try {
    return await ctx.reply(text, opts);
  } catch (e) {
    // Telegram отклонил reply_markup (например, не-https web_app-ссылка) —
    // отвечаем без кнопок, чтобы клиент не остался без ответа.
    console.error('[clientbot] ответ отклонён Telegram:', e && e.message);
    try {
      return await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (e2) {
      console.error('[clientbot] ответ без клавиатуры тоже отклонён:', e2 && e2.message);
      return null;
    }
  }
}

function clientMenu(ctx) {
  const s = store.get().settings;
  const online = s.online ? '🟢 Обменник <b>ОНЛАЙН</b>' : '🔴 Обменник <b>ОФФЛАЙН</b>';
  return show(ctx,
    `🌌 <b>VEGA | Official</b> — обменник\n${online}\n\n` +
    `Выкупаем подарочные карты Google, iTunes, Xbox и Apple Store (регион США, USD) с выплатой в BTC.\n` +
    `Что будем делать?`,
    menuKb(s));
}

function assetScreen(ctx) {
  const s = store.get().settings;
  if (!s.online) {
    return show(ctx, '⛔ <b>Выкуп временно недоступен.</b>\nМы скоро вернёмся — загляните чуть позже.', backMenuKb());
  }
  if (!availableGift().length) {
    return show(ctx, '💱 <b>Направления временно недоступны.</b>\nЗагляните чуть позже.', backMenuKb());
  }
  return show(ctx, '💱 <b>Выбор карты</b>\n\nВыберите, какую карту выкупаем:', assetKb());
}

/* ---------- заявка: подарочная карта → BTC ---------- */

// Первое, что видит клиент: диалог с правилами передачи карты.
function giftRules(ctx, pair) {
  clientFlows.delete(uidOf(ctx));
  const label = pair?.label || currencies.gift().label;
  return show(ctx,
    `🎁 <b>Продажа ${esc(label)}</b>\n\n` +
    `<b>Правила передачи карты:</b>\n` +
    `1. Карта — <b>${esc(label)}</b> для региона <b>США</b>, в валюте <b>USD</b>, с полным неизрасходованным балансом. Карты других регионов и валют не принимаем.\n` +
    `2. Сначала создаётся заявка, затем <b>подключается оператор</b>. <b>Ничего не отправляйте и никому не сообщайте код до его команды.</b>\n` +
    `3. Код карты вы отправляете здесь (или в приложении) <b>только после подключения оператора</b>. Он проверит карту (обычно 5–15 минут).\n` +
    `4. Выплата — в <b>BTC</b> на ваш Bitcoin-кошелёк. Сумма определяется по актуальному курсу BTC/USD.\n` +
    `5. Поддержка никогда не просит код и деньги вне заявки. Не сообщайте код никому, кроме оператора в рамках заявки.\n` +
    `6. На сделку даётся <b>1 час</b> с момента создания заявки. Если карта недействительна — заявка отклоняется без выплаты.\n\n` +
    GIFT_PRIVACY,
    new InlineKeyboard().text('✅ Понятно — выбрать номинал', `c:giftnom:${pair.key}`).row().text('↩️ К выбору карты', 'c:exchange'));
}

function giftIntro(ctx, pair) {
  const s = store.get().settings;
  const rate = currencies.rateOf(s, pair.currency);
  clientFlows.set(uidOf(ctx), { type: 'gift_select', key: pair.key });
  const kb = new InlineKeyboard()
    .text('$10', `c:units:${pair.key}:10`).text('$20', `c:units:${pair.key}:20`).text('$50', `c:units:${pair.key}:50`).text('$100', `c:units:${pair.key}:100`).row()
    .text('Другая сумма', `c:giftnum:${pair.key}`).row()
    .text('↩️ К выбору карты', 'c:exchange');
  return show(ctx,
    `${esc(pair.label)} → BTC\n\n` +
    `Вы отдаёте код карты ${esc(pair.label)} номинала в <b>USD</b>, мы выплачиваем BTC на ваш Bitcoin-кошелёк.\n\n` +
    `💱 Курс выплаты: <b>1 $ = ${esc(fmtCrypto(rate, 'BTC', 8))}</b>. Курс BTC/USD обновляется автоматически.\n` +
    `⏱ На сделку — 1 час с момента создания.\n` +
    `✅ Принимаем только карты региона США в долларах (USD).\n\n` +
    GIFT_PRIVACY + `\n\n` +
    `Выберите номинал:`,
    kb);
}

// Заявка создаётся БЕЗ кода: код клиент отправит только после подключения оператора.
function askGiftWallet(ctx, units, pair) {
  clientFlows.set(uidOf(ctx), { type: 'gift_wallet', units, key: pair.key });
  return show(ctx,
    `👛 <b>Адрес Bitcoin-кошелька</b>\n\n` +
    `Куда выплатить BTC? Отправьте Bitcoin-адрес: <b>bc1…</b>, <b>1…</b> или <b>3…</b>.\n\n` +
    `/cancel — отмена`,
    new InlineKeyboard().text('↩️ К номиналу', `c:giftnom:${pair.key}`));
}

function createGiftOrder(ctx, units, wallet, pair) {
  const s = store.get().settings;
  if (!s.online) return { error: 'Обмен временно недоступен — попробуйте чуть позже.' };
  if (!pair || pair.kind !== 'gift') return { error: 'Неизвестный вид подарочной карты.' };
  if (!currencies.isEnabled(s, pair.key)) return { error: 'Продажа этой карты сейчас недоступна.' };
  const unitsError = currencies.validateUnits(units);
  if (unitsError) return { error: unitsError };
  const walletError = currencies.validateWallet(wallet);
  if (walletError) return { error: walletError };
  const payout = currencies.giftPayout(s, units, pair.currency);
  if (!payout || !(payout.crypto > 0)) {
    return { error: 'Курс BTC для выплаты временно недоступен — попробуйте позже.' };
  }
  const usr = ensureUser(ctx);
  const order = store.createOrder({
    userId: uidOf(ctx),
    userName: ctx.from.first_name || 'Клиент',
    userUsername: ctx.from.username || null,
    expiresAt: Date.now() + (Number(pair.ttlMinutes) || 60) * 60 * 1000,
    rub: payout.rub,
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

/* ---------- «Мои заявки» ---------- */

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
      '📦 <b>У вас пока нет заявок.</b>\nОформите первый обмен — он появится здесь.',
      new InlineKeyboard().text('💱 Выкупить карту', 'c:exchange').text('↩️ В меню', 'c:menu'));
  }
  const kb = new InlineKeyboard();
  for (const o of shown) {
    kb.text(`${statusIcon(o)} #${o.id} · ${shortOf(o)} · ${amountOf(o)}`, `c:order:${o.id}`).row();
  }
  kb.text('💱 Выкупить карту', 'c:exchange').text('↩️ В меню', 'c:menu');
  return show(ctx, `📦 <b>Ваши заявки</b>\n\n${active.length ? `Активных: ${active.length}` : 'Активных нет'}. Нажмите на заявку, чтобы открыть:`, kb);
}

async function loadOwnOrder(ctx, id) {
  const o = store.getOrder(id);
  if (!o || String(o.userId) !== uidOf(ctx)) return null;
  return store.expireIfNeeded(o) || o;
}

const orderActionsKb = (o) => {
  const kb = new InlineKeyboard();
  if (o.status === 'details' && !o.giftCode) {
    // Оператор подключился — клиент отправляет код.
    kb.text('🎟 Отправить код карты', `c:sendcode:${o.id}`);
  } else if (o.status === 'details') {
    kb.text('🔄 Обновить', `c:order:${o.id}`);
  } else if (o.status === 'new') {
    if (o.giftCode) kb.text('✅ Я оплатил', `c:paid:${o.id}`); // совместимость со старыми заявками
    else kb.text('🔄 Обновить', `c:order:${o.id}`);
  } else if (o.status === 'paid') {
    kb.text('🔄 Обновить', `c:order:${o.id}`);
  }
  if (['new', 'details'].includes(o.status)) kb.text('❌ Отменить', `c:cancel:${o.id}`);
  kb.row().text('📦 К заявкам', 'c:orders').text('↩️ В меню', 'c:menu');
  return kb;
};

function orderDetailText(o) {
  const head = `<b>Заявка #${o.id}</b> · ${esc(fmtDate(o.createdAt))}\n`;
  if (o.status === 'new') {
    if (o.giftCode) {
      // Совместимость со старыми заявками, где код был указан при создании.
      return head +
        `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
        `🎟 Код <code>${esc(o.giftCode)}</code> уже у оператора.\n` +
        `Когда будете готовы отдать карту — нажмите «Я оплатил».`;
    }
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `⏳ <b>Ожидаем подключения оператора</b> — обычно несколько минут.\n` +
      `<b>Ничего не отправляйте и никому не сообщайте код</b> до команды оператора в этой заявке.`;
  }
  if (o.status === 'details' && !o.giftCode) {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🤝 <b>Оператор на связи.</b> Дождался и просит код карты.\n` +
      `Нажмите «🎟 Отправить код карты» и отправьте код одним сообщением.`;
  }
  if (o.status === 'details' && o.giftCode) {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🔎 Код отправлен — карта на проверке. Обычно 5–15 минут.`;
  }
  if (o.status === 'paid') {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🔎 Карта на проверке: оператор проверит регион (<b>США</b>), валюту (<b>USD</b>), номинал и баланс.\n` +
      `Обычно 5–15 минут.`;
  }
  if (o.status === 'completed') {
    return head + `🟢 <b>Завершена.</b> Выплата ${payoutOf(o)} отправлена на ваш кошелёк:\n<code>${esc(o.wallet)}</code>${o.txUrl ? `\n🔗 ${esc(o.txUrl)}` : ''}`;
  }
  return head + `${o.status === 'rejected' ? '🔴 Отклонена оператором.' : '⚪ Отменена.'}${o.cancelReason ? `\nПричина: ${esc(o.cancelReason)}` : ''}`;
}

async function orderDetail(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  // Если включены виджеты и Telegram их принимает — показываем карточку заявки внутри сообщения.
  const sent = await widget.trySendOrderWidget(ctx, o);
  if (sent) return;
  return show(ctx, orderDetailText(o), orderActionsKb(o));
}

/* ---------- действия клиента ---------- */

async function clientPaid(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  if (o.status === 'new' && o.giftCode) {
    const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
    bus.emit('order_event', { order: upd, type: 'paid' });
    return show(ctx, `🔎 <b>Заявка #${o.id}</b>\nКод отправлен на проверку. Обычно 5–15 минут — оператор проверит карту и выплатит ${payoutOf(o)}.`, new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ В меню', 'c:menu'));
  }
  return show(ctx, orderDetailText(o), orderActionsKb(o));
}

async function clientCancel(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  if (!['new', 'details'].includes(o.status)) {
    return show(ctx, 'Отменить можно только новую или ожидающую код заявку.', orderActionsKb(o));
  }
  if (o.status === 'cancelled' && o.cancelReason === store.EXPIRED) {
    return show(ctx, `${store.EXPIRED}. Создайте новую заявку.`, backMenuKb());
  }
  const upd = store.updateOrder(o.id, { status: 'cancelled' });
  bus.emit('order_event', { order: upd, type: 'cancelled' });
  return show(ctx, `⚪ <b>Заявка #${o.id} отменена.</b>`, new InlineKeyboard().text('💱 Новый выкуп', 'c:exchange').text('↩️ В меню', 'c:menu'));
}

/* ---------- прочее: инфо, рефералы, поддержка ---------- */

function infoScreen(ctx) {
  const s = store.get().settings;
  return show(ctx,
    `ℹ️ <b>VEGA | Official</b>\n\n` +
    `Курс выплаты и комиссию уточняйте в заявке — выплата только в BTC.\n\n` +
    `Статус: ${s.online ? '🟢 Онлайн' : '🔴 Оффлайн'}\n` +
    `${s.announcement ? `📢 ${esc(s.announcement)}\n\n` : '\n'}` +
    `📇 Оператор: ${esc(s.operator)}\n📣 Канал: ${esc(s.channel)}\n💬 Чат: ${esc(s.chat)}`,
    backMenuKb());
}

function refsScreen(ctx) {
  const s = store.get().settings;
  const me = store.getUser(uidOf(ctx));
  const botUsername = s.botUsername || null;
  const link = botUsername ? `https://t.me/${esc(botUsername)}?start=ref${uidOf(ctx)}` : null;
  return show(ctx,
    `🎁 <b>Реферальная программа</b>\n\n` +
    `Приглашайте друзей — получайте <b>${esc(s.refPercent)}%</b> с каждого их обмена.\n` +
    `Ссылка закрепляет друга за вами навсегда.\n\n` +
    (link ? `Ваша ссылка:\n<code>${link}</code>\n\n` : 'Ссылка появится после подключения бота.\n\n') +
    `Приглашено: <b>${me?.referredCount || 0}</b>`,
    backMenuKb());
}

function supportPrompt(ctx) {
  clientFlows.set(uidOf(ctx), { type: 'support' });
  return show(ctx,
    `💬 <b>Поддержка VEGA</b>\n\nНапишите ваш вопрос одним сообщением — передадим оператору.\nОтвет придёт сюда и в приложение.\n\n/cancel — отмена`,
    new InlineKeyboard().text('↩️ В меню', 'c:menu'));
}

/* ---------- виджет-действия (без рендера — виджет обновится сам) ---------- */

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

/* ---------- вход: /start, /menu ---------- */

async function clientStart(ctx, refParam = '') {
  if (!isPrivate(ctx)) return;
  ensureUser(ctx, refParam);
  // Если виджеты включены и Telegram их принимает — показываем живой виджет курсов вместо меню.
  if (await widget.trySendRatesWidget(ctx)) return;
  return clientMenu(ctx);
}

/* ---------- роутинг входящих ---------- */

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
      return show(ctx, 'Продажа этой карты сейчас недоступна. Выберите другой вид карты или попробуйте позже.', assetKb());
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
      'Введите номинал карты в $ (кратно $10, минимум $10):\n\n/cancel — отмена',
      new InlineKeyboard().text('↩️ К номиналу', `c:giftnom:${pair.key}`));
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
      return show(ctx, 'Продажа этой карты сейчас недоступна. Выберите другой вид карты или попробуйте позже.', assetKb());
    }
    if (!Number.isFinite(units) || currencies.validateUnits(units)) return giftIntro(ctx, pair);
    return askGiftWallet(ctx, units, pair);
  }
  if (d.startsWith('c:buy:')) {
    const pair = currencies.get(d.slice('c:buy:'.length));
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    const s = store.get().settings;
    if (!currencies.isEnabled(s, pair.key) || !currencies.rateOf(s, pair.currency)) {
      return show(ctx, `Выкуп ${esc(pair.label)} сейчас недоступен. Выберите другую карту.`, assetKb());
    }
    return giftRules(ctx, pair);
  }
  if (d.startsWith('c:order:')) return orderDetail(ctx, Number(d.slice(8)));
  if (d.startsWith('c:sendcode:')) {
    const id = Number(d.slice(11));
    const o = await loadOwnOrder(ctx, id);
    if (!o || !isGiftOrder(o)) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
    if (o.status !== 'details') return show(ctx, 'Код можно отправить только после подключения оператора.', orderActionsKb(o));
    clientFlows.set(uidOf(ctx), { type: 'gift_send_code', orderId: o.id });
    return show(ctx,
      `🎟 <b>Код карты ${esc(giftLabel(o))} на $${giftUnits(o)}</b>\n\nОператор в заявке и ждёт код. Отправьте код карты (например XXXX-XXXX-XXXX-XXXX) одним сообщением.\n\n/cancel — отмена`,
      new InlineKeyboard().text('↩️ К заявке', `c:order:${o.id}`));
  }
  if (d.startsWith('c:paid:')) return clientPaid(ctx, Number(d.slice(7)));
  if (d.startsWith('c:cancel:')) return clientCancel(ctx, Number(d.slice(9)));
  return clientMenu(ctx);
}

async function handleClientText(ctx) {
  if (!isPrivate(ctx)) return;
  const text = (ctx.message.text || '').trim();
  // /cancel в любой момент сценария — выходим в меню.
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^отмен\w*$/i.test(text)) {
    clientFlows.delete(uidOf(ctx));
    return clientMenu(ctx);
  }
  const f = clientFlows.get(uidOf(ctx));
  const s = store.get().settings;
  if (!f) {
    return ctx.reply('Я здесь, чтобы помочь с обменом 🌌\nОткройте меню — или нажмите /menu.', { reply_markup: menuKb(s) });
  }
  if (f.type === 'gift_units') {
    const pair = currencies.get(f.key || currencies.GIFT_KEY);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    const n = parseNum(text);
    const units = currencies.floorUnits(n);
    if (!Number.isFinite(n) || currencies.validateUnits(units)) {
      return ctx.reply('Минимальный номинал — $10, кратно $10. Например: 20');
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
      `✅ <b>Заявка #${order.id} создана!</b>\n\n` +
      `🎁 ${esc(giftLabel(order))} <b>$${giftUnits(order)}</b> → <b>${payoutOf(order)}</b>\n\n` +
      `⏳ <b>Ожидаем подключения оператора</b> — дождитесь его сигнала в этом чате.\n` +
      `<b>Ничего не отправляйте и никому не сообщайте код карты</b> до команды оператора. На сделку даётся 1 час.`,
      new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('❌ Отменить', `c:cancel:${order.id}`));
  }
  if (f.type === 'gift_send_code') {
    const code = text.replace(/\s+/g, ' ').trim();
    if (code.length < 8 || code.length > 200 || /\s{2,}/.test(code)) {
      return ctx.reply('Код слишком короткий или с двойными пробелами (минимум 8 символов). Попробуйте ещё раз:');
    }
    const o = await loadOwnOrder(ctx, f.orderId);
    if (!o) { clientFlows.delete(uidOf(ctx)); return show(ctx, '🚫 Заявка не найдена.', backMenuKb()); }
    if (!isGiftOrder(o)) { clientFlows.delete(uidOf(ctx)); return show(ctx, 'Это не гифт-заявка.', backMenuKb()); }
    if (o.status === 'paid') { clientFlows.delete(uidOf(ctx)); return show(ctx, orderDetailText(o), orderActionsKb(o)); }
    if (o.status !== 'details' && o.status !== 'new') {
      clientFlows.delete(uidOf(ctx));
      return show(ctx, 'Код сейчас не принимается по этой заявке.', orderActionsKb(o));
    }
    if (o.status === 'new' && !o.giftCode) {
      return ctx.reply('⏳ Оператор ещё не подключился. <b>Ничего не отправляйте</b> — дождитесь его сигнала.');
    }
    const upd = store.updateOrder(o.id, { giftCode: code, status: 'paid', paidAt: Date.now() });
    clientFlows.delete(uidOf(ctx));
    bus.emit('order_event', { order: upd, type: 'paid' });
    return show(ctx,
      `🔎 <b>Заявка #${o.id}: код отправлен оператору.</b>\nОбычно проверка занимает 5–15 минут. Выплата — ${payoutOf(upd)}.`,
      new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ В меню', 'c:menu'));
  }
  if (f.type === 'support') {
    ensureUser(ctx);
    const message = store.createSupportMessage(uidOf(ctx), 'user', text.slice(0, 2000));
    bus.emit('support_message', { message, user: { id: uidOf(ctx), first_name: ctx.from.first_name, username: ctx.from.username || null } });
    clientFlows.delete(uidOf(ctx));
    return show(ctx, '✅ <b>Передал оператору.</b>\nОтветим здесь и в чате поддержки приложения.', backMenuKb());
  }
  clientFlows.delete(uidOf(ctx));
  return ctx.reply('Что-то пошло не так — начнём заново.', { reply_markup: menuKb(s) });
}

/* Чек PDF от клиента: по gift-заявкам чеки не требуются — оставлен заглушкой на случай старого клиента. */
async function handleClientDocument(ctx, bot) {
  if (!isPrivate(ctx)) return;
  return ctx.reply('Чек не требуется: по карте достаточно кода, который вы отправите после подключения оператора.\n/cancel — отмена');
}

module.exports = {
  clientStart, // точка входа для /start и /menu (ensureUser + виджет-или-меню)
  sendClientMenu: clientMenu, // обычный экран меню — используется из виджета («Обменять»)
  handleClientCallback,
  handleClientText,
  handleClientDocument,
  clientPaidWidget,
  clientCancelWidget,
  GIFT_PRIVACY,
};
