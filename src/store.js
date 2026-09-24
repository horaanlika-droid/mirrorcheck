const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const defaults = () => ({
  seq: 1,
  supportSeq: 1,
  reviewSeq: 1,
  settings: {
    rateBTC: 10250000, // ₽ за 1 BTC (итоговый, с комиссией)
    rateGRAM: 125, // ₽ за 1 GRAM (стартовый курс, итоговый с комиссией)
    baseRateBTC: null, // официальный курс BTC без комиссии (авто)
    baseRateGRAM: null, // официальный курс GRAM без комиссии (авто)
    feePercent: 2, // комиссия обменника, % поверх официального курса
    rateUpdatedAt: null,
    rateSource: 'manual',
    minRub: 3000,
    maxRub: 300000,
    online: true,
    announcement:
      '🚀 PRICELEX официально начинает работу! Принимаем заявки на обмен BTC и GRAM. Минимальная сумма обмена — от 3 000 ₽.',
    refPercent: 1,
    brokerPercent: 10, // доля брокера от крипто-суммы завершённой сделки, %
    operator: '@pricelex_support', // внутренний контакт операторов (клиентам не показываем)
    channel: 'https://t.me/pricelex_channel',
    chat: 'https://t.me/pricelex_chat',
    publicUrl: null,
    botUsername: null,
  },
  admins: [], // дополнительные операторы; владельцы задаются через окружение
  users: {},
  orders: [],
  flags: {},
  support: [], // чат поддержки: { id, userId, from: 'user'|'admin', text, at }
  rateHistory: [], // наблюдения курса: { at, btc, gram } — основа графика в приложении
  // Отзывы: { id, userId, orderId, name, rating 1–5, text, status, source, createdAt, updatedAt, adminMsgIds }
  // status: 'pending' (модерация) | 'approved' (опубликован) | 'rejected' (скрыт)
  reviews: [],
  // Брокеры площадки: логин/пароль выдаёт администрация в боте.
  // { id, login, pass, name, tgId, active, earnedBTC, pendingBTC, paidBTC, createdAt }
  brokers: [],
  brokerSeq: 1,
  // Заявки клиентов «Стать брокером» из приложения:
  // { id, userId, name, username, contact, experience, status, createdAt, processedAt }
  brokerApps: [],
  brokerAppSeq: 1,
  // Заявки брокеров на выплату: { id, brokerId, amountBTC, address, status, createdAt, paidAt }
  payouts: [],
  payoutSeq: 1,
});

const OLD_OPERATOR_DEFAULTS = ['@pricelex_operator', '@stonym0ntana'];

// Выплата брокеру доступна от этой суммы BTC (в любое время, через бота).
const BROKER_MIN_PAYOUT = 0.0002;

// График курса в Web App строится только по реальным наблюдениям:
// каждое успешное автообновление курса добавляет точку. Храним неделю.
const RATE_HISTORY_MAX = 2016;

let db = null;
let saveTimer = null;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = Object.assign(defaults(), raw);
      db.settings = Object.assign(defaults().settings, raw.settings || {});
      // Миграция старых баз и переименование второй валюты LTC → GRAM.
      if (raw.settings?.rateGRAM == null && raw.settings?.rateLTC != null) {
        db.settings.rateGRAM = raw.settings.rateLTC;
      }
      if (raw.settings?.baseRateGRAM == null && raw.settings?.baseRateLTC != null) {
        db.settings.baseRateGRAM = raw.settings.baseRateLTC;
      }
      delete db.settings.rateLTC;
      delete db.settings.baseRateLTC;
      // Старые активные заявки продолжают отображаться уже под новым тикером.
      for (const o of db.orders || []) {
        if (o.currency === 'LTC') o.currency = 'GRAM';
      }
      if (!Array.isArray(db.support)) db.support = [];
      if (!Number.isFinite(db.supportSeq)) db.supportSeq = (db.support?.length || 0) + 1;
      if (!Array.isArray(db.rateHistory)) db.rateHistory = [];
      if (!Array.isArray(db.reviews)) db.reviews = [];
      if (!Number.isFinite(db.reviewSeq)) db.reviewSeq = db.reviews.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
      // Брокерская подсистема: аккаунты, заявки кандидатов, выплаты.
      if (!Array.isArray(db.brokers)) db.brokers = [];
      if (!Array.isArray(db.brokerApps)) db.brokerApps = [];
      if (!Array.isArray(db.payouts)) db.payouts = [];
      if (!Number.isFinite(db.brokerSeq)) db.brokerSeq = db.brokers.reduce((m, b) => Math.max(m, b.id || 0), 0) + 1;
      if (!Number.isFinite(db.brokerAppSeq)) db.brokerAppSeq = db.brokerApps.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
      if (!Number.isFinite(db.payoutSeq)) db.payoutSeq = db.payouts.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
      if (db.settings.brokerPercent == null) db.settings.brokerPercent = 10;
      // Поддержка уехала из клиентских контактов: обновляем нетронутое старое значение.
      if (!db.settings.operator || OLD_OPERATOR_DEFAULTS.includes(db.settings.operator)) {
        db.settings.operator = defaults().settings.operator;
      }
      db.rateHistory = db.rateHistory.filter(
        (p) => p && Number.isFinite(Number(p.at)) && Number(p.btc) > 0 && Number(p.gram) > 0
      );
      for (const o of db.orders || []) {
        if (o.txUrl === undefined) o.txUrl = null;
        if (o.txHash === undefined) o.txHash = null;
      }
      return;
    }
  } catch (e) {
    console.error('[store] load error:', e.message);
  }
  db = defaults();
  save();
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[store] save error:', e.message);
    }
  }, 150);
}

