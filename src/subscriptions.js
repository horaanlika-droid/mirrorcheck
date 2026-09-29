// Ежемесячная плата за площадку.
// Комиссии с залога и сделок нет. Единственный платёж партнёра — фиксированная
// ежемесячная подписка на доступ к сервису через интеграцию Tribute.
// Статус подписки обновляется по подтверждённому событию оплаты; не принимаем
// деньги клиентской сделки через Pricelex. Если доступ обязателен только при оплате,
// не маркируем подписку как добровольное пожертвование. Не включаем криптовалютную
// оплату подписки до отдельного подтверждения её допустимости.
// Если платёж обязателен для доступа, обозначаем его утверждённым договорным
// названием — «Минимальный донат» (тариф за доступ к сервису).
// Если платёж добровольный, не связываем его с доступом к франшизе.
// Не считаем, что использование Tribute или другого внешнего платёжного сервиса меняет
// правовую природу платежа.
// Не включаем приём BTC в оплату услуг Pricelex по умолчанию. Оставляем такой способ
// выключенным feature flag'ом до отдельного документированного подтверждения применимого
// правового режима. Не удерживаем этот платёж из залога.

const store = require('./store');
const audit = require('./audit');

const PROVIDER = 'tribute';
const TRIBUTE_BTC_ENABLED = process.env.TRIBUTE_BTC_ENABLED === '1'; // по умолчанию выключено
const SUBSCRIPTION_REQUIRED = process.env.SUBSCRIPTION_REQUIRED === '1'; // конфигурируемое условие минимального ежемесячного платежа
const SUBSCRIPTION_AMOUNT_RUB = Number(process.env.SUBSCRIPTION_AMOUNT_RUB) || 200;
const SUBSCRIPTION_CURRENCY = 'RUB';

// Статусы подписки
const STATUSES = ['pending', 'active', 'past_due', 'unpaid', 'cancelled'];

function getSubscription(exchangerId) {
  const sub = (store.get().subscriptions || []).find((s) => String(s.exchangerId) === String(exchangerId));
  return sub ? { ...sub } : null;
}

function listSubscriptions({ status } = {}) {
  let list = (store.get().subscriptions || []).slice();
  if (status) list = list.filter((s) => s.status === status);
  return list.map((s) => ({ ...s }));
}

function createOrUpdateSubscription(exchangerId, { status, externalId, amount, currency, currentPeriodStart, currentPeriodEnd, lastPaymentAt }) {
  return store.mutate((db) => {
    if (!Array.isArray(db.subscriptions)) db.subscriptions = [];
    let sub = db.subscriptions.find((s) => String(s.exchangerId) === String(exchangerId));
    const now = Date.now();
    if (!sub) {
      sub = {
        exchangerId: String(exchangerId),
        provider: PROVIDER,
        status: status || 'pending',
        externalId: externalId ? String(externalId) : null,
        amount: amount != null ? Number(amount) : SUBSCRIPTION_AMOUNT_RUB,
        currency: currency || SUBSCRIPTION_CURRENCY,
        currentPeriodStart: currentPeriodStart || now,
        currentPeriodEnd: currentPeriodEnd || now + 30 * 24 * 3600 * 1000,
        lastPaymentAt: lastPaymentAt || null,
        lastEventAt: now,
        createdAt: now,
        updatedAt: now,
      };
      db.subscriptions.push(sub);
    } else {
      if (status) sub.status = status;
      if (externalId) sub.externalId = String(externalId);
      if (amount != null) sub.amount = Number(amount);
      if (currency) sub.currency = currency;
      if (currentPeriodStart) sub.currentPeriodStart = currentPeriodStart;
      if (currentPeriodEnd) sub.currentPeriodEnd = currentPeriodEnd;
      if (lastPaymentAt) sub.lastPaymentAt = lastPaymentAt;
      sub.lastEventAt = now;
      sub.updatedAt = now;
    }
    return { ...sub };
  });
}

