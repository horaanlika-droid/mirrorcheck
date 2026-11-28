// Клиентский бот Pricelex Worldwide — тот же обмен без Mini App, для тех, кто не хочет открывать приложение.
// Поток: /start → меню → карта → номинал → адрес BEP-20 → заявка,
// «Мои заявки», «Поддержка», «Реферальная программа», «Информация». Обычными сообщениями
// и кнопками — работает в любом клиенте Telegram без Mini App и без виджетов.
// Только выкуп USD-подарочных карт (Google, iTunes, Xbox, Apple Store) с выплатой только в USDT (BEP-20).
const { InlineKeyboard } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const orderChat = require('./orderchat');
const currencies = require('./currencies');
const { esc, fmtCrypto, fmtUsdt, fmtOrderPayout, fmtDate, parseNum } = require('./util');
const widget = require('./widget');

const isPrivate = (ctx) => ctx.chat?.type === 'private' && ctx.from;
const uidOf = (ctx) => String(ctx.from.id);
const isGiftOrder = (o) => o && o.direction === 'sell';
const giftLabel = (o) => currencies.label(o.currency);
const giftUnits = (o) => Number(o.units) || 0;
const payoutOf = (o) => esc(fmtOrderPayout(o));
const loyaltyLabel = (o) => Number(o.loyaltyDiscountPercent) > 0
  ? `🎉 Скидка комиссии за каждый 5-й обмен: ${Number(o.loyaltyDiscountPercent)} п.п.\n`
  : '';

/* ---------- тексты ---------- */

// Преимущество подарочных карт — минимальный цифровой след.
const GIFT_PRIVACY =
  '🛡 <b>Минимальный цифровой след</b>\n' +
  '• Где и по какому курсу вы купили карту — нам не важно. Хоть на маркетплейсе, хоть у знакомых, хоть за наличные: важен только рабочий код.\n' +
  '• Мы не просим документы и регистрацию: только код карты и адрес кошелька для выплаты.\n' +
  '• Моментальный вывод без сетевого сбора — USDT (BEP-20), а также доступны Bitcoin (BTC), TRC-20, ERC-20 и TON.\n' +
  '• Меньше мест, где фиксируются ваши данные, — меньше цифровой след.';

/* ---------- состояние ---------- */

const ensureUser = (ctx, refParam = '') =>
  store.touchUser({ id: ctx.from.id, first_name: ctx.from.first_name || 'Клиент', username: ctx.from.username || null }, refParam);

// Псевдоним, выданный сервером, остаётся за профилем: в Telegram показываем его,
// чтобы клиент узнавал себя и не получал незнакомое «имя».
function displayName(ctx) {
  const user = store.getUser(uidOf(ctx));
  return (user && user.name) || ctx.from.first_name || 'Клиент';
}

// /link — одноразовый код для привязки браузерной сессии к этому Telegram-профилю.
// Код живёт 10 минут и не раскрывает Telegram ID: его вводит только владелец экрана.
async function sendLinkCode(ctx) {
  if (!isPrivate(ctx)) return;
  const session = require('./session');
  const { code, exp } = session.linkCode(uidOf(ctx));
  return ctx.reply(
    `🔗 <b>Привязка браузера к Telegram</b>\n\n` +
    `Код: <code>${code}</code>\n` +
    `Действует 10 минут.\n\n` +
    `Откройте сайт в браузере и введите код в профиле — заявки и чат станут общими,
` +
    `а этот профиль будет виден в Telegram.\n\n` +
    `⚠️ Код даёт доступ к профилю: никому его не передавайте.`,
    { parse_mode: 'HTML' }
  );
}

/* ---------- состояние потоков ---------- */
// Раньше шаг жил в Map в памяти процесса: рестарт, второй бот или другой
// инстанс теряли состояние — на выборе сети бот молчал. Теперь шаг хранится
// в базе (короткий TTL) + нужные данные есть в callback_data.
const FLOW_TTL_MS = 60 * 60 * 1000;
const flowKey = (id) => `cf:${id}`;
function flowGet(id) {
  const entry = (store.get().flags || {})[flowKey(id)];
  if (!entry || !entry.flow) return null;
  if (Date.now() > Number(entry.exp || 0)) { flowDel(id); return null; }
  return entry.flow;
}
function flowSet(id, flow) {
  store.mutate((db) => {
    db.flags = db.flags || {};
    db.flags[flowKey(id)] = { flow, exp: Date.now() + FLOW_TTL_MS };
    // Заодно подчищаем просроченные, чтобы база не росла.
    if (Object.keys(db.flags).length > 500) {
      for (const [k, v] of Object.entries(db.flags)) {
        if (k.startsWith('cf:') && (!v || Number(v.exp) < Date.now())) delete db.flags[k];
      }
    }
  });
}
function flowDel(id) {
  store.mutate((db) => { if (db.flags) delete db.flags[flowKey(id)]; });
}
const clientFlows = { get: flowGet, set: flowSet, delete: flowDel };

const availableGift = () =>
  currencies.list().filter(
    (p) => currencies.isEnabled(store.get().settings, p.key) && currencies.rateOf(store.get().settings, p.currency) > 0
  );

// У каждой карты свой курс — показываем их списком.
const rateListText = () => availableGift()
  .map((p) => `• ${esc(p.label)}: <b>1 $ = ${esc(fmtUsdt(currencies.rateOf(store.get().settings, p.currency)))}</b>`)
  .join('\n');

/* ---------- клавиатуры ---------- */