const get = () => db;
const mutate = (fn) => {
  const r = fn(db);
  save();
  return r;
};

function publicSettings() {
  const s = db.settings;
  // Клиенту отдаём только итоговые курсы (комиссия уже зашита внутрь).
  // feePercent и базовые курсы не светим — это видит только оператор в боте.
  return {
    rateBTC: s.rateBTC,
    rateGRAM: s.rateGRAM,
    rateUpdatedAt: s.rateUpdatedAt,
    minRub: s.minRub,
    maxRub: s.maxRub,
    online: !!s.online,
    announcement: s.announcement,
    refPercent: s.refPercent,
    operator: s.operator,
    channel: s.channel,
    chat: s.chat,
    botUsername: s.botUsername,
  };
}

function touchUser(u, refParam) {
  return mutate((d) => {
    const id = String(u.id);
    let user = d.users[id];
    if (!user) {
      user = d.users[id] = {
        id,
        name: u.first_name || u.name || 'Клиент',
        username: u.username || null,
        referrer: null,
        referredCount: 0,
        referredIds: [],
        createdAt: Date.now(),
      };
    }
    user.lastSeen = Date.now();
    if (u.first_name) user.name = u.first_name;
    if (u.username) user.username = u.username;
    if (refParam && !user.referrer) {
      const m = String(refParam).match(/^ref(\d{3,})$/);
      if (m && m[1] !== id) {
        user.referrer = m[1];
        const r = d.users[m[1]];
        if (r) {
          r.referredCount = (r.referredCount || 0) + 1;
          (r.referredIds = r.referredIds || []).push(id);
        } else {
          d.users[m[1]] = {
            id: m[1],
            name: '—',
            username: null,
            referrer: null,
            referredCount: 1,
            referredIds: [id],
            createdAt: Date.now(),
          };
        }
      }
    }
    return user;
  });
}

const getUser = (id) => db.users[String(id)] || null;

function createOrder(o) {
  return mutate((d) => {
    const order = {
      id: d.seq++,
      userId: o.userId,
      userName: o.userName || 'Клиент',
      userUsername: o.userUsername || null,
      rub: o.rub,
      currency: o.currency,
      wallet: o.wallet,
      rate: o.rate,
      crypto: o.crypto,
      status: 'new',
      requisites: null,
      payRub: null,
      receipt: null, // { name, size, at } — чек PDF от клиента
      txUrl: null, // ссылка на блокчейн транзакцию (опционально после подтверждения)
      referrer: o.referrer || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      adminMsgIds: {},
      version: 0,
    };
    d.orders.push(order);
    return order;
  });
}

const getOrder = (id) => db.orders.find((o) => o.id === Number(id)) || null;

// Чек не конфликтует с вводом оператора, поэтому версию заявки не трогаем.
function setReceipt(id, receipt) {
  return mutate((d) => {
    const o = d.orders.find((x) => x.id === Number(id));
    if (!o) return null;
    o.receipt = receipt;
    o.updatedAt = Date.now();
    return o;
  });
}

