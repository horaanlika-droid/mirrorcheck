// Анонимные веб-сессии для работы вне Telegram.
//
// Идентичность выдаёт только сервер: подписанный HttpOnly-cookie с случайным
// opaque-id (не Telegram ID и не что-то, что можно «заказать» в запросе).
// Это закрывает прежнюю дыру с ?demo[id]=…, где любой мог назваться оператором.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const COOKIE = 'plx_sid';
const TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 дней
const ID_RE = /^web_[A-Za-z0-9_-]{28,64}$/;

// Форматы id:
// • web_<random> — анонимный гость (по умолчанию)
// • tgweb_<telegramId> — браузер, привязанный к Telegram через ссылку из бота
const WEB_ID_RE = /^web_[A-Za-z0-9_-]{20,64}$/;
const TG_WEB_RE = /^tgweb_[1-9]\d{0,15}$/;
const LEGACY_RE = /^900\d{3}$/;

// Демо-личность (demo[id]/demo[name]) — только для тестов и локальных превью.
// В продакшене она выключена и не может быть включена настройкой из базы.
const legacyAllowed = () => String(process.env.ALLOW_DEMO_AUTH || '') === '1';

// ---------- ключ подписи ----------
let secretCache = null;
function secret() {
  if (secretCache) return secretCache;
  const env = String(process.env.SESSION_SECRET || '').trim();
  if (env.length >= 32) return (secretCache = Buffer.from(env, 'utf8'));
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'session.key');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      const saved = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
      if (saved.length >= 32) return (secretCache = saved);
    }
    const created = crypto.randomBytes(48);
    fs.writeFileSync(file, created.toString('hex'), { mode: 0o600 });
    return (secretCache = created);
  } catch (e) {
    console.error('[session] не удалось прочитать/создать session.key:', e.message);
    // Крайний случай: эфемерный ключ (сессии сбросятся после рестарта).
    return (secretCache = crypto.randomBytes(48));
  }
}

// ---------- псевдонимы ----------
// Имя придумывает сервер: без телефона, почты и реального имени.
const ADJ = [
  'Тихий', 'Быстрый', 'Северный', 'Лунный', 'Стальной', 'Серебряный', 'Неоновый',
  'Далёкий', 'Ясный', 'Скрытый', 'Вольный', 'Холодный', 'Тёплый', 'Звёздный',
  'Туманный', 'Глубокий', 'Лёгкий', 'Стойкий', 'Мягкий', 'Резкий',
];
const NOUN = [
  'Кит', 'Сокол', 'Ворон', 'Лис', 'Барс', 'Ёж', 'Филин', 'Дельфин', 'Олень',
  'Тигр', 'Выдра', 'Койот', 'Пингвин', 'Орёл', 'Рысь', 'Бобр', 'Стриж', 'Мангуст',
  'Тюлень', 'Журавль', 'Сурок', 'Песец', 'Сом', 'Лебедь',
];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O/1/I
const pick = (arr) => arr[crypto.randomInt(arr.length)];
const tag = () => {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
};

function generateNickname() {
  const taken = new Set(Object.values(store.get().users || {}).map((u) => String(u.name || '').toLowerCase()));
  for (let i = 0; i < 12; i++) {
    const nick = `${pick(ADJ)} ${pick(NOUN)} · ${tag()}`;
    if (!taken.has(nick.toLowerCase())) return nick;
  }
  return `Гость · ${tag()}${tag()}`;
}

// ---------- подпись cookie ----------
const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function createToken(id, nickname) {
  const payload = Buffer.from(JSON.stringify({ id, nickname, ts: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(payload))) return null;
  let data = null;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.id !== 'string' || !Number.isFinite(data.ts)) return null;
  if (Date.now() - data.ts > TTL_MS || data.ts > Date.now() + 24 * 60 * 60 * 1000) return null;
  if (!(WEB_ID_RE.test(data.id) || TG_WEB_RE.test(data.id))) return null;
  return { id: data.id, nickname: typeof data.nickname === 'string' ? data.nickname.slice(0, 60) : '' };
}

