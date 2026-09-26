const fs = require('fs');
const path = require('path');

let DATA_DIR;
try {
  const cfg = require('./config');
  DATA_DIR = cfg.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
} catch {
  DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_ADMIN_BROKERS = [
  { login: 'stony montana', name: 'stony montana', active: true, online: true, rating: 4.98, completed: 342 },
  { login: 'safer', name: 'safer', active: true, online: true, rating: 4.96, completed: 289 },
  { login: 'INGA352', name: 'INGA352', active: true, online: true, rating: 4.99, completed: 415 },
  { login: 'user_161931', name: 'user_161931', active: true, online: true, rating: 4.95, completed: 198 },
  { login: 'fast alberto', name: 'fast alberto', active: true, online: true, rating: 4.97, completed: 276 },
];

const defaults = () => ({
  seq: 1,
  supportSeq: 1,
  reviewSeq: 1,
  brokerSeq: 1,
  payoutSeq: 1,
  settings: {
    rateBTC: 10250000, // ₽ за 1 BTC (итоговый, с комиссией)
    rateGRAM: 125, // ₽ за 1 GRAM (стартовый курс, итоговый с комиссией)
    baseRateBTC: null, // официальный курс BTC без комиссии (авто)
    baseRateGRAM: null, // официальный курс GRAM без комиссии (авто)
    feePercent: 2, // комиссия обменника, % поверх официального курса
    rateUpdatedAt: null,
    rateSource: 'manual',
    usdRub: null, // последний курс доллара для пересчёта в рубли (ЦБ РФ или резервный)
    usdRubSource: null,
    usdRubAt: null,
    minRub: 3000,
    maxRub: 300000,
    online: true,
    announcement:
      '🚀 PRICELEX официально начинает работу! Принимаем заявки на обмен BTC и GRAM. Минимальная сумма обмена — от 3 000 ₽.',
    refPercent: 1,
    operator: '', // поддержка клиентов: пусто → только чат в приложении
    channel: 'https://t.me/pricelex_channel',
    chat: 'https://t.me/pricelex_chat',
    publicUrl: null,
    botUsername: null,
    // Доступ брокера: логин/пароль регулируются в админ-панели бота,
    // стартовые значения можно задать через BROKER_LOGIN / BROKER_PASSWORD.
    brokerLogin: String(process.env.BROKER_LOGIN || '').trim(),
    brokerPassword: String(process.env.BROKER_PASSWORD || '').trim(),
    brokerActive: true,
    brokerSharePercent: 70, // брокеру 70% спреда сделки, площадке 30%
    opsExpensesRub: 50, // операционные расходы площадки со сделки, ₽
    brokerMinPayoutBtc: 0.0002, // минимальная сумма выплаты брокеру
    brokerDepositUsd: 20, // возвратный депозит стажёра, в $ (для текстов)
    brokerDepositBtc: 0.0002, // эквивалент депозита в BTC
    brokerDepositAddress: '', // куда брокер вносит депозит (задаёт админ)
    // Разовый сбор за подключение брокера: процент от суммы депозита, но не больше
    // лимита. Сбор считается сверх депозита и не возвращается — он не входит
    // в возвратную сумму и всегда показывается брокеру отдельной строкой.
    brokerDepositFeePercent: 10,
    brokerDepositFeeMaxBtc: 0.0005,
    // Общий гарантийный депозит всех брокеров площадки — именно его клиент видит
    // в приложении как страховку сделки. Последние знаки на витрине живут по рынку.
    guaranteeFundBtc: 0.02,
    internMaxRub: 5000, // стажёр работает только с заявками до этой суммы, ₽
    internDays: 7, // длительность стажировки в днях
    adminBrokers: DEFAULT_ADMIN_BROKERS,
  },
  admins: [], // дополнительные операторы; владельцы задаются через окружение
  users: {},
  orders: [],
  flags: {},
  support: [], // чат поддержки: { id, userId, from: 'user'|'admin', text, at }
  rateHistory: [], // наблюдения курса: { at, btc, gram } — основа графика в приложении
  // Отзывы: { id, userId, orderId, name, rating 1–5, text, status, source, createdAt, updatedAt, adminMsgIds,
  //           reply: null | { text, at, by } }
  // status: 'pending' (модерация) | 'approved' (опубликован) | 'rejected' (скрыт)
  reviews: [],
  // Заявки «стать брокером»: { id, userId, name, username, experience, contact, status, createdAt, updatedAt, adminMsgIds }
  // status: 'pending' | 'approved' | 'rejected'
  brokerApps: [],
  brokerSessions: {}, // tgId -> { login, at }
  // Профиль брокера по логину: { name, username, depositBtc, depositAt, internUntil }
  brokerProfiles: {},
  // Леджер брокера: { id, login, orderId, rub, btc, at, type: 'earn' }
  brokerLedger: [],
  // Заявки на ввод депозита стажёра: { id, login, tgId, btc, status, createdAt, updatedAt, adminMsgIds }
  // status: 'pending' | 'confirmed' | 'declined'
  brokerDeposits: [],
  depositSeq: 1,
  // Выплаты брокерам: { id, login, btc, address, kind, status, createdAt, updatedAt, adminMsgIds }
  // kind: 'earning' (доход) | 'deposit' (возврат депозита); status: 'pending' | 'paid' | 'declined'
  payouts: [],
});

const OLD_OPERATOR_DEFAULTS = ['@pricelex_operator', '@stonym0ntana'];

// График курса в Web App строится только по реальным наблюдениям:
// каждое успешное автообновление курса обновляет точку. Курс обновляется
// раз в 10 секунд, но точку графика плотнее минуты не храним — для недельной
// истории достаточно минутного разрешения.
const RATE_HISTORY_MAX = 10080;

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
      for (const r of db.reviews) {
        if (r.reply === undefined) r.reply = null;
      }
      if (!Array.isArray(db.brokerApps)) db.brokerApps = [];
      if (!Number.isFinite(db.brokerSeq)) db.brokerSeq = db.brokerApps.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
      if (!db.brokerSessions || typeof db.brokerSessions !== 'object') db.brokerSessions = {};
      if (!Array.isArray(db.brokerLedger)) db.brokerLedger = [];
      if (!Array.isArray(db.payouts)) db.payouts = [];
      if (!Number.isFinite(db.payoutSeq)) db.payoutSeq = db.payouts.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
      // Личного оператора убрали: поддержка ведётся в чате приложения.
      // Обновляем устаревшие дефолтные контакты, пользовательское значение не трогаем.
      if (db.settings.operator == null || OLD_OPERATOR_DEFAULTS.includes(db.settings.operator)) {
        db.settings.operator = defaults().settings.operator;
      }
      const bs = db.settings;
      // Кнопки «Объявление / Поддержка / Канал» раньше писали в settings.ann/op/ch
      // вместо announcement/operator/channel — переносим живые значения и убираем мёртвые ключи.
      if (typeof bs.ann === 'string' && bs.ann.trim()) bs.announcement = bs.ann;
      if (typeof bs.op === 'string' && bs.op.trim()) bs.operator = bs.op;
      if (typeof bs.ch === 'string' && bs.ch.trim()) bs.channel = bs.ch;
      delete bs.ann;
      delete bs.op;
      delete bs.ch;
      // Доля брокера больше не плоская: платформа делит с ним спред сделки.
      if (bs.brokerPercent !== undefined) delete bs.brokerPercent;
      if (bs.brokerLogin === undefined) bs.brokerLogin = String(process.env.BROKER_LOGIN || '').trim();
      if (bs.brokerPassword === undefined) bs.brokerPassword = String(process.env.BROKER_PASSWORD || '').trim();
      if (bs.brokerActive === undefined) bs.brokerActive = true;
      if (bs.brokerSharePercent === undefined) bs.brokerSharePercent = 70; // брокеру 70% спреда, площадке 30%
      if (bs.opsExpensesRub === undefined) bs.opsExpensesRub = 50; // операционные расходы со сделки, ₽
      if (bs.brokerMinPayoutBtc === undefined) bs.brokerMinPayoutBtc = 0.0002;
      if (bs.avgExchangeMin === undefined) bs.avgExchangeMin = 0;
      if (bs.brokerDepositUsd === undefined) bs.brokerDepositUsd = 20;
      if (bs.brokerDepositBtc === undefined) bs.brokerDepositBtc = 0.0002;
      if (bs.brokerDepositAddress === undefined) bs.brokerDepositAddress = '';
      if (bs.brokerDepositFeePercent === undefined) bs.brokerDepositFeePercent = 10;
      if (bs.brokerDepositFeeMaxBtc === undefined) bs.brokerDepositFeeMaxBtc = 0.0005;
      if (bs.guaranteeFundBtc === undefined) bs.guaranteeFundBtc = 0.02;
      if (bs.internMaxRub === undefined) bs.internMaxRub = 5000;
      if (bs.internDays === undefined) bs.internDays = 7;
      if (!Array.isArray(bs.adminBrokers) || bs.adminBrokers.length === 0) bs.adminBrokers = DEFAULT_ADMIN_BROKERS;
      if (!db.brokerProfiles || typeof db.brokerProfiles !== 'object') db.brokerProfiles = {};
      if (!Array.isArray(db.brokerDeposits)) db.brokerDeposits = [];
      for (const dep of db.brokerDeposits) {
        // Заявки, созданные до появления сбора, шли ровно на сумму депозита.
        if (dep.feeBtc === undefined) {
          dep.feeBtc = 0;
          dep.feePercent = 0;
          dep.feeMaxBtc = 0;
        }
        dep.btc = Math.round((Number(dep.btc) || 0) * 1e8) / 1e8;
        dep.feeBtc = Math.round((Number(dep.feeBtc) || 0) * 1e8) / 1e8;
        if (dep.totalBtc === undefined || dep.totalBtc === null) dep.totalBtc = Math.round((dep.btc + dep.feeBtc) * 1e8) / 1e8;
      }
      if (!Number.isFinite(db.depositSeq)) db.depositSeq = db.brokerDeposits.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
      for (const o of db.orders || []) {
        if (o.broker === undefined) o.broker = null;
        if (o.officialRate === undefined) o.officialRate = null;
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

function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[store] save error:', e.message);
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 150);
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
}

