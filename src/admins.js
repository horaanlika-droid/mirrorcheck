const config = require('./config');
const store = require('./store');

const validId = (id) => /^[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id));
const owners = () => config.adminIds;
const all = () => [...new Set([...owners(), ...store.get().admins.map(String)])];
const isOwner = (id) => owners().includes(String(id));
const has = (id) => all().includes(String(id));

function add(id) {
  id = String(id);
  if (!validId(id)) throw new Error('Укажите числовой Telegram ID. Пример: /addadmin 123456789');
  if (has(id)) return false;
  store.mutate((db) => db.admins.push(id));
  return true;
}

function remove(id) {
  id = String(id);
  if (!validId(id)) throw new Error('Укажите числовой Telegram ID. Пример: /removeadmin 123456789');
  if (isOwner(id)) throw new Error('Владелец задан в ADMIN_ID / ADMIN_IDS. Удалите его из окружения и перезапустите сервер.');
  if (!has(id)) return false;
  store.mutate((db) => { db.admins = db.admins.filter((value) => String(value) !== id); });
  return true;
}

module.exports = { all, isOwner, has, add, remove };
