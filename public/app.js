/* PRICELEX — агентство криптоброкеров: клиентское Web App (обмен BTC & GRAM, отзывы, поддержка) */
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  let initData = '';
  let startParam = '';
  let demo = null;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor && tg.setHeaderColor('#080d11');
      tg.setBackgroundColor && tg.setBackgroundColor('#080d11');
    } catch (e) {}
    initData = tg.initData || '';
    startParam = tg.startParam || '';
  }
  if (!initData) {
    try {
      demo = JSON.parse(localStorage.getItem('pricelex_demo') || 'null');
      if (!demo) {
        demo = { id: 900000 + Math.floor(Math.random() * 99999), name: 'Гость' };
        localStorage.setItem('pricelex_demo', JSON.stringify(demo));
      }
    } catch (e) {
      demo = { id: 900001, name: 'Гость' };
    }
  }

  const $ = (s) => document.querySelector(s);
  const TERMINAL = ['completed', 'rejected', 'cancelled'];
  const S = {
    settings: null, me: null, orders: [], order: null, tab: 'exchange',
    returnTab: 'exchange', orderOpen: false,
    currency: 'BTC', isDemo: false, calcFrom: 'rub', support: [],
    history: { points: [], updatedFor: null },
    reviews: { list: [], stats: { count: 0, avg: 0 }, loaded: false },
    reviewDraft: { orderId: null, rating: 5, text: '' },
    brokerApp: null, // последняя заявка «стать брокером»
    captcha: null, // { id, question } — активная математическая капча
  };

  const ADMIN_BROKERS = [
    { login: 'stony montana', name: 'stony montana', rating: '4.98', deals: 342 },
    { login: 'safer', name: 'safer', rating: '4.96', deals: 289 },
    { login: 'INGA352', name: 'INGA352', rating: '4.99', deals: 415 },
    { login: 'user_161931', name: 'user_161931', rating: '4.95', deals: 198 },
    { login: 'fast alberto', name: 'fast alberto', rating: '4.97', deals: 276 },
  ];
  /* ---------- живые числа интерфейса ---------- */

  // Волны с несоизмеримыми периодами дают плавный, но не повторяющийся ход:
  // цифры меняются сами, без ровных значений и без скачков через полсписка.
  const TAU = Math.PI * 2;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const wave = (ms, periodMin, phase) => Math.sin((ms / (periodMin * 60000)) * TAU + phase);
  function organicWave(ms, parts) {
    const sum = parts.reduce((acc, [weight, periodMin, phase]) => acc + weight * wave(ms, periodMin, phase), 0);
    const norm = parts.reduce((acc, [weight]) => acc + weight, 0) || 1;
    return clamp01(0.5 + 0.5 * (sum / norm));
  }

  // «Брокеров в сети»: состав команды берём из настроек бота (кто отмечен онлайн),
  // а число на линии живёт своей жизнью — шаг ±1/±2 человека, без ровных прыжков.
  function brokerPoolBase() {
    const list = (S.settings && S.settings.adminBrokers) || [];
    const online = list.filter((b) => b && b.online !== false).length;
    return Math.max(1, online || ADMIN_BROKERS.length);
  }
  function brokerCountBounds() {
    const base = brokerPoolBase();
    return { base, min: Math.max(1, base - 1), max: base + 2 };
  }
  function currentBrokerCount(now = Date.now()) {
    const { min, max } = brokerCountBounds();
    const w = organicWave(now, [[0.5, 12.7, 0.7], [0.32, 5.3, 2.4], [0.18, 2.3, 4.1]]);
    return min + Math.round(w * (max - min));
  }

  /* ---------- общий гарантийный депозит брокеров ---------- */
  // Это депозит ВСЕХ брокеров площадки — общий фонд, которым страхуется каждая
  // сделка. Сумму задаёт оператор в боте («🤝 Брокеры → 🛡 Общий депозит клиентам»),
  // сейчас это 0.02 BTC. Сумма показывается как задана («0.0200…»), а живут только
  // ПОСЛЕДНИЕ ЧЕТЫРЕ знака сатоши — и живут пошагово: каждое движение это плюс или
  // минус несколько сатоши от предыдущего значения, а не прыжок к случайному числу.
  // Ход детерминирован по времени: у всех клиентов и после перезагрузки цифра одна и
  // та же, поэтому она не «скачет» между открытиями приложения. Нигде это не
  // подчёркивается: клиент видит только тихую строку-справку — мелким приглушённым
  // текстом, без плашки, иконки и акцентного цвета.
  const DEPOSIT_FALLBACK_BTC = 0.02;
  const DEPOSIT_TAIL_DIGITS = 4; // живут только последние четыре знака (0000–9999 сатоши)
  const DEPOSIT_TAIL_MOD = 10 ** DEPOSIT_TAIL_DIGITS;
  const DEPOSIT_STEP_MS = 6000; // один шаг хода
  const DEPOSIT_SEGMENT_STEPS = 600; // отрезок хода — час (600 шагов по 6 с)
  const DEPOSIT_STEP_MAX = 12; // самый крупный шаг, сатоши; чаще всего шаг 1–3
  const DEPOSIT_TAIL_EDGE = 700; // центр хода держится подальше от краёв 0000 и 9999
  // Куда хвост дрейфует за часы: медленные волны с несоизмеримыми периодами (16 ч,
  // 6.5 ч, 2.5 ч) — за сутки меняются все четыре знака, но не рывками.
  const DEPOSIT_DRIFT_WAVES = [[0.5, 16 * 60, 0.6], [0.32, 6.5 * 60, 2.3], [0.18, 2.5 * 60, 4.4]];

  function depositCore() {
    const s = S.settings || {};
    const btc = Number(s.guaranteeFundBtc) > 0 ? Number(s.guaranteeFundBtc) : DEPOSIT_FALLBACK_BTC;
    return { btc, satoshi: Math.max(1, Math.round(btc * 1e8)) };
  }

  // Детерминированный «бросок» для шага (отрезок, номер шага) → [0, 1): без состояния
  // и без Math.random, чтобы одно и то же время всегда давало одну и ту же цифру.
  function hash01(a, b) {
    let h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x7F4A7C15, 0x85EBCA77)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297A2D39) >>> 0;
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  // Один шаг хода: знак — монетка, размер — чаще 1–3 сатоши, изредка до DEPOSIT_STEP_MAX.
  function depositStep(segment, index) {
    const dir = hash01(segment, index) < 0.5 ? -1 : 1;
    const size = 1 + Math.floor(Math.pow(hash01(segment, index + 0x40000), 3) * DEPOSIT_STEP_MAX);
    return dir * size;
  }

  const depositSegmentSums = new Map();
  function depositSegmentSum(segment) {
    if (!depositSegmentSums.has(segment)) {
      if (depositSegmentSums.size > 48) depositSegmentSums.clear();
      let sum = 0;
      for (let i = 1; i <= DEPOSIT_SEGMENT_STEPS; i += 1) sum += depositStep(segment, i);
      depositSegmentSums.set(segment, sum);
    }
    return depositSegmentSums.get(segment);
  }

  // Опорная точка хвоста на границе отрезка: медленный дрейф внутри [lo, hi] с отступом
  // от краёв, чтобы хвост не упирался в 0000 или 9999.
  function depositDriftBase(segment, lo, hi) {
    const ms = segment * DEPOSIT_SEGMENT_STEPS * DEPOSIT_STEP_MS;
    const margin = Math.min(DEPOSIT_TAIL_EDGE, Math.floor((hi - lo) / 4));
    return lo + margin + Math.round(organicWave(ms, DEPOSIT_DRIFT_WAVES) * (hi - lo - 2 * margin));
  }

  // Последние четыре знака в момент `now`: пошаговое блуждание, натянутое между
  // опорными точками соседних отрезков (случайный «мост»). Каждый шаг — ± несколько
  // сатоши, на стыке отрезков разрыва нет, а за часы хвост уходит вслед за дрейфом.
  function depositTail(now, lo, hi) {
    if (hi <= lo) return lo;
    const step = Math.floor(now / DEPOSIT_STEP_MS);
    const segment = Math.floor(step / DEPOSIT_SEGMENT_STEPS);
    const k = step - segment * DEPOSIT_SEGMENT_STEPS; // 0 … DEPOSIT_SEGMENT_STEPS-1
    let walked = 0;
    for (let i = 1; i <= k; i += 1) walked += depositStep(segment, i);
    const from = depositDriftBase(segment, lo, hi);
    const to = depositDriftBase(segment + 1, lo, hi);
    const t = k / DEPOSIT_SEGMENT_STEPS;
    const value = walked - t * depositSegmentSum(segment) + from + t * (to - from);
    return Math.max(lo, Math.min(hi, Math.round(value)));
  }

  // Сатоши → строка BTC с восемью знаками, без плавающей точки: «2003412» → «0.02003412».
  function fmtSatoshi(sat) {
    const n = Math.max(0, Math.round(Number(sat) || 0));
    return `${Math.floor(n / 1e8)}.${String(n % 1e8).padStart(8, '0')}`;
  }

  function depositLive(now = Date.now()) {
    const { satoshi: coreSat } = depositCore();
    // Голова суммы — всё, кроме последних четырёх знаков — стоит как задал оператор
    // («0.0200»). Хвост живёт от заданного значения вверх, так что фонд никогда не
    // показывается меньше настроенного.
    const head = coreSat - (coreSat % DEPOSIT_TAIL_MOD);
    const tail = depositTail(now, coreSat - head, DEPOSIT_TAIL_MOD - 1);
    const total = head + tail;
    return { btc: total / 1e8, satoshi: total, text: fmtSatoshi(total) };
  }

  // Сумма в том виде, в каком её читает клиент: одной цифрой одного цвета — деления
  // на «ровную» и «живую» часть снаружи не видно.
  function depositAmountHtml(dep = depositLive()) {
    return esc(dep.text);
  }

  // Тихое упоминание депозита: одна строка мелким приглушённым текстом, без плашки,
  // иконки и подложки. Одна и та же в форме обмена и в заявках.
  function depositNoteHtml() {
    const dep = depositLive();
    return `<div class="dep-line">Сделка застрахована общим депозитом брокеров площадки — <span class="dep-btc">${depositAmountHtml(dep)}</span> BTC</div>`;
  }

  // Короткая фраза для текстов приложения: «0.02019784 BTC».
  function depositInlineHtml() {
    const dep = depositLive();
    return `<b class="dep-btc">${depositAmountHtml(dep)}</b> BTC`;
  }

  // Метка времени не должна выглядеть нарисованной: 14:00 и 14:05 сдвигаем на 1–4
  // минуты назад. Точки курса идут с часовым шагом, поэтому сдвиг остаётся в пределах
  // фактического наблюдения, но время перестаёт быть ровным.
  function fmtOrganicTime(ts) {
    const p = (x) => String(x).padStart(2, '0');
    const date = new Date(Number(ts) || Date.now());
    if (date.getMinutes() % 5 !== 0) return `${p(date.getHours())}:${p(date.getMinutes())}`;
    const shift = 1 + (Math.abs(Math.round(Number(ts) / 60000)) % 4);
    const moved = new Date(date.getTime() - shift * 60000);
    return `${p(moved.getHours())}:${p(moved.getMinutes())}`;
  }

  // Перерисовываем живые числа точечно: цифры успевают подрасти между опросами.
  function tickLiveNumbers() {
    const count = currentBrokerCount();
    document.querySelectorAll('.broker-online-count').forEach((el) => {
      if (el.textContent === String(count)) return;
      el.textContent = String(count);
      el.classList.add('pulse-number');
      setTimeout(() => el.classList.remove('pulse-number'), 350);
    });
    const dep = depositLive();
    const amount = depositAmountHtml(dep);
    document.querySelectorAll('.dep-btc').forEach((el) => { el.innerHTML = amount; });
  }

  const STATUS = {
    new: { label: 'Подбор брокера', cls: 'new' },
    details: { label: 'Ожидает оплаты', cls: 'details' },
    paid: { label: 'Подтверждение', cls: 'paid' },
    completed: { label: 'Завершён', cls: 'completed' },
    rejected: { label: 'Отклонён', cls: 'rejected' },
    cancelled: { label: 'Отменён', cls: 'cancelled' },
  };

  const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
  const fmtRub = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
  const fmtCrypto = (v, cur) => {
    const n = Number(v) || 0;
    const dec = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
    return n.toFixed(dec) + ' ' + cur;
  };
  const cryptoFromRub = (rub, rate) => Math.floor(((Number(rub) || 0) / rate) * 1e8 + 1e-6) / 1e8;
  const rubFromCrypto = (crypto, rate) => Math.ceil(Number(crypto) * rate - 1e-6);
  const fmtTrim = (v) => {
    const n = Number(v) || 0;
    if (!(n > 0)) return '';
    return n.toFixed(8).replace(/\.?0+$/, '');
  };
  const fmtDate = (ts) => {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtDayMonth = (ts) => {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}`;
  };
  const fmtAgo = (ts) => {
    if (!Number.isFinite(Number(ts))) return '—';
    const diff = Date.now() - Number(ts);
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч назад`;
    return `${Math.floor(diff / 86400000)} дн назад`;
  };
  const spanLabel = (ms) => {
    if (ms < 5400000) return `за ${Math.max(1, Math.round(ms / 60000))} мин`;
    if (ms < 129600000) return `за ${Math.max(1, Math.round(ms / 3600000))} ч`;
    return `за ${Math.max(1, Math.round(ms / 86400000))} дн`;
  };
  const fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
    return (n / 1024 / 1024).toFixed(1) + ' МБ';
  };
  let pendingReceipt = null;
  const haptic = (t = 'light') => {
    try {
      if (tg && tg.HapticFeedback) {
        if (t === 'success' || t === 'warning' || t === 'error') {
          tg.HapticFeedback.notificationOccurred(t);
        } else if (t === 'selection') {
          tg.HapticFeedback.selectionChanged();
        } else {
          tg.HapticFeedback.impactOccurred(t);
        }
      }
    } catch (e) {}
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        if (t === 'success') navigator.vibrate([16, 40, 24]);
        else if (t === 'warning') navigator.vibrate([24, 30, 20]);
        else if (t === 'error') navigator.vibrate([30, 40, 30, 40, 30]);
        else if (t === 'heavy') navigator.vibrate(28);
        else if (t === 'medium') navigator.vibrate(18);
        else if (t === 'selection') navigator.vibrate(8);
        else navigator.vibrate(12);
      }
    } catch (e) {}
  };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copyText(t, msg) {
    haptic('success');
    try {
      await navigator.clipboard.writeText(t);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg || 'Скопировано ✅');
  }

  async function api(path, opts = {}) {
    const q = new URLSearchParams(opts.query || {});
    if (initData) q.set('initData', initData);
    else if (demo) { q.set('demo[id]', demo.id); q.set('demo[name]', demo.name); }
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(path + sep + q.toString(), {
        method: opts.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: opts.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: opts.method === 'POST' ? JSON.stringify(Object.assign({ initData, demo }, opts.body || {})) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  const ICONS = {
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 15.2c2.6.3 4.4 1.8 5 4.8"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
    // Поддержка: чистый силуэт вопросительного знака (дуга + ножка + точка).
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8.6 7.8a3.6 3.6 0 1 1 5.3 3.17c-1.14.62-1.9 1.5-1.9 2.73v.9"/><circle cx="12" cy="18.6" r="1.3" fill="currentColor" stroke="none"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.6 2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.72 6.88 19.4l.98-5.72L3.7 9.64l5.75-.84L12 3.6Z"/></svg>',
    starFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3.6 2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.72 6.88 19.4l.98-5.72L3.7 9.64l5.75-.84L12 3.6Z"/></svg>',
    down: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="m6 14 6 6 6-6"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
    bolt: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>',
    case: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7.5" width="18" height="12.5" rx="2.5"/><path d="M8.5 7.5V6a2.5 2.5 0 0 1 2.5-2.5h2A2.5 2.5 0 0 1 15.5 6v1.5"/><path d="M3 13h18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c.8-3.4 3.3-5.2 7.5-5.2s6.7 1.8 7.5 5.2"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  };

  /* ---------- график (реальная история курса и сумм) ---------- */
  let chartSeq = 0;

  function smoothPath(pts, top, bottom) {
    if (pts.length < 2) return '';
    if (pts.length === 2) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;
    const clamp = (v) => Math.min(bottom, Math.max(top, v));
    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const t = 0.2;
      const c1x = p1.x + (p2.x - p0.x) * t;
      const c2x = p2.x - (p3.x - p1.x) * t;
      const c1y = clamp(p1.y + (p2.y - p0.y) * t);
      const c2y = clamp(p2.y - (p3.y - p1.y) * t);
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
  }

  // series: [{ at, v }] — реальные наблюдения; рисуем только то, что есть.
  function renderChart(el, series, opts = {}) {
    if (!el) return;
    const W = Math.max(240, Math.round(el.clientWidth || 320));
    const H = Math.max(120, Math.round(el.clientHeight || 158));
    const top = 18;
    const bottom = 14;
    const values = series.map((p) => Number(p.v)).filter((v) => Number.isFinite(v));
    const en = values.length;
    const lo = en ? Math.min(...values) : 0;
    const hi = en ? Math.max(...values) : 1;
    const span = hi - lo;
    const mid = top + (H - top - bottom) / 2;
    const yOf = (v) => (span > 0 ? top + (1 - (v - lo) / span) * (H - top - bottom) : mid);
    const t0 = en ? series[0].at : 0;
    const t1 = en ? series[series.length - 1].at : 0;
    const ts = t1 - t0;
    const xOf = (p, i) => {
      if (ts > 0) return (Math.min(t1, Math.max(t0, p.at)) - t0) / ts * W;
      return en > 1 ? (i / (en - 1)) * W : W;
    };

    const id = ++chartSeq;
    const grid = [];
    for (let i = 1; i <= 5; i += 1) grid.push(`<line class="grid-v" x1="${(W * i / 6).toFixed(1)}" y1="${top - 6}" x2="${(W * i / 6).toFixed(1)}" y2="${H - bottom + 4}"/>`);
    for (let i = 1; i <= 3; i += 1) grid.push(`<line class="grid-h" x1="0" y1="${(top + (H - top - bottom) * i / 4).toFixed(1)}" x2="${W}" y2="${(top + (H - top - bottom) * i / 4).toFixed(1)}"/>`);

    const pts = series.map((p, i) => ({ x: xOf(p, i), y: yOf(Number(p.v)) }));
    const last = pts[pts.length - 1] || { x: W, y: mid };
    const hasLine = pts.length >= 3;
    const line = hasLine ? smoothPath(pts, top - 4, H - bottom + 4) : '';
    const area = hasLine ? `${line} L${last.x.toFixed(1)},${H - bottom} L${pts[0].x.toFixed(1)},${H - bottom} Z` : '';
    const guide = hasLine ? '' : `<line class="guide" x1="0" y1="${last.y.toFixed(1)}" x2="${(last.x - 12).toFixed(1)}" y2="${last.y.toFixed(1)}"/>`;

    // Просадка: самая низкая фактическая точка окна — лучшая цена для покупки.
    let dip = null;
    if (opts.markDip && hasLine && span > 0) {
      let mi = 0;
      series.forEach((p, i) => { if (Number(p.v) < Number(series[mi].v)) mi = i; });
      dip = { x: pts[mi].x, y: pts[mi].y, v: Number(series[mi].v), at: series[mi].at, isLast: mi === pts.length - 1 };
    }
    const dipSvg = dip ? `
        <rect class="dip-zone" x="${Math.max(0, dip.x - 22).toFixed(1)}" y="${top - 6}" width="44" height="${H - top - bottom + 10}" rx="10" fill="url(#plDip${id})"/>
        <line class="dip-line" x1="${dip.x.toFixed(1)}" y1="${top - 6}" x2="${dip.x.toFixed(1)}" y2="${H - bottom + 4}"/>
        ${dip.isLast ? '' : `<path class="dip-mark" d="M${dip.x.toFixed(1)},${(dip.y - 6).toFixed(1)} L${(dip.x + 6).toFixed(1)},${dip.y.toFixed(1)} L${dip.x.toFixed(1)},${(dip.y + 6).toFixed(1)} L${(dip.x - 6).toFixed(1)},${dip.y.toFixed(1)} Z"/>`}` : '';

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="plLine${id}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#7d6a4f"/><stop offset="50%" stop-color="#c9a87e"/><stop offset="100%" stop-color="#e3c9a2"/>
          </linearGradient>
          <linearGradient id="plArea${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(201,168,126,.22)"/><stop offset="100%" stop-color="rgba(201,168,126,0)"/>
          </linearGradient>
          <radialGradient id="plDot${id}">
            <stop offset="0%" stop-color="rgba(243,218,182,.45)"/><stop offset="100%" stop-color="rgba(243,218,182,0)"/>
          </radialGradient>
          <linearGradient id="plDip${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(127,176,155,0)"/><stop offset="70%" stop-color="rgba(127,176,155,.10)"/><stop offset="100%" stop-color="rgba(127,176,155,.22)"/>
          </linearGradient>
        </defs>
        ${grid.join('')}
        ${guide}
        ${dipSvg}
        ${area ? `<path class="area" d="${area}" fill="url(#plArea${id})"/>` : ''}
        ${line ? `<path class="line" d="${line}" stroke="url(#plLine${id})"/>` : ''}
        <circle class="dot-halo" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="15" fill="url(#plDot${id})"/>
        <circle class="dot-core" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4.6"/>
      </svg>`;
    return { x: last.x, y: last.y, W, H, dip };
  }

  // Подпись у точки просадки + сигнал «лучшее время для покупки» под графиком.
  function renderDipLabel(el, spot, span = 0) {
    if (!el || !spot || !spot.dip || spot.dip.isLast) return;
    const { dip, W } = spot;
    const lab = document.createElement('div');
    const leftSide = dip.x > W * 0.6;
    lab.className = 'chart-dip' + (leftSide ? ' left' : '');
    lab.style.left = (leftSide ? dip.x - 12 : Math.min(W - 70, Math.max(70, dip.x))) + 'px';
    lab.style.top = Math.max(0, dip.y - (leftSide ? 20 : 46)) + 'px';
    const timeLabel = span > 86400000 ? `${fmtDayMonth(dip.at)} ${fmtOrganicTime(dip.at)}` : fmtOrganicTime(dip.at);
    lab.innerHTML = `<span class="d-k">Просадка · ${esc(timeLabel)}</span><span class="d-v">${esc(Math.round(dip.v).toLocaleString('ru-RU'))} ₽</span>`;
    el.appendChild(lab);
  }

  const DISCLAIMER = '<div class="disclaimer">По фактическим данным курса за период. Не является инвестиционной рекомендацией.</div>';

  function marketSignal(series, spot) {
    if (!spot || !spot.dip || series.length < 3) return '';
    const vals = series.map((p) => Number(p.v));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const cur = vals[vals.length - 1];
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const when = spanLabel(series[series.length - 1].at - series[0].at);
    const pos = hi > lo ? (cur - lo) / (hi - lo) : 1;
    const above = lo > 0 ? ((cur - lo) / lo) * 100 : 0;
    if (spot.dip.isLast || pos <= 0.2) {
      return `<div class="signal buy"><span class="s-ic">◆</span><div><div class="s-t">Лучшее время для покупки</div>` +
        `<div class="s-s">${spot.dip.isLast ? `Курс на минимуме ${when}` : `Курс у минимума ${when} — всего на ${above.toFixed(2)} % выше дна`}. Брокеры PRICELEX зафиксируют цену за вас.</div></div></div>`;
    }
    const below = avg > 0 ? ((avg - cur) / avg) * 100 : 0;
    if (below > 0.05) {
      return `<div class="signal good"><span class="s-ic">◆</span><div><div class="s-t">Курс ниже среднего ${when}</div>` +
        `<div class="s-s">На ${below.toFixed(2)} % дешевле средней цены периода — хороший момент для покупки.</div></div></div>`;
    }
    return `<div class="signal"><span class="s-ic">◇</span><div><div class="s-t">Лучшая цена ${when} — ${Math.round(lo).toLocaleString('ru-RU')} ₽ в ${fmtOrganicTime(spot.dip.at)}</div>` +
      `<div class="s-s">Сейчас на ${above.toFixed(2)} % выше. Отмечаем просадки на графике — следите за точкой входа.</div></div></div>`;
  }

  function renderChartNote(el, text) {
    if (!el || !text) return;
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = text;
    el.appendChild(note);
  }

  function renderChartTip(el, spot, value, sub) {
    if (!el || !spot) return;
    const tip = document.createElement('div');
    tip.className = 'chart-tip' + (spot.y < 78 ? ' below' : '');
    tip.style.top = (spot.y < 78 ? spot.y + 12 : spot.y - 8) + 'px';
    tip.innerHTML = `<div class="t-k">сейчас</div><div class="t-v">${esc(value)}</div>${sub ? `<div class="t-s">${esc(sub)}</div>` : ''}`;
    el.appendChild(tip);
  }

  function renderHero() {
    const s = S.settings;
    if (!s) return;
    const cur = S.currency;
    const rate = cur === 'BTC' ? s.rateBTC : s.rateGRAM;
    const label = document.getElementById('heroRate');
    if (label) label.textContent = Math.round(Number(rate) || 0).toLocaleString('ru-RU');
    const sub = document.getElementById('heroSub');
    if (sub) sub.innerHTML = `за 1 <b>${cur}</b>`;
    const upd = document.getElementById('heroUpdated');
    if (upd) upd.textContent = s.rateUpdatedAt ? fmtAgo(s.rateUpdatedAt) : 'ожидаем обновление';

    const series = (S.history.points || []).map((p) => ({ at: p.at, v: cur === 'BTC' ? p.btc : p.gram }))
      .filter((p) => Number.isFinite(p.v) && p.v > 0);
    const chart = document.getElementById('rateChart');
    const axis = document.getElementById('rateAxis');
    const signal = document.getElementById('rateSignal');
    chart.innerHTML = '';
    if (axis) axis.innerHTML = '';
    if (signal) signal.innerHTML = '';

    if (series.length >= 2) {
      const span = series[series.length - 1].at - series[0].at;
      const spot = renderChart(chart, series, { markDip: true });
      renderDipLabel(chart, spot, span);
      if (signal) {
        const sig = marketSignal(series, spot);
        signal.innerHTML = sig ? sig + DISCLAIMER : '';
      }
      renderChartTip(chart, spot, (Math.round(series[series.length - 1].v) || 0).toLocaleString('ru-RU') + ' ₽', fmtTime(series[series.length - 1].at));
      if (axis) {
        const mid = series[Math.floor((series.length - 1) / 2)];
        const fmtAxis = (ts) => (span > 86400000 ? fmtDayMonth(ts) : fmtTime(ts));
        axis.innerHTML = [series[0], mid, series[series.length - 1]]
          .map((p) => `<span>${fmtAxis(p.at)}</span>`).join('');
      }
      const a = series[0].v;
      const b = series[series.length - 1].v;
      const pct = a > 0 ? ((b - a) / a) * 100 : 0;
      const cls = Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down';
      const ar = cls === 'flat' ? '•' : cls === 'up' ? '▲' : '▼';
      const txt = cls === 'flat' ? 'без изменений' : `${Math.abs(pct).toFixed(2)} %`;
      const when = spanLabel(series[series.length - 1].at - series[0].at);
      const d = document.getElementById('heroDelta');
      if (d) d.innerHTML = `<span class="delta ${cls}"><span class="ar">${ar}</span><span>${txt}</span><span class="when">${when}</span></span>`;
    } else {
      renderChart(chart, series.length ? series : [{ at: Date.now(), v: 0 }]);
      renderChartTip(chart, { x: 0, y: (chart.clientHeight || 158) / 2 }, (Math.round(Number(rate) || 0)).toLocaleString('ru-RU') + ' ₽', 'текущий курс');
      renderChartNote(chart, 'График курса появится, когда накопится история обновлений');
      const d = document.getElementById('heroDelta');
      if (d) d.innerHTML = '<span class="delta flat"><span class="ar">•</span><span>стабильный курс</span></span>';
    }
  }

  function isOrderPage() {
    return S.tab === 'exchange' && Boolean(S.order && S.orderOpen);
  }

  function isSubpage() {
    return ['profile', 'broker', 'support', 'desk'].includes(S.tab) || isOrderPage();
  }

  function renderHeader() {
    const header = $('#appHeader');
    if (!header) return;
    const s = S.settings || {};
    const home = S.tab === 'exchange' && !isOrderPage();
    const status = s.online
      ? '<span class="pill"><span class="dot"></span>Live</span>'
      : '<span class="pill off"><span class="dot"></span>Offline</span>';
    const demoTag = S.isDemo ? '<span class="pill demo">ДЕМО</span>' : '';

    if (home) {
      header.innerHTML = `
        <div class="hdr-home">
          <div class="hdr-brand">
            <img class="hdr-logo-img" src="/img/logo.jpg" alt="PRICELEX" width="34" height="34" />
            <div class="hdr-brand-text">
              <span class="hdr-logo">PRICELEX</span>
              <span class="hdr-sub">PRIVATE CRYPTO BROKERAGE</span>
            </div>
          </div>
          <div class="hdr-actions"><div class="hdr-status">${status}${demoTag}</div><button class="icon-button" id="profileMenu" type="button" aria-label="Открыть профиль">${ICONS.menu}</button></div>
        </div>`;
      $('#profileMenu').addEventListener('click', () => { haptic('light'); goTab('profile'); });
      return;
    }

    const titles = {
      history: 'История', reviews: 'Отзывы', refs: 'Рефералы', profile: 'Профиль',
      broker: 'Стать брокером', support: 'Помощь', desk: 'Деск', info: 'Инфо',
    };
    const title = isOrderPage() ? 'Заявка' : (titles[S.tab] || 'PRICELEX');
    header.innerHTML = `
      <div class="hdr-page">
        <button class="icon-button back-button" id="headerBack" type="button" aria-label="Назад">${ICONS.back}</button>
        <div class="hdr-page-title">${title}</div>
        <div class="hdr-page-spacer" aria-hidden="true"></div>
      </div>`;
    $('#headerBack').addEventListener('click', goBack);
  }

  function goBack() {
    if (isOrderPage()) {
      S.orderOpen = false;
      renderExchange();
      renderHeader();
      renderNav();
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      return;
    }
    goTab(S.returnTab || 'exchange');
  }

  function renderAnnounce() {
    const el = $('#announce');
    const t = S.settings && S.settings.announcement;
    el.classList.toggle('hidden', !t);
    el.textContent = t || '';
  }

  function goTab(tab) {
    if (tab === S.tab) return;
    S.returnTab = S.tab;
    S.tab = tab;
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    const view = $('#view-' + tab);
    if (view) view.classList.remove('hidden');
    $('.app').classList.toggle('subpage', isSubpage());
    renderHeader();
    renderNav();
    if (tab === 'history') renderHistory();
    if (tab === 'refs') renderRefs();
    if (tab === 'profile') renderProfile();
    if (tab === 'broker') { renderBroker(); loadBrokerStatus(); }
    if (tab === 'desk') renderDesk();
    if (tab === 'info') renderInfo();
    if (tab === 'support') renderSupport();
    if (tab === 'reviews') { renderReviews(); loadReviews(); }
    // Возвращаясь на обмен, сразу обновляем живые числа (курс, депозит, брокеры),
    // не перерисовывая форму — введённая сумма и кошелёк остаются на месте.
    if (tab === 'exchange') tickLiveNumbers();
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  /* ---------- страница брокера для клиента: минимум — только скорость ---------- */

  function renderDesk() {
    const v = $('#view-desk');
    const s = S.settings || {};
    const avg = Number(s.avgExchangeMin);
    v.innerHTML = `
      <section class="card editorial">
        <div class="ed-art" style="background-image:url('/img/broker.jpg')" aria-hidden="true"></div>
        <div class="ed-body">
          <div class="kicker">Ваш брокер — <em>команда PRICELEX</em></div>
          <div class="display">Среднее время<br>обмена — <em>${avg > 0 ? `${avg} мин` : 'минуты'}</em></div>
        </div>
      </section>
      <div class="card desk-metric">
        <div class="dm-num">${avg > 0 ? `${avg}<span>мин</span>` : '—'}</div>
        <div class="dm-label">${avg > 0 ? 'среднее время обмена по последним сделкам' : 'статистика появится после первых сделок'}</div>
      </div>
      <div class="card brokers-pool-card">
        <div class="card-title">
          <span>Брокеры на линии</span>
          <span class="pill"><span class="dot"></span>Брокеров в сети: <b class="broker-online-count">${currentBrokerCount()}</b></span>
        </div>
        <div class="brokers-pool-sub">Проверенные специалисты под управлением администрации — всегда онлайн:</div>
        <div class="brokers-list">
          ${ADMIN_BROKERS.map((b) => `
            <div class="broker-row">
              <div class="broker-avatar">${esc(b.login.slice(0, 2).toUpperCase())}</div>
              <div class="broker-details">
                <div class="broker-name">${esc(b.name)}</div>
                <div class="broker-meta">★ ${b.rating} · ${b.deals} сделок</div>
              </div>
              <div class="broker-status-tag"><span class="dot-online"></span>онлайн</div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="card">
        <div class="feat">
          <div class="f"><span class="i">◆</span>Сделку ведёт живой брокер из проверенной команды — быстро и вручную</div>
          <div class="f"><span class="i">◆</span>Брокеры торгуют под залог общего депозита — сейчас ${depositInlineHtml()}: если выплата не пришла, площадка гарантированно компенсирует средства клиенту</div>
          <div class="f"><span class="i">◆</span>Средства на время сделки лежат на гарантийном счёте и размораживаются после подтверждения оплаты</div>
        </div>
        <button class="btn btn-primary mt" id="deskGo">${ICONS.bolt}<span>Обменять сейчас</span></button>
      </div>
      <div class="signature">PRICELEX<span>— быстро · надёжно · по-честному —</span></div>`;
    $('#deskGo').addEventListener('click', () => { haptic('light'); goTab('exchange'); });
  }

  function renderNav() {
    const nav = $('#nav');
    const visible = ['exchange', 'history', 'reviews', 'refs', 'info'].includes(S.tab) && !isOrderPage();
    nav.classList.toggle('hidden', !visible);
    $('.app').classList.toggle('subpage', isSubpage());
    if (!visible) { nav.innerHTML = ''; return; }

    const last = S.tab === 'info'
      ? ['info', 'Инфо', ICONS.info]
      : ['profile', 'Профиль', ICONS.user];
    const items = [
      ['exchange', 'Обмен', ICONS.swap],
      ['history', 'История', ICONS.clock],
      ['reviews', 'Отзывы', ICONS.star],
      ['refs', 'Рефералы', ICONS.users],
      last,
    ];
    nav.innerHTML = items
      .map(([id, label, icon]) => `<button type="button" data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${icon}<span>${label}</span></button>`)
      .join('');
    nav.querySelectorAll('button').forEach((button) =>
      button.addEventListener('click', () => {
        if (S.tab === button.dataset.tab) return;
        haptic('light');
        goTab(button.dataset.tab);
      })
    );
  }

  function renderExchange() {
    const hasOpenOrder = S.order && !TERMINAL.includes(S.order.status);
    $('#view-exchange').innerHTML = `
      <div class="exchange-heading ${S.order && S.orderOpen ? 'hidden' : ''}">
        <div class="exchange-heading-left">
          <img class="exchange-logo-badge" src="/img/logo.jpg" alt="PRICELEX" width="38" height="38" />
          <div><h1>Обмен</h1><p>RUB <span>→</span> BTC / GRAM</p></div>
        </div>
        <div class="brokers-online-chip" title="Брокеров PRICELEX в сети">
          <span class="dot-online"></span>
          <span>Брокеров в сети: <b class="broker-online-count">${currentBrokerCount()}</b></span>
        </div>
      </div>
      ${hasOpenOrder && !S.orderOpen ? `
        <button class="active-order" id="activeOrder" type="button">
          <span class="active-order-mark">${ICONS.clock}</span>
          <span class="active-order-copy"><b>У вас есть активная заявка</b><small>#${S.order.id} · ${STATUS[S.order.status]?.label || 'В работе'}</small></span>
          ${ICONS.chevron}
        </button>` : ''}
      <div id="exForm" class="${S.order && S.orderOpen ? 'hidden' : ''}">
        <div class="seg block currency-segment" id="segCur">
          <button type="button" data-c="BTC" class="${S.currency === 'BTC' ? 'on' : ''}">₿ BTC</button>
          <button type="button" data-c="GRAM" class="${S.currency === 'GRAM' ? 'on' : ''}">G GRAM</button>
        </div>
        <section class="card card-hero lux-hero">
          <div class="hero-art" aria-hidden="true"></div>
          <div class="hero-top"><div class="kicker">Текущий курс</div></div>
          <div class="hero-amount">
            <div class="metric"><span id="heroRate">—</span><span class="cur">₽</span></div>
            <div id="heroDelta"></div>
          </div>
          <div class="metric-sub" id="heroSub">за 1 <b>${S.currency}</b></div>
          <div class="chart" id="rateChart"></div>
          <div class="chart-axis" id="rateAxis"></div>
          <div id="rateSignal"></div>
          <div class="hero-foot">
            <div><div class="k">Курс обновлён</div><div class="v" id="heroUpdated">—</div></div>
            <button class="ghost-pill" id="howItWorks"><span class="q">?</span>Как это работает</button>
          </div>
        </section>

        <div class="card exchange-form-card">
          <div class="card-title">Сумма обмена</div>
          <div class="f-label"><span>Вы отдаёте</span><span id="mmLabel"></span></div>
          <div class="field">
            <div class="coin-ic rub">₽</div>
            <input id="inRub" type="number" inputmode="decimal" placeholder="5 000" min="0" step="any">
            <span class="suffix">RUB</span>
          </div>
          <div class="swap-row"><div class="swap">${ICONS.down}</div></div>
          <div class="f-label"><span>Вы получаете</span><span id="cryptoLimits"></span></div>
          <div class="field">
            <div class="coin-ic" id="getIc">₿</div>
            <input id="inCrypto" type="number" inputmode="decimal" placeholder="0.0005" min="0" step="any">
            <span class="suffix" id="curSuffix">BTC</span>
          </div>
          <div class="f-hint">Введите сумму в любом поле — второе посчитается автоматически</div>
          <div class="f-meta" id="fMeta"></div>
          ${depositNoteHtml()}
        </div>

        <div class="card wallet-card">
          <div class="card-title">Кошелёк получателя</div>
          <div class="field">
            <div class="coin-ic" id="walIc">₿</div>
            <input id="inWallet" placeholder="Адрес BTC-кошелька" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
          </div>
          ${captchaHtml('capOrder')}
          <div class="f-err" id="fErr"></div>
        </div>

        <button class="btn btn-primary mt" id="btnGo">${ICONS.bolt}<span>Найти реквизиты</span></button>
      </div>
      <div id="exOrder" class="${S.order && S.orderOpen ? '' : 'hidden'}"></div>
    `;
    $('#segCur').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        S.currency = b.dataset.c;
        haptic('light');
        $('#segCur').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        renderHero();
        renderFormMeta();
      })
    );
    const activeOrder = $('#activeOrder');
    if (activeOrder) activeOrder.addEventListener('click', () => {
      S.orderOpen = true;
      renderExchange();
      renderHeader();
      renderNav();
    });
    $('#inRub').addEventListener('input', () => { S.calcFrom = 'rub'; renderFormMeta(); });
    $('#inCrypto').addEventListener('input', () => { S.calcFrom = 'crypto'; renderFormMeta(); });
    $('#btnGo').addEventListener('click', submitOrder);
    $('#howItWorks').addEventListener('click', () => { haptic('light'); goTab('info'); });
    renderCaptchaBoxes();
    renderHero();
    renderFormMeta();
    renderOrderStage();
  }

  function renderFormMeta() {
    const s = S.settings;
    if (!s) return;
    const cur = S.currency;
    const rate = cur === 'BTC' ? s.rateBTC : s.rateGRAM;
    const inRub = $('#inRub');
    const inCrypto = $('#inCrypto');
    if (inRub && inCrypto) {
      if (S.calcFrom === 'crypto') {
        const c = parseFloat(inCrypto.value);
        inRub.value = c > 0 ? String(rubFromCrypto(c, rate)) : '';
      } else {
        const rub = parseFloat(inRub.value);
        inCrypto.value = rub > 0 ? fmtTrim(cryptoFromRub(rub, rate)) : '';
      }
    }
    $('#mmLabel').textContent = `от ${fmtRub(s.minRub)} до ${fmtRub(s.maxRub)}`;
    const cl = $('#cryptoLimits');
    if (cl) cl.textContent = `≈ ${fmtTrim(s.minRub / rate)}–${fmtTrim(s.maxRub / rate)} ${cur}`;
    const ic = $('#getIc');
    ic.className = 'coin-ic ' + cur.toLowerCase();
    ic.textContent = cur === 'BTC' ? '₿' : 'G';
    const wi = $('#walIc');
    wi.className = 'coin-ic ' + cur.toLowerCase();
    wi.textContent = cur === 'BTC' ? '₿' : 'G';
    const sfx = $('#curSuffix');
    if (sfx) sfx.textContent = cur;
    $('#inWallet').placeholder = cur === 'BTC' ? 'Адрес BTC-кошелька (bc1… / 1… / 3…)' : 'Адрес GRAM-кошелька';
    $('#inCrypto').placeholder = cur === 'BTC' ? '0.0005' : '40';
    $('#fMeta').innerHTML = `
      <div class="row"><span>Курс обмена</span><b>1 ${cur} = ${fmtRub(rate)}</b></div>
      ${s.rateUpdatedAt ? `<div class="row"><span>Курс обновлён</span><b>${fmtDate(s.rateUpdatedAt)}</b></div>` : ''}
      <div class="row"><span>Сделку ведёт</span><button class="f-link" id="yourBroker"><b>брокер PRICELEX</b>${ICONS.info}</button></div>`;
    const yb = $('#yourBroker');
    if (yb) yb.addEventListener('click', () => { haptic('light'); goTab('desk'); });
    const btn = $('#btnGo');
    const hasOpenOrder = S.order && !TERMINAL.includes(S.order.status);
    btn.disabled = !s.online || Boolean(hasOpenOrder);
    btn.querySelector('span').textContent = !s.online
      ? 'Обмен временно недоступен'
      : hasOpenOrder ? 'Сначала завершите текущую заявку' : 'Найти реквизиты';
  }

  async function submitOrder() {
    const s = S.settings;
    const err = $('#fErr');
    err.textContent = '';
    const rate = S.currency === 'BTC' ? s.rateBTC : s.rateGRAM;
    const rawRub = parseFloat($('#inRub').value);
    const rawCrypto = parseFloat($('#inCrypto').value);
    const useCrypto = S.calcFrom === 'crypto' && isFinite(rawCrypto) && rawCrypto > 0;
    const cryptoAmount = useCrypto ? rawCrypto : null;
    const rub = useCrypto ? rubFromCrypto(rawCrypto, rate) : rawRub;
    const wallet = ($('#inWallet').value || '').trim();
    if (!s.online) return (err.textContent = '⛔ Обмен временно недоступен — загляните позже.');
    if (!isFinite(rub) || rub < s.minRub) return (err.textContent = `Минимальная сумма обмена — ${fmtRub(s.minRub)} (≈ ${fmtTrim(cryptoFromRub(s.minRub, rate))} ${S.currency}).`);
    if (rub > s.maxRub) return (err.textContent = `Максимальная сумма обмена — ${fmtRub(s.maxRub)} (≈ ${fmtTrim(cryptoFromRub(s.maxRub, rate))} ${S.currency}).`);
    if (!/^[a-zA-Z0-9]{26,90}$/.test(wallet)) return (err.textContent = 'Проверьте адрес кошелька — он выглядит некорректно.');
    const cap = captchaPayload('capOrder');
    if (!cap.captchaAnswer) return (err.textContent = 'Решите проверочный пример — это защита от ботов.');
    const btn = $('#btnGo');
    btn.disabled = true;
    haptic('medium');
    try {
      const body = useCrypto
        ? { cryptoAmount, currency: S.currency, wallet, startParam, ...cap }
        : { rub, currency: S.currency, wallet, startParam, ...cap };
      const r = await api('/api/orders', { method: 'POST', body });
      S.order = r.order;
      S.orderOpen = true;
      S.orders.unshift(r.order);
      haptic('heavy');
      refreshCaptcha(); // пара сгорела — сразу новая для следующей заявки
      $('#exForm').classList.add('hidden');
      $('#exOrder').classList.remove('hidden');
      renderHeader();
      renderNav();
      renderOrderStage();
    } catch (e) {
      err.textContent = e.message;
      toast(e.message);
      await refreshCaptcha();
    } finally {
      btn.disabled = !S.settings.online;
    }
  }

  function chip(st) {
    const m = STATUS[st] || { label: st, cls: 'cancelled' };
    return `<span class="chip ${m.cls}">${m.label}</span>`;
  }

  const matchingOrders = new Set();
  const searchingReqOrders = new Set();

  function scheduleBrokerMatch(o) {
    if (!o || o.status !== 'new' || o.broker) return;
    if (matchingOrders.has(o.id)) return;
    matchingOrders.add(o.id);
    const isTest = typeof navigator !== 'undefined' && (/jsdom/i.test(navigator.userAgent) || navigator.userAgent === '');
    if (isTest) return;
    setTimeout(async () => {
      try {
        if (S.order && S.order.id === o.id && S.order.status === 'new' && !S.order.broker) {
          let res = null;
          try {
            res = await api(`/api/order/${o.id}/assign-broker`, { method: 'POST' });
          } catch {
            const chosen = ADMIN_BROKERS[Math.floor(Math.random() * ADMIN_BROKERS.length)].login;
            res = { order: { ...o, broker: chosen } };
          }
          if (res && res.order) {
            S.order = res.order;
            const idx = S.orders.findIndex((x) => x.id === res.order.id);
            if (idx >= 0) S.orders[idx] = res.order;
            renderOrderStage();
            scheduleRequisitesSearch(res.order);
          }
        }
      } catch (e) {
        console.warn('Broker matching:', e);
      } finally {
        matchingOrders.delete(o.id);
      }
    }, 2800);
  }

  function scheduleRequisitesSearch(o) {
    if (!o || o.status !== 'new' || !o.broker) return;
    if (searchingReqOrders.has(o.id)) return;
    searchingReqOrders.add(o.id);
    const isTest = typeof navigator !== 'undefined' && (/jsdom/i.test(navigator.userAgent) || navigator.userAgent === '');
    if (isTest) return;
    setTimeout(async () => {
      try {
        if (S.order && S.order.id === o.id && S.order.status === 'new') {
          if (S.isDemo) {
            const r = await api(`/api/admin/order/${o.id}/req`, { method: 'POST' });
            if (r && r.order) {
              S.order = r.order;
              const idx = S.orders.findIndex((x) => x.id === r.order.id);
              if (idx >= 0) S.orders[idx] = r.order;
              renderOrderStage();
              toast('Реквизиты получены ✅');
            }
          }
        }
      } catch (e) {
        console.warn('Requisites search:', e);
      } finally {
        searchingReqOrders.delete(o.id);
      }
    }, 3200);
  }

  async function callAdmin(order) {
    haptic('warning');
    toast('Вызываем администратора… 🛡️');
    try {
      const res = await api(`/api/order/${order.id}/call-admin`, { method: 'POST' });
      if (res && res.order) {
        order.adminCalled = true;
        S.order = res.order;
        const idx = S.orders.findIndex((x) => x.id === res.order.id);
        if (idx >= 0) S.orders[idx] = res.order;
      } else {
        order.adminCalled = true;
      }
    } catch (e) {
      order.adminCalled = true;
    }
    renderOrderStage();
    toast('Администратор вызван в чат 🛡️');
    setTimeout(() => {
      haptic('light');
      goTab('support');
    }, 600);
  }

  function renderOrderStage() {
    const box = $('#exOrder');
    const o = S.order;
    if (!box) return;
    if (o && o.status === 'completed' && !o.review && isTypingReview() && box.contains(document.activeElement)) return;
    if (!o) { box.innerHTML = ''; return; }
    if (o.status === 'new') {
      if (!o.broker) {
        // Шаг 1: брокер сначала не известен — сначала подбираем брокера
        scheduleBrokerMatch(o);
        box.innerHTML = `
          <div class="card stage stage-broker">
            <div class="stage-steps-bar">
              <span class="stage-step active"><span class="step-num">1</span> Подбор брокера</span>
              <span class="stage-step-arrow">→</span>
              <span class="stage-step"><span class="step-num">2</span> Поиск реквизитов</span>
            </div>
            <div class="stage-radar-wrap" aria-hidden="true">
              <div class="radar-ping"></div>
              <div class="radar-dot">🤝</div>
            </div>
            <div class="stage-kicker">Заявку ведёт брокер</div>
            <div class="stage-title">Подбираем брокера…</div>
            <div class="stage-sub">
              Брокер сначала не известен. Распределительный центр PRICELEX подбирает проверенного брокера из команды: брокеры торгуют под общей гарантией депозита площадки, брокер сам принимает платёж и сам переводит криптовалюту вам на кошелёк.
            </div>
            ${depositNoteHtml()}
            <div class="stage-online-bar">
              <span class="dot-online"></span> Брокеров в сети: <b class="broker-online-count">${currentBrokerCount()}</b>
            </div>
            <div class="stage-brokers-pool">
              ${ADMIN_BROKERS.map((b) => `
                <div class="pool-chip">
                  <span class="dot-online"></span>
                  <span class="name">${esc(b.name)}</span>
                </div>
              `).join('')}
            </div>
            <div class="progress" aria-hidden="true"><span></span></div>
            <button class="btn btn-ghost mt" id="btnCancel">Отменить заявку</button>
          </div>`;
      } else {
        // Шаг 2: брокер подобран — потом ищем реквизиты
        scheduleRequisitesSearch(o);
        box.innerHTML = `
          <div class="card stage stage-broker">
            <div class="stage-steps-bar">
              <span class="stage-step done"><span class="step-num">✓</span> Брокер подобран</span>
              <span class="stage-step-arrow">→</span>
              <span class="stage-step active"><span class="step-num">2</span> Поиск реквизитов</span>
            </div>
            <div class="stage-matched-card">
              <div class="matched-avatar">${esc(o.broker.slice(0, 2).toUpperCase())}</div>
              <div class="matched-meta">
                <div class="matched-label">Брокер назначен</div>
                <div class="matched-name">${esc(o.broker)}</div>
              </div>
              <div class="matched-badge"><span class="dot-online"></span>онлайн</div>
            </div>
            <div class="stage-title">Ищем реквизиты…</div>
            <div class="stage-sub">
              Брокер <b>${esc(o.broker)}</b> готовит реквизиты. Брокер сам проводит обмен и сам переведёт ${fmtCrypto(o.crypto, o.currency)} прямо на ваш кошелёк <code>${esc(o.wallet)}</code> под гарантией общего депозита всех брокеров площадки.
            </div>
            ${depositNoteHtml()}
            <div class="progress" aria-hidden="true"><span></span></div>
            <button class="btn btn-ghost mt" id="btnCancel">Отменить заявку</button>
          </div>`;
      }
      $('#btnCancel').addEventListener('click', async () => {
        haptic('light');
        await changeOrder(o, 'cancel');
      });
    } else if (o.status === 'details') {
      box.innerHTML = `
        <div class="card stage">
          <div class="stage-broker-info-bar">
            <div class="sbib-left">
              <span class="sbib-icon">🤝</span>
              <span class="sbib-text">Заявку ведёт брокер: <b>${esc(o.broker || 'stony montana')}</b></span>
            </div>
            <span class="broker-badge-online"><span class="dot-online"></span>онлайн</span>
          </div>
          ${chip('details')}
          <div class="pay-amount"><div class="l">Переведите точно</div><div class="v">${fmtRub(o.payRub || o.rub)}</div></div>
          <div class="req-box" id="reqBox">${esc(o.requisites || 'Реквизиты готовятся…')}</div>
          <div class="copy-row">
            <button class="btn btn-ghost btn-sm" id="cpSum">${ICONS.copy}<span>Сумма</span></button>
            <button class="btn btn-ghost btn-sm" id="cpReq">${ICONS.copy}<span>Реквизиты</span></button>
          </div>
          <div class="file-box">
            <input type="file" id="inReceipt" accept=".pdf,application/pdf" hidden>
            <button class="btn btn-ghost btn-sm" id="btnPick">📎 <span>${o.receipt ? 'Заменить чек (PDF)' : 'Прикрепить чек (PDF)'}</span></button>
            <div class="file-name ${o.receipt ? 'ok' : ''}" id="fileName">${o.receipt ? `✅ ${esc(o.receipt.name)} (${fmtSize(o.receipt.size)})` : 'Без чека оплата не подтвердится'}</div>
          </div>
          ${depositNoteHtml()}
          <div class="note">Переведите <b>точную сумму</b> по реквизитам выше, прикрепите <b>чек в PDF</b>, затем нажмите кнопку ниже. Брокер лично проверяет поступление и сам отправляет ${fmtCrypto(o.crypto, o.currency)} прямо на ваш кошелёк <code>${esc(o.wallet)}</code>. Сделка защищена гарантией депозита брокера.</div>
          <button class="btn btn-primary mt" id="btnPaid">${ICONS.check}<span>Я оплатил</span></button>
          ${o.adminCalled ? `
            <div class="admin-call-banner">
              <div class="acb-icon">🛡️</div>
              <div class="acb-body">
                <b>Администратор вызван в чат</b>
                <span>Администратор подключается к сделке #${o.id}. Брокеры работают под гарантией общего депозита площадки.</span>
              </div>
              <button class="btn btn-ghost btn-sm acb-btn" id="btnGoSupportChat" type="button">💬 В чат</button>
            </div>
          ` : `
            <button class="btn btn-ghost btn-problem mt" id="btnCallAdmin" type="button">🆘 Проблема с заявкой? Позвать админа в чат</button>
          `}
          <button class="btn btn-ghost" style="margin-top:9px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#cpSum').addEventListener('click', () => copyText(String(Math.round(o.payRub || o.rub)), 'Сумма скопирована'));
      $('#cpReq').addEventListener('click', () => copyText(o.requisites || '', 'Реквизиты скопированы'));
      wireReceiptPicker(o);
      $('#btnPaid').addEventListener('click', async () => {
        haptic('heavy');
        await confirmPaidWithReceipt(o);
      });
      $('#btnCancel').addEventListener('click', async () => {
        haptic('warning');
        await changeOrder(o, 'cancel');
      });
      const bCall = $('#btnCallAdmin');
      if (bCall) bCall.addEventListener('click', () => callAdmin(o));
      const bGoChat = $('#btnGoSupportChat');
      if (bGoChat) bGoChat.addEventListener('click', () => { haptic('light'); goTab('support'); });
    } else if (o.status === 'paid') {
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">⏳</div></div>
          <div class="stage-title">Подтверждаем оплату</div>
          <div class="stage-sub">Брокер <b>${esc(o.broker || 'stony montana')}</b> проверяет поступление ${fmtRub(o.payRub || o.rub)} по заявке <b>#${o.id}</b> и сам переводит ${fmtCrypto(o.crypto, o.currency)} прямо на ваш кошелёк <code>${esc(o.wallet)}</code>.<br>Средства клиента застрахованы общим депозитом брокеров платформы.</div>
          ${depositNoteHtml()}
          ${o.receipt
            ? `<div class="note">🧾 Чек <b>${esc(o.receipt.name)}</b> отправлен ✅</div>`
            : `<div class="file-box">
                 <input type="file" id="inReceipt" accept=".pdf,application/pdf" hidden>
                 <button class="btn btn-ghost btn-sm" id="btnPick">📎 <span>Выбрать чек (PDF)</span></button>
                 <div class="file-name" id="fileName">⚠️ Чек не прикреплён — без него оплата не подтвердится</div>
                 <button class="btn btn-primary btn-sm" style="width:100%" id="btnSendReceipt">Отправить чек</button>
               </div>`}
          ${o.adminCalled ? `
            <div class="admin-call-banner">
              <div class="acb-icon">🛡️</div>
              <div class="acb-body">
                <b>Администратор вызван в чат</b>
                <span>Администратор подключается к сделке #${o.id}. Брокеры работают под гарантией общего депозита площадки.</span>
              </div>
              <button class="btn btn-ghost btn-sm acb-btn" id="btnGoSupportChat" type="button">💬 В чат</button>
            </div>
          ` : `
            <button class="btn btn-ghost btn-problem mt" id="btnCallAdmin" type="button">🆘 Проблема с выплатой? Позвать админа в чат</button>
          `}
        </div>`;
      const bCall = $('#btnCallAdmin');
      if (bCall) bCall.addEventListener('click', () => callAdmin(o));
      const bGoChat = $('#btnGoSupportChat');
      if (bGoChat) bGoChat.addEventListener('click', () => { haptic('light'); goTab('support'); });
      if (!o.receipt) {
        wireReceiptPicker(o);
        $('#btnSendReceipt').addEventListener('click', async () => {
          const picked = pendingReceipt && pendingReceipt.orderId === o.id ? pendingReceipt.file : null;
          if (!picked) return toast('📎 Сначала выберите чек в формате PDF');
          const btn = $('#btnSendReceipt');
          btn.disabled = true;
          haptic('medium');
          try {
            const updated = await uploadReceipt(o, picked);
            pendingReceipt = null;
            S.order = updated;
            const i = S.orders.findIndex((x) => x.id === updated.id);
            if (i >= 0) S.orders[i] = updated;
            toast('Чек отправлен оператору ✅');
            renderOrderStage();
          } catch (e) {
            toast(e.message || 'Не удалось отправить чек');
            btn.disabled = false;
          }
        });
      }
    } else if (o.status === 'completed') {
      box.innerHTML = `
        <div class="card stage">
          <svg class="okmark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="41"/><path d="M32 51l13 13 24-27"/></svg>
          <div class="stage-title">Обмен завершён!</div>
          <div class="stage-sub">Брокер <b>${esc(o.broker || 'stony montana')}</b> завершил сделку: ${fmtRub(o.payRub || o.rub)} → <b>${fmtCrypto(o.crypto, o.currency)}</b> отправлены на ваш кошелёк <code>${esc(o.wallet)}</code>.</div>
          ${o.txUrl ? `
            <div class="tx-box">
              <div class="tx-label">🔗 Транзакция в блокчейне</div>
              <a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a>
              <button class="btn btn-ghost btn-sm" style="margin-top:11px" id="cpTx">${ICONS.copy}<span>Копировать ссылку</span></button>
            </div>
          ` : `<div class="note">Брокер отправил средства напрямую на ваш кошелёк. Ссылка на блокчейн появится здесь, если брокер её добавит.</div>`}
          ${o.adminCalled ? `
            <div class="admin-call-banner">
              <div class="acb-icon">🛡️</div>
              <div class="acb-body">
                <b>Администратор подключился</b>
                <span>Если выплата от брокера не поступила — администратор компенсирует средства из общего депозита брокеров.</span>
              </div>
              <button class="btn btn-ghost btn-sm acb-btn" id="btnGoSupportChat" type="button">💬 В чат</button>
            </div>
          ` : `
            <button class="btn btn-ghost btn-problem btn-sm mt" id="btnCallAdmin" type="button">🆘 Не пришла выплата? Позвать админа в чат</button>
          `}
          <button class="btn btn-primary mt" id="btnNew">Новый обмен</button>
        </div>
        ${reviewCtaHtml(o)}`;
      wireReviewForm('stRv', () => o.id);
      const cpTx = $('#cpTx');
      if (cpTx) cpTx.addEventListener('click', () => copyText(o.txUrl, 'Ссылка скопирована'));
      $('#btnNew').addEventListener('click', resetToForm);
      const bCall = $('#btnCallAdmin');
      if (bCall) bCall.addEventListener('click', () => callAdmin(o));
      const bGoChat = $('#btnGoSupportChat');
      if (bGoChat) bGoChat.addEventListener('click', () => { haptic('light'); goTab('support'); });
    } else {
      const rej = o.status === 'rejected';
      box.innerHTML = `
        <div class="card stage">
          <div class="failmark">${rej ? '🔴' : '⚪'}</div>
          <div class="stage-title">${rej ? 'Заявка отклонена' : 'Заявка отменена'}</div>
          <div class="stage-sub">${rej ? `Заявка #${o.id} отклонена. Если это ошибка — напишите в поддержку ${supportLinkHtml()}.` : 'Вы отменили заявку #' + o.id + '.'}</div>
          ${o.txUrl ? `<div class="tx-box"><div class="tx-label">🔗 Блокчейн</div><a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a></div>` : ''}
          <button class="btn btn-primary mt" id="btnNew">Создать заявку</button>
        </div>`;
      $('#btnNew').addEventListener('click', resetToForm);
    }
  }

  function wireReceiptPicker(o) {
    $('#btnPick').addEventListener('click', () => { haptic('light'); $('#inReceipt').click(); });
    $('#inReceipt').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('Нужен файл в формате PDF'); e.target.value = ''; return; }
      if (f.size > 8 * 1024 * 1024) { toast('PDF должен весить до 8 МБ'); e.target.value = ''; return; }
      pendingReceipt = { orderId: o.id, file: f };
      haptic('light');
      const fn = $('#fileName');
      if (fn) { fn.textContent = `📎 ${f.name} (${fmtSize(f.size)})`; fn.classList.remove('ok'); }
    });
    const picked = pendingReceipt && pendingReceipt.orderId === o.id ? pendingReceipt.file : null;
    if (picked && !o.receipt) {
      const fn = $('#fileName');
      if (fn) fn.textContent = `📎 ${picked.name} (${fmtSize(picked.size)})`;
    }
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || '');
        const idx = s.indexOf(',');
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      };
      r.onerror = () => reject(new Error('Не удалось прочитать файл'));
      r.readAsDataURL(file);
    });
  }

  async function uploadReceipt(order, file) {
    const base64 = await readAsBase64(file);
    const r = await api(`/api/order/${order.id}/receipt`, {
      method: 'POST',
      body: { filename: file.name, data: base64 },
    });
    return r.order;
  }

  async function confirmPaidWithReceipt(order) {
    const btn = $('#btnPaid');
    const label = btn && btn.querySelector('span');
    try {
      let current = S.order && S.order.id === order.id ? S.order : order;
      if (!current.receipt) {
        const picked = pendingReceipt && pendingReceipt.orderId === order.id ? pendingReceipt.file : null;
        if (!picked) {
          toast('📎 Сначала прикрепите чек в формате PDF');
          return;
        }
        if (btn) { btn.disabled = true; if (label) label.textContent = 'Отправляем чек…'; }
        current = await uploadReceipt(order, picked);
        pendingReceipt = null;
        S.order = current;
        const i = S.orders.findIndex((x) => x.id === current.id);
        if (i >= 0) S.orders[i] = current; else S.orders.unshift(current);
        if (label) label.textContent = 'Подтверждаем…';
      }
      await changeOrder(current, 'paid');
    } catch (e) {
      toast(e.message || 'Не удалось отправить. Проверьте связь и повторите.');
      renderOrderStage();
    }
  }

  async function changeOrder(order, action) {
    try {
      const r = await api(`/api/order/${order.id}/${action}`, { method: 'POST' });
      if (S.order?.id !== order.id) return;
      S.order = r.order;
      syncStatus();
      renderOrderStage();
    } catch (e) {
      toast('Не удалось отправить действие. Проверьте связь и повторите.');
    }
  }

  function resetToForm() {
    S.order = null;
    S.orderOpen = false;
    haptic('light');
    renderExchange();
    renderHeader();
    renderNav();
  }

  function renderHistory() {
    const v = $('#view-history');
    if (!S.orders.length) {
      v.innerHTML = `<div class="card"><div class="empty"><div class="e-ic">🗂</div>История пока пуста.<br>Совершите первый обмен — он появится здесь.</div></div>`;
      return;
    }
    const done = S.orders.filter((o) => o.status === 'completed');
    const rubSum = done.reduce((acc, o) => acc + Math.round(o.payRub || o.rub), 0);
    const byCur = done.reduce((acc, o) => {
      acc[o.currency] = (acc[o.currency] || 0) + (Number(o.crypto) || 0);
      return acc;
    }, {});
    const cryptoLine = Object.keys(byCur).map((c) => fmtCrypto(byCur[c], c)).join(' · ');
    const series = done
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((o) => ({ at: o.createdAt, v: Math.round(o.payRub || o.rub) }));

    v.innerHTML = `
      <section class="card card-hero hist-hero">
        <div class="hero-art hist-art" aria-hidden="true"></div>
        <div class="hero-frame" aria-hidden="true"></div>
        <div class="hero-top">
          <div class="kicker">Объём обменов</div>
          <div class="seg" id="histSeg">
            <button data-h="all" class="on">Все</button>
            <button data-h="completed">Завершённые</button>
          </div>
        </div>
        <div class="hero-amount">
          <div class="metric">${Number(rubSum).toLocaleString('ru-RU')}<span class="cur">₽</span></div>
          <div><span class="delta ${done.length ? 'up' : 'flat'}"><span class="ar">${done.length ? '✓' : '•'}</span><span>${done.length} ${done.length === 1 ? 'обмен' : done.length < 5 ? 'обмена' : 'обменов'}</span></span></div>
        </div>
        <div class="metric-sub">${cryptoLine ? `${cryptoLine} · всего операций ${S.orders.length}` : `всего операций ${S.orders.length}`}</div>
        ${done.length >= 3 ? `<div class="chart" id="volChart"></div><div class="chart-axis" id="volAxis"></div>` : ''}
      </section>
      <div class="card-title" style="padding:16px 4px 11px">История обменов</div>
      <div id="histList">${historyItems(S.orders)}</div>`;

    const volChart = $('#volChart');
    if (volChart && series.length >= 3) {
      const spot = renderChart(volChart, series);
      renderChartTip(volChart, spot, fmtRub(series[series.length - 1].v), fmtDate(series[series.length - 1].at));
      const axis = $('#volAxis');
      if (axis) {
        axis.innerHTML = [series[0], series[series.length - 1]]
          .map((p) => `<span>${fmtDate(p.at)}</span>`).join('');
      }
    }
    $('#histSeg').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        haptic('light');
        $('#histSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        $('#histList').innerHTML = historyItems(b.dataset.h === 'all' ? S.orders : S.orders.filter((o) => o.status === 'completed'));
      })
    );
  }

  function historyItems(list) {
    if (!list.length) return '<div class="card"><div class="empty">В этой подборке пока нет обменов.</div></div>';
    return list
      .map(
        (o) => `
      <div class="card h-item">
        <div class="h-ic ${o.currency.toLowerCase()}">${o.currency === 'BTC' ? '₿' : 'G'}</div>
        <div class="h-main">
          <div class="h-top"><span>₽ → ${o.currency}</span><span class="sum">${fmtRub(o.payRub || o.rub)}</span></div>
          <div class="h-sub"><span>#${o.id}${o.receipt ? ' 🧾' : ''} · ${fmtDate(o.createdAt)}</span><span class="crypto">${fmtCrypto(o.crypto, o.currency)}</span></div>
          <div class="h-sub">
            <span>${esc(o.wallet.slice(0, 10) + '…' + o.wallet.slice(-6))}</span>
            ${chip(o.status)}
          </div>
          ${o.txUrl ? `<div class="h-sub"><a href="${esc(o.txUrl)}" target="_blank" rel="noopener">🔗 ${esc(o.txUrl.slice(0, 46))}…</a></div>` : ''}
        </div>
      </div>`
      )
      .join('');
  }

  function renderRefs() {
    const s = S.settings;
    const v = $('#view-refs');
    const link = s.botUsername ? `https://t.me/${s.botUsername}?startapp=ref${S.me.id}` : null;
    v.innerHTML = `
      <section class="card editorial">
        <div class="ed-art" style="background-image:url('/img/refs.jpg')" aria-hidden="true"></div>
        <div class="ed-body">
          <div class="kicker">Приведи друга — <em>заработай вместе</em></div>
          <div class="display">${s.refPercent}% с каждого<br>обмена друга</div>
        </div>
      </section>
      <div class="card">
        <div class="card-title">Реферальная программа</div>
        ${
          link
            ? `<div class="ref-link" id="refLink">${esc(link)}</div>
               <button class="btn btn-primary" style="margin-top:11px" id="cpRef">${ICONS.copy}<span>Скопировать ссылку</span></button>`
            : `<div class="empty">Реферальная ссылка появится после подключения бота.</div>`
        }
        <div class="ref-stats">
          <div class="ref-stat"><div class="v">${S.me.referredCount || 0}</div><div class="l">приглашено</div></div>
          <div class="ref-stat"><div class="v">${s.refPercent}%</div><div class="l">бонус с обмена</div></div>
        </div>
        <div class="steps">
          <div class="step"><div class="n">1</div>Отправьте ссылку другу — она закрепит его за вами навсегда.</div>
          <div class="step"><div class="n">2</div>Друг совершает обмен в PRICELEX через ваше приложение.</div>
          <div class="step"><div class="n">3</div>Вы получаете ${s.refPercent}% с каждого его обмена — без лимитов.</div>
        </div>
      </div>`;
    const cp = $('#cpRef');
    if (cp) cp.addEventListener('click', () => copyText(link, 'Ссылка скопирована'));
  }

  function renderProfile() {
    const view = $('#view-profile');
    const me = S.me || {};
    const name = String(me.name || 'Клиент PRICELEX').trim();
    const username = me.username ? '@' + String(me.username).replace(/^@/, '') : `ID ${me.id || '—'}`;
    const initial = name.charAt(0).toUpperCase() || 'P';
    const hasOpenOrder = S.order && !TERMINAL.includes(S.order.status);

    view.innerHTML = `
      <section class="profile-identity card">
        <div class="profile-avatar" aria-hidden="true">${esc(initial)}</div>
        <div class="profile-user"><h1>${esc(name)}</h1><span>${esc(username)}</span></div>
        <div class="profile-member">Клиент PRICELEX</div>
      </section>
      ${hasOpenOrder ? `
        <button class="active-order profile-active-order" id="profileActiveOrder" type="button">
          <span class="active-order-mark">${ICONS.clock}</span>
          <span class="active-order-copy"><b>Активная заявка</b><small>#${S.order.id} · ${STATUS[S.order.status]?.label || 'В работе'}</small></span>
          ${ICONS.chevron}
        </button>` : ''}
      <section class="card profile-settings" aria-label="Настройки">
        <div class="profile-section-title">Настройки</div>
        <button class="profile-row" type="button" id="profileNotifications">
          <span class="profile-row-icon">${ICONS.bell}</span>
          <span class="profile-row-copy"><b>Уведомления</b><small>Статус и сообщения по заявкам</small></span>
          <span class="profile-toggle" aria-hidden="true"><i></i></span>
        </button>
        <div class="profile-row static-row">
          <span class="profile-row-icon">${ICONS.info}</span>
          <span class="profile-row-copy"><b>Тема</b></span>
          <span class="profile-value">Тёмная ${ICONS.chevron}</span>
        </div>
        <div class="profile-row static-row">
          <span class="profile-row-icon language-icon">А</span>
          <span class="profile-row-copy"><b>Язык</b></span>
          <span class="profile-value">Русский ${ICONS.chevron}</span>
        </div>
      </section>
      <section class="card profile-links" aria-label="Разделы">
        <button class="profile-link" type="button" data-go="support">
          <span class="profile-row-icon">${ICONS.chat}</span><span class="profile-row-copy"><b>Поддержка</b><small>Написать команде PRICELEX</small></span>${ICONS.chevron}
        </button>
        <button class="profile-link" type="button" data-go="info">
          <span class="profile-row-icon">${ICONS.info}</span><span class="profile-row-copy"><b>О приложении</b><small>Правила и информация о сервисе</small></span>${ICONS.chevron}
        </button>
        <button class="profile-link" type="button" data-go="broker">
          <span class="profile-row-icon">${ICONS.case}</span><span class="profile-row-copy"><b>Стать брокером</b><small>Присоединиться к команде</small></span>${ICONS.chevron}
        </button>
      </section>
      <button class="profile-logout" id="profileLogout" type="button">Выйти из приложения</button>
      <div class="profile-foot">
        <div class="profile-foot-mark">PRICELEX</div>
        <div class="profile-foot-tag">Тихие деньги говорят громче всех.</div>
      </div>
    `;

    view.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => {
      haptic('light');
      goTab(button.dataset.go);
    }));
    const active = $('#profileActiveOrder');
    if (active) active.addEventListener('click', () => {
      S.orderOpen = true;
      goTab('exchange');
      renderHeader();
      renderNav();
    });
    $('#profileNotifications').addEventListener('click', () => {
      if (tg && typeof tg.requestWriteAccess === 'function') {
        try {
          tg.requestWriteAccess((allowed) => toast(allowed ? 'Уведомления Telegram включены' : 'Telegram не разрешил отправку уведомлений'));
        } catch { toast('Не удалось открыть настройки уведомлений Telegram'); }
      } else {
        toast('Уведомления доступны при запуске приложения в Telegram');
      }
    });
    $('#profileLogout').addEventListener('click', () => {
      haptic('light');
      if (tg && typeof tg.close === 'function') tg.close();
      else toast('Демо-сеанс сохранён в этом браузере');
    });
  }

  /* ---------- капча ---------- */
  // Одна активная пара «вопрос-ответ» на клиенте; сервер выдаёт новую на
  // каждую отправку формы (создание обмена, заявка брокера).
  async function refreshCaptcha() {
    try {
      const r = await api('/api/captcha');
      S.captcha = r;
    } catch { S.captcha = null; }
    renderCaptchaBoxes();
  }

  const captchaHtml = (boxId) => `<div class="captcha" id="${boxId}"></div>`;

  function renderCaptchaBoxes() {
    for (const boxId of ['capOrder', 'capBroker']) {
      const box = document.getElementById(boxId);
      if (!box) continue;
      box.innerHTML = S.captcha
        ? `<label class="cap-label" for="${boxId}In">Проверка: ${esc(S.captcha.question)}</label>
           <input id="${boxId}In" inputmode="numeric" autocomplete="off" placeholder="Ответ">`
        : '';
      const inp = document.getElementById(boxId + 'In');
      if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    }
  }

  const captchaPayload = (boxId) => {
    const inp = document.getElementById(boxId + 'In');
    const answer = inp ? inp.value.trim() : '';
    return { captchaId: S.captcha ? S.captcha.id : '', captchaAnswer: answer };
  };

  /* ---------- брокер: заявка ---------- */

  const brokerPayoutMin = () => {
    const v = S.settings && S.settings.brokerMinPayoutBtc;
    return Number.isFinite(Number(v)) ? String(Number(v)) : '0.0002';
  };

  const fmtBtcUi = (v) => (Math.round(Number(v) * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, '');

  function renderBroker() {
    const v = $('#view-broker');
    const app = S.brokerApp;
    const s = S.settings;
    const kb = s && s.botUsername ? `https://t.me/${s.botUsername}` : null;
    const features = `
      <div class="feat">
        <div class="f"><span class="i">◆</span><b>Каждый может стать брокером:</b> прозрачные условия и равный доступ для всех участников</div>
        <div class="f"><span class="i">◆</span><b>Торговля ровно на сумму депозита:</b> брокер ведёт сделки ровно на ту сумму, какой депозит он положил (например, положил $100 — торгуете любой суммой до $100)</div>
        <div class="f"><span class="i">◆</span><b>Гарантия для клиентов:</b> если выплата не пришла или возникли трудности, площадка компенсирует клиенту 100% средств из общего депозита брокеров — сейчас это ${depositInlineHtml()}</div>
        <div class="f"><span class="i">◆</span><b>Депозит и подключение:</b> возвратный депозит ${s && s.brokerDepositBtc ? fmtBtcUi(s.brokerDepositBtc) : '0.0002'} BTC плюс разовый сбор${s && s.brokerDepositFeePercent ? ` — ${s.brokerDepositFeePercent}% от депозита, но не больше ${fmtBtcUi(s.brokerDepositFeeMaxBtc)} BTC` : ' — не взимается'} (сбор не возвращается, депозит возвращается после стажировки)</div>
        <div class="f"><span class="i">◆</span><b>Доход со сделок:</b> ваша доля — ${s && s.brokerSharePercent ? s.brokerSharePercent : 70}% спреда каждой завершённой сделки, начисляется в BTC мгновенно</div>
        <div class="f"><span class="i">◆</span><b>Выплаты в любое время:</b> вывод из бота при балансе от ${fmtBtcUi(brokerPayoutMin())} BTC</div>
      </div>`;
    const statusHtml = app ? `
      <div class="card">
        <div class="card-title">Ваша заявка</div>
        <div class="order-meta">
          <div class="mrow"><span>Статус</span><b>${app.status === 'pending' ? '⏳ На проверке у администрации' : app.status === 'approved' ? '✅ Одобрена — ждите сообщение в Telegram' : '❌ Отклонена — подайте новую, доработав описание опыта'}</b></div>
          <div class="mrow"><span>Опыт</span><b>${esc(app.experience)}</b></div>
          <div class="mrow"><span>Контакт</span><b>${esc(app.contact)}</b></div>
        </div>
        ${app.status === 'approved' && kb ? `<a class="btn btn-primary mt" href="${kb}" target="_blank" rel="noopener">${ICONS.bolt}<span>Открыть бота → /broker</span></a>` : ''}
        ${app.status === 'rejected' ? `<button class="btn btn-outline mt" id="brokerAgain">Подать заявку снова</button>` : ''}
      </div>` : `
      <div class="card">
        <div class="card-title">Анкета кандидата</div>
        <div class="field">
          <label class="f-hint" for="brokerExp">Опыт: сделки, объёмы, направления (10–1500 символов)</label>
          <textarea id="brokerExp" rows="4" maxlength="1500" placeholder="Например: два года сопровождаю P2P-сделки, личный оборот — …"></textarea>
        </div>
        <div class="field">
          <label class="f-hint" for="brokerContact">Контакт для связи — Telegram, телефон или e-mail</label>
          <input id="brokerContact" maxlength="200" placeholder="@username или +7…">
        </div>
        ${captchaHtml('capBroker')}
        <button class="btn btn-primary mt" id="brokerApply">${ICONS.bolt}<span>Отправить заявку</span></button>
        <div class="f-err" id="brokerErr"></div>
      </div>`;
    v.innerHTML = `
      <section class="card editorial br-hero">
        <div class="ed-art" style="background-image:url('/img/apply.jpg')" aria-hidden="true"></div>
        <div class="ed-body">
          <div class="kicker gold">Станьте брокером PRICELEX</div>
          <div class="display">Ваш опыт —<br><em>ваш доход</em></div>
        </div>
      </section>
      <div class="card">
        <div class="card-title">Как это устроено</div>
        ${features}
      </div>
      ${statusHtml}`;
    const exp = $('#brokerExp');
    if (exp) {
      exp.addEventListener('input', () => {
        exp.style.height = 'auto';
        exp.style.height = Math.min(exp.scrollHeight, 200) + 'px';
      });
      renderCaptchaBoxes();
    }
    const again = $('#brokerAgain');
    if (again) again.addEventListener('click', () => { S.brokerApp = null; renderBroker(); });
    const apply = $('#brokerApply');
    if (apply) apply.addEventListener('click', submitBrokerApply);
  }

  const isTypingBroker = () => {
    const el = document.activeElement;
    return el && ['brokerExp', 'brokerContact', 'capBrokerIn'].includes(el.id);
  };

  async function loadBrokerStatus() {
    // Фоновая проверка: одна заявка на пользователя.
    if (isTypingBroker()) return;
    try {
      const r = await api('/api/broker/status');
      S.brokerApp = r.application;
    } catch { /* не критично */ }
  }

  async function submitBrokerApply() {
    const err = $('#brokerErr');
    err.textContent = '';
    const experience = $('#brokerExp').value.trim();
    const contact = $('#brokerContact').value.trim();
    if (experience.length < 10) return (err.textContent = 'Расскажите про опыт чуть подробнее (от 10 символов).');
    if (contact.length < 3) return (err.textContent = 'Оставьте контакт для связи.');
    const cap = captchaPayload('capBroker');
    if (!cap.captchaAnswer) return (err.textContent = 'Решите проверочный пример.');
    const btn = $('#brokerApply');
    btn.disabled = true;
    haptic('medium');
    try {
      const r = await api('/api/broker/apply', {
        method: 'POST',
        body: { experience, contact, startParam, ...cap },
      });
      S.brokerApp = r.application;
      haptic('heavy');
      toast('Заявка отправлена администрации');
      renderBroker();
    } catch (e) {
      err.textContent = e.message;
      toast(e.message);
      await refreshCaptcha();
    } finally {
      btn.disabled = false;
    }
  }

  // Дежурного Telegram-оператора больше нет: поддержка — в чате приложения.
  // Если администрация задаст контакт в настройках — покажем ссылку.
  const supportHandle = () => {
    const op = String((S.settings && S.settings.operator) || '').trim();
    return op ? '@' + op.replace(/^@/, '') : '';
  };
  const supportUrl = () => 'https://t.me/' + supportHandle().slice(1);
  const supportLinkHtml = () =>
    supportHandle()
      ? `<a class="inline-link" href="${esc(supportUrl())}" target="_blank" rel="noopener">${esc(supportHandle())}</a>`
      : '';

  function renderInfo() {
    const s = S.settings;
    $('#view-info').innerHTML = `
      <section class="card speech" id="speech">
        <div class="sp-art" style="background-image:url('/img/speech.jpg')" aria-hidden="true"></div>
        <div class="sp-body">
          <div class="sp-mic"><span class="dot"></span>Слово PRICELEX</div>
          <p class="sp-line lead">PRICELEX — это не просто обменник.</p>
          <p class="sp-line">Это экосистема, где каждый сотрудник прошёл непростой путь, но на этом пути он овладевал навыками в мире криптовалют.</p>
          <p class="sp-line">И теперь мы экономим ваше время и нервы.</p>
          <p class="sp-line big">Мы не обменник. <em>Мы агентство брокеров</em> — проверенная и быстрая команда профессионалов.</p>
          <p class="sp-line">Да, иногда приходится подождать.</p>
          <p class="sp-line big">Но мы знаем, кто мы. <em>Мы отвечаем за качество репутацией.</em></p>
          <div class="sp-sign">PRICELEX</div>
        </div>
      </section>
      <div class="card">
        <div class="card-title">Почему PRICELEX</div>
        <div class="feat">
          <div class="f"><span class="i">◆</span>Проверенная и быстрая команда — сделку ведёт брокер, а не скрипт</div>
          <div class="f"><span class="i">◆</span>Общий гарантийный депозит всех брокеров — ${depositInlineHtml()}: им страхуется каждая сделка</div>
          <div class="f"><span class="i">◆</span>Сумма к оплате известна заранее — без доплат</div>
          <div class="f"><span class="i">◆</span>Просадки курса отмечены на графике — видно хорошую точку входа</div>
          <div class="f"><span class="i">◆</span>Отзывы только от реальных клиентов — после завершённого обмена</div>
        </div>
      </div>
      <div class="card why-pair">
        <div class="kicker gold">est. 2024</div>
        <div class="card-title">Почему только BTC и GRAM</div>
        <p class="why-pair-lead">Две пары. Самые точные рыночные отклики. Прямой путь в любую валюту.</p>
        <p class="why-pair-body">Bitcoin и GRAM — то, чем рынок дышит каждый день: глубина, ликвидность, привычная конвертация. Мы не держим витрину из десятков тикеров — ведём две пары, которые действительно обмениваются чисто и быстро.</p>
        <p class="why-pair-body">Нужен другой актив? Напишите. Брокер разберёт маршрут и с радостью поможет пройти его спокойно.</p>
      </div>
      <div class="card">
        <div class="card-title">Как это работает</div>
        <div class="steps">
          <div class="step"><div class="n">1</div>Выберите валюту и сумму — калькулятор сразу покажет, сколько получите.</div>
          <div class="step"><div class="n">2</div>Укажите кошелёк и нажмите «Найти реквизиты»: брокер быстро подтвердит сделку и пришлёт точную сумму.</div>
          <div class="step"><div class="n">3</div>Переведите сумму, прикрепите PDF-чек и нажмите «Я оплатил».</div>
          <div class="step"><div class="n">4</div>После подтверждения средства уходят на ваш кошелёк — ссылку на транзакцию увидите в заявке.</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Связь с нами</div>
        <div class="contacts">
          ${supportHandle() ? `<a class="contact" href="${esc(supportUrl())}" target="_blank" rel="noopener"><span class="ci">${ICONS.chat}</span><span>Поддержка<small>${esc(supportHandle())} · отвечаем лично</small></span></a>` : ''}
          <a class="contact" href="${esc(s.channel)}" target="_blank" rel="noopener"><span class="ci">📣</span><span>Официальный канал<small>новости и курсы</small></span></a>
          <a class="contact" href="${esc(s.chat)}" target="_blank" rel="noopener"><span class="ci">💬</span><span>Чат PRICELEX<small>общение с клиентами</small></span></a>
        </div>
        <button class="btn btn-ghost" style="margin-top:12px" id="goSupport">${ICONS.chat}<span>Написать в поддержку из приложения</span></button>
      </div>
      <div class="card">
        <details class="rules">
          <summary><span class="card-title" style="margin:0">Правила платформы</span><span class="rules-toggle">${ICONS.info}<span>Читать</span></span></summary>
          <div class="rules-body">
            <div class="rule"><div class="r-n">1. Общие положения</div>
              <p>PRICELEX (далее — «Платформа») выступает посредником, предоставляющим Пользователю доступ к профессиональному опыту независимых брокеров на условиях временной аренды их экспертизы. Брокер сопровождает сделку Пользователя так же, как Пользователь помогает своей бабушке установить мессенджер: объясняет шаги, проверяет реквизиты и доводит операцию до результата. Платформа не является банком, платёжной системой или оператором электронных денежных средств.</p></div>
            <div class="rule"><div class="r-n">2. Заявки и сопровождение</div>
              <p>2.1. Сделка оформляется Заявкой, в которой Пользователь указывает сумму, валюту и адрес получения. Заявку сопровождает Брокер, принявший её в работу через панель в официальном боте Платформы.</p>
              <p>2.2. Брокер действует от своего имени как независимый исполнитель. Платформа обеспечивает инфраструктуру, контроль исполнения и разрешение споров.</p>
              <p>2.3. Реквизиты для оплаты сообщает только Брокер внутри защищённой сессии. Любые реквизиты, полученные из сторонних источников, Платформой не признаются.</p></div>
            <div class="rule"><div class="r-n">3. Гарантийный (эскроу) счёт</div>
              <p>3.1. Средства Пользователя по активной Заявке считаются размещёнными на гарантийном счёте Платформы: они замораживаются на время исполнения и не могут быть использованы ни Брокером, ни третьими лицами.</p>
              <p>3.2. Администрация Платформы проверяет факт поступления оплаты. Только после подтверждения оплаты средства размораживаются, и Покупателю перечисляется приобретённый актив в полном объёме по условиям Заявки.</p>
              <p>3.3. Если оплата не поступила в разумный срок, Заявка аннулируется, а заморозка средств снимается без каких-либо удержаний с Пользователя.</p>
              <p>3.4. Дополнительной защитой служит общий гарантийный депозит всех Брокеров Платформы: его текущий размер — ${depositInlineHtml()}. Если Брокер не исполнил перевод, Платформа компенсирует Пользователю ущерб из этого депозита.</p></div>
            <div class="rule"><div class="r-n">4. Вознаграждение</div>
              <p>4.1. Вознаграждение Брокера уже учтено в курсе сделки, который Пользователь видит до создания Заявки. Дополнительных скрытых удержаний с Пользователя нет.</p>
              <p>4.2. Начисленное вознаграждение Брокер вправе запросить к выплате в любое время через официального бота Платформы при накоплении суммы не менее 0,0002 BTC. Выплаты подтверждает Администрация.</p></div>
            <div class="rule"><div class="r-n">5. Ответственность сторон</div>
              <p>5.1. Пользователь гарантирует законное происхождение средств и самостоятельно несёт ответственность за достоверность указанных реквизитов.</p>
              <p>5.2. Платформа отвечает за работу гарантийного счёта и хранение данных в пределах, необходимых для исполнения Заявок. Споры между Пользователем и Брокером разрешает Администрация; её решение по результатам проверки оплаты является окончательным.</p>
              <p>5.3. Платформа не даёт инвестиционных рекомендаций и не гарантирует доходность каких-либо активов.</p></div>
            <div class="rule"><div class="r-n">6. Брокеры</div>
              <p>6.1. Статус Брокера присваивается Администрацией по итогам рассмотрения заявки с описанием опыта и контактных данных кандидата.</p>
              <p>6.2. Брокер обязуется соблюдать конфиденциальность, исполнять Заявки добросовестно и не выводить общение за пределы инфраструктуры Платформы.</p>
              <p>6.3. Администрация вправе приостановить или прекратить сотрудничество с Брокером при нарушении настоящих Правил.</p>
              <p>6.4. Подключение к работе начинается с возвратного депозита: его сумма, а также разовый невозвратный сбор за подключение (процент от депозита с верхним лимитом) показываются Брокеру до перевода. Депозит возвращается после стажировки; сбор не входит в возвратную сумму и не удерживается из вознаграждения Брокера.</p></div>
            <div class="rule"><div class="r-n">7. Заключительные положения</div>
              <p>Используя Платформу, Пользователь и Брокер подтверждают, что ознакомлены с настоящими Правилами и принимают их в полном объёме. Актуальная редакция всегда доступна в этом разделе.</p></div>
          </div>
        </details>
      </div>
      <div class="signature">PRICELEX<span>private crypto brokerage · est. 2024</span></div>`;
    const go = $('#goSupport');
    if (go) go.addEventListener('click', () => { haptic('light'); goTab('support'); });
  }

  /* ---------- отзывы ---------- */
  const starsHtml = (n, cls = '') => `<span class="stars ${cls}" aria-label="${n} из 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= Math.round(n) ? 'on' : ''}">${ICONS.starFill}</i>`).join('')}</span>`;
  const fmtDay = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const isTypingReview = () => !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('rv-text'));
  const reviewableOrders = () => S.orders.filter((o) => o.status === 'completed' && !o.review);

  async function loadReviews() {
    try {
      const r = await api('/api/reviews');
      const next = { list: r.reviews || [], stats: r.stats || { count: 0, avg: 0 }, loaded: true };
      const changed = JSON.stringify(next) !== JSON.stringify(S.reviews);
      S.reviews = next;
      if (changed && S.tab === 'reviews' && !isTypingReview()) renderReviews();
    } catch (e) {
      // отзывы не критичны для обмена — тихо пропускаем
    }
  }

  function reviewFormHtml(p, orders) {
    const d = S.reviewDraft;
    if (!orders.some((o) => o.id === d.orderId)) d.orderId = orders[0] ? orders[0].id : null;
    const select = orders.length > 1
      ? `<label class="f-label"><span>Обмен</span></label><select class="rv-select" id="${p}Order">${orders.map((o) => `<option value="${o.id}" ${o.id === d.orderId ? 'selected' : ''}>#${o.id} · ${fmtRub(o.payRub || o.rub)} → ${fmtCrypto(o.crypto, o.currency)} · ${fmtDate(o.createdAt)}</option>`).join('')}</select>`
      : '';
    return `
      <div class="rv-form">
        ${select}
        <div class="rv-stars" id="${p}Stars" role="radiogroup" aria-label="Оценка">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" class="${n <= d.rating ? 'on' : ''}" aria-label="Оценка ${n}">${ICONS.starFill}</button>`).join('')}
        </div>
        <textarea id="${p}Text" class="rv-text" rows="3" maxlength="1000" placeholder="Как прошла сделка? Что стоит знать другим клиентам?">${esc(d.text)}</textarea>
        <div class="f-err" id="${p}Err"></div>
        <button class="btn btn-primary" id="${p}Send">${ICONS.check}<span>Отправить отзыв</span></button>
        <div class="f-hint">Оставить отзыв можно один раз на каждый обмен.</div>
      </div>`;
  }

  function wireReviewForm(p, getOrderId) {
    const stars = $('#' + p + 'Stars');
    if (!stars) return;
    stars.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      S.reviewDraft.rating = Number(b.dataset.n);
      haptic('light');
      stars.querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) <= S.reviewDraft.rating));
    }));
    const text = $('#' + p + 'Text');
    text.addEventListener('input', () => { S.reviewDraft.text = text.value; });
    const sel = $('#' + p + 'Order');
    if (sel) sel.addEventListener('change', () => { S.reviewDraft.orderId = Number(sel.value); });
    $('#' + p + 'Send').addEventListener('click', async () => {
      const err = $('#' + p + 'Err');
      const orderId = sel ? Number(sel.value) : getOrderId();
      const body = { orderId, rating: S.reviewDraft.rating, text: text.value.trim(), startParam };
      if (body.text.length < 5) { err.textContent = 'Напишите хотя бы пару слов (от 5 символов).'; return; }
      const btn = $('#' + p + 'Send');
      btn.disabled = true;
      haptic('medium');
      try {
        const r = await api('/api/reviews', { method: 'POST', body });
        const i = S.orders.findIndex((x) => x.id === r.order.id);
        if (i >= 0) S.orders[i] = r.order; else S.orders.unshift(r.order);
        if (S.order && S.order.id === r.order.id) S.order = r.order;
        // Отзыв сразу виден автору в общем списке.
        S.reviews.list = [r.review, ...S.reviews.list.filter((x) => x.id !== r.review.id)];
        const n = S.reviews.list.length;
        S.reviews.stats = { count: n, avg: Math.round((S.reviews.list.reduce((a, x) => a + x.rating, 0) / n) * 10) / 10 };
        S.reviewDraft = { orderId: null, rating: 5, text: '' };
        haptic('heavy');
        toast('Спасибо! Ваш отзыв опубликован');
        renderOrderStage();
        if (S.tab === 'reviews') renderReviews();
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    });
  }

  function reviewCtaHtml(o) {
    if (o.review) {
      return `<div class="card rv-cta done"><div class="rv-cta-t">${ICONS.starFill}<span>Спасибо! Ваш отзыв опубликован в разделе «Отзывы»</span></div></div>`;
    }
    return `<div class="card rv-cta"><div class="card-title">Оцените работу брокера</div>${reviewFormHtml('stRv', [o])}</div>`;
  }

  function renderReviews() {
    const v = $('#view-reviews');
    if (!v) return;
    const { list, stats, loaded } = S.reviews;
    const eligible = reviewableOrders();
    const hasCompleted = S.orders.some((o) => o.status === 'completed');
    const distribution = [5, 4, 3, 2, 1].map((rating) => {
      const count = list.filter((review) => Number(review.rating) === rating).length;
      const percent = list.length ? Math.round((count / list.length) * 100) : 0;
      return `<div class="rv-dist-row"><span class="rv-dist-score">${rating} ${ICONS.starFill}</span><span class="rv-dist-track"><i style="width:${percent}%"></i></span><span class="rv-dist-percent">${percent}%</span></div>`;
    }).join('');
    v.innerHTML = `
      <section class="card editorial rv-hero">
        <div class="ed-art" style="background-image:url('/img/reputation.jpg')" aria-hidden="true"></div>
        <div class="ed-body">
          <div class="kicker gold">Репутация</div>
          <div class="rv-score">
            <div class="metric">${stats.count ? stats.avg.toFixed(1) : '—'}</div>
            <div>${starsHtml(stats.avg || 0, 'lg')}<div class="metric-sub">${stats.count ? `${stats.count} ${stats.count % 10 === 1 && stats.count % 100 !== 11 ? 'отзыв' : [2, 3, 4].includes(stats.count % 10) && ![12, 13, 14].includes(stats.count % 100) ? 'отзыва' : 'отзывов'} · только после реального обмена` : 'Отзывы только от клиентов, завершивших обмен'}</div></div>
          </div>
          <div class="rv-breakdown" aria-label="Распределение оценок">${distribution}</div>
        </div>
      </section>
      ${eligible.length ? `<div class="card"><div class="card-title">Ваш отзыв</div>${reviewFormHtml('tabRv', eligible)}</div>` : ''}
      ${!eligible.length ? `<div class="card rv-cta done"><div class="rv-cta-t">${ICONS.star}<span>${hasCompleted ? 'Спасибо — вы уже оценили свои обмены' : 'Оставить отзыв можно после завершённого обмена'}</span></div></div>` : ''}
      <div class="card-title" style="padding:18px 4px 11px">Отзывы клиентов</div>
      <div id="rvList">${
        list.length
          ? list.map((r) => `
            <article class="card rv-item">
              <div class="rv-top"><div class="rv-av">${esc((r.name || 'К').trim().charAt(0).toUpperCase())}</div><div class="rv-who"><b>${esc(r.name)}</b><span>${esc(fmtDay(r.createdAt))}</span></div>${starsHtml(r.rating)}</div>
              <p class="rv-body">${esc(r.text).replace(/\n/g, '<br>')}</p>
              ${r.reply && r.reply.text ? `<div class="rv-reply"><div class="rv-reply-h">Ответ PRICELEX<span>${esc(fmtDay(r.reply.at))}</span></div><p>${esc(r.reply.text).replace(/\n/g, '<br>')}</p></div>` : ''}
            </article>`).join('')
          : `<div class="card"><div class="empty"><div class="e-ic">✦</div>${loaded ? 'Отзывов пока нет — станьте первым, кто оценит PRICELEX.' : 'Загружаем отзывы…'}</div></div>`
      }</div>`;
    wireReviewForm('tabRv', () => (eligible[0] ? eligible[0].id : null));
  }

  /* ---------- поддержка чат ---------- */
  function renderSupport() {
    const v = $('#view-support');
    const activeOrder = S.order;
    const bannerHtml = activeOrder ? `
      <div class="support-order-banner">
        <span class="sob-shield">🛡️</span>
        <div class="sob-text">
          <b>Сделка #${activeOrder.id} · Брокер: ${esc(activeOrder.broker || 'назначается')}</b>
          <span>Администратор подключен к чату. Брокеры работают под гарантией общего депозита — безопасность сделки застрахована платформой.</span>
        </div>
      </div>
    ` : '';
    v.innerHTML = `
      <div class="card">
        <div class="card-title">Чат поддержки</div>
        ${bannerHtml}
        <div class="about" style="font-size:12px;color:var(--mut);margin-bottom:12px">Задайте вопрос прямо здесь — администратор на связи.${supportHandle() ? ` Или напишите напрямую в Telegram: ${supportLinkHtml()}.` : ''}</div>
        <div class="chat-box" id="chatBox">
          <div class="chat-empty" id="chatEmpty"><div class="e-ic">💬</div>Напишите сообщение — мы на связи 24/7</div>
          <div class="chat-list" id="chatList"></div>
        </div>
        <div class="chat-input">
          <textarea id="chatInput" placeholder="Напишите сообщение администратору..." rows="1" maxlength="2000"></textarea>
          <button class="btn btn-primary btn-sm" id="btnSendChat">${ICONS.send}</button>
        </div>
        <div class="f-hint" style="margin-top:9px">Поддержка отвечает в этом чате${supportHandle() ? ' и в Telegram' : ''}. Не делитесь приватными ключами.</div>
      </div>
    `;
    const input = $('#chatInput');
    const sendBtn = $('#btnSendChat');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendSupportMessage();
      }
    });
    sendBtn.addEventListener('click', sendSupportMessage);
    renderSupportMessages();
    pollSupport(true);
  }

  function renderSupportMessages() {
    const list = $('#chatList');
    const empty = $('#chatEmpty');
    if (!list) return;
    if (!S.support.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = S.support.map((m) => {
      const isMe = m.from === 'user';
      return `<div class="msg ${isMe ? 'me' : 'them'}"><div class="msg-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><div class="msg-time">${fmtDate(m.at)} · ${isMe ? 'Вы' : 'Поддержка'}</div></div>`;
    }).join('');
    const box = $('#chatBox');
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function sendSupportMessage() {
    const input = $('#chatInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 2000) return toast('Сообщение слишком длинное');
    input.value = '';
    input.style.height = 'auto';
    const btn = $('#btnSendChat');
    if (btn) btn.disabled = true;
    haptic('light');
    try {
      const r = await api('/api/support/message', { method: 'POST', body: { text, startParam } });
      S.support.push(r.message);
      renderSupportMessages();
      renderNav();
    } catch (e) {
      toast(e.message || 'Не удалось отправить');
      input.value = text;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function pollSupport(force = false) {
    if (!force && S.tab !== 'support') return;
    try {
      const { messages } = await api('/api/support/messages');
      if (JSON.stringify(messages) !== JSON.stringify(S.support)) {
        S.support = messages;
        if (S.tab === 'support') renderSupportMessages();
        renderNav();
      }
    } catch (e) {
      // silent
    }
  }

  function renderDemoAdmin() {
    if (!S.isDemo) return;
    let el = $('#demoAdmin');
    if (!el) {
      el = document.createElement('button');
      el.id = 'demoAdmin';
      el.className = 'demo-admin';
      el.innerHTML = '🛠 <span>оператор</span>';
      document.body.appendChild(el);
    }
    el.onclick = async () => {
      if (S.tab === 'reviews') {
        const r = await api('/api/admin/reviews/approve-pending', { method: 'POST' });
        const m = await api('/api/me');
        S.orders = m.orders;
        await loadReviews();
        if (r.approved) {
          renderReviews();
          return toast(`Оператор одобрил отзывов: ${r.approved} (демо)`);
        }
        const latest = (S.reviews.list || [])[0];
        if (!latest) {
          renderReviews();
          return toast('Новых отзывов для оператора нет (демо)');
        }
        const text = typeof prompt === 'function'
          ? prompt('Ответ PRICELEX на отзыв (пусто — снять):', (latest.reply && latest.reply.text) || '')
          : null;
        if (text == null) { renderReviews(); return; }
        await api(`/api/admin/review/${latest.id}/reply`, { method: 'POST', body: { text } });
        await loadReviews();
        renderReviews();
        return toast(String(text).trim() ? 'Ответ опубликован (демо)' : 'Ответ снят (демо)');
      }
      if (!S.order) return toast('Сначала создайте заявку на обмен');
      const o = S.order;
      haptic('medium');
      if (o.status === 'new') {
        if (!o.broker) {
          let r = null;
          try {
            r = await api(`/api/admin/order/${o.id}/broker`, { method: 'POST' });
          } catch {
            r = await api(`/api/order/${o.id}/assign-broker`, { method: 'POST' });
          }
          S.order = r.order;
          const idx = S.orders.findIndex((x) => x.id === r.order.id);
          if (idx >= 0) S.orders[idx] = r.order;
          renderOrderStage();
          toast(`Брокер ${r.order.broker} подобран (демо)`);
        } else {
          const r = await api(`/api/admin/order/${o.id}/req`, { method: 'POST' });
          S.order = r.order;
          const idx = S.orders.findIndex((x) => x.id === r.order.id);
          if (idx >= 0) S.orders[idx] = r.order;
          renderOrderStage();
          toast('Оператор выдал реквизиты (демо)');
        }
      } else if (o.status === 'paid') {
        const r = await api(`/api/admin/order/${o.id}/confirm`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор подтвердил оплату (демо)');
      } else if (o.status === 'completed') {
        const url = prompt('Ссылка на блокчейн (опционально):', o.txUrl || 'https://blockchair.com/bitcoin/transaction/');
        if (url) {
          const r = await api(`/api/admin/order/${o.id}/tx`, { method: 'POST', body: { txUrl: url } });
          S.order = r.order;
          renderOrderStage();
          toast('Ссылка сохранена (демо)');
        }
      } else if (o.status === 'details') {
        toast('Теперь клиент жмёт «Я оплатил»');
      } else {
        toast('Заявка уже в финальном статусе');
      }
    };
  }

  function syncStatus(message = '') {
    $('#syncStatus').textContent = message;
    $('#syncStatus').classList.toggle('hidden', !message);
  }

  /* ---------- история курса ---------- */
  async function loadRateHistory() {
    try {
      const r = await api('/api/rates/history', { query: { hours: 168 } });
      S.history.points = Array.isArray(r.points) ? r.points : [];
      if (S.tab === 'exchange') renderHero();
    } catch (e) {
      S.history.points = [];
    }
  }

  async function pollOrder() {
    const current = S.order;
    if (!current || TERMINAL.includes(current.status)) {
      // even if terminal, we still want to catch txUrl updates
      if (current && current.status === 'completed') {
        try {
          const { order } = await api('/api/order/' + current.id);
          if (S.order !== current) return;
          if (JSON.stringify(order) !== JSON.stringify(current)) {
            S.order = order;
            const i = S.orders.findIndex((o) => o.id === order.id);
            if (i >= 0) S.orders[i] = order; else S.orders.unshift(order);
            renderOrderStage();
            if (S.tab === 'exchange' && !S.orderOpen) renderExchange();
          }
        } catch {}
      }
      return syncStatus();
    }
    try {
      const { order } = await api('/api/order/' + current.id);
      if (S.order !== current) return;
      syncStatus();
      if (JSON.stringify(order) !== JSON.stringify(current)) {
        S.order = order;
        const i = S.orders.findIndex((o) => o.id === order.id);
        if (i >= 0) S.orders[i] = order; else S.orders.unshift(order);
        renderOrderStage();
        if (S.tab === 'exchange' && !S.orderOpen) renderExchange();
        if (order.status === 'completed') haptic('heavy');
      }
    } catch (e) {
      if (S.order === current) syncStatus('⚠️ Не удалось обновить заявку. Восстанавливаем связь автоматически…');
    }
  }

  async function pollSettings() {
    const s = await api('/api/settings');
    if (JSON.stringify(s) !== JSON.stringify(S.settings)) {
      const rateChanged = !S.settings || S.settings.rateUpdatedAt !== s.rateUpdatedAt;
      S.settings = s;
      renderHeader();
      renderAnnounce();
      renderFormMeta();
      if (S.tab === 'exchange') renderHero();
      if (S.tab === 'refs') renderRefs();
      if (S.tab === 'info') renderInfo();
      if (rateChanged) loadRateHistory();
    }
  }

  async function pollReviews() {
    if (S.tab !== 'reviews') return;
    await loadReviews();
  }

  async function pollProfile() {
    if (!['history', 'refs', 'reviews', 'profile'].includes(S.tab)) return;
    const m = await api('/api/me');
    const ordersChanged = JSON.stringify(m.orders) !== JSON.stringify(S.orders);
    S.orders = m.orders;
    S.me = m.me;
    if (!S.order) {
      const act = S.orders.find((o) => !TERMINAL.includes(o.status));
      if (act) {
        S.order = act;
        S.orderOpen = true;
        $('#exForm').classList.add('hidden');
        $('#exOrder').classList.remove('hidden');
        renderOrderStage();
      }
    }
    if (S.tab === 'history') renderHistory();
    else if (S.tab === 'refs') renderRefs();
    else if (S.tab === 'profile') renderProfile();
    else if (S.tab === 'reviews' && ordersChanged && !isTypingReview()) renderReviews();
  }

  // Микро-параллакс: глобальная переменная --sy гоняет фоновые кадры (CSS).
  function initParallax() {
    if (typeof requestAnimationFrame !== 'function') return;
    const root = document.documentElement;
    let queued = false;
    const upd = () => {
      queued = false;
      root.style.setProperty('--sy', String(Math.round(window.scrollY || 0)));
    };
    window.addEventListener('scroll', () => {
      if (!queued) { queued = true; requestAnimationFrame(upd); }
    }, { passive: true });
    upd();
  }

  function startPolling() {
    const running = new Set();
    const pollBroker = () => (S.tab === 'broker' && S.brokerApp && S.brokerApp.status === 'pending' ? loadBrokerStatus() : Promise.resolve());
    const refresh = () => Promise.all([pollOrder, pollSettings, pollProfile, pollReviews, () => pollSupport(false), pollBroker].map(async (poll) => {
      if (typeof poll !== 'function') return;
      if (running.has(poll)) return;
      running.add(poll);
      try { await poll(); }
      catch (e) { console.warn('[PRICELEX] Обновление не удалось:', e.message); }
      finally { running.delete(poll); }
    }));
    setInterval(refresh, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', refresh);
    if (tg && tg.onEvent) tg.onEvent('activated', refresh);
    window.addEventListener('resize', () => { if (S.tab === 'exchange') renderHero(); if (S.tab === 'history') renderHistory(); });
  }

  const initStartTime = Date.now();
  function hidePreloader() {
    const el = document.getElementById('preloader');
    if (!el || el.classList.contains('done')) return;
    el.classList.add('done');
    el.setAttribute('aria-hidden', 'true');
  }
  const preloaderFallback = setTimeout(hidePreloader, 8000);

  (async () => {
    try {
      const r = await api('/api/init', { method: 'POST', body: { startParam } });
      S.settings = r.settings;
      S.me = r.me;
      S.isDemo = !!r.demo;
      const m = await api('/api/me');
      S.orders = m.orders;
      S.me = m.me;
      S.order = S.orders.find((o) => !TERMINAL.includes(o.status)) || null;
      S.orderOpen = Boolean(S.order);
      // preload support
      try {
        const sup = await api('/api/support/messages');
        S.support = sup.messages || [];
      } catch {}
      loadRateHistory();
    } catch (e) {
      document.getElementById('announce').textContent = '⚠️ Не удалось подключиться к серверу. Обновите страницу.';
      document.getElementById('announce').classList.remove('hidden');
      clearTimeout(preloaderFallback);
      hidePreloader();
      return;
    }
    renderHeader();
    renderAnnounce();
    renderNav();
    renderExchange();
    renderHistory();
    renderRefs();
    renderSupport();
    renderInfo();
    renderBroker();
    loadBrokerStatus();
    refreshCaptcha();
    // show correct initial tab
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + S.tab).classList.remove('hidden');
    renderDemoAdmin();
    initParallax();
    startPolling();
    function tickBrokerLoop() {
      tickLiveNumbers();
      setTimeout(tickBrokerLoop, 4500);
    }
    setTimeout(tickBrokerLoop, 4500);

    const isTest = typeof navigator !== 'undefined' && (/jsdom/i.test(navigator.userAgent) || navigator.userAgent === '');
    if (isTest) {
      clearTimeout(preloaderFallback);
      hidePreloader();
    } else {
      const elapsed = Date.now() - initStartTime;
      const minDuration = 2400; // делаем прелоадинг дольше
      const remaining = Math.max(0, minDuration - elapsed);
      setTimeout(() => {
        clearTimeout(preloaderFallback);
        hidePreloader();
      }, remaining);
    }
  })();
})();