const get = () => db;
// Счётчик изменений: по нему сбрасываются производные кэши (сортировка отзывов).
let mutations = 0;
const mutate = (fn) => {
  const r = fn(db);
  mutations += 1;
  save();
  return r;
};

// Ensure data is flushed on graceful shutdown. Свой обработчик сигнала отменяет
// выход по умолчанию, поэтому после сохранения процесс завершается сам — иначе
// Ctrl+C и `kill` не останавливали сервер.
try {
  const stop = (code) => () => {
    try { flush(); } catch {}
    process.exit(code);
  };
  process.once('SIGINT', stop(130));
  process.once('SIGTERM', stop(143));
  process.on('beforeExit', () => { try { if (saveTimer) flush(); } catch {} });
} catch {}

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
    brokerMinPayoutBtc: s.brokerMinPayoutBtc,
    brokerSharePercent: s.brokerSharePercent,
    brokerDepositUsd: s.brokerDepositUsd,
    brokerDepositBtc: s.brokerDepositBtc,
    brokerDepositFeePercent: s.brokerDepositFeePercent,
    brokerDepositFeeMaxBtc: s.brokerDepositFeeMaxBtc,
    // Общий депозит брокеров площадки — клиент видит его как гарантию сделки.
    guaranteeFundBtc: Number(s.guaranteeFundBtc) > 0 ? Number(s.guaranteeFundBtc) : 0.02,
    internDays: s.internDays,
    internMaxRub: s.internMaxRub,
    adminBrokers: (s.adminBrokers || DEFAULT_ADMIN_BROKERS).map((b) => ({
      login: b.login,
      name: b.name || b.login,
      online: b.online !== false,
      rating: b.rating || 4.98,
      completed: b.completed || 250,
    })),
    // Среднее время обмена: ручное значение, иначе — вычисленное по сделкам.
    avgExchangeMin: Number(s.avgExchangeMin) > 0 ? Number(s.avgExchangeMin) : avgExchangeMinutesComputed(),
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
      officialRate: o.officialRate || null, // официальный курс на момент заявки — из него считается спред брокера
      broker: null, // логин брокера, взявшего заявку
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