function menuKb(s) {
  const kb = new InlineKeyboard()
    .text('💱 Сдать карту', 'c:exchange').text('📦 Мои заявки', 'c:orders').row()
    .text('💬 Поддержка', 'c:support').text('⭐ Отзывы', 'c:reviews').row()
    .text('ℹ️ Информация', 'c:info').text('🎁 Реферальная программа', 'c:refs');
  // Telegram принимает кнопки web_app только по https — иначе всё сообщение отклоняется и клиент видит тишину.
  if (s.publicUrl && /^https:\/\//i.test(s.publicUrl)) kb.row().webApp('📱 Открыть приложение', s.publicUrl);
  return kb;
}

const backMenuKb = () => new InlineKeyboard().text('↩️ Меню', 'c:menu');

function assetKb() {
  const kb = new InlineKeyboard();
  for (const p of availableGift()) {
    kb.text(`🎁 ${p.label}`, `c:buy:${p.key}`).row();
  }
  kb.text('↩️ Меню', 'c:menu');
  return kb;
}

/* ---------- отрисовка экранов (сообщение редактируется по колбэкам) ---------- */

async function show(ctx, text, kb) {
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, opts);
    } catch (e) {
      /* сообщение не изменилось или слишком старое — просто отправляем новое */
    }
  }
  try {
    return await ctx.reply(text, opts);
  } catch (e) {
    // Telegram отклонил reply_markup (например, ссылка web_app не https) —
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
  const online = s.online ? '🟢 Обмен <b>ОНЛАЙН</b>' : '🔴 Обмен <b>ОФФЛАЙН</b>';
  return show(ctx,
    `🌌 <b>Pricelex Worldwide | Official</b> — обмен\n${online}\n\n` +
    `Выкупаем подарочные карты Google, iTunes, Xbox и Apple Store (регион США, USD).\n` +
    `Моментальный вывод без комиссии — <b>USDT (BEP-20)</b>; также доступны <b>BTC</b>, <b>TRC-20</b>, <b>ERC-20</b> и <b>TON</b> по комиссии сети.\n` +
    `Сумма выплаты видна до создания заявки.\n\n` +
    `Что хотите сделать?`,
    menuKb(s));
}

function assetScreen(ctx) {
  const s = store.get().settings;
  if (!s.online) {
    return show(ctx, '⛔ <b>Обмен временно недоступен.</b>\nСкоро вернёмся — загляните чуть позже.', backMenuKb());
  }
  if (!availableGift().length) {
    return show(ctx, '💱 <b>Направления временно недоступны.</b>\nЗагляните чуть позже.', backMenuKb());
  }
  return show(ctx,
    `💱 <b>Выберите карту</b>\n\nКакую карту сдаёте?\n\n${rateListText()}`,
    assetKb());
}

/* ---------- заявка: карта → USDT (BEP-20) ---------- */

// Первый экран — правила передачи карты.
function giftRules(ctx, pair) {
  clientFlows.delete(uidOf(ctx));
  const label = pair?.label || currencies.gift().label;
  return show(ctx,
    `🎁 <b>Сдать ${esc(label)}</b>\n\n` +
    `<b>Правила передачи карты:</b>\n` +
    `1. Карта должна быть <b>${esc(label)}</b> региона <b>США</b>, в <b>USD</b>, с полным неиспользованным балансом. Карты других регионов и валют не принимаем.\n` +
    `2. Сначала создаётся заявка, затем <b>подключается оператор</b>. <b>Ничего не отправляйте и никому не сообщайте код, пока оператор не попросит.</b>\n` +
    `3. Код карты вы отправляете здесь (или в приложении) <b>только после подключения оператора</b>. Он проверит карту (обычно 5–15 минут).\n` +
    `4. Выплата: <b>USDT (BEP-20)</b> — моментально и <b>без сетевого сбора</b>; либо <b>BTC</b>, <b>TRC-20</b>, <b>ERC-20</b>, <b>TON</b> по тарифу сети.\n` +
    `5. Поддержка никогда не просит код или деньги вне заявки. Не передавайте код никому, кроме оператора внутри заявки.\n` +
    `6. На сделку даётся <b>1 час</b> с момента создания заявки. Если карта окажется недействительной, заявку отклонят без выплаты.\n\n` +
    GIFT_PRIVACY,
    new InlineKeyboard().text('✅ Понятно — выбрать номинал', `c:giftnom:${pair.key}`).row().text('↩️ К списку карт', 'c:exchange'));
}

