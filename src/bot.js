const { Bot, InlineKeyboard, InputFile } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const admins = require('./admins');
const rates = require('./rates');
const receipts = require('./receipts');
const attachments = require('./attachments');
const orderChat = require('./orderchat');
const currencies = require('./currencies');
const { esc, fmtUsdt, fmtOrderPayout, fmtDate, fmtSize, parseNum } = require('./util');
const clientbot = require('./clientbot');
const widget = require('./widget');

let bot = null;
const flows = new Map(); // adminId -> { type, orderId?, userId? }

const isAdmin = (ctx) => ctx.chat?.type === 'private' && admins.has(ctx.from?.id);

const STATUS_LABEL = {
  new: '🕐 Ожидает подключения оператора (кнопка «🤝»)',
  details: '🤝 Оператор подключён — ждём код карты от клиента',
  paid: '⏳ Карта на проверке — нужно подтверждение',
  completed: '🟢 Завершена',
  rejected: '🔴 Отклонена',
  cancelled: '⚪ Отменена клиентом',
};

const dirLabel = (o) => currencies.label(o.currency);
const giftUnits = (o) => Number(o.units) || 0;
const payoutText = (o) => esc(fmtOrderPayout(o));

function orderText(o) {
  const ref = o.referrer ? store.getUser(o.referrer) : null;
  const payoutCur = currencies.payoutCurrencyOf(o);
  const netFee = Number(o.networkFee) || 0;
  const feeLine = netFee > 0
    ? `💸 Комиссия сети: <b>${esc(String(netFee))} ${esc(payoutCur)}</b> (до комиссии: ${esc(String(o.grossCrypto ?? o.crypto))} ${esc(payoutCur)})\n`
    : (o.network === currencies.PAYOUT_NETWORK ? '⚡ Вывод: <b>BEP-20 · моментально, без комиссии</b>\n' : '');
  return (
    `📥 <b>Заявка #${o.id}</b>\n` +
    `👤 ${esc(o.userName)}${o.userUsername ? ' (@' + esc(o.userUsername) + ')' : ''} · <code>${esc(o.userId)}</code>\n` +
    `🎁 Карта: <b>${esc(dirLabel(o))} $${giftUnits(o)}</b> → выплата ${payoutText(o)}\n` +
    feeLine +
    (o.promoCode ? `🏷 Промокод: <b>${esc(o.promoCode)}</b> (+${o.promoPercent}%)\n` : '') +
    (Number(o.loyaltyDiscountPercent) > 0 ? `🎉 Скидка комиссии за каждый 5-й обмен: <b>${o.loyaltyDiscountPercent} п.п.</b>\n` : '') +
    `🎟 Код карты: <code>${esc(o.giftCode || '—')}</code>\n` +
    `✅ Карта должна быть для региона <b>США</b> в валюте <b>USD</b> (другие регионы и валюты не принимаем)\n` +
    `👛 Кошелёк клиента: <code>${esc(o.wallet || '—')}</code>\n` +
    (o.receiptName ? `🖼 Скрин карты: ${esc(o.receiptName)}\n` : '') +
    `🧬 Реферер: ${ref ? esc(ref.name) + ' (#' + esc(ref.id) + ')' : '—'}\n` +
    (o.txUrl ? `🔗 Блокчейн: ${esc(o.txUrl)}\n` : '') +
    `🕒 ${fmtDate(o.createdAt)}\n` +
    `Статус: ${
      o.status === 'new'
        ? STATUS_LABEL.new
        : o.status === 'details'
          ? STATUS_LABEL.details
          : o.status === 'paid'
            ? `🔎 Карта на проверке — подтвердите и выплатите ${payoutText(o)}`
            : STATUS_LABEL[o.status] || o.status
    }` +
    (o.expiresAt && !['completed', 'rejected', 'cancelled'].includes(o.status)
      ? `\n⏳ Срок на сделку: до ${fmtDate(o.expiresAt)}`
      : '')
  );
}

// Завершение сделки: оператор проверил карту и выплатил клиенту валюту.
// Используется и из карточки заявки, и прямо из диалога сделки.
const CONFIRM_PROMPT = 'confirm';

async function completeOrder(ctx, id) {
  const o = store.getOrder(id);
  if (!o) return ctx.reply('Заявка не найдена.', { reply_markup: homeKb() });
  if (o.status === 'completed') {
    return ctx.reply(`✅ Заявка #${o.id} уже завершена — выплата ${payoutText(o)} на кошелёк:\n👛 <code>${esc(o.wallet)}</code>`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔗 Ссылка на блокчейн', `o:${o.id}:tx`),
    });
  }
  if (o.status !== 'paid') {
    return ctx.reply(
      `⚠️ Заявку #${o.id} нельзя завершить: статус «${STATUS_LABEL[o.status] || o.status}».\n` +
      'Выплата доступна после того, как клиент пришлёт код карты и нажмёт «Я оплатил».',
      { parse_mode: 'HTML', reply_markup: orderKb(o) }
    );
  }
  // Деньги нельзя выдать дважды: статус меняется атомарно с проверкой.
  const fresh = store.getOrder(o.id);
  if (!fresh || fresh.status !== 'paid') {
    return ctx.reply('Статус заявки уже изменился — откройте её заново.', { reply_markup: homeKb() });
  }
  const upd = store.updateOrder(o.id, { status: 'completed', completedAt: Date.now() });
  await sendOrUpdateOrderAdmin(upd);
  // Клиенту в Telegram — отдельное сообщение о выплате; веб-клиенту — статус в приложении.
  await notifyClientCompleted(upd);
  return ctx.reply(
    `📨 <b>Заявка #${upd.id} завершена — валюта выдана.</b>\n` +
    `🎁 Карта ${dirLabel(upd)} на ${giftUnits(upd)} проверена.\n` +
    `💸 Выплачено: <b>${payoutText(upd)}</b>\n` +
    `👛 Кошелёк клиента: <code>${esc(upd.wallet)}</code>\n\n` +
    '💡 Опционально добавьте ссылку на блокчейн-транзакцию — клиент увидит её в заявке.',
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('🔗 Добавить ссылку на блокчейн', `o:${upd.id}:tx`)
        .row()
        .text('💬 Вернуться в диалог', `o:${upd.id}:chat`)
        .text('📥 К заявкам', 'm:orders'),
    }
  );
}

// Подпись кнопки «выдать» в диалоге: сумма и сеть выплаты.
function orderChatPayout(o) {
  return `${fmtOrderPayout(o)} · ${currencies.payoutLabelOf(o)}`;
}