// Среднее время обмена: по 30 последним завершённым сделкам (от создания до завершения).
function avgExchangeMinutesComputed() {
  const done = db.orders
    .filter((o) => o.status === 'completed')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 30);
  if (!done.length) return null;
  const mins = done.map((o) => Math.max(0, (o.updatedAt - o.createdAt) / 60000));
  return Math.max(1, Math.round(mins.reduce((s, x) => s + x, 0) / mins.length));
}

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
function pushRatePoint({ btc, gram, at = Date.now(), baseBtc, baseGram } = {}) {
  const b = Math.round(Number(btc));
  const g = Math.round(Number(gram));
  if (!Number.isFinite(b) || !Number.isFinite(g) || b <= 0 || g <= 0) return null;
  const bb = Number.isFinite(Number(baseBtc)) && Number(baseBtc) > 0 ? Math.round(Number(baseBtc)) : null;
  const bg = Number.isFinite(Number(baseGram)) && Number(baseGram) > 0 ? Math.round(Number(baseGram)) : null;
  return mutate((d) => {
    if (!Array.isArray(d.rateHistory)) d.rateHistory = [];
    const last = d.rateHistory[d.rateHistory.length - 1];
    if (last && last.btc === b && last.gram === g && at - last.at < 30000) return last;
    // Обновления чаще минуты не плодят точки: свежая точка заменяет предыдущую.
    if (last && at - last.at < 60000) {
      last.at = at; last.btc = b; last.gram = g;
      if (bb) last.baseBtc = bb;
      if (bg) last.baseGram = bg;
      return last;
    }
    const point = { at, btc: b, gram: g };
    if (bb) point.baseBtc = bb;
    if (bg) point.baseGram = bg;
    d.rateHistory.push(point);
    if (d.rateHistory.length > RATE_HISTORY_MAX) d.rateHistory.splice(0, d.rateHistory.length - RATE_HISTORY_MAX);
    return point;
  });
}

