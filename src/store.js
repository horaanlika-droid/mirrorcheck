const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const defaults = () => ({
  seq: 1,
  supportSeq: 1,
  settings: {
    rateBTC: 10250000, // ₽ за 1 BTC (итоговый, с комиссией)
    rateLTC: 9400, // ₽ за 1 LTC (итоговый, с комиссией)
    baseRateBTC: null, // официальный курс BTC без комиссии (авто)
    baseRateLTC: null, // официальный курс LTC без комиссии (авто)
    feePercent: 2, // комиссия обменника, % поверх официального курса
    rateUpdatedAt: null,
    rateSource: 'manual',
    minRub: 3000,
    maxRub: 300000,
    online: true,
    announcement:
      '🚀 PRICELEX официально начинает работу! Принимаем заявки на обмен BTC и LTC. Минимальная сумма обмена — от 3 000 ₽.',
    refPercent: 1,
    operator: '@pricelex_operator',
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
});

let db = null;
let saveTimer = null;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = Object.assign(defaults(), raw);
      db.settings = Object.assign(defaults().settings, raw.settings || {});
      // Миграция старых баз
      if (!Array.isArray(db.support)) db.support = [];
      if (!Number.isFinite(db.supportSeq)) db.supportSeq = (db.support?.length || 0) + 1;
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
    rateLTC: s.rateLTC,
    rateUpdatedAt: s.rateUpdatedAt,
    minRub: s.minRub,
    maxRub: s.maxRub,
    online: !!s.online,
    announcement: s.announcement,
    refPercent: s.refPercent,
    operator: s.operator,
    channel: s.channel,
    chat: s.chat,
    publicUrl: s.publicUrl,
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

function countSupportUnread() {
  // для простоты считаем все треды
  return getSupportThreads().length;
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
  createSupportMessage,
  getSupportMessages,
  getSupportThreads,
  countSupportUnread,
};
