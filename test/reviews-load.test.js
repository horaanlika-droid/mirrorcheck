// Нагрузка на отзывы: генератор тестового набора (с 20.05.2026, 2–3 в день,
// хорошие и плохие, средняя 4.7), страницы API по курсору, 10 000 отзывов и
// CLI tools/seed-reviews.js. Своя временная база — живые данные не трогаются.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { execFile } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-reviews-'));
process.env.DATA_DIR = dir;
delete process.env.BOT_TOKEN; // демо-режим: гостевой доступ к /api/reviews
const config = require('../src/config');
const store = require('../src/store');
const seed = require('../src/review-seed');
const { startWeb } = require('../src/web');

config.port = 0;
const server = startWeb();
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
const base = async () => {
  if (!server.listening) await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const getJson = async (route) => {
  const r = await fetch((await base()) + route);
  const body = await r.text();
  return { status: r.status, bytes: Buffer.byteLength(body), json: JSON.parse(body) };
};

const MSK = 3 * 3600 * 1000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const msk = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) - MSK;
const NOW = msk(2026, 9, 26, 12, 0); // «сейчас» зафиксировано: набор не зависит от часа запуска
const mskMinutes = (ts) => Math.floor(((ts + MSK) % DAY) / MIN);
const noWord = (w) => new RegExp(`(?<![а-яё])${w}(?![а-яё])`, 'i');
const clearReviews = () => store.mutate((d) => { d.reviews = []; });

const byNewest = (a, b) => (b.createdAt - a.createdAt) || (b.id - a.id);

test('набор детерминирован: те же параметры — те же отзывы, другой seed — другие', () => {
  const a = seed.generateSeedReviews({ now: NOW });
  const b = seed.generateSeedReviews({ now: NOW });
  assert.deepEqual(a, b);
  const c = seed.generateSeedReviews({ now: NOW, seed: 7 });
  assert.notDeepEqual(a.map((r) => r.text), c.map((r) => r.text));
  assert.deepEqual([...seed.FALLBACK_BROKERS], store.DEFAULT_ADMIN_BROKERS.map((x) => x.name),
    'брокеры по умолчанию совпадают с store.js');
});

test('с 20.05.2026 по сегодня: 2–3 отзыва в день, с 08:00 до 23:30 МСК, ни одного из будущего', () => {
  const list = seed.generateSeedReviews({ now: NOW });
  assert.equal(seed.mskDayKey(list[0].createdAt), '2026-05-20', 'первый день — 20 мая');
  const perDay = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    assert.ok(r.createdAt <= NOW, 'не из будущего');
    if (i) assert.ok(r.createdAt >= list[i - 1].createdAt, 'по возрастанию времени');
    const m = mskMinutes(r.createdAt);
    assert.ok(m >= 8 * 60 && m <= 23 * 60 + 30, `время по Москве ${Math.floor(m / 60)}:${m % 60}`);
    const k = seed.mskDayKey(r.createdAt);
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }
  // 20.05–25.09 — полные дни, 26.09 ещё идёт (до 12:00 МСК).
  for (let d = msk(2026, 5, 20); d < msk(2026, 9, 26); d += DAY) {
    const k = seed.mskDayKey(d);
    const n = perDay.get(k) || 0;
    assert.ok(n === 2 || n === 3, `${k}: ${n} отзыва — «пару-тройку» в день`);
  }
  assert.equal(perDay.size >= 129 && perDay.size <= 130, true);
  assert.ok((perDay.get('2026-09-26') || 0) <= 3, 'сегодня — только то, что уже было');
  assert.ok(list.length >= 129 * 2 && list.length <= 130 * 3, `${list.length} отзывов`);
});