// Заполнение начальной истории курса (из онлайна за неделю с нашим процентом).
function seedRateHistory(points) {
  if (!Array.isArray(points) || !points.length) return 0;
  return mutate((d) => {
    if (!Array.isArray(d.rateHistory)) d.rateHistory = [];
    const valid = points
      .filter((p) => p && Number.isFinite(p.at) && p.btc > 0 && p.gram > 0)
      .map((p) => {
        const pt = {
          at: Number(p.at),
          btc: Math.round(Number(p.btc)),
          gram: Math.round(Number(p.gram)),
        };
        if (Number(p.baseBtc) > 0) pt.baseBtc = Math.round(Number(p.baseBtc));
        if (Number(p.baseGram) > 0) pt.baseGram = Math.round(Number(p.baseGram));
        return pt;
      });
    if (!valid.length) return 0;

    const map = new Map();
    for (const p of valid) {
      map.set(Math.round(p.at / 60000), p);
    }
    for (const p of d.rateHistory) {
      if (p && Number.isFinite(p.at) && p.btc > 0 && p.gram > 0) {
        const k = Math.round(p.at / 60000);
        if (!map.has(k)) map.set(k, p);
      }
    }
    const merged = Array.from(map.values()).sort((a, b) => a.at - b.at);
    if (merged.length > RATE_HISTORY_MAX) {
      merged.splice(0, merged.length - RATE_HISTORY_MAX);
    }
    d.rateHistory = merged;

    const latest = merged[merged.length - 1];
    if (latest) {
      if (!d.settings.rateUpdatedAt || d.settings.rateUpdatedAt < latest.at) {
        d.settings.rateUpdatedAt = latest.at;
      }
      if (!d.settings.baseRateBTC && latest.baseBtc) d.settings.baseRateBTC = latest.baseBtc;
      if (!d.settings.baseRateGRAM && latest.baseGram) d.settings.baseRateGRAM = latest.baseGram;
      if (latest.btc) d.settings.rateBTC = latest.btc;
      if (latest.gram) d.settings.rateGRAM = latest.gram;
      if (!d.settings.rateSource || d.settings.rateSource === 'manual') {
        d.settings.rateSource = 'online history';
      }
    }

    return d.rateHistory.length;
  });
}

// Убираем точки, записанные после ts: пока официальный курс не обновлялся, в историю
// попадали стартовые или устаревшие курсы (например, при смене комиссии) — это не рынок.
function dropRatePointsAfter(ts = 0) {
  if (!(db.rateHistory || []).some((p) => p.at > ts)) return 0;
  return mutate((d) => {
    const before = d.rateHistory.length;
    d.rateHistory = d.rateHistory.filter((p) => p.at <= ts);
    return before - d.rateHistory.length;
  });
}

// Точки окна [since; ∞) с прореживанием до maxPoints (последняя всегда сохраняется).
function rateHistorySince(since = 0, maxPoints = 180) {
  const all = (db.rateHistory || []).filter((p) => p.at >= since);
  const limit = Math.max(2, Number(maxPoints) || 180);
  const pick = (p) => ({ at: p.at, btc: p.btc, gram: p.gram });
  if (all.length <= limit) return all.map(pick);
  const step = Math.ceil(all.length / limit);
  const out = all.filter((_, i) => i % step === 0).map(pick);
  const last = pick(all[all.length - 1]);
  if (!out.length || out[out.length - 1].at !== last.at) out.push(last);
  return out;
}

