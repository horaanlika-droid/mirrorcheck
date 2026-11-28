const fs = require('fs');
const path = require('path');
const currencies = require('./currencies');
const textCatalogue = require('./texts');
const attachments = require('./attachments');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// WEB_ACCESS=telegram закрывает анонимный вход (по умолчанию браузер открывается анонимно).
const WEB_ACCESS_DEFAULT = String(process.env.WEB_ACCESS || '').trim().toLowerCase() === 'telegram' ? 'telegram' : 'auto';
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_TICKER = [
  'PRICELEX WORLDWIDE',
  'GOOGLE · ITUNES · XBOX · APPLE STORE',
  'ВЫПЛАТА В USDT (BEP-20)',
  'БЕЗ РЕГИСТРАЦИИ И ДОКУМЕНТОВ',
  'СРЕДНЕЕ ВРЕМЯ ОБМЕНА 10–15 МИН',
  'КАЖДЫЙ 5-Й ОБМЕН — СКИДКА НА КОМИССИЮ',
  'ПОДДЕРЖКА 24/7',
];

const DEFAULT_MARQUEE = [
  'Приватный *обмен* подарочных карт',
  'USD *→* USDT (BEP-20)',
  'Google · iTunes · *Xbox* · Apple Store',
  'Без регистрации *и лишних следов*',
  'Честный курс *до создания* заявки',
];

const DEFAULT_BLOCK_ORDER = {
  home: ['hero', 'marquee', 'cards', 'steps', 'buyNote'],
  form: ['formCalc', 'formInfo', 'formWallet'],
  profile: ['profileHead', 'profileRef', 'profilePrivacy', 'profileContacts', 'profileAbout'],
};

function normalizeLines(raw, fallback) {
  if (!Array.isArray(raw)) return [...fallback];
  const lines = raw
    .map((v) => String(v ?? '').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 30);
  return lines.length ? lines : [...fallback];
}

function normalizeBlockOrder(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [section, def] of Object.entries(DEFAULT_BLOCK_ORDER)) {
    const valid = new Set(def);
    const seen = new Set();
    const list = [];
    if (Array.isArray(src[section])) {
      for (const item of src[section]) {
        const key = String(item ?? '').trim();
        if (valid.has(key) && !seen.has(key)) {
          seen.add(key);
          list.push(key);
        }
      }
    }
    for (const key of def) {
      if (!seen.has(key)) list.push(key);
    }
    out[section] = list;
  }
  return out;
}

const defaults = () => {
  const settings = {
    // Цена 1 USDT в USD и 1 BTC в USD. До получения котировки используем стартовые значения.
    usdtUsd: 1,
    btcUsd: 95000,
    // У каждой карты своя скидка к споту (%) и свой итоговый курс (USDT за $1 номинала).
    cardFees: Object.fromEntries(currencies.GIFT_KEYS.map((key) => [key, 0])),
    cardRates: {}, // заполняется ниже из спота и скидок
    // Комиссии сетей выплаты. BEP-20 всегда 0 (моментальный вывод без комиссии).
    networkFees: Object.fromEntries(currencies.PAYOUT_OPTION_LIST.map((o) => [o.id, o.defaultFee])),
    payoutEnabled: Object.fromEntries(currencies.PAYOUT_OPTION_LIST.map((o) => [o.id, true])),
    enabled: {
      GOOGLE_USD: true, ITUNES_USD: true, XBOX_USD: true, APPLE_STORE_USD: true,
    },
    rateUpdatedAt: null,
    rateSource: 'manual',
    online: true,
    refPercent: 1,
    operator: '@VEGA_obmen',
    channel: 'https://t.me/VEGA_Official_65',
    chat: 'https://t.me/+tY5b6RUJ0xUwNmNh',
    textOverrides: {},
    ticker: [...DEFAULT_TICKER],
    tickerEnabled: true,
    marquee: [...DEFAULT_MARQUEE],
    marqueeEnabled: true,
    blockOrder: normalizeBlockOrder(DEFAULT_BLOCK_ORDER),
    publicUrl: null,
    botUsername: null,
    // Второй бот (клиентский) для привязки веб-профиля к Telegram: /link
    bots: { operator: null, client: null },
    // Режим доступа: 'auto' — вне Telegram открывается анонимно;
    // 'telegram' — только Telegram (анонимный вход выключен).
    webAccess: WEB_ACCESS_DEFAULT,
  };
  settings.cardRates = currencies.allCardRates(settings);
  return {
    seq: 1,
    supportSeq: 1,
    settings,
    admins: [], // additional operators; owners are set via the environment
    users: {},
    orders: [],
    flags: {},
    support: [], // support chat: { id, userId, from: 'user'|'admin', text, at }
    reviews: [], // reviews: { id, userId, orderId, name, rating, text, at, source, reply, replyAt }
    reviewSeq: 1,
    orderMessages: [], // диалог клиента и оператора по заявке: { id, orderId, userId, from: 'user'|'admin', text, at }
    orderMsgSeq: 1,
    linkCodes: {}, // одноразовые коды привязки браузера к Telegram (10 минут)
    promos: [], // promo codes: { id, code, percent, maxUses, usedCount, minUnits, expiresAt, active, createdAt, updatedAt }
    promoSeq: 1,
  };
};