test('средняя ровно 4.7 — и не только хорошие: медленный обмен, высокая комиссия', () => {
  const list = seed.generateSeedReviews({ now: NOW });
  const sum = list.reduce((s, r) => s + r.rating, 0);
  assert.equal(sum, Math.round(4.7 * list.length), 'сумма оценок подогнана под 4.7');
  assert.equal((sum / list.length).toFixed(1), '4.7');

  const low = list.filter((r) => r.rating <= 3);
  for (const n of [1, 2, 3]) assert.ok(list.filter((r) => r.rating === n).length >= 4, `есть оценки ${n}★`);
  assert.ok(low.length >= list.length * 0.05, `плохих заметно: ${low.length}`);
  const slow = low.filter((r) => /медленн|долго|ждал/i.test(r.text));
  const fee = low.filter((r) => /комисси|дороже|дорого|курс хуже/i.test(r.text));
  assert.ok(slow.length >= 6, `«обмен медленный»: ${slow.length}`);
  assert.ok(fee.length >= 5, `«комиссия высокая»: ${fee.length}`);
  assert.ok(low.some((r) => /Обмен (очень )?медленный/.test(r.text)));
  assert.ok(low.some((r) => /Комиссия высокая/.test(r.text)));
  assert.ok(list.filter((r) => r.rating === 4).some((r) => /комиссия|ждал|дольше|медленнее/i.test(r.text)),
    'у четвёрок бывают мелкие замечания');

  for (const r of list) {
    assert.equal(r.source, 'seed');
    assert.equal(r.status, 'approved');
    assert.equal(r.userId, null);
    assert.equal(r.orderId, null);
    assert.ok(r.name.length >= 2 && r.name.length <= 60);
    assert.ok(r.text.length >= 5 && r.text.length <= 1000);
    assert.doesNotMatch(r.text, /модерац|\{|\}/, 'без служебных слов и незаполненных подстановок');
  }
  assert.equal(new Set(list.map((r) => r.text)).size, list.length, 'тексты не повторяются');

  // Род автора: у Анны не «обменял», у Ивана не «обменяла».
  const female = list.filter((r) => /^(Анна|Мария|Елена|Ольга|Наталья|Ирина|Екатерина|Татьяна|Юлия|Светлана|Алина|Дарья|Ксения|Виктория|Полина|Вероника|Марина|Софья|Кристина|Валерия)(?![а-яё])/.test(r.name));
  const male = list.filter((r) => /^(Алексей|Дмитрий|Сергей|Андрей|Максим|Иван|Артём|Никита|Михаил|Егор|Павел|Роман|Кирилл|Денис|Олег)(?![а-яё])/.test(r.name));
  assert.ok(female.length > 20 && male.length > 20);
  for (const w of ['обменял', 'ждал', 'получил', 'купил', 'отдал', 'оформил', 'покупал']) {
    assert.ok(!female.some((r) => noWord(w).test(r.text)), `женщины не пишут «${w}»`);
    assert.ok(!male.some((r) => noWord(w + 'а').test(r.text)), `мужчины не пишут «${w}а»`);
  }

  // Ответы площадки: на большинство плохих, через 1–10 часов, не из будущего.
  const answered = low.filter((r) => r.reply).length / low.length;
  assert.ok(answered > 0.35 && answered < 0.85, `ответ на ${Math.round(answered * 100)}% плохих`);
  for (const r of list.filter((x) => x.reply)) {
    assert.ok(r.reply.at - r.createdAt >= 60 * MIN && r.reply.at - r.createdAt <= 600 * MIN);
    assert.ok(r.reply.at <= NOW);
    assert.equal(r.reply.by, 'seed');
    assert.ok(r.reply.text.length > 10);
  }
});

