const fs = require('fs');
const path = require('path');
const currencies = require('./currencies');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const defaults = () => {
  const settings = {
    // Direct BTC/USD spot price; gift-card payout is calculated without fiat conversion.
    btcUsd: 100000, // fallback until the first live market update
    // All USD gift cards share the same BTC rate per $1 and the same fee.
    giftPercent: 0, // exchange fee for cards, % of the BTC equivalent of the face value (0–50)
    rateGOOGLEUSD: null, // BTC per $1 of face value (recalculated from rates and fee)
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
    publicUrl: null,
    botUsername: null,
  };
  settings.rateGOOGLEUSD = currencies.giftRateFromPercent(settings.giftPercent, settings);
  return {
    seq: 1,
    supportSeq: 1,
    settings,
    admins: [], // additional operators; owners are set via the environment
    users: {},
    orders: [],
    flags: {},
    support: [], // support chat: { id, userId, from: 'user'|'admin', text, at }
    reviews: [], // reviews: { id, userId, orderId, name, rating, text, at, source }
    reviewSeq: 1,
  };
};

let db = null;
let saveTimer = null;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = Object.assign(defaults(), raw);
      db.settings = Object.assign(defaults().settings, raw.settings || {});
      // Migration of old databases
      if (!Array.isArray(db.support)) db.support = [];
      if (!Array.isArray(db.reviews)) db.reviews = [];
      if (!Number.isFinite(db.reviewSeq)) {
        db.reviewSeq = db.reviews.reduce((m, r) => Math.max(m, Number(r && r.id) || 0), 0) + 1;
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
      db.settings.rateGOOGLEUSD = currencies.giftRateFromPercent(db.settings.giftPercent, db.settings);
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
  // The client only sees gift-card directions and the final BTC payout per $1 of face value.
  return {
    rates: currencies.publicRates(s).map((r) => ({ ...r, rate: r.direction === 'sell' ? r.rate : null })),
    rateUpdatedAt: s.rateUpdatedAt,
    online: !!s.online,
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
        name: u.first_name || u.name || 'Client',
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
      userName: o.userName || 'Client',
      userUsername: o.userUsername || null,
      direction: 'sell', // gift card sale for BTC only
      payoutCurrency: 'BTC',
      currency: o.currency || null, // gift-card currency/key (e.g. GOOGLE_USD)
      network: o.network || null,   // always null for gift cards
      expiresAt: o.expiresAt ?? null, // deal time limit (gift cards — 1 hour)
      paidAt: null, // when the client tapped "I paid"
      units: o.units ?? null, // gift card face value, $
      giftCode: o.giftCode || null, // card code (visible only to the client and the operator)
      wallet: o.wallet || '',
      rate: o.rate,
      crypto: o.crypto,
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
  return updateOrder(order.id, { status: 'cancelled', cancelReason: EXPIRED });
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
});

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
    avg: count ? sum / count : 0,
    dist,
  };
}

// Newest first: list for the showcase and the admin panel.
function listReviews(limit = 500) {
  const n = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  return [...db.reviews].sort((a, b) => (b.at || 0) - (a.at || 0) || (b.id || 0) - (a.id || 0)).slice(0, n);
}

const getReviewByOrder = (orderId) =>
  db.reviews.find((r) => r.orderId != null && Number(r.orderId) === Number(orderId)) || null;

const getReviewedOrderIds = () => new Set(db.reviews.filter((r) => r.orderId != null).map((r) => Number(r.orderId)));

function createReview({ userId, orderId, name, rating, text, source }) {
  return mutate((d) => {
    const review = {
      id: d.reviewSeq++,
      userId: userId != null ? String(userId) : null,
      orderId: orderId != null ? Number(orderId) : null,
      name: String(name || 'Client').trim().slice(0, 60) || 'Client',
      rating: Math.min(5, Math.max(1, Math.round(Number(rating) || 0))),
      text: String(text || '').trim().slice(0, 1000),
      at: Date.now(),
      source: source === 'admin' ? 'admin' : 'order',
    };
    d.reviews.push(review);
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

load();

module.exports = {
  get,
  mutate,
  publicSettings,
  touchUser,
  getUser,
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
  publicReview,
  reviewSummary,
  listReviews,
  getReviewByOrder,
  getReviewedOrderIds,
  createReview,
  deleteReview,
};