function giftIntro(ctx, pair, promo = null) {
  const s = store.get().settings;
  ensureUser(ctx);
  const loyalty = store.loyaltyStatus(uidOf(ctx));
  const feeDiscount = loyalty.eligible
    ? currencies.rateAfterFeeDiscount(s, pair.currency, loyalty.discountPercent).feeDiscountPercent
    : 0;
  const regularRate = currencies.rateOf(s, pair.currency);
  const baseRate = feeDiscount > 0 ? currencies.rateAfterFeeDiscount(s, pair.currency, feeDiscount).rate : regularRate;
  const effectiveRate = promo ? currencies.applyPromoToRate(baseRate, promo.percent) : baseRate;
  clientFlows.set(uidOf(ctx), { type: 'gift_select', key: pair.key, promoCode: promo ? promo.code : null });
  const kb = new InlineKeyboard()
    .text('$10', `c:units:${pair.key}:10`).text('$20', `c:units:${pair.key}:20`).text('$50', `c:units:${pair.key}:50`).text('$100', `c:units:${pair.key}:100`).row()
    .text('Другой номинал', `c:giftnum:${pair.key}`).row();
  if (promo) {
    kb.text(`🏷 Промокод ${promo.code} (+${promo.percent}%) ✕`, `c:promoclear:${pair.key}`).row();
  } else {
    kb.text('🏷 Ввести промокод', `c:promo:${pair.key}`).row();
  }
  kb.text('↩️ К списку карт', 'c:exchange');
  return show(ctx,
    `${esc(pair.label)} → USDT (BEP-20) / BTC / TRC-20\n\n` +
    `Вы отдаёте код карты ${esc(pair.label)} номиналом в <b>USD</b> — мы отправляем USDT (BEP-20 моментально без сетевого сбора) или BTC / TRC-20 / ERC-20 / TON по тарифу сети.\n\n` +
    `💱 Курс этой карты: <b>1 $ = ${esc(fmtUsdt(effectiveRate))}</b>. Курс обновляется автоматически.\n` +
    (feeDiscount > 0 ? `🎉 Каждый 5-й обмен: комиссия снижена на <b>${feeDiscount} п.п.</b>.\n` : '') +
    (promo ? `🏷 Промокод <b>${esc(promo.code)}</b>: <b>+${promo.percent}%</b> к выплате${promo.minUnits ? ` (от $${promo.minUnits})` : ''}.\n` : '') +
    `⏱ На сделку — 1 час с момента создания заявки.\n` +
    `✅ Только карты региона США в долларах (USD).\n\n` +
    GIFT_PRIVACY + `\n\n` +
    `Выберите номинал:`,
    kb);
}

// Заявка создаётся БЕЗ кода: клиент отправляет код только после подключения оператора.
function askGiftWallet(ctx, units, pair, promoCode = null, payoutId = 'USDT_BEP20') {
  const s = store.get().settings;
  let opt = currencies.findPayoutOption(payoutId) || currencies.PAYOUT_OPTIONS.USDT_BEP20;
  // Если выбранную сеть отключили в настройках, возвращаемся к BEP-20.
  if (!currencies.isPayoutEnabled(s, opt)) opt = currencies.PAYOUT_OPTIONS.USDT_BEP20;
  const check = promoCode ? store.validatePromo(promoCode, { units }) : null;
  if (check && !check.ok) {
    return show(ctx, esc(check.error), new InlineKeyboard().text('↩️ К номиналу', `c:giftnom:${pair.key}`));
  }
  ensureUser(ctx);
  const loyalty = store.loyaltyStatus(uidOf(ctx));
  const feeDiscount = loyalty.eligible
    ? currencies.rateAfterFeeDiscount(s, pair.currency, loyalty.discountPercent).feeDiscountPercent
    : 0;
  const quote = currencies.giftPayout(s, units, pair.currency, check?.promo.percent, feeDiscount, opt);
  if (!quote) return assetScreen(ctx);

  // Выбор сети всегда доступен, даже если оператор выключил все сети в настройках:
  // иначе поток молча останавливался на этом шаге.
  const kb = new InlineKeyboard();
  const enabledNets = currencies.PAYOUT_OPTION_LIST.filter((o) => currencies.isPayoutEnabled(s, o));
  const nets = enabledNets.length ? enabledNets : currencies.PAYOUT_OPTION_LIST;
  nets.forEach((o, idx) => {
    const netFee = currencies.networkFeeOf(s, o);
    const active = o.id === opt.id ? '✓ ' : '';
    const suffix = o.instant ? '0%' : `-${netFee} ${o.feeUnit}`;
    // units и id сети — прямо в кнопке: шаг не зависит от памяти процесса.
    kb.text(`${active}${o.shortLabel} (${suffix})`, `c:pnet:${pair.key}:${units}:${o.id}`);
    if (idx % 2 === 1 || idx === nets.length - 1) kb.row();
  });
  kb.text('↩️ К номиналу', `c:giftnom:${pair.key}`);

  clientFlows.set(uidOf(ctx), {
    type: 'gift_wallet',
    units,
    key: pair.key,
    promoCode: promoCode || null,
    payoutId: opt.id,
  });

  const fmtQuote = (val) => fmtCrypto(val, opt.payoutCurrency, opt.decimals);
  const feeInfo = opt.instant
    ? '⚡ <b>Моментальный вывод без комиссии</b> (сеть BNB Smart Chain BEP-20).'
    : `💸 Комиссия сети <b>${esc(opt.label)}</b>: <b>${esc(fmtQuote(quote.networkFee))}</b> (до вычета: ${esc(fmtQuote(quote.grossCrypto))}).`;
  const netInfo = quote.crypto > 0
    ? `Итого к выплате за $${units}: <b>${esc(fmtQuote(quote.crypto))}</b>`
    : `⚠️ Номинала $${units} недостаточно для покрытия комиссии сети (${esc(fmtQuote(quote.networkFee))}). Выберите BEP-20 без комиссии или увеличьте номинал.`;

  return show(ctx,
    `👛 <b>Кошелёк для ${esc(opt.label)}</b>\n\n` +
    `${netInfo}\n` +
    `${feeInfo}\n` +
    (feeDiscount > 0 ? `🎉 Учтена скидка комиссии <b>${feeDiscount} п.п.</b> за каждый 5-й обмен.\n` : '') +
    `\n${esc(opt.walletHint)}\n` +
    `Если нужна другая сеть выплаты — переключите кнопками ниже.\n\n` +
    `/cancel — отмена`, kb);
}