async function notifyClientCompleted(o) {
  if (!telegramChatId(o.userId)) return false;
  try {
    await bot.api.sendMessage(
      o.userId,
      `✅ <b>Заявка #${o.id} завершена.</b>\n\n` +
      `Оператор проверил карту ${esc(dirLabel(o))} на ${giftUnits(o)}.\n` +
      `💸 Выплата <b>${payoutText(o)}</b> отправлена на ваш кошелёк:\n<code>${esc(o.wallet)}</code>\n\n` +
      'Спасибо за обмен! Отзыв можно оставить в приложении или через /menu → ⭐ Отзывы.',
      { parse_mode: 'HTML' }
    );
    return true;
  } catch (e) {
    console.error(`[bot] completed → client ${o.userId}:`, e.message);
    return false;
  }
}

function orderKb(o) {
  const kb = new InlineKeyboard();
  if (o.status === 'new') {
    // Двухфазная сделка: клиент ждёт оператора и ничего не отправляет без его команды.
    kb.text('🤝 Подключить — запросить код', `o:${o.id}:connect`).row();
    kb.text('🔄 Обновить', `o:${o.id}`).text('❌ Отклонить', `o:${o.id}:reject`);
  } else if (o.status === 'details') {
    // Оператор подключился — ждём код карты от клиента.
    kb.text('🔄 Обновить', `o:${o.id}`).text('❌ Отклонить', `o:${o.id}:reject`);
  } else if (o.status === 'paid') {
    // Код прислан и клиент нажал «Я оплатил» → проверяем карту и выплачиваем сумму заявки.
    kb.text(`✅ Проверено — выдать ${payoutText(o)}`, `o:${o.id}:confirm`)
      .row()
      .text('❌ Карта недействительна', `o:${o.id}:unpaid`);
  } else if (o.status === 'completed') {
    if (o.receipt) kb.text('🧾 Получить чек', `o:${o.id}:receipt`);
    kb.text(o.txUrl ? '🔗 Изменить ссылку' : '🔗 Добавить ссылку на блокчейн', `o:${o.id}:tx`);
    kb.row().text(' К списку заявок', 'm:orders');
  } else {
    if (o.receipt) kb.text('🧾 Получить чек', `o:${o.id}:receipt`).row();
    if (o.txUrl) kb.text('🔗 Ссылка на блокчейн', `o:${o.id}:tx`).row();
    kb.text(' К списку заявок', 'm:orders');
  }
  return kb.row().text('💬 Диалог сделки', `o:${o.id}:chat`);
}

const orderQueues = new Map();
function sendOrUpdateOrderAdmin(order) {
  const previous = orderQueues.get(order.id) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    if (!bot) return;
    await Promise.all(admins.all().map(async (adminId) => {
      const o = store.getOrder(order.id);
      if (!o || !admins.has(adminId)) return;
      const opts = { parse_mode: 'HTML', reply_markup: orderKb(o) };
      const messageId = o.adminMsgIds?.[adminId] || (adminId === config.adminId ? o.adminMsgId : null);
      if (messageId) {
        try {
          await bot.api.editMessageText(adminId, messageId, orderText(o), opts);
          return;
        } catch (e) {
          if (/message is not modified/i.test(e.description || e.message)) return;
        }
      }
      try {
        const m = await bot.api.sendMessage(adminId, orderText(o), opts);
        store.mutate(() => {
          (o.adminMsgIds ||= {})[adminId] = m.message_id;
        });
      } catch (e) {
        console.error(`[bot] order #${o.id} → admin ${adminId}:`, e.message);
      }
    }));
  });
  orderQueues.set(order.id, task);
  task.finally(() => {
    if (orderQueues.get(order.id) === task) orderQueues.delete(order.id);
  }).catch(() => {});
  return task;
}

// Веб-клиенты не имеют Telegram-чата: отправка им невозможна и не должна
// логироваться как ошибка с их идентификатором.
const telegramChatId = (userId) => (/^[1-9]\d{0,15}$/.test(String(userId)) ? String(userId) : null);

async function broadcast(text, options = {}) {
  if (!bot) return;
  await Promise.all(admins.all().map(async (id) => {
    try { await bot.api.sendMessage(id, text, options); }
    catch (e) { console.error(`[bot] admin ${id}:`, e.message); }
  }));
}

// Объявление всем клиентам, которые когда-либо открывали бота/приложение.
const CLIENTS_ANNOUNCE_OPEN =
  '🟢 <b>Pricelex Worldwide: приём карт открыт!</b>\n\n' +
  'Снова принимаем подарочные карты Google, iTunes, Xbox и Apple Store региона США в USD 🎁\n' +
  'Моментальный вывод без комиссии — USDT (BEP-20), а также доступны Bitcoin (BTC), TRC-20, ERC-20 и TON по комиссии сети.';

async function announceToClients(text) {
  if (!bot) return { sent: 0, failed: 0 };
  const users = Object.keys(store.get().users || {}).filter(telegramChatId);
  let sent = 0; let failed = 0;
  await Promise.all(users.map(async (id) => {
    try { await bot.api.sendMessage(id, text, { parse_mode: 'HTML' }); sent += 1; }
    catch (e) { failed += 1; console.error(`[bot] announce → ${id}:`, e.message); }
  }));
  console.log(`[Pricelex Worldwide] объявление клиентам: отправлено ${sent}, не доставлено ${failed}`);
  return { sent, failed };
}

async function sendReceiptTo(adminId, o) {
  const file = receipts.filePath(o.id);
  if (!o.receipt || !receipts.exists(o.id)) {
    await bot.api.sendMessage(adminId,
      `⚠️ <b>Заявка #${o.id}</b>: файл чека не найден на сервере.`,
      { parse_mode: 'HTML' }).catch((e) => console.error(`[bot] receipt miss ${adminId}:`, e.message));
    return false;
  }
  try {
    await bot.api.sendDocument(adminId, new InputFile(file, `check-${o.id}.pdf`), {
      caption: `🧾 Pricelex Worldwide · заявка #${o.id} · $${o.units || 0} → ${fmtOrderPayout(o)} · ${o.receipt.name} (${fmtSize(o.receipt.size)})`,
    });
    return true;
  } catch (e) {
    console.error(`[bot] receipt #${o.id} → admin ${adminId}:`, e.message);
    return false;
  }
}

async function sendReceiptToAdmins(o) {
  if (!bot) return;
  await Promise.all(admins.all().map((id) => sendReceiptTo(id, o)));
}

async function notifyClientConnected(o) {
  if (!telegramChatId(o.userId)) return false;
  try {
    await bot.api.sendMessage(o.userId,
      `🤝 <b>Оператор подключился к заявке #${o.id}</b>\n\n` +
      `Теперь можно отправить код карты ${dirLabel(o)} номиналом $${giftUnits(o)} — в приложении или прямо здесь, через /menu → 📦 Мои заявки.\n` +
      `После отправки кода оператор проверит карту и выплатит <b>${payoutText(o)}</b> на кошелёк <code>${esc(o.wallet)}</code>.\n\n` +
      `Не передавайте код карты никому, кроме оператора Pricelex Worldwide.`,
      { parse_mode: 'HTML' });
    return true;
  } catch (e) {
    console.error(`[bot] connect → client ${o.id}:`, e.message);
    return false;
  }
}

