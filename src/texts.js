// Каталог редактируемых блоков интерфейса. Единица редактирования — целый
// блок (заголовок, абзац, секция руководства, info-note, подпись кнопки), а не отдельное
// предложение или фрагмент внутри блока. Текст блока собирается целиком, со всеми
// inline-выделениями, и подменяется в DOM целиком. Динамические значения и
// пользовательский контент не собираются и не отправляются на сервер.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const currencies = require('./currencies');

// Нормализация текста блока: пробелы схлопываются, края обрезаются.
// Эту же нормализацию применяет клиент к textContent элемента при поиске блока.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

let cached;
function catalogue() {
  if (cached) return cached;
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').split('<div id="adminSheet"')[0];
  const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const values = new Set();

  function add(value) {
    const text = norm(value);
    if (!text) return;
    if (text.length > 1000) return;                       // целый блок может быть длиннее фразы
    if (!/[А-Яа-яЁё]/.test(text)) return;                 // только русскоязычные надписи
    if (/\$\{|[<>\\}]|&(?:[a-z]+|#\d+);/i.test(text)) return; // интерполяции, разметка, сущности
    values.add(text);
  }

  // Серверные тексты направлений приходят клиенту через /api/settings и рендерятся
  // в DOM (например, info-note карты). В исходном JS они — строковые значения, а не
  // HTML, поэтому регулярками не собираются; добавляем их явно целыми блоками.
  add(currencies.CARD_INFO_NOTE);

  for (const source of [html, js]) {
    // Убираем встроенные скрипты/стили и комментарии, чтобы не собирать код.
    // Inline-выделение <b>/<strong> убираем: тогда фрагменты блока
    // ("Карта <b>…</b> региона <b>США</b>…") склеиваются в один текст блока.
    // Структурные <span>/<small> оставляем — они разделяют ячейки и подписи.
    const clean = source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<b\b[^>]*>/gi, '')
      .replace(/<\/b\s*>/gi, '')
      .replace(/<strong\b[^>]*>/gi, '')
      .replace(/<\/strong\s*>/gi, '');
    for (const m of clean.matchAll(/>([^<>\n]+)</g)) add(m[1]);
    for (const m of clean.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)) add(m[1]);
  }

  return cached = [...values].sort((a, b) => a.localeCompare(b, 'ru')).map((text) => ({
    id: crypto.createHash('sha256').update(text).digest('hex').slice(0, 20), text,
  }));
}
module.exports = catalogue;
