// Нагрузочные отзывы: проверяем, как сервис держит сотни и тысячи отзывов.
//
// Только для теста. Каждый отзыв помечен source:'seed', генерация
// детерминирована (одни и те же параметры — один и тот же набор), повторный
// запуск заменяет прошлый набор, а не дописывает к нему, и всё удаляется одной
// командой (CLI --purge или кнопкой «🧹 Удалить тестовые» в боте).
//
// По умолчанию: с 20.05.2026 по сегодня, 2–3 отзыва в день с 08:00 до 23:30 МСК,
// не только хорошие — есть и плохие («обмен медленный», «комиссия высокая»),
// а средняя оценка, которую увидит клиент, ровно 4.7.

const MSK_OFFSET = 3 * 3600 * 1000; // Москва — UTC+3 круглый год
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const DAY_FROM = 8 * 60; // 08:00 МСК
const DAY_TO = 23 * 60 + 30; // 23:30 МСК

const SEED_DEFAULTS = Object.freeze({ from: '2026-05-20', avg: 4.7, perDay: [2, 3], seed: 20260520 });
// Брокеры, которых упоминают отзывы, если список не передан (как DEFAULT_ADMIN_BROKERS
// в store.js). Модуль нарочно не тянет store: генератор — чистая функция.
const FALLBACK_BROKERS = Object.freeze(['stony montana', 'safer', 'INGA352', 'user_161931', 'fast alberto']);

