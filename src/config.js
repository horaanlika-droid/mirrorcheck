const fs = require('fs');
const path = require('path');

// Минимальный загрузчик .env — в продакшене нужны только BOT_TOKEN и ADMIN_ID.
// Всё остальное (БД, ссылки, меню TG, дефолтные курсы) создаётся автоматически.
function loadEnvFile() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  const content = fs.readFileSync(p, 'utf8');
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    // Remove trailing inline comment if not inside quotes
    if (!(v.startsWith('"') && v.lastIndexOf('"') > 0) && !(v.startsWith("'") && v.lastIndexOf("'") > 0)) {
      const hashIdx = v.indexOf(' #');
      if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = v;
    }
  }
}
loadEnvFile();

// Бот-хостинги (Bot-Hosting.net, Pterodactyl и т.п.) проксируют трафик
// на SERVER_PORT. Если слушать только 8080 — снаружи будет заглушка «Bot is running».
function resolvePort() {
  const keys = ['SERVER_PORT', 'PORT', 'WEB_PORT', 'APP_PORT', 'HTTP_PORT'];
  for (const k of keys) {
    const raw = process.env[k];
    if (raw == null || String(raw).trim() === '') continue;
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return { port: n, source: k };
  }
  return { port: 8080, source: 'default' };
}

const listen = resolvePort();
const adminIds = [...new Set([process.env.ADMIN_ID, process.env.ADMIN_IDS]
  .filter(Boolean).join(',').split(/[,;\s]+/).filter(Boolean))];
if (adminIds.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
  throw new Error('ADMIN_ID / ADMIN_IDS должны содержать положительные Telegram ID, разделённые запятыми.');
}

// Telegram пускает web_app-кнопки только по https. На хостингах PUBLIC_URL нередко
// задают без схемы или с http:// — нормализуем вместо тихого падения каждой отправки.
function normalizePublicUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return null;
  let url = value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  else if (/^http:\/\//i.test(url)) url = 'https://' + url.slice('http://'.length);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.')) throw new Error('not https');
    return url.replace(/\/+$/, '');
  } catch {
    console.error(`[config] PUBLIC_URL="${value}" не похож на https-адрес — кнопки приложения будут скрыты.`);
    return null;
  }
}
const publicUrl = normalizePublicUrl(process.env.PUBLIC_URL);

module.exports = {
  botToken: (process.env.BOT_TOKEN || '').trim(),
  adminId: (process.env.ADMIN_ID || '').trim(), // совместимость со старыми сообщениями
  adminIds,
  port: listen.port,
  portSource: listen.source,
  host: '0.0.0.0',
  publicUrl,
};