function createGiftOrder(ctx, units, wallet, pair, promoCode = null, payoutId = 'USDT_BEP20') {
  const s = store.get().settings;
  if (!s.online) return { error: 'Обмен временно недоступен — попробуйте позже.' };
  if (!pair || pair.kind !== 'gift') return { error: 'Неизвестный тип карты.' };
  if (!currencies.isEnabled(s, pair.key)) return { error: 'Эта карта сейчас недоступна для выкупа.' };
  const opt = currencies.findPayoutOption(payoutId) || currencies.PAYOUT_OPTIONS.USDT_BEP20;
  if (!currencies.isPayoutEnabled(s, opt)) return { error: `Выплата в ${opt.label} сейчас недоступна.` };
  const unitsError = currencies.validateUnits(units);
  if (unitsError) return { error: unitsError };
  const walletError = currencies.validateWallet(wallet, opt);
  if (walletError) return { error: walletError };
  let promo = null;
  if (promoCode) {
    const check = store.validatePromo(promoCode, { units });
    if (!check.ok) return { error: check.error };
    promo = check.promo;
  }
  const usr = ensureUser(ctx);
  const loyalty = store.loyaltyStatus(uidOf(ctx));
  const feeDiscount = loyalty.eligible
    ? currencies.rateAfterFeeDiscount(s, pair.currency, loyalty.discountPercent).feeDiscountPercent
    : 0;
  const payout = currencies.giftPayout(s, units, pair.currency, promo ? promo.percent : 0, feeDiscount, opt);
  if (!payout) {
    return { error: `Курс выплаты в ${opt.payoutCurrency} временно недоступен — попробуйте позже.` };
  }
  if (!(payout.crypto > 0)) {
    return {
      error: payout.networkFee > 0
        ? `Сумма выплаты меньше комиссии сети (${payout.networkFee} ${payout.payoutCurrency}). Выберите BEP-20 без комиссии или увеличьте номинал.`
        : 'Сумма выплаты слишком мала — увеличьте номинал карты.',
    };
  }
  const order = store.createOrder({
    userId: uidOf(ctx),
    userName: ctx.from.first_name || 'Клиент',
    userUsername: ctx.from.username || null,
    expiresAt: Date.now() + (Number(pair.ttlMinutes) || 60) * 60 * 1000,
    units,
    currency: pair.currency,
    payoutId: payout.payoutId,
    payoutCurrency: payout.payoutCurrency,
    network: payout.network,
    networkFee: payout.networkFee,
    grossCrypto: payout.grossCrypto,
    wallet,
    rate: payout.rate,
    crypto: payout.crypto,
    promoId: promo ? promo.id : null,
    promoCode: promo ? promo.code : null,
    promoPercent: promo ? promo.percent : null,
    baseCrypto: promo ? payout.baseCrypto : null,
    loyaltyDiscountPercent: payout.feeDiscountPercent,
    loyaltyExchangeNumber: payout.feeDiscountPercent > 0 ? loyalty.exchangeNumber : null,
    referrer: usr && usr.referrer,
  });
  if (promo) store.consumePromo(promo.id);
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
      '📦 <b>У вас пока нет заявок.</b>\nСоздайте первый обмен — он появится здесь.',
      new InlineKeyboard().text('💱 Сдать карту', 'c:exchange').text('↩️ Меню', 'c:menu'));
  }
  const kb = new InlineKeyboard();
  for (const o of shown) {
    kb.text(`${statusIcon(o)} #${o.id} · ${shortOf(o)} · ${amountOf(o)}`, `c:order:${o.id}`).row();
  }
  kb.text('💱 Сдать карту', 'c:exchange').text('↩️ Меню', 'c:menu');
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
  // Отзыв — как на сайте: после завершённой сделки и только один раз.
  if (o.status === 'completed' && !store.getReviewByOrder(o.id)) {
    kb.row().text('⭐ Оставить отзыв', `c:rate:${o.id}`);
  }
  kb.row().text('💬 Диалог сделки', `c:chat:${o.id}`);
  kb.row().text('📦 Мои заявки', 'c:orders').text('↩️ Меню', 'c:menu');
  return kb;
};

