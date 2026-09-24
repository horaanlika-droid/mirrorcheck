// Математическая капча: защищает публичные формы (создание заявки,
// заявка «стать брокером») от ботов и спама. Вопрос генерируется сервером,
// пара «вопрос-ответ» живёт 5 минут и сгорает после первой проверки.
const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const pending = new Map(); // id -> { answer, exp }

const rnd = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function sweep() {
  const now = Date.now();
  for (const [id, row] of pending) {
    if (now > row.exp) pending.delete(id);
  }
}

function issue() {
  if (pending.size > 500) sweep();
  const op = ['+', '−', '×'][rnd(0, 2)];
  let a = rnd(3, 9);
  let b = rnd(2, 9);
  if (op === '−' && b > a) [a, b] = [b, a]; // ответ неотрицательный
  const answer = op === '+' ? a + b : op === '−' ? a - b : a * b;
  const id = crypto.randomBytes(8).toString('hex');
  pending.set(id, { answer, exp: Date.now() + TTL_MS });
  return { id, question: `${a} ${op} ${b} = ?` };
}

function verify(id, raw) {
  const key = String(id || '');
  const row = pending.get(key);
  if (!row) return false;
  pending.delete(key); // капча одноразовая, повторной отправки с ней нет
  if (Date.now() > row.exp) return false;
  const n = Number(String(raw ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n === row.answer;
}

module.exports = { issue, verify };
