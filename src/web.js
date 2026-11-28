const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const currencies = require('./currencies');
const { validateInitData, parseUser } = require('./validate');
const admins = require('./admins');
const textCatalogue = require('./texts');
const orderChat = require('./orderchat');
const attachments = require('./attachments');
const session = require('./session');
const { createLimiter, rateLimit, ipOf } = require('./ratelimit');

const clientOrder = (o, reviewedIds) => ({
  id: o.id,
  direction: o.direction || 'sell',
  currency: o.currency,
  network: o.network || null,
  payoutId: o.payoutId || null,
  currencyLabel: currencies.label(o.currency),
  payoutCurrency: currencies.payoutCurrencyOf(o),
  payoutLabel: currencies.payoutLabelOf(o),
  payoutDecimals: currencies.payoutDecimals(currencies.payoutCurrencyOf(o)),
  networkFee: Number(o.networkFee) || 0,
  grossCrypto: o.grossCrypto ?? o.crypto,
  instant: o.network === currencies.PAYOUT_NETWORK,
  units: o.units ?? null,
  giftCode: o.giftCode || null,
  expiresAt: o.expiresAt ?? null,
  paidAt: o.paidAt || null,
  cancelReason: o.cancelReason || null,
  wallet: o.wallet,
  crypto: o.crypto,
  rate: o.rate,
  promoCode: o.promoCode || null,
  promoPercent: o.promoPercent ?? null,
  baseCrypto: o.baseCrypto ?? null,
  loyaltyDiscountPercent: o.loyaltyDiscountPercent ?? 0,
  loyaltyExchangeNumber: o.loyaltyExchangeNumber ?? null,
  status: o.status,
  requisites: o.requisites,
  receipt: o.receipt || null,
  txUrl: o.txUrl || null,
  reviewed: reviewedIds ? reviewedIds.has(Number(o.id)) : !!store.getReviewByOrder(o.id),
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

// Веб-клиент получает только публичные поля профиля: Telegram ID, username и
// привязку к Telegram наружу не отдаём (минимизация данных).
const clientUser = (u) => {
  const webId = /^tgweb_([1-9]\d{0,15})$/.exec(String(u.id));
  const tgId = /^[1-9]\d{0,15}$/.test(String(u.id)) ? String(u.id) : webId ? webId[1] : null;
  return {
    // Реферальную ссылку в Telegram можно строить только для Telegram-профилей.
    // Внутренний веб-id не отдаём: он не нужен интерфейсу и не должен утекать.
    id: tgId,
    telegramId: tgId,
    name: u.name,
    username: u.username || null,
    referrer: u.referrer,
    referredCount: u.referredCount || 0,
    // Анонимный псевдоним неизменяем; админ-панель — только для реальных операторов.
    anonymous: !webId,
    linked: !!webId,
    isAdmin: admins.has(String(u.id)),
  };
};

const MIN_TS = Date.UTC(2000, 0, 1);
const MAX_TS = Date.UTC(2100, 11, 31, 23, 59, 59);

function parseTimestamp(raw, errLabel = 'Некорректный формат даты и времени.') {
  if (raw === undefined || raw === null || raw === '') {
    return { provided: false, value: null };
  }
  let ts = NaN;
  if (typeof raw === 'number') {
    ts = raw;
  } else {
    const str = String(raw).trim();
    if (!str) return { provided: false, value: null };
    if (/^-?\d+$/.test(str)) {
      ts = Number(str);
    } else {
      // Поддержка DD.MM.YYYY HH:mm(:ss)? и ISO/YYYY-MM-DD HH:mm
      const ru = str.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[\sT]+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
      if (ru) {
        const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = ru;
        const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
        if (
          d.getFullYear() === Number(yyyy) &&
          d.getMonth() === Number(mm) - 1 &&
          d.getDate() === Number(dd) &&
          d.getHours() === Number(hh) &&
          d.getMinutes() === Number(mi) &&
          d.getSeconds() === Number(ss)
        ) {
          ts = d.getTime();
        }
      } else {
        ts = Date.parse(str.includes(' ') && !str.includes('T') ? str.replace(' ', 'T') : str);
      }
    }
  }
  if (!Number.isFinite(ts) || ts < MIN_TS || ts > MAX_TS) {
    return { provided: true, error: errLabel };
  }
  return { provided: true, value: Math.round(ts) };
}

function validatePromoInput(body, { partial = false, existingId = null } = {}) {
  const b = body || {};
  const patch = {};

  if (!partial || b.code !== undefined) {
    const code = store.normalizePromoCode(b.code);
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
      return { status: 400, error: 'Код промокода: от 2 до 32 символов (латинские буквы, цифры, «-» и «_»).' };
    }
    const existing = store.getPromoByCode(code);
    if (existing && Number(existing.id) !== Number(existingId)) {
      return { status: 409, error: 'Промокод с таким кодом уже существует.' };
    }
    patch.code = code;
  }

  if (!partial || b.percent !== undefined) {
    const pct = Number(String(b.percent ?? '').replace(',', '.'));
    if (!Number.isFinite(pct) || pct < 0.1 || pct > 50) {
      return { status: 400, error: 'Скидка промокода: число от 0.1 до 50 (%).' };
    }
    patch.percent = Math.round(pct * 100) / 100;
  }

  if (b.maxUses !== undefined) {
    if (b.maxUses === null || String(b.maxUses).trim() === '') {
      patch.maxUses = null;
    } else {
      const m = Number(b.maxUses);
      if (!Number.isInteger(m) || m < 1 || m > 1000000) {
        return { status: 400, error: 'Лимит использований: целое число от 1 (или оставьте пустым).' };
      }
      patch.maxUses = m;
    }
  } else if (!partial) {
    patch.maxUses = null;
  }

  if (b.minUnits !== undefined) {
    if (b.minUnits === null || String(b.minUnits).trim() === '') {
      patch.minUnits = null;
    } else {
      const mu = Number(b.minUnits);
      if (!Number.isInteger(mu) || mu < 10 || mu % 10 !== 0 || mu > 100000) {
        return { status: 400, error: 'Минимальный номинал: от $10, кратно $10 (или оставьте пустым).' };
      }
      patch.minUnits = mu;
    }
  } else if (!partial) {
    patch.minUnits = null;
  }

  if (b.expiresAt !== undefined) {
    const parsed = parseTimestamp(b.expiresAt, 'Некорректная дата окончания промокода.');
    if (parsed.error) return { status: 400, error: parsed.error };
    patch.expiresAt = parsed.provided ? parsed.value : null;
  } else if (!partial) {
    patch.expiresAt = null;
  }

  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') {
      return { status: 400, error: 'active: только true или false.' };
    }
    patch.active = b.active;
  } else if (!partial) {
    patch.active = true;
  }

  if (partial && !Object.keys(patch).length) {
    return { status: 400, error: 'Нечего обновлять — передайте хотя бы одно поле.' };
  }

  return { patch };
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // За прокси (бот-хостинги, nginx) реальный IP приходит в X-Forwarded-For.
  // Без настройки доверяем только loopback, иначе клиент подделает IP и обойдёт лимиты.
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : 'loopback');
  app.set('query parser', 'extended');
  app.use(express.json({ limit: '12mb' }));
  // body-parser может прислать ошибку в next(err) — отвечаем JSON, а не 500-страницей.
  app.use((err, _req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Запрос слишком большой. Максимальный размер вложения — 8 МБ.' });
    if (err.type === 'entity.parse.failed' || err.status === 400) return res.status(400).json({ error: 'Некорректный JSON в запросе.' });
    return next(err);
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, private');
    next();
  });

  app.use((req, res, next) => {
    // Базовые защитные заголовки. CSP не запрещает inline-стили/скрипты, потому что
    // интерфейс и Telegram SDK их используют, но запрещает фрейминг и чужие connect-хосты.
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://telegram.org",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        // Mini App встраивают web.telegram.org, Telegram Desktop и мобильные клиенты.
        "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://*.t.me https://t.me telegram:",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; ')
    );
    if (String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https') {
      res.set('Strict-Transport-Security', 'max-age=15552000');
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html' || req.path === '/app.js' || req.path === '/order-chat.js')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
    }
    next();
  });

  // Защита от CSRF и «чужих» сайтов: состояние меняем только с нашего Origin
  // (или без него — старые Mini App/нативные клиенты), и никогда с чужим.
  const selfHosts = () => {
    const hosts = new Set();
    const add = (raw) => {
      try {
        const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw);
        hosts.add(u.host.toLowerCase());
      } catch {}
    };
    if (store.get().settings.publicUrl) add(store.get().settings.publicUrl);
    if (config.publicUrl) add(config.publicUrl);
    return hosts;
  };
  app.use((req, res, next) => {
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!write) return next();
    const origin = String(req.get('origin') || '');
    if (origin && origin !== 'null') {
      let host = '';
      try { host = new URL(origin).host.toLowerCase(); } catch { return res.status(403).json({ error: 'Запрос отклонён' }); }
      const own = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim().toLowerCase();
      if (host !== own && !selfHosts().has(host)) {
        return res.status(403).json({ error: 'Запрос отклонён: недопустимый источник' });
      }
    }
    const fetchSite = String(req.get('sec-fetch-site') || '');
    if (fetchSite === 'cross-site') {
      return res.status(403).json({ error: 'Запрос отклонён: межсайтовый запрос' });
    }
    // JSON API: простые cross-site формы не должны менять состояние.
    // Пустое тело (cancel/confirm без данных) пропускаем — вреда от него нет.
    if (write && req.path.startsWith('/api/') && (req.get('content-length') || req.get('transfer-encoding'))) {
      if (!String(req.get('content-type') || '').includes('application/json')) {
        return res.status(415).json({ error: 'Требуется Content-Type: application/json' });
      }
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'GET') {
      const proto = String(req.get('x-forwarded-proto') || 'https').split(',')[0].trim();
      const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
      if (
        host &&
        !/^(localhost|127\.|0\.0\.0\.0|\[|192\.168\.|10\.)/.test(host) &&
        !host.includes('127.0.0.1')
      ) {
        const url = `${proto}://${host}`.replace(/\/+$/, '');
        if (url !== store.get().settings.publicUrl) {
          store.mutate((db) => {
            db.settings.publicUrl = url;
          });
          console.log('[Pricelex Worldwide] public address auto-detected:', url);
          bus.emit('public_url', url);
        }
      }
    }
    next();
  });

  /* ---------- идентичность ---------- */
  // Приоритет: подписанный Telegram initData → подписанная cookie веб-сессии.
  // Клиентские поля demo[id]/demo[name] больше не принимаются как личность:
  // раньше так можно было выдать себя за оператора 900001.
  const limiter = createLimiter();

  const auth = (req) => {
    const body = req.body || {};
    const q = req.query || {};
    const initData = body.initData || q.initData || req.get('x-telegram-init-data') || '';
    if (initData && config.botToken && validateInitData(initData, config.botToken)) {
      return { user: parseUser(initData), demo: false, source: 'telegram' };
    }
    // Совместимость с тестами и локальными превью: demo-личность принимается только
    // когда сессии выдавать нечем (нет BOT_TOKEN) и только из временного DATA_DIR.
    // Разбор: ?demo[id]=…, ?demo=900002 и тело {"demo":{…}} или {"demo":"900002"}.
    const rawDemo = body.demo || q.demo;
    const demo = rawDemo && typeof rawDemo === 'object' ? rawDemo : rawDemo ? { id: rawDemo } : null;
    if (demo && demo.id && !config.botToken && session.legacyAllowed() && /^\d{1,18}$/.test(String(demo.id))) {
      return {
        user: { id: String(demo.id), first_name: demo.name || 'Demo', username: demo.username || '' },
        demo: true,
        source: 'demo',
      };
    }
    const webUser = session.anonymousUser(req);
    if (webUser) return { user: webUser, demo: false, source: 'web' };
    return null;
  };

  const needAuth = (req, res) => {
    const a = auth(req);
    if (!a) {
      res.status(401).json({ error: 'Не авторизован' });
      return null;
    }
    return a;
  };

  const isAdminRequest = (req) => {
    const a = auth(req);
    if (!a) return null;
    return admins.has(String(a.user.id)) ? a : null;
  };

  app.post('/api/init', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.body.startParam || '');
    res.json({
      me: clientUser(user),
      settings: store.publicSettings(),
      demo: a.demo,
      source: a.source,
      // Доступна ли анонимная сессия и куда идти за кодом привязки к Telegram.
      web: webInfo(),
    });
  });

  // Публичные настройки: без сессии тоже доступны (витрина и курс до входа).
  app.get('/api/settings', (req, res) => res.json(store.publicSettings()));

  // Публичная информация о веб-входе (нужна профилю: куда идти за кодом привязки).
  const webInfo = () => ({
    anonymousLogin: store.get().settings.webAccess !== 'telegram',
    linkBot: store.get().settings.botUsername || (store.get().settings.bots || {}).client || null,
  });

  /* ---------- анонимная веб-сессия ---------- */
  // 1) /api/session/challenge — proof-of-work, чтобы не плодить профили пачками.
  app.get('/api/session/challenge', (req, res) => {
    if (!rateLimit(limiter, 'session', req, res)) return;
    res.json({ ...session.issueChallenge(), required: true });
  });

  // 2) /api/session — сервер сам придумывает имя и выдаёт подписанную HttpOnly-cookie.
  app.post('/api/session', (req, res) => {
    if (!rateLimit(limiter, 'session', req, res)) return;
    if (!rateLimit(limiter, 'sessionDay', req, res)) return;
    if (store.get().settings.webAccess === 'telegram') {
      return res.status(403).json({ error: 'Анонимный вход отключён. Откройте приложение через Telegram.' });
    }
    const { challenge, nonce } = req.body || {};
    if (!session.checkPow(challenge, nonce)) {
      return res.status(400).json({ error: 'Не пройдена проверка безопасности. Обновите страницу.' });
    }
    const user = session.issueSession(res);
    res.status(201).json({ me: clientUser(user), settings: store.publicSettings(), demo: false, source: 'web', web: webInfo() });
  });

  // 3) Привязка к Telegram: код из бота (/link) превращает веб-профиль в tgweb_<id>.
  app.post('/api/link', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!rateLimit(limiter, 'link', req, res)) return;
    const code = String(req.body?.code || '').trim();
    const linked = session.redeemLinkCode(code, a.user.id);
    if (!linked) return res.status(400).json({ error: 'Код неверный или истёк. Получите новый в боте: /link' });
    session.issueSession(res, linked);
    const user = store.getUser(linked.id);
    res.json({ me: clientUser(user), settings: store.publicSettings(), demo: false, source: 'web', web: webInfo() });
  });

  app.post('/api/link/revoke', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!rateLimit(limiter, 'link', req, res)) return;
    try {
      const next = session.revokeLink(a.user.id, String(req.body?.confirm || ''));
      session.issueSession(res, next);
      res.json({ me: clientUser(store.getUser(next.id)), settings: store.publicSettings(), demo: false, source: 'web', web: webInfo() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /* ---------- лимиты для действий ---------- */
  app.use((req, res, next) => {
    // Общий потолок на IP: приложение опрашивает статусы каждые 3 секунды.
    if (!rateLimit(limiter, 'api', req, res)) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !rateLimit(limiter, 'writes', req, res)) return;
    next();
  });

  // Only known fixed UI strings can be changed; never accept arbitrary keys or HTML.
  app.get('/api/admin/texts', (req, res) => {
    if (!needAuth(req, res)) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    res.json({ texts: textCatalogue(), overrides: store.get().settings.textOverrides || {} });
  });
  app.put('/api/admin/texts', (req, res) => {
    if (!needAuth(req, res)) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const { id, value } = req.body || {};
    if (!textCatalogue().some((item) => item.id === id) || (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 2000))) {
      return res.status(400).json({ error: 'Некорректный текст или идентификатор.' });
    }
    store.mutate((db) => {
      if (!db.settings.textOverrides || typeof db.settings.textOverrides !== 'object') db.settings.textOverrides = {};
      if (value === null) delete db.settings.textOverrides[id];
      else db.settings.textOverrides[id] = value;
    });
    res.json({ settings: store.publicSettings() });
  });

  // Админ: все редактируемые настройки. Курс и скидка отдаются для каждой карты отдельно.
  const adminSettingsBlock = () => {
    const s = store.get().settings;
    const on = (key) => currencies.isEnabled(s, key);
    return {
      chat: s.chat,
      usdtUsd: s.usdtUsd,
      btcUsd: currencies.btcUsdQuote(s.btcUsd) || 95000,
      cardFees: Object.fromEntries(currencies.GIFT_KEYS.map((key) => [key, currencies.feeOf(s, key)])),
      cardRates: currencies.allCardRates(s),
      directions: Object.fromEntries(currencies.list().map((p) => [p.key, on(p.key)])),
      networkFees: Object.fromEntries(currencies.PAYOUT_OPTION_LIST.map((o) => [o.id, currencies.networkFeeOf(s, o)])),
      payoutEnabled: Object.fromEntries(currencies.PAYOUT_OPTION_LIST.map((o) => [o.id, currencies.isPayoutEnabled(s, o)])),
      payoutOptions: currencies.publicPayoutOptions(s),
      online: !!s.online,
      ticker: store.normalizeLines(s.ticker, store.DEFAULT_TICKER),
      tickerEnabled: s.tickerEnabled !== false,
      marquee: store.normalizeLines(s.marquee, store.DEFAULT_MARQUEE),
      marqueeEnabled: s.marqueeEnabled !== false,
      blockOrder: store.normalizeBlockOrder(s.blockOrder),
      defaultTicker: store.DEFAULT_TICKER,
      defaultMarquee: store.DEFAULT_MARQUEE,
      defaultBlockOrder: store.DEFAULT_BLOCK_ORDER,
    };
  };

  function parseRunningLinesInput(raw, label) {
    if (raw === null) return { reset: true };
    let lines;
    if (typeof raw === 'string') {
      lines = raw.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      lines = raw.map((v) => String(v ?? '').trim()).filter(Boolean);
    } else {
      return { error: `${label}: передайте список строк или текст.` };
    }
    if (!lines.length) {
      return { error: `${label}: добавьте хотя бы одну фразу (или выключите строку).` };
    }
    if (lines.length > 30) {
      return { error: `${label}: максимум 30 фраз.` };
    }
    if (lines.some((line) => line.length > 200)) {
      return { error: `${label}: каждая фраза не длиннее 200 символов.` };
    }
    return { lines };
  }

  function parseBlockOrderPatch(raw) {
    if (raw === null) return { reset: true };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'blockOrder: ожидается объект секций.' };
    }
    const patch = {};
    for (const [section, list] of Object.entries(raw)) {
      const def = store.DEFAULT_BLOCK_ORDER[section];
      if (!def) {
        return { error: `Неизвестная секция блоков: ${section}` };
      }
      if (!Array.isArray(list)) {
        return { error: `Секция ${section}: ожидается массив идентификаторов блоков.` };
      }
      const valid = new Set(def);
      const seen = new Set();
      const cleaned = [];
      for (const item of list) {
        const key = String(item ?? '').trim();
        if (!valid.has(key) || seen.has(key)) {
          return { error: `Некорректный блок «${key}» в секции ${section}.` };
        }
        seen.add(key);
        cleaned.push(key);
      }
      for (const key of def) {
        if (!seen.has(key)) cleaned.push(key);
      }
      patch[section] = cleaned;
    }
    if (!Object.keys(patch).length) {
      return { error: 'Передайте хотя бы одну секцию для изменения порядка.' };
    }
    return { patch };
  }

  app.get('/api/admin/settings', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    res.json({ admin: adminSettingsBlock(), settings: store.publicSettings() });
  });

  app.put('/api/admin/tickers', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const body = req.body || {};
    const patch = {};
    if (body.ticker !== undefined) {
      const parsed = parseRunningLinesInput(body.ticker, 'Верхняя бегущая строка');
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      patch.ticker = parsed.reset ? [...store.DEFAULT_TICKER] : parsed.lines;
    }
    if (body.tickerEnabled !== undefined) {
      if (typeof body.tickerEnabled !== 'boolean') return res.status(400).json({ error: 'tickerEnabled: только true или false' });
      patch.tickerEnabled = body.tickerEnabled;
    }
    if (body.marquee !== undefined) {
      const parsed = parseRunningLinesInput(body.marquee, 'Крупная бегущая строка');
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      patch.marquee = parsed.reset ? [...store.DEFAULT_MARQUEE] : parsed.lines;
    }
    if (body.marqueeEnabled !== undefined) {
      if (typeof body.marqueeEnabled !== 'boolean') return res.status(400).json({ error: 'marqueeEnabled: только true или false' });
      patch.marqueeEnabled = body.marqueeEnabled;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Нечего обновлять — передайте настройки бегущих строк.' });
    }
    store.mutate((db) => {
      Object.assign(db.settings, patch);
    });
    res.json({ settings: store.publicSettings(), admin: adminSettingsBlock() });
  });

  app.put('/api/admin/layout', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const body = req.body || {};
    let input = body.blockOrder;
    if (body.reset === true) input = null;
    else if (input === undefined && body.section !== undefined) {
      input = { [String(body.section)]: body.order };
    }
    const parsed = parseBlockOrderPatch(input);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    store.mutate((db) => {
      const current = store.normalizeBlockOrder(db.settings.blockOrder);
      db.settings.blockOrder = parsed.reset
        ? store.normalizeBlockOrder(store.DEFAULT_BLOCK_ORDER)
        : store.normalizeBlockOrder({ ...current, ...parsed.patch });
    });
    res.json({ settings: store.publicSettings(), admin: adminSettingsBlock() });
  });

  const CLIENTS_ANNOUNCE_OPEN =
    '🟢 <b>Pricelex Worldwide: приём карт открыт!</b>\n\n' +
    'Снова принимаем подарочные карты Google, iTunes, Xbox и Apple Store региона США в USD 🎁\n' +
    'Выплата только в USDT (BEP-20), без документов и регистрации — в приложении и в боте.';
  const DIRECTION_KEYS = currencies.list().map((p) => p.key);
  const feeValue = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 50 ? Number(v) : null);

  // Админ: частичное обновление настроек (направления, курсы карт, чат, приём заявок).
  app.post('/api/admin/settings', async (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const body = req.body || {};
    const patch = {};
    // 1) Включение/выключение направлений
    if (body.enabled && typeof body.enabled === 'object') {
      const map = {};
      for (const key of Object.keys(body.enabled)) {
        if (!DIRECTION_KEYS.includes(key)) return res.status(400).json({ error: `Неизвестное направление: ${key}` });
        if (typeof body.enabled[key] !== 'boolean') return res.status(400).json({ error: 'enabled: только true или false' });
        map[key] = body.enabled[key];
      }
      patch.enabled = map;
    }
    // 2) Индивидуальные скидки карт → у каждой карты свой курс выплаты.
    //    cardFees: { GOOGLE_USD: 5, ITUNES_USD: 12, ... } — можно менять одну карту, остальные не затрагиваются.
    let cardFeesPatch = null;
    if (body.cardFees !== undefined) {
      if (!body.cardFees || typeof body.cardFees !== 'object' || Array.isArray(body.cardFees)) {
        return res.status(400).json({ error: 'cardFees: ожидается объект с курсами по картам.' });
      }
      const map = {};
      for (const [key, value] of Object.entries(body.cardFees)) {
        if (!DIRECTION_KEYS.includes(key)) return res.status(400).json({ error: `Неизвестная карта: ${key}` });
        const v = feeValue(value);
        if (v === null) return res.status(400).json({ error: `Скидка для ${currencies.label(key)}: число от 0 до 50 (%).` });
        map[key] = v;
      }
      if (Object.keys(map).length) cardFeesPatch = map;
    }
    // Совместимость со старым полем giftPercent: применяет одну скидку ко всем картам.
    if (body.giftPercent !== undefined) {
      const v = feeValue(body.giftPercent);
      if (v === null) return res.status(400).json({ error: 'Скидка карты: число от 0 до 50 (%).' });
      cardFeesPatch = Object.fromEntries(DIRECTION_KEYS.map((key) => [key, v]));
    }
    // 3) Открытие/закрытие приёма заявок
    let openTrading = null;
    if (body.online !== undefined) {
      if (typeof body.online !== 'boolean') return res.status(400).json({ error: 'online: только true или false' });
      openTrading = body.online;
    }
    // 4) Ссылка на чат
    if (body.chat !== undefined) {
      const chat = String(body.chat || '').trim().slice(0, 300);
      if (chat.length < 8 || !(chat.startsWith('https://') || /^@[A-Za-z0-9_]{5,32}$/.test(chat))) {
        return res.status(400).json({ error: 'Укажите ссылку t.me/… или юзернейм @…' });
      }
      patch.chat = chat;
    }
    // 5) Бегущие строки и порядок блоков
    if (body.ticker !== undefined) {
      const parsed = parseRunningLinesInput(body.ticker, 'Верхняя бегущая строка');
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      patch.ticker = parsed.reset ? [...store.DEFAULT_TICKER] : parsed.lines;
    }
    if (body.tickerEnabled !== undefined) {
      if (typeof body.tickerEnabled !== 'boolean') return res.status(400).json({ error: 'tickerEnabled: только true или false' });
      patch.tickerEnabled = body.tickerEnabled;
    }
    if (body.marquee !== undefined) {
      const parsed = parseRunningLinesInput(body.marquee, 'Крупная бегущая строка');
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      patch.marquee = parsed.reset ? [...store.DEFAULT_MARQUEE] : parsed.lines;
    }
    if (body.marqueeEnabled !== undefined) {
      if (typeof body.marqueeEnabled !== 'boolean') return res.status(400).json({ error: 'marqueeEnabled: только true или false' });
      patch.marqueeEnabled = body.marqueeEnabled;
    }
    let blockOrderPatch = null;
    if (body.blockOrder !== undefined) {
      const parsed = parseBlockOrderPatch(body.blockOrder);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      blockOrderPatch = parsed;
    }
    // 6) Сети выплат, комиссии сетей и курс BTC/USD
    let networkFeesPatch = null;
    if (body.networkFees !== undefined) {
      if (!body.networkFees || typeof body.networkFees !== 'object' || Array.isArray(body.networkFees)) {
        return res.status(400).json({ error: 'networkFees: ожидается объект с комиссиями сетей.' });
      }
      const map = {};
      for (const [id, value] of Object.entries(body.networkFees)) {
        const opt = currencies.PAYOUT_OPTIONS[id];
        if (!opt) return res.status(400).json({ error: `Неизвестная сеть выплаты: ${id}` });
        const num = Number(value);
        if (opt.instant) {
          if (!Number.isFinite(num) || num !== 0) {
            return res.status(400).json({ error: 'Вывод в USDT (BEP-20) всегда моментальный и без комиссии (0).' });
          }
          map[id] = 0;
        } else {
          if (!Number.isFinite(num) || num < 0 || num > opt.maxFee) {
            return res.status(400).json({ error: `Комиссия сети ${opt.label}: число от 0 до ${opt.maxFee} ${opt.feeUnit}.` });
          }
          map[id] = currencies.clampNetworkFee(num, opt);
        }
      }
      if (Object.keys(map).length) networkFeesPatch = map;
    }
    let payoutEnabledPatch = null;
    if (body.payoutEnabled !== undefined) {
      if (!body.payoutEnabled || typeof body.payoutEnabled !== 'object' || Array.isArray(body.payoutEnabled)) {
        return res.status(400).json({ error: 'payoutEnabled: ожидается объект.' });
      }
      const map = {};
      for (const [id, value] of Object.entries(body.payoutEnabled)) {
        const opt = currencies.PAYOUT_OPTIONS[id];
        if (!opt) return res.status(400).json({ error: `Неизвестная сеть выплаты: ${id}` });
        if (typeof value !== 'boolean') return res.status(400).json({ error: 'payoutEnabled: только true или false' });
        if (opt.instant && value === false) {
          return res.status(400).json({ error: 'Моментальный вывод в USDT (BEP-20) без комиссии должен оставаться доступным.' });
        }
        map[id] = value;
      }
      if (Object.keys(map).length) payoutEnabledPatch = map;
    }
    if (body.btcUsd !== undefined) {
      const bq = currencies.btcUsdQuote(body.btcUsd);
      if (!bq) return res.status(400).json({ error: 'btcUsd: укажите корректный курс BTC/USD (1000–10000000).' });
      patch.btcUsd = Math.round(bq * 100) / 100;
    }
    if (openTrading !== null) patch.online = openTrading;
    if (!Object.keys(patch).length && !cardFeesPatch && !blockOrderPatch && !networkFeesPatch && !payoutEnabledPatch) {
      return res.status(400).json({ error: 'Нечего обновлять — передайте хотя бы одно поле.' });
    }
    const wasOnline = !!store.get().settings.online;
    store.mutate((db) => {
      const s = db.settings;
      if (patch.enabled) {
        s.enabled = { ...(s.enabled || {}), ...patch.enabled };
      }
      for (const key of ['chat', 'online', 'ticker', 'tickerEnabled', 'marquee', 'marqueeEnabled', 'btcUsd']) {
        if (patch[key] !== undefined) s[key] = patch[key];
      }
      if (networkFeesPatch) {
        s.networkFees = { ...(s.networkFees || {}), ...networkFeesPatch, USDT_BEP20: 0 };
      }
      if (payoutEnabledPatch) {
        s.payoutEnabled = { ...(s.payoutEnabled || {}), ...payoutEnabledPatch, USDT_BEP20: true };
      }
      if (blockOrderPatch) {
        const current = store.normalizeBlockOrder(s.blockOrder);
        s.blockOrder = blockOrderPatch.reset
          ? store.normalizeBlockOrder(store.DEFAULT_BLOCK_ORDER)
          : store.normalizeBlockOrder({ ...current, ...blockOrderPatch.patch });
      }
      if (cardFeesPatch) {
        s.cardFees = { ...(s.cardFees || {}), ...cardFeesPatch };
        s.cardRates = currencies.allCardRates(s);
      }
    });
    // Открытие приёма: рассылаем объявление клиентам.
    let announced = 0;
    if (!wasOnline && patch.online === true) {
      const results = await bus.emit('announce', { text: CLIENTS_ANNOUNCE_OPEN });
      announced = (results && results[0] && results[0].sent) || 0;
    }
    res.json({ settings: store.publicSettings(), admin: adminSettingsBlock(), announced });
  });

  // Admin: changing the chat link — instantly visible to everyone on the site and in the app.
  app.post('/api/admin/settings/chat', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    }
    const chat = String(req.body?.chat || '').trim().slice(0, 300);
      if (chat.length < 8 || !(chat.startsWith('https://') || /^@[A-Za-z0-9_]{5,32}$/.test(chat))) {
      return res.status(400).json({ error: 'Укажите ссылку t.me/… или юзернейм @… (например https://t.me/+abc или @support_team)' });
    }
    store.mutate((db) => { db.settings.chat = chat; });
    res.json({ settings: store.publicSettings() });
  });

  app.get('/api/me', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.query.startParam || '');
    const reviewedIds = store.getReviewedOrderIds();
    const loyalty = store.loyaltyStatus(user.id);
    if (loyalty.eligible) {
      loyalty.rates = Object.fromEntries(currencies.GIFT_KEYS.map((key) => {
        const adjusted = currencies.rateAfterFeeDiscount(store.get().settings, key, loyalty.discountPercent);
        return [key, adjusted.rate];
      }));
      loyalty.feeDiscounts = Object.fromEntries(currencies.GIFT_KEYS.map((key) => [
        key, currencies.rateAfterFeeDiscount(store.get().settings, key, loyalty.discountPercent).feeDiscountPercent,
      ]));
    }
    res.json({ me: clientUser(user), loyalty, orders: store.userOrders(user.id).map((o) => clientOrder(o, reviewedIds)) });
  });

  app.post('/api/orders', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!rateLimit(limiter, 'orders', req, res, { key: a.user.id })) return;
    const s = store.get().settings;
    const currency = String(req.body.currency || '').toUpperCase();
    const pair = currencies.find(currency);
    const wallet = String(req.body.wallet || '').trim();
    if (!s.online) return res.status(403).json({ error: 'Обмен временно недоступен' });
    if (!pair || pair.kind !== 'gift') return res.status(400).json({ error: 'Неизвестная карта' });
    if (!currencies.isEnabled(s, pair.key)) {
      return res.status(400).json({ error: `Выкуп ${pair.label} временно недоступен — выберите другую карту.` });
    }
    const payoutOption = currencies.findPayoutOption(req.body);
    if (!payoutOption) {
      return res.status(400).json({ error: 'Неподдерживаемая валюта или сеть выплаты. Доступны USDT (BEP-20, TRC-20, ERC-20, TON) и BTC.' });
    }
    if (!currencies.isPayoutEnabled(s, payoutOption.id)) {
      return res.status(400).json({ error: `Выплата в ${payoutOption.label} временно недоступна — выберите другую сеть.` });
    }
    const user = store.touchUser(a.user, req.body.startParam || '');

    /* ---------- gift card → USDT (BEP-20 / TRC-20 / ERC-20 / TON) или BTC ---------- */
    const units = Number(req.body.units ?? req.body.cryptoAmount);
    const unitsError = currencies.validateUnits(units);
    if (unitsError) return res.status(400).json({ error: unitsError });
    // Important: the card code is NOT collected at order creation. The client sends it only
    // after the operator joins — nothing is sent without the operator's command.
    // A legacy client may send the code right away: supported for compatibility.
    const giftCodeRaw = String(req.body.giftCode || '').trim();
    let giftCode = null;
    if (giftCodeRaw) {
      if (giftCodeRaw.length < 8 || giftCodeRaw.length > 200 || /\s{2,}/.test(giftCodeRaw)) {
        return res.status(400).json({ error: 'Код карты: от 8 до 200 символов, без двойных пробелов.' });
      }
      giftCode = giftCodeRaw;
    }
    const walletError = currencies.validateWallet(wallet, payoutOption);
    if (walletError) return res.status(400).json({ error: walletError });

    const promoRaw = String(req.body.promoCode || '').trim();
    let promo = null;
    if (promoRaw) {
      const check = store.validatePromo(promoRaw, { units });
      if (!check.ok) return res.status(400).json({ error: check.error });
      promo = check.promo;
    }

    const loyalty = store.loyaltyStatus(user.id);
    const loyaltyDiscountPercent = loyalty.eligible ? loyalty.discountPercent : 0;
    const payout = currencies.giftPayout(s, units, pair.currency, promo ? promo.percent : 0, loyaltyDiscountPercent, payoutOption);
    if (!payout) {
      return res.status(400).json({ error: `Курс выплаты в ${payoutOption.payoutCurrency} временно недоступен — попробуйте позже.` });
    }
    if (!(payout.crypto > 0)) {
      if (payout.networkFee > 0) {
        return res.status(400).json({
          error: `Сумма выплаты не покрывает комиссию сети (${payout.networkFee} ${payout.payoutCurrency}). Выберите моментальный USDT (BEP-20) без комиссии или увеличьте номинал карты.`,
        });
      }
      return res.status(400).json({ error: 'Сумма выплаты слишком мала — увеличьте номинал карты.' });
    }
    const ttlMinutes = Number(pair.ttlMinutes) || 60;
    const order = store.createOrder({
      userId: String(user.id),
      userName: user.name,
      userUsername: user.username,
      expiresAt: Date.now() + ttlMinutes * 60 * 1000, // one hour per deal
      units,
      currency: pair.currency,
      payoutId: payout.payoutId,
      payoutCurrency: payout.payoutCurrency,
      network: payout.network,
      networkFee: payout.networkFee,
      grossCrypto: payout.grossCrypto,
      giftCode,
      wallet,
      rate: payout.rate,
      crypto: payout.crypto,
      promoId: promo ? promo.id : null,
      promoCode: promo ? promo.code : null,
      promoPercent: promo ? promo.percent : null,
      baseCrypto: promo ? payout.baseCrypto : null,
      loyaltyDiscountPercent: payout.feeDiscountPercent,
      loyaltyExchangeNumber: payout.feeDiscountPercent > 0 ? loyalty.exchangeNumber : null,
      referrer: user.referrer,
    });
    if (promo) store.consumePromo(promo.id);
    bus.emit('order_event', { order, type: 'new' });
    return res.json({ order: clientOrder(order) });
  });

  app.get('/api/order/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'Заявка не найдена' });
    res.json({ order: clientOrder(store.expireIfNeeded(found) || found) });
  });

  app.post('/api/order/:id/paid', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'Заявка не найдена' });
    const o = store.expireIfNeeded(found);
    // Gift card: "I paid" = the client confirms the deal.
    // An order WITHOUT a code (the new two-phase scheme) cannot be confirmed this way — first the operator
    // joins, then the client sends the code.
    if (o.status === 'new') {
      if (!o.giftCode) {
        return res.status(400).json({ error: 'Дождитесь оператора — код карты отправляется только после его запроса.' });
      }
      const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    if (o.status === 'details') {
      // Gift card in the "operator joined" status: the code has not been sent yet.
      if (!o.giftCode) {
        return res.status(400).json({ error: 'Сначала отправьте код карты — оператор на связи.' });
      }
      const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  // Card code: the client sends it ONLY after the operator joins.
  // Code received → the order moves to "paid" (code under review) — the operator gets a broadcast.
  app.post('/api/order/:id/code', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'Заявка не найдена' });
    const o = store.expireIfNeeded(found);
    if (['completed', 'rejected', 'cancelled'].includes(o.status)) {
      return res.status(400).json({ error: 'Эта заявка больше не принимает код.' });
    }
    if (o.status === 'paid') return res.json({ order: clientOrder(o) }); // idempotent
    if (!['details', 'new'].includes(o.status)) {
      return res.status(400).json({ error: 'Код сейчас не принимается — дождитесь оператора.' });
    }
    // A new two-phase order (no code yet) accepts the code only in the "details" status (operator joined).
    if (!o.giftCode && o.status !== 'details') {
      return res.status(400).json({ error: 'Дождитесь оператора — код карты отправляется только после его запроса.' });
    }
    const giftCode = String(req.body.giftCode || '').trim();
    if (giftCode.length < 8 || giftCode.length > 200 || /\s{2,}/.test(giftCode)) {
      return res.status(400).json({ error: 'Код карты: от 8 до 200 символов, без двойных пробелов.' });
    }
    const upd = store.updateOrder(o.id, { giftCode, status: 'paid', paidAt: Date.now() });
    bus.emit('order_event', { order: upd, type: 'paid' });
    return res.json({ order: clientOrder(upd) });
  });

  app.post('/api/order/:id/cancel', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const found = store.getOrder(req.params.id);
    if (!found || found.userId !== String(a.user.id)) return res.status(404).json({ error: 'Заявка не найдена' });
    const o = store.expireIfNeeded(found);
    if (o.status === 'cancelled' && (o.cancelReason === store.EXPIRED || o.cancelReason === store.EXPIRED_LEGACY)) {
      return res.status(400).json({ error: 'Время на сделку истекло — создайте новую заявку.' });
    }
    if (['new', 'details'].includes(o.status)) {
      const upd = store.updateOrder(o.id, { status: 'cancelled' });
      if (upd && upd.promoId && !upd.promoReleased) store.releaseOrderPromo(upd.id);
      bus.emit('order_event', { order: upd, type: 'cancelled' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  /* ---------- диалог по заявке: клиент ↔ оператор ---------- */
  function chatOrder(req, res, role) {
    const a = needAuth(req, res);
    if (!a) return null;
    // 'read' доступен и владельцу заявки, и оператору; писать «от админа» — только оператору.
    const admin = role === 'user' ? null : isAdminRequest(req);
    if (role === 'admin' && !admin) {
      res.status(403).json({ error: 'Только для оператора' });
      return null;
    }
    const order = store.getOrder(req.params.id);
    if (!order || (!admin && String(order.userId) !== String(a.user.id))) {
      res.status(404).json({ error: 'Заявка не найдена' });
      return null;
    }
    return order;
  }
  app.get('/api/order/:id/messages', (req, res) => {
    const order = chatOrder(req, res, 'read');
    if (order) res.json({ messages: store.getOrderMessages(order.id).map(orderChat.publicMessage) });
  });
  const postMessage = (from) => (req, res, next) => {
    const a = auth(req);
    if (!a) return res.status(401).json({ error: 'Не авторизован' });
    if (!rateLimit(limiter, 'chat', req, res, { key: a.user.id })) return;
    const order = chatOrder(req, res, from);
    if (!order) return;
    try {
      const file = attachments.decodeUpload(req.body?.attachment);
      res.json({ message: orderChat.post(order, from, req.body?.text, file) });
    } catch (err) {
      if (err instanceof attachments.InputError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
  app.post('/api/order/:id/messages', postMessage('user'));
  app.post('/api/admin/order/:id/messages', postMessage('admin'));
  app.get('/api/order/:id/messages/:messageId/attachment', (req, res, next) => {
    const order = chatOrder(req, res, 'read');
    if (!order) return;
    const file = store.getOrderMessages(order.id).find((m) => m.id === Number(req.params.messageId))?.attachment;
    if (!file) return res.status(404).json({ error: 'Вложение не найдено' });
    // Вложение не должно кэшироваться и исполняться: заголовки ставим явно,
    // иначе Express перезапишет их при res.download + cacheControl:false.
    res.set({
      'Cache-Control': 'no-store, private',
      'Content-Type': file.type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    res.download(attachments.filePath(file), file.name, { cacheControl: false }, (err) => {
      if (!err) return;
      if (!res.headersSent && err.status === 404) return res.status(404).json({ error: 'Вложение не найдено' });
      next(err);
    });
  });

  /* ---------- promo codes ---------- */
  app.post('/api/promo/check', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const b = req.body || {};
    const units = b.units !== undefined && b.units !== null && b.units !== '' ? Number(b.units) : null;
    const check = store.validatePromo(b.code, { units });
    if (!check.ok) return res.status(400).json({ error: check.error });
    const promo = check.promo;
    let payout = null;
    if (b.currency && units && units > 0) {
      const pair = currencies.find(String(b.currency).toUpperCase());
      if (pair && pair.kind === 'gift') {
        const opt = currencies.findPayoutOption(b);
        payout = currencies.giftPayout(store.get().settings, units, pair.currency, promo.percent, 0, opt);
      }
    }
    res.json({ promo: store.publicPromo(promo), payout });
  });

  app.get('/api/admin/promos', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    res.json({ promos: store.listPromos() });
  });

  app.post('/api/admin/promos', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const v = validatePromoInput(req.body, { partial: false });
    if (v.error) return res.status(v.status || 400).json({ error: v.error });
    const promo = store.createPromo(v.patch);
    res.json({ promo });
  });

  const handleUpdatePromo = (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const existing = store.getPromo(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Промокод не найден' });
    const v = validatePromoInput(req.body, { partial: true, existingId: existing.id });
    if (v.error) return res.status(v.status || 400).json({ error: v.error });
    const promo = store.updatePromo(existing.id, v.patch);
    res.json({ promo });
  };
  app.put('/api/admin/promos/:id', handleUpdatePromo);
  app.patch('/api/admin/promos/:id', handleUpdatePromo);

  app.delete('/api/admin/promos/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const removed = store.deletePromo(req.params.id);
    res.json({ ok: removed > 0 });
  });

  /* ---------- reviews ---------- */
  // Review showcase: the client leaves a review after a completed deal (one per order),
  // the operator can add any review manually via the admin panel.
  app.get('/api/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const all = store.listReviews(500);
    res.json({
      summary: store.reviewSummary(all),
      reviews: all.slice(0, 100).map(store.publicReview),
    });
  });

  app.post('/api/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!rateLimit(limiter, 'reviews', req, res, { key: a.user.id })) return;
    const b = req.body || {};
    const order = store.getOrder(b.orderId);
    if (!order || order.userId !== String(a.user.id)) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Отзыв можно оставить после завершения сделки.' });
    }
    if (store.getReviewByOrder(order.id)) {
      return res.status(409).json({ error: 'Вы уже оставили отзыв по этой сделке.' });
    }
    const rating = Math.round(Number(b.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Оценка: от 1 до 5 звёзд.' });
    }
    const text = String(b.text || '').trim().slice(0, 1000);
    const user = store.touchUser(a.user, b.startParam || '');
    const review = store.createReview({ userId: user.id, orderId: order.id, name: user.name, rating, text, source: 'order' });
    res.json({ review: store.publicReview(review), order: clientOrder(order, new Set([Number(order.id)])) });
  });

  // Admin: full list for management (deletion) + manual adding.
  app.get('/api/admin/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const all = store.listReviews(500);
    res.json({
      summary: store.reviewSummary(all),
      reviews: all.map((r) => ({ ...store.publicReview(r), orderId: r.orderId ?? null })),
    });
  });

  app.post('/api/admin/reviews', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60) || 'Pricelex Worldwide';
    const rating = Math.round(Number(b.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Оценка: от 1 до 5 звёзд.' });
    }
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Добавьте текст отзыва.' });
    if (text.length > 1000) return res.status(400).json({ error: 'Отзыв ограничен 1000 символов.' });
    const parsedAt = parseTimestamp(b.at, 'Некорректная дата и время отзыва.');
    if (parsedAt.error) return res.status(400).json({ error: parsedAt.error });
    const review = store.createReview({
      userId: null,
      orderId: null,
      name,
      rating,
      text,
      source: 'admin',
      at: parsedAt.provided ? parsedAt.value : undefined,
    });
    res.json({ review: { ...store.publicReview(review), orderId: review.orderId ?? null } });
  });

  const handleUpdateReview = (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const existing = store.getReview(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Отзыв не найден' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'Укажите имя в отзыве.' });
      patch.name = name;
    }
    if (b.rating !== undefined) {
      const rating = Math.round(Number(b.rating));
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Оценка: от 1 до 5 звёзд.' });
      }
      patch.rating = rating;
    }
    if (b.text !== undefined) {
      const text = String(b.text || '').trim();
      if (existing.source === 'admin' && !text) return res.status(400).json({ error: 'Добавьте текст отзыва.' });
      if (text.length > 1000) return res.status(400).json({ error: 'Отзыв ограничен 1000 символов.' });
      patch.text = text;
    }
    if (b.at !== undefined) {
      const parsedAt = parseTimestamp(b.at, 'Некорректная дата и время отзыва.');
      if (parsedAt.error) return res.status(400).json({ error: parsedAt.error });
      if (parsedAt.provided) patch.at = parsedAt.value;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Нечего обновлять — передайте хотя бы одно поле.' });
    }
    const updated = store.updateReview(existing.id, patch);
    res.json({ review: { ...store.publicReview(updated), orderId: updated.orderId ?? null } });
  };
  app.put('/api/admin/reviews/:id', handleUpdateReview);
  app.patch('/api/admin/reviews/:id', handleUpdateReview);

  // Площадка отвечает на отзыв: оператор пишет ответ (или чистит его), клиент его видит.
  app.post('/api/admin/reviews/:id/reply', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const existing = store.getReview(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Отзыв не найден' });
    const reply = String((req.body || {}).reply || '').trim().slice(0, 1000);
    if (reply.length > 0 && reply.length < 3) {
      return res.status(400).json({ error: 'Ответ на отзыв — коротко, опишите положение дел.' });
    }
    const updated = store.updateReview(existing.id, { reply });
    res.json({ review: { ...store.publicReview(updated), orderId: updated.orderId ?? null } });
  });

  app.delete('/api/admin/reviews/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
    const removed = store.deleteReview(req.params.id);
    res.json({ ok: removed > 0 });
  });

  /* ---------- support chat ---------- */
  app.get('/api/support/messages', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const msgs = store.getSupportMessages(a.user.id);
    res.json({ messages: msgs });
  });

  app.post('/api/support/message', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    if (text.length > 2000) return res.status(400).json({ error: 'Сообщение слишком длинное (до 2000 символов)' });
    if (!rateLimit(limiter, 'support', req, res, { key: a.user.id })) return;
    store.touchUser(a.user, req.body.startParam || '');
    const msg = store.createSupportMessage(a.user.id, 'user', text);
    bus.emit('support_message', { message: msg, user: a.user });
    res.json({ message: msg });
  });

  app.post('/api/support/read', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    res.json({ ok: true });
  });

  // DEMO operator console: exists ONLY when BOT_TOKEN is unset (preview without the bot).
  // Доступ — только администратору. Демо-гость 900001 больше не «оператор»:
  // иначе любой посетитель мог подтверждать чужие выплаты.
  if (!config.botToken) {
    app.use('/api/admin', (req, res, next) => {
      if (req.path === '/settings/chat') return next();
      if (!isAdminRequest(req)) return res.status(403).json({ error: 'Только для оператора Pricelex Worldwide' });
      next();
    });
    app.post('/api/admin/order/:id/connect', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Заявка не найдена' });
      if (o.status !== 'new') return res.status(400).json({ error: 'Заявка уже в работе' });
      const upd = store.updateOrder(o.id, { status: 'details' });
      bus.emit('order_event', { order: upd, type: 'details' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/confirm', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Заявка не найдена' });
      const upd = store.updateOrder(o.id, { status: 'completed' });
      bus.emit('order_event', { order: upd, type: 'completed' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/reject', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Заявка не найдена' });
      const upd = store.updateOrder(o.id, { status: 'rejected' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/cancel', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Заявка не найдена' });
      const upd = store.updateOrder(o.id, { status: 'cancelled' });
      if (upd && upd.promoId && !upd.promoReleased) store.releaseOrderPromo(upd.id);
      bus.emit('order_event', { order: upd, type: 'cancelled' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/support/:userId/reply', (req, res) => {
      const userId = String(req.params.userId);
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
      const msg = store.createSupportMessage(userId, 'admin', text);
      bus.emit('support_message', { message: msg, user: { id: userId } });
      res.json({ message: msg });
    });
  }

  // Глобальный обработчик: никогда не отдаём стектрейс наружу.
  app.use((err, _req, res, _next) => {
    console.error('[web] unhandled route error:', err && err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  const publicDir = path.join(__dirname, '..', 'public');
  const indexFile = path.join(publicDir, 'index.html');

  app.get('/health', (_req, res) => res.json({ ok: true, name: 'Pricelex Worldwide' }));
  app.use(express.static(publicDir));
  app.use((req, res) => res.sendFile(indexFile));

  return app;
}

function startWeb() {
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `[Pricelex Worldwide] web server listening on ${config.host}:${config.port} (port source: ${config.portSource})`
    );
    console.log('[Pricelex Worldwide] откройте этот адрес в браузере — должна быть страница обмена, а не «Bot is running»');
  });
  server.on('error', (e) => {
    console.error(`[Pricelex Worldwide] could not bind ${config.host}:${config.port}:`, e.message);
    if (e && e.code === 'EADDRINUSE') {
      console.error(
        '[Pricelex Worldwide] Порт занят. На бот-хостинге укажите Main File = index.js и не задавайте PORT вручную — нужен SERVER_PORT панели.'
      );
    }
    process.exit(1);
  });
  return server;
}

module.exports = { startWeb, createApp, parseTimestamp };
