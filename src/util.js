const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtRub = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';

const fmtCrypto = (v, cur) => {
  const n = Number(v) || 0;
  const dec = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toFixed(dec) + ' ' + cur;
};

const fmtDate = (ts) => {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
};

const plural = (n, forms) => {
  const a = Math.abs(Number(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
};

const parseNum = (s) => {
  const value = String(s).replace(/\s|₽|руб\.?/gi, '').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return NaN;
  const n = Number(value);
  return isFinite(n) ? n : NaN;
};

// Даты отзывов оператор видит и вводит по Москве (UTC+3, без перехода на летнее время),
// независимо от часового пояса сервера.
const MSK_OFFSET = 3 * 3600 * 1000;

const fmtMsk = (ts) => {
  const d = new Date(Number(ts) + MSK_OFFSET);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

// «24.09.2026 14:30», «24.09.2026», «24.09 14:30», «24.09.26 9:05», «сейчас» → timestamp (МСК).
function parseMsk(input, now = Date.now()) {
  const s = String(input || '').trim().toLowerCase();
  if (/^(сейчас|now|сегодня)$/.test(s)) return now;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?(?:[\s,]+(\d{1,2})[:.](\d{2}))?$/);
  if (!m) return NaN;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : new Date(now + MSK_OFFSET).getUTCFullYear();
  if (year < 100) year += 2000;
  const hh = m[4] != null ? Number(m[4]) : 12;
  const mm = m[5] != null ? Number(m[5]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59 || year < 2000 || year > 2100) return NaN;
  const ts = Date.UTC(year, month - 1, day, hh, mm) - MSK_OFFSET;
  const back = new Date(ts + MSK_OFFSET);
  if (back.getUTCDate() !== day || back.getUTCMonth() !== month - 1) return NaN; // 31.02 и т.п.
  return ts;
}

module.exports = { esc, fmtRub, fmtCrypto, fmtDate, fmtSize, plural, parseNum, fmtMsk, parseMsk };
