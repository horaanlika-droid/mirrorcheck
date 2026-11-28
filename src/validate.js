const crypto = require('crypto');

const MAX_AGE_SEC = (() => {
  const raw = Number(process.env.INITDATA_MAX_AGE_SEC);
  return Number.isFinite(raw) && raw >= 60 && raw <= 7 * 24 * 3600 ? raw : 24 * 3600;
})();

// Проверка initData Telegram WebApp по официальной схеме (HMAC-SHA256).
// Дополнительно проверяется свежесть auth_date: перехваченная строка не живёт вечно.
function validateInitData(initData, botToken, now = Date.now()) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return false;
    p.delete('hash');
    const dcs = [...p.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const h = crypto.createHmac('sha256', key).update(dcs).digest('hex');
    if (h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return false;
    const authDate = Number(p.get('auth_date'));
    if (!Number.isFinite(authDate) || authDate <= 0) return false;
    const age = Math.floor(now / 1000) - authDate;
    if (age > MAX_AGE_SEC || age < -300) return false;
    return true;
  } catch {
    return false;
  }
}

function parseUser(initData) {
  try {
    const p = new URLSearchParams(initData);
    return JSON.parse(p.get('user')) || {};
  } catch {
    return {};
  }
}

module.exports = { validateInitData, parseUser, MAX_AGE_SEC };
