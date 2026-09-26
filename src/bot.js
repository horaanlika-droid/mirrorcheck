const { Bot, InlineKeyboard, InputFile } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const admins = require('./admins');
const rates = require('./rates');
const receipts = require('./receipts');
const { esc, fmtRub, fmtCrypto, fmtDate, fmtSize, parseNum, fmtMsk, parseMsk } = require('./util');
const { countSeedReviews, purgeSeedReviews } = require('./review-seed');

let bot = null;
const flows = new Map(); // adminId -> { type, orderId?, userId?, at }
const FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

function setFlow(id, data) {
  flows.set(id, { ...data, at: Date.now() });
}
function getFlow(id) {
  const f = flows.get(id);
  if (!f) return null;
  if (Date.now() - (f.at || 0) > FLOW_TTL_MS) {
    flows.delete(id);
    return null;
  }
  return f;
}
function clearExpiredFlows() {
  const now = Date.now();
  for (const [k, v] of flows) {
    if (now - (v.at || 0) > FLOW_TTL_MS) flows.delete(k);
  }
}
setInterval(clearExpiredFlows, 60_000).unref?.();

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
  if (type === 'new') {
    // параллельно уведомляем всех вошедших брокеров о свободной заявке
    await notifyBrokersNewOrder(order);
  }
  if (type === 'receipt') {
    await sendReceiptToAdmins(order);
    if (order.broker) await sendReceiptToFirstBrokerSession(order);
  }
  if (type === 'paid') {
    await broadcast(
      `🔔 <b>Клиент нажал «Я оплатил» по заявке #${order.id}!</b>\n` +
      `Проверьте поступление ${fmtRub(order.payRub || order.rub)} и подтвердите завершение.\n` +
      (order.receipt ? `🧾 Чек прикреплён: ${esc(order.receipt.name)} (${fmtSize(order.receipt.size)}).` : '🧾 Чек: нет ⚠️'),
      { parse_mode: 'HTML', reply_markup: orderKb(order) }
    );
    await notifyBrokerPaid(order);
  }
  if (type === 'tx') {
    await sendOrUpdateOrderAdmin(order);
    await notifyClientTx(order);
  }
  if (type === 'admin_called') {
    await sendOrUpdateOrderAdmin(order);
    const kb = new InlineKeyboard()
      .text('💬 Открыть чат поддержки', `sup:${order.userId}`)
      .text('📋 К заявке', `ord:${order.id}`);
    await broadcast(
      `🚨 <b>Клиент нажал «Позвать администратора» по заявке #${order.id}!</b>\n` +
      `🤝 Брокер: <b>${esc(order.broker || 'не назначен')}</b>\n` +
      `💰 Сумма: <b>${fmtRub(order.payRub || order.rub)}</b> → ${fmtCrypto(order.crypto, order.currency)}\n` +
      `👛 Кошелёк: <code>${esc(order.wallet)}</code>\n\n` +
      `🛡️ Брокер торгует под гарантией депозита и сам отправляет выплату клиенту. Администратор подключается в чат для помощи.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
    if (order.broker) {
      const bTgs = store.brokerSessionsByLogin(order.broker);
      for (const bTg of bTgs) {
        await sendMsg(
          bTg,
          `⚠️ <b>Клиент вызвал администратора по сделке #${order.id}!</b>\n` +
          `Администратор подключается в чат поддержки. Проверьте статус отправки криптовалюты клиенту.`
        ).catch(() => {});
      }
    }
  }
}

async function sendReceiptToFirstBrokerSession(o) {
  const tgId = store.brokerSessionsByLogin(o.broker)[0];
  if (tgId) await sendReceiptTo(tgId, o);
}

/* ---------- support chat ---------- */

async function onSupportMessage({ message, user }) {
  // Если сообщение адресовано конкретному брокеру (собеседование/депозит),
  // админы видят карточку именно его чата с кнопкой-переходом.
  const brokerChat = message.broker;
  const u = store.getUser(message.userId) || { name: user.first_name || user.name || 'Клиент', id: message.userId };
  const jump = brokerChat
    ? new InlineKeyboard()
        .text('💬 Чат брокера', `bchat:${String(message.userId)}:${String(brokerChat)}`)
        .text('📂 Все чаты', 'm:support')
    : new InlineKeyboard()
        .text('💬 Ответить', `suprep:${message.userId}`)
        .text('📂 Открыть чат', `sup:${message.userId}`);
  const fromLabel = brokerChat ? '🧑‍💼 Брокер' : message.from === 'user' ? '👤 Клиент' : '🛡️ Поддержка';
  const whoLine = brokerChat
    ? `🤝 Брокер: <code>${esc(brokerChat)}</code> · <code>${esc(message.userId)}</code>`
    : (message.from === 'user' ? `👤 ${esc(u.name)} · <code>${esc(message.userId)}</code>` : `👤 ${esc(u.name)} · чат с клиентом <code>${esc(message.userId)}</code>`);
  const preview = message.text.slice(0, 200);
  const text =
    `💬 <b>${brokerChat ? 'Чат брокера' : 'Поддержка'}</b>\n` +
    `${whoLine}\n` +
    `${fromLabel}: ${esc(preview)}\n` +
    `🕒 ${fmtDate(message.at)}`;

  if (message.from === 'user') {
    await broadcast(text, { parse_mode: 'HTML', reply_markup: jump });
  } else {
    // Ответ площадки: клиенту — в личку бота, а если это ответ брокеру — ему же.
    const target = brokerChat ? store.brokerSessionsByLogin(brokerChat)[0] : message.userId;
    if (target) {
      try {
        await bot.api.sendMessage(target,
          brokerChat
            ? `💬 <b>PRICELEX:</b>\n${esc(message.text)}`
            : `💬 <b>Поддержка PRICELEX:</b>\n${esc(message.text)}`,
          { parse_mode: 'HTML' });
      } catch (e) {
        console.error(`[bot] support reply → ${target}:`, e.message);
      }
    }
  }
}

// Ответ площадки конкретному брокеру: кладём сообщение в его персональную ветку
// и сразу уведомляем его же личным сообщением. Рендер диа­лога — у вызывающего.
async function replyToBrokerChat(userId, broker, text) {
  const msg = store.createSupportMessage(userId, 'admin', text, broker);
  const tgs = store.brokerSessionsByLogin(broker);
  if (tgs.length) {
    await Promise.all(tgs.map(async (tgId) => {
      try {
        await bot.api.sendMessage(tgId, `💬 <b>PRICELEX:</b>\n${esc(text)}`, { parse_mode: 'HTML' });
      } catch (e) {
        console.error(`[bot] broker chat reply → ${tgId}:`, e.message);
      }
    }));
  }
  return msg;
}