function updateOrder(id, patch) {
  return mutate((d) => {
    const o = d.orders.find((x) => x.id === Number(id));
    if (!o) return null;
    Object.assign(o, patch, { updatedAt: Date.now(), version: (o.version || 0) + 1 });
    return o;
  });
}

const userOrders = (userId) =>
  db.orders.filter((o) => o.userId === String(userId)).sort((a, b) => b.createdAt - a.createdAt);

const activeOrders = () => db.orders.filter((o) => ['new', 'details', 'paid'].includes(o.status));

function stats() {
  const by = (s) => db.orders.filter((o) => o.status === s);
  const done = by('completed');
  return {
    total: db.orders.length,
    new: by('new').length,
    details: by('details').length,
    paid: by('paid').length,
    completed: done.length,
    rejected: by('rejected').length + by('cancelled').length,
    volumeDone: done.reduce((s, o) => s + (o.payRub || o.rub), 0),
    users: Object.keys(db.users).length,
    refs: Object.values(db.users).filter((u) => u.referrer).length,
  };
}

/* ---------- история курса для графика ---------- */
// Записываем только фактические наблюдения курса (автообновление или ручная правка).
function pushRatePoint({ btc, gram, at = Date.now() } = {}) {
  const b = Math.round(Number(btc));
  const g = Math.round(Number(gram));
  if (!Number.isFinite(b) || !Number.isFinite(g) || b <= 0 || g <= 0) return null;
  return mutate((d) => {
    if (!Array.isArray(d.rateHistory)) d.rateHistory = [];
    const last = d.rateHistory[d.rateHistory.length - 1];
    if (last && last.btc === b && last.gram === g && at - last.at < 30000) return last;
    const point = { at, btc: b, gram: g };
    d.rateHistory.push(point);
    if (d.rateHistory.length > RATE_HISTORY_MAX) d.rateHistory.splice(0, d.rateHistory.length - RATE_HISTORY_MAX);
    return point;
  });
}

