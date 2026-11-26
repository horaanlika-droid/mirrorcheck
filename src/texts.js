// Catalogue of fixed, client-facing HTML copy. Dynamic values and user-generated
// content are deliberately not collected or sent to the server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let cached;
function catalogue() {
  if (cached) return cached;
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').split('<div id="adminSheet"')[0];
  const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const values = new Set();
  function add(value) {
    value = value.trim();
    if (!value || value.length > 500 || !/[А-Яа-яЁё]/.test(value) || /[${}<>\\]|&(?:[a-z]+|#\d+);/i.test(value)) return;
    values.add(value);
  }
  for (const source of [html, js]) {
    for (const match of source.matchAll(/>([^<>\n]+)</g)) add(match[1]);
    for (const match of source.matchAll(/(?:placeholder|aria-label|title)="([^"$<>]+)"/g)) add(match[1]);
  }
  return cached = [...values].sort((a, b) => a.localeCompare(b, 'ru')).map((text) => ({
    id: crypto.createHash('sha256').update(text).digest('hex').slice(0, 20), text,
  }));
}
module.exports = catalogue;
