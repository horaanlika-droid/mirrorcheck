const { Bot, InlineKeyboard, InputFile } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const admins = require('./admins');
const rates = require('./rates');
const receipts = require('./receipts');
const { esc, fmtRub, fmtCrypto, fmtDate, fmtSize, parseNum, fmtMsk, parseMsk } = require('./util');

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

// BTC-суммы: 0.0004 вместо 0.00040000, ноль — «0 BTC».
const fmtBtc = (n) => {
  const v = Math.round((Number(n) || 0) * 1e8) / 1e8;
  return (v ? v.toFixed(8).replace(/\.?0+$/, '') : '0') + ' BTC';
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
    (o.brokerId ? `🤝 Брокер: <code>${esc((store.getBroker(o.brokerId) || {}).login || o.brokerId)}</code>\n` : '') +
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

/* ---------- отзывы ---------- */

const REVIEW_STATUS = { pending: '🕓 На модерации', approved: '✅ Опубликован', rejected: '🙈 Скрыт' };
const REVIEW_LISTS = { pending: '🕓 На модерации', approved: '✅ Опубликованные', rejected: '🙈 Скрытые' };
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const REVIEWS_PAGE = 8;

function reviewText(r) {
  const order = r.orderId ? store.getOrder(r.orderId) : null;
  const user = r.userId ? store.getUser(r.userId) : null;
  const author = r.source === 'admin'
    ? ' · добавлен оператором'
    : user ? ` · <code>${esc(user.id)}</code>${user.username ? ' @' + esc(user.username) : ''}` : '';
  return (
    `⭐ <b>Отзыв #${r.id}</b> · ${REVIEW_STATUS[r.status] || r.status}\n` +
    `${stars(r.rating)} ${r.rating}/5\n` +
    `👤 ${esc(r.name)}${author}\n` +
    (order ? `📥 Заявка #${order.id} · ${fmtRub(order.payRub || order.rub)} → ${esc(order.currency)}\n` : '') +
    `📅 ${fmtMsk(r.createdAt)} (МСК)\n\n` +
    `«${esc(r.text)}»`
  );
}

function reviewKb(r) {
  const kb = new InlineKeyboard();
  if (r.status === 'pending') kb.text('✅ Опубликовать', `rv:${r.id}:approve`).text('🚫 Отклонить', `rv:${r.id}:reject`).row();
  else if (r.status === 'approved') kb.text('🙈 Снять с публикации', `rv:${r.id}:reject`).row();
  else kb.text('✅ Опубликовать', `rv:${r.id}:approve`).row();
  return kb
    .text('👤 Имя', `rv:${r.id}:name`).text('⭐ Оценка', `rv:${r.id}:rate`).row()
    .text('✏️ Текст', `rv:${r.id}:text`).text('📅 Дата и время', `rv:${r.id}:date`).row()
    .text('🗑 Удалить', `rv:${r.id}:del`).text('📋 К списку', `rvl:${r.status}:0`);
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
  const text =
    `⭐ <b>Отзывы</b>\n\n` +
    `Опубликовано: <b>${pub.count}</b>${pub.count ? ` · средняя оценка <b>${pub.avg.toFixed(1)}</b>` : ''}\n` +
    `На модерации: <b>${pending}</b> · Скрыто: ${hidden}\n\n` +
    `Клиент может оставить отзыв только после завершённого обмена — он попадает сюда на модерацию. ` +
    `Автор всегда видит свой отзыв опубликованным и о модерации не знает; остальным он виден только после одобрения.\n` +
    `Вы можете добавить отзыв сами и отредактировать любой: имя, оценку, текст, дату и время (по Москве).`;
  const kb = new InlineKeyboard()
    .text(`🕓 На модерации${pending ? ` (${pending})` : ''}`, 'rvl:pending:0').row()
    .text('✅ Опубликованные', 'rvl:approved:0').text('🙈 Скрытые', 'rvl:rejected:0').row()
    .text('➕ Добавить отзыв', 'rv:add').row()
    .text('↩️ Назад', 'm:home');
  return show(ctx, edit, text, kb);
}

async function reviewsList(ctx, status, page = 0, edit = true) {
  const list = store.reviewsByStatus(status);
  const pages = Math.max(1, Math.ceil(list.length / REVIEWS_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const kb = new InlineKeyboard();
  for (const r of list.slice(p * REVIEWS_PAGE, (p + 1) * REVIEWS_PAGE)) {
    kb.text(`${'★'.repeat(r.rating)} ${r.name.slice(0, 18)} · ${fmtMsk(r.createdAt).slice(0, 10)}`, `rv:${r.id}`).row();
  }
  if (pages > 1) {
    if (p > 0) kb.text('◀️', `rvl:${status}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, `rvl:${status}:${p}`);
    if (p < pages - 1) kb.text('▶️', `rvl:${status}:${p + 1}`);
    kb.row();
  }
  kb.text('⭐ Все отзывы', 'm:reviews').text('↩️ Меню', 'm:home');
  const text = `${REVIEW_LISTS[status]} — <b>${list.length}</b>\n\n` +
    (list.length ? 'Выберите отзыв, чтобы открыть и отредактировать:' : 'Здесь пока пусто.');
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
  flows.set(ctx.from.id, { type: 'rvadd', step, draft });
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
  }
  flows.delete(ctx.from.id);
  const upd = store.updateReview(r.id, patch);
  await syncReviewCards(upd);
  await ctx.reply('✅ Отзыв обновлён — изменения уже на сайте.');
  return reviewView(ctx, upd, false);
}

async function onReviewCallback(ctx, d, prevFlow) {
  if (d === 'm:reviews') return reviewsMenu(ctx, true);
  let m = d.match(/^rvl:(pending|approved|rejected):(\d+)$/);
  if (m) return reviewsList(ctx, m[1], Number(m[2]), true);
  if (d === 'rv:add') return reviewAddPrompt(ctx, {}, 'name');
  m = d.match(/^rva:(rate|date):(\w+)$/);
  if (m) {
    if (!prevFlow || prevFlow.type !== 'rvadd' || prevFlow.step !== m[1]) {
      return ctx.reply('Этот шаг уже неактуален. Начните заново: ⭐ Отзывы → ➕ Добавить отзыв.', { reply_markup: homeKb() });
    }
    return reviewAddStep(ctx, prevFlow, m[1] === 'date' ? 'сейчас' : m[2]);
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
  if (REVIEW_EDIT[act]) {
    flows.set(ctx.from.id, { type: 'rvedit', field: act, reviewId: r.id });
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

/* ---------- брокеры: кандидаты, аккаунты, выплаты (администрация) ---------- */

const getBrokerApp = (id) => store.get().brokerApps.find((a) => a.id === Number(id)) || null;

async function brokersMenu(ctx, edit = true) {
  const accs = store.get().brokers;
  const apps = store.brokerAppsByStatus('new');
  const pays = store.payoutsByStatus('requested');
  const linked = accs.filter((b) => b.active && b.tgId).length;
  const text =
    `🤝 <b>Брокеры площадки</b>\n\n` +
    `Аккаунтов: <b>${accs.length}</b> (привязано к Telegram: ${linked})\n` +
    `Заявок кандидатов: <b>${apps.length}</b> · выплат ожидают: <b>${pays.length}</b>\n` +
    `Доля брокера: ${store.get().settings.brokerPercent ?? 10}% от суммы сделки\n` +
    `Минимальная выплата: ${fmtBtc(store.BROKER_MIN_PAYOUT)}\n\n` +
    `Доступ выдаётся вручную, логином и паролем:\n` +
    `<code>/addbroker логин пароль Имя</code>\n` +
    `<code>/brokerpass логин новыйпароль</code> — сменить пароль\n` +
    `<code>/delbroker логин</code> — отозвать доступ\n\n` +
    `Брокер входит в свою панель командой /broker в этом же боте.`;
  const kb = new InlineKeyboard()
    .text(`📥 Заявки кандидатов${apps.length ? ` (${apps.length})` : ''}`, 'brm:apps').row()
    .text(`💸 Выплаты${pays.length ? ` (${pays.length})` : ''}`, 'brm:pays')
    .text('📋 Аккаунты', 'brm:accs').row()
    .text('↩️ Назад', 'm:home');
  return show(ctx, edit, text, kb);
}

async function brokerAppsMenu(ctx, edit = true) {
  const apps = store.brokerAppsByStatus('new');
  const kb = new InlineKeyboard();
  for (const a of apps.slice(0, 8)) {
    kb.text(`#${a.id} · ${a.name.slice(0, 16)} · ${fmtDate(a.createdAt)}`, `brm:app:${a.id}`).row();
  }
  kb.text('🤝 Брокеры', 'brm:home').text('↩️ Меню', 'm:home');
  const text = `📥 <b>Заявки кандидатов в брокеры</b> — ${apps.length}\n\n` +
    (apps.length ? 'Откройте заявку, чтобы прочитать опыт и отметить обработку:' : 'Новых заявок нет.');
  return show(ctx, edit, text, kb);
}

const brokerAppText = (a) =>
  `📥 <b>Заявка в брокеры #${a.id}</b>\n` +
  `👤 ${esc(a.name)}${a.username ? ' (@' + esc(a.username) + ')' : ''} · <code>${esc(a.userId)}</code>\n` +
  `📇 Контакт: <code>${esc(a.contact)}</code>\n` +
  `🕒 ${fmtDate(a.createdAt)}\n\n` +
  `📝 <b>Опыт кандидата:</b>\n${esc(a.experience)}\n\n` +
  (a.status === 'done'
    ? '✅ Заявка обработана.'
    : 'Свяжитесь с кандидатом, выдайте доступ (<code>/addbroker логин пароль Имя</code>) и отметьте заявку обработанной.');

async function brokerAppView(ctx, a, edit = true) {
  const kb = new InlineKeyboard();
  if (a.status === 'new') kb.text('✅ Отметить обработанной', `brm:app:${a.id}:done`).row();
  kb.text('📥 Все заявки', 'brm:apps').text('🤝 Брокеры', 'brm:home');
  return show(ctx, edit, brokerAppText(a), kb);
}

async function brokerAccsMenu(ctx, edit = true) {
  const accs = store.get().brokers.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  const lines = accs.length
    ? accs.map((b) =>
      `• <code>${esc(b.login)}</code> · ${esc(b.name)} — ${b.active ? (b.tgId ? '🔗 в работе' : '⌛ ждёт входа') : '⛔ доступ отозван'}\n` +
      `  баланс ${fmtBtc(store.brokerAvailable(b))} · начислено ${fmtBtc(b.earnedBTC)} · выплачено ${fmtBtc(b.paidBTC)}`).join('\n')
    : 'Аккаунтов пока нет.';
  const kb = new InlineKeyboard().text('🤝 Брокеры', 'brm:home').text('↩️ Меню', 'm:home');
  return show(ctx, edit, `📋 <b>Аккаунты брокеров</b>\n\n${lines}\n\nВыдача: <code>/addbroker логин пароль Имя</code>`, kb);
}

async function payoutsMenu(ctx, edit = true) {
  const list = store.payoutsByStatus('requested');
  const kb = new InlineKeyboard();
  for (const p of list.slice(0, 8)) {
    kb.text(`✅ Выдать #${p.id} · ${p.login} · ${fmtBtc(p.amountBTC)}`, `brm:pay:${p.id}:done`).row();
  }
  kb.text('🤝 Брокеры', 'brm:home').text('↩️ Меню', 'm:home');
  const lines = list.slice(0, 8)
    .map((p) => `• #${p.id} · <code>${esc(p.login)}</code> · <b>${fmtBtc(p.amountBTC)}</b>\n  → <code>${esc(p.address)}</code>`)
    .join('\n');
  const text = `💸 <b>Запрошенные выплаты</b> — ${list.length}\n\n` +
    (list.length ? `${lines}\n\nПосле перевода нажмите кнопку выплаты — брокер получит уведомление.` : 'Запросов нет.');
  return show(ctx, edit, text, kb);
}

// Веб-приложение: клиент подал заявку «стать брокером».
async function onBrokerApp({ application }) {
  if (!bot) return;
  const a = application;
  await broadcast(
    `🤝 <b>Новая заявка «Стать брокером» #${a.id}</b>\n` +
    `👤 ${esc(a.name)}${a.username ? ' (@' + esc(a.username) + ')' : ''} · <code>${esc(a.userId)}</code>\n` +
    `📇 Контакт: <code>${esc(a.contact)}</code>\n` +
    `🕒 ${fmtDate(a.createdAt)}\n\n` +
    `📝 ${esc(a.experience.slice(0, 600))}`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✅ Отметить обработанной', `brm:app:${a.id}:done`) }
  );
}

/* ---------- панель брокера (логин + пароль от администрации) ---------- */

const linkedBroker = (ctx) => store.getBrokerByTg(ctx.from?.id);

async function brokerPanel(ctx, edit = false) {
  const me = linkedBroker(ctx);
  if (!me) return ctx.reply('⛔ Доступ не привязан к этому Telegram. Вход: /broker');
  const avail = store.brokerAvailable(me);
  const active = store.activeOrders().length;
  const text =
    `🤝 <b>Панель брокера</b>\n` +
    `${esc(me.name)} · <code>${esc(me.login)}</code>\n\n` +
    `💰 Доступно к выводу: <b>${fmtBtc(avail)}</b>\n` +
    `Начислено всего: ${fmtBtc(me.earnedBTC)}\n` +
    `На выплате: ${fmtBtc(me.pendingBTC)} · выплачено: ${fmtBtc(me.paidBTC)}\n` +
    `Минимальная выплата: ${fmtBtc(store.BROKER_MIN_PAYOUT)}\n\n` +
    `Активных заявок в системе: ${active}\n` +
    `Средства клиентов проходят через гарантийный счёт площадки — подтверждайте оплату только после проверки чека.`;
  const kb = new InlineKeyboard()
    .text(`📥 Заявки${active ? ` (${active})` : ''}`, 'brk:orders').row()
    .text('💸 Вывести BTC', 'brk:payout').text('🔄 Обновить', 'brk:home').row()
    .text('⏏ Выйти', 'brk:logout');
  return show(ctx, edit, text, kb);
}

async function brokerOrdersMenu(ctx, edit = true) {
  const list = store.activeOrders().sort((a, b) => b.createdAt - a.createdAt);
  const kb = new InlineKeyboard();
  if (list.length) {
    for (const o of list.slice(0, 8)) {
      kb.text(`#${o.id} · ${o.currency} · ${fmtRub(o.rub)} · ${o.status === 'new' ? '🔍' : o.status === 'paid' ? '⏳' : '💳'}`, `brk:o:${o.id}`).row();
    }
  }
  kb.text('🤝 Панель', 'brk:home');
  const text = list.length
    ? '📥 <b>Активные заявки</b> — выберите и ведите:'
    : '📥 <b>Заявки</b>\n\nАктивных заявок нет. Новые появятся здесь по мере поступления — обновляйте панель.';
  return show(ctx, edit, text, kb);
}

function brokerOrderKb(o, me) {
  const kb = new InlineKeyboard();
  const mine = String(o.brokerId) === String(me.id);
  if (o.status === 'new') {
    kb.text('💳 Дать реквизиты счёта', `brk:o:${o.id}:req`);
  } else if (o.status === 'details') {
    kb.text('✅ Платёж проверен — завершить', `brk:o:${o.id}:confirm`);
    if (o.receipt) kb.row().text('🧾 Получить чек', `brk:o:${o.id}:receipt`);
  } else if (o.status === 'paid') {
    kb.text('✅ Подтвердить и завершить', `brk:o:${o.id}:confirm`);
    if (o.receipt) kb.row().text('🧾 Получить чек', `brk:o:${o.id}:receipt`);
  } else if (o.status === 'completed') {
    if (o.receipt) kb.text('🧾 Получить чек', `brk:o:${o.id}:receipt`);
    if (mine) kb.text(o.txUrl ? '🔗 Изменить ссылку' : '🔗 Ссылка на блокчейн', `brk:o:${o.id}:tx`);
  }
  kb.row().text('📥 Все заявки', 'brk:orders').text('🤝 Панель', 'brk:home');
  return kb;
}

function brokerOrderText(o, me) {
  let t = orderText(o);
  if (String(o.brokerId) === String(me.id)) t += `\n🤝 Сделку ведёте вы.`;
  if (o.brokerAccrued != null) t += `\n💰 Начислено вам за сделку: <b>${fmtBtc(o.brokerAccrued)}</b>`;
  return t;
}

async function onBrokerCallback(ctx, d) {
  const me = linkedBroker(ctx);
  if (!me) return ctx.reply('⛔ Доступ не найден или отозван администрацией. Вход: /broker');
  if (d === 'brk:home') return brokerPanel(ctx, true);
  if (d === 'brk:orders') return brokerOrdersMenu(ctx, true);
  if (d === 'brk:logout') {
    store.updateBroker(me.id, { tgId: null });
    return show(ctx, true, '⏏ Вы вышли из панели брокера. Снова войти: /broker (понадобятся логин и пароль).', new InlineKeyboard());
  }
  if (d === 'brk:payout') {
    const avail = store.brokerAvailable(me);
    if (avail < store.BROKER_MIN_PAYOUT) {
      return ctx.reply(`Минимальная сумма выплаты — ${fmtBtc(store.BROKER_MIN_PAYOUT)}.\nДоступно сейчас: ${fmtBtc(avail)}.`);
    }
    flows.set(ctx.from.id, { type: 'brkpayout', brokerId: me.id });
    return ctx.reply(
      `💸 К выплате вся доступная сумма: <b>${fmtBtc(avail)}</b>.\n` +
      `Отправьте адрес BTC-кошелька для получения.\n` +
      `Администрация проверит запрос, переведёт средства и отметит выплату.\n/cancel — отмена`,
      { parse_mode: 'HTML' }
    );
  }
  const m = d.match(/^brk:o:(\d+)(?::(\w+))?$/);
  if (!m) return;
  const o = store.getOrder(m[1]);
  if (!o) return show(ctx, true, 'Заявка не найдена.', new InlineKeyboard().text('📥 Все заявки', 'brk:orders'));
  const act = m[2];
  if (!act) return show(ctx, true, brokerOrderText(o, me), brokerOrderKb(o, me));
  const allowed = { req: ['new'], confirm: ['details', 'paid'], receipt: ['details', 'paid', 'completed'], tx: ['completed'] };
  if (!allowed[act] || !allowed[act].includes(o.status)) {
    return ctx.reply('Действие недоступно: статус заявки уже изменился. Откройте её заново.');
  }
  if (act === 'receipt') {
    if (!o.receipt) return ctx.reply('Чек по этой заявке не прикреплён.');
    return sendReceiptTo(ctx.from.id, o);
  }
  if (act === 'req') {
    flows.set(ctx.from.id, { type: 'brkreq', orderId: o.id, version: o.version || 0 });
    return ctx.reply(
      `💳 Заявка #${o.id}. Отправьте одним сообщением реквизиты гарантийного счёта (карта / СБП / счёт, банк, получатель).\n\n` +
      `Они СРАЗУ появятся у клиента с суммой ${fmtRub(o.payRub || o.rub)}. Точную сумму при необходимости скорректирует администрация.\n/cancel — отмена`
    );
  }
  if (act === 'confirm') {
    const upd = store.updateOrder(o.id, { status: 'completed' });
    const accrual = store.accrueCompletedOrder(o.id);
    await sendOrUpdateOrderAdmin(upd);
    await broadcast(
      `🤝 Брокер <code>${esc(me.login)}</code> завершил заявку #${o.id} (${fmtRub(upd.payRub || upd.rub)} → ${fmtCrypto(upd.crypto, upd.currency)}).` +
      (accrual ? `\nНачислено брокеру: ${fmtBtc(accrual.earnedBTC)}.` : ''),
      { parse_mode: 'HTML' }
    );
    await show(ctx, true, brokerOrderText(upd, me), brokerOrderKb(upd, me));
    return ctx.reply(
      `✅ Заявка #${o.id} завершена.` +
      (accrual ? ` На ваш баланс начислено <b>${fmtBtc(accrual.earnedBTC)}</b>.` : '') +
      `\n\nОтправьте клиенту вручную:\n🪙 <b>${fmtCrypto(upd.crypto, upd.currency)}</b>\n👛 <code>${esc(upd.wallet)}</code>`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔗 Ссылка на блокчейн', `brk:o:${o.id}:tx`) }
    );
  }
  if (act === 'tx') {
    if (String(o.brokerId) !== String(me.id)) return ctx.reply('Ссылку добавляет брокер, который вёл заявку.');
    flows.set(ctx.from.id, { type: 'brktx', orderId: o.id });
    return ctx.reply(`🔗 Заявка #${o.id} — отправьте ссылку на транзакцию в блокчейне (https://…).\n/cancel — отмена`);
  }
}

async function handleBrokerText(ctx, f) {
  const text = ctx.message.text.trim();
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^отмена$/i.test(text)) {
    flows.delete(ctx.from.id);
    return ctx.reply('❌ Отменено. /broker — панель брокера.');
  }
  if (f.type === 'brklogin') {
    if (f.step === 'login') {
      const b = store.getBrokerByLogin(text);
      if (!b || !b.active) return ctx.reply('Такой логин не найден (или доступ отозван). Проверьте логин у администрации и отправьте ещё раз.\n/cancel — выход');
      flows.set(ctx.from.id, { type: 'brklogin', step: 'pass', brokerId: b.id });
      return ctx.reply('Логин принят. Теперь отправьте пароль.\nПосле входа удалите сообщение с паролем из чата.\n/cancel — выход');
    }
    if (f.step === 'pass') {
      const b = store.getBroker(f.brokerId);
      if (!b || !b.active || b.pass !== text) return ctx.reply('Неверный пароль — попробуйте ещё раз.\n/cancel — выход');
      flows.delete(ctx.from.id);
      store.updateBroker(b.id, { tgId: String(ctx.from.id) });
      await ctx.reply(`✅ Вход выполнен, ${esc(b.name)}.`, { parse_mode: 'HTML' });
      return brokerPanel(ctx, false);
    }
    return;
  }
  const me = linkedBroker(ctx);
  if (!me) {
    flows.delete(ctx.from.id);
    return ctx.reply('⛔ Сессия завершена. Войдите снова: /broker');
  }
  if (f.type === 'brkreq') {
    const o = store.getOrder(f.orderId);
    if (!o || o.status !== 'new' || (o.version || 0) !== f.version) {
      flows.delete(ctx.from.id);
      return ctx.reply('Заявка уже изменена оператором или клиентом. Откройте её заново через /broker.');
    }
    if (!text || text.length > 900) return ctx.reply('Реквизиты — от 1 до 900 символов. Отправьте целиком ещё раз.');
    flows.delete(ctx.from.id);
    const upd = store.updateOrder(o.id, { requisites: text, payRub: o.payRub || o.rub, status: 'details', brokerId: me.id });
    const [, delivered] = await Promise.all([sendOrUpdateOrderAdmin(upd), notifyClient(upd)]);
    await broadcast(`🤝 Брокер <code>${esc(me.login)}</code> выдал реквизиты по заявке #${o.id} (${fmtRub(upd.payRub)}).`, { parse_mode: 'HTML' });
    return ctx.reply(
      `✅ Реквизиты по заявке #${o.id} опубликованы. К оплате: ${fmtRub(upd.payRub)}.` +
      (delivered ? '' : '\nЛичное сообщение клиенту не доставлено — реквизиты ждут его в приложении.'),
      { reply_markup: new InlineKeyboard().text('📥 Заявки', 'brk:orders').text('🤝 Панель', 'brk:home') }
    );
  }
  if (f.type === 'brktx') {
    const o = store.getOrder(f.orderId);
    if (!o || o.status !== 'completed') {
      flows.delete(ctx.from.id);
      return ctx.reply('Ссылка добавляется только к завершённой заявке.');
    }
    if (!/^https?:\/\/.{4,800}$/i.test(text)) return ctx.reply('Пришлите корректную ссылку, начинающуюся с https:// (до 800 символов).');
    flows.delete(ctx.from.id);
    const upd = store.updateOrder(o.id, { txUrl: text });
    await Promise.all([sendOrUpdateOrderAdmin(upd), notifyClientTx(upd)]);
    return ctx.reply(`✅ Ссылка сохранена для заявки #${o.id}:\n${text}\n\nКлиент увидит её в приложении.`, {
      reply_markup: new InlineKeyboard().text('🤝 Панель', 'brk:home'),
    });
  }
  if (f.type === 'brkpayout') {
    const meNow = store.getBroker(f.brokerId);
    if (!meNow || String(meNow.tgId) !== String(ctx.from.id)) {
      flows.delete(ctx.from.id);
      return ctx.reply('⛔ Сессия завершена. Войдите снова: /broker');
    }
    const addr = text.replace(/\s+/g, '');
    if (!/^[a-zA-Z0-9]{26,90}$/.test(addr)) return ctx.reply('Пришлите корректный адрес BTC-кошелька (26–90 символов, без пробелов).');
    const avail = store.brokerAvailable(meNow);
    if (avail < store.BROKER_MIN_PAYOUT) {
      flows.delete(ctx.from.id);
      return ctx.reply(`Недостаточно средств: доступно ${fmtBtc(avail)}, минимум ${fmtBtc(store.BROKER_MIN_PAYOUT)}.`);
    }
    flows.delete(ctx.from.id);
    const payout = store.createPayout({ brokerId: meNow.id, amountBTC: avail, address: addr });
    await broadcast(
      `💸 <b>Брокер ${esc(meNow.login)} запросил выплату</b>\n` +
      `Сумма: <b>${fmtBtc(payout.amountBTC)}</b>\n` +
      `Адрес: <code>${esc(addr)}</code>`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✅ Выдать', `brm:pay:${payout.id}:done`) }
    );
    return ctx.reply(
      `✅ Запрос на выплату <b>${fmtBtc(payout.amountBTC)}</b> отправлен администрации.\n` +
      `Адрес: <code>${esc(addr)}</code>\n` +
      `Администрация проверит запрос, переведёт средства и отметит выплату — вы получите уведомление.`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🤝 Панель', 'brk:home') }
    );
  }
}

/* ---------- меню ---------- */

async function mainMenu(ctx, edit = false) {
  const s = store.get().settings;
  const active = store.activeOrders().length;
  const supportCount = store.getSupportThreads().length;
  const pendingReviews = store.reviewsByStatus('pending').length;
  const pendingBrokerApps = store.brokerAppsByStatus('new').length;
  const pendingPayouts = store.payoutsByStatus('requested').length;
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
    .text('🤝 Брокеры', 'm:brokers')
    .text('👥 Админы', 'm:admins');
  const text =
    `🌌 <b>PRICELEX | Official</b> — пульт оператора\n` +
    `${s.online ? '🟢 Обменник <b>ОНЛАЙН</b>' : '🔴 Обменник <b>ОФФЛАЙН</b>'}\n` +
    `₿ ${fmtRub(s.rateBTC)} · G ${fmtRub(s.rateGRAM)} (комиссия ${s.feePercent ?? 0}%)\n` +
    `Официальный курс ${s.rateUpdatedAt ? 'от ' + fmtDate(s.rateUpdatedAt) + ` (${esc(s.rateSource || '?')})` : 'ещё не подтянут — действуют стартовые курсы'}\n` +
    `Активных заявок: ${active} · 💬 Чатов: ${supportCount}` +
    (pendingReviews ? `\n⭐ Отзывов на модерации: <b>${pendingReviews}</b>` : '') +
    (pendingBrokerApps ? `\n🤝 Кандидатов в брокеры: <b>${pendingBrokerApps}</b>` : '') +
    (pendingPayouts ? `\n💸 Выплат запросили брокеры: <b>${pendingPayouts}</b>` : '');
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
    .text('🤝 % брокера', 's:bpct')
    .text('📢 Объявление', 's:ann')
    .text('🛟 Поддержка', 's:op')
    .row()
    .text('📣 Канал', 's:ch')
    .text('💬 Чат', 's:chat')
    .row()
    .text('↩️ Назад', 'm:home');
}

function settingsText(s) {
  const base = s.baseRateBTC
    ? `₿ ${fmtRub(s.baseRateBTC)} · G ${fmtRub(s.baseRateGRAM)}`
    : 'ещё не подтянут';
  return (
    `⚙️ <b>Настройки</b> (применяются мгновенно)\n\n` +
    `📊 Официальный курс (авто): <b>${base}</b>\n` +
    (s.rateUpdatedAt ? `Обновлён: ${fmtDate(s.rateUpdatedAt)} (${esc(s.rateSource || '?')})\n` : '') +
    `💰 Комиссия: <b>${s.feePercent ?? 0}%</b> поверх официального\n` +
    `💵 Курс для клиентов: <b>₿ ${fmtRub(s.rateBTC)} · G ${fmtRub(s.rateGRAM)}</b>\n` +
    `Лимиты: ${fmtRub(s.minRub)} — ${fmtRub(s.maxRub)}\n` +
    `🎁 Реферальный процент: <b>${s.refPercent}%</b>\n` +
    `🤝 Доля брокера: <b>${s.brokerPercent ?? 10}%</b> от суммы сделки · мин. выплата ${store.BROKER_MIN_PAYOUT} BTC\n` +
    `Статус: ${s.online ? '🟢 Онлайн' : '🔴 Оффлайн'}\n` +
    `📢 ${esc(s.announcement)}\n` +
    `🛟 Поддержка: ${esc(s.operator)} · 📣 ${esc(s.channel)}\n💬 ${esc(s.chat)}`
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
    `🛟 Поддержка: ${esc(s.operator)}\n📣 Канал: ${esc(s.channel)}\n💬 Чат: ${esc(s.chat)}\n\n` +
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
  bpct: { label: 'долю брокера в % от крипто-суммы сделки (0–50, например 10)', num: true, key: 'brokerPercent' },
  ann: { label: 'текст объявления для сайта' },
  op: { label: 'юзернейм поддержки (например @pricelex_support)' },
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
    `🔗 Заявка #${o.id} — отправьте ссылку на транзакцию в блокчейне (например https://blockchair.com/bitcoin/transaction/… или https://blockchair.com/gram/transaction/…).\n\nСсылка появится у клиента в завершённой заявке. Это опционально — можно оставить пустым, отправив /cancel.\n\nТекущая: ${o.txUrl ? esc(o.txUrl) : '— нет —'}\n/cancel — отмена`,
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
  if (f.type === 'rvadd') return reviewAddStep(ctx, f, text);
  if (f.type === 'rvedit') return reviewEditText(ctx, f, text);
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
        if (f.type === 'set:fee' || f.type === 'set:bpct') {
          if (!isFinite(n) || n < 0 || n > 50) return ctx.reply('Нужно число от 0 до 50. Пример: 2');
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
    .text('⭐ Отзывы', 'm:reviews')
    .row()
    .text('🤝 Брокеры', 'm:brokers')
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
  bot.command('brokers', (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    return brokersMenu(ctx, false);
  });
  bot.command('addbroker', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const [login, pass] = parts;
    const name = parts.slice(2).join(' ') || login;
    if (!login || !pass || !/^[a-zA-Z0-9_]{3,24}$/.test(login)) {
      return ctx.reply('Формат: /addbroker логин пароль [Имя]\nЛогин — 3–24 латинские буквы, цифры или подчёркивание.');
    }
    if (pass.length < 4 || pass.length > 64) return ctx.reply('Пароль — от 4 до 64 символов, без пробелов.');
    const b = store.createBroker({ login, pass, name });
    if (!b) return ctx.reply(`Логин «${login}» уже занят. Сменить пароль: /brokerpass ${login} новыйпароль`);
    return ctx.reply(
      `✅ Доступ брокера создан.\nЛогин: <code>${esc(b.login)}</code>\nПароль: <code>${esc(pass)}</code>\nИмя: ${esc(b.name)}\n\nПередайте кандидату логин и пароль — он войдёт командой /broker в этом боте.`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🤝 Брокеры', 'brm:home') }
    );
  });
  bot.command('brokerpass', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [login, pass] = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (!login || !pass || pass.length < 4 || pass.length > 64) {
      return ctx.reply('Формат: /brokerpass логин новыйпароль (4–64 символа, без пробелов).');
    }
    const b = store.getBrokerByLogin(login);
    if (!b) return ctx.reply(`Логин «${esc(login)}» не найден.`, { parse_mode: 'HTML' });
    store.updateBroker(b.id, { pass });
    return ctx.reply(`✅ Пароль брокера <code>${esc(b.login)}</code> обновлён. Передайте его брокеру.`, { parse_mode: 'HTML' });
  });
  bot.command('delbroker', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const login = ctx.match.trim();
    if (!login) return ctx.reply('Формат: /delbroker логин');
    const b = store.getBrokerByLogin(login);
    if (!b) return ctx.reply(`Логин «${esc(login)}» не найден.`, { parse_mode: 'HTML' });
    store.updateBroker(b.id, { active: false, tgId: null });
    return ctx.reply(`⛔ Доступ брокера <code>${esc(b.login)}</code> отозван, сессия завершена. Начисленный баланс сохранён: ${fmtBtc(store.brokerAvailable(b))}.`, { parse_mode: 'HTML' });
  });
  bot.command('start', async (ctx) => {
    if (!isAdmin(ctx)) {
      const url = store.get().settings.publicUrl;
      if (url) {
        return ctx.reply('🌌 PRICELEX — агентство криптоброкеров. BTC и GRAM по лучшей цене рынка.', {
          reply_markup: new InlineKeyboard().webApp('Открыть PRICELEX', url),
        });
      }
      return ctx.reply('🌌 PRICELEX — агентство криптоброкеров. Приложение откроется кнопкой меню, как только будет готово.');
    }
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });
  bot.command('menu', async (ctx) => {
    if (!isAdmin(ctx)) return;
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });

  bot.command('broker', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const me = linkedBroker(ctx);
    flows.delete(ctx.from.id);
    if (me) return brokerPanel(ctx, false);
    flows.set(ctx.from.id, { type: 'brklogin', step: 'login' });
    return ctx.reply('🤝 <b>Вход в панель брокера</b>\nОтправьте логин, выданный администрацией площадки.\n/cancel — выход', { parse_mode: 'HTML' });
  });

  bot.on('callback_query:data', async (ctx) => {
    const d = ctx.callbackQuery.data;
    if (typeof d === 'string' && d.startsWith('brk:')) {
      await ctx.answerCallbackQuery().catch(() => {});
      flows.delete(ctx.from.id);
      return onBrokerCallback(ctx, d);
    }
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔️' });
    await ctx.answerCallbackQuery().catch(() => {});
    const prevFlow = flows.get(ctx.from.id);
    flows.delete(ctx.from.id);

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

    if (d === 'm:brokers' || d === 'brm:home') return brokersMenu(ctx, true);
    if (d === 'brm:apps') return brokerAppsMenu(ctx, true);
    if (d === 'brm:accs') return brokerAccsMenu(ctx, true);
    if (d === 'brm:pays') return payoutsMenu(ctx, true);
    let bm = d.match(/^brm:app:(\d+)(?::(done))?$/);
    if (bm) {
      const a = getBrokerApp(bm[1]);
      if (!a) return show(ctx, true, 'Заявка не найдена.', new InlineKeyboard().text('🤝 Брокеры', 'brm:home'));
      if (bm[2] === 'done' && a.status === 'new') {
        store.updateBrokerApp(a.id, { status: 'done', processedAt: Date.now(), processedBy: String(ctx.from.id) });
      }
      return brokerAppView(ctx, getBrokerApp(bm[1]), true);
    }
    bm = d.match(/^brm:pay:(\d+):done$/);
    if (bm) {
      const res = store.markPayoutPaid(bm[1]);
      if (!res) return ctx.reply('Выплата уже обработана.');
      const { payout, broker: payoutBroker } = res;
      if (payoutBroker && payoutBroker.tgId) {
        await bot.api.sendMessage(payoutBroker.tgId,
          `💸 <b>Выплата #${payout.id} отправлена!</b>\n<b>${fmtBtc(payout.amountBTC)}</b> переведены на ваш кошелёк:\n<code>${esc(payout.address)}</code>\n\nСпасибо за работу на площадке 🤝`,
          { parse_mode: 'HTML' }).catch(() => {});
      }
      await ctx.reply(`✅ Выплата #${payout.id} отмечена выданной${payoutBroker && payoutBroker.tgId ? ', брокер уведомлён' : ''}.`);
      return payoutsMenu(ctx, true);
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
        const accrual = store.accrueCompletedOrder(id);
        await sendOrUpdateOrderAdmin(upd);
        await ctx.reply(
          `📨 <b>Заявка #${id} завершена.</b>\nОтправьте клиенту вручную:\n🪙 <b>${fmtCrypto(upd.crypto, upd.currency)}</b>\n👛 <code>${esc(upd.wallet)}</code>\n\n💡 Теперь вы можете опционально отправить ссылку на блокчейн-транзакцию — нажмите кнопку ниже.` +
          (accrual ? `\\n\\n🤝 Брокеру начислено за сделку: <b>${fmtBtc(accrual.earnedBTC)}</b>.` : ''),
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔗 Добавить ссылку на блокчейн', `o:${id}:tx`) }
        );
        return;
      }
    }
  });

  bot.on('message:text', async (ctx) => {
    const f = flows.get(ctx.from.id);
    if (f && typeof f.type === 'string' && f.type.startsWith('brk')) return handleBrokerText(ctx, f);
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
  bus.on('review_event', onReviewEvent);
  bus.on('broker_app', onBrokerApp);
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
      { command: 'reviews', description: 'Отзывы и модерация' },
      { command: 'broker', description: 'Панель брокера' },
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