function orderDetailText(o) {
  const head = `<b>Заявка #${o.id}</b> · ${esc(fmtDate(o.createdAt))}\n` + loyaltyLabel(o);
  if (o.status === 'new') {
    if (o.giftCode) {
      // Совместимость со старыми заявками, где код передавался при создании.
      return head +
        `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
        `🎟 Код <code>${esc(o.giftCode)}</code> уже у оператора.\n` +
        `Когда будете готовы передать карту — нажмите «Я оплатил».`;
    }
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `⏳ <b>Ждём подключения оператора</b> — обычно несколько минут.\n` +
      `<b>Ничего не отправляйте и не сообщайте код</b>, пока оператор не попросит его в этой заявке.`;
  }
  if (o.status === 'details' && !o.giftCode) {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🤝 <b>Оператор на связи.</b> Он ждёт код карты.\n` +
      `Нажмите «🎟 Отправить код карты» и пришлите код одним сообщением.`;
  }
  if (o.status === 'details' && o.giftCode) {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🔎 Код отправлен — карта на проверке. Обычно 5–15 минут.`;
  }
  if (o.status === 'paid') {
    return head +
      `🎁 ${esc(giftLabel(o))} <b>$${giftUnits(o)}</b> → ${payoutOf(o)}\n\n` +
      `🔎 Карта на проверке: оператор сверит регион (<b>США</b>), валюту (<b>USD</b>), номинал и баланс.\n` +
      `Обычно 5–15 минут.`;
  }
  if (o.status === 'completed') {
    return head +
      `🟢 <b>Завершена — валюта выдана.</b>\n` +
      `💸 Выплата ${payoutOf(o)} отправлена на кошелёк:\n<code>${esc(o.wallet)}</code>` +
      (o.completedAt ? `\n🕒 ${fmtDate(o.completedAt)}` : '') +
      (o.txUrl ? `\n🔗 ${esc(o.txUrl)}` : '');
  }
  return head + `${o.status === 'rejected' ? '🔴 Отклонена оператором.' : '⚪ Отменена.'}${o.cancelReason ? `\nПричина: ${esc(o.cancelReason)}` : ''}`;
}

async function openOrderChat(ctx, id) {
  const order = await loadOwnOrder(ctx, id);
  if (!order) return show(ctx, 'Заявка не найдена.', backMenuKb());
  clientFlows.set(uidOf(ctx), { type: 'order_chat', orderId: order.id });
  return orderChat.openTelegram(ctx, order, 'user');
}

async function receiveChat(ctx, id) {
  const order = await loadOwnOrder(ctx, id);
  if (!order) return ctx.reply('Заявка не найдена.');
  return orderChat.receiveTelegram(ctx, order, 'user');
}

async function orderDetail(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  // Если виджеты включены и Telegram их принимает — показываем карточку заявки внутри сообщения.
  const sent = await widget.trySendOrderWidget(ctx, o);
  if (sent) return;
  return show(ctx, orderDetailText(o), orderActionsKb(o));
}

/* ---------- отзывы ---------- */
// Витрина отзывов и оценка после сделки — те же данные, что в приложении.
const STARS = ['1', '2', '3', '4', '5'];

function reviewsScreen(ctx) {
  const all = store.listReviews(500);
  const summary = store.reviewSummary(all);
  const shown = all.slice(0, 5).map((r) => {
    const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    return `👤 <b>${esc(r.name)}</b> · ${stars}\n${esc(r.text.slice(0, 240))}` +
      (r.reply ? `\n↳ <i>${esc(r.reply.slice(0, 200))}</i>` : '');
  }).join('\n\n');
  const head = `⭐ <b>Отзывы клиентов</b>\n\n` +
    (summary.count ? `Средняя оценка: <b>${summary.avg.toFixed(1)} / 5</b> · ${summary.count}\n\n` : '') +
    (shown || 'Пока нет отзывов — станьте первым.');
  // Кнопка оценки — для завершённой заявки без отзыва.
  const pending = store.userOrders(uidOf(ctx))
    .find((o) => o.status === 'completed' && !store.getReviewByOrder(o.id));
  const kb = new InlineKeyboard();
  if (pending) kb.text('⭐ Оставить отзыв', `c:rate:${pending.id}`).row();
  kb.text('💱 Сдать карту', 'c:exchange').text('↩️ Меню', 'c:menu');
  return show(ctx, head, kb);
}

function ratePrompt(ctx, orderId) {
  const o = store.getOrder(orderId);
  if (!o || String(o.userId) !== uidOf(ctx)) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  if (o.status !== 'completed') return show(ctx, 'Отзыв можно оставить после завершения сделки.', orderActionsKb(o));
  if (store.getReviewByOrder(o.id)) return show(ctx, 'Вы уже оставили отзыв по этой сделке. Спасибо! ✦', new InlineKeyboard().text('⭐ Отзывы', 'c:reviews').text('↩️ Меню', 'c:menu'));
  // Оценка едет в callback_data: состояние в памяти не нужно.
  const kb = new InlineKeyboard();
  STARS.forEach((n) => kb.text(`${n} ★`, `c:ratev:${o.id}:${n}`));
  kb.row().text('↩️ К заявке', `c:order:${o.id}`);
  return show(ctx,
    `⭐ <b>Отзыв по заявке #${o.id}</b>\n\n` +
    `Сделка ${esc(giftLabel(o))} на $${giftUnits(o)} завершена.\n` +
    `Поставьте оценку — затем пришлите пару слов одним сообщением.\n\n/cancel — пропустить`,
    kb);
}

function startReview(ctx, orderId, rating) {
  const o = store.getOrder(orderId);
  const stars = Math.round(Number(rating));
  if (!o || String(o.userId) !== uidOf(ctx)) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  if (o.status !== 'completed') return show(ctx, 'Отзыв можно оставить после завершения сделки.', orderActionsKb(o));
  if (store.getReviewByOrder(o.id)) return show(ctx, 'Вы уже оставили отзыв по этой сделке. Спасибо! ✦', backMenuKb());
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) return ratePrompt(ctx, o.id);
  clientFlows.set(uidOf(ctx), { type: 'review_text', orderId: o.id, rating: stars });
  return show(ctx,
    `⭐ Оценка: <b>${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</b>\n\n` +
    `Напишите пару слов об обмене одним сообщением — отзыв появится на витрине.\n\n/cancel — пропустить`,
    new InlineKeyboard().text('↩️ К заявке', `c:order:${o.id}`));
}

/* ---------- действия клиента ---------- */