/* ---------- support chat ---------- */
function createSupportMessage(userId, from, text, broker = null) {
  return mutate((d) => {
    const msg = {
      id: d.supportSeq++,
      userId: String(userId),
      from, // 'user' | 'admin'
      text: String(text).slice(0, 2000),
      at: Date.now(),
    };
    if (broker) msg.broker = String(broker); // персональное сообщение для брокера
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
      reply: null,
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
    if (p.reply !== undefined) {
      if (p.reply == null) {
        p.reply = null;
      } else {
        const text = String(p.reply.text != null ? p.reply.text : (r.reply && r.reply.text) || '').trim().slice(0, REVIEW_TEXT_MAX);
        const at = Number.isFinite(Number(p.reply.at)) ? Number(p.reply.at) : ((r.reply && r.reply.at) || Date.now());
        const by = p.reply.by != null ? String(p.reply.by) : (r.reply && r.reply.by) || null;
        p.reply = text ? { text, at, by } : null;
      }
    }
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

// Порядок витрины: новые сверху, при равном времени — больший id выше.
// Порядок строгий — на нём держится курсор страниц.
const newestFirst = (a, b) => (b.createdAt - a.createdAt) || (b.id - a.id);
let sortedCache = { at: -1, src: null, len: -1, list: [] };
// Отсортированный список пересобирается только после изменений базы, а не на
// каждый запрос: при тысячах отзывов опрос вкладки «Отзывы» не сортирует их заново.
function sortedReviews() {
  const c = sortedCache;
  if (c.at !== mutations || c.src !== db.reviews || c.len !== db.reviews.length) {
    sortedCache = { at: mutations, src: db.reviews, len: db.reviews.length, list: db.reviews.slice().sort(newestFirst) };
  }
  return sortedCache.list;
}

const reviewsByStatus = (status) =>
  status ? sortedReviews().filter((r) => r.status === status) : sortedReviews().slice();

const publicReview = (r) => ({
  id: r.id,
  name: r.name,
  rating: r.rating,
  text: r.text,
  createdAt: r.createdAt,
  reply: r.reply && r.reply.text ? { text: r.reply.text, at: r.reply.at } : null,
});

// Курсор страницы — «createdAt:id» последнего показанного отзыва.
// null — первая страница, undefined — курсор испорчен.
function parseReviewCursor(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/^(\d{1,15}):(\d{1,12})$/);
  return m ? { at: Number(m[1]), id: Number(m[2]) } : undefined;
}

// Автор всегда видит свои отзывы как опубликованные — о модерации клиент не знает.
// Остальные видят только одобренные. Страница — limit отзывов после курсора
// before; stats (число, средняя, распределение по звёздам) — по всей витрине.
function publicReviews(limit = 100, viewerId = null, opts = {}) {
  const viewer = viewerId != null ? String(viewerId) : null;
  const list = sortedReviews().filter((r) => r.status === 'approved' || (viewer && r.userId === viewer));
  const count = list.length;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of list) {
    dist[r.rating] = (dist[r.rating] || 0) + 1;
    sum += r.rating;
  }
  let start = 0;
  const cur = opts.before;
  if (cur) {
    // Первый отзыв строго «старше» курсора — бинарный поиск по строгому порядку.
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = list[mid];
      if (r.createdAt > cur.at || (r.createdAt === cur.at && r.id >= cur.id)) lo = mid + 1;
      else hi = mid;
    }
    start = lo;
  }
  const page = list.slice(start, start + Math.max(0, Math.floor(limit) || 0));
  const hasMore = start + page.length < count;
  const last = page[page.length - 1];
  return {
    reviews: page.map(publicReview),
    stats: { count, avg: count ? Math.round((sum / count) * 10) / 10 : 0, dist },
    hasMore,
    next: hasMore && last ? `${last.createdAt}:${last.id}` : null,
  };
}

const reviewForOrder = (orderId) => db.reviews.find((r) => r.orderId === Number(orderId)) || null;
const userReviews = (userId) => reviewsByStatus().filter((r) => r.userId === String(userId));

function countSupportUnread() {
  // для простоты считаем все треды
  return getSupportThreads().length;
}

/* ---------- брокеры: заявки, сессии, заработок, выплаты ---------- */

function createBrokerApp(a) {
  return mutate((d) => {
    const now = Date.now();
    const app = {
      id: d.brokerSeq++,
      userId: String(a.userId),
      name: String(a.name || 'Кандидат').trim().slice(0, 80) || 'Кандидат',
      username: a.username ? String(a.username).replace(/^@/, '').slice(0, 40) : null,
      experience: String(a.experience || '').trim().slice(0, 1500),
      contact: String(a.contact || '').trim().slice(0, 200),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      adminMsgIds: {},
    };
    d.brokerApps.push(app);
    return app;
  });
}

