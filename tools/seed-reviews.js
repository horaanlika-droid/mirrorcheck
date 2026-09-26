#!/usr/bin/env node
// Нагрузочные отзывы для проверки, как сервис справляется с большим их числом.
//
//   npm run seed:reviews                         # с 20.05.2026 по сегодня, 2–3 в день, средняя 4.7
//   npm run seed:reviews -- --dry-run            # только показать, что будет записано
//   npm run seed:reviews -- --per-day=80-100     # тяжёлый прогон: ~11 000 отзывов
//   npm run seed:reviews -- --purge              # удалить все тестовые отзывы
//
// Флаги: --from=2026-05-20|20.05.2026  --to=now|2026-09-26  --avg=4.7
//        --per-day=2-3  --seed=20260520  --dry-run  --purge  --force
//
// Отзывы помечены source:'seed', повторный запуск заменяет прошлый тестовый
// набор, живые отзывы не трогаются. Базу пишет в DATA_DIR (по умолчанию ./data).
// Запускайте при остановленном сервере: он держит базу в памяти и при
// следующем сохранении перезапишет файл своей копией.
const path = require('path');

const HELP = `Нагрузочные отзывы PRICELEX (source: 'seed')

  --from=2026-05-20   первый день (МСК), также 20.05.2026
  --to=now            последний день или now (по умолчанию — сейчас)
  --avg=4.7           средняя оценка на витрине (вместе с живыми отзывами)
  --per-day=2-3       отзывов в день: «2-3» или одно число
  --seed=20260520     зерно генератора: те же флаги — тот же набор
  --dry-run           ничего не записывать, только сводка
  --purge             удалить все тестовые отзывы и выйти
  --force             не проверять, запущен ли сервер`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw new Error(`Непонятный аргумент: ${a}`);
    const [, key, inline] = m;
    if (['dry-run', 'purge', 'force', 'help'].includes(key)) {
      out[key] = true;
    } else if (['from', 'to', 'avg', 'per-day', 'seed'].includes(key)) {
      const v = inline != null ? inline : argv[++i];
      if (v == null || v.startsWith('--')) throw new Error(`Флагу --${key} нужно значение`);
      out[key] = v;
    } else {
      throw new Error(`Неизвестный флаг --${key}`);
    }
  }
  return out;
}

// Сервер, запущенный на той же базе, перезапишет её — проверяем порт заранее.
async function serverIsUp(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 400);
    const r = await fetch(`http://127.0.0.1:${port}/api/settings`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

const fmtMsk = (ts) => new Date(ts + 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
const pct = (n, all) => (all ? Math.round((n / all) * 100) : 0);

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✖ ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const config = require('../src/config');
  if (!args.force && !args['dry-run'] && (await serverIsUp(config.port))) {
    console.error(`✖ На порту ${config.port} отвечает сервер PRICELEX. Остановите его перед запуском:\n` +
      '  он держит базу в памяти и перезапишет отзывы своей копией. (--force — пропустить проверку)');
    return 3;
  }

  const store = require('../src/store');
  const seed = require('../src/review-seed');
  const dbFile = path.join(config.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'db.json');

  if (args.purge) {
    const n = args['dry-run'] ? seed.countSeedReviews(store.get().reviews) : seed.purgeSeedReviews(store);
    if (!args['dry-run']) store.flush();
    console.log(args['dry-run'] ? `Тестовых отзывов в базе: ${n} (--dry-run: ничего не удалено)` : `🧹 Удалено тестовых отзывов: ${n}\n   База: ${dbFile}`);
    return 0;
  }

  let res;
  try {
    res = seed.seedReviews(store, {
      from: args.from,
      to: args.to,
      avg: args.avg != null ? Number(String(args.avg).replace(',', '.')) : undefined,
      perDay: args['per-day'],
      seed: args.seed,
      dryRun: !!args['dry-run'],
    });
  } catch (e) {
    console.error(`✖ ${e.message}`);
    return 2;
  }
  if (!res.dryRun) store.flush();

  const d = res.dist;
  const lines = [
    res.dryRun ? '🧪 Пробный прогон (--dry-run): база не изменена' : '🧪 Тестовые отзывы записаны',
    `   Отзывов: ${res.count} за ${res.days} дн. · ${res.count ? `${fmtMsk(res.first)} — ${fmtMsk(res.last)} МСК` : 'период пуст'}`,
    `   Средняя на витрине: ${res.overallAvg.toFixed(1)} (точно ${res.overallAvg.toFixed(3)}; тестовых ${res.avg.toFixed(3)}, живых отзывов: ${res.live})`,
    `   Оценки: ★5 ${d[5]} (${pct(d[5], res.count)}%) · ★4 ${d[4]} · ★3 ${d[3]} · ★2 ${d[2]} · ★1 ${d[1]}`,
    `   Плохих (≤3★): ${res.low} — медленный обмен ${res.themes.slow || 0} · высокая комиссия ${res.themes.fee || 0} · и то и другое ${res.themes.both || 0} · поддержка ${res.themes.support || 0}`,
    `   С ответом PRICELEX: ${res.replies}`,
    res.dryRun
      ? `   Уже в базе тестовых: ${res.existing} — при записи они будут заменены`
      : `   Заменено прежних тестовых: ${res.removed} · База: ${dbFile}`,
    '   Удалить перед запуском для клиентов: npm run seed:reviews -- --purge (или «🧹 Удалить тестовые» в боте)',
  ];
  console.log(lines.join('\n'));
  return 0;
}

main().then((code) => { process.exitCode = code; });