// Маленький детерминированный ГПСЧ: у каждого набора свой seed.
function mulberry32(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- даты по Москве ---------- */

function mskMidnight(y, m, d) {
  const ts = Date.UTC(y, m - 1, d) - MSK_OFFSET;
  const back = new Date(ts + MSK_OFFSET);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return NaN; // 31.02 и т.п.
  return ts;
}

// «2026-05-20» или «20.05.2026» → начало суток по Москве (мс UTC).
function parseDay(v) {
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return mskMidnight(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return mskMidnight(+m[3], +m[2], +m[1]);
  return NaN;
}

const mskDayStart = (ts) => Math.floor((ts + MSK_OFFSET) / DAY) * DAY - MSK_OFFSET;
const mskDayKey = (ts) => new Date(mskDayStart(ts) + MSK_OFFSET).toISOString().slice(0, 10);

// «now» / пусто → сейчас; дата → конец этих суток по Москве; число → как есть.
function parseTo(v, now) {
  if (v == null || v === '' || v === 'now' || v === 'сейчас') return now;
  if (typeof v === 'number') return v;
  const day = parseDay(v);
  return Number.isFinite(day) ? day + DAY - 1 : NaN;
}

/* ---------- тексты ---------- */

const NAMES_M = ['Алексей', 'Дмитрий', 'Сергей', 'Андрей', 'Максим', 'Иван', 'Артём', 'Никита', 'Михаил', 'Егор',
  'Павел', 'Роман', 'Кирилл', 'Денис', 'Олег', 'Владимир', 'Антон', 'Илья', 'Тимур', 'Руслан', 'Глеб',
  'Константин', 'Виктор', 'Георгий', 'Евгений', 'Вадим', 'Степан', 'Арсений'];
const NAMES_F = ['Анна', 'Мария', 'Елена', 'Ольга', 'Наталья', 'Ирина', 'Екатерина', 'Татьяна', 'Юлия', 'Светлана',
  'Алина', 'Дарья', 'Ксения', 'Виктория', 'Полина', 'Вероника', 'Марина', 'Софья', 'Кристина', 'Валерия'];
const INITIALS = 'АБВГДЕЗИКЛМНОПРСТФХЧШ';
const NICKS = [['crypto_max', 'm'], ['Den4ik', 'm'], ['ivan_btc', 'm'], ['vova_spb', 'm'], ['Serg 1987', 'm'],
  ['Nomad', 'm'], ['Kate', 'f'], ['lena.k', 'f'], ['Sasha T.', 'f'], ['mira_ton', 'f']];

// {g:м|ж} — форма по роду автора, {rub} {cur} {min} … — подстановки.
const BODIES = {
  5: [
    ['good', '{g:Обменял|Обменяла} {rub} на {cur}, монеты пришли через {min}.'],
    ['good', 'Брокер {broker} выдал реквизиты сразу, перевод дошёл за {min}.'],
    ['good', 'Курс зафиксировали при создании заявки — на выходе {g:получил|получила} ровно ту сумму, что показывал калькулятор.'],
    ['good', 'Меняю здесь уже не первый раз: стабильно быстро и без сюрпризов.'],
    ['good', 'Всё прозрачно: реквизиты, таймер и статус заявки видно в реальном времени.'],
    ['good', 'Первый раз {g:покупал|покупала} {cur}, в чате поддержки спокойно всё объяснили.'],
    ['good', 'Заявка на {rub} закрылась за {min}, курс не поменялся ни на рубль.'],
    ['good', 'Удобно, что всё внутри Telegram: {g:оплатил|оплатила}, {g:нажал|нажала} «Я оплатил», и через {min} монеты уже были на кошельке.'],
    ['good', 'Брокер вежливый, на вопросы отвечал быстро и по делу.'],
    ['good', 'По курсу выгоднее, чем в обменниках, которыми {g:пользовался|пользовалась} раньше.'],
    ['good', '{g:Купил|Купила} {cur} на {rub} — ссылку на транзакцию прислали сразу после перевода.'],
    ['good', 'Ночью {g:оформил|оформила} заявку, взяли в работу почти мгновенно.'],
    ['good', '{broker}, спасибо за быстрый обмен: {rub} в {cur} за {min}.'],
  ],
  4: [
    ['slow', '{g:Обменял|Обменяла} {rub} на {cur}, всё пришло, но реквизиты {g:ждал|ждала} минут {waitShort}.'],
    ['fee', 'В целом хорошо, но комиссия могла бы быть пониже.'],
    ['slow', 'Всё честно, только подтверждение сети заняло дольше, чем хотелось бы.'],
    ['slow', 'Брокер {broker} отработал нормально, но отвечал не сразу.'],
    ['fee', 'Курс чуть хуже биржевого, зато быстро и без лишних проверок.'],
    ['slow', 'Удобный интерфейс, деньги дошли. Минус звезда за ожидание в вечерний час пик.'],
    ['fee', 'Нормально: заявка на {rub} закрылась за {min}, но курс мог бы быть и лучше.'],
    ['slow', 'Сервис хороший, но в выходные обмен шёл заметно медленнее, чем в будни.'],
  ],
  3: [
    ['slow', 'Обмен медленный: от оплаты до монет прошло больше {waitLong}. Деньги дошли, но {g:понервничал|понервничала}.'],
    ['fee', 'Комиссия высокая — на {rub} вышло почти на {pct}% дороже биржевого курса.'],
    ['slow', 'Всё дошло, но долго {g:ждал|ждала}, пока брокер возьмёт заявку.'],
    ['fee', 'Сервис рабочий, но курс не самый выгодный, комиссия ощутимая.'],
    ['support', 'Обмен прошёл, но поддержка отвечала медленно — по {waitShort} минут на сообщение.'],
    ['slow', 'Реквизиты выдали быстро, а потом {hours} {g:ждал|ждала} перевод.'],
  ],
  2: [
    ['slow', 'Обмен очень медленный — {g:ждал|ждала} {hours}, пока пришли монеты.'],
    ['fee', 'Комиссия высокая: за {rub} {g:получил|получила} заметно меньше {cur}, чем {g:рассчитывал|рассчитывала}. Разница с биржей около {pct}%.'],
    ['slow', 'Долго не выдавали реквизиты, пришлось писать в поддержку.'],
    ['both', 'Медленно и дорого. Монеты дошли, но осадок остался.'],
    ['both', 'Комиссия высокая, а обмен занял {hours}. За такие деньги ждёшь скорости.'],
  ],
  1: [
    ['slow', 'Обмен медленный, {g:ждал|ждала} {hours}. Не рекомендую, если нужно срочно.'],
    ['fee', 'Комиссия высокая, курс хуже, чем где-либо: {g:отдал|отдала} {rub}, а {cur} пришло на {pct}% меньше рыночного.'],
    ['slow', 'Заявку долго не брали в работу, потом ещё {hours} {g:ждал|ждала} перевод.'],
    ['both', 'Дорого и долго. Лучше бы {g:пошёл|пошла} на P2P.'],
    ['both', 'Очень медленный обмен и высокая комиссия. Больше не приду.'],
  ],
};

const OPENINGS = {
  5: ['', '', '', 'Отличный сервис.', 'Всё супер!', 'Рекомендую.', 'Спасибо!', 'Чётко и быстро.', 'Надёжно.',
    'Лучший обменник из тех, что {g:пробовал|пробовала}.', '{g:Доволен|Довольна}.'],
  4: ['', '', 'Хорошо.', 'Неплохо.', 'В целом {g:доволен|довольна}.', 'Твёрдая четвёрка.'],
  low: ['', '', '', 'Так себе.', '{g:Разочарован|Разочарована}.', 'Средне.', '{g:Ожидал|Ожидала} большего.', 'Честно говоря, не впечатлило.'],
};
const CLOSINGS = {
  5: ['', '', '', 'Буду обращаться ещё.', 'Рекомендую друзьям.', 'Спасибо, {broker}!', '10 из 10.',
    'Пять звёзд заслуженно.', 'Теперь меняю только здесь.'],
  4: ['', '', 'В остальном всё отлично.', 'Буду пользоваться дальше.', 'Спасибо!'],
  slow: ['', '', 'Надеюсь, ускоритесь.', 'Деньги в итоге дошли.', 'Если нужно срочно — не вариант.'],
  fee: ['', '', 'Снизите комиссию — вернусь.', 'Деньги в итоге дошли.', 'Сравнивайте курс заранее.'],
  both: ['', '', 'Пока не рекомендую.'],
  support: ['', '', 'Надеюсь, исправите.'],
};
const REPLIES = {
  slow: [
    'Извините за ожидание. Вечером заявок больше, чем свободных брокеров, — мы подключили ещё двоих на это время. Скорость подтверждения в сети, к сожалению, от нас не зависит.',
    'Спасибо, что написали. Проверили заявку: задержка была на подтверждении в сети. Теперь брокер сам пишет в чат, если перевод идёт дольше 20 минут.',
    'Нам жаль, что пришлось ждать. Разобрали ситуацию с брокером — такие заявки теперь уходят в приоритет.',
  ],
  fee: [
    'Спасибо за отзыв. Итоговый курс уже включает сетевую комиссию и работу брокера — без скрытых платежей, сумма видна до оплаты. На крупных суммах курс выгоднее.',
    'Понимаем. Курс обновляется каждые 10 секунд и фиксируется в заявке, комиссия сети входит в него. Передали отзыв команде — смотрим, где можем снизить спред.',
  ],
  both: [
    'Извините за такой опыт. Разобрали заявку: задержка была на стороне брокера, а курс включал сетевую комиссию в пиковый час. Напишите в чат поддержки — компенсируем разницу.',
  ],
  support: ['Извините за задержку с ответом. Мы расширили смену поддержки на вечерние часы.'],
  good: ['Спасибо, что выбрали PRICELEX! Ждём снова.', 'Благодарим за доверие — передадим брокеру ваши слова.', 'Рады, что всё прошло гладко!'],
};

// Доли оценок до подгонки: 81% ★5, 12% ★4, 3% ★3, 2% ★2, 2% ★1 — раздаются
// квотами (а не монеткой), так что плохие отзывы есть в любом наборе от ~30 штук.
const MIX = [[5, 0.81], [4, 0.12], [3, 0.03], [2, 0.02], [1, 0.02]];
// Темы плохих оценок (тоже квотами): медленный обмен и высокая комиссия — основные.
const LOW_THEMES = [['slow', 0.45], ['fee', 0.4], ['both', 0.1], ['support', 0.05]];
const REPLY_CHANCE = { 1: 0.6, 2: 0.6, 3: 0.6, 4: 0.15, 5: 0.05 };

const FAST_MIN = [7, 8, 9, 10, 12, 14, 15, 17, 18, 20, 25]; // «через/за N минут» — у всех одна форма
const WAIT_SHORT = [15, 20, 25, 30, 35];
const WAIT_LONG = ['40 минут', '45 минут', '50 минут', '55 минут', 'часа'];
const HOURS = ['полтора часа', 'почти два часа', 'больше двух часов', 'около трёх часов', 'три с лишним часа'];

const fmtRub = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + '\u00a0₽';

function makeRng(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  return { rnd, pick, between };
}

function amount(R) {
  const x = R.rnd();
  if (x < 0.45) return R.between(6, 30) * 500; // 3 000 – 15 000 ₽
  if (x < 0.85) return R.between(15, 60) * 1000; // 15 000 – 60 000 ₽
  return R.between(12, 30) * 5000; // 60 000 – 150 000 ₽
}

function author(R) {
  const x = R.rnd();
  if (x < 0.1) {
    const [name, g] = R.pick(NICKS);
    return { name, g };
  }
  const g = R.rnd() < 0.62 ? 'm' : 'f';
  const first = R.pick(g === 'm' ? NAMES_M : NAMES_F);
  return { name: x < 0.62 ? `${first} ${R.pick([...INITIALS])}.` : first, g };
}

function fill(tpl, vars, g) {
  return tpl
    .replace(/\{g:([^|}]*)\|([^}]*)\}/g, (_, m, f) => (g === 'f' ? f : m))
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));
}