test('средняя на витрине учитывает живые отзывы; повтор заменяет набор, удаление трогает только тестовые', () => {
  clearReviews();
  const live = [1, 1, 5].map((rating) => store.createReview({ name: 'Живой', rating, text: 'Настоящий отзыв клиента', status: 'approved', source: 'user', createdAt: msk(2026, 9, 1, 10) }));
  const pending = store.createReview({ name: 'Ждёт', rating: 1, text: 'Ещё не опубликован', status: 'pending', source: 'user' });

  const first = seed.seedReviews(store, { now: NOW, from: '2026-07-01' });
  assert.equal(first.live, 3, 'на витрине три живых отзыва');
  assert.equal(first.removed, 0);
  let pub = store.publicReviews(0).stats;
  assert.equal(pub.count, first.count + 3);
  assert.equal(pub.avg, 4.7, 'с живыми единицами средняя всё равно 4.7');
  assert.equal(Object.values(pub.dist).reduce((s, n) => s + n, 0), pub.count, 'распределение — по всей витрине');

  const again = seed.seedReviews(store, { now: NOW, from: '2026-07-01' });
  assert.equal(again.removed, first.count, 'прошлый набор заменён, а не удвоен');
  assert.equal(seed.countSeedReviews(store.get().reviews), first.count);
  assert.equal(store.publicReviews(0).stats.count, first.count + 3);

  const dry = seed.seedReviews(store, { now: NOW, from: '2026-06-01', dryRun: true });
  assert.ok(dry.dryRun && dry.count > first.count);
  assert.equal(seed.countSeedReviews(store.get().reviews), first.count, '--dry-run ничего не пишет');

  assert.equal(seed.purgeSeedReviews(store), first.count);
  pub = store.publicReviews(0).stats;
  assert.equal(pub.count, 3, 'остались только живые');
  for (const r of [...live, pending]) assert.ok(store.getReview(r.id), `отзыв #${r.id} на месте`);
  assert.equal(seed.purgeSeedReviews(store), 0, 'повторное удаление безопасно');
  clearReviews();
});

test('API: страницы по курсору — каждый отзыв ровно один раз и строго от новых к старым', async () => {
  clearReviews();
  const res = seed.seedReviews(store, { now: NOW });
  // Одинаковое время у нескольких отзывов: порядок всё равно строгий (по id).
  const same = msk(2026, 8, 15, 12, 0);
  for (let i = 0; i < 5; i += 1) store.createReview({ name: `Одновременный ${i}`, rating: 5, text: 'Отзыв в ту же секунду', status: 'approved', source: 'admin', createdAt: same });
  store.createReview({ name: 'Скрытый', rating: 1, text: 'Этого на витрине нет', status: 'rejected', source: 'user', createdAt: NOW - MIN });
  const total = res.count + 5;

  const first = await getJson('/api/reviews');
  assert.equal(first.status, 200);
  assert.equal(first.json.reviews.length, 20, 'без параметров — 20 самых свежих');
  assert.equal(first.json.stats.count, total);
  assert.equal(Object.values(first.json.stats.dist).reduce((s, n) => s + n, 0), total);
  assert.equal(first.json.stats.avg, 4.7);
  assert.equal(first.json.hasMore, true);
  assert.match(first.json.next, /^\d+:\d+$/);
  assert.ok(!first.json.reviews.some((r) => r.name === 'Скрытый'));

  const seen = [];
  let next = null;
  let pages = 0;
  do {
    const q = next ? `?limit=37&before=${encodeURIComponent(next)}` : '?limit=37';
    const { json } = await getJson('/api/reviews' + q);
    assert.ok(json.reviews.length <= 37);
    assert.equal(json.stats.count, total, 'сводка на каждой странице — по всей витрине');
    seen.push(...json.reviews);
    next = json.next;
    assert.equal(json.hasMore, !!next);
    pages += 1;
    assert.ok(pages < 100, 'обход конечен');
  } while (next);
  assert.equal(seen.length, total, 'все отзывы пройдены');
  assert.equal(new Set(seen.map((r) => r.id)).size, total, 'ни одного дубля');
  for (let i = 1; i < seen.length; i += 1) assert.ok(byNewest(seen[i - 1], seen[i]) < 0, 'строго от новых к старым');
  assert.deepEqual(seen.slice(0, 20).map((r) => r.id), first.json.reviews.map((r) => r.id));
  assert.deepEqual(Object.keys(seen[0]).sort(), ['createdAt', 'id', 'name', 'rating', 'reply', 'text'], 'наружу — только публичные поля');

  const capped = await getJson('/api/reviews?limit=500');
  assert.equal(capped.json.reviews.length, 50, 'страница не больше 50');
  assert.equal((await getJson('/api/reviews?before=abc')).status, 400, 'испорченный курсор — ошибка, а не первая страница');
  const tail = await getJson(`/api/reviews?before=${encodeURIComponent(`${msk(2026, 5, 20)}:1`)}`);
  assert.deepEqual([tail.json.reviews.length, tail.json.hasMore, tail.json.next], [0, false, null], 'за концом ленты пусто');

  // Автор видит свой отзыв и до публикации — и в ленте, и в сводке.
  const mine = store.createReview({ userId: 'u-77', name: 'Автор', rating: 4, text: 'Мой свежий отзыв', status: 'pending', source: 'user', createdAt: NOW });
  const asAuthor = await getJson('/api/reviews?demo[id]=u-77&demo[name]=A');
  assert.equal(asAuthor.json.reviews[0].id, mine.id);
  assert.equal(asAuthor.json.stats.count, total + 1);
  assert.equal((await getJson('/api/reviews')).json.stats.count, total, 'остальным — нет');
  clearReviews();
});

