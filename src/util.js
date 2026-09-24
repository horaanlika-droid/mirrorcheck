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

module.exports = { esc, fmtRub, fmtCrypto, fmtDate, fmtSize, plural, parseNum };