function composeText(R, rating, theme, who, brokers) {
  const vars = {
    rub: fmtRub(amount(R)),
    cur: R.rnd() < 0.64 ? 'BTC' : 'GRAM',
    min: `${R.pick(FAST_MIN)} минут`,
    waitShort: R.pick(WAIT_SHORT),
    waitLong: R.pick(WAIT_LONG),
    hours: R.pick(HOURS),
    pct: R.between(3, 7),
    broker: R.pick(brokers),
  };
  const pool = BODIES[rating].filter(([t]) => rating >= 4 || t === theme);
  const body = R.pick(pool.length ? pool : BODIES[rating]);
  const open = R.pick(rating >= 4 ? OPENINGS[rating] : OPENINGS.low);
  let close = R.pick(rating >= 4 ? CLOSINGS[rating] : CLOSINGS[body[0]] || CLOSINGS.both);
  if (/Спасибо/.test(open) && /Спасибо/.test(close)) close = ''; // без «Спасибо! … Спасибо, safer!»
  const text = [open, body[1], close].filter(Boolean).map((part) => fill(part, vars, who.g)).join(' ');
  return { text, theme: rating === 5 ? 'good' : body[0], cur: vars.cur };
}

// Время отзывов внутри суток: k моментов с 08:00 до 23:30, не теснее 15 минут.
function dayTimes(R, k) {
  const span = DAY_TO - DAY_FROM;
  for (let attempt = 0; ; attempt += 1) {
    const mins = Array.from({ length: k }, () => DAY_FROM + Math.floor(R.rnd() * (span + 1))).sort((a, b) => a - b);
    const spaced = k > 8 || mins.every((m, i) => i === 0 || m - mins[i - 1] >= 15);
    if (spaced || attempt >= 20) return mins.map((m) => m * MIN + R.between(0, 59) * 1000);
  }
}