// ---------- cookie ----------
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function cookieHeader(value, { maxAge = TTL_MS } = {}) {
  const secure = process.env.NODE_ENV === 'production' || String(process.env.COOKIE_SECURE || '') === '1';
  const sameSite = String(process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor(maxAge / 1000)}`,
    'SameSite=' + (sameSite === 'none' ? 'None' : sameSite === 'strict' ? 'Strict' : 'Lax'),
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function setCookie(res, token) {
  res.append('Set-Cookie', cookieHeader(encodeURIComponent(token)));
}

// ---------- проверка «challenge» ----------
// Небольшой proof-of-work для создания анонимной сессии: отсекает массовое
// автоматическое создание профилей без капчи и без внешних сервисов.
const POW_BITS = Number(process.env.POW_BITS || 12);
const POW_FRESH_MS = 2 * 60 * 1000;

function issueChallenge() {
  const seed = crypto.randomBytes(18).toString('base64url');
  const exp = Date.now() + POW_FRESH_MS;
  const payload = Buffer.from(JSON.stringify({ s: seed, e: exp, b: POW_BITS })).toString('base64url');
  return { challenge: `${payload}.${sign(payload)}`, bits: POW_BITS };
}

// Число ведущих нулевых бит. Math.clz32 считает по 32-битному слову,
// поэтому для байта вычитаем 24 (а не 28, как для полубайта).
const leadingZeroBits = (buf) => {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
};

function checkPow(challenge, nonce) {
  if (typeof challenge !== 'string' || challenge.length > 512) return false;
  const n = Number(nonce);
  if (!Number.isSafeInteger(n) || n < 0) return false;
  const dot = challenge.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = challenge.slice(0, dot);
  if (!safeEqual(challenge.slice(dot + 1), sign(payload))) return false;
  let data = null;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!data || typeof data.s !== 'string' || !Number.isFinite(data.e)) return false;
  if (Date.now() > Number(data.e)) return false;
  if (!Number.isFinite(data.b) || data.b < 8 || data.b > 24) return false;
  const hash = crypto.createHash('sha256').update(`${data.s}:${n}`).digest();
  return leadingZeroBits(hash) >= data.b;
}

// ---------- работа с пользователем ----------
function userFromTicket(ticket) {
  const existing = store.getUser(ticket.id);
  if (existing) {
    // Имя закреплено за профилем: смена cookie не переименовывает клиента.
    if (!String(existing.name || '').trim() || existing.name === 'Клиент') {
      const name = ticket.nickname || generateNickname();
      store.touchUser({ id: ticket.id, name }, '');
      return store.getUser(ticket.id);
    }
    return store.touchUser({ id: ticket.id }, '');
  }
  return store.touchUser({ id: ticket.id, name: ticket.nickname || generateNickname() }, '');
}

function issueSession(res, { id, nickname } = {}) {
  const userId = id || `web_${crypto.randomBytes(24).toString('base64url')}`;
  const nick = nickname || generateNickname();
  const user = store.touchUser({ id: userId, name: nick }, '');
  setCookie(res, createToken(userId, user.name));
  return user;
}

// Анонимный пользователь по cookie; при отсутствии — null (создание — по /api/session).
function anonymousUser(req) {
  const token = parseCookies(req)[COOKIE];
  const ticket = token ? readToken(token) : null;
  return ticket ? userFromTicket(ticket) : null;
}

// ---------- привязка Telegram ↔ браузер ----------
function linkCode(userId) {
  const code = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toUpperCase();
  store.mutate((db) => {
    db.linkCodes = db.linkCodes || {};
    db.linkCodes[code] = { userId: String(userId), exp: Date.now() + 10 * 60 * 1000 };
    // Чистим просроченные, чтобы база не росла.
    for (const [k, v] of Object.entries(db.linkCodes)) {
      if (!v || !Number.isFinite(v.exp) || v.exp < Date.now() - 60 * 60 * 1000) delete db.linkCodes[k];
    }
  });
  return { code, exp: Date.now() + 10 * 60 * 1000 };
}

// Web-пользователь вводит код из Telegram → его профиль становится tgweb_<id>.
function redeemLinkCode(code, webUserId) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(normalized)) return null;
  const entry = (store.get().linkCodes || {})[normalized];
  if (!entry || entry.exp < Date.now()) return null;
  const tgId = String(entry.userId);
  if (!/^[1-9]\d{0,15}$/.test(tgId)) return null;
  const targetId = `tgweb_${tgId}`;
  const result = store.mutate((db) => {
    delete db.linkCodes[normalized];
    const webUser = db.users[String(webUserId)];
    if (!webUser) return null;
    const target = db.users[targetId];
    if (target) {
      // Одну личность нельзя слить с чужой привязанной сессией: просто переносим
      // заявки и отзывы веб-профиля на Telegram-профиль, имя оставляем из Telegram.
      for (const o of db.orders) if (String(o.userId) === String(webUserId)) o.userId = targetId;
      for (const m of db.orderMessages || []) if (String(m.userId) === String(webUserId)) m.userId = targetId;
      for (const s of db.support || []) if (String(s.userId) === String(webUserId)) s.userId = targetId;
      for (const r of db.reviews || []) if (String(r.userId) === String(webUserId)) r.userId = targetId;
      delete db.users[String(webUserId)];
      return { id: targetId, nickname: target.name };
    }
    webUser.id = targetId;
    webUser.telegramId = tgId;
    return { id: targetId, nickname: webUser.name };
  });
  return result;
}

function revokeLink(userId, confirm) {
  if (confirm !== 'REVOKE') throw new Error('Требуется подтверждение: отправьте {"confirm":"REVOKE"}.');
  const id = String(userId);
  if (!/^tgweb_[1-9]\d{0,15}$/.test(id)) throw new Error('Текущая сессия не привязана к Telegram.');
  const newId = `web_${crypto.randomBytes(24).toString('base64url')}`;
  const nick = generateNickname();
  store.mutate((db) => {
    const u = db.users[id];
    if (!u) return;
    for (const o of db.orders) if (String(o.userId) === id) o.userId = newId;
    for (const m of db.orderMessages || []) if (String(m.userId) === id) m.userId = newId;
    for (const s of db.support || []) if (String(s.userId) === id) s.userId = newId;
    for (const r of db.reviews || []) if (String(r.userId) === id) r.userId = newId;
    delete db.users[id];
    db.users[newId] = { ...u, id: newId, name: nick, telegramId: null, lastSeen: Date.now() };
  });
  return { id: newId, nickname: nick };
}

module.exports = {
  COOKIE,
  TTL_MS,
  WEB_ID_RE,
  TG_WEB_RE,
  LEGACY_RE,
  legacyAllowed,
  generateNickname,
  createToken,
  readToken,
  parseCookies,
  cookieHeader,
  setCookie,
  issueChallenge,
  checkPow,
  anonymousUser,
  issueSession,
  linkCode,
  redeemLinkCode,
  revokeLink,
  // only for tests
  _sign: sign,
};