let db = null;
let saveTimer = null;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      const rawSettings = raw.settings || {};
      db = Object.assign(defaults(), raw);
      db.settings = Object.assign(defaults().settings, rawSettings);
      // Migration of old databases
      if (!Array.isArray(db.support)) db.support = [];
      if (!Array.isArray(db.reviews)) db.reviews = [];
      if (!Number.isFinite(db.reviewSeq)) {
        db.reviewSeq = db.reviews.reduce((m, r) => Math.max(m, Number(r && r.id) || 0), 0) + 1;
      }
      if (!Array.isArray(db.orderMessages)) db.orderMessages = [];
      db.orderMsgSeq = Math.max(Number(raw.orderMsgSeq) || 1,
        db.orderMessages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0) + 1);
      if (!Array.isArray(db.promos)) db.promos = [];
      if (!Number.isFinite(db.promoSeq)) {
        db.promoSeq = db.promos.reduce((m, p) => Math.max(m, Number(p && p.id) || 0), 0) + 1;
      }
      delete db.settings.announcement; // the site announcement was removed
      if (!db.settings.enabled || typeof db.settings.enabled !== 'object') {
        db.settings.enabled = defaults().settings.enabled;
      } else {
        for (const [key, on] of Object.entries(defaults().settings.enabled)) {
          if (db.settings.enabled[key] === undefined) db.settings.enabled[key] = on;
        }
      }
      if (!Number.isFinite(db.supportSeq)) db.supportSeq = (db.support?.length || 0) + 1;
      // Миграция старых баз: общая комиссия giftPercent и общий курс rateGOOGLEUSD
      // раскладываются в индивидуальные настройки каждой карты. Смотрим именно на
      // raw.settings: defaults() уже подставил cardFees с нулями, и по одному лишь
      // наличию этого поля не отличить старую базу от новой.
      const s = db.settings;
      const legacyFee = currencies.clampFee(rawSettings.giftPercent);
      if (!rawSettings.cardFees || typeof rawSettings.cardFees !== 'object') {
        s.cardFees = Object.fromEntries(currencies.GIFT_KEYS.map((key) => [key, legacyFee]));
      } else {
        for (const key of currencies.GIFT_KEYS) {
          s.cardFees[key] = currencies.clampFee(
            s.cardFees[key] === undefined ? legacyFee : s.cardFees[key]
          );
        }
      }
      // Не переносим абсолютные курсы и дату котировки другой валюты. Скидки
      // безразмерны, их сохраняем. Суммы и кошельки открытых и старых заявок не меняем.
      if (!currencies.usdtUsdQuote(rawSettings.usdtUsd)) {
        s.usdtUsd = 1;
        s.rateUpdatedAt = null;
        s.rateSource = 'manual';
      }
      if (!currencies.btcUsdQuote(rawSettings.btcUsd)) {
        s.btcUsd = defaults().settings.btcUsd;
      }
      const rawNetFees = rawSettings.networkFees && typeof rawSettings.networkFees === 'object' ? rawSettings.networkFees : {};
      s.networkFees = {};
      for (const opt of currencies.PAYOUT_OPTION_LIST) {
        s.networkFees[opt.id] = opt.instant
          ? 0
          : currencies.clampNetworkFee(rawNetFees[opt.id] === undefined ? opt.defaultFee : rawNetFees[opt.id], opt);
      }
      const rawPayoutOn = rawSettings.payoutEnabled && typeof rawSettings.payoutEnabled === 'object' ? rawSettings.payoutEnabled : {};
      s.payoutEnabled = {};
      for (const opt of currencies.PAYOUT_OPTION_LIST) {
        s.payoutEnabled[opt.id] = rawPayoutOn[opt.id] !== false;
      }
      s.cardRates = currencies.allCardRates(s);
      delete s.giftPercent;
      delete s.rateGOOGLEUSD;
      for (const o of db.orders || []) {
        if (o.txUrl === undefined) o.txUrl = null;
        if (o.txHash === undefined) o.txHash = null;
      }
      // Миграция текстовых override'ов: единица редактирования — целый блок (для
      // руководства это целая секция из нескольких абзацев, а не отдельный абзац).
      // При смене модели id блоков меняются, поэтому сбрасываем override'ы, чей id
      // больше не соответствует ни одному блоку текущего каталога; оператор
      // переводирует их заново целыми блоками.
      if (s.textOverrides && typeof s.textOverrides === 'object') {
        const known = new Set(textCatalogue().map((t) => t.id));
        for (const id of Object.keys(s.textOverrides)) {
          if (!known.has(id)) delete s.textOverrides[id];
        }
      }
      s.ticker = normalizeLines(rawSettings.ticker, DEFAULT_TICKER);
      s.tickerEnabled = rawSettings.tickerEnabled !== false;
      s.marquee = normalizeLines(rawSettings.marquee, DEFAULT_MARQUEE);
      s.marqueeEnabled = rawSettings.marqueeEnabled !== false;
      s.blockOrder = normalizeBlockOrder(rawSettings.blockOrder);
      // Веб-доступ и второй бот: старые базы получают безопасные значения по умолчанию.
      // Явная настройка в базе важнее переменной окружения.
      if (rawSettings.webAccess === 'telegram' || rawSettings.webAccess === 'auto') s.webAccess = rawSettings.webAccess;
      else s.webAccess = WEB_ACCESS_DEFAULT;
      if (!s.bots || typeof s.bots !== 'object') s.bots = { operator: null, client: null };
      if (!db.linkCodes || typeof db.linkCodes !== 'object') db.linkCodes = {};
      for (const [uid, u] of Object.entries(db.users || {})) {
        if (u && u.anonymous === undefined) u.anonymous = /^(web_|tgweb_)/.test(uid);
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
  // The client sees gift-card directions and payout options (BEP-20 instant & zero-fee; BTC/TRC-20/ERC-20/TON with network fee).
  return {
    texts: textCatalogue().filter((item) => Object.prototype.hasOwnProperty.call(s.textOverrides || {}, item.id)).map((item) => ({ text: item.text, value: s.textOverrides[item.id] })),
    rates: currencies.publicRates(s).map((r) => ({ ...r, rate: r.direction === 'sell' ? r.rate : null })),
    btcUsd: currencies.btcUsdQuote(s.btcUsd) || 95000,
    payoutOptions: currencies.publicPayoutOptions(s),
    rateUpdatedAt: s.rateUpdatedAt,
    online: !!s.online,
    refPercent: s.refPercent,
    operator: s.operator,
    channel: s.channel,
    chat: s.chat,
    ticker: normalizeLines(s.ticker, DEFAULT_TICKER),
    tickerEnabled: s.tickerEnabled !== false,
    marquee: normalizeLines(s.marquee, DEFAULT_MARQUEE),
    marqueeEnabled: s.marqueeEnabled !== false,
    blockOrder: normalizeBlockOrder(s.blockOrder),
    publicUrl: s.publicUrl,
    botUsername: s.botUsername,
    // Для профиля: доступен ли анонимный вход и какой бот выдаёт код привязки.
    privacy: {
      anonymousLogin: s.webAccess !== 'telegram',
      // Код привязки выдаёт тот же бот, что обслуживает клиентов (@botUsername).
      linkBot: s.botUsername || (s.bots && s.bots.client) || null,
    },
  };
}