function normalizeOpts(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const from = typeof opts.from === 'number' ? opts.from : parseDay(opts.from != null ? opts.from : SEED_DEFAULTS.from);
  const to = Math.min(parseTo(opts.to, now), now); // отзывов из будущего не бывает
  const avg = opts.avg != null ? Number(opts.avg) : SEED_DEFAULTS.avg;
  let perDay = opts.perDay != null ? opts.perDay : SEED_DEFAULTS.perDay;
  if (typeof perDay === 'string') perDay = perDay.split(/[-–:]/).map(Number);
  if (typeof perDay === 'number') perDay = [perDay, perDay];
  if (perDay.length === 1) perDay = [perDay[0], perDay[0]];
  const [minPerDay, maxPerDay] = perDay.map((n) => Math.floor(Number(n)));
  const seed = opts.seed != null ? Number(opts.seed) : SEED_DEFAULTS.seed;
  if (!Number.isFinite(from)) throw new Error('Дата начала: 2026-05-20 или 20.05.2026');
  if (!Number.isFinite(to)) throw new Error('Дата конца: 2026-09-26, 26.09.2026 или now');
  if (to < from) throw new Error('Конец периода раньше начала');
  if ((to - from) / DAY > 3700) throw new Error('Период длиннее 10 лет — проверьте даты');
  if (!(avg >= 1 && avg <= 5)) throw new Error('Средняя оценка — от 1 до 5');
  if (!(minPerDay >= 1 && maxPerDay >= minPerDay && maxPerDay <= 500)) throw new Error('Отзывов в день: например 2-3 (от 1 до 500)');
  if (!Number.isFinite(seed)) throw new Error('seed — число');
  const baseline = { count: Number(opts.baseline?.count) || 0, sum: Number(opts.baseline?.sum) || 0 };
  const brokers = Array.isArray(opts.brokers) && opts.brokers.length ? opts.brokers.map(String) : [...FALLBACK_BROKERS];
  return { now, from, to, avg, minPerDay, maxPerDay, seed, baseline, brokers };
}

