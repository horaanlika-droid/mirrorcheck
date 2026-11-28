const store = require('./store');
const bus = require('./bus');
const files = require('./attachments');
const config = require('./config');
const { InlineKeyboard, InputFile } = require('grammy');

function publicMessage({ id, orderId, from, text, at, attachment }) {
  const message = { id, orderId, from, text, at };
  if (attachment) {
    const { name, size, type } = attachment;
    message.attachment = { name, size, type };
  }
  return message;
}

// Sending a message does not change deal status or submit the gift code.
function post(order, from, text = '', file = null) {
  if (typeof text !== 'string' || text.length > 2000) throw new files.InputError('Сообщение — текст до 2000 символов.');
  if (!text.trim() && !file) throw new files.InputError('Напишите сообщение или прикрепите файл.');
  const attachment = file ? files.save(file) : null;
  const message = store.createOrderMessage({ orderId: order.id, userId: order.userId, from, text, attachment });
  bus.emit('order_message', { order, message });
  return publicMessage(message);
}

// Telegram file URLs contain the bot token. Fetch server-side only, do not persist
// or log these URLs, and bound the actual streamed bytes, not just the reported size.
async function telegramFile(ctx, media) {
  if (media.file_size > files.MAX_BYTES) throw files.tooLarge();
  const remote = await ctx.api.getFile(media.file_id);
  if (remote.file_size > files.MAX_BYTES) throw files.tooLarge();
  if (!remote.file_path) throw new Error('Telegram file unavailable');
  const url = `https://api.telegram.org/file/bot${config.botToken}/${remote.file_path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Telegram file unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > files.MAX_BYTES) throw files.tooLarge();
    chunks.push(chunk);
  }
  return { name: media.file_name || 'Фото.jpg', bytes: Buffer.concat(chunks, size) };
}

async function receiveTelegram(ctx, order, from) {
  const media = ctx.message.document || ctx.message.photo?.at(-1);
  try {
    const file = media ? await telegramFile(ctx, media) : null;
    post(order, from, ctx.message.text ?? ctx.message.caption ?? '', file);
  } catch (e) {
    return ctx.reply(e instanceof files.InputError ? e.message : 'Не удалось сохранить сообщение. Попробуйте ещё раз.');
  }
  return ctx.reply(`Отправлено в диалог сделки #${order.id}.`);
}

// Show recent context without retransmitting every file. Download buttons always
// resolve a message within the order, after the caller's ownership/role check.
// Для оператора в диалог добавлены действия по сделке: выдать валюту, отклонить,
// подключиться — чтобы не выходить из переписки в карточку заявки.
function adminChatActions(kb, order, payoutLabel) {
  const o = order;
  if (o.status === 'paid') {
    kb.row().text(`✅ Проверено — выдать ${payoutLabel || ''}`.trim(), `o:${o.id}:confirm`);
    kb.text('❌ Карта недействительна', `o:${o.id}:unpaid`);
  } else if (o.status === 'new') {
    kb.row().text('🤝 Подключить — запросить код', `o:${o.id}:connect`);
    kb.text('❌ Отклонить', `o:${o.id}:reject`);
  } else if (o.status === 'details') {
    kb.row().text('❌ Отклонить', `o:${o.id}:reject`);
  } else if (o.status === 'completed') {
    kb.row().text(o.txUrl ? '🔗 Изменить ссылку' : '🔗 Ссылка на блокчейн', `o:${o.id}:tx`);
  }
  return kb;
}

function openTelegram(ctx, order, from, opts = {}) {
  const prefix = from === 'admin' ? 'o' : 'c';
  const kb = new InlineKeyboard();
  const recent = store.getOrderMessages(order.id).slice(-5).map((m) => {
    const parts = [m.text.slice(0, 180)];
    if (m.attachment) {
      parts.push(`📎 ${m.attachment.name}`);
      kb.text(`📎 ${m.attachment.name}`, `${prefix}:file:${order.id}:${m.id}`).row();
    }
    return `${m.from === 'admin' ? 'Оператор' : 'Клиент'}: ${parts.filter(Boolean).join(' · ')}`;
  });
  if (from === 'admin') adminChatActions(kb, order, opts.payout);
  kb.text('↩️ К заявке', from === 'admin' ? `o:${order.id}` : `c:order:${order.id}`);
  const history = recent.length ? `\n\nПоследние сообщения:\n${recent.join('\n')}` : '';
  // Оператору подсказываем, как завершить сделку, не выходя из чата.
  const adminHint = from === 'admin'
    ? '\n\nКогда карта проверена и валюта отправлена — нажмите «✅ Проверено — выдать», сделка закроется, клиент получит уведомление.'
    : '';
  return ctx.reply(`💬 Диалог сделки #${order.id}${history}\n\nПришлите сообщение, фото или документ (JPG, PNG, WebP, PDF до 8 МБ). Подпись необязательна. Не отправляйте код карты до запроса оператора.${adminHint}\n/cancel — выйти из диалога`, { reply_markup: kb });
}

async function sendFile(ctx, order, messageId) {
  const file = order && store.getOrderMessages(order.id).find((m) => m.id === messageId)?.attachment;
  if (!file) return ctx.reply('Вложение не найдено.');
  try {
    return await ctx.replyWithDocument(new InputFile(files.filePath(file), file.name), { caption: `📎 Сделка #${order.id}` });
  } catch { return ctx.reply('Не удалось получить вложение.'); }
}

module.exports = { post, publicMessage, receiveTelegram, openTelegram, sendFile };