async function clientPaid(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  if (o.status === 'new' && o.giftCode) {
    const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
    bus.emit('order_event', { order: upd, type: 'paid' });
    return show(ctx, `🔎 <b>Заявка #${o.id}</b>\nКод отправлен на проверку. Обычно 5–15 минут — оператор проверит карту и выплатит ${payoutOf(o)}.`, new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ Меню', 'c:menu'));
  }
  return show(ctx, orderDetailText(o), orderActionsKb(o));
}

async function clientCancel(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  if (!['new', 'details'].includes(o.status)) {
    return show(ctx, 'Отменить можно только новую заявку или заявку в ожидании кода.', orderActionsKb(o));
  }
  if (o.status === 'cancelled' && (o.cancelReason === store.EXPIRED || o.cancelReason === store.EXPIRED_LEGACY)) {
    return show(ctx, 'Время на сделку истекло. Создайте новую заявку.', backMenuKb());
  }
  const upd = store.updateOrder(o.id, { status: 'cancelled' });
  if (upd && upd.promoId && !upd.promoReleased) store.releaseOrderPromo(upd.id);
  bus.emit('order_event', { order: upd, type: 'cancelled' });
  return show(ctx, `⚪ <b>Заявка #${o.id} отменена.</b>`, new InlineKeyboard().text('💱 Новый обмен', 'c:exchange').text('↩️ Меню', 'c:menu'));
}

/* ---------- прочее: информация, рефералы, поддержка ---------- */

function infoScreen(ctx) {
  const s = store.get().settings;
  return show(ctx,
    `ℹ️ <b>Pricelex Worldwide | Official</b>\n\n` +
    `Моментальный вывод без комиссии — USDT (BEP-20); также доступны Bitcoin (BTC), TRC-20, ERC-20 и TON по комиссии сети:\n${rateListText()}\n\n` +
    `Статус: ${s.online ? '🟢 Онлайн' : '🔴 Оффлайн'}\n\n` +
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
    `Ваша ссылка навсегда закрепляет друга за вами.\n\n` +
    (link ? `Ваша ссылка:\n<code>${link}</code>\n\n` : 'Ссылка появится после подключения бота.\n\n') +
    `Приглашено: <b>${me?.referredCount || 0}</b>`,
    backMenuKb());
}

function supportPrompt(ctx) {
  clientFlows.set(uidOf(ctx), { type: 'support' });
  return show(ctx,
    `💬 <b>Поддержка Pricelex Worldwide</b>\n\nНапишите вопрос одним сообщением — передадим оператору.\nОтвет придёт сюда и в приложение.\n\n/cancel — отмена`,
    new InlineKeyboard().text('↩️ Меню', 'c:menu'));
}

/* ---------- действия виджета (без отрисовки — виджет обновляется сам) ---------- */

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
  if (upd && upd.promoId && !upd.promoReleased) store.releaseOrderPromo(upd.id);
  bus.emit('order_event', { order: upd, type: 'cancelled' });
  return { ok: 1, order: upd };
}

/* ---------- вход: /start, /menu ---------- */

async function clientStart(ctx, refParam = '') {
  if (!isPrivate(ctx)) return;
  ensureUser(ctx, refParam);
  // Если виджеты включены и Telegram их принимает — показываем виджет с курсами вместо меню.
  if (await widget.trySendRatesWidget(ctx)) return;
  return clientMenu(ctx);
}

/* ---------- выбор сети ---------- */
// Форматы callback_data (все поддержаны, чтобы старые сообщения в чатах работали):
//   c:pnet:<netId>                  — самый первый вариант
//   c:pnet:<units>:<netId>          — номинал без карты
//   c:pnet:<key>:<units>:<netId>    — текущий: карта и номинал едут вместе с кнопкой
// Благодаря этому шаг не «зависает», если состояние потока потерялось
// (рестарт процесса, другой инстанс, очистка базы).
function parsePnet(data) {
  const parts = String(data).slice('c:pnet:'.length).split(':').filter(Boolean);
  const netId = parts.length ? parts[parts.length - 1] : '';
  const nums = parts.filter((p) => /^\d+$/.test(p));
  const keyPart = parts.find((p) => {
    const pair = currencies.get(p);
    return pair && pair.kind === 'gift';
  });
  return {
    netId,
    units: nums.length ? parseInt(nums[0], 10) : null,
    key: keyPart || null,
  };
}

function selectNetwork(ctx, data) {
  const parsed = parsePnet(data);
  const flow = clientFlows.get(uidOf(ctx));
  const key = parsed.key || (flow && flow.key) || currencies.GIFT_KEY;
  const pair = currencies.get(key);
  const units = Number.isFinite(parsed.units) ? parsed.units : flow && flow.units;
  if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
  if (!Number.isFinite(units) || currencies.validateUnits(units)) {
    return show(ctx,
      'Не получилось вспомнить номинал. Выберите его заново — это один шаг.',
      new InlineKeyboard().text('🎁 К номиналу', `c:giftnom:${pair.key}`));
  }
  return askGiftWallet(ctx, units, pair, flow && flow.key === pair.key ? flow.promoCode || null : null, parsed.netId);
}

/* ---------- маршрутизация входящих ---------- */

