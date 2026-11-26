// Каталог редактируемых блоков интерфейса. Единица редактирования — целый
// блок: для руководства пользователя это целая секция (несколько абзацев,
// заголовок и списки вместе), для остального интерфейса — отдельный элемент
// (заголовок, info-note, подпись кнопки). Текст блока собирается целиком,
// со всеми inline-выделениями, и подменяется в DOM целиком. Динамические
// значения и пользовательский контент не собираются и не отправляются на сервер.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const currencies = require('./currencies');

// Нормализация для сопоставления: всё пробельное (включая переводы строк)
// схлопывается в один пробел, края обрезаются. Применяется и к textContent
// элемента в DOM, и к ключу override-карты на клиенте.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Текст контейнера руководства (секции/intro) с переводами строк между
// блочными элементами — чтобы в админке textarea показывал читаемый
// многострочный текст, а при override переводы строк рендерились как абзацы.
function containerText(inner) {
  return inner
    .replace(/<\/?(b|strong)\b[^>]*>/gi, '')          // inline-выделение убираем, текст оставляем
    .replace(/<\/(h[1-6]|p|li|ul|ol|div)\s*>/gi, '\n') // конец блочного элемента → новая строка
    .replace(/<(h[1-6]|p|li|ul|ol|div)\b[^>]*>/gi, '\n') // начало блочного элемента → новая строка
    .replace(/<[^>]+>/g, '')                            // прочие теги убираем
    .replace(/[ \t]+/g, ' ')                            // схлопываем пробелы/табы
    .replace(/ *\n */g, '\n')                           // обрезаем пробелы у переводов строк
    .replace(/\n{3,}/g, '\n\n')                         // не больше одного пустого ряда
    .trim();
}

const MAX = 2000; // целая секция может быть длиннее отдельной фразы

let cached;
function catalogue() {
  if (cached) return cached;
  const rawHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').split('<div id="adminSheet"')[0];
  const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const values = new Set();

  // Блочный текст (с переводами строк) — для контейнеров руководства.
  function addBlock(text) {
    const t = String(text).trim();
    if (!t || t.length > MAX) return;
    if (!/[А-Яа-яЁё]/.test(t)) return;
    if (/\$\{|[<>\\}]|&(?:[a-z]+|#\d+);/i.test(t)) return;
    values.add(t);
  }
  // Листовой текст (одна строка) — для отдельных элементов интерфейса.
  function addLeaf(value) {
    const text = norm(value);
    if (!text || text.length > MAX) return;
    if (!/[А-Яа-яЁё]/.test(text)) return;
    if (/\$\{|[<>\\}]|&(?:[a-z]+|#\d+);/i.test(text)) return;
    values.add(text);
  }

  // Серверные тексты направлений приходят клиенту через /api/settings и рендерятся
  // в DOM (например, info-note карты). В исходном JS они — строковые значения, а не
  // HTML, поэтому регулярками не собираются; добавляем их явно целыми блоками.
  addLeaf(currencies.CARD_INFO_NOTE);

  // Контейнеры руководства — каждый целиком одним блоком (несколько абзацев).
  // Секции не вложены друг в друга, поэтому нежадный матч надёжен.
  const GUIDE_BLOCK = /<(?:section class="guide-section[^"]*"|div class="guide-intro")>([\s\S]*?)<\/(?:section|div)>/g;
  for (const m of rawHtml.matchAll(GUIDE_BLOCK)) addBlock(containerText(m[1]));
  // Убираем контейнеры руководства из HTML, чтобы их внутренние абзацы не попали
  // в листовую выборку как отдельные блоки.
  const htmlNoGuide = rawHtml.replace(GUIDE_BLOCK, '');

  for (const source of [htmlNoGuide, js]) {
    const clean = source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<b\b[^>]*>/gi, '')
      .replace(/<\/b\s*>/gi, '')
      .replace(/<strong\b[^>]*>/gi, '')
      .replace(/<\/strong\s*>/gi, '');
    for (const m of clean.matchAll(/>([^<>\n]+)</g)) addLeaf(m[1]);
    for (const m of clean.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)) addLeaf(m[1]);
  }

  return cached = [...values].sort((a, b) => a.localeCompare(b, 'ru')).map((text) => ({
    id: crypto.createHash('sha256').update(text).digest('hex').slice(0, 20), text,
  }));
}
module.exports = catalogue;