function touchUser(u, refParam) {
  return mutate((d) => {
    const id = String(u.id);
    let user = d.users[id];
    if (!user) {
      user = d.users[id] = {
        id,
        // Анонимные (не Telegram) профили: их псевдоним придумывает сервер.
        anonymous: /^(web_|tgweb_)/.test(id),
        name: u.first_name || u.name || 'Клиент',
        username: u.username || null,
        referrer: null,
        referredCount: 0,
        referredIds: [],
        createdAt: Date.now(),
      };
    }
    user.lastSeen = Date.now();
    // Серверный псевдоним анонимного профиля закреплён: Telegram-поля его не перетирают.
    if (u.first_name && !user.anonymous) user.name = u.first_name;
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

function completedOrderCount(userId) {
  const id = String(userId);
  return db.orders.filter((order) => String(order.userId) === id && order.status === 'completed').length;
}

function loyaltyStatus(userId) {
  const completedExchanges = completedOrderCount(userId);
  const exchangeNumber = completedExchanges + 1;
  return {
    completedExchanges,
    exchangeNumber,
    eligible: exchangeNumber % 5 === 0,
    exchangesUntilReward: 5 - (completedExchanges % 5),
    discountPercent: 1,
  };
}

function createOrder(o) {
  return mutate((d) => {
    const order = {
      id: d.seq++,
      userId: o.userId,
      userName: o.userName || 'Клиент',
      userUsername: o.userUsername || null,
      direction: 'sell',
      payoutId: o.payoutId || currencies.PAYOUT_OPTIONS.USDT_BEP20.id,
      payoutCurrency: o.payoutCurrency || currencies.PAYOUT_CURRENCY,
      currency: o.currency || null, // gift-card currency/key (e.g. GOOGLE_USD)
      network: o.network || currencies.PAYOUT_NETWORK, // validated server-side from PAYOUT_OPTIONS
      networkFee: Number(o.networkFee) || 0,
      grossCrypto: o.grossCrypto ?? o.crypto,
      expiresAt: o.expiresAt ?? null, // deal time limit (gift cards — 1 hour)
      paidAt: null, // when the client tapped "I paid"
      completedAt: null, // when the operator confirmed the payout (currency issued)
      units: o.units ?? null, // gift card face value, $
      giftCode: o.giftCode || null, // card code (visible only to the client and the operator)
      wallet: o.wallet || '',
      rate: o.rate,
      crypto: o.crypto,
      promoId: o.promoId ?? null,
      promoCode: o.promoCode || null,
      promoPercent: o.promoPercent ?? null,
      baseCrypto: o.baseCrypto ?? null,
      loyaltyDiscountPercent: o.loyaltyDiscountPercent ?? 0,
      loyaltyExchangeNumber: o.loyaltyExchangeNumber ?? null,
      promoReleased: false,
      status: 'new', // new orders wait for the operator to join
      requisites: null,
      receipt: null,
      txUrl: null, // blockchain transaction link (optional, after confirmation)
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

// An order whose time limit expired is moved to "cancelled" and no longer accepts actions.
// An "I paid" mark finalizes the deal: the limit no longer applies, the operator verifies manually.
const EXPIRED = 'expired';
const EXPIRED_LEGACY = 'Срок на сделку истёк'; // rows written before the stable reason code was introduced
function expireIfNeeded(order) {
  if (!order || !order.expiresAt) return order;
  if (['completed', 'rejected', 'cancelled', 'paid'].includes(order.status)) return order;
  if (Date.now() < Number(order.expiresAt)) return order;
  const upd = updateOrder(order.id, { status: 'cancelled', cancelReason: EXPIRED });
  if (upd && upd.promoId && !upd.promoReleased) releaseOrderPromo(upd.id);
  return upd;
}

// Receipts are unused for gift orders — kept for order-structure compatibility.
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
  db.orders
    .filter((o) => o.userId === String(userId))
    .map(expireIfNeeded)
    .sort((a, b) => b.createdAt - a.createdAt);

const activeOrders = () =>
  db.orders.filter((o) => ['new', 'details', 'paid'].includes(o.status)).map(expireIfNeeded).filter(Boolean);

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
    volumeDoneUsd: done.reduce((s, o) => s + (Number(o.units) || 0), 0),
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
    // keep at most the last 5000 messages
    if (d.support.length > 5000) d.support.splice(0, d.support.length - 5000);
    // refresh the user's lastSeen if present
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

/* ---------- диалог по заявке: клиент ↔ оператор ---------- */
// Диалог живёт внутри карточки заявки — от начала сделки (статус «new») до финала
// («completed»/«rejected»/«cancelled»), так что клиент остаётся на связи всю сделку.
function createOrderMessage({ orderId, userId, from, text, attachment }) {
  return mutate((d) => {
    const msg = {
      id: d.orderMsgSeq++,
      orderId: Number(orderId),
      userId: String(userId),
      from, // 'user' | 'admin'
      text: String(text || '').trim().slice(0, 2000),
      ...(attachment ? { attachment } : {}),
      at: Date.now(),
    };
    d.orderMessages.push(msg);
    if (d.orderMessages.length > 5000) {
      for (const old of d.orderMessages.splice(0, d.orderMessages.length - 5000)) {
        try { attachments.remove(old.attachment); }
        catch { console.error('[store] не удалось удалить вложение сообщения', old.id); }
      }
    }
    return msg;
  });
}

function getOrderMessages(orderId) {
  return db.orderMessages
    .filter((m) => m.orderId === Number(orderId))
    .sort((a, b) => a.at - b.at || (a.id || 0) - (b.id || 0));
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
  // for simplicity all threads are counted
  return getSupportThreads().length;
}

/* ---------- reviews ---------- */
// A client can leave a review after a completed deal (source 'order', one review per order),
// or the operator adds one manually via the admin panel (source 'admin').
const publicReview = (r) => ({
  id: r.id,
  name: r.name,
  rating: r.rating,
  text: r.text,
  at: r.at,
  source: r.source || 'order',
  // Ответ площадки (витрисы) на отзыв — добавляется оператором через админку, клиент его видит.
  reply: r.reply ? String(r.reply).trim().slice(0, 1000) : '',
  replyAt: r.replyAt || null,
});

// Средний рейтинг всегда висит в пределах 0–5 звёзд: при счёте показа площадки
// ничего не может выйти за пять звёзд, даже если данные пришли извне.
const clampAvg = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(5, Math.max(0, n));
};

function reviewSummary(list) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of list) {
    const k = Math.min(5, Math.max(1, Math.round(Number(r.rating) || 0)));
    if (!k) continue;
    dist[k] += 1;
    sum += k;
  }
  const count = list.length;
  return {
    count,
    avg: clampAvg(count ? sum / count : 0),
    dist,
  };
}

// Newest first: list for the showcase and the admin panel.
function listReviews(limit = 500) {
  const n = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  return [...db.reviews].sort((a, b) => (b.at || 0) - (a.at || 0) || (b.id || 0) - (a.id || 0)).slice(0, n);
}

const getReview = (id) => db.reviews.find((r) => Number(r.id) === Number(id)) || null;

const getReviewByOrder = (orderId) =>
  db.reviews.find((r) => r.orderId != null && Number(r.orderId) === Number(orderId)) || null;

const getReviewedOrderIds = () => new Set(db.reviews.filter((r) => r.orderId != null).map((r) => Number(r.orderId)));

function createReview({ userId, orderId, name, rating, text, source, at }) {
  return mutate((d) => {
    const ts = at != null && Number.isFinite(Number(at)) ? Math.round(Number(at)) : Date.now();
    const review = {
      id: d.reviewSeq++,
      userId: userId != null ? String(userId) : null,
      orderId: orderId != null ? Number(orderId) : null,
      name: String(name || 'Клиент').trim().slice(0, 60) || 'Клиент',
      rating: Math.min(5, Math.max(1, Math.round(Number(rating) || 0))),
      text: String(text || '').trim().slice(0, 1000),
      at: ts,
      source: source === 'admin' ? 'admin' : 'order',
    };
    d.reviews.push(review);
    return review;
  });
}

function updateReview(id, patch = {}) {
  return mutate((d) => {
    const review = d.reviews.find((r) => Number(r.id) === Number(id));
    if (!review) return null;
    if (patch.name !== undefined) {
      review.name = String(patch.name || 'Клиент').trim().slice(0, 60) || 'Клиент';
    }
    if (patch.rating !== undefined) {
      review.rating = Math.min(5, Math.max(1, Math.round(Number(patch.rating) || 0)));
    }
    if (patch.text !== undefined) {
      review.text = String(patch.text || '').trim().slice(0, 1000);
    }
    if (patch.reply !== undefined) {
      review.reply = String(patch.reply || '').trim().slice(0, 1000);
      if (review.reply) {
        review.replyAt = Number.isFinite(Number(patch.replyAt)) ? Math.round(Number(patch.replyAt)) : Date.now();
      } else {
        review.replyAt = null;
      }
    }
    if (patch.replyAt !== undefined && patch.replyAt !== null && Number.isFinite(Number(patch.replyAt))) {
      review.replyAt = Math.round(Number(patch.replyAt));
    }
    if (patch.at !== undefined && patch.at !== null && Number.isFinite(Number(patch.at))) {
      review.at = Math.round(Number(patch.at));
    }
    return review;
  });
}

function deleteReview(id) {
  return mutate((d) => {
    const before = d.reviews.length;
    d.reviews = d.reviews.filter((r) => Number(r.id) !== Number(id));
    return before - d.reviews.length;
  });
}

/* ---------- promo codes ---------- */
// Промокоды создаются в админ-панели и дают скидку (улучшение курса выплаты в %) на обмен.
const normalizePromoCode = (raw) => String(raw ?? '').trim().toUpperCase();

const publicPromo = (p) => ({
  code: p.code,
  percent: p.percent,
  minUnits: p.minUnits ?? null,
  expiresAt: p.expiresAt ?? null,
});

function listPromos() {
  return [...db.promos].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (b.id || 0) - (a.id || 0));
}

const getPromo = (id) => db.promos.find((p) => Number(p.id) === Number(id)) || null;

const getPromoByCode = (rawCode) => {
  const code = normalizePromoCode(rawCode);
  if (!code) return null;
  return db.promos.find((p) => normalizePromoCode(p.code) === code) || null;
};

function validatePromo(rawCode, { units = null, now = Date.now() } = {}) {
  const code = normalizePromoCode(rawCode);
  if (!code) return { ok: false, error: 'Введите промокод.' };
  const promo = getPromoByCode(code);
  if (!promo) return { ok: false, error: 'Промокод не найден.' };
  if (promo.active === false) return { ok: false, error: 'Промокод временно отключён.' };
  if (promo.expiresAt != null && Number(now) > Number(promo.expiresAt)) {
    return { ok: false, error: 'Срок действия промокода истёк.' };
  }
  if (promo.maxUses != null && (Number(promo.usedCount) || 0) >= Number(promo.maxUses)) {
    return { ok: false, error: 'Лимит использований промокода исчерпан.' };
  }
  if (promo.minUnits != null && units != null && Number(units) > 0 && Number(units) < Number(promo.minUnits)) {
    return { ok: false, error: `Промокод действует от номинала $${promo.minUnits}.` };
  }
  return { ok: true, promo };
}

function createPromo({ code, percent, maxUses = null, minUnits = null, expiresAt = null, active = true }) {
  return mutate((d) => {
    const now = Date.now();
    const promo = {
      id: d.promoSeq++,
      code: normalizePromoCode(code),
      percent: Math.round(Number(percent) * 100) / 100,
      maxUses: maxUses != null ? Math.round(Number(maxUses)) : null,
      usedCount: 0,
      minUnits: minUnits != null ? Math.round(Number(minUnits)) : null,
      expiresAt: expiresAt != null && Number.isFinite(Number(expiresAt)) ? Math.round(Number(expiresAt)) : null,
      active: active !== false,
      createdAt: now,
      updatedAt: now,
    };
    d.promos.push(promo);
    return promo;
  });
}

function updatePromo(id, patch = {}) {
  return mutate((d) => {
    const promo = d.promos.find((p) => Number(p.id) === Number(id));
    if (!promo) return null;
    if (patch.code !== undefined) promo.code = normalizePromoCode(patch.code);
    if (patch.percent !== undefined) promo.percent = Math.round(Number(patch.percent) * 100) / 100;
    if (patch.maxUses !== undefined) promo.maxUses = patch.maxUses != null ? Math.round(Number(patch.maxUses)) : null;
    if (patch.minUnits !== undefined) promo.minUnits = patch.minUnits != null ? Math.round(Number(patch.minUnits)) : null;
    if (patch.expiresAt !== undefined) {
      promo.expiresAt = patch.expiresAt != null && Number.isFinite(Number(patch.expiresAt))
        ? Math.round(Number(patch.expiresAt))
        : null;
    }
    if (patch.active !== undefined) promo.active = !!patch.active;
    promo.updatedAt = Date.now();
    return promo;
  });
}

function deletePromo(id) {
  return mutate((d) => {
    const before = d.promos.length;
    d.promos = d.promos.filter((p) => Number(p.id) !== Number(id));
    return before - d.promos.length;
  });
}

function consumePromo(id) {
  return mutate((d) => {
    const promo = d.promos.find((p) => Number(p.id) === Number(id));
    if (!promo) return null;
    promo.usedCount = (Number(promo.usedCount) || 0) + 1;
    promo.updatedAt = Date.now();
    return promo;
  });
}

function releaseOrderPromo(orderId) {
  return mutate((d) => {
    const order = d.orders.find((o) => Number(o.id) === Number(orderId));
    if (!order || !order.promoId || order.promoReleased) return false;
    order.promoReleased = true;
    const promo = d.promos.find((p) => Number(p.id) === Number(order.promoId));
    if (promo) {
      promo.usedCount = Math.max(0, (Number(promo.usedCount) || 0) - 1);
      promo.updatedAt = Date.now();
    }
    return true;
  });
}

load();

module.exports = {
  DEFAULT_TICKER,
  DEFAULT_MARQUEE,
  DEFAULT_BLOCK_ORDER,
  normalizeLines,
  normalizeBlockOrder,
  get,
  mutate,
  publicSettings,
  touchUser,
  getUser,
  completedOrderCount,
  loyaltyStatus,
  createOrder,
  getOrder,
  expireIfNeeded,
  EXPIRED,
  EXPIRED_LEGACY,
  updateOrder,
  setReceipt,
  userOrders,
  activeOrders,
  stats,
  createSupportMessage,
  getSupportMessages,
  getSupportThreads,
  countSupportUnread,
  createOrderMessage,
  getOrderMessages,
  publicReview,
  reviewSummary,
  listReviews,
  getReview,
  getReviewByOrder,
  getReviewedOrderIds,
  createReview,
  updateReview,
  deleteReview,
  normalizePromoCode,
  publicPromo,
  listPromos,
  getPromo,
  getPromoByCode,
  validatePromo,
  createPromo,
  updatePromo,
  deletePromo,
  consumePromo,
  releaseOrderPromo,
};