async function handleClientCallback(ctx, d) {
  if (!isPrivate(ctx)) return ctx.answerCallbackQuery({ text: '' }).catch(() => {});
  await ctx.answerCallbackQuery().catch(() => {});
  const file = d.match(/^c:file:(\d+):(\d+)$/);
  if (file) return orderChat.sendFile(ctx, await loadOwnOrder(ctx, Number(file[1])), Number(file[2]));
  if (clientFlows.get(uidOf(ctx))?.type === 'order_chat') clientFlows.delete(uidOf(ctx));
  if (d.startsWith('c:chat:')) return openOrderChat(ctx, Number(d.slice(7)));
  if (d === 'c:menu') return clientMenu(ctx);
  if (d === 'c:exchange') return assetScreen(ctx);
  if (d === 'c:orders') return ordersList(ctx);
  if (d === 'c:info') return infoScreen(ctx);
  if (d === 'c:refs') return refsScreen(ctx);
  if (d === 'c:reviews') return reviewsScreen(ctx);
  if (d.startsWith('c:ratev:')) {
    const [, , orderId, rating] = d.split(':');
    return startReview(ctx, orderId, rating);
  }
  if (d.startsWith('c:rate:')) return ratePrompt(ctx, Number(d.slice('c:rate:'.length)));
  if (d === 'c:support') return supportPrompt(ctx);
  if (d === 'c:giftnom' || d.startsWith('c:giftnom:')) {
    const flow = clientFlows.get(uidOf(ctx));
    const key = d === 'c:giftnom' ? currencies.GIFT_KEY : d.slice('c:giftnom:'.length);
    const pair = currencies.get(key);
    const s = store.get().settings;
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    if (!currencies.isEnabled(s, pair.key) || !currencies.rateOf(s, pair.currency)) {
      return show(ctx, 'Эта карта сейчас недоступна. Выберите другую или загляните позже.', assetKb());
    }
    const existingPromo = flow && flow.promoCode && flow.key === pair.key ? store.validatePromo(flow.promoCode).promo || null : null;
    return giftIntro(ctx, pair, existingPromo);
  }
  if (d.startsWith('c:promo:')) {
    const key = d.slice('c:promo:'.length) || currencies.GIFT_KEY;
    const pair = currencies.get(key);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    clientFlows.set(uidOf(ctx), { type: 'gift_promo', key: pair.key });
    return show(ctx,
      '🏷 <b>Промокод на обмен</b>\n\nПришлите промокод одним сообщением:\n\n/cancel — отмена',
      new InlineKeyboard().text('↩️ К номиналу', `c:giftnom:${pair.key}`));
  }
  if (d.startsWith('c:promoclear:')) {
    const key = d.slice('c:promoclear:'.length) || currencies.GIFT_KEY;
    const pair = currencies.get(key);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    return giftIntro(ctx, pair, null);
  }
  if (d === 'c:giftnum' || d.startsWith('c:giftnum:')) {
    const flow = clientFlows.get(uidOf(ctx));
    const key = d === 'c:giftnum' ? flow?.key || currencies.GIFT_KEY : d.slice('c:giftnum:'.length);
    const pair = currencies.get(key);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    clientFlows.set(uidOf(ctx), { type: 'gift_units', key: pair.key, promoCode: flow?.promoCode || null });
    return show(ctx,
      'Введите номинал карты в $ (кратно $10, минимум $10):\n\n/cancel — отмена',
      new InlineKeyboard().text('↩️ К номиналу', `c:giftnom:${pair.key}`));
  }
  if (d.startsWith('c:pnet:')) {
    return selectNetwork(ctx, d);
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
      return show(ctx, 'Эта карта сейчас недоступна. Выберите другую или загляните позже.', assetKb());
    }
    if (!Number.isFinite(units) || currencies.validateUnits(units)) return giftIntro(ctx, pair);
    return askGiftWallet(ctx, units, pair, flow && flow.key === pair.key ? flow.promoCode : null, flow?.payoutId || 'USDT_BEP20');
  }
  if (d.startsWith('c:buy:')) {
    const pair = currencies.get(d.slice('c:buy:'.length));
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    const s = store.get().settings;
    if (!currencies.isEnabled(s, pair.key) || !currencies.rateOf(s, pair.currency)) {
      return show(ctx, `${esc(pair.label)} сейчас недоступна для выкупа. Выберите другую карту.`, assetKb());
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
      `🎟 <b>Код карты ${esc(giftLabel(o))} на $${giftUnits(o)}</b>\n\nОператор в заявке и ждёт код. Пришлите код карты (например XXXX-XXXX-XXXX-XXXX) одним сообщением.\n\n/cancel — отмена`,
      new InlineKeyboard().text('↩️ К заявке', `c:order:${o.id}`));
  }
  if (d.startsWith('c:paid:')) return clientPaid(ctx, Number(d.slice(7)));
  if (d.startsWith('c:cancel:')) return clientCancel(ctx, Number(d.slice(9)));
  return clientMenu(ctx);
}