// Квоты по методу наибольшего остатка, затем детерминированное перемешивание.
function quotas(R, n, mix) {
  const exact = mix.map(([key, w], i) => ({ key, i, q: w * n, n: Math.floor(w * n) }));
  let left = n - exact.reduce((s, e) => s + e.n, 0);
  for (const e of [...exact].sort((a, b) => (b.q - b.n) - (a.q - a.n) || b.i - a.i)) {
    if (left <= 0) break;
    e.n += 1;
    left -= 1;
  }
  const out = exact.flatMap((e) => Array(e.n).fill(e.key));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(R.rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Подгонка суммы оценок под целевую среднюю: плохие отзывы не трогаем,
// двигаем четвёрки и пятёрки по одной звезде за шаг.
function tuneRatings(R, ratings, target) {
  let sum = ratings.reduce((s, x) => s + x, 0);
  const order = [[4, 3, 2, 1], [5, 4, 3, 2]]; // кого повышать / кого понижать, по очереди
  while (sum !== target) {
    const up = sum < target;
    let moved = false;
    for (const from of order[up ? 0 : 1]) {
      const idx = [];
      for (let i = 0; i < ratings.length; i += 1) if (ratings[i] === from) idx.push(i);
      if (!idx.length) continue;
      const i = idx[Math.floor(R.rnd() * idx.length)];
      ratings[i] += up ? 1 : -1;
      sum += up ? 1 : -1;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return ratings;
}

// Детерминированный набор отзывов (без id): одинаковые параметры — одинаковый результат.
function generateSeedReviews(opts = {}) {
  const o = normalizeOpts(opts);
  const R = makeRng(o.seed);
  const { brokers } = o;

  const stamps = [];
  for (let day = mskDayStart(o.from); day <= o.to; day += DAY) {
    const k = R.between(o.minPerDay, o.maxPerDay);
    for (const t of dayTimes(R, k)) {
      const at = day + t;
      if (at >= o.from && at <= o.to) stamps.push(at);
    }
  }
  const n = stamps.length;
  if (!n) return [];

  // Средняя, которую увидит клиент, считается вместе с уже опубликованными
  // живыми отзывами (baseline), поэтому цель — по всей витрине.
  const target = Math.min(5 * n, Math.max(n, Math.round(o.avg * (n + o.baseline.count)) - o.baseline.sum));
  const ratings = tuneRatings(R, quotas(R, n, MIX), target);
  const lowIdx = [];
  ratings.forEach((r, i) => { if (r <= 3) lowIdx.push(i); });
  const themeOf = new Map(quotas(R, lowIdx.length, LOW_THEMES).map((th, k) => [lowIdx[k], th]));

  const seen = new Set();
  return stamps.map((createdAt, i) => {
    const rating = ratings[i];
    const who = author(R);
    const theme = themeOf.get(i) || null;
    let t = composeText(R, rating, theme, who, brokers);
    for (let tries = 0; seen.has(t.text) && tries < 8; tries += 1) t = composeText(R, rating, theme, who, brokers);
    seen.add(t.text);

    let reply = null;
    if (R.rnd() < REPLY_CHANCE[rating]) {
      const at = createdAt + R.between(60, 600) * MIN; // через 1–10 часов
      const kind = rating >= 4 ? (t.theme === 'fee' ? 'fee' : 'good') : t.theme;
      if (at <= o.now) reply = { text: R.pick(REPLIES[kind] || REPLIES.good), at, by: 'seed' };
    }
    return {
      userId: null,
      orderId: null,
      name: who.name,
      rating,
      text: t.text,
      status: 'approved',
      source: 'seed',
      theme: t.theme,
      createdAt,
      updatedAt: reply ? reply.at : createdAt,
      adminMsgIds: {},
      reply,
    };
  });
}

// Опубликованные «живые» отзывы — к ним подгоняется общая средняя.
function baselineOf(reviews) {
  const live = (reviews || []).filter((r) => r.source !== 'seed' && r.status === 'approved');
  return { count: live.length, sum: live.reduce((s, r) => s + (Number(r.rating) || 0), 0) };
}

const countSeedReviews = (reviews) => (reviews || []).filter((r) => r.source === 'seed').length;

function summarize(list, baseline = { count: 0, sum: 0 }) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const themes = {}; // темы плохих отзывов (≤3★)
  let sum = 0;
  let replies = 0;
  for (const r of list) {
    dist[r.rating] += 1;
    sum += r.rating;
    if (r.rating <= 3 && r.theme) themes[r.theme] = (themes[r.theme] || 0) + 1;
    if (r.reply) replies += 1;
  }
  const count = list.length;
  const all = count + baseline.count;
  return {
    count,
    days: new Set(list.map((r) => mskDayKey(r.createdAt))).size,
    first: count ? list[0].createdAt : null,
    last: count ? list[count - 1].createdAt : null,
    avg: count ? sum / count : 0,
    overallAvg: all ? (sum + baseline.sum) / all : 0,
    live: baseline.count,
    dist,
    low: dist[1] + dist[2] + dist[3],
    themes,
    replies,
  };
}

// Вставка одним mutate: прошлый тестовый набор заменяется, живые отзывы не трогаются.
function seedReviews(store, opts = {}) {
  const db = store.get();
  const baseline = baselineOf(db.reviews);
  const brokers = (store.getAdminBrokers ? store.getAdminBrokers() : [])
    .filter((b) => b && b.active !== false && b.name)
    .map((b) => b.name);
  const list = generateSeedReviews({ brokers, ...opts, baseline });
  const summary = summarize(list, baseline);
  const existing = countSeedReviews(db.reviews);
  if (opts.dryRun) return { ...summary, removed: 0, existing, dryRun: true };
  let removed = 0;
  store.mutate((d) => {
    const before = d.reviews.length;
    d.reviews = d.reviews.filter((r) => r.source !== 'seed');
    removed = before - d.reviews.length;
    for (const { theme, ...r } of list) d.reviews.push({ id: d.reviewSeq++, ...r });
  });
  return { ...summary, removed, existing };
}

function purgeSeedReviews(store) {
  let removed = 0;
  store.mutate((d) => {
    const before = d.reviews.length;
    d.reviews = d.reviews.filter((r) => r.source !== 'seed');
    removed = before - d.reviews.length;
  });
  return removed;
}

module.exports = {
  SEED_DEFAULTS,
  FALLBACK_BROKERS,
  MSK_OFFSET,
  mulberry32,
  parseDay,
  mskDayKey,
  generateSeedReviews,
  baselineOf,
  countSeedReviews,
  summarize,
  seedReviews,
  purgeSeedReviews,
};