test('10 000 отзывов: страница отдаётся быстро и весит немного', async (t) => {
  clearReviews();
  const res = seed.seedReviews(store, { now: NOW, perDay: [76, 79] });
  assert.ok(res.count >= 10000, `${res.count} отзывов`);
  assert.equal(store.publicReviews(0).stats.avg, 4.7);

  const t0 = process.hrtime.bigint();
  const direct = store.publicReviews(20);
  const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(firstMs < 400, `первый запрос с сортировкой: ${firstMs.toFixed(1)} мс`);

  let next = direct.next;
  const times = [];
  for (let i = 0; i < 40; i += 1) {
    const s = process.hrtime.bigint();
    const page = store.publicReviews(20, null, { before: store.parseReviewCursor(next) });
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
    next = page.next;
  }
  times.sort((a, b) => a - b);
  assert.ok(times[20] < 15, `страница из кэша: медиана ${times[20].toFixed(2)} мс`);

  const httpTimes = [];
  let bytes = 0;
  let cursor = null;
  for (let i = 0; i < 25; i += 1) {
    const s = process.hrtime.bigint();
    const { json, bytes: b } = await getJson(cursor ? `/api/reviews?before=${encodeURIComponent(cursor)}` : '/api/reviews');
    httpTimes.push(Number(process.hrtime.bigint() - s) / 1e6);
    bytes = Math.max(bytes, b);
    assert.equal(json.reviews.length, 20);
    assert.equal(json.stats.count, res.count);
    cursor = json.next;
  }
  httpTimes.sort((a, b) => a - b);
  assert.ok(httpTimes[12] < 60, `HTTP-страница: медиана ${httpTimes[12].toFixed(1)} мс`);
  assert.ok(bytes < 24 * 1024, `страница весит ${bytes} байт, а не всю базу`);
  t.diagnostic(`${res.count} отзывов: первая сборка ${firstMs.toFixed(1)} мс, страница из кэша ${times[20].toFixed(2)} мс, ` +
    `HTTP медиана ${httpTimes[12].toFixed(1)} мс, страница ${bytes} байт`);

  // Изменение базы сбрасывает кэш сортировки: новый отзыв сразу первым.
  const fresh = store.createReview({ name: 'Самый новый', rating: 5, text: 'Только что', status: 'approved', source: 'admin', createdAt: NOW + 1 });
  assert.equal(store.publicReviews(1).reviews[0].id, fresh.id);
  const copy = store.reviewsByStatus();
  copy.reverse();
  assert.equal(store.reviewsByStatus()[0].id, fresh.id, 'наружу отдаётся копия — порядок витрины не испортить');
  assert.equal(seed.purgeSeedReviews(store), res.count);
  clearReviews();
});

