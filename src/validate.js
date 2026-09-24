const crypto = require('crypto');

// Проверка initData Telegram WebApp по официальной схеме (HMAC-SHA256).
function validateInitData(initData, botToken) {
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
    if (h !== hash) return false;
    if (!p.get('auth_date')) return false;
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

module.exports = { validateInitData, parseUser };
