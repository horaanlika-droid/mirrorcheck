const { Bot, InlineKeyboard, InputFile } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const admins = require('./admins');
const rates = require('./rates');
const receipts = require('./receipts');
const { esc, fmtRub, fmtCrypto, fmtDate, fmtSize, parseNum } = require('./util');

let bot = null;
const flows = new Map(); // adminId -> { type, orderId?, userId? }

const isAdmin = (ctx) => ctx.chat?.type === 'private' && admins.has(ctx.from?.id);

const STATUS_LABEL = {
  new: '🔍 Идёт подбор реквизитов',
  details: '💳 Ожидает оплаты клиентом',
  paid: '⏳ Клиент оплатил — нужно подтверждение',
  completed: '🟢 Завершена',
  rejected: '🔴 Отклонена',
  cancelled: '⚪ Отменена клиентом',
};

/* ---------- рендер сообщений ---------- */

function orderText(o) {
  const ref = o.referrer ? store.getUser(o.referrer) : null;
  return (
    `📥 <b>Заявка #${o.id}</b>\n` +
    `👤 ${esc(o.userName)}${o.userUsername ? ' (@' + esc(o.userUsername) + ')' : ''} · <code>${esc(o.userId)}</code>\n` +
    `💵 Сумма: <b>${fmtRub(o.rub)}</b>\n` +
    `🪙 Валюта: <b>${o.currency}</b> ≈ ${fmtCrypto(o.crypto, o.currency)}\n` +
    `👛 Кошелёк: <code>${esc(o.wallet)}</code>\n` +
    `🧬 Реферер: ${ref ? esc(ref.name) + ' (#' + esc(ref.id) + ')' : '—'}\n` +
    (o.requisites ? `🏦 Реквизиты: ${esc(o.requisites)}\n` : '') +
    (o.payRub ? `💰 К оплате: <b>${fmtRub(o.payRub)}</b>\n` : '') +
    (o.receipt
      ? `🧾 Чек: ✅ ${esc(o.receipt.name)} (${fmtSize(o.receipt.size)})\n`
      : ['details', 'paid'].includes(o.status) ? `🧾 Чек: ⏳ не прикреплён\n` : '') +
    (o.txUrl ? `🔗 Блокчейн: ${esc(o.txUrl)}\n` : '') +
    `🕒 ${fmtDate(o.createdAt)}\n` +
    `Статус: ${STATUS_LABEL[o.status] || o.status}`
  );
}

function orderKb(o) {
  const kb = new InlineKeyboard();
  if (o.status === 'new') {
    kb.text('💳 Выдать реквизиты', `o:${o.id}:req`).text('❌ Отклонить', `o:${o.id}:reject`);
  } else if (o.status === 'details') {
    kb.text('✅ Оплачено (подтвердить)', `o:${o.id}:confirm`)
      .row()
      .text('✏️ Изменить сумму', `o:${o.id}:amt`)
      .text('❌ Отклонить', `o:${o.id}:reject`);
    if (o.receipt) kb.row().text('🧾 Получить чек', `o:${o.id}:receipt`);
  } else if (o.status === 'paid') {
    kb.text('✅ Подтвердить и завершить', `o:${o.id}:confirm`)
      .row()
      .text('❌ Оплата не поступила', `o:${o.id}:unpaid`);
    if (o.receipt) kb.row().text('🧾 Получить чек', `o:${o.id}:receipt`);
  } else if (o.status === 'completed') {
    if (o.receipt) kb.text('🧾 Получить чек', `o:${o.id}:receipt`);
    kb.text(o.txUrl ? '🔗 Изменить ссылку' : '🔗 Добавить ссылку на блокчейн', `o:${o.id}:tx`);
    kb.row().text(' К списку заявок', 'm:orders');
  } else {
    if (o.receipt) kb.text('🧾 Получить чек', `o:${o.id}:receipt`).row();
    if (o.txUrl) kb.text('🔗 Ссылка на блокчейн', `o:${o.id}:tx`).row();
    kb.text(' К списку заявок', 'm:orders');
  }
  return kb;
}