// Точки окна [since; ∞) с прореживанием до maxPoints (последняя всегда сохраняется).
function rateHistorySince(since = 0, maxPoints = 180) {
  const all = (db.rateHistory || []).filter((p) => p.at >= since);
  const limit = Math.max(2, Number(maxPoints) || 180);
  if (all.length <= limit) return all.slice();
  const step = Math.ceil(all.length / limit);
  const out = all.filter((_, i) => i % step === 0);
  const last = all[all.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/* ---------- support chat ---------- */
function createSupportMessage(userId, from, text) {
  return mutate((d) => {
    const msg = {
      id: d.supportSeq++,
      userId: String(userId),
      from, // 'user' | 'admin'
      text: String(text).slice(0, 2000),
      at: Date.now(),
    };
    d.support.push(msg);
    // ограничим хранение последними 5000 сообщениями
    if (d.support.length > 5000) d.support.splice(0, d.support.length - 5000);
    // обновим lastSeen пользователя если есть
    const u = d.users[String(userId)];
    if (u) u.lastSupportAt = msg.at;
    return msg;
  });
}

function getSupportMessages(userId) {
  return db.support
    .filter((m) => m.userId === String(userId))
    .sort((a, b) => a.at - b.at)
    .slice(-200);
}

function getSupportThreads() {
  const map = new Map();
  for (const m of db.support) {
    const prev = map.get(m.userId);
    if (!prev || m.at > prev.lastAt) {
      map.set(m.userId, { userId: m.userId, lastAt: m.at, lastText: m.text, lastFrom: m.from });
    }
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/* ---------- отзывы ---------- */
const REVIEW_TEXT_MAX = 1000;
const clampRating = (n) => Math.min(5, Math.max(1, Math.round(Number(n) || 5)));

function createReview(r) {
  return mutate((d) => {
    const now = Date.now();
    const review = {
      id: d.reviewSeq++,
      userId: r.userId != null ? String(r.userId) : null,
      orderId: r.orderId != null ? Number(r.orderId) : null,
      name: String(r.name || 'Клиент').trim().slice(0, 60) || 'Клиент',
      rating: clampRating(r.rating),
      text: String(r.text || '').trim().slice(0, REVIEW_TEXT_MAX),
      status: r.status || 'pending',
      source: r.source || 'user', // 'user' | 'admin'
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt : now,
      updatedAt: now,
      adminMsgIds: {},
    };
    d.reviews.push(review);
    return review;
  });
}

const getReview = (id) => db.reviews.find((r) => r.id === Number(id)) || null;

function updateReview(id, patch) {
  return mutate((d) => {
    const r = d.reviews.find((x) => x.id === Number(id));
    if (!r) return null;
    const p = { ...patch };
    if (p.rating != null) p.rating = clampRating(p.rating);
    if (p.name != null) p.name = String(p.name).trim().slice(0, 60) || r.name;
    if (p.text != null) p.text = String(p.text).trim().slice(0, REVIEW_TEXT_MAX);
    Object.assign(r, p, { updatedAt: Date.now() });
    return r;
  });
}

function deleteReview(id) {
  return mutate((d) => {
    const i = d.reviews.findIndex((x) => x.id === Number(id));
    if (i < 0) return null;
    return d.reviews.splice(i, 1)[0];
  });
}

const reviewsByStatus = (status) =>
  db.reviews.filter((r) => !status || r.status === status).sort((a, b) => b.createdAt - a.createdAt);

const publicReview = (r) => ({ id: r.id, name: r.name, rating: r.rating, text: r.text, createdAt: r.createdAt });

// Автор всегда видит свои отзывы как опубликованные — о модерации клиент не знает.
// Остальные видят только одобренные.
function publicReviews(limit = 100, viewerId = null) {
  const viewer = viewerId != null ? String(viewerId) : null;
  const list = reviewsByStatus().filter((r) => r.status === 'approved' || (viewer && r.userId === viewer));
  const count = list.length;
  const avg = count ? list.reduce((s, r) => s + r.rating, 0) / count : 0;
  return { reviews: list.slice(0, limit).map(publicReview), stats: { count, avg: Math.round(avg * 10) / 10 } };
}

const reviewForOrder = (orderId) => db.reviews.find((r) => r.orderId === Number(orderId)) || null;
const userReviews = (userId) => reviewsByStatus().filter((r) => r.userId === String(userId));

function countSupportUnread() {
  // для простоты считаем все треды
  return getSupportThreads().length;
}

/* ---------- брокеры ---------- */

const roundBtc = (n) => Math.round(Number(n) * 1e8) / 1e8;

function createBroker({ login, pass, name }) {
  login = String(login || '').trim();
  return mutate((d) => {
    if (d.brokers.some((b) => b.login.toLowerCase() === login.toLowerCase())) return null;
    const broker = {
      id: d.brokerSeq++,
      login,
      pass: String(pass),
      name: String(name || login).trim().slice(0, 60) || login,
      tgId: null, // привязывается при первом входе /broker
      active: true,
      earnedBTC: 0, // начислено всего
      pendingBTC: 0, // запрошено к выплате
      paidBTC: 0, // выплачено администрацией
      createdAt: Date.now(),
    };
    d.brokers.push(broker);
    return broker;
  });
}

const getBroker = (id) => db.brokers.find((b) => b.id === Number(id)) || null;
const getBrokerByLogin = (login) =>
  db.brokers.find((b) => b.login.toLowerCase() === String(login || '').trim().toLowerCase()) || null;
const getBrokerByTg = (tgId) => db.brokers.find((b) => b.active && String(b.tgId) === String(tgId)) || null;

function updateBroker(id, patch) {
  return mutate((d) => {
    const b = d.brokers.find((x) => x.id === Number(id));
    if (!b) return null;
    Object.assign(b, patch);
    return b;
  });
}

// Доступно к выводу = начислено − на выплате − выплачено.
const brokerAvailable = (b) => roundBtc((b.earnedBTC || 0) - (b.pendingBTC || 0) - (b.paidBTC || 0));

// Начисление вознаграждения брокеру за завершённую им сделку (однократно на заявку).
// Сумма в валюте сделки × brokerPercent; GRAM конвертируется в BTC по текущему курсу.
function accrueCompletedOrder(orderId) {
  return mutate((d) => {
    const o = d.orders.find((x) => x.id === Number(orderId));
    if (!o || o.status !== 'completed' || !o.brokerId || o.brokerAccrued != null) return null;
    const b = d.brokers.find((x) => x.id === Number(o.brokerId));
    if (!b) return null;
    const pct = Number(d.settings.brokerPercent) || 0;
    const inCur = (Number(o.crypto) || 0) * pct / 100;
    const btc = o.currency === 'BTC'
      ? inCur
      : (inCur * (Number(o.rate) || 0)) / Math.max(1, Number(d.settings.rateBTC) || 1);
    const earned = roundBtc(btc);
    o.brokerAccrued = earned;
    o.updatedAt = Date.now();
    b.earnedBTC = roundBtc((b.earnedBTC || 0) + earned);
    return { broker: b, order: o, earnedBTC: earned };
  });
}

/* ---------- заявки «стать брокером» ---------- */

function createBrokerApp({ userId, name, username, contact, experience }) {
  return mutate((d) => {
    const app = {
      id: d.brokerAppSeq++,
      userId: String(userId),
      name: String(name || 'Клиент').slice(0, 60),
      username: username ? String(username).slice(0, 60) : null,
      contact: String(contact).slice(0, 120),
      experience: String(experience).slice(0, 2000),
      status: 'new', // 'new' | 'done'
      createdAt: Date.now(),
      processedAt: null,
    };
    d.brokerApps.push(app);
    return app;
  });
}

const pendingBrokerApp = (userId) =>
  db.brokerApps.find((a) => a.userId === String(userId) && a.status === 'new') || null;
const latestBrokerApp = (userId) =>
  db.brokerApps.filter((a) => a.userId === String(userId)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
const brokerAppsByStatus = (status) =>
  db.brokerApps.filter((a) => !status || a.status === status).sort((a, b) => b.createdAt - a.createdAt);

function updateBrokerApp(id, patch) {
  return mutate((d) => {
    const a = d.brokerApps.find((x) => x.id === Number(id));
    if (!a) return null;
    Object.assign(a, patch);
    return a;
  });
}

/* ---------- выплаты брокерам ---------- */

function createPayout({ brokerId, amountBTC, address }) {
  return mutate((d) => {
    const b = d.brokers.find((x) => x.id === Number(brokerId));
    if (!b) return null;
    const amount = roundBtc(amountBTC);
    const payout = {
      id: d.payoutSeq++,
      brokerId: b.id,
      login: b.login,
      name: b.name,
      amountBTC: amount,
      address: String(address).slice(0, 128),
      status: 'requested', // 'requested' | 'paid'
      createdAt: Date.now(),
      paidAt: null,
    };
    d.payouts.push(payout);
    b.pendingBTC = roundBtc((b.pendingBTC || 0) + amount);
    return payout;
  });
}

const getPayout = (id) => db.payouts.find((p) => p.id === Number(id)) || null;
const payoutsByStatus = (status) =>
  db.payouts.filter((p) => !status || p.status === status).sort((a, b) => b.createdAt - a.createdAt);

function markPayoutPaid(id) {
  return mutate((d) => {
    const p = d.payouts.find((x) => x.id === Number(id));
    if (!p || p.status !== 'requested') return null;
    p.status = 'paid';
    p.paidAt = Date.now();
    const b = d.brokers.find((x) => x.id === Number(p.brokerId));
    if (b) {
      b.pendingBTC = roundBtc(Math.max(0, (b.pendingBTC || 0) - p.amountBTC));
      b.paidBTC = roundBtc((b.paidBTC || 0) + p.amountBTC);
    }
    return { payout: p, broker: b };
  });
}

load();

module.exports = {
  get,
  mutate,
  publicSettings,
  touchUser,
  getUser,
  createOrder,
  getOrder,
  updateOrder,
  setReceipt,
  userOrders,
  activeOrders,
  stats,
  pushRatePoint,
  rateHistorySince,
  createSupportMessage,
  getSupportMessages,
  getSupportThreads,
  countSupportUnread,
  REVIEW_TEXT_MAX,
  createReview,
  getReview,
  updateReview,
  deleteReview,
  reviewsByStatus,
  publicReview,
  publicReviews,
  reviewForOrder,
  userReviews,
  BROKER_MIN_PAYOUT,
  createBroker,
  getBroker,
  getBrokerByLogin,
  getBrokerByTg,
  updateBroker,
  brokerAvailable,
  accrueCompletedOrder,
  createBrokerApp,
  pendingBrokerApp,
  latestBrokerApp,
  brokerAppsByStatus,
  updateBrokerApp,
  createPayout,
  getPayout,
  payoutsByStatus,
  markPayoutPaid,
};