async function handleClientText(ctx) {
  if (!isPrivate(ctx)) return;
  const text = (ctx.message.text || '').trim();
  // /cancel в любой точке потока — возврат в меню.
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^(отмен\w*|cancel)$/i.test(text)) {
    clientFlows.delete(uidOf(ctx));
    return clientMenu(ctx);
  }
  const f = clientFlows.get(uidOf(ctx));
  const s = store.get().settings;
  if (!f) {
    return ctx.reply('Я здесь, чтобы помочь с обменом 🌌\nОткройте меню — или нажмите /menu.', { reply_markup: menuKb(s) });
  }
  if (f.type === 'order_chat') return receiveChat(ctx, f.orderId);
  if (f.type === 'gift_promo') {
    const pair = currencies.get(f.key || currencies.GIFT_KEY);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    const check = store.validatePromo(text);
    if (!check.ok) {
      return ctx.reply(`⚠️ ${check.error} Попробуйте другой промокод или нажмите /cancel.`);
    }
    return giftIntro(ctx, pair, check.promo);
  }
  if (f.type === 'gift_units') {
    const pair = currencies.get(f.key || currencies.GIFT_KEY);
    if (!pair || pair.kind !== 'gift') return assetScreen(ctx);
    const n = parseNum(text);
    const units = currencies.floorUnits(n);
    if (!Number.isFinite(n) || currencies.validateUnits(units)) {
      return ctx.reply('Минимум $10, шаг $10. Например: 20');
    }
    return askGiftWallet(ctx, units, pair, f.promoCode || null, f.payoutId || 'USDT_BEP20');
  }
  if (f.type === 'gift_wallet') {
    const wallet = text.trim();
    const units = f.units;
    const pair = currencies.get(f.key || currencies.GIFT_KEY);
    const { order, error } = createGiftOrder(ctx, units, wallet, pair, f.promoCode || null, f.payoutId || 'USDT_BEP20');
    if (error) return ctx.reply(`⚠️ ${error}`);
    clientFlows.delete(uidOf(ctx));
    return show(ctx,
      `✅ <b>Заявка #${order.id} создана!</b>\n\n` +
      `🎁 ${esc(giftLabel(order))} <b>$${giftUnits(order)}</b> → <b>${payoutOf(order)}</b>\n` +
      (order.promoCode ? `🏷 Промокод <b>${esc(order.promoCode)}</b> (+${order.promoPercent}%)\n` : '') +
      loyaltyLabel(order) +
      `\n⏳ <b>Ждём подключения оператора</b> — дождитесь его сигнала в этом чате.\n` +
      `<b>Ничего не отправляйте и не сообщайте код карты</b>, пока оператор не попросит. На сделку — 1 час.`,
      new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('❌ Отменить', `c:cancel:${order.id}`));
  }
  if (f.type === 'gift_send_code') {
    const code = text.replace(/\s+/g, ' ').trim();
    if (code.length < 8 || code.length > 200 || /\s{2,}/.test(code)) {
      return ctx.reply('Код слишком короткий или содержит двойные пробелы (минимум 8 символов). Попробуйте ещё раз:');
    }
    const o = await loadOwnOrder(ctx, f.orderId);
    if (!o) { clientFlows.delete(uidOf(ctx)); return show(ctx, '🚫 Заявка не найдена.', backMenuKb()); }
    if (!isGiftOrder(o)) { clientFlows.delete(uidOf(ctx)); return show(ctx, 'Это не заявка на карту.', backMenuKb()); }
    if (o.status === 'paid') { clientFlows.delete(uidOf(ctx)); return show(ctx, orderDetailText(o), orderActionsKb(o)); }
    if (o.status !== 'details' && o.status !== 'new') {
      clientFlows.delete(uidOf(ctx));
      return show(ctx, 'Сейчас код для этой заявки не принимается.', orderActionsKb(o));
    }
    if (o.status === 'new' && !o.giftCode) {
      return ctx.reply('⏳ Оператор ещё не подключился. <b>Ничего не отправляйте</b> — дождитесь его сигнала.');
    }
    const upd = store.updateOrder(o.id, { giftCode: code, status: 'paid', paidAt: Date.now() });
    clientFlows.delete(uidOf(ctx));
    bus.emit('order_event', { order: upd, type: 'paid' });
    return show(ctx,
      `🔎 <b>Заявка #${o.id}: код отправлен оператору.</b>\nПроверка обычно занимает 5–15 минут. Выплата — ${payoutOf(upd)}.`,
      new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ Меню', 'c:menu'));
  }
  if (f.type === 'review_text') {
    const o = await loadOwnOrder(ctx, f.orderId);
    clientFlows.delete(uidOf(ctx));
    if (!o || o.status !== 'completed') return show(ctx, 'Заявка уже недоступна для отзыва.', backMenuKb());
    if (store.getReviewByOrder(o.id)) return show(ctx, 'Вы уже оставили отзыв по этой сделке. Спасибо! ✦', backMenuKb());
    const user = ensureUser(ctx);
    store.createReview({
      userId: uidOf(ctx),
      orderId: o.id,
      name: user && user.name ? user.name : (ctx.from.first_name || 'Клиент'),
      rating: f.rating,
      text: text.slice(0, 1000),
      source: 'order',
    });
    return show(ctx,
      `🙏 <b>Спасибо за отзыв!</b>\n\nОценка: ${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)}\nОн уже виден в приложении и в боте.`,
      new InlineKeyboard().text('⭐ Все отзывы', 'c:reviews').text('↩️ Меню', 'c:menu'));
  }
  if (f.type === 'support') {
    ensureUser(ctx);
    const message = store.createSupportMessage(uidOf(ctx), 'user', text.slice(0, 2000));
    bus.emit('support_message', { message, user: { id: uidOf(ctx), first_name: ctx.from.first_name, username: ctx.from.username || null } });
    clientFlows.delete(uidOf(ctx));
    return show(ctx, '✅ <b>Передано оператору.</b>\nОтветим здесь и в чате поддержки приложения.', backMenuKb());
  }
  clientFlows.delete(uidOf(ctx));
  return ctx.reply('Что-то пошло не так — начнём сначала.', { reply_markup: menuKb(s) });
}

// Only route media into an explicitly selected order, never guess from active deals.
async function handleClientDocument(ctx) {
  if (!isPrivate(ctx)) return;
  const flow = clientFlows.get(uidOf(ctx));
  if (flow?.type === 'order_chat') return receiveChat(ctx, flow.orderId);
  return ctx.reply('Чтобы отправить вложение, откройте «Мои заявки» → нужную сделку → «💬 Диалог сделки».');
}

module.exports = {
  clientStart, // точка входа для /start и /menu (ensureUser + виджет-или-меню)
  sendClientMenu: clientMenu, // обычное меню — используется из виджета («Обмен»)
  handleClientCallback,
  handleClientText,
  handleClientDocument,
  openOrderChat,
  sendLinkCode,
  clientPaidWidget,
  clientCancelWidget,
  GIFT_PRIVACY,
};