const getBrokerApp = (id) => db.brokerApps.find((a) => a.id === Number(id)) || null;

const getAdminBrokers = () => db.settings.adminBrokers || DEFAULT_ADMIN_BROKERS;
const isAdminBroker = (login) => {
  if (!login) return false;
  const l = String(login).trim().toLowerCase();
  return (db.settings.adminBrokers || DEFAULT_ADMIN_BROKERS).some((b) => b.login.toLowerCase() === l);
};
const getRandomAdminBroker = () => {
  const list = (db.settings.adminBrokers || DEFAULT_ADMIN_BROKERS).filter((b) => b.active !== false);
  if (!list.length) return 'stony montana';
  return list[Math.floor(Math.random() * list.length)].login;
};

function updateBrokerApp(id, patch) {
  return mutate((d) => {
    const a = d.brokerApps.find((x) => x.id === Number(id));
    if (!a) return null;
    Object.assign(a, patch, { updatedAt: Date.now() });
    return a;
  });
}

// Последняя заявка пользователя — статус показываем в приложении.
const brokerAppFor = (userId) =>
  db.brokerApps
    .filter((a) => a.userId === String(userId))
    .sort((x, y) => y.createdAt - x.createdAt)[0] || null;

const brokerAppsByStatus = (status) =>
  db.brokerApps.filter((a) => !status || a.status === status).sort((a, b) => b.createdAt - a.createdAt);

const brokerCreds = () => {
  const s = db.settings;
  return {
    login: String(s.brokerLogin || ''),
    password: String(s.brokerPassword || ''),
    active: s.brokerActive !== false && !!(s.brokerLogin && s.brokerPassword),
  };
};

const brokerSession = (tgId) => {
  const s = db.brokerSessions[String(tgId)];
  return s && s.login ? s : null;
};

function setBrokerSession(tgId, login) {
  return mutate((d) => {
    d.brokerSessions[String(tgId)] = { login: String(login), at: Date.now() };
    return d.brokerSessions[String(tgId)];
  });
}

function dropBrokerSession(tgId) {
  return mutate((d) => {
    delete d.brokerSessions[String(tgId)];
  });
}

// Сессии конкретного брокера и все активные сессии — для уведомлений.
const brokerSessionsByLogin = (login) =>
  Object.entries(db.brokerSessions)
    .filter(([, s]) => s && s.login === String(login))
    .map(([tgId]) => tgId);
const allBrokerSessions = () =>
  Object.entries(db.brokerSessions).filter(([, s]) => s && s.login).map(([tgId, s]) => ({ tgId, login: s.login }));

// Начисление брокеру за завершённую сделку: разница между клиентским и
// официальным курсом (спред) минус операционные расходы площадки делится
// 70/30 — бо́льшая часть брокеру (доля настраивается). Идемпотентно по orderId.
function accrueBroker(order) {
  if (!order || !order.broker || order.status !== 'completed') return null;
  return mutate((d) => {
    if (d.brokerLedger.some((e) => e.orderId === order.id)) return null;
    const s = d.settings;
    const official = Number(order.officialRate) || (order.rate / (1 + (Number(s.feePercent) || 0) / 100));
    const payRub = Number(order.payRub) || Number(order.rub) || 0;
    const grossSpread = Math.max(0, Math.round(payRub - (Number(order.crypto) || 0) * official));
    const ops = Math.min(grossSpread, Math.max(0, Number(s.opsExpensesRub) || 0));
    const net = grossSpread - ops;
    const sharePct = Math.min(100, Math.max(0, Number(s.brokerSharePercent) ?? 70));
    const rubShare = Math.round(net * sharePct / 100);
    const rateBTC = Number(s.baseRateBTC) || Number(s.rateBTC) || order.rate || 1;
    const btc = Math.round((rubShare / rateBTC) * 1e8) / 1e8;
    const entry = {
      id: d.brokerLedger.length ? d.brokerLedger[d.brokerLedger.length - 1].id + 1 : 1,
      login: order.broker,
      orderId: order.id,
      rub: rubShare,
      btc,
      type: 'earn',
      spread: grossSpread, // гросс-спред сделки (наценка над официальным курсом)
      ops,                 // вычет операционных расходов площадки
      sharePct,
      at: Date.now(),
    };
    d.brokerLedger.push(entry);
    return entry;
  });
}