// Очередь на заявку: более старый сетевой ответ не должен затереть новую карточку.
const orderQueues = new Map();
function sendOrUpdateOrderAdmin(order) {
  const previous = orderQueues.get(order.id) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    if (!bot) return;
    await Promise.all(admins.all().map(async (adminId) => {
      const o = store.getOrder(order.id);
      if (!o || !admins.has(adminId)) return;
      const opts = { parse_mode: 'HTML', reply_markup: orderKb(o) };
      const messageId = o.adminMsgIds?.[adminId] ||
        (adminId === config.adminId ? o.adminMsgId : null);
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

async function broadcast(text, options = {}) {
  if (!bot) return;
  await Promise.all(admins.all().map(async (id) => {
    try { await bot.api.sendMessage(id, text, options); }
    catch (e) { console.error(`[bot] admin ${id}:`, e.message); }
  }));
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
      caption: `🧾 Чек по заявке #${o.id} · ${fmtRub(o.payRub || o.rub)} · ${o.receipt.name} (${fmtSize(o.receipt.size)})`,
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

async function notifyClient(o) {
  try {
    await bot.api.sendMessage(o.userId,
      `💳 <b>Реквизиты по заявке #${o.id}</b>\n\n${esc(o.requisites)}\n\nК оплате: <b>${fmtRub(o.payRub)}</b>\nПосле перевода нажмите «Я оплатил» в приложении.`,
      { parse_mode: 'HTML' });
    return true;
  } catch (e) {
    console.error(`[bot] requisites #${o.id} → client:`, e.message);
    return false;
  }
}

async function notifyClientTx(o) {
  try {
    await bot.api.sendMessage(o.userId,
      `🔗 <b>Транзакция по заявке #${o.id} отправлена</b>\n\n${esc(o.txUrl)}\n\nПроверьте поступление ${fmtCrypto(o.crypto, o.currency)} на кошелёк:\n<code>${esc(o.wallet)}</code>`,
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
      `🔔 <b>Клиент нажал «Я оплатил» по заявке #${order.id}!</b>\n` +
      `Проверьте поступление ${fmtRub(order.payRub || order.rub)} и подтвердите завершение.\n` +
      (order.receipt ? `🧾 Чек прикреплён: ${esc(order.receipt.name)} (${fmtSize(order.receipt.size)}).` : '🧾 Чек: нет ⚠️'),
      { parse_mode: 'HTML', reply_markup: orderKb(order) }
    );
  }
  if (type === 'tx') {
    await sendOrUpdateOrderAdmin(order);
    await notifyClientTx(order);
  }
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
    // admin reply -> try to notify client via bot
    try {
      await bot.api.sendMessage(message.userId,
        `💬 <b>Поддержка PRICELEX:</b>\n${esc(message.text)}`,
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
  const text =
    `🌌 <b>PRICELEX | Official</b> — пульт оператора\n` +
    `${s.online ? '🟢 Обменник <b>ОНЛАЙН</b>' : '🔴 Обменник <b>ОФФЛАЙН</b>'}\n` +
    `₿ ${fmtRub(s.rateBTC)} · Ł ${fmtRub(s.rateLTC)} (комиссия ${s.feePercent ?? 0}%)\n` +
    `Официальный курс ${s.rateUpdatedAt ? 'от ' + fmtDate(s.rateUpdatedAt) + ` (${esc(s.rateSource || '?')})` : 'ещё не подтянут — действуют стартовые курсы'}\n` +
    `Активных заявок: ${active} · 💬 Чатов: ${supportCount}`;
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
    kb.text(`#${o.id} · ${o.currency} · ${fmtRub(o.rub)} · ${o.status === 'new' ? '🔍' : o.status === 'paid' ? '⏳' : '💳'}`, `o:${o.id}`).row();
  }
  kb.text('🔄 Обновить', 'm:orders').text('↩️ Назад', 'm:home');
  const text = '📥 <b>Активные заявки</b> — нажмите, чтобы открыть:';
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

function settingsKb(s) {
  return new InlineKeyboard()
    .text(`💰 Комиссия ${s.feePercent ?? 0}%`, 's:fee')
    .text('🔄 Обновить курс', 's:refresh')
    .row()
    .text('⬇️ Мин. сумма', 's:min')
    .text('⬆️ Макс. сумма', 's:max')
    .row()
    .text(s.online ? '🟢 Онлайн' : '🔴 Оффлайн', 's:online')
    .text('🎁 Реф. %', 's:ref')
    .row()
    .text('📢 Объявление', 's:ann')
    .text('📇 Оператор', 's:op')
    .row()
    .text('📣 Канал', 's:ch')
    .text('💬 Чат', 's:chat')
    .row()
    .text('↩️ Назад', 'm:home');
}

function settingsText(s) {
  const base = s.baseRateBTC
    ? `₿ ${fmtRub(s.baseRateBTC)} · Ł ${fmtRub(s.baseRateLTC)}`
    : 'ещё не подтянут';
  return (
    `⚙️ <b>Настройки</b> (применяются мгновенно)\n\n` +
    `📊 Официальный курс (авто): <b>${base}</b>\n` +
    (s.rateUpdatedAt ? `Обновлён: ${fmtDate(s.rateUpdatedAt)} (${esc(s.rateSource || '?')})\n` : '') +
    `💰 Комиссия: <b>${s.feePercent ?? 0}%</b> поверх официального\n` +
    `💵 Курс для клиентов: <b>₿ ${fmtRub(s.rateBTC)} · Ł ${fmtRub(s.rateLTC)}</b>\n` +
    `Лимиты: ${fmtRub(s.minRub)} — ${fmtRub(s.maxRub)}\n` +
    `🎁 Реферальный процент: <b>${s.refPercent}%</b>\n` +
    `Статус: ${s.online ? '🟢 Онлайн' : '🔴 Оффлайн'}\n` +
    `📢 ${esc(s.announcement)}\n` +
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
    `🔍 Новых: ${t.new} · 💳 Ждут оплаты: ${t.details} · ⏳ Ждут подтверждения: ${t.paid}\n` +
    `🟢 Завершено: <b>${t.completed}</b> на <b>${fmtRub(t.volumeDone)}</b>\n` +
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

/* ---------- FSM ввода от админа ---------- */

const SET_FIELDS = {
  fee: { label: 'комиссию в % поверх официального курса (0–50, например 2)', num: true, key: 'feePercent' },
  min: { label: 'минимальную сумму обмена (₽)', num: true, key: 'minRub' },
  max: { label: 'максимальную сумму обмена (₽)', num: true, key: 'maxRub' },
  ref: { label: 'реферальный процент (например 1)', num: true, key: 'refPercent' },
  ann: { label: 'текст объявления для сайта' },
  op: { label: 'юзернейм оператора (например @pricelex_operator)' },
  ch: { label: 'ссылку на канал' },
  chat: { label: 'ссылку на чат' },
};

async function requisitesPrompt(ctx, o, payRub = o.rub) {
  flows.set(ctx.from.id, { type: 'req', orderId: o.id, version: o.version || 0, payRub });
  return ctx.reply(
    `💳 Заявка #${o.id}. Отправьте одним сообщением реквизиты (карта / СБП / счёт, банк и получатель).\n\nОни СРАЗУ появятся у клиента с суммой ${fmtRub(payRub)}. Если нужна другая сумма, сначала нажмите кнопку ниже.\n/cancel — отмена`,
    { reply_markup: new InlineKeyboard().text('✏️ Сначала изменить сумму', `o:${o.id}:quote`) }
  );
}

async function txPrompt(ctx, o) {
  flows.set(ctx.from.id, { type: 'tx', orderId: o.id, version: o.version || 0 });
  return ctx.reply(
    `🔗 Заявка #${o.id} — отправьте ссылку на транзакцию в блокчейне (например https://blockchair.com/bitcoin/transaction/… или https://blockchair.com/litecoin/transaction/…).\n\nСсылка появится у клиента в завершённой заявке. Это опционально — можно оставить пустым, отправив /cancel.\n\nТекущая: ${o.txUrl ? esc(o.txUrl) : '— нет —'}\n/cancel — отмена`,
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

async function handleAdminText(ctx) {
  const f = flows.get(ctx.from.id);
  if (!f) return ctx.reply('Выберите заявку через /menu, затем нажмите «Выдать реквизиты» или откройте чат поддержки.');
  const text = ctx.message.text.trim();
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^отмена$/i.test(text)) {
    flows.delete(ctx.from.id);
    return ctx.reply('❌ Ввод отменён.', { reply_markup: homeKb() });
  }
  if (f.type === 'support') {
    if (!text || text.length > 2000) return ctx.reply('Сообщение должно содержать от 1 до 2000 символов.');
    flows.delete(ctx.from.id);
    const msg = store.createSupportMessage(f.userId, 'admin', text);
    await onSupportMessage({ message: msg, user: { id: f.userId } });
    await ctx.reply(`✅ Ответ отправлен клиенту ${f.userId}.`, { reply_markup: homeKb() });
    // покажем чат после ответа
    const dummyCtx = ctx;
    await supportThreadView(dummyCtx, f.userId, false).catch(() => {});
    return;
  }
  if (f.orderId) {
    const o = store.getOrder(f.orderId);
    if (f.type === 'tx') {
      if (!o) {
        flows.delete(ctx.from.id);
        return ctx.reply('Заявка не найдена.', { reply_markup: homeKb() });
      }
      // tx можно добавить к любой завершённой заявке, версия не критична, но проверим что заявка всё ещё completed
      if (o.status !== 'completed') {
        flows.delete(ctx.from.id);
        return ctx.reply('Ссылку на блокчейн можно добавить только после подтверждения оплаты (статус «Завершена»).', { reply_markup: homeKb() });
      }
      // валидация URL
      if (!/^https?:\/\/.{4,800}$/i.test(text)) {
        return ctx.reply('Пришлите корректную ссылку, начинающуюся с https:// (до 800 символов). Пример: https://blockchair.com/bitcoin/transaction/abc…');
      }
      flows.delete(ctx.from.id);
      const upd = store.updateOrder(o.id, { txUrl: text });
      await Promise.all([sendOrUpdateOrderAdmin(upd), notifyClientTx(upd)]);
      return ctx.reply(`✅ Ссылка на блокчейн сохранена для заявки #${o.id}:\n${text}\n\nКлиент увидит её в приложении.`, { reply_markup: homeKb() });
    }
    const expectedStatus = f.type === 'amt' ? 'details' : f.type === 'quote' || f.type === 'req' ? 'new' : null;
    if (expectedStatus && (!o || o.status !== expectedStatus || (o.version || 0) !== f.version)) {
      flows.delete(ctx.from.id);
      return ctx.reply('Заявка уже изменена другим оператором или клиентом. Откройте её заново через /menu.', { reply_markup: homeKb() });
    }
    if (f.type === 'quote') {
      const pay = parseNum(text);
      if (!Number.isFinite(pay) || pay <= 0) return ctx.reply('Пришлите положительную сумму в рублях.');
      return requisitesPrompt(ctx, o, pay);
    }
    if (f.type === 'req') {
      if (!text || text.length > 900) return ctx.reply('Реквизиты должны содержать от 1 до 900 символов. Отправьте их целиком ещё раз.');
      flows.delete(ctx.from.id);
      const upd = store.updateOrder(o.id, { requisites: text, payRub: f.payRub, status: 'details' });
      const [, delivered] = await Promise.all([sendOrUpdateOrderAdmin(upd), notifyClient(upd)]);
      return ctx.reply(`✅ Реквизиты заявки #${o.id} опубликованы в приложении. К оплате: ${fmtRub(upd.payRub)}.\n` +
        (delivered ? 'Уведомление в Telegram отправлено.' : 'Личное сообщение не доставлено (возможно, клиент не запускал бота). Реквизиты доступны в приложении.'),
        { reply_markup: homeKb() });
    }
    if (f.type === 'amt') {
      const pay = /^(так|так же|same|=|\.)$/i.test(text) ? o.rub : parseNum(text);
      if (!Number.isFinite(pay) || pay <= 0) return ctx.reply('Не понял сумму. Пришлите число в рублях или «так же».');
      flows.delete(ctx.from.id);
      const upd = store.updateOrder(o.id, { payRub: pay });
      await Promise.all([sendOrUpdateOrderAdmin(upd), notifyClient(upd)]);
      return ctx.reply(`✅ Сумма заявки #${o.id} обновлена в приложении: ${fmtRub(pay)}.`, { reply_markup: homeKb() });
    }
  }
  if (f.type && f.type.startsWith('set:')) {
    const field = SET_FIELDS[f.type.slice(4)];
    if (field) {
      if (field.num) {
        const n = parseNum(text);
        if (f.type === 'set:fee') {
          if (!isFinite(n) || n < 0 || n > 50) return ctx.reply('Комиссия — число от 0 до 50. Пример: 2');
        } else if (!isFinite(n) || n <= 0) {
          return ctx.reply('Нужно положительное число.');
        }
        store.mutate((db) => {
          db.settings[field.key || f.type.slice(4)] = n;
        });
        if (f.type === 'set:fee') rates.recomputeWithFee();
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
    .text('👥 Админы', 'm:admins');
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
          await bot.api.sendMessage(id, 'Вы добавлены как оператор PRICELEX. /start — пульт оператора.')
            .catch(() => ctx.reply('Попросите нового админа открыть бота и нажать /start.'));
        }
        return adminsMenu(ctx);
      } catch (e) { return ctx.reply(e.message); }
    });
  }
  bot.command('start', async (ctx) => {
    if (!isAdmin(ctx)) {
      const url = store.get().settings.publicUrl;
      if (url) {
        return ctx.reply('🌌 PRICELEX — обмен BTC и LTC', {
          reply_markup: new InlineKeyboard().webApp('Открыть обменник', url),
        });
      }
      return ctx.reply('🌌 PRICELEX — обменник скоро будет доступен. Откройте сайт по ссылке из панели оператора.');
    }
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });
  bot.command('menu', async (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });

  bot.on('callback_query:data', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔️' });
    const d = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => {});
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);

    if (d === 'm:home') return mainMenu(ctx, true);
    if (d === 'm:orders') return ordersMenu(ctx, true);
    if (d === 'm:settings') return settingsMenu(ctx, true);
    if (d === 'm:stats') return statsMenu(ctx, true);
    if (d === 'm:admins') return adminsMenu(ctx);
    if (d === 'm:links') return linksMenu(ctx, true);
    if (d === 'm:support') return supportMenu(ctx, true);

    if (d.startsWith('sup:')) {
      const userId = d.slice(4);
      return supportThreadView(ctx, userId, true);
    }
    if (d.startsWith('suprep:')) {
      const userId = d.slice(7);
      return supportReplyPrompt(ctx, userId);
    }

    if (d === 's:online') {
      store.mutate((db) => {
        db.settings.online = !db.settings.online;
      });
      return settingsMenu(ctx, true);
    }
    if (d === 's:refresh') {
      await ctx.answerCallbackQuery({ text: 'Обновляю курс…' }).catch(() => {});
      try {
        const { source } = await rates.refreshRates();
        await settingsMenu(ctx, true);
        return ctx.reply(`✅ Официальный курс обновлён (источник: ${source}). Курсы для клиентов пересчитаны с комиссией.`, { reply_markup: homeKb() });
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
      const allowed = { req: ['new'], quote: ['new'], amt: ['details'], reject: ['new', 'details'], unpaid: ['paid'], confirm: ['details', 'paid'] };
      if (!allowed[act]?.includes(o.status)) {
        return ctx.reply('Действие недоступно: статус заявки уже изменился. Откройте заявку заново.', { reply_markup: homeKb() });
      }
      if (act === 'req') return requisitesPrompt(ctx, o);
      if (act === 'quote' || act === 'amt') {
        flows.set(ctx.from.id, { type: act, orderId: id, version: o.version || 0 });
        return ctx.reply(`✏️ Заявка #${id}. Отправьте точную сумму к оплате в ₽ (сейчас ${fmtRub(o.payRub || o.rub)}).\n/cancel — отмена`);
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
        const upd = store.updateOrder(id, { status: 'completed' });
        await sendOrUpdateOrderAdmin(upd);
        await ctx.reply(
          `📨 <b>Заявка #${id} завершена.</b>\nОтправьте клиенту вручную:\n🪙 <b>${fmtCrypto(upd.crypto, upd.currency)}</b>\n👛 <code>${esc(upd.wallet)}</code>\n\n💡 Теперь вы можете опционально отправить ссылку на блокчейн-транзакцию — нажмите кнопку ниже.`,
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔗 Добавить ссылку на блокчейн', `o:${id}:tx`) }
        );
        return;
      }
    }
  });

  bot.on('message:text', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await handleAdminText(ctx);
  });
}

/* ---------- запуск ---------- */

function createBot(options = {}) {
  bot = new Bot(config.botToken, { client: { timeoutSeconds: 15 }, ...options });
  register();
  bus.on('order_event', onOrderEvent);
  bus.on('support_message', onSupportMessage);
  return bot;
}

async function startBot() {
  if (!config.botToken) {
    console.log('[PRICELEX] BOT_TOKEN не задан → сайт работает в ДЕМО-режиме, бот отключён.');
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
    ])
    .catch(() => {});

  if (!admins.all().length) {
    console.warn('[PRICELEX] ВНИМАНИЕ: ADMIN_ID / ADMIN_IDS не заданы — нет администраторов.');
  }
  await Promise.all(admins.all().map(async (id) => {
    if (store.get().flags.onboardedAdmins?.[id]) return;
    try {
      await bot.api.sendMessage(id,
        `🚀 <b>PRICELEX запущен!</b>\n🤖 @${esc(bot.botInfo.username)}\n/start — пульт оператора\n/admins — список админов\n/support — чаты поддержки\nНовые заявки будут приходить всем операторам.`,
        { parse_mode: 'HTML' });
      store.mutate((db) => { (db.flags.onboardedAdmins ||= {})[id] = true; });
    } catch (e) { console.error(`[bot] onboarding ${id}:`, e.message); }
  }));
  for (const order of store.activeOrders()) await sendOrUpdateOrderAdmin(order);

  const applyPublicUrl = async (url, notifyAdmin = true) => {
    try {
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Открыть обменник', web_app: { url } } });
      console.log('[PRICELEX] кнопка меню Telegram настроена на', url);
    } catch (e) {
      console.error('[PRICELEX] setChatMenuButton:', e.message);
    }
    if (notifyAdmin) await broadcast(`🔗 Публичный адрес обменника:\n${url}`);
  };
  bus.on('public_url', (url) => applyPublicUrl(url, true));
  if (store.get().settings.publicUrl) {
    applyPublicUrl(store.get().settings.publicUrl, false).catch(() => {});
  }

  bot.catch((e) => console.error('[bot error]', e.message));
  bot.start();
  console.log('[PRICELEX] бот запущен: @' + bot.botInfo.username);
}

module.exports = { startBot, createBot };