/* ---------- CLI ---------- */

const cli = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(__dirname, '../tools/seed-reviews.js'), ...args],
    { env: { ...process.env, ...env }, timeout: 30000 },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});
const freePort = async () => {
  const s = net.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
const readDb = (d) => JSON.parse(fs.readFileSync(path.join(d, 'db.json'), 'utf8'));

test('CLI: пробный прогон, запись, повтор без дублей, удаление; сервер на той же базе — отказ', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-seedcli-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const env = { DATA_DIR: d, PORT: String(await freePort()) };
  const range = ['--from=2026-05-20', '--to', '2026-06-19'];

  const dry = await cli([...range, '--dry-run'], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /Пробный прогон/);
  assert.match(dry.stdout, /Отзывов: \d+ за 31 дн\./);
  const before = fs.existsSync(path.join(d, 'db.json')) ? readDb(d).reviews || [] : [];
  assert.equal(before.length, 0, '--dry-run не пишет отзывы');

  const run = await cli(range, env);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Тестовые отзывы записаны/);
  assert.match(run.stdout, /Средняя на витрине: 4\.7 \(точно 4\.\d{3}/);
  assert.match(run.stdout, /Плохих \(≤3★\): \d+ — медленный обмен \d+ · высокая комиссия \d+/);
  assert.match(run.stdout, /--purge/, 'подсказка, как удалить перед запуском');
  const db = readDb(d);
  const seeded = db.reviews.filter((r) => r.source === 'seed');
  assert.ok(seeded.length >= 62 && seeded.length <= 93, `${seeded.length} отзывов за 31 день`);
  assert.equal(seeded.reduce((s, r) => s + r.rating, 0), Math.round(4.7 * seeded.length));
  assert.ok(seeded.every((r) => r.createdAt >= msk(2026, 5, 20) && r.createdAt < msk(2026, 6, 20)));
  assert.ok(seeded.every((r) => !('theme' in r)), 'служебная тема в базу не пишется');
  assert.equal(new Set(seeded.map((r) => r.id)).size, seeded.length);
  assert.equal(db.reviewSeq, Math.max(...seeded.map((r) => r.id)) + 1);

  const again = await cli(range, env);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`Заменено прежних тестовых: ${seeded.length}`));
  const db2 = readDb(d).reviews.filter((r) => r.source === 'seed');
  assert.equal(db2.length, seeded.length, 'повтор не удваивает набор');
  assert.deepEqual(db2.map((r) => r.text), seeded.map((r) => r.text), 'и даёт тот же набор');

  const purge = await cli(['--purge'], env);
  assert.equal(purge.code, 0, purge.stderr);
  assert.match(purge.stdout, new RegExp(`Удалено тестовых отзывов: ${seeded.length}`));
  assert.equal(readDb(d).reviews.filter((r) => r.source === 'seed').length, 0);

  const bad = await cli(['--from=31.02.2026'], env);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Дата начала/);
  assert.equal((await cli(['--bogus'], env)).code, 2);

  // Запущенный сервер держит базу в памяти — инструмент отказывается писать поверх.
  const fake = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{}'); }).listen(0, '127.0.0.1');
  await once(fake, 'listening');
  t.after(() => fake.close());
  const busy = await cli(range, { ...env, PORT: String(fake.address().port) });
  assert.equal(busy.code, 3);
  assert.match(busy.stderr, /Остановите его/);
  assert.equal(readDb(d).reviews.filter((r) => r.source === 'seed').length, 0, 'база не тронута');
  const forced = await cli([...range, '--force'], { ...env, PORT: String(fake.address().port) });
  assert.equal(forced.code, 0, forced.stderr);
});