async function notifyClientTx(o) {
  if (!telegramChatId(o.userId)) return false;
  try {
    await bot.api.sendMessage(o.userId,
      `🔗 <b>Транзакция по заявке #${o.id} отправлена</b>\n\n${esc(o.txUrl)}\n\nПроверьте поступление ${payoutText(o)} на кошелёк:\n<code>${esc(o.wallet)}</code>`,
      { parse_mode: 'HTML' });
    return true;
  } catch (e) {
    console.error(`[bot] tx #${o.id} → client:`, e.message);
    return false;
  }
}

/* ---------- события заказов из веб-части ---------- */

async function onOrderEvent({ order, type }) {
  await sendOrUpdateOrderAdmin(order);
  if (type === 'receipt') {
    await sendReceiptToAdmins(order);
  }
  if (type === 'paid') {
    await broadcast(
      `🔔 <b>Клиент подтвердил сделку по заявке #${order.id}!</b>\n` +
      `🎁 ${esc(dirLabel(order))} <b>$${giftUnits(order)}</b> → ${payoutText(order)}\n` +
      (order.promoCode ? `🏷 Промокод: <b>${esc(order.promoCode)}</b> (+${order.promoPercent}%)\n` : '') +
      (Number(order.loyaltyDiscountPercent) > 0 ? `🎉 Скидка комиссии за каждый 5-й обмен: <b>${order.loyaltyDiscountPercent} п.п.</b>\n` : '') +
      `🎟 Код: <code>${esc(order.giftCode || '—')}</code>\n` +
      `👛 Кошелёк: <code>${esc(order.wallet)}</code>\n\n` +
      `1️⃣ Проверьте карту (регион — <b>США</b>, валюта — <b>USD</b>, номинал и баланс).\n` +
      `2️⃣ Нажмите «✅ Карта проверена — выплатить ${payoutText(order)}» и отправьте ${payoutText(order)}.`,
      { parse_mode: 'HTML', reply_markup: orderKb(order) }
    );
  }
  if (type === 'tx') {
    await sendOrUpdateOrderAdmin(order);
    await notifyClientTx(order);
  }
}

// The same order thread is used by the Mini App and both Telegram roles.
async function onOrderMessage({ order, message }) {
  const fromClient = message.from === 'user';
  const recipients = fromClient ? admins.all() : [telegramChatId(order.userId)].filter(Boolean);
  const reply = new InlineKeyboard().text('💬 Ответить в сделке', fromClient ? `o:${order.id}:chat` : `c:chat:${order.id}`);
  const heading = `💬 Сделка #${order.id} · ${fromClient ? 'Клиент' : 'Оператор'}`;
  const text = message.text ? `${heading}\n${message.text}` : heading;
  await Promise.all(recipients.map(async (id) => {
    try {
      if (message.attachment) {
        const file = message.attachment;
        // A Telegram document caption is limited to 1024 characters.
        await bot.api.sendDocument(id, new InputFile(attachments.filePath(file), file.name), {
          caption: text.length <= 1024 ? text : heading, reply_markup: reply,
        });
      }
      if (!message.attachment || text.length > 1024) await bot.api.sendMessage(id, text, { reply_markup: reply });
    } catch { console.error('[bot] не доставлено сообщение сделки', order.id, message.id); }
  }));
}

/* ---------- support chat ---------- */

async function onSupportMessage({ message, user }) {
  const u = store.getUser(message.userId) || { name: user.first_name || user.name || 'Клиент', id: message.userId };
  const fromLabel = message.from === 'user' ? '👤 Клиент' : '🛡️ Поддержка';
  const preview = message.text.slice(0, 200);
  const kb = new InlineKeyboard()
    .text('💬 Ответить', `suprep:${message.userId}`)
    .text('📂 Открыть чат', `sup:${message.userId}`);
  const text =
    `💬 <b>Новое сообщение поддержки</b>\n` +
    `👤 ${esc(u.name)} · <code>${esc(message.userId)}</code>\n` +
    `${fromLabel}: ${esc(preview)}\n` +
    `🕒 ${fmtDate(message.at)}`;

  if (message.from === 'user') {
    await broadcast(text, { parse_mode: 'HTML', reply_markup: kb });
  } else {
    // admin reply -> try to notify client via bot (only if the client has a Telegram chat)
    if (!telegramChatId(message.userId)) return;
    try {
      await bot.api.sendMessage(message.userId,
        `💬 <b>Поддержка Pricelex Worldwide:</b>\n${esc(message.text)}`,
        { parse_mode: 'HTML' });
    } catch (e) {
      console.error(`[bot] support reply → client ${message.userId}:`, e.message);
    }
  }
}

function supportThreadsKb(threads) {
  const kb = new InlineKeyboard();
  for (const t of threads.slice(0, 10)) {
    const user = store.getUser(t.userId);
    const name = user ? user.name : t.userId;
    const label = `${t.lastFrom === 'user' ? '👤' : '🛡️'} ${name} · #${t.userId.slice(-4)}`;
    kb.text(label, `sup:${t.userId}`).row();
  }
  kb.text('🔄 Обновить', 'm:support').text('↩️ Назад', 'm:home');
  return kb;
}

