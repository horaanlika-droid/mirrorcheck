const fs = require('fs');
const path = require('path');

// Минимальный загрузчик .env — в продакшене нужны только BOT_TOKEN и ADMIN_ID.
// Всё остальное (БД, ссылки, меню TG, дефолтные курсы) создаётся автоматически.
function loadEnvFile() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
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

module.exports = {
  botToken: (process.env.BOT_TOKEN || '').trim(),
  adminId: (process.env.ADMIN_ID || '').trim(), // совместимость со старыми сообщениями
  adminIds,
  port: listen.port,
  portSource: listen.source,
  host: '0.0.0.0',
  publicUrl: ((process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '')) || null,
};
