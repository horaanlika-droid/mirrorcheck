// Простые окна-лимиты в памяти процесса: защита от флуда заявками, спама
// в поддержку и перебора. Без внешних зависимостей и без Redis.
function createLimiter() {
  const buckets = new Map();
  let lastSweep = Date.now();

  const sweep = (now) => {
    lastSweep = now;
    for (const [key, b] of buckets) {
      if (!b || b.reset <= now) buckets.delete(key);
    }
    // Аварийный предохранитель: под сильным флудом ключей не копим бесконечно.
    if (buckets.size > 20000) buckets.clear();
  };

  // hit() — учёт одного события. Лимит 0/undefined отключает проверку.
  function hit(key, limit, windowMs, now = Date.now()) {
    if (!limit || limit <= 0) return { ok: true, remaining: Infinity, retryAfter: 0 };
    let b = buckets.get(key);
    if (!b || b.reset <= now) {
      b = { hits: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.hits += 1;
    if (now - lastSweep > 60_000) sweep(now);
    if (b.hits > limit) {
      return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
    }
    return { ok: true, remaining: limit - b.hits, retryAfter: 0 };
  }

  return { hit, buckets, sweep };
}

const LIMITS = {
  api: { limit: 1500, windowMs: 60_000 }, // общий потолок на IP (опросы приложения)
  writes: { limit: 300, windowMs: 60_000 },
  session: { limit: 15, windowMs: 60_000 }, // создание анонимных сессий
  sessionDay: { limit: 120, windowMs: 24 * 60 * 60_000 },
  orders: { limit: 30, windowMs: 60 * 60_000 },
  chat: { limit: 40, windowMs: 60_000 },
  support: { limit: 15, windowMs: 60_000 },
  reviews: { limit: 10, windowMs: 60 * 60_000 },
  authFail: { limit: 60, windowMs: 10 * 60_000 },
  link: { limit: 20, windowMs: 10 * 60_000 },
};

// Идентифицируем клиента по IP (Express trust proxy уже учитывает X-Forwarded-For).
const ipOf = (req) => String(req.ip || req.socket?.remoteAddress || 'unknown');

function rateLimit(limiter, name, req, res, { limit, windowMs, key } = {}) {
  const conf = LIMITS[name] || {};
  const l = limit ?? conf.limit;
  const w = windowMs ?? conf.windowMs;
  const result = limiter.hit(`${name}:${key || ipOf(req)}`, l, w);
  if (!result.ok) {
    res.set('Retry-After', String(result.retryAfter));
    res.status(429).json({ error: 'Слишком много запросов. Подождите немного и попробуйте снова.' });
    return false;
  }
  return true;
}

module.exports = { createLimiter, rateLimit, LIMITS, ipOf };