// Чат конкретного брокера глазами администратора: переписка собеседования,
// статус депозита и всё, что брокер писал площадке в этом же диалоге.
async function brokerChatAdminView(ctx, userId, login) {
  const msgs = store.getSupportMessages(String(userId)).filter((m) => !m.broker || m.broker === String(login));
  const p = store.brokerProfile(login);
  let body =
    `💬 <b>Чат с брокером</b> <code>${esc(login)}</code> · <code>${esc(userId)}</code>\n` +
    (p && p.depositBtc
      ? `🛡 Депозит: ${fmtBtc(p.depositBtc)} · стажировка до ${p.internUntil ? fmtDate(p.internUntil) : '—'}\n` : '') +
    '\n';
  if (!msgs.length) {
    body += 'Сообщений от брокера пока нет.';
  } else {
    for (const m of msgs.slice(-15)) {
      const who = m.from === 'user' ? `🧑‍💼 <b>${esc(login)}</b>` : '🛡️ Вы';
      body += `${who} · ${fmtDate(m.at)}:\n${esc(m.text)}\n\n`;
    }
  }
  const kb = new InlineKeyboard()
    .text('✍️ Ответить', `bchre:${userId}:${login}`)
    .text('🔄 Обновить', `bchat:${userId}:${login}`)
    .row()
    .text('↩️ Меню', 'm:home');
  return ctx.reply(body, { parse_mode: 'HTML', reply_markup: kb });
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

/* ---------- отзывы ---------- */

const REVIEW_STATUS = { pending: '🕓 На модерации', approved: '✅ Опубликован', rejected: '🙈 Скрыт' };
const REVIEW_LISTS = { pending: '🕓 На модерации', approved: '✅ Опубликованные', rejected: '🙈 Скрытые', low: '⚠️ Оценки ≤3★' };
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const REVIEWS_PAGE = 8;

function reviewText(r) {
  const order = r.orderId ? store.getOrder(r.orderId) : null;
  const user = r.userId ? store.getUser(r.userId) : null;
  const author = r.source === 'seed'
    ? ' · 🧪 тестовый (нагрузочный набор)'
    : r.source === 'admin'
      ? ' · добавлен оператором'
      : user ? ` · <code>${esc(user.id)}</code>${user.username ? ' @' + esc(user.username) : ''}` : '';
  return (
    `⭐ <b>Отзыв #${r.id}</b> · ${REVIEW_STATUS[r.status] || r.status}\n` +
    `${stars(r.rating)} ${r.rating}/5\n` +
    `👤 ${esc(r.name)}${author}\n` +
    (order ? `📥 Заявка #${order.id} · ${fmtRub(order.payRub || order.rub)} → ${esc(order.currency)}\n` : '') +
    `📅 ${fmtMsk(r.createdAt)} (МСК)\n\n` +
    `«${esc(r.text)}»` +
    (r.reply && r.reply.text
      ? `\n\n💬 <b>Ответ PRICELEX</b> · ${fmtMsk(r.reply.at)} (МСК)\n«${esc(r.reply.text)}»`
      : '')
  );
}

function reviewKb(r) {
  const kb = new InlineKeyboard();
  if (r.status === 'pending') kb.text('✅ Опубликовать', `rv:${r.id}:approve`).text('🚫 Отклонить', `rv:${r.id}:reject`).row();
  else if (r.status === 'approved') kb.text('🙈 Снять с публикации', `rv:${r.id}:reject`).row();
  else kb.text('✅ Опубликовать', `rv:${r.id}:approve`).row();
  kb.text('👤 Имя', `rv:${r.id}:name`).text('⭐ Оценка', `rv:${r.id}:rate`).row()
    .text('✏️ Текст', `rv:${r.id}:text`).text('📅 Дата и время', `rv:${r.id}:date`).row();
  if (r.reply && r.reply.text) {
    kb.text('✏️ Ответ', `rv:${r.id}:replyedit`).text('📅 Дата ответа', `rv:${r.id}:replydate`).row()
      .text('🗑 Снять ответ', `rv:${r.id}:replydel`).row();
  } else {
    kb.text('💬 Ответить', `rv:${r.id}:reply`).row();
  }
  return kb.text('🗑 Удалить', `rv:${r.id}:del`).text('📋 К списку', `rvl:${r.status}:0`);
}

// Карточка отзыва у всех админов обновляется после действий любого из них.
async function syncReviewCards(r, skip = null) {
  if (!bot || !r) return;
  const gone = !store.getReview(r.id);
  await Promise.all(Object.entries(r.adminMsgIds || {}).map(async ([adminId, msgId]) => {
    if (skip && String(skip.chat) === String(adminId) && skip.msg === msgId) return;
    const opts = gone ? { parse_mode: 'HTML' } : { parse_mode: 'HTML', reply_markup: reviewKb(r) };
    const text = gone ? `🗑 Отзыв #${r.id} удалён.` : reviewText(r);
    await bot.api.editMessageText(adminId, msgId, text, opts).catch(() => {});
  }));
}

async function onReviewEvent({ review, type }) {
  if (!bot || type !== 'new') return;
  await Promise.all(admins.all().map(async (adminId) => {
    const r = store.getReview(review.id);
    if (!r) return;
    try {
      const m = await bot.api.sendMessage(adminId, `🆕 <b>Новый отзыв — нужна модерация</b>\n\n${reviewText(r)}`,
        { parse_mode: 'HTML', reply_markup: reviewKb(r) });
      store.mutate(() => { (r.adminMsgIds ||= {})[adminId] = m.message_id; });
    } catch (e) {
      console.error(`[bot] review #${r.id} → admin ${adminId}:`, e.message);
    }
  }));
}

async function show(ctx, edit, text, kb) {
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  return ctx.reply(text, opts);
}

async function reviewsMenu(ctx, edit = true) {
  const pub = store.publicReviews(0).stats;
  const pending = store.reviewsByStatus('pending').length;
  const hidden = store.reviewsByStatus('rejected').length;
  const all = store.reviewsByStatus();
  const low = all.filter((r) => r.rating <= 3).length;
  const seeds = countSeedReviews(all);
  const pct = (n) => (pub.count ? Math.round((n / pub.count) * 100) : 0);
  const dist = pub.count ? `Оценки: ${[5, 4, 3, 2, 1].map((n) => `${n}★ ${pct(pub.dist[n])}%`).join(' · ')}\n` : '';
  const text =
    `⭐ <b>Отзывы</b>\n\n` +
    `Опубликовано: <b>${pub.count}</b>${pub.count ? ` · средняя оценка <b>${pub.avg.toFixed(1)}</b>` : ''}\n` +
    dist +
    `На модерации: <b>${pending}</b> · Скрыто: ${hidden}\n` +
    (seeds ? `🧪 Тестовых (нагрузочный набор): <b>${seeds}</b> — удалите их, прежде чем открывать витрину клиентам.\n` : '') +
    `\n` +
    `Клиент может оставить отзыв только после завершённого обмена — он попадает сюда на модерацию. ` +
    `Автор всегда видит свой отзыв опубликованным и о модерации не знает; остальным он виден только после одобрения.\n` +
    `Вы можете добавить отзыв сами, ответить на любой и отредактировать: имя, оценку, текст, дату отзыва и дату ответа (по Москве).`;
  const kb = new InlineKeyboard()
    .text(`🕓 На модерации${pending ? ` (${pending})` : ''}`, 'rvl:pending:0').row()
    .text('✅ Опубликованные', 'rvl:approved:0').text('🙈 Скрытые', 'rvl:rejected:0').row()
    .text(`⚠️ Оценки ≤3★${low ? ` (${low})` : ''}`, 'rvl:low:0').row()
    .text('➕ Добавить отзыв', 'rv:add').row();
  if (seeds) kb.text(`🧹 Удалить тестовые (${seeds})`, 'rvs:purge').row();
  kb.text('↩️ Назад', 'm:home');
  return show(ctx, edit, text, kb);
}

// Сотни отзывов: страницы по REVIEWS_PAGE с переходом в начало и в конец.
async function reviewsList(ctx, status, page = 0, edit = true) {
  const list = status === 'low'
    ? store.reviewsByStatus().filter((r) => r.rating <= 3)
    : store.reviewsByStatus(status);
  const pages = Math.max(1, Math.ceil(list.length / REVIEWS_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const kb = new InlineKeyboard();
  for (const r of list.slice(p * REVIEWS_PAGE, (p + 1) * REVIEWS_PAGE)) {
    const mark = `${r.source === 'seed' ? '🧪' : ''}${r.reply && r.reply.text ? '💬' : ''}`;
    kb.text(`${mark ? mark + ' ' : ''}${'★'.repeat(r.rating)} ${r.name.slice(0, 18)} · ${fmtMsk(r.createdAt).slice(0, 10)}`, `rv:${r.id}`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text('⏮', `rvl:${status}:0`).text('◀️', `rvl:${status}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, `rvl:${status}:${p}`);
    if (p < pages - 1) kb.text('▶️', `rvl:${status}:${p + 1}`).text('⏭', `rvl:${status}:${pages - 1}`);
    kb.row();
  }
  kb.text('⭐ Все отзывы', 'm:reviews').text('↩️ Меню', 'm:home');
  const text = `${REVIEW_LISTS[status]} — <b>${list.length}</b>${pages > 1 ? ` · стр. ${p + 1} из ${pages}` : ''}\n\n` +
    (list.length ? 'Выберите отзыв, чтобы открыть и отредактировать:' : 'Здесь пока пусто.') +
    (list.some((r) => r.source === 'seed') ? '\n🧪 — тестовый отзыв нагрузочного набора, 💬 — есть ответ PRICELEX.' : '');
  return show(ctx, edit, text, kb);
}

function reviewView(ctx, r, edit = true) {
  return show(ctx, edit, reviewText(r), reviewKb(r));
}

const REVIEW_ADD_STEPS = {
  name: 'Шаг 1/4 — <b>имя автора</b> так, как оно будет видно клиентам (например «Алексей К.»).',
  rate: 'Шаг 2/4 — <b>оценка</b>: нажмите кнопку или пришлите число от 1 до 5.',
  text: 'Шаг 3/4 — <b>текст отзыва</b> (от 5 до 1000 символов).',
  date: 'Шаг 4/4 — <b>дата и время</b> по Москве: <code>24.09.2026 14:30</code>, <code>24.09 14:30</code> или «сейчас».',
};

const rateKb = (prefix, back) => {
  const kb = new InlineKeyboard();
  for (let n = 1; n <= 5; n += 1) kb.text('★'.repeat(n), `${prefix}${n}`).row();
  if (back) kb.text('↩️ Отмена', back);
  return kb;
};

function reviewAddPrompt(ctx, draft, step) {
  setFlow(ctx.from.id, { type: 'rvadd', step, draft });
  const text = `➕ <b>Новый отзыв</b>\n${REVIEW_ADD_STEPS[step]}\n/cancel — отмена`;
  if (step === 'rate') return ctx.reply(text, { parse_mode: 'HTML', reply_markup: rateKb('rva:rate:') });
  if (step === 'date') return ctx.reply(text, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🕒 Сейчас', 'rva:date:now') });
  return ctx.reply(text, { parse_mode: 'HTML' });
}

async function reviewAddStep(ctx, f, value) {
  const draft = { ...f.draft };
  if (f.step === 'name') {
    if (!value || value.length > 60) return ctx.reply('Имя — от 1 до 60 символов.');
    draft.name = value;
    return reviewAddPrompt(ctx, draft, 'rate');
  }
  if (f.step === 'rate') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) return ctx.reply('Оценка — целое число от 1 до 5.');
    draft.rating = n;
    return reviewAddPrompt(ctx, draft, 'text');
  }
  if (f.step === 'text') {
    if (value.length < 5 || value.length > store.REVIEW_TEXT_MAX) return ctx.reply(`Текст — от 5 до ${store.REVIEW_TEXT_MAX} символов.`);
    draft.text = value;
    return reviewAddPrompt(ctx, draft, 'date');
  }
  if (f.step === 'date') {
    const ts = parseMsk(value);
    if (!Number.isFinite(ts)) return ctx.reply('Не понял дату. Формат: 24.09.2026 14:30 (по Москве) или «сейчас».');
    flows.delete(ctx.from.id);
    const r = store.createReview({ ...draft, createdAt: ts, status: 'approved', source: 'admin' });
    await ctx.reply(`✅ Отзыв #${r.id} добавлен и опубликован. Его можно отредактировать или скрыть:`);
    return reviewView(ctx, r, false);
  }
}

const REVIEW_EDIT = {
  name: 'новое <b>имя автора</b> (до 60 символов)',
  text: `новый <b>текст отзыва</b> (5–${store.REVIEW_TEXT_MAX} символов)`,
  date: 'новую <b>дату и время</b> по Москве: <code>24.09.2026 14:30</code>, <code>24.09 14:30</code> или «сейчас»',
};

async function reviewReplyStep(ctx, f, value) {
  const r = store.getReview(f.reviewId);
  if (!r) {
    flows.delete(ctx.from.id);
    return ctx.reply('Отзыв не найден — возможно, его удалили.', { reply_markup: homeKb() });
  }
  if (f.step === 'text') {
    if (!value || value.length > store.REVIEW_TEXT_MAX) return ctx.reply(`Ответ — от 1 до ${store.REVIEW_TEXT_MAX} символов.`);
    setFlow(ctx.from.id, { type: 'rvreply', step: 'date', reviewId: r.id, text: value });
    return ctx.reply(
      `📅 Отзыв #${r.id}. Шаг 2/2 — <b>дата ответа</b> по Москве: <code>24.09.2026 14:30</code>, <code>24.09 14:30</code> или «сейчас».\n/cancel — отмена`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🕒 Сейчас', 'rvr:now') }
    );
  }
  if (f.step === 'date') {
    const ts = parseMsk(value);
    if (!Number.isFinite(ts)) return ctx.reply('Не понял дату. Формат: 24.09.2026 14:30 (по Москве) или «сейчас».');
    flows.delete(ctx.from.id);
    const upd = store.updateReview(r.id, { reply: { text: f.text, at: ts, by: String(ctx.from.id) } });
    await syncReviewCards(upd);
    await ctx.reply('✅ Ответ опубликован — клиенты увидят его под отзывом.');
    return reviewView(ctx, upd, false);
  }
}

async function reviewEditText(ctx, f, value) {
  const r = store.getReview(f.reviewId);
  if (!r) {
    flows.delete(ctx.from.id);
    return ctx.reply('Отзыв не найден — возможно, его удалили.', { reply_markup: homeKb() });
  }
  let patch;
  if (f.field === 'name') {
    if (!value || value.length > 60) return ctx.reply('Имя — от 1 до 60 символов.');
    patch = { name: value };
  } else if (f.field === 'text') {
    if (value.length < 5 || value.length > store.REVIEW_TEXT_MAX) return ctx.reply(`Текст — от 5 до ${store.REVIEW_TEXT_MAX} символов.`);
    patch = { text: value };
  } else if (f.field === 'date') {
    const ts = parseMsk(value);
    if (!Number.isFinite(ts)) return ctx.reply('Не понял дату. Формат: 24.09.2026 14:30 (по Москве) или «сейчас».');
    patch = { createdAt: ts };
  } else if (f.field === 'reply') {
    if (!value || value.length > store.REVIEW_TEXT_MAX) return ctx.reply(`Ответ — от 1 до ${store.REVIEW_TEXT_MAX} символов.`);
    patch = { reply: { text: value, at: (r.reply && Number.isFinite(r.reply.at) ? r.reply.at : Date.now()), by: String(ctx.from.id) } };
  } else if (f.field === 'replydate') {
    const ts = parseMsk(value);
    if (!Number.isFinite(ts)) return ctx.reply('Не понял дату. Формат: 24.09.2026 14:30 (по Москве) или «сейчас».');
    if (!r.reply || !r.reply.text) {
      flows.delete(ctx.from.id);
      return ctx.reply('Сначала напишите ответ.', { reply_markup: homeKb() });
    }
    patch = { reply: { text: r.reply.text, at: ts, by: r.reply.by || String(ctx.from.id) } };
  } else {
    flows.delete(ctx.from.id);
    return ctx.reply('Неизвестное поле.', { reply_markup: homeKb() });
  }
  flows.delete(ctx.from.id);
  const upd = store.updateReview(r.id, patch);
  await syncReviewCards(upd);
  await ctx.reply('✅ Отзыв обновлён — изменения уже на сайте.');
  return reviewView(ctx, upd, false);
}

async function onReviewCallback(ctx, d, prevFlow) {
  if (d === 'm:reviews') return reviewsMenu(ctx, true);
  let m = d.match(/^rvl:(pending|approved|rejected|low):(\d+)$/);
  if (m) return reviewsList(ctx, m[1], Number(m[2]), true);
  // Нагрузочный набор (tools/seed-reviews.js) убирается отсюда, не останавливая сервер.
  if (d === 'rvs:purge') {
    const n = countSeedReviews(store.get().reviews);
    if (!n) return reviewsMenu(ctx, true);
    return show(ctx, true,
      `🧹 Удалить <b>${n}</b> тестовых отзывов нагрузочного набора?\n\nЖивые отзывы клиентов и добавленные вами не пострадают.`,
      new InlineKeyboard().text('🧹 Да, удалить тестовые', 'rvs:purgeok').text('↩️ Отмена', 'm:reviews'));
  }
  if (d === 'rvs:purgeok') {
    const n = purgeSeedReviews(store);
    return show(ctx, true, `🧹 Удалено тестовых отзывов: <b>${n}</b>. На витрине остались только настоящие.`,
      new InlineKeyboard().text('⭐ Отзывы', 'm:reviews').text('↩️ Меню', 'm:home'));
  }
  if (d === 'rv:add') return reviewAddPrompt(ctx, {}, 'name');
  m = d.match(/^rva:(rate|date):(\w+)$/);
  if (m) {
    if (!prevFlow || prevFlow.type !== 'rvadd' || prevFlow.step !== m[1]) {
      return ctx.reply('Этот шаг уже неактуален. Начните заново: ⭐ Отзывы → ➕ Добавить отзыв.', { reply_markup: homeKb() });
    }
    return reviewAddStep(ctx, prevFlow, m[1] === 'date' ? 'сейчас' : m[2]);
  }
  if (d === 'rvr:now') {
    if (!prevFlow || prevFlow.type !== 'rvreply' || prevFlow.step !== 'date') {
      return ctx.reply('Этот шаг уже неактуален. Откройте отзыв и нажмите «Ответить» ещё раз.', { reply_markup: homeKb() });
    }
    return reviewReplyStep(ctx, prevFlow, 'сейчас');
  }
  m = d.match(/^rv:(\d+)(?::(\w+))?(?::(\w+))?$/);
  if (!m) return false;
  const r = store.getReview(m[1]);
  if (!r) return ctx.editMessageText('Отзыв не найден — возможно, его удалили.', { reply_markup: new InlineKeyboard().text('⭐ Отзывы', 'm:reviews') }).catch(() => {});
  const act = m[2];
  const arg = m[3];
  const here = { chat: ctx.chat?.id, msg: ctx.callbackQuery?.message?.message_id };
  if (!act) return reviewView(ctx, r, true);
  if (act === 'approve' || act === 'reject') {
    const upd = store.updateReview(r.id, { status: act === 'approve' ? 'approved' : 'rejected', moderatedBy: String(ctx.from.id) });
    await reviewView(ctx, upd, true);
    await syncReviewCards(upd, here);
    return;
  }
  if (act === 'rate') {
    if (arg) {
      const upd = store.updateReview(r.id, { rating: Number(arg) });
      await reviewView(ctx, upd, true);
      return syncReviewCards(upd, here);
    }
    return show(ctx, true, `⭐ Отзыв #${r.id} — выберите новую оценку (сейчас ${r.rating}/5):`, rateKb(`rv:${r.id}:rate:`, `rv:${r.id}`));
  }
  if (act === 'date' && arg === 'now') {
    const upd = store.updateReview(r.id, { createdAt: Date.now() });
    await reviewView(ctx, upd, true);
    return syncReviewCards(upd, here);
  }
  if (act === 'reply') {
    setFlow(ctx.from.id, { type: 'rvreply', step: 'text', reviewId: r.id });
    return ctx.reply(
      `💬 Отзыв #${r.id}. Напишите <b>ответ</b> от имени PRICELEX (1–${store.REVIEW_TEXT_MAX} символов).\n/cancel — отмена`,
      { parse_mode: 'HTML' }
    );
  }
  if (act === 'replyedit') {
    setFlow(ctx.from.id, { type: 'rvedit', field: 'reply', reviewId: r.id });
    const current = r.reply && r.reply.text ? `«${esc(r.reply.text)}»` : '— нет —';
    return ctx.reply(
      `✏️ Отзыв #${r.id}. Отправьте новый <b>текст ответа</b> (1–${store.REVIEW_TEXT_MAX} символов).\n\nСейчас: ${current}\n/cancel — отмена`,
      { parse_mode: 'HTML' }
    );
  }
  if (act === 'replydate') {
    if (!r.reply || !r.reply.text) return ctx.reply('Сначала напишите ответ.');
    if (arg === 'now') {
      const upd = store.updateReview(r.id, { reply: { text: r.reply.text, at: Date.now(), by: r.reply.by || String(ctx.from.id) } });
      await reviewView(ctx, upd, true);
      return syncReviewCards(upd, here);
    }
    setFlow(ctx.from.id, { type: 'rvedit', field: 'replydate', reviewId: r.id });
    return ctx.reply(
      `📅 Отзыв #${r.id}. Отправьте <b>дату ответа</b> по Москве: <code>24.09.2026 14:30</code>, <code>24.09 14:30</code> или «сейчас».\n\nСейчас: ${fmtMsk(r.reply.at)} (МСК)\n/cancel — отмена`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🕒 Сейчас', `rv:${r.id}:replydate:now`) }
    );
  }
  if (act === 'replydel') {
    const upd = store.updateReview(r.id, { reply: null });
    await reviewView(ctx, upd, true);
    return syncReviewCards(upd, here);
  }
  if (REVIEW_EDIT[act]) {
    setFlow(ctx.from.id, { type: 'rvedit', field: act, reviewId: r.id });
    const current = act === 'date' ? fmtMsk(r.createdAt) + ' (МСК)' : act === 'name' ? esc(r.name) : `«${esc(r.text)}»`;
    const kb = act === 'date' ? new InlineKeyboard().text('🕒 Сейчас', `rv:${r.id}:date:now`) : undefined;
    return ctx.reply(`✏️ Отзыв #${r.id}. Отправьте ${REVIEW_EDIT[act]}.\n\nСейчас: ${current}\n/cancel — отмена`,
      { parse_mode: 'HTML', ...(kb ? { reply_markup: kb } : {}) });
  }
  if (act === 'del') {
    return show(ctx, true, `🗑 Удалить отзыв #${r.id} от ${esc(r.name)} безвозвратно?`,
      new InlineKeyboard().text('🗑 Да, удалить', `rv:${r.id}:delok`).text('↩️ Отмена', `rv:${r.id}`));
  }
  if (act === 'delok') {
    const gone = store.deleteReview(r.id);
    await syncReviewCards(gone, here);
    return show(ctx, true, `🗑 Отзыв #${r.id} удалён.`, new InlineKeyboard().text('⭐ Отзывы', 'm:reviews').text('↩️ Меню', 'm:home'));
  }
  return false;
}

/* ---------- меню ---------- */

async function mainMenu(ctx, edit = false) {
  const s = store.get().settings;
  const active = store.activeOrders().length;
  const supportCount = store.getSupportThreads().length;
  const pendingReviews = store.reviewsByStatus('pending').length;
  const pendingBrokerApps = store.brokerAppsByStatus('pending').length;
  const pendingPayouts = store.payoutsByStatus('pending').length + store.brokerDepositsByStatus('pending').length;
  const kb = new InlineKeyboard()
    .text(`📥 Заявки${active ? ` (${active})` : ''}`, 'm:orders')
    .text('📊 Статистика', 'm:stats')
    .row()
    .text('⚙️ Настройки', 'm:settings')
    .text('🔗 Ссылки', 'm:links')
    .row()
    .text(`💬 Поддержка${supportCount ? ` (${supportCount})` : ''}`, 'm:support')
    .text(`⭐ Отзывы${pendingReviews ? ` (${pendingReviews})` : ''}`, 'm:reviews')
    .row()
    .text(`🤝 Брокеры${pendingBrokerApps ? ` (${pendingBrokerApps})` : ''}`, 'm:brokers')
    .text(`💸 Выплаты${pendingPayouts ? ` (${pendingPayouts})` : ''}`, 'm:payouts')
    .row()
    .text('👥 Админы', 'm:admins');
  const text =
    `🌌 <b>PRICELEX | Official</b> — пульт оператора\n` +
    `${s.online ? '🟢 Обменник <b>ОНЛАЙН</b>' : '🔴 Обменник <b>ОФФЛАЙН</b>'}\n` +
    `₿ ${fmtRub(s.rateBTC)} · G ${fmtRub(s.rateGRAM)} (комиссия ${s.feePercent ?? 0}%)\n` +
    `Официальный курс ${s.rateUpdatedAt ? 'от ' + fmtDate(s.rateUpdatedAt) + ` (${esc(s.rateSource || '?')})` : 'ещё не подтянут — действуют стартовые курсы'}\n` +
    `Активных заявок: ${active} · 💬 Чатов: ${supportCount}` +
    (pendingReviews ? `\n⭐ Отзывов на модерации: <b>${pendingReviews}</b>` : '');
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
    .text(`⏱ Время обмена ${Number(s.avgExchangeMin) > 0 ? s.avgExchangeMin + ' мин' : 'авто'}`, 's:avgm')
    .row()
    .text('📢 Объявление', 's:ann')
    .text('🛟 Поддержка', 's:op')
    .row()
    .text('📣 Канал', 's:ch')
    .text('💬 Чат', 's:chat')
    .row()
    .text('🤝 Брокеры и выплаты', 'm:brokers')
    .row()
    .text('↩️ Назад', 'm:home');
}

const fmtUsdRub = (n) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';

// «🛰 Источники курса на связи: 10 из 12» — видно, если биржи начали отваливаться.
function ratesHealthLine() {
  const list = rates.status().sources;
  const tried = list.filter((x) => x.tried);
  if (!tried.length) return '';
  const down = tried.filter((x) => !x.ok).map((x) => `${x.name} (${x.error})`);
  return (
    `🛰 Источники курса на связи: <b>${tried.length - down.length} из ${list.length}</b>` +
    (down.length ? ` · на паузе: ${esc(down.join(', '))}` : '') +
    '\n'
  );
}

function settingsText(s) {
  const base = s.baseRateBTC
    ? `₿ ${fmtRub(s.baseRateBTC)} · G ${fmtRub(s.baseRateGRAM)}`
    : 'ещё не подтянут';
  return (
    `⚙️ <b>Настройки</b> (применяются мгновенно)\n\n` +
    `📊 Официальный курс (авто): <b>${base}</b>\n` +
    (s.rateUpdatedAt ? `Обновлён: ${fmtDate(s.rateUpdatedAt)} (${esc(s.rateSource || '?')})\n` : '') +
    (s.usdRub ? `💱 Курс доллара: ${fmtUsdRub(s.usdRub)} (${esc(s.usdRubSource || '?')}${s.usdRubAt ? ', ' + fmtDate(s.usdRubAt) : ''})\n` : '') +
    ratesHealthLine() +
    `💰 Комиссия: <b>${s.feePercent ?? 0}%</b> поверх официального\n` +
    `💵 Курс для клиентов: <b>₿ ${fmtRub(s.rateBTC)} · G ${fmtRub(s.rateGRAM)}</b>\n` +
    `Лимиты: ${fmtRub(s.minRub)} — ${fmtRub(s.maxRub)}\n` +
    `🎁 Реферальный процент: <b>${s.refPercent}%</b>\n` +
    `⏱ Среднее время обмена: <b>${Number(s.avgExchangeMin) > 0 ? s.avgExchangeMin + ' мин (задано вручную)' : (store.avgExchangeMinutesComputed() ? store.avgExchangeMinutesComputed() + ' мин (авто)' : 'пока нет данных')}</b>\n` +
    `Статус: ${s.online ? '🟢 Онлайн' : '🔴 Оффлайн'}\n` +
    `📢 ${esc(s.announcement)}\n` +
    `${s.operator ? `🛟 Поддержка: ${esc(s.operator)} · ` : '🛟 Поддержка: чат в приложении · '}📣 ${esc(s.channel)}\n💬 ${esc(s.chat)}`
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
  const text =
    `🔗 <b>Ссылки</b>\n\n` +
    `🛟 Поддержка: ${s.operator ? esc(s.operator) : 'чат в приложении'}\n📣 Канал: ${esc(s.channel)}\n💬 Чат: ${esc(s.chat)}\n\n` +
    `Приложение открывается кнопкой меню этого бота.`;
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
  avgm: { label: 'среднее время обмена в минутах (0 — считать автоматически по сделкам, например 12)', num: true, key: 'avgExchangeMin' },
  ann: { label: 'текст объявления для сайта', key: 'announcement' },
  op: { label: 'юзернейм поддержки в Telegram (пусто — только чат в приложении)', key: 'operator' },
  ch: { label: 'ссылку на канал', key: 'channel' },
  chat: { label: 'ссылку на чат', key: 'chat' },
  blog: { label: 'логин брокера (один для всех сессий)', key: 'brokerLogin' },
  bpass: { label: 'пароль брокера', key: 'brokerPassword' },
  bshare: { label: 'долю брокера в спреде, % (например 70)', num: true, key: 'brokerSharePercent' },
  bops: { label: 'операционные расходы со сделки, ₽ (вычитаются из спреда до деления)', num: true, key: 'opsExpensesRub' },
  bminp: { label: 'минимальную выплату брокеру в BTC (например 0.0002)', num: true, key: 'brokerMinPayoutBtc' },
  bdepbtc: { label: 'депозит стажёра в BTC (например 0.0002)', num: true, key: 'brokerDepositBtc' },
  gfund: { label: 'общий гарантийный депозит всех брокеров в BTC — его видит клиент (например 0.02)', num: true, key: 'guaranteeFundBtc' },
  bdepusd: { label: 'депозит стажёра в $ для текстов (например 20)', num: true, key: 'brokerDepositUsd' },
  bdepa: { label: 'BTC-адрес для приёма депозитов брокеров', key: 'brokerDepositAddress' },
  bdepfee: { label: 'сбор за подключение брокера, % от депозита (0–100, например 10)', num: true, key: 'brokerDepositFeePercent' },
  bdepfeemax: { label: 'предел сбора за подключение в BTC (0 — без предела, например 0.0005)', num: true, key: 'brokerDepositFeeMaxBtc' },
  binmax: { label: 'лимит заявки стажёра, ₽ (например 5000)', num: true, key: 'internMaxRub' },
  bindays: { label: 'длительность стажировки в днях (например 7)', num: true, key: 'internDays' },
};

async function requisitesPrompt(ctx, o, payRub = o.rub) {
  setFlow(ctx.from.id, { type: 'req', orderId: o.id, version: o.version || 0, payRub });
  return ctx.reply(
    `💳 Заявка #${o.id}. Отправьте одним сообщением реквизиты (карта / СБП / счёт, банк и получатель).\n\nОни СРАЗУ появятся у клиента с суммой ${fmtRub(payRub)}. Если нужна другая сумма, сначала нажмите кнопку ниже.\n/cancel — отмена`,
    { reply_markup: new InlineKeyboard().text('✏️ Сначала изменить сумму', `o:${o.id}:quote`) }
  );
}

async function txPrompt(ctx, o) {
  setFlow(ctx.from.id, { type: 'tx', orderId: o.id, version: o.version || 0 });
  return ctx.reply(
    `🔗 Заявка #${o.id} — отправьте ссылку на транзакцию в блокчейне (например https://blockchair.com/bitcoin/transaction/… или https://blockchair.com/gram/transaction/…).\n\nСсылка появится у клиента в завершённой заявке. Это опционально — можно оставить пустым, отправив /cancel.\n\nТекущая: ${o.txUrl ? esc(o.txUrl) : '— нет —'}\n/cancel — отмена`,
    { parse_mode: 'HTML' }
  );
}

async function supportReplyPrompt(ctx, userId) {
  setFlow(ctx.from.id, { type: 'support', userId: String(userId) });
  const user = store.getUser(userId);
  return ctx.reply(
    `💬 Ответ клиенту ${user ? esc(user.name) + ' ' : ''}<code>${esc(userId)}</code>.\nНапишите сообщение — оно сразу появится у клиента в приложении и уйдёт ему в Telegram, если он запускал бота.\n/cancel — отмена`,
    { parse_mode: 'HTML' }
  );
}

async function handleAdminText(ctx) {
  const f = getFlow(ctx.from.id);
  if (!f) return ctx.reply('Выберите заявку через /menu, затем нажмите «Выдать реквизиты» или откройте чат поддержки.');
  const text = ctx.message.text.trim();
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^отмена$/i.test(text)) {
    flows.delete(ctx.from.id);
    return ctx.reply('❌ Ввод отменён.', { reply_markup: homeKb() });
  }
  if (f.type === 'rvadd') return reviewAddStep(ctx, f, text);
  if (f.type === 'rvedit') return reviewEditText(ctx, f, text);
  if (f.type === 'rvreply') return reviewReplyStep(ctx, f, text);
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
  if (f.type === 'achreply') {
    const { userId, broker } = f;
    if (!text || text.length > 2000) return ctx.reply('Сообщение должно содержать от 1 до 2000 символов.');
    await replyToBrokerChat(userId, broker, text);
    flows.delete(ctx.from.id);
    await ctx.reply(`✅ Ответ отправлен брокеру <code>${esc(broker)}</code>.`, { parse_mode: 'HTML', reply_markup: homeKb() });
    return brokerChatAdminView(ctx, userId, broker);
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
  if (f.type && (f.type.startsWith('set:') || f.type.startsWith('setb:'))) {
    const key = f.type.slice(f.type.indexOf(':') + 1);
    const field = SET_FIELDS[key];
    if (field) {
      if (field.num) {
        const n = parseNum(text);
        if (f.type === 'set:fee') {
          if (!isFinite(n) || n < 0 || n > 50) return ctx.reply('Комиссия — число от 0 до 50. Пример: 2');
        } else if (key === 'bshare') {
          if (!isFinite(n) || n < 0 || n > 100) return ctx.reply('Доля брокера — от 0 до 100. Пример: 70');
        } else if (key === 'bops') {
          if (!isFinite(n) || n < 0) return ctx.reply('Расходы — неотрицательное число в ₽. Пример: 50');
        } else if (key === 'bindays') {
          if (!isFinite(n) || n < 1 || n > 90) return ctx.reply('Стажировка — от 1 до 90 дней. Пример: 7');
        } else if (key === 'bdepfee') {
          if (!isFinite(n) || n < 0 || n > 100) return ctx.reply('Сбор — от 0 до 100% от депозита. Пример: 10');
        } else if (key === 'bdepfeemax') {
          if (!isFinite(n) || n < 0) return ctx.reply('Предел сбора — неотрицательное число в BTC. Пример: 0.0005 (0 — без предела)');
        } else if (key === 'avgm') {
          if (!isFinite(n) || n < 0 || n > 480) return ctx.reply('Среднее время обмена — целое от 0 (авто) до 480 минут. Пример: 12');
        } else if (!isFinite(n) || n <= 0) {
          return ctx.reply('Нужно положительное число.');
        }
        store.mutate((db) => {
          db.settings[field.key || key] = n;
        });
        if (f.type === 'set:fee') rates.recomputeWithFee();
      } else {
        store.mutate((db) => {
          db.settings[field.key || key] = text.slice(0, 500);
        });
      }
      flows.delete(ctx.from.id);
      const back = f.type.startsWith('setb:') ? brokersMenu(ctx, false) : settingsMenu(ctx, false);
      return back.then(() =>
        ctx.reply('✅ Сохранено и уже применилось.', { reply_markup: homeKb() })
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
    .text('⭐ Отзывы', 'm:reviews')
    .row()
    .text('👥 Админы', 'm:admins');
}

async function adminsMenu(ctx) {
  const list = admins.all().map((id) => `<code>${id}</code>${admins.isOwner(id) ? ' — владелец' : ' — оператор'}`).join('\n');
  return ctx.reply(`👥 <b>Администраторы</b>\n\n${list}\n\n` +
    (admins.isOwner(ctx.from.id)
      ? 'Добавить: /addadmin 123456789\nУдалить: /removeadmin 123456789\nНовый админ должен открыть бота и нажать /start.'
      : 'Добавлять и удалять операторов может только владелец.'), { parse_mode: 'HTML' });
}

/* ==================== КАБИНЕТ БРОКЕРА ==================== */

const brokerLoginOf = (tgId) => {
  const s = store.brokerSession(tgId);
  return s ? s.login : null;
};

const fmtBtc = (v) => (Math.round(Number(v) * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, '') + ' BTC';
// Короткий вид без суффикса — для подписей кнопок.
const fmtBtcNum = (v) => (Math.round(Number(v) * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, '');

// Кто может работать: вошедший брокер (не админ — у того свой контур).
function brokerCtx(ctx) {
  const login = brokerLoginOf(ctx.from.id);
  if (!login) return null;
  const creds = store.brokerCreds();
  if (!creds.active) return null; // креды отключены
  if (creds.login !== login && !(store.isAdminBroker && store.isAdminBroker(login))) return null; // креды сменили — перелогин
  return login;
}

function brokerHomeText(login) {
  const s = store.get().settings;
  const earned = store.brokerEarnedBtc(login);
  const avail = store.brokerAvailableBtc(login);
  const deals = store.brokerLedgerFor(login).length;
  const p = store.brokerProfile(login);
  const intern = store.brokerIsIntern(login);
  let head = `🤝 <b>Кабинет брокера</b> · <code>${esc(login)}</code>\n\n`;
  if (intern && !(p && p.depositBtc)) {
    head +=
      `🎓 Вы на стажировке. Первый шаг — чат: напишите о себе (опыт, направления, объёмы), администрация выдаст реквизиты на возвратный депозит.\n\n` +
      `💬 <b>Чат</b> — открыть переписку с площадкой (кнопка ниже).\n\n`;
  } else if (intern) {
    head +=
      `🎓 Стажировка: осталось ~${store.brokerInternLeft(login)} дн. ` +
      `Торгуете ровно на сумму депозита ${fmtBtc(p.depositBtc)} (до ${fmtRub(s.internMaxRub)}). ` +
      `Если у клиента возникнут проблемы с выплатой, площадка компенсирует из депозита.\n\n`;
  } else if (p && p.depositBtc) {
    head +=
      `🛡️ Депозит ${fmtBtc(p.depositBtc)} под контролем площадки. Со временем, по мере роста доверия, площадка закрывает часть депозита — ваш лимит растёт на освободившуюся сумму.\n\n`;
  }
  return (
    head +
    `💰 Заработано: <b>${fmtBtc(earned)}</b>\n` +
    `💼 Доступно к выводу: <b>${fmtBtc(avail)}</b>\n` +
    `🧾 Завершённых сделок: <b>${deals}</b>\n` +
    `📉 Ваша доля — ${s.brokerSharePercent}% спреда каждой сделки.\n` +
    `💸 Выплата от ${fmtBtc(s.brokerMinPayoutBtc)} в любое время.\n\n` +
    `Дальше обучение — его анонсируем отдельно.`
  );
}

function brokerHomeKb(login) {
  const avail = store.brokerAvailableBtc(login);
  const min = Number(store.get().settings.brokerMinPayoutBtc) || 0.0002;
  const kb = new InlineKeyboard()
    .text('💬 Чат', 'b:chat')
    .text('📥 Заявки', 'b:orders')
    .row()
    .text('💰 Баланс', 'b:bal')
    .text('💸 Вывести', 'b:withdraw')
    .row()
    .text('🏦 Депозит', 'b:deposit')
    .text('🚪 Выйти', 'b:logout');
  if (avail < min) kb.text('🔄', 'b:home');
  return kb;
}

async function brokerHome(ctx, edit = false) {
  const login = brokerCtx(ctx);
  if (!login) return brokerAuthStart(ctx);
  const text = brokerHomeText(login);
  const opts = { parse_mode: 'HTML', reply_markup: brokerHomeKb(login) };
  if (edit) return ctx.editMessageText(text, opts).catch(() => {});
  return ctx.reply(text, opts);
}

// Отклик на «💬 Чат» в кабинете брокера: если персональная лента пустая и нет
// подтверждённого депозита, показываем карточку первого шага (собеседование →
// реквизиты → депозит), иначе открываем переписку с площадкой.
async function brokerChatOpen(ctx, edit = true) {
  const login = brokerCtx(ctx);
  if (!login) return brokerAuthStart(ctx);
  const p = store.brokerProfile(login);
  const started = store.getSupportMessages(String(ctx.from.id)).some((m) => m.broker === String(login));
  const pending = p && p.depositBtc;
  if (!started && !pending) {
    const intro = brokerInvestMessage(login);
    const opts = { parse_mode: 'HTML', reply_markup: intro.kb };
    if (edit) return ctx.editMessageText(intro.text, opts).catch(() => {});
    return ctx.reply(intro.text, opts);
  }
  return brokerSupportThreadView(ctx, login, edit);
}

async function brokerAuthStart(ctx) {
  const creds = store.brokerCreds();
  if (!creds.active || !creds.login || !creds.password) {
    return ctx.reply(
      'Кабинет брокера пока не настроен — администрация сначала задаст логин и пароль в панели.\n' +
      'Если вы подали заявку через приложение, ожидайте контакта.'
    );
  }
  setFlow(ctx.from.id, { type: 'blogin' });
  return ctx.reply(
    '🤝 <b>Вход в кабинет брокера</b>\n\nВведите логин, который выдала администрация. /cancel — отмена',
    { parse_mode: 'HTML' }
  );
}

async function brokerOrdersMenu(ctx, edit = true) {
  const login = brokerCtx(ctx);
  if (!login) return brokerAuthStart(ctx);
  const all = store.activeOrders().sort((a, b) => b.createdAt - a.createdAt);
  const mine = all.filter((o) => o.broker === login);
  const free = all.filter((o) => !o.broker && o.status === 'new');
  const kb = new InlineKeyboard();
  for (const o of mine) {
    kb.text(`#${o.id} · ${o.currency} · ${fmtRub(o.rub)} · моя`, `b:o:${o.id}`).row();
  }
  for (const o of free.slice(0, 8 - mine.length)) {
    kb.text(`#${o.id} · ${o.currency} · ${fmtRub(o.rub)} · взять`, `b:o:${o.id}`).row();
  }
  kb.text('🔄 Обновить', 'b:orders').text(' Кабинет', 'b:home');
  const text = mine.length + free.length
    ? '📥 <b>Заявки</b> — откройте, чтобы взять в работу:'
    : '📥 Свободных заявок нет. Новые приходят сюда мгновенно и в личных уведомлениях.';
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) return ctx.editMessageText(text, opts).catch(() => {});
  return ctx.reply(text, opts);
}

function brokerOrderText(o, login) {
  const est = brokerEarnEstimate(o);
  return (
    `📥 <b>Заявка #${o.id}</b>\n` +
    `💵 Сумма: <b>${fmtRub(o.rub)}</b> · 🪙 ${o.currency} ≈ ${fmtCrypto(o.crypto, o.currency)}\n` +
    `👛 Кошелёк клиента: <code>${esc(o.wallet)}</code>\n` +
    (o.requisites ? `🏦 Реквизиты: ${esc(o.requisites)}\n` : '') +
    (o.payRub ? `💰 К оплате: <b>${fmtRub(o.payRub)}</b>\n` : '') +
    (o.receipt ? `🧾 Чек: ✅ ${esc(o.receipt.name)} (${fmtSize(o.receipt.size)})\n` : '') +
    `🕒 ${fmtDate(o.createdAt)}\n` +
    `Статус: ${STATUS_LABEL[o.status] || o.status}\n` +
    (o.broker === login ? `\n📈 Ваш доход по сделке: ≈ <b>${fmtRub(est.rub)}</b> (${fmtBtc(est.btc)})` : '')
  );
}

// Оценка дохода брокера по заявке: спред за вычетом расходов площадки на его долю.
function brokerEarnEstimate(o) {
  const s = store.get().settings;
  const official = Number(o.officialRate) || (o.rate / (1 + (Number(s.feePercent) || 0) / 100));
  const payRub = Number(o.payRub) || Number(o.rub) || 0;
  const gross = Math.max(0, Math.round(payRub - (Number(o.crypto) || 0) * official));
  const ops = Math.min(gross, Math.max(0, Number(s.opsExpensesRub) || 0));
  const sharePct = Math.min(100, Math.max(0, Number(s.brokerSharePercent) ?? 70));
  const rub = Math.round((gross - ops) * sharePct / 100);
  const rateBTC = Number(s.baseRateBTC) || Number(s.rateBTC) || o.rate || 1;
  return { rub, btc: Math.round((rub / rateBTC) * 1e8) / 1e8, gross, ops };
}

function brokerOrderKb(o, login) {
  const kb = new InlineKeyboard();
  if (o.status === 'new') {
    if (o.broker === login) {
      kb.text('💳 Выдать реквизиты', `b:o:${o.id}:req`).text('↩️ Отказаться', `b:o:${o.id}:release`);
    } else if (!o.broker) {
      kb.text('🙋 Взять заявку', `b:o:${o.id}:take`);
    } else {
      kb.text(`В работе у другого брокера`, `b:noop`);
    }
  } else if (o.broker === login && o.status === 'details') {
    kb.text('✅ Оплата получена', `b:o:${o.id}:confirm`)
      .row()
      .text('✏️ Изменить сумму', `b:o:${o.id}:amt`)
      .text('❌ Оплата не поступила', `b:o:${o.id}:unpaid`);
    if (o.receipt) kb.row().text('🧾 Получить чек', `b:o:${o.id}:receipt`);
  } else if (o.broker === login && o.status === 'paid') {
    kb.text('✅ Подтвердить и завершить', `b:o:${o.id}:confirm`)
      .row()
      .text('❌ Оплата не поступила', `b:o:${o.id}:unpaid`);
    if (o.receipt) kb.row().text('🧾 Получить чек', `b:o:${o.id}:receipt`);
  }
  kb.row().text(' К заявкам', 'b:orders');
  return kb;
}

async function brokerBalanceMenu(ctx, edit = true) {
  const login = brokerCtx(ctx);
  if (!login) return brokerAuthStart(ctx);
  const ledger = store.brokerLedgerFor(login).slice(-8).reverse();
  const s = store.get().settings;
  const rateBTC = Number(s.baseRateBTC) || Number(s.rateBTC) || 1;
  const lines = ledger.map((e) => {
    const o = store.getOrder(e.orderId);
    return `· #${e.orderId} ${o ? fmtRub(o.rub) : ''} → <b>+${fmtBtc(e.btc)}</b> (спред ${fmtRub(e.spread || 0)}, расходы ${fmtRub(e.ops || 0)})`;
  });
  const pays = store.payoutsByLogin(login).slice(0, 3).map((p) =>
    `· ${fmtBtc(p.btc)} ${p.kind === 'deposit' ? '(возврат депозита) ' : ''}— ${p.status === 'pending' ? '⏳ в работе' : p.status === 'paid' ? '✅ выплачено' : '❌ отклонено'}`
  );
  const text =
    `💰 <b>Баланс</b>\n\n` +
    `💼 Доступно: <b>${fmtBtc(store.brokerAvailableBtc(login))}</b> (≈ ${fmtRub(store.brokerAvailableBtc(login) * rateBTC)})\n` +
    `📈 Заработано всего: <b>${fmtBtc(store.brokerEarnedBtc(login))}</b>\n\n` +
    (lines.length ? `Последние начисления:\n${lines.join('\n')}\n\n` : 'Начислений пока нет — возьмите первую заявку в разделе «Заявки».\n\n') +
    (pays.length ? `Выплаты:\n${pays.join('\n')}` : '');
  const kb = new InlineKeyboard().text('💸 Вывести', 'b:withdraw').text(' Кабинет', 'b:home');
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) return ctx.editMessageText(text, opts).catch(() => {});
  return ctx.reply(text, opts);
}

async function brokerDepositMenu(ctx, edit = true) {
  const login = brokerCtx(ctx);
  if (!login) return brokerAuthStart(ctx);
  const s = store.get().settings;
  const p = store.brokerProfile(login);
  const intern = store.brokerIsIntern(login);
  const refund = store.brokerDepositRefundable(login);
  const pend = (!p || !p.depositBtc) && store.brokerDepositsByStatus('pending').find((x) => x.login === login);
  // Для заявки в работе показываем зафиксированные в ней суммы, для новой — текущие настройки.
  const sumBtc = pend ? pend.btc : s.brokerDepositBtc;
  const feeBtc = pend ? pend.feeBtc : store.brokerDepositFeeFor(s.brokerDepositBtc);
  const totalBtc = pend ? pend.totalBtc : store.brokerDepositTotalBtc(s.brokerDepositBtc);
  let text =
    `🏦 <b>Возвратный депозит $${s.brokerDepositUsd}</b> · ${fmtBtc(sumBtc)}\n` +
    (feeBtc > 0
      ? `⚙️ Сбор за подключение: <b>${fmtBtc(feeBtc)}</b> ` +
        `(${pend ? pend.feePercent : s.brokerDepositFeePercent}% от депозита, не больше ${fmtBtc(pend ? pend.feeMaxBtc : s.brokerDepositFeeMaxBtc)})\n` +
        `📤 К переводу всего: <b>${fmtBtc(totalBtc)}</b> — одним платежом, сбор уже включён\n\n` +
        `Возвращается <b>${fmtBtc(sumBtc)}</b> — сумма депозита. Сбор разовый и не возвращается: он идёт на подключение и проверку.\n\n`
      : `📤 К переводу: <b>${fmtBtc(totalBtc)}</b>\n\n`);
  const kb = new InlineKeyboard();
  if (!p || !p.depositBtc) {
    text +=
      'Депозит — вклад в репутацию: на стажировке он страхует клиентов, пока вы торгуете малыми суммами. ' +
      `Через ${s.internDays} дней стажировки его можно забрать полностью.\n\n`;
    if (pend) {
      text += '⏳ Ваша заявка на депозит в работе у администрации.';
    } else {
      text += 'После перевода нажмите «Я внёс депозит» — администрация подтвердит зачисление.';
      kb.text('✅ Я внёс депозит', 'b:dep:made');
    }
  } else if (refund.ok) {
    text += `Стажировка завершена! Депозит <b>${fmtBtc(refund.btc)}</b> можно забрать.`;
    kb.text('💸 Забрать депозит', 'b:dep:refund');
  } else if (refund.reason === 'intern') {
    text += `Зачислен ${fmtBtc(p.depositBtc)} · ${fmtDate(p.depositAt)}.\nВернётся через ~${refund.left} дн. после стажировки.`;
  } else if (refund.reason === 'dup') {
    text += `Возврат депозита ${refund.status === 'pending' ? '⏳ уже в работе' : 'уже выполнен'}.`;
  }
  if (s.brokerDepositAddress && (!p || !p.depositBtc) && !pend) {
    text += `\n\nАдрес для депозита:\n<code>${esc(s.brokerDepositAddress)}</code>`;
  }
  kb.row().text(' Кабинет', 'b:home');
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) return ctx.editMessageText(text, opts).catch(() => {});
  return ctx.reply(text, opts);
}

async function notifyAdminsBrokerDeposit(dep) {
  const s = store.get().settings;
  const p = store.brokerProfile(dep.login);
  const kb = new InlineKeyboard()
    .text('✅ Подтвердить зачисление', `bd:${dep.id}:ok`)
    .text('❌ Отклонить', `bd:${dep.id}:no`);
  await broadcast(
    `🏦 <b>Депозит стажёра #${dep.id}</b>\n` +
    `🤝 Брокер: <code>${esc(dep.login)}</code>${p?.name ? ' · ' + esc(p.name) : ''} · <code>${esc(dep.tgId)}</code>\n` +
    `💰 Депозит: <b>${fmtBtc(dep.btc)}</b> (возвратный, $${s.brokerDepositUsd})\n` +
    (dep.feeBtc > 0
      ? `⚙️ Сбор за подключение: <b>${fmtBtc(dep.feeBtc)}</b> (${dep.feePercent}% от депозита, лимит ${fmtBtc(dep.feeMaxBtc)}) — не возвращается\n` +
        `📤 К зачислению всего: <b>${fmtBtc(dep.totalBtc)}</b>. Брокеру зачисляется депозит ${fmtBtc(dep.btc)}, сбор остаётся у площадки.\n`
      : '') +
    `🕒 ${fmtDate(dep.createdAt)}\n\n` +
    `Проверьте поступление на адрес${s.brokerDepositAddress ? ` <code>${esc(s.brokerDepositAddress)}</code>` : ''} и подтвердите.`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

async function notifyAdminsPayout(payout) {
  const kind = payout.kind === 'deposit' ? '💰 Возврат депозита' : '💸 Выплата брокеру';
  const kb = new InlineKeyboard()
    .text('✅ Выплачено', `bp:${payout.id}:paid`)
    .text('❌ Отклонить', `bp:${payout.id}:no`);
  await broadcast(
    `${kind} <b>#${payout.id}</b>\n` +
    `🤝 Брокер: <code>${esc(payout.login)}</code>\n` +
    `🪙 Сумма: <b>${fmtBtc(payout.btc)}</b>\n` +
    `🏦 Адрес: <code>${esc(payout.address)}</code>\n` +
    `🕒 ${fmtDate(payout.createdAt)}`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

async function notifyBrokersNewOrder(o) {
  const s = store.get().settings;
  const est = brokerEarnEstimate(o);
  const creds = store.brokerCreds();
  if (!creds.active) return;
  const intern = Number(o.rub) <= (Number(s.internMaxRub) || 5000);
  await Promise.all(store.allBrokerSessions().map(async ({ tgId, login }) => {
    const can = store.brokerCanTake(login, o.rub);
    if (!can.ok && can.reason === 'limit') return; // не спамим стажёров крупными заявками
    if (!can.ok && can.reason === 'deposit') return;
    try {
      await bot.api.sendMessage(tgId,
        `🔔 <b>Новая заявка #${o.id}</b>${intern ? ' · подходит стажёру' : ''}\n` +
        `💵 ${fmtRub(o.rub)} · 🪙 ${o.currency} ≈ ${fmtCrypto(o.crypto, o.currency)}\n` +
        `📈 Доход: ≈ <b>${fmtRub(est.rub)}</b> (${fmtBtc(est.btc)})`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🙋 Взять', `b:o:${o.id}:take`).text('📥 Заявки', 'b:orders') });
    } catch (e) { console.error(`[bot] broker ${tgId}:`, e.message); }
  }));
}

async function notifyBrokerPaid(o) {
  if (!o.broker) return;
  await Promise.all(store.brokerSessionsByLogin(o.broker).map(async (tgId) => {
    try {
      await bot.api.sendMessage(tgId,
        `⏳ <b>Заявка #${o.id}: клиент нажал «Я оплатил»</b>.\n` +
        `Проверьте поступление ${fmtRub(o.payRub || o.rub)}${o.receipt ? ' — чек прикреплён' : ''} и подтвердите завершение.`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard()
          .text('✅ Подтвердить', `b:o:${o.id}:confirm`)
          .text('❌ Не поступила', `b:o:${o.id}:unpaid`) });
    } catch (e) { console.error(`[bot] broker ${tgId}:`, e.message); }
  }));
}

/* ---------- чат брокера (собеседование, депозит, клиенты) ---------- */

// Сообщения поддержки несут поле broker: когда у логина есть свои персональные
// сообщения (собеседование, статус депозита), брокер видит их — иначе общую ветку
// «клиент ↔ площадка» по тому же пользовательскому диалогу.
function brokerSupportThreadView(ctx, login, edit = true) {
  const userId = String(ctx.from.id);
  const personal = store.getSupportMessages(userId).filter((m) => m.broker === String(login));
  const src = personal.length ? personal : store.getSupportMessages(userId).filter((m) => m.broker);
  const lens = src.length ? src : store.getSupportMessages(userId);
  let body = `💬 <b>Чат с PRICELEX</b> · <code>${esc(login)}\n\n`;
  if (!lens.length) {
    body += 'Сообщений нет.';
  } else {
    for (const m of lens.slice(-15)) {
      const who = m.from === 'user' ? `🧑💼 <b>${esc(login)}</b>` : '🛡️ PRICELEX';
      body += `${who} · ${fmtDate(m.at)}:\n${esc(m.text)}\n\n`;
    }
  }
  const kb = new InlineKeyboard()
    .text('✍️ Ответить', 'b:chat:reply')
    .text('🔄 Обновить', 'b:chat')
    .row()
    .text(' Кабинет', 'b:home');
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) return ctx.editMessageText(body, opts).catch(() => {});
  return ctx.reply(body, opts);
}

// Первый шаг кабинета: собеседование в чате → реквизиты на депозит → заявки в
// рамках суммы депозита → площадка закрывает часть депозита по мере доверия.
function brokerInvestMessage(login) {
  const s = store.get().settings;
  const feeBtc = store.brokerDepositFeeFor(s.brokerDepositBtc);
  const total = store.brokerDepositTotalBtc(s.brokerDepositBtc);
  const addr = s.brokerDepositAddress ? `\n\nАдрес для депозита:\n<code>${esc(s.brokerDepositAddress)}</code>` : '';
  const kb = new InlineKeyboard().text('💬 Чат', 'b:chat').text(' Кабинет', 'b:home');
  return {
    kb,
    text:
      `🎓 <b>Начните с собеседования</b>\n\n` +
      `Чтобы начать торговать, сначала напишите о себе в чате — опыт, направления, объёмы. ` +
      `Администрация выдаст реквизиты на возвратный депозит <b>$${s.brokerDepositUsd}</b> (${fmtBtc(s.brokerDepositBtc)})` +
      `${feeBtc > 0 ? ` плюс разовый сбор ${fmtBtc(feeBtc)} — итого к переводу ${fmtBtc(total)}` : ''}.\n\n` +
      `Как только депозит подтвердится — получите заявки клиентов в рамках суммы этого депозита, а когда накопится доверие, площадка будет закрывать часть депозита за вас.` +
      addr,
  };
}

/* ---------- текстовые сценарии брокера ---------- */

async function requisitesPromptBroker(ctx, o) {
  setFlow(ctx.from.id, { type: 'breq', orderId: o.id, version: o.version || 0, payRub: o.rub });
  return ctx.reply(
    `💳 Заявка #${o.id}. Отправьте одним сообщением реквизиты (карта / СБП / счёт, банк и получатель).\n\n` +
    `Они СРАЗУ появятся у клиента с суммой ${fmtRub(o.rub)}.\n/cancel — отмена`,
  );
}

async function handleBrokerText(ctx) {
  const f = getFlow(ctx.from.id);
  const text = ctx.message.text.trim();
  if (!f) return brokerHome(ctx, false);
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^отмена$/i.test(text)) {
    flows.delete(ctx.from.id);
    return brokerHome(ctx, false);
  }
  if (f.type === 'blogin') {
    const creds = store.brokerCreds();
    const isMaster = creds.active && text === creds.login;
    const isAdminBrk = creds.active && store.isAdminBroker && store.isAdminBroker(text);
    if (!isMaster && !isAdminBrk) return ctx.reply('Логин не подходит. Проверьте и отправьте ещё раз. /cancel — отмена');
    setFlow(ctx.from.id, { type: 'bpass', login: text });
    return ctx.reply('Теперь пароль:');
  }
  if (f.type === 'bpass') {
    const creds = store.brokerCreds();
    await ctx.deleteMessage().catch(() => {}); // пароль не светим в чате
    if (!creds.active || text !== creds.password) return ctx.reply('Пароль не подходит. Попробуйте ещё раз — или /cancel');
    flows.delete(ctx.from.id);
    const login = f.login || creds.login;
    store.setBrokerSession(ctx.from.id, login);
    store.upsertBrokerProfile(login, {
      name: ctx.from.first_name || '',
      username: ctx.from.username || null,
    });
    await ctx.reply(`✅ Вход выполнен: <code>${esc(login)}</code>`, { parse_mode: 'HTML' });
    return brokerHome(ctx, false);
  }
  // Собеседование / депозит / работа с клиентом идут одним чатом с площадкой.
  if (f.type === 'bchat') {
    const login = brokerCtx(ctx);
    if (!login) { flows.delete(ctx.from.id); return brokerAuthStart(ctx); }
    if (!text || text.length > 2000) {
      return ctx.reply('Сообщение должно содержать от 1 до 2000 символов.');
    }
    const msg = store.createSupportMessage(ctx.from.id, 'user', text, login);
    await bus.emit('support_message', { message: msg, user: ctx.from });
    return brokerSupportThreadView(ctx, login, false);
  }
  // ниже нужна сессия
  const login = brokerCtx(ctx);
  if (!login) { flows.delete(ctx.from.id); return brokerAuthStart(ctx); }
  if (f.type === 'breq') {
    const o = store.getOrder(f.orderId);
    if (!o || o.status !== 'new' || o.broker !== login || (o.version || 0) !== f.version) {
      flows.delete(ctx.from.id);
      return ctx.reply('Заявка уже изменилась. Откройте её заново через список заявок.');
    }
    if (!text || text.length > 900) return ctx.reply('Реквизиты должны содержать от 1 до 900 символов. Отправьте целиком ещё раз.');
    flows.delete(ctx.from.id);
    const upd = store.updateOrder(o.id, { requisites: text, payRub: f.payRub, status: 'details' });
    await Promise.all([sendOrUpdateOrderAdmin(upd), notifyClient(upd)]);
    await ctx.reply(`✅ Реквизиты заявки #${o.id} опубликованы. К оплате: ${fmtRub(upd.payRub)}. После оплаты подтвердите в один тап.`);
    return brokerOrdersMenu(ctx, false);
  }
  if (f.type === 'bamt') {
    const o = store.getOrder(f.orderId);
    if (!o || o.status !== 'details' || o.broker !== login || (o.version || 0) !== f.version) {
      flows.delete(ctx.from.id);
      return ctx.reply('Заявка уже изменилась. Откройте её заново.');
    }
    const pay = /^(так|так же|same|=|\.)$/i.test(text) ? o.rub : parseNum(text);
    if (!Number.isFinite(pay) || pay <= 0) return ctx.reply('Не понял сумму. Пришлите число в рублях или «так же».');
    flows.delete(ctx.from.id);
    const upd = store.updateOrder(o.id, { payRub: pay });
    await Promise.all([sendOrUpdateOrderAdmin(upd), notifyClient(upd)]);
    return ctx.reply(`✅ Сумма заявки #${o.id} обновлена: ${fmtRub(pay)}.`);
  }
  if (f.type === 'bwithdraw' || f.type === 'brefund') {
    const isRefund = f.type === 'brefund';
    const avail = isRefund
      ? (store.brokerDepositRefundable(login).btc || 0)
      : store.brokerAvailableBtc(login);
    if (avail <= 0) { flows.delete(ctx.from.id); return brokerHome(ctx, false); }
    if (!/^[a-zA-Z0-9]{26,64}$/.test(text) && !/^(bc1|ltc1|[13])[a-zA-Z0-9]{24,90}$/i.test(text)) {
      return ctx.reply('Пришлите корректный BTC-адрес одной строкой (26–90 символов). /cancel — отмена');
    }
    flows.delete(ctx.from.id);
    const payout = store.createPayout({
      login, btc: avail, address: text,
      kind: isRefund ? 'deposit' : 'earning',
    });
    if (isRefund) store.upsertBrokerProfile(login, {}); // профиль на месте
    await notifyAdminsPayout(payout);
    await ctx.reply(
      `✅ ${isRefund ? 'Запрос на возврат депозита' : 'Заявка на выплату'} <b>#${payout.id}</b> отправлена администрации.\n` +
      `🪙 ${fmtBtc(payout.btc)} → <code>${esc(text)}</code>\nПодтверждение обычно занимает до суток.`,
      { parse_mode: 'HTML' }
    );
    return brokerHome(ctx, false);
  }
  flows.delete(ctx.from.id);
  return brokerHome(ctx, false);
}

/* ---------- колбэки b: (брокер), bd:/bp: (админы по брокерам) ---------- */

async function handleBrokerCallback(ctx, d) {
  await ctx.answerCallbackQuery().catch(() => {});
  const login = brokerCtx(ctx);
  if (!login) {
    await ctx.answerCallbackQuery({ text: 'Сессия истекла — войдите заново: /broker' }).catch(() => {});
    return;
  }
  const prevFlow = getFlow(ctx.from.id);
  flows.delete(ctx.from.id);

  if (d === 'b:noop') return;
  if (d === 'b:home') return brokerHome(ctx, true);
  if (d === 'b:chat') return brokerChatOpen(ctx, true);
  if (d === 'b:chat:reply') {
    setFlow(ctx.from.id, { type: 'bchat' });
    return ctx.reply('✍️ <b>Сообщение для площадки</b>\\nНапишите текст — он сразу появится в вашем чате с PRICELEX. /cancel — отмена', { parse_mode: 'HTML' });
  }
  if (d === 'b:orders') return brokerOrdersMenu(ctx, true);
  if (d === 'b:bal') return brokerBalanceMenu(ctx, true);
  if (d === 'b:deposit') return brokerDepositMenu(ctx, true);
  if (d === 'b:logout') {
    store.dropBrokerSession(ctx.from.id);
    return ctx.editMessageText('Вы вышли из кабинета брокера. Снова войти: /broker').catch(() => {});
  }
  if (d === 'b:withdraw') {
    const s = store.get().settings;
    const avail = store.brokerAvailableBtc(login);
    const min = Number(s.brokerMinPayoutBtc) || 0.0002;
    if (avail < min) {
      return ctx.reply(`Для вывода нужно минимум ${fmtBtc(min)} — сейчас доступно ${fmtBtc(avail)}. Завершите ещё сделку.`);
    }
    setFlow(ctx.from.id, { type: 'bwithdraw' });
    return ctx.reply(`💸 Вывод <b>${fmtBtc(avail)}</b> (весь доступный остаток).\nПришлите BTC-адрес для выплаты. /cancel — отмена`, { parse_mode: 'HTML' });
  }
  if (d === 'b:dep:made') {
    const s = store.get().settings;
    const p = store.brokerProfile(login);
    if (p && p.depositBtc) return ctx.reply('Депозит уже зачислен.');
    if (store.brokerDepositsByStatus('pending').find((x) => x.login === login)) {
      return ctx.reply('Заявка на депозит уже на проверке у администрации.');
    }
    const dep = store.createBrokerDeposit({ login, tgId: ctx.from.id, btc: s.brokerDepositBtc });
    await notifyAdminsBrokerDeposit(dep);
    return ctx.reply(
      `✅ Заявка принята.\n` +
      (dep.feeBtc > 0
        ? `📤 Переводите <b>${fmtBtc(dep.totalBtc)}</b>: депозит ${fmtBtc(dep.btc)} + сбор ${fmtBtc(dep.feeBtc)}.\n`
        : `📤 Переводите <b>${fmtBtc(dep.totalBtc)}</b>.\n`) +
      `Администрация подтвердит зачисление депозита — и лимит малых сумм заработает сразу.`,
      { parse_mode: 'HTML' }
    );
  }
  if (d === 'b:dep:refund') {
    const r = store.brokerDepositRefundable(login);
    if (!r.ok) {
      return ctx.reply(r.reason === 'intern' ? `Депозит вернётся через ~${r.left} дн. после стажировки.` : 'Возврат сейчас недоступен.');
    }
    setFlow(ctx.from.id, { type: 'brefund' });
    return ctx.reply(`💸 Возврат депозита <b>${fmtBtc(r.btc)}</b>.\nПришлите BTC-адрес. /cancel — отмена`, { parse_mode: 'HTML' });
  }
  const m = d.match(/^b:o:(\d+)(?::(\w+))?$/);
  if (!m) return;
  const o = store.getOrder(Number(m[1]));
  if (!o) return ctx.editMessageText('Заявка не найдена.', { reply_markup: new InlineKeyboard().text(' К заявкам', 'b:orders') }).catch(() => {});
  const act = m[2];
  const opts = { parse_mode: 'HTML', reply_markup: brokerOrderKb(o, login) };
  if (!act) return ctx.editMessageText(brokerOrderText(o, login), opts).catch(() => {});

  if (act === 'take') {
    if (o.status !== 'new' || o.broker) {
      return ctx.editMessageText(brokerOrderText(o, login), opts).catch(() => {});
    }
    const can = store.brokerCanTake(login, o.rub);
    if (!can.ok) {
      await ctx.reply(can.text);
      if (can.reason === 'deposit') return brokerDepositMenu(ctx, false);
      return;
    }
    const upd = store.updateOrder(o.id, { broker: login });
    await sendOrUpdateOrderAdmin(upd);
    await ctx.editMessageText(brokerOrderText(upd, login), { parse_mode: 'HTML', reply_markup: brokerOrderKb(upd, login) }).catch(() => {});
    return requisitesPromptBroker(ctx, upd);
  }
  if (o.broker !== login) {
    return ctx.editMessageText(brokerOrderText(o, login), opts).catch(() => {});
  }
  if (act === 'release' && o.status === 'new') {
    const upd = store.updateOrder(o.id, { broker: null });
    await Promise.all([sendOrUpdateOrderAdmin(upd), notifyBrokersNewOrder(upd)]);
    await ctx.editMessageText(`Заявка #${o.id} возвращена в общую ленту.`).catch(() => {});
    return brokerOrdersMenu(ctx, false);
  }
  if (act === 'req' && o.status === 'new') return requisitesPromptBroker(ctx, o);
  if (act === 'amt' && o.status === 'details') {
    setFlow(ctx.from.id, { type: 'bamt', orderId: o.id, version: o.version || 0 });
    return ctx.reply(`✏️ Заявка #${o.id}. Отправьте точную сумму к оплате в ₽ (сейчас ${fmtRub(o.payRub || o.rub)}).\n/cancel — отмена`);
  }
  if (act === 'receipt') {
    if (!o.receipt) return ctx.reply('Чек по этой заявке не прикреплён.');
    await sendReceiptTo(ctx.from.id, o);
    return;
  }
  if (act === 'unpaid' && ['details', 'paid'].includes(o.status)) {
    const upd = store.updateOrder(o.id, { status: 'rejected' });
    await sendOrUpdateOrderAdmin(upd);
    await ctx.editMessageText(`Заявка #${o.id} отмечена: оплата не поступила — сделка отклонена, средства с гарантийного счёта не списаны.`).catch(() => {});
    return brokerOrdersMenu(ctx, false);
  }
  if (act === 'confirm' && ['details', 'paid'].includes(o.status)) {
    const upd = store.updateOrder(o.id, { status: 'completed' });
    const earn = store.accrueBroker(upd); // идемпотентно: повторный тап ничего не начислит
    await sendOrUpdateOrderAdmin(upd);
    const est = earn || brokerEarnEstimate(upd);
    await ctx.editMessageText(
      `🟢 <b>Сделка #${o.id} завершена.</b>\n` +
      `📈 Начислено: <b>+${fmtRub(est.rub)}</b> = <b>${fmtBtc(est.btc)}</b>\n` +
      `(спред ${fmtRub(est.gross ?? est.spread ?? 0)} − расходы площадки ${fmtRub(est.ops || 0)})\n\n` +
      `Отправьте клиенту вручную:\n🪙 <b>${fmtCrypto(upd.crypto, upd.currency)}</b>\n👛 <code>${esc(upd.wallet)}</code>\n\n` +
      `После отправки скажите администрации txid — она добавит ссылку в заявку.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    await broadcast(
      `🟢 <b>Брокер ${esc(login)} завершил заявку #${o.id}</b> на ${fmtRub(upd.payRub || upd.rub)}.\n` +
      `Начисление: ${fmtRub(est.rub)} · удержание расходов площадки в спреде учтено.\n` +
      `Проверьте завершение в списке заявок (/menu).`,
      { parse_mode: 'HTML' }
    );
    return brokerHome(ctx, false);
  }
  return ctx.editMessageText(brokerOrderText(o, login), opts).catch(() => {});
}

/* ---------- админские карточки заявок/депозитов/выплат брокеров ---------- */

async function handleBrokerAdminCallback(ctx, d) {
  // d: bd:<id>:ok|no (депозит), bp:<id>:paid|no (выплата)
  if (d.startsWith('bd:')) {
    const [, id, act] = d.split(':');
    const dep = store.getBrokerDeposit(Number(id));
    if (!dep) return ctx.answerCallbackQuery({ text: 'Заявка не найдена' }).catch(() => {});
    if (dep.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Уже обработано' }).catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});
    const upd = store.updateBrokerDeposit(dep.id, { status: act === 'ok' ? 'confirmed' : 'declined' });
    if (act === 'ok') {
      const s = store.get().settings;
      const internUntil = Date.now() + (Number(s.internDays) || 7) * 86400000;
      const p = store.brokerProfile(dep.login);
      store.upsertBrokerProfile(dep.login, {
        depositBtc: dep.btc,
        depositAt: Date.now(),
        internUntil: (p && p.internUntil) || internUntil,
      });
    }
    const p = store.brokerProfile(dep.login);
    await ctx.editMessageText(
      `🏦 <b>Депозит #${dep.id}</b> · ${act === 'ok' ? '✅ зачислен' : '❌ отклонён'}\n` +
      `🤝 <code>${esc(dep.login)}</code> · ${fmtBtc(dep.btc)}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    await Promise.all(store.brokerSessionsByLogin(dep.login).map(async (tgId) => {
      try {
        await bot.api.sendMessage(tgId, act === 'ok'
          ? `✅ Депозит ${fmtBtc(dep.btc)} подтверждён! Стажировка ${store.get().settings.internDays} дней пошла — доступны заявки до ${fmtRub(store.get().settings.internMaxRub)}. Удачных сделок!`
          : `❌ Депозит не подтверждён. Если перевод точно был — напишите администрации.`);
      } catch {}
    }));
    return;
  }
  if (d.startsWith('bp:')) {
    const [, id, act] = d.split(':');
    const payout = store.getPayout(Number(id));
    if (!payout) return ctx.answerCallbackQuery({ text: 'Выплата не найдена' }).catch(() => {});
    if (payout.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Уже обработано' }).catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});
    store.updatePayout(payout.id, { status: act === 'paid' ? 'paid' : 'declined' });
    if (payout.kind === 'deposit' && act === 'paid') {
      const p = store.brokerProfile(payout.login);
      if (p) store.upsertBrokerProfile(payout.login, { depositBtc: 0, depositAt: 0 });
    }
    await ctx.editMessageText(
      `💸 <b>Выплата #${payout.id}</b> · ${act === 'paid' ? '✅ исполнена' : '❌ отклонена (сумма возвращена на баланс брокера)'}\n` +
      `🤝 <code>${esc(payout.login)}</code> · ${fmtBtc(payout.btc)} → <code>${esc(payout.address)}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    await Promise.all(store.brokerSessionsByLogin(payout.login).map(async (tgId) => {
      try {
        await bot.api.sendMessage(tgId, act === 'paid'
          ? `💸 Выплата #${payout.id} исполнена: ${fmtBtc(payout.btc)} → ${payout.address}`
          : `❌ Выплата #${payout.id} отклонена — сумма ${fmtBtc(payout.btc)} снова на вашем балансе.`);
      } catch {}
    }));
    return;
  }
}

async function onBrokerEvent({ app }) {
  const kb = new InlineKeyboard()
    .text('✅ Одобрить', `bb:${app.id}:ok`)
    .text('❌ Отклонить', `bb:${app.id}:no`);
  await broadcast(
    `🤝 <b>Заявка «стать брокером» #${app.id}</b>\n` +
    `👤 ${esc(app.name)}${app.username ? ' (@' + esc(app.username) + ')' : ''} · <code>${esc(app.userId)}</code>\n` +
    `📇 Контакт: ${esc(app.contact)}\n` +
    `🎓 Опыт: ${esc(app.experience)}\n` +
    `🕒 ${fmtDate(app.createdAt)}`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

/* ---------- меню брокеров и выплат (админ) ---------- */

function brokersMenuKb(s) {
  const kb = new InlineKeyboard()
    .text(s.brokerLogin ? `🔑 Логин: ${s.brokerLogin}` : '🔑 Задать логин', 'sb:blog')
    .text('🔒 Пароль', 'sb:bpass')
    .row()
    .text(`📊 Доля брокера ${s.brokerSharePercent}%`, 'sb:bshare')
    .text(`🧾 Расходы ${fmtRub(s.opsExpensesRub)}`, 'sb:bops')
    .row()
    .text(`💸 Мин. выплата ${fmtBtc(s.brokerMinPayoutBtc)}`, 'sb:bminp')
    .text(s.brokerActive ? '🟢 Вход ON' : '🔴 Вход OFF', 'sb:active')
    .row()
    .text(`🏦 Депозит $${s.brokerDepositUsd} · ${fmtBtc(s.brokerDepositBtc)}`, 'sb:bdepbtc')
    .text(`💵 Депозит в $`, 'sb:bdepusd')
    .row()
    .text(`🛡 Общий депозит клиентам ${fmtBtcNum(s.guaranteeFundBtc)}`, 'sb:gfund')
    .row()
    .text(`⚙️ Сбор ${s.brokerDepositFeePercent}% · макс ${fmtBtcNum(s.brokerDepositFeeMaxBtc)}`, 'sb:bdepfee')
    .text('⚙️ Предел сбора', 'sb:bdepfeemax')
    .row()
    .text('🏦 Адрес приёма депозитов', 'sb:bdepa')
    .row()
    .text(`🎓 Лимит стажёра ${fmtRub(s.internMaxRub)}`, 'sb:binmax')
    .text(`📆 Стажировка ${s.internDays} дн.`, 'sb:bindays')
    .row()
    .text('↩️ Назад', 'm:home');
  return kb;
}

async function brokersMenu(ctx, edit = true) {
  const s = store.get().settings;
  const apps = store.brokerAppsByStatus('pending');
  const adminBrokers = (store.getAdminBrokers ? store.getAdminBrokers() : [])
    .map((b) => `• <b>${esc(b.name || b.login)}</b> 🟢 онлайн`).join('\n');
  const text =
    `🤝 <b>Брокеры</b>\n\n` +
    `🔑 Логин: <code>${esc(s.brokerLogin || '— не задан —')}</code> · Пароль: ${s.brokerPassword ? '••••••' : '— не задан —'} · ${s.brokerActive ? '🟢 вход открыт' : '🔴 вход закрыт'}\n` +
    `📊 Деление спреда: брокеру <b>${s.brokerSharePercent}%</b> · площадке ${100 - s.brokerSharePercent}%, расходы ${fmtRub(s.opsExpensesRub)}/сделка\n` +
    `💸 Выплаты от ${fmtBtc(s.brokerMinPayoutBtc)} · 🏦 депозит $${s.brokerDepositUsd} (${fmtBtc(s.brokerDepositBtc)})\n` +
    `⚙️ Сбор за подключение ${s.brokerDepositFeePercent}% (не больше ${fmtBtc(s.brokerDepositFeeMaxBtc)}) → к переводу <b>${fmtBtc(store.brokerDepositTotalBtc(s.brokerDepositBtc))}</b> ` +
    `${s.brokerDepositAddress ? `→ <code>${esc(s.brokerDepositAddress)}</code>` : '(адрес не задан!)'}\n` +
    `🛡 Общий депозит брокеров (виден клиентам): <b>${fmtBtc(s.guaranteeFundBtc)}</b>\n` +
    `🎓 Стажировка: ${s.internDays} дн., заявки до ${fmtRub(s.internMaxRub)}\n\n` +
    (adminBrokers ? `👥 <b>Брокеры под управлением админа (5):</b>\n${adminBrokers}\n\n` : '') +
    (apps.length ? `📥 Заявок «стать брокером» ожидает: <b>${apps.length}</b>\n` : 'Новых заявок «стать брокером» нет.\n') +
    (store.allBrokerSessions().length ? `🔐 Сессий брокеров сейчас: ${store.allBrokerSessions().length}` : '');
  const kb = brokersMenuKb(s);
  // заявки сверху меню
  for (const a of apps.slice(0, 5)) {
    kb.row().text(`📥 #${a.id} · ${a.name} · ${fmtDate(a.createdAt)}`, `bbv:${a.id}`);
  }
  kb.row().text('↩️ Назад', 'm:home');
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else await ctx.reply(text, opts);
}

async function payoutsMenu(ctx, edit = true) {
  const s = store.get().settings;
  const pays = store.payoutsByStatus('pending');
  const deps = store.brokerDepositsByStatus('pending');
  const kb = new InlineKeyboard();
  const lines = [];
  for (const p of pays.slice(0, 6)) {
    lines.push(`💸 #${p.id} · ${esc(p.login)} · ${fmtBtc(p.btc)}${p.kind === 'deposit' ? ' (возврат депозита)' : ''}`);
    kb.text(`Выплачено #${p.id}`, `bp:${p.id}:paid`).text(`Отклонить`, `bp:${p.id}:no`).row();
  }
  for (const d of deps.slice(0, 4)) {
    lines.push(`🏦 #${d.id} · ${esc(d.login)} · ${fmtBtc(d.btc)} (депозит стажёра)`);
    kb.text(`Зачислить #${d.id}`, `bd:${d.id}:ok`).text(`Отклонить`, `bd:${d.id}:no`).row();
  }
  kb.text('🔄 Обновить', 'm:payouts').text('↩️ Назад', 'm:home');
  const text =
    `💸 <b>Выплаты и депозиты брокеров</b>\n\n` +
    (lines.length ? lines.join('\n') : 'Очередь пуста — новые запросы появятся здесь автоматически.') +
    `\n\nМин. выплата: ${fmtBtc(s.brokerMinPayoutBtc)}`;
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else await ctx.reply(text, opts);
}

async function brokerAppView(ctx, id, edit = true) {
  const a = store.getBrokerApp(Number(id));
  if (!a) return ctx.answerCallbackQuery({ text: 'Заявка не найдена' }).catch(() => {});
  const kb = a.status === 'pending'
    ? new InlineKeyboard().text('✅ Одобрить', `bb:${a.id}:ok`).text('❌ Отклонить', `bb:${a.id}:no`).row().text(' К брокерам', 'm:brokers')
    : new InlineKeyboard().text(' К брокерам', 'm:brokers');
  const text =
    `🤝 <b>Заявка «стать брокером» #${a.id}</b>\n` +
    `👤 ${esc(a.name)}${a.username ? ' (@' + esc(a.username) + ')' : ''} · <code>${esc(a.userId)}</code>\n` +
    `📇 Контакт: ${esc(a.contact)}\n` +
    `🎓 Опыт: ${esc(a.experience)}\n` +
    `🕒 ${fmtDate(a.createdAt)} · Статус: <b>${a.status === 'pending' ? '⏳ ожидает' : a.status === 'approved' ? '✅ одобрена' : '❌ отклонена'}</b>`;
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else await ctx.reply(text, opts);
}

/* ---------- регистрация обработчиков ---------- */

function register() {
  bot.command('admins', (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    return adminsMenu(ctx);
  });
  bot.command('reviews', (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    return reviewsMenu(ctx, false);
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
        return ctx.reply('🌌 PRICELEX — агентство криптоброкеров. Проверенная и быстрая команда профессионалов: BTC и GRAM.', {
          reply_markup: new InlineKeyboard().webApp('Открыть PRICELEX', url),
        });
      }
      return ctx.reply('🌌 PRICELEX — агентство криптоброкеров. Приложение откроется кнопкой меню, как только будет готово.');
    }
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });
  // Кабинет брокера доступен любому пользователю: вход по логину/паролю из админки.
  bot.command('broker', async (ctx) => {
    if (isAdmin(ctx)) {
      // админу брокерский контур не нужен, но дадим подсказку
      return ctx.reply('Вы оператор. Брокерская панель — /broker действует для вошедших брокеров; управление брокерами — в меню «Брокеры».');
    }
    flows.delete(ctx.from.id);
    if (brokerCtx(ctx)) return brokerHome(ctx, false);
    return brokerAuthStart(ctx);
  });
  bot.command('menu', async (ctx) => {
    if (!isAdmin(ctx)) {
      // для брокера /menu тоже открывает кабинет
      if (brokerCtx(ctx)) return brokerHome(ctx, false);
      return;
    }
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });

  bot.on('callback_query:data', async (ctx) => {
    const d0 = ctx.callbackQuery.data;
    // Брокерские колбэки — до админского фильтра: это отдельный контур по логину/паролю.
    if (d0.startsWith('b:')) return handleBrokerCallback(ctx, d0);
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔️' });
    const d = d0;
    await ctx.answerCallbackQuery().catch(() => {});
    if (!isAdmin(ctx)) return;
    const prevFlow = getFlow(ctx.from.id);
    flows.delete(ctx.from.id);

    // Админские карточки брокеров: депозиты, выплаты, заявки «стать брокером».
    if (d.startsWith('bd:') || d.startsWith('bp:')) return handleBrokerAdminCallback(ctx, d);
    // Чат брокера: bchat:<userId>:<login> — открыть, bchre:<userId>:<login> — ответить.
    if (d.startsWith('bchat:')) {
      const [, userId, login] = d.split(':');
      return brokerChatAdminView(ctx, userId, login);
    }
    if (d.startsWith('bchre:')) {
      const [, userId, login] = d.split(':');
      setFlow(ctx.from.id, { type: 'achreply', userId, broker: login });
      return ctx.reply('✍️ Ответ брокеру — напишите сообщение, оно сразу появится в его чате. /cancel — отмена');
    }
    if (d.startsWith('bb:')) {
      const [, id, act] = d.split(':');
      const app0 = store.getBrokerApp(Number(id));
      if (!app0) return ctx.reply('Заявка не найдена.');
      if (app0.status !== 'pending') return ctx.reply('Заявка уже обработана.');
      const upd = store.updateBrokerApp(app0.id, { status: act === 'ok' ? 'approved' : 'rejected' });
      await ctx.editMessageText(
        `🤝 <b>Заявка брокера #${app0.id}</b> · ${act === 'ok' ? '✅ одобрена' : '❌ отклонена'}\n` +
        `👤 ${esc(app0.name)}${app0.username ? ' (@' + esc(app0.username) + ')' : ''}\n` +
        `📇 ${esc(app0.contact)}\n🎓 ${esc(app0.experience)}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      await bot.api.sendMessage(app0.userId,
        act === 'ok'
          ? `🤝 Ваша заявка «стать брокером» одобрена!\n\nВойдите в кабинет: /broker — логин и пароль выдала администрация.\nПервый шаг — возвратный депозит $20 на период стажировки: торгуете малыми суммами, через неделю депозит можно забрать.`
          : 'Ваша заявка «стать брокером» в этот раз отклонена. Доработайте описание опыта и подайте её снова в приложении.'
      ).catch(() => {});
      return;
    }

    if (d === 'm:reviews' || d.startsWith('rv')) {
      const handled = await onReviewCallback(ctx, d, prevFlow);
      if (handled !== false) return;
    }

    if (d === 'm:home') return mainMenu(ctx, true);
    if (d === 'm:orders') return ordersMenu(ctx, true);
    if (d === 'm:settings') return settingsMenu(ctx, true);
    if (d === 'm:stats') return statsMenu(ctx, true);
    if (d === 'm:admins') return adminsMenu(ctx);
    if (d === 'm:links') return linksMenu(ctx, true);
    if (d === 'm:support') return supportMenu(ctx, true);
    if (d === 'm:brokers') return brokersMenu(ctx, true);
    if (d === 'm:payouts') return payoutsMenu(ctx, true);
    if (d.startsWith('bbv:')) return brokerAppView(ctx, d.slice(4), true);

    // Настройки брокерского контура — свои кнопки s:… в меню «Настройки».
    if (d === 'sb:active') {
      store.mutate((db) => {
        db.settings.brokerActive = !db.settings.brokerActive;
      });
      return brokersMenu(ctx, true);
    }
    if (d.startsWith('sb:')) {
      const key = d.slice(3);
      if (SET_FIELDS[key]) {
        setFlow(ctx.from.id, { type: 'setb:' + key });
        await ctx.editMessageText(`✍️ Отправьте ${SET_FIELDS[key].label}.\n( /cancel — отмена )`, {
          parse_mode: 'HTML',
        }).catch(() => {});
        return;
      }
    }

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
        const { official } = await rates.refreshRates();
        await settingsMenu(ctx, true);
        const down = official.failed.length
          ? `\n⏸ Не ответили: ${official.failed.map((f) => `${f.name} (${f.error})`).join(', ')} — повторим автоматически.`
          : '';
        return ctx.reply(
          `✅ Официальный курс обновлён: ₿ ${fmtRub(official.btc)} · G ${fmtRub(official.gram)}\n` +
            `Медиана по ${official.sources.length} ист.: ${official.sources.join(', ')}\n` +
            `Курс доллара: ${fmtUsdRub(official.usdRub)} (${official.usdRubSource})\n` +
            `Курсы для клиентов пересчитаны с комиссией.${down}`,
          { reply_markup: homeKb() }
        );
      } catch (e) {
        return ctx.reply(`⚠️ Не удалось обновить курс: ${e.message}. Действуют прежние курсы.`, { reply_markup: homeKb() });
      }
    }
    if (d.startsWith('s:')) {
      const key = d.slice(2);
      if (SET_FIELDS[key]) {
        setFlow(ctx.from.id, { type: 'set:' + key });
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
        setFlow(ctx.from.id, { type: act, orderId: id, version: o.version || 0 });
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
        // Если заявку вёл брокер — начисляем ему долю спреда (идемпотентно).
        const earn = upd.broker ? store.accrueBroker(upd) : null;
        await sendOrUpdateOrderAdmin(upd);
        await ctx.reply(
          `📨 <b>Заявка #${id} завершена.</b>\nОтправьте клиенту вручную:\n🪙 <b>${fmtCrypto(upd.crypto, upd.currency)}</b>\n👛 <code>${esc(upd.wallet)}</code>` +
          (earn ? `\n\n📈 Брокеру <code>${esc(upd.broker)}</code> начислено <b>+${fmtRub(earn.rub)}</b> (${fmtBtc(earn.btc)}).` : '') +
          `\n\n💡 Теперь вы можете опционально отправить ссылку на блокчейн-транзакцию — нажмите кнопку ниже.`,
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔗 Добавить ссылку на блокчейн', `o:${id}:tx`) }
        );
        if (earn) {
          await Promise.all(store.brokerSessionsByLogin(upd.broker).map(async (tgId) => {
            try {
              await bot.api.sendMessage(tgId,
                `📈 <b>Начисление по заявке #${upd.id}</b>: +${fmtRub(earn.rub)} = ${fmtBtc(earn.btc)}.\n` +
                `Завершил оператор. Баланс: /broker → 💰.`, { parse_mode: 'HTML' });
            } catch {}
          }));
        }
        return;
      }
    }
  });

  bot.on('message:text', async (ctx) => {
    // Брокерские сценарии (blogin/bpass/breq/bamt/bwithdraw/brefund) — до админ-гейта.
    const f = getFlow(ctx.from.id);
    if (f && String(f.type).startsWith('b')) return handleBrokerText(ctx);
    if (!isAdmin(ctx)) {
      // не-админ без флоу: подскажем про кабинет брокера
      if (brokerCtx(ctx)) return brokerHome(ctx, false);
      return;
    }
    await handleAdminText(ctx);
  });
}

/* ---------- запуск ---------- */

function createBot(options = {}) {
  bot = new Bot(config.botToken, { client: { timeoutSeconds: 15 }, ...options });
  register();
  bus.on('order_event', onOrderEvent);
  bus.on('support_message', onSupportMessage);
  bus.on('review_event', onReviewEvent);
  bus.on('broker_event', onBrokerEvent);
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
      { command: 'broker', description: 'Кабинет брокера' },
      { command: 'support', description: 'Чаты поддержки' },
      { command: 'reviews', description: 'Отзывы и модерация' },
    ])
    .catch(() => {});

  if (!admins.all().length) {
    console.warn('[PRICELEX] ВНИМАНИЕ: ADMIN_ID / ADMIN_IDS не заданы — нет администраторов.');
  }
  await Promise.all(admins.all().map(async (id) => {
    if (store.get().flags.onboardedAdmins?.[id]) return;
    try {
      await bot.api.sendMessage(id,
        `🚀 <b>PRICELEX запущен!</b>\n🤖 @${esc(bot.botInfo.username)}\n/start — пульт оператора\n/admins — список админов\n/support — чаты поддержки\n/reviews — отзывы и модерация\nНовые заявки будут приходить всем операторам.`,
        { parse_mode: 'HTML' });
      store.mutate((db) => { (db.flags.onboardedAdmins ||= {})[id] = true; });
    } catch (e) { console.error(`[bot] onboarding ${id}:`, e.message); }
  }));
  for (const order of store.activeOrders()) await sendOrUpdateOrderAdmin(order);

  // Адрес приложения нигде не публикуется: он только прописывается в кнопку меню бота.
  const applyPublicUrl = async (url) => {
    try {
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'PRICELEX', web_app: { url } } });
      console.log('[PRICELEX] кнопка меню Telegram настроена');
    } catch (e) {
      console.error('[PRICELEX] setChatMenuButton:', e.message);
    }
  };
  bus.on('public_url', (url) => applyPublicUrl(url));
  if (store.get().settings.publicUrl) {
    applyPublicUrl(store.get().settings.publicUrl).catch(() => {});
  }

  bot.catch((e) => console.error('[bot error]', e.message));
  bot.start();
  console.log('[PRICELEX] бот запущен: @' + bot.botInfo.username);
}

module.exports = { startBot, createBot };