const brokerLedgerFor = (login) => db.brokerLedger.filter((e) => e.login === String(login));
const brokerEarnedBtc = (login) =>
  brokerLedgerFor(login).reduce((s, e) => s + (Number(e.btc) || 0), 0);

function createPayout(p) {
  return mutate((d) => {
    const now = Date.now();
    const payout = {
      id: d.payoutSeq++,
      login: String(p.login),
      btc: Math.round(Number(p.btc) * 1e8) / 1e8,
      address: String(p.address || '').trim().slice(0, 128),
      kind: p.kind === 'deposit' ? 'deposit' : 'earning', // возврат депозита или вывод дохода
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      adminMsgIds: {},
    };
    d.payouts.push(payout);
    return payout;
  });
}

const getPayout = (id) => db.payouts.find((p) => p.id === Number(id)) || null;

function updatePayout(id, patch) {
  return mutate((d) => {
    const p = d.payouts.find((x) => x.id === Number(id));
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: Date.now() });
    return p;
  });
}

const payoutsByLogin = (login) =>
  db.payouts.filter((p) => p.login === String(login)).sort((a, b) => b.createdAt - a.createdAt);
const payoutsByStatus = (status) =>
  db.payouts.filter((p) => !status || p.status === status).sort((a, b) => b.createdAt - a.createdAt);

/* ---------- брокер: профиль, депозит, стажировка ---------- */

const brokerProfile = (login) => db.brokerProfiles[String(login)] || null;

function upsertBrokerProfile(login, patch) {
  return mutate((d) => {
    const key = String(login);
    d.brokerProfiles[key] = Object.assign(
      { name: '', username: null, depositBtc: 0, depositAt: 0, internUntil: 0 },
      d.brokerProfiles[key] || {},
      patch
    );
    return d.brokerProfiles[key];
  });
}

// Стажировка идёт от даты подтверждения депозита internDays дней.
const brokerIsIntern = (login) => {
  const p = brokerProfile(login);
  if (!p || !p.internUntil) return true; // без депозита — стажёр по умолчанию
  return Date.now() < p.internUntil;
};
const brokerInternLeft = (login) => {
  const p = brokerProfile(login);
  if (!p || !p.internUntil) return null;
  return Math.max(0, Math.ceil((p.internUntil - Date.now()) / 86400000));
};

// Лимит заявки: каждый брокер торгует ровно на ту сумму, какой депозит он положил.
// Например, положил 100$ — может торговать любой суммой до 100$.
// Депозит страхует клиентов: если выплата не пришла, площадка компенсирует клиенту.
function brokerCanTake(login, rub) {
  const s = db.settings;
  if (!brokerIsIntern(login)) return { ok: true };
  const p = brokerProfile(login);
  if (!p || !p.depositBtc) {
    return {
      ok: false,
      reason: 'deposit',
      text: `Каждый может стать брокером, но торгует ровно на сумму своего депозита (например, положил $100 — торгуешь любой суммой до $100). Сначала внесите возвратный депозит $${s.brokerDepositUsd} (${s.brokerDepositBtc} BTC) плюс разовый сбор за подключение: он страхует клиентов — если выплата не пришла, мы компенсируем клиенту из депозита.`
    };
  }
  const rateBTC = Number(s.rateBTC) || 10000000;
  const depositRub = Math.round((Number(p.depositBtc) || 0) * rateBTC);
  const internLimit = Number(s.internMaxRub) || 5000;
  const maxAllowedRub = Math.max(internLimit, depositRub);
  if (Number(rub) > maxAllowedRub) {
    return {
      ok: false,
      reason: 'limit',
      text: `Сумма заявки (${Number(rub).toLocaleString('ru-RU')} ₽) превышает лимит стажировки и размер вашего депозита (${maxAllowedRub.toLocaleString('ru-RU')} ₽). Брокер торгует ровно на ту сумму, какой депозит он положил (на стажировке до ${brokerInternLeft(login) || s.internDays} дн.), чтобы страховать клиентов: если выплата не пришла, мы компенсируем средства клиенту.`
    };
  }
  return { ok: true };
}

/* ---------- сбор за подключение брокера ---------- */

const roundBtc = (v) => Math.round((Number(v) || 0) * 1e8) / 1e8;