async function supportMenu(ctx, edit = true) {
  const threads = store.getSupportThreads();
  if (!threads.length) {
    const kb = new InlineKeyboard().text('↩️ Назад', 'm:home');
    const text = '💬 <b>Поддержка</b>\n\nСообщений пока нет. Когда клиент напишет в чат поддержки внутри приложения — диалог появится здесь.';
    return edit
      ? ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
      : ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
  const kb = supportThreadsKb(threads);
  const text = '💬 <b>Чаты поддержки</b> — выберите диалог:';
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

async function supportThreadView(ctx, userId, edit = true) {
  const msgs = store.getSupportMessages(userId);
  const user = store.getUser(userId);
  const name = user ? `${user.name} ${user.username ? '(@' + user.username + ')' : ''}` : userId;
  let body = `💬 <b>Чат с ${esc(name)}</b> · <code>${esc(userId)}</code>\n\n`;
  if (!msgs.length) {
    body += 'Сообщений нет.';
  } else {
    for (const m of msgs.slice(-15)) {
      const who = m.from === 'user' ? '👤 Клиент' : '🛡️ Вы';
      body += `${who} ${fmtDate(m.at)}:\n${esc(m.text)}\n\n`;
    }
  }
  const kb = new InlineKeyboard()
    .text('💬 Ответить', `suprep:${userId}`)
    .text('🔄 Обновить', `sup:${userId}`)
    .row()
    .text('📋 Все чаты', 'm:support')
    .text('↩️ Меню', 'm:home');
  if (edit) await ctx.editMessageText(body, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(body, { parse_mode: 'HTML', reply_markup: kb });
}

/* ---------- меню ---------- */

// Курсы включённых направлений — у каждой карты своя строка (USDT за $1 номинала).
function rateLine(s) {
  return currencies
    .list()
    .filter((p) => currencies.isEnabled(s, p.key) && currencies.rateOf(s, p.currency) > 0)
    .map((p) => `${p.symbol} ${p.label.replace(' Gift Card', '')}: 1 $ = ${fmtUsdt(currencies.rateOf(s, p.currency))}`)
    .join('\n');
}

async function mainMenu(ctx, edit = false) {
  const s = store.get().settings;
  const active = store.activeOrders().length;
  const supportCount = store.getSupportThreads().length;
  const kb = new InlineKeyboard()
    .text(`📥 Заявки${active ? ` (${active})` : ''}`, 'm:orders')
    .text('📊 Статистика', 'm:stats')
    .row()
    .text('⚙️ Настройки', 'm:settings')
    .text('🔗 Ссылки', 'm:links')
    .row()
    .text(`💬 Поддержка${supportCount ? ` (${supportCount})` : ''}`, 'm:support')
    .text('👥 Админы', 'm:admins');
  const text = [
    '🌌 <b>Pricelex Worldwide | Official</b> — пульт оператора',
    s.online ? '🟢 Обменник <b>ОНЛАЙН</b>' : '🔴 Обменник <b>ОФФЛАЙН</b>',
    rateLine(s),
    s.rateUpdatedAt ? 'Официальный курс от ' + fmtDate(s.rateUpdatedAt) + ' (' + esc(s.rateSource || '?') + ')' : 'ещё не подтянут — действует сохранённая цена USDT/USD',
    'Активных заявок: ' + active + ' · 💬 Чатов: ' + supportCount,
  ].join('\n');
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

async function ordersMenu(ctx, edit = true) {
  const list = store.activeOrders().sort((a, b) => b.createdAt - a.createdAt);
  const kb = new InlineKeyboard();
  if (!list.length) {
    kb.text('↩️ Назад', 'm:home');
    const text = '📥 <b>Заявки</b>\n\nАктивных заявок нет. Новые появятся здесь автоматически.';
    return edit
      ? ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
      : ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
  for (const o of list.slice(0, 8)) {
    kb.text(`#${o.id} · ${dirLabel(o)} $${giftUnits(o)} · ${o.status === 'new' ? '🕐' : o.status === 'paid' ? '⏳' : '🤝'}`, `o:${o.id}`).row();
  }
  kb.text('🔄 Обновить', 'm:orders').text('↩️ Назад', 'm:home');
  const text = '📥 <b>Активные заявки</b> — нажмите, чтобы открыть:';
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

// Настройки: переключатель ✅/⛔ конкретной карты и СВОЙ курс для каждой карты.
function settingsKb(s) {
  const on = (key) => (currencies.isEnabled(s, key) ? '✅' : '⛔');
  const kb = new InlineKeyboard()
    .row()
    // Включение/выключение выкупа конкретной карты — для каждого направления отдельно.
    .text(`${on('GOOGLE_USD')} Google Gift`, 's:dir_GOOGLE_USD')
    .text(`${on('ITUNES_USD')} iTunes`, 's:dir_ITUNES_USD')
    .row()
    .text(`${on('XBOX_USD')} Xbox`, 's:dir_XBOX_USD')
    .text(`${on('APPLE_STORE_USD')} Apple Store`, 's:dir_APPLE_STORE_USD');
  // Отдельная кнопка скидки/курса на каждый бренд: меняем один — остальные не трогаем.
  for (const p of currencies.list()) {
    const short = p.label.replace(' Gift Card', '');
    kb.row().text(`💱 ${short}: скидка ${currencies.feeOf(s, p.key)}% · ${fmtUsdt(currencies.rateOf(s, p.currency) || 0)}`, `s:fee_${p.key}`);
  }
  // Сети выплаты: включение/выключение — как кнопки направлений на сайте.
  for (const opt of currencies.PAYOUT_OPTION_LIST) {
    kb.row().text(`${currencies.isPayoutEnabled(s, opt) ? '✅' : '⛔'} ${opt.shortLabel} · ${opt.instant ? '0' : currencies.networkFeeOf(s, opt)} ${opt.feeUnit}`, `s:net_${opt.id}`);
  }
  return kb
    .row()
    .text('🏷 Промокоды', 'm:promos')
    .row()
    .text('🔄 Обновить курс', 's:refresh')
    .row()
    .text(s.online ? '🟢 Онлайн' : '🔴 Оффлайн', 's:online')
    .text('🎁 Реф. %', 's:ref')
    .row()
    .text('📇 Оператор', 's:op')
    .row()
    .text('📣 Канал', 's:ch')
    .text('💬 Чат', 's:chat')
    .row()
    .text('↩️ Назад', 'm:home');
}

function settingsText(s) {
  const base = Number(s.usdtUsd) > 0 ? `$${Number(s.usdtUsd).toLocaleString('ru-RU', { maximumFractionDigits: 8 })} за USDT` : 'ещё не подтянут';
  const btcBase = currencies.btcUsdQuote(s.btcUsd)
    ? `$${Number(s.btcUsd).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} за BTC`
    : '—';
  const cards = currencies.list().map((p) => {
    const rate = currencies.rateOf(s, p.currency);
    const example = currencies.giftPayout(s, 10, p.currency);
    return `• ${esc(p.label)}: <b>1 $ = ${rate ? fmtUsdt(rate) : '—'}</b> ` +
      `(скидка ${currencies.feeOf(s, p.key)}% · $10 = ${example ? fmtUsdt(example.crypto) : '—'}) ${currencies.isEnabled(s, p.key) ? '✅' : '⛔'}`;
  }).join('\n');
  const nets = currencies.PAYOUT_OPTION_LIST.map((opt) => {
    const on = currencies.isPayoutEnabled(s, opt);
    const fee = currencies.networkFeeOf(s, opt);
    const feeTxt = opt.instant ? '⚡ моментально, 0 комиссии' : `комиссия сети ${fee} ${opt.feeUnit}`;
    return `• ${esc(opt.label)}: ${feeTxt} ${on ? '✅' : '⛔'}`;
  }).join('\n');
  return (
    `⚙️ <b>Настройки</b> (применяются мгновенно)\n\n` +
    `📊 Спотовый курс USDT/USD: <b>${base}</b> · BTC/USD: <b>${btcBase}</b>\n` +
    (s.rateUpdatedAt ? `Обновлён: ${fmtDate(s.rateUpdatedAt)} (${esc(s.rateSource || '?')})\n` : '') +
    `\n🎁 <b>Курс каждой карты — отдельный:</b>\n${cards}\n` +
    `\n🌐 <b>Сети выплаты:</b>\n${nets}\n` +
    `\n🎁 Реферальный процент: <b>${s.refPercent}%</b>\n` +
    `Статус: ${s.online ? '🟢 Онлайн' : '🔴 Оффлайн'}\n` +
    `📇 ${esc(s.operator)} · 📣 ${esc(s.channel)}\n💬 ${esc(s.chat)}`
  );
}

async function settingsMenu(ctx, edit = true) {
  const s = store.get().settings;
  const opts = { parse_mode: 'HTML', reply_markup: settingsKb(s) };
  if (edit) await ctx.editMessageText(settingsText(s), opts).catch(() => {});
  else await ctx.reply(settingsText(s), opts);
}

async function statsMenu(ctx, edit = true) {
  const t = store.stats();
  const text =
    `📊 <b>Статистика</b>\n\n` +
    `Всего заявок: <b>${t.total}</b>\n` +
    `🕐 Новых: ${t.new} · 🤝 Ждут код карты: ${t.details} · ⏳ Карты на проверке: ${t.paid}\n` +
    `🟢 Завершено: <b>${t.completed}</b>\n` +
    `🔴 Отклонено/отменено: ${t.rejected}\n\n` +
    `👥 Клиентов: ${t.users} · 🧬 С реферерами: ${t.refs} · 💬 Чатов: ${store.getSupportThreads().length}`;
  const kb = new InlineKeyboard().text('🔄 Обновить', 'm:stats').text('↩️ Назад', 'm:home');
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

async function linksMenu(ctx, edit = true) {
  const s = store.get().settings;
  const url = s.publicUrl || '(появится автоматически после первого открытия сайта)';
  const text =
    `🔗 <b>Ссылки</b>\n\n` +
    `🌐 Сайт обменника:\n${esc(url)}\n\n` +
    `Адрес определяется автоматически при первом открытии сайта и сразу прописывается в кнопку меню Telegram.\n\n` +
    `📇 Оператор: ${esc(s.operator)}\n📣 Канал: ${esc(s.channel)}\n💬 Чат: ${esc(s.chat)}`;
  const kb = new InlineKeyboard().text('↩️ Назад', 'm:home');
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

/* ---------- промокоды (как в админке сайта) ---------- */

const promoStatus = (p) => {
  const now = Date.now();
  if (p.active === false) return '⏸ на паузе';
  if (p.expiresAt && Number(p.expiresAt) < now) return '⌛ истёк';
  if (p.maxUses != null && Number(p.usedCount) >= Number(p.maxUses)) return '✅ исчерпан';
  return '🟢 активен';
};

async function promosMenu(ctx, edit = true) {
  const list = store.listPromos().slice(0, 10);
  const text =
    `🏷 <b>Промокоды</b>\n\n` +
    `Клиент вводит код при обмене — выплата растёт на указанный процент.\n\n` +
    (list.length
      ? list.map((p) => `• <code>${esc(p.code)}</code> · +${p.percent}% · ${promoStatus(p)}` +
          ` · использований ${p.usedCount || 0}${p.maxUses != null ? '/' + p.maxUses : ''}` +
          (p.minUnits ? ` · от $${p.minUnits}` : '')).join('\n')
      : 'Промокодов пока нет.') +
    `\n\nСоздать: /newpromo КОД ПРОЦЕНТ [лимит] [от_суммы]$`;
  const kb = new InlineKeyboard();
  for (const p of list) {
    kb.text(`${p.active === false ? '▶️' : '⏸'} ${p.code}`, `pr:t:${p.id}`)
      .text(`🗑 ${p.code}`, `pr:d:${p.id}`)
      .row();
  }
  kb.text('↩️ Настройки', 'm:settings');
  if (edit) return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

/* ---------- FSM ввода от админа ---------- */

const SET_FIELDS = {
  ref: { label: 'реферальный процент (например 1)', num: true, key: 'refPercent' },
  op: { label: 'юзернейм оператора (например @operator)' },
  ch: { label: 'ссылку на канал' },
  chat: { label: 'ссылку на чат' },
};

// Скидка (а значит и курс) настраивается для КАЖДОЙ карты отдельно.
for (const p of currencies.list()) {
  SET_FIELDS[`fee_${p.key}`] = {
    label: `скидку для ${p.label} в % от USDT-эквивалента номинала (0–50; курс этой карты пересчитается, остальные не изменятся)`,
    num: true,
    discount: true,
    feeKey: p.key,
  };
}

async function txPrompt(ctx, o) {
  const opt = currencies.findPayoutOption({ payoutCurrency: o.payoutCurrency, network: o.network });
  const example = opt && opt.txExample ? ` (например, ${opt.txExample})` : '';
  flows.set(ctx.from.id, { type: 'tx', orderId: o.id, version: o.version || 0 });
  return ctx.reply(
    `🔗 Заявка #${o.id} — отправьте ссылку на транзакцию в блокчейне${example}.\n\nСсылка появится у клиента в завершённой заявке. Это опционально — можно оставить пустым, отправив /cancel.\n\nТекущая: ${o.txUrl ? esc(o.txUrl) : '— нет —'}\n/cancel — отмена`,
    { parse_mode: 'HTML' }
  );
}

async function supportReplyPrompt(ctx, userId) {
  flows.set(ctx.from.id, { type: 'support', userId: String(userId) });
  const user = store.getUser(userId);
  return ctx.reply(
    `💬 Ответ клиенту ${user ? esc(user.name) + ' ' : ''}<code>${esc(userId)}</code>.\nНапишите сообщение — оно сразу появится у клиента в приложении и уйдёт ему в Telegram, если он запускал бота.\n/cancel — отмена`,
    { parse_mode: 'HTML' }
  );
}

async function receiveAdminChat(ctx, id) {
  const order = store.getOrder(id);
  if (!order) return ctx.reply('Заявка не найдена.');
  return orderChat.receiveTelegram(ctx, order, 'admin');
}

async function handleAdminText(ctx) {
  const f = flows.get(ctx.from.id);
  if (!f) return ctx.reply('Выберите заявку через /menu, затем нажмите «🤝 Подключить» или откройте чат поддержки.');
  const text = ctx.message.text.trim();
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^отмена$/i.test(text)) {
    flows.delete(ctx.from.id);
    return ctx.reply('❌ Ввод отменён.', { reply_markup: homeKb() });
  }
  if (f.type === 'order_chat') return receiveAdminChat(ctx, f.orderId);
  if (f.type === 'support') {
    if (!text || text.length > 2000) return ctx.reply('Сообщение должно содержать от 1 до 2000 символов.');
    flows.delete(ctx.from.id);
    const msg = store.createSupportMessage(f.userId, 'admin', text);
    await onSupportMessage({ message: msg, user: { id: f.userId } });
    await ctx.reply(`✅ Ответ отправлен клиенту ${f.userId}.`, { reply_markup: homeKb() });
    await supportThreadView(ctx, f.userId, false).catch(() => {});
    return;
  }
  if (f.orderId) {
    const o = store.getOrder(f.orderId);
    if (f.type === 'tx') {
      if (!o) {
        flows.delete(ctx.from.id);
        return ctx.reply('Заявка не найдена.', { reply_markup: homeKb() });
      }
      if (o.status !== 'completed') {
        flows.delete(ctx.from.id);
        return ctx.reply('Ссылку на блокчейн можно добавить только после подтверждения оплаты (статус «Завершена»).', { reply_markup: homeKb() });
      }
      if (!/^https?:\/\/.{4,800}$/i.test(text)) {
        return ctx.reply('Пришлите корректную ссылку, начинающуюся с https:// (до 800 символов).');
      }
      flows.delete(ctx.from.id);
      const upd = store.updateOrder(o.id, { txUrl: text });
      await Promise.all([sendOrUpdateOrderAdmin(upd), notifyClientTx(upd)]);
      return ctx.reply(`✅ Ссылка на блокчейн сохранена для заявки #${o.id}:\n${text}\n\nКлиент увидит её в приложении.`, { reply_markup: homeKb() });
    }
  }
  if (f.type && f.type.startsWith('set:')) {
    const field = SET_FIELDS[f.type.slice(4)];
    if (field) {
      if (field.num) {
        const n = parseNum(text);
        if (!isFinite(n) || n < 0 || n > 50) {
          return ctx.reply(field.discount
            ? 'Скидка карты — число от 0 до 50 %. Она удерживается из USDT-эквивалента номинала (например, 15 = минус 15% от выплаты). Курс меняется только у выбранной карты.'
            : 'Процент — число от 0 до 50. Пример: 2');
        }
        store.mutate((db) => {
          if (field.feeKey) {
            db.settings.cardFees = db.settings.cardFees || {};
            db.settings.cardFees[field.feeKey] = n;
            db.settings.cardRates = currencies.allCardRates(db.settings);
          } else {
            db.settings[field.key || f.type.slice(4)] = n;
          }
        });
      } else {
        store.mutate((db) => {
          db.settings[field.key || f.type.slice(4)] = text.slice(0, 500);
        });
      }
      flows.delete(ctx.from.id);
      return settingsMenu(ctx, false).then(() =>
        ctx.reply('✅ Сохранено и уже применилось на сайте.', { reply_markup: homeKb() })
      );
    }
  }
}

function homeKb() {
  return new InlineKeyboard()
    .text('📥 Заявки', 'm:orders')
    .text('⚙️ Настройки', 'm:settings')
    .row()
    .text('📊 Статистика', 'm:stats')
    .text('🔗 Ссылки', 'm:links')
    .row()
    .text('💬 Поддержка', 'm:support')
    .text('👥 Админы', 'm:admins')
    .text('🔗 Привязка сайта', 'm:linkcode');
}

async function adminsMenu(ctx) {
  const list = admins.all().map((id) => `<code>${id}</code>${admins.isOwner(id) ? ' — владелец' : ' — оператор'}`).join('\n');
  return ctx.reply(`👥 <b>Администраторы</b>\n\n${list}\n\n` +
    (admins.isOwner(ctx.from.id)
      ? 'Добавить: /addadmin 123456789\nУдалить: /removeadmin 123456789\nНовый админ должен открыть бота и нажать /start.'
      : 'Добавлять и удалять операторов может только владелец.'), { parse_mode: 'HTML' });
}

/* ---------- регистрация обработчиков ---------- */

function register() {
  // Виджеты (Bot API 10.4): grammy не знает тип обновления widget_query — разбираем middleware сами.
  bot.use(async (ctx, next) => {
    const wq = ctx.update && ctx.update.widget_query;
    if (wq) return widget.handleWidgetQuery(ctx, wq, clientbot);
    return next();
  });
  bot.command('admins', (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    return adminsMenu(ctx);
  });
  bot.command('support', (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    return supportMenu(ctx, false);
  });
  bot.command('reviews', async (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    const all = store.listReviews(500);
    const summary = store.reviewSummary(all);
    const shown = all.slice(0, 5).map((r) => {
      const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
      return `👤 ${esc(r.name)} · ${stars}\n${esc(r.text.slice(0, 200))}` + (r.reply ? `\n↳ ${esc(r.reply.slice(0, 150))}` : '');
    }).join('\n\n');
    return ctx.reply(
      `⭐ <b>Отзывы</b>\n\n` +
      (summary.count ? `Средняя оценка: <b>${summary.avg.toFixed(1)} / 5</b> · ${summary.count}\n\n` : 'Отзывов пока нет.\n\n') +
      (shown || ''),
      { parse_mode: 'HTML', reply_markup: homeKb() }
    );
  });
  for (const command of ['addadmin', 'removeadmin']) {
    bot.command(command, async (ctx) => {
      if (!isAdmin(ctx)) return;
      if (!admins.isOwner(ctx.from.id)) return ctx.reply('⛔ Только владелец может менять список админов.');
      const id = ctx.match.trim();
      try {
        const changed = command === 'addadmin' ? admins.add(id) : admins.remove(id);
        if (command === 'removeadmin') flows.delete(Number(id));
        flows.delete(ctx.from.id);
        await ctx.reply(changed ? '✅ Список обновлён.' : 'Список не изменился.');
        if (changed && command === 'addadmin') {
          await bot.api.sendMessage(id, 'Вы добавлены как оператор Pricelex Worldwide. /start — пульт оператора.')
            .catch(() => ctx.reply('Попросите нового админа открыть бота и нажать /start.'));
        }
        return adminsMenu(ctx);
      } catch (e) { return ctx.reply(e.message); }
    });
  }
  bot.command('newpromo', async (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    const [rawCode, rawPercent, rawMax, rawMin] = String(ctx.match || '').trim().split(/\s+/);
    const code = store.normalizePromoCode(rawCode || '');
    const percent = Number(String(rawPercent || '').replace(',', '.'));
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
      return ctx.reply('Формат: /newpromo КОД ПРОЦЕНТ [лимит] [от_суммы]\nПример: /newpromo BONUS10 10 50 100\nКод: 2–32 символа, латиница/цифры.');
    }
    if (!Number.isFinite(percent) || percent < 0.1 || percent > 50) return ctx.reply('Процент: число от 0.1 до 50.');
    if (store.getPromoByCode(code)) return ctx.reply('Промокод с таким кодом уже существует.');
    const maxUses = rawMax === undefined ? null : Number(rawMax);
    const minUnits = rawMin === undefined ? null : Number(rawMin);
    if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses < 1)) return ctx.reply('Лимит использований — целое число от 1.');
    if (minUnits !== null && (!Number.isFinite(minUnits) || minUnits < 1)) return ctx.reply('Минимальная сумма — число от 1.');
    store.createPromo({ code, percent, maxUses, minUnits });
    await promosMenu(ctx, false);
    return ctx.reply(`✅ Промокод <code>${esc(code)}</code> создан: +${percent}%.`, { parse_mode: 'HTML', reply_markup: homeKb() });
  });
  bot.command('promos', (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    return promosMenu(ctx, false);
  });
  bot.command('link', async (ctx) => {
    if (!isAdmin(ctx) && ctx.chat?.type === 'private') return clientbot.sendLinkCode(ctx);
  });
  bot.command('start', async (ctx) => {
    if (!isAdmin(ctx)) {
      if (ctx.chat?.type !== 'private') return;
      // t.me/<bot>?start=link — сразу код привязки браузера к Telegram.
      if (String(ctx.match || '').trim() === 'link') return clientbot.sendLinkCode(ctx);
      // Клиентский флоу прямо в чате (для тех, кто не хочет открывать приложение).
      return clientbot.clientStart(ctx, (ctx.match || '').toString().trim());
    }
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });
  bot.command('menu', async (ctx) => {
    if (!isAdmin(ctx)) {
      if (ctx.chat?.type !== 'private') return;
      return clientbot.clientStart(ctx);
    }
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });

  bot.on('callback_query:data', async (ctx) => {
    const d = ctx.callbackQuery.data || '';
    if (!isAdmin(ctx)) {
      if (d.startsWith('c:') && ctx.chat?.type === 'private') return clientbot.handleClientCallback(ctx, d);
      return ctx.answerCallbackQuery({ text: '⛔️' }).catch(() => {});
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const file = d.match(/^o:file:(\d+):(\d+)$/);
    if (file) return orderChat.sendFile(ctx, store.getOrder(Number(file[1])), Number(file[2]));
    flows.delete(ctx.from.id);

    if (d === 'm:home') return mainMenu(ctx, true);
    if (d === 'm:orders') return ordersMenu(ctx, true);
    if (d === 'm:settings') return settingsMenu(ctx, true);
    if (d === 'm:stats') return statsMenu(ctx, true);
    if (d === 'm:admins') return adminsMenu(ctx);
    if (d === 'm:links') return linksMenu(ctx, true);
    if (d === 'm:support') return supportMenu(ctx, true);
    if (d === 'm:promos') return promosMenu(ctx, true);
    const promoAct = d.match(/^pr:(t|d):(\d+)$/);
    if (promoAct) {
      const promo = store.getPromo(promoAct[2]);
      if (!promo) return ctx.answerCallbackQuery({ text: 'Промокод не найден' }).catch(() => {});
      if (promoAct[1] === 't') {
        store.updatePromo(promo.id, { active: promo.active === false });
        await ctx.answerCallbackQuery({ text: promo.active === false ? 'Включён ✅' : 'Поставлен на паузу ⏸' }).catch(() => {});
      } else {
        store.deletePromo(promo.id);
        await ctx.answerCallbackQuery({ text: 'Удалён 🗑' }).catch(() => {});
      }
      return promosMenu(ctx, true);
    }
    if (d === 'm:linkcode') return clientbot.sendLinkCode(ctx);

    if (d.startsWith('sup:')) {
      const userId = d.slice(4);
      return supportThreadView(ctx, userId, true);
    }
    if (d.startsWith('suprep:')) {
      const userId = d.slice(7);
      return supportReplyPrompt(ctx, userId);
    }

    if (d.startsWith('s:dir_')) {
      const key = d.slice(6);
      const pair = currencies.get(key);
      if (!pair) return;
      store.mutate((db) => {
        db.settings.enabled = db.settings.enabled || {};
        db.settings.enabled[key] = !currencies.isEnabled(db.settings, key);
      });
      const st = currencies.isEnabled(store.get().settings, key);
      const active = store.activeOrders().filter((o) => currencies.keyOf(o.currency) === key).length;
      const extra = active ? ` · активных заявок: ${active} (обработайте вручную)` : '';
      await ctx.answerCallbackQuery({ text: `${pair.label}: ${st ? 'включено ✅' : 'выключено ⛔'}${extra}` }).catch(() => {});
      return settingsMenu(ctx, true);
    }
    if (d.startsWith('s:net_')) {
      const opt = currencies.PAYOUT_OPTIONS[d.slice('s:net_'.length)];
      if (!opt) return;
      // BEP-20 — базовая сеть: её нельзя выключить (как и в админке сайта).
      if (opt.id === currencies.PAYOUT_OPTIONS.USDT_BEP20.id) {
        return ctx.answerCallbackQuery({ text: 'BEP-20 — базовая сеть, её нельзя выключить' }).catch(() => {});
      }
      store.mutate((db) => {
        db.settings.payoutEnabled = db.settings.payoutEnabled || {};
        db.settings.payoutEnabled[opt.id] = !currencies.isPayoutEnabled(db.settings, opt);
      });
      const now = currencies.isPayoutEnabled(store.get().settings, opt);
      const active = store.activeOrders().filter((o) => o.payoutId === opt.id).length;
      await ctx.answerCallbackQuery({ text: `${opt.label}: ${now ? 'включено ✅' : 'выключено ⛔'}${active ? ` · активных заявок: ${active}` : ''}` }).catch(() => {});
      return settingsMenu(ctx, true);
    }
    if (d === 's:online') {
      const was = store.get().settings.online;
      store.mutate((db) => {
        db.settings.online = !db.settings.online;
      });
      const now = store.get().settings.online;
      if (!was && now) {
        const { sent } = await announceToClients(CLIENTS_ANNOUNCE_OPEN);
        await ctx.answerCallbackQuery({ text: `Выкуп открыт 🟢 · объявление отправлено: ${sent}` }).catch(() => {});
      }
      return settingsMenu(ctx, true);
    }
    if (d === 's:refresh') {
      await ctx.answerCallbackQuery({ text: 'Обновляю курс…' }).catch(() => {});
      try {
        const { source } = await rates.refreshRates();
        await settingsMenu(ctx, true);
        return ctx.reply(`✅ Официальный курс обновлён (источник: ${source}). Курсы всех карт пересчитаны с их индивидуальными скидками.`, { reply_markup: homeKb() });
      } catch (e) {
        return ctx.reply(`⚠️ Не удалось обновить курс: ${e.message}. Действуют прежние курсы.`, { reply_markup: homeKb() });
      }
    }
    if (d.startsWith('s:')) {
      const key = d.slice(2);
      if (SET_FIELDS[key]) {
        flows.set(ctx.from.id, { type: 'set:' + key });
        await ctx.editMessageText(`✍️ Отправьте ${SET_FIELDS[key].label}.\n( /cancel — отмена )`, {
          parse_mode: 'HTML',
        }).catch(() => {});
        return;
      }
    }

    const m = d.match(/^o:(\d+)(?::(\w+))?$/);
    if (m) {
      const id = Number(m[1]);
      const act = m[2];
      const o = store.getOrder(id);
      if (!o) return ctx.editMessageText('Заявка не найдена.', { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('↩️ Назад', 'm:orders') }).catch(() => {});
      if (!act) {
        return ctx.editMessageText(orderText(o), { parse_mode: 'HTML', reply_markup: orderKb(o) }).catch(() => {});
      }
      if (act === 'chat') {
        flows.set(ctx.from.id, { type: 'order_chat', orderId: id });
        return orderChat.openTelegram(ctx, o, 'admin', { payout: orderChatPayout(o) });
      }
      // Завершение сделки доступно из любого статуса: completeOrder сам объяснит,
      // почему нельзя (не оплачено) или что уже выдано (идемпотентность).
      // Обе кнопки выдачи ведут в один обработчик: из диалога — сразу,
      // из карточки — после подтверждения суммы (состояние проверяется внутри).
      if (act === 'paid_yes') return completeOrder(ctx, id);
      if (act === 'confirm' && o.status !== 'paid') {
        // Нечего подтверждать: completeOrder объяснит причину (ждём код/уже выдано).
        return completeOrder(ctx, id);
      }
      if (act === 'receipt') {
        if (!o.receipt) return ctx.reply('Чек по этой заявке не прикреплён.');
        await sendReceiptTo(ctx.from.id, o);
        return;
      }
      if (act === 'tx') {
        if (o.status !== 'completed') {
          return ctx.reply('Ссылку на блокчейн можно добавить только после завершения заявки.', { reply_markup: homeKb() });
        }
        return txPrompt(ctx, o);
      }
      const allowed = { connect: ['new'], reject: ['new', 'details'], unpaid: ['paid'], confirm: ['paid'] };
      if (!allowed[act]?.includes(o.status)) {
        return ctx.reply('Действие недоступно: статус заявки уже изменился. Откройте заявку заново.', { reply_markup: homeKb() });
      }
      if (act === 'connect') {
        const upd = store.updateOrder(id, { status: 'details' });
        await sendOrUpdateOrderAdmin(upd);
        await notifyClientConnected(upd);
        return;
      }
      if (act === 'reject') {
        const upd = store.updateOrder(id, { status: 'rejected' });
        return sendOrUpdateOrderAdmin(upd);
      }
      if (act === 'unpaid') {
        const upd = store.updateOrder(id, { status: 'rejected' });
        return sendOrUpdateOrderAdmin(upd);
      }
      if (act === 'confirm') {
        // Деньги выдаются только после явного подтверждения суммы и адреса —
        // одинаково из карточки и из диалога сделки.
        return ctx.reply(
          `💸 <b>Заявка #${o.id} — выдать ${payoutText(o)}?</b>\n\n` +
          `🎁 ${dirLabel(o)} на ${giftUnits(o)}\n` +
          `👛 Кошелёк: <code>${esc(o.wallet)}</code>\n` +
          `🌐 Сеть: ${esc(currencies.payoutLabelOf(o))}\n\n` +
          'Проверьте, что валюта отправлена на этот адрес, и подтвердите.',
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('✅ Да, валюта выдана', `o:${o.id}:paid_yes`)
              .text('↩️ Отмена', `o:${o.id}`),
          }
        );
      }
    }
  });

  bot.on('message:text', async (ctx) => {
    if (!isAdmin(ctx)) {
      if (ctx.chat?.type !== 'private') return;
      return clientbot.handleClientText(ctx);
    }
    await handleAdminText(ctx);
  });

  bot.on(['message:document', 'message:photo'], async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!isAdmin(ctx)) return clientbot.handleClientDocument(ctx);
    const flow = flows.get(ctx.from.id);
    if (flow?.type === 'order_chat') return receiveAdminChat(ctx, flow.orderId);
    return ctx.reply('Чтобы отправить вложение, откройте нужную заявку и нажмите «💬 Диалог сделки».');
  });
}

/* ---------- запуск ---------- */

function createBot(options = {}) {
  bot = new Bot(config.botToken, { client: { timeoutSeconds: 15 }, ...options });
  register();
  bus.on('order_event', onOrderEvent);
  bus.on('order_message', onOrderMessage);
  bus.on('support_message', onSupportMessage);
  bus.on('announce', ({ text }) => announceToClients(text));
  return bot;
}

async function startBot() {
  if (!config.botToken) {
    console.log('[Pricelex Worldwide] BOT_TOKEN не задан → сайт работает в ДЕМО-режиме, бот отключён.');
    return;
  }
  createBot();
  await bot.init();
  store.mutate((db) => {
    db.settings.botUsername = bot.botInfo.username;
  });
  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Главное меню' },
      { command: 'menu', description: 'Показать меню' },
      { command: 'support', description: 'Чаты поддержки' },
      { command: 'promos', description: 'Промокоды' },
      { command: 'reviews', description: 'Отзывы клиентов' },
      { command: 'newpromo', description: 'Создать промокод: /newpromo КОД ПРОЦЕНТ' },
    ])
    .catch(() => {});

  if (!admins.all().length) {
    console.warn('[Pricelex Worldwide] ВНИМАНИЕ: ADMIN_ID / ADMIN_IDS не заданы — нет администраторов.');
  }
  await Promise.all(admins.all().map(async (id) => {
    if (store.get().flags.onboardedAdmins?.[id]) return;
    try {
      await bot.api.sendMessage(id,
        `🚀 <b>Pricelex Worldwide запущен!</b>\n🤖 @${esc(bot.botInfo.username)}\n/start — пульт оператора\n/admins — список админов\n/support — чаты поддержки\nНовые заявки будут приходить всем операторам.`,
        { parse_mode: 'HTML' });
      store.mutate((db) => { (db.flags.onboardedAdmins ||= {})[id] = true; });
    } catch (e) { console.error(`[bot] onboarding ${id}:`, e.message); }
  }));
  for (const order of store.activeOrders()) await sendOrUpdateOrderAdmin(order);

  const applyPublicUrl = async (url, notifyAdmin = true) => {
    if (!/^https:\/\//i.test(String(url || ''))) {
      console.error('[Pricelex Worldwide] publicUrl не https — кнопка меню Telegram не установлена:', url);
      return;
    }
    try {
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Открыть обменник', web_app: { url } } });
      console.log('[Pricelex Worldwide] кнопка меню Telegram настроена на', url);
    } catch (e) {
      console.error('[Pricelex Worldwide] setChatMenuButton:', e.message);
    }
    if (notifyAdmin) await broadcast(`🔗 Публичный адрес обменника:\n${url}`);
  };
  bus.on('public_url', (url) => applyPublicUrl(url, true));
  if (store.get().settings.publicUrl) {
    applyPublicUrl(store.get().settings.publicUrl, false).catch(() => {});
  }

  bot.catch((e) => console.error('[bot error]', e.message));
  bot.start();
  console.log('[Pricelex Worldwide] бот запущен: @' + bot.botInfo.username);
}

module.exports = { startBot, createBot };