// Обработка подтверждённого события оплаты от Tribute.
// Статус обновляется только по подтверждённому событию, не по инициативе клиента.
function handleTributeWebhook(event) {
  // Ожидаемый формат события (упрощённо, документирован в README интеграции Tribute):
  // { type: 'payment.succeeded' | 'payment.failed', data: { exchangerId, externalId, amount, currency, periodEnd } }
  // В реальности — подпись и проверка. Здесь — тестовая реализация с проверкой структуры.
  if (!event || typeof event !== 'object') throw new Error('Некорректное событие Tribute');
  const { type, data } = event;
  if (!type || !data) throw new Error('Событие Tribute должно содержать type и data');
  if (!['payment.succeeded', 'payment.failed', 'subscription.renewed', 'subscription.cancelled'].includes(type)) {
    throw new Error(`Неизвестный тип события Tribute: ${type}`);
  }
  const exchangerId = data.exchangerId || data.exchanger_id;
  if (!exchangerId) throw new Error('exchangerId обязателен в событии Tribute');

  const now = Date.now();
  let status;
  if (type === 'payment.succeeded' || type === 'subscription.renewed') status = 'active';
  else if (type === 'payment.failed') status = 'past_due';
  else if (type === 'subscription.cancelled') status = 'cancelled';

  const sub = createOrUpdateSubscription(exchangerId, {
    status,
    externalId: data.externalId || data.id,
    amount: data.amount,
    currency: data.currency,
    currentPeriodStart: now,
    currentPeriodEnd: data.periodEnd || data.currentPeriodEnd || now + 30 * 24 * 3600 * 1000,
    lastPaymentAt: type === 'payment.succeeded' ? now : undefined,
  });

  audit.log({
    actorId: `tribute_webhook`,
    action: `subscription_${type}`,
    targetType: 'subscription',
    targetId: exchangerId,
    details: { type, data, newStatus: status },
  });

  return sub;
}

function isAccessAllowed(exchangerId) {
  if (!SUBSCRIPTION_REQUIRED) {
    return { ok: true, required: false, reason: 'subscription_not_required' };
  }
  const sub = getSubscription(exchangerId);
  if (!sub) return { ok: false, required: true, reason: 'no_subscription', status: 'unpaid' };
  if (sub.status === 'active' && sub.currentPeriodEnd > Date.now()) {
    return { ok: true, required: true, status: sub.status, until: sub.currentPeriodEnd };
  }
  return { ok: false, required: true, reason: 'subscription_inactive', status: sub.status, until: sub.currentPeriodEnd };
}

function getSubscriptionConfig() {
  return {
    provider: PROVIDER,
    required: SUBSCRIPTION_REQUIRED,
    amount: SUBSCRIPTION_AMOUNT_RUB,
    currency: SUBSCRIPTION_CURRENCY,
    btcEnabled: TRIBUTE_BTC_ENABLED,
    label: SUBSCRIPTION_REQUIRED ? 'Минимальный донат' : 'Минимальный донат (опционально)',
    note: 'У Pricelex нет процента с оборота, сделки или залога. Единственный платёж партнёра — фиксированная ежемесячная подписка на доступ к сервису через интеграцию Tribute. Статус подписки обновляется по подтверждённому событию оплаты; не принимаем деньги клиентской сделки через Pricelex. Если доступ обязателен только при оплате, не маркируем подписку как добровольное пожертвование. Не включаем криптовалютную оплату подписки до отдельного подтверждения её допустимости. Не удерживаем этот платёж из залога.',
    btcPaymentDisabledReason: TRIBUTE_BTC_ENABLED ? null : 'Приём BTC в оплату услуг Pricelex выключен feature flag\'ом до отдельного документированного подтверждения применимого правового режима.',
  };
}

module.exports = {
  STATUSES,
  PROVIDER,
  TRIBUTE_BTC_ENABLED,
  SUBSCRIPTION_REQUIRED,
  SUBSCRIPTION_AMOUNT_RUB,
  getSubscription,
  listSubscriptions,
  createOrUpdateSubscription,
  handleTributeWebhook,
  isAccessAllowed,
  getSubscriptionConfig,
};