// Сбор: percent от депозита, но не больше max. Считается от суммы депозита,
// поэтому при базовом депозите 0.0002 BTC это 0.00002 BTC (10%).
function brokerDepositFeeFor(btc) {
  const s = db.settings;
  const sum = roundBtc(btc);
  const percent = Math.max(0, Number(s.brokerDepositFeePercent) || 0);
  const cap = Math.max(0, Number(s.brokerDepositFeeMaxBtc) || 0);
  if (!(sum > 0)) return 0;
  const raw = (sum * percent) / 100;
  return roundBtc(cap > 0 ? Math.min(raw, cap) : raw);
}

// Сколько брокер переводит «одним платежом»: депозит + сбор.
const brokerDepositTotalBtc = (btc) => roundBtc(roundBtc(btc) + brokerDepositFeeFor(btc));

function createBrokerDeposit(dep) {
  const btc = roundBtc(dep.btc);
  const feeBtc = dep.feeBtc != null ? roundBtc(dep.feeBtc) : brokerDepositFeeFor(btc);
  return mutate((d) => {
    const now = Date.now();
    const row = {
      id: d.depositSeq++,
      login: String(dep.login),
      tgId: String(dep.tgId),
      btc,
      // Сбор фиксируем в записи: ставку в настройках можно поменять позже,
      // а у брокера уже названная сумма меняться не должна.
      feeBtc,
      feePercent: dep.feePercent != null ? dep.feePercent : Math.max(0, Number(d.settings.brokerDepositFeePercent) || 0),
      feeMaxBtc: dep.feeMaxBtc != null ? dep.feeMaxBtc : Math.max(0, Number(d.settings.brokerDepositFeeMaxBtc) || 0),
      totalBtc: roundBtc(btc + feeBtc),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      adminMsgIds: {},
    };
    d.brokerDeposits.push(row);
    return row;
  });
}

const getBrokerDeposit = (id) => db.brokerDeposits.find((x) => x.id === Number(id)) || null;

function updateBrokerDeposit(id, patch) {
  return mutate((d) => {
    const row = d.brokerDeposits.find((x) => x.id === Number(id));
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: Date.now() });
    return row;
  });
}

const brokerDepositsByStatus = (status) =>
  db.brokerDeposits.filter((x) => !status || x.status === status).sort((a, b) => b.createdAt - a.createdAt);

// Депозит можно забрать после стажировки (и когда он ещё не выведен).
function brokerDepositRefundable(login) {
  const p = brokerProfile(login);
  if (!p || !p.depositBtc) return { ok: false, reason: 'none' };
  if (brokerIsIntern(login)) {
    return { ok: false, reason: 'intern', left: brokerInternLeft(login) };
  }
  const dup = db.payouts.find((x) => x.login === String(login) && x.kind === 'deposit' && ['pending', 'paid'].includes(x.status));
  if (dup) return { ok: false, reason: 'dup', status: dup.status };
  return { ok: true, btc: p.depositBtc };
}

// Доступный остаток: начисленное минус выплаты дохода (запрошенные и исполненные).
// Возврат депозита из заработанного не вычитается — это свои деньги.
function brokerAvailableBtc(login) {
  const reserved = db.payouts
    .filter((p) => p.login === String(login) && p.kind !== 'deposit' && ['pending', 'paid'].includes(p.status))
    .reduce((s, p) => s + (Number(p.btc) || 0), 0);
  return Math.max(0, Math.round((brokerEarnedBtc(login) - reserved) * 1e8) / 1e8);
}

load();

module.exports = {
  get,
  mutate,
  flush,
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
  dropRatePointsAfter,
  rateHistorySince,
  seedRateHistory,
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
  parseReviewCursor,
  reviewForOrder,
  userReviews,
  avgExchangeMinutesComputed,
  createBrokerApp,
  getBrokerApp,
  updateBrokerApp,
  brokerAppFor,
  brokerAppsByStatus,
  brokerCreds,
  brokerSession,
  setBrokerSession,
  dropBrokerSession,
  brokerSessionsByLogin,
  allBrokerSessions,
  brokerProfile,
  upsertBrokerProfile,
  brokerIsIntern,
  brokerInternLeft,
  brokerCanTake,
  createBrokerDeposit,
  getBrokerDeposit,
  updateBrokerDeposit,
  brokerDepositsByStatus,
  brokerDepositFeeFor,
  brokerDepositTotalBtc,
  brokerDepositRefundable,
  accrueBroker,
  brokerLedgerFor,
  brokerEarnedBtc,
  createPayout,
  getPayout,
  updatePayout,
  payoutsByLogin,
  payoutsByStatus,
  brokerAvailableBtc,
  DEFAULT_ADMIN_BROKERS,
  getAdminBrokers,
  isAdminBroker,
  getRandomAdminBroker,
};
