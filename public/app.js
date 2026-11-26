/* PRICELEX — Web App for USD gift cards → BTC. */
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
      tg.setHeaderColor && tg.setHeaderColor('#07141c');
      tg.setBackgroundColor && tg.setBackgroundColor('#07141c');
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

  /* ---------- прелоадер: брендовый экран загрузки ---------- */
  // Держим экран с логотипом минимум PRELOAD_MIN_MS, затем мягко скрываем.
  const PRELOAD_MIN_MS = 6000;
  const bootTs = Date.now();
  let preloaderDone = false;
  function hidePreloader() {
    const el = document.getElementById('preloader');
    if (!el || preloaderDone) return;
    preloaderDone = true;
    const wait = Math.max(0, PRELOAD_MIN_MS - (Date.now() - bootTs));
    setTimeout(() => {
      el.classList.add('done');
      setTimeout(() => el.remove(), 800);
    }, wait);
  }
  // Страховка: даже если инициализация зависла, экран не остаётся навсегда.
  setTimeout(hidePreloader, 13000);

  const $ = (s) => document.querySelector(s);
  const TERMINAL = ['completed', 'rejected', 'cancelled'];
  // dir — выбранное направление (ключ из /api/settings → rates[]).
  // screen — на каком под-экране обмена мы находимся: «picker» (выбор активов) или «form» (форма обмена).
  // sheet — какая шторка открыта (crypto | gift) или null.
  const S = { settings: null, me: null, orders: [], order: null, tab: 'exchange', dir: 'GOOGLE_USD', isDemo: false, support: [], screen: 'picker', sheet: null, giftRules: false, giftRuleKey: null, adminOpen: false, admin: null };

  // Резервный реестр направлений: нужен, если сервер старой версии не прислал rates.
  const giftFallback = (key, label, symbol, coin) => ({
    key, direction: 'sell', currency: key, network: null, kind: 'gift', payoutCurrency: 'BTC', payoutDecimals: 8,
    label, symbol, coin, decimals: 0, display: 0, unit: 'USD', step: 10, minUnits: 10,
    walletHint: 'Адрес Bitcoin-кошелька (bc1… / 1… / 3…)',
    walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    walletError: 'Проверьте адрес Bitcoin-кошелька — он выглядит некорректно.',
    infoNote: 'Принимаются только подарочные карты США в USD ($).', currencyNote: 'Нужна карта региона США в USD ($).',
    rate: null, enabled: true,
  });
  const FALLBACK_DIRS = [

    giftFallback('GOOGLE_USD', 'Google Gift Card', '🎁', 'google'),
    giftFallback('ITUNES_USD', 'iTunes Gift Card', '🎵', 'itunes'),
    giftFallback('XBOX_USD', 'Xbox Gift Card', '🎮', 'xbox'),
    giftFallback('APPLE_STORE_USD', 'Apple Store Gift Card', '🍎', 'apple'),
  ];

  // Only USD gift cards are enabled as sell → BTC directions.
  function dirs() {
    const s = S.settings;
    if (!s) return [];
    if (Array.isArray(s.rates) && s.rates.length) return s.rates;
    return FALLBACK_DIRS;
  }
  const isGiftDir = (d) => !!d && (d.kind === 'gift' || d.direction === 'sell');
  // A card direction is shown only when its BTC payout rate is available.
  const eligible = (d) => d.enabled !== false && (isGiftDir(d) ? Number(d.rate) > 0 : true);
  const available = () => dirs().filter(eligible);
  // Gift cards are sold for BTC; there is no fiat payment flow.
  const sellDirs = () => available().filter(isGiftDir);
  const currentSellDir = () => sellDirs()[0] || dirs().find(isGiftDir) || FALLBACK_DIRS.find(isGiftDir);

  // Сколько BTC даём за карту номиналом units $; курс в BTC за $1 приходит с сервера.
  function giftPayout(units, product = null) {
    const dir = product || (isGiftDir(currentDir()) ? currentDir() : currentSellDir());
    const giftRate = Number(dir && dir.rate) || 0;
    if (!(giftRate > 0)) return null;
    return floorTo((Number(units) || 0) * giftRate, 8);
  }
  function giftWalletValid(address, product = null) {
    const dir = product || (isGiftDir(currentDir()) ? currentDir() : currentSellDir());
    const pattern = dir && dir.walletPattern;
    return !!pattern && new RegExp(pattern).test(String(address || '').trim());
  }
  function currentDir() {
    const all = dirs();
    return all.find((d) => d.key === S.dir) || available()[0] || all[0] || FALLBACK_DIRS[0];
  }
  // При смене настроек оператором выбранное направление могло исчезнуть — берём доступное.
  function selectDir(key) {
    const all = dirs();
    const want = all.find((d) => d.key === key);
    const dir = want && eligible(want) ? want : available()[0] || want || all[0];
    S.dir = dir ? dir.key : key;
    return S.dir;
  }
  // Точность хранения/округления (USDT — 6, BTC/LTC — 8).
  function decimalsOf(dir) {
    return Number.isFinite(Number(dir.decimals)) ? Number(dir.decimals) : 8;
  }
  // Точность для показа клиенту (USDT — 2 знака, BTC/LTC — 8).
  function displayOf(dir) {
    const d = dir.display;
    return Number.isFinite(Number(d)) && d !== null && d !== undefined ? Number(d) : decimalsOf(dir);
  }
  function giftDirOfOrder(o) {
    const currency = String(o && o.currency || '').toUpperCase();
    return dirs().find((d) => isGiftDir(d) && d.currency === currency) ||
      FALLBACK_DIRS.find((d) => isGiftDir(d) && d.currency === currency) ||
      dirs().find(isGiftDir) || FALLBACK_DIRS.find(isGiftDir);
  }
  const giftLabelOf = (o) => giftDirOfOrder(o)?.label || o.currencyLabel || 'Gift Card';
  function dirLabel(o) {
    const d = dirs().find((x) => x.currency === o.currency && (x.network || null) === (o.network || null));
    if (d) return d.label;
    if (isGiftOrder(o)) return giftLabelOf(o);
    return o.currencyLabel || [o.currency, o.network].filter(Boolean).join(' ');
  }
  const floorTo = (v, dec) => Math.floor(Number(v) * 10 ** dec + 1e-6) / 10 ** dec;
  // Параметры направления по заявке (в заявке хранятся currency + network).
  function dirOfOrder(o) {
    const d = dirs().find((x) => x.currency === o.currency && (x.network || null) === (o.network || null));
    if (d) return d;
    // Старые заявки могут хранить network TRC20/ERC20; продукт определяем по currency.
    if (isGiftOrder(o)) return giftDirOfOrder(o);
    return FALLBACK_DIRS.find((x) => x.currency === o.currency && (x.network || null) === (o.network || null)) || { coin: String(o.currency || '').toLowerCase(), symbol: o.currency === 'BTC' ? '₿' : o.currency === 'LTC' ? 'Ł' : '₮', decimals: 8, display: o.currency === 'USDT' ? 2 : 8 };
  }
  const currenciesDecimals = (o) => displayOf(dirOfOrder(o));
  const giftCurrencyOf = (o) => o.payoutCurrency || (o.network ? 'USDT' : 'BTC');
  const giftPayoutText = (o) => {
    const currency = giftCurrencyOf(o);
    const suffix = currency === 'USDT' && o.network ? ` (${o.network})` : '';
    return `${fmtCrypto(o.crypto, currency, currency === 'USDT' ? 2 : 8)}${suffix}`;
  };
  // Сумма к выплате для показа клиенту.
  const cryptoOf = (o) => (isGiftOrder(o)
    ? giftPayoutText(o)
    : fmtCrypto(o.crypto, o.currency, currenciesDecimals(o)));

  const STATUS = {
    new: { label: 'Подбор реквизитов', color: '#ffb648' },
    quote: { label: 'Согласование суммы', color: '#38bdf8' },
    details: { label: 'Ожидает оплаты', color: '#38bdf8' },
    paid: { label: 'Подтверждение', color: '#ffb648' },
    completed: { label: 'Завершён', color: '#22e5a2' },
    rejected: { label: 'Отклонён', color: '#ff5470' },
    cancelled: { label: 'Отменён', color: '#8aa0b8' },
  };

  const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
  // dec — точность из направления (USDT — 2 знака, BTC/LTC — 8); без неё точность по величине.
  const fmtCrypto = (v, cur, dec) => {
    const n = Number(v) || 0;
    const d = Number.isFinite(Number(dec)) && dec !== null ? Number(dec) : n >= 1000 ? 2 : n >= 1 ? 4 : 6;
    const fixed = n.toFixed(d);
    const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
    return (trimmed || '0') + ' ' + cur;
  };
  const fmtDate = (ts) => {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
    return (n / 1024 / 1024).toFixed(1) + ' МБ';
  };
  let pendingReceipt = null;
  const haptic = (t) => { try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(t || 'light'); } catch (e) {} };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copyText(t, msg) {
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
    haptic('light');
    toast(msg || 'Скопировано');
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

  // Официальный знак Google «G» — логотип подарочных карт вместо эмодзи.
  const GIFT_ICON =
    '<svg viewBox="0 0 48 48" style="width:66%;height:66%;display:block" role="img" aria-label="Google Gift Card">' +
    '<path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v9h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.16z"/>' +
    '<path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.34l-7.11-5.52c-1.97 1.32-4.5 2.1-7.45 2.1-5.73 0-10.59-3.87-12.32-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>' +
    '<path fill="#FBBC05" d="M11.68 28.17A13.9 13.9 0 0 1 10.96 24c0-1.45.25-2.86.69-4.17v-5.7H4.34A23 23 0 0 0 2 24c0 3.72.9 7.24 2.48 10.4l7.2-6.23z"/>' +
    '<path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 30.08 2 24 2 15.4 2 7.96 6.93 4.34 12.12l7.34 5.7c1.73-5.2 6.59-9.07 12.32-9.07z"/>' +
    '</svg>';
  // Брендовые SVG: iTunes, Xbox и Apple адаптированы из Font Awesome Free Brands 7.3.1
  // (Fonticons, Inc., CC BY 4.0; https://fontawesome.com/license/free), с currentColor для темы PRICELEX.
  const brandMark = (label, viewBox, path) =>
    `<svg viewBox="${viewBox}" style="width:66%;height:66%;display:block" role="img" aria-label="${label}" focusable="false"><path fill="currentColor" d="${path}"/></svg>`;
  const BRAND_MARKS = {
    google: GIFT_ICON,
    itunes: brandMark('iTunes Gift Card', '0 0 448 512', 'M223.6 80.3a171.3 171.3 0 1 0 .2 342.5 171.3 171.3 0 1 0 -.2-342.5zm79.4 240c-3.2 13.6-13.5 21.2-27.3 23.8-12.1 2.2-22.2 2.8-31.9-5-11.8-10-12-26.4-1.4-36.8 8.4-8 20.3-9.6 38-12.8 3-.5 5.6-1.2 7.7-3.7 3.2-3.6 2.2-2 2.2-80.8 0-5.6-2.7-7.1-8.4-6.1-4 .7-91.9 17.1-91.9 17.1-5 1.1-6.7 2.6-6.7 8.3 0 116.1 .5 110.8-1.2 118.5-2.1 9-7.6 15.8-14.9 19.6-8.3 4.6-23.4 6.6-31.4 5.2-21.4-4-28.9-28.7-14.4-42.9 8.4-8 20.3-9.6 38-12.8 3-.5 5.6-1.2 7.7-3.7 5-5.7 .9-127 2.6-133.7 .4-2.6 1.5-4.8 3.5-6.4 2.1-1.7 5.8-2.7 6.7-2.7 101-19 113.3-21.4 115.1-21.4 5.7-.4 9 3 9 8.7-.1 170.6 .4 161.4-1 167.6zM345.2 32L102.8 32C45.9 32 0 77.9 0 134.8L0 377.2C0 434.1 45.9 480 102.8 480l242.4 0c57 0 102.8-45.9 102.8-102.8l0-242.4C448 77.9 402.1 32 345.2 32zM223.6 59a192.5 192.5 0 1 1 0 385 192.5 192.5 0 1 1 0-385z'),
    xbox: brandMark('Xbox Gift Card', '0 0 512 512', 'M369.9 318.2c44.3 54.3 64.7 98.8 54.4 118.7-7.9 15.1-56.7 44.6-92.6 55.9-29.6 9.3-68.4 13.3-100.4 10.2-38.2-3.7-76.9-17.4-110.1-39-27.9-18.2-34.2-25.7-34.2-40.6 0-29.9 32.9-82.3 89.2-142.1 32-33.9 76.5-73.7 81.4-72.6 9.4 2.1 84.3 75.1 112.3 109.5zM188.6 143.8c-29.7-26.9-58.1-53.9-86.4-63.4-15.2-5.1-16.3-4.8-28.7 8.1-29.2 30.4-53.5 79.7-60.3 122.4-5.4 34.2-6.1 43.8-4.2 60.5 5.6 50.5 17.3 85.4 40.5 120.9 9.5 14.6 12.1 17.3 9.3 9.9-4.2-11-.3-37.5 9.5-64 14.3-39 53.9-112.9 120.3-194.4zm311.6 63.5c-16.9-80-67.5-130.3-74.6-130.3-7.3 0-24.2 6.5-36 13.9-23.3 14.5-41 31.4-64.3 52.8 42.4 53.3 102.2 139.4 122.9 202.3 6.8 20.7 9.7 41.1 7.4 52.3-1.7 8.5-1.7 8.5 1.4 4.6 6.1-7.7 19.9-31.3 25.4-43.5 7.4-16.2 15-40.2 18.6-58.7 4.3-22.5 3.9-70.8-.8-93.4zM141.3 43c47.7-2.5 109.7 34.5 114.3 35.4 .7 .1 10.4-4.2 21.6-9.7 63.9-31.1 94-25.8 107.4-25.2-63.9-39.3-152.7-50-233.9-11.7-23.4 11.1-24 11.9-9.4 11.2z'),
    apple: brandMark('Apple Store Gift Card', '0 0 384 512', 'M319.1 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7-55.8 .9-115.1 44.5-115.1 133.2 0 26.2 4.8 53.3 14.4 81.2 12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM262.5 104.5c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z'),
  };
  // Use the official brand marks in all card pickers, forms, admin controls and order history.
  const coinInner = (d) => BRAND_MARKS[d?.coin] || esc(d?.symbol || '');
  const ICONS = {
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 15.2c2.6.3 4.4 1.8 5 4.8"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7.6" width="18" height="12.4" rx="2.6"/><path d="M9.2 7.6V6.1A2.1 2.1 0 0 1 11.3 4h1.4a2.1 2.1 0 0 1 2.1 2.1v1.5"/><path d="M3 13.2h18"/><path d="M12 12v2.6"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.6" width="18" height="12.8" rx="4.1"/><path d="M8.4 17.4v3.9c0 .7.8 1.1 1.3.6l3.9-4.1"/><circle cx="8.6" cy="11" r="1.05" fill="currentColor" stroke="none"/><circle cx="12" cy="11" r="1.05" fill="currentColor" stroke="none"/><circle cx="15.4" cy="11" r="1.05" fill="currentColor" stroke="none"/></svg>',
    down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="m6 14 6 6 6-6"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
    bolt: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>',
    left: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    chevDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  };

  function renderHeader() {
    const s = S.settings;
    let html = s.online
      ? '<span class="pill"><span class="dot"></span>ОНЛАЙН</span>'
      : '<span class="pill off"><span class="dot"></span>ОФФЛАЙН</span>';
    if (S.isDemo) html += ' <span class="pill demo">ДЕМО</span>';
    $('#hdrStatus').innerHTML = html;
  }

  function renderAnnounce() {
    const el = $('#announce');
    const t = S.settings && S.settings.announcement;
    el.classList.toggle('hidden', !t);
    el.textContent = t || '';
  }

  function renderNav() {
    const items = [
      ['exchange', 'Обмен', ICONS.swap],
      ['history', 'История', ICONS.clock],
      ['refs', 'Рефералы', ICONS.users],
      ['support', 'Чат', ICONS.chat],
      ['profile', 'Профиль', ICONS.user],
    ];
    $('#nav').innerHTML = items
      .map(([id, l, ic]) => `<button data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${ic}<span>${l}</span>${id==='support' && S.support.length ? `<span class="badge">${S.support.length>99?'99+':S.support.length}</span>` : ''}</button>`)
      .join('');
    $('#nav').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        if (S.tab === b.dataset.tab) return;
        S.tab = b.dataset.tab;
        haptic('light');
        document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
        $('#view-' + S.tab).classList.remove('hidden');
        renderNav();
        if (S.tab === 'history') renderHistory();
        if (S.tab === 'refs') renderRefs();
        if (S.tab === 'profile') renderProfile();
        if (S.tab === 'support') renderSupport();
        syncTgBack();
      })
    );
  }

  // ---------- Выбор актива: экран «Выбор активов для обмена» + нижние шторки ----------
  // Обмен открывается на экране выбора активов (криптовалюта / подарочные карты).
  // Сам выбор актива — всегда через нижнюю шторку: и для криптовалюты, и для подарочных карт.
  // Для всех поддерживаемых карт используются общие правила: США, USD, $10 и кратно $10.
  let sheetCloseTimer = null;
  let sheetFrames = [];
  let rulesCloseTimer = null;
  let rulesFrames = [];
  // Показываем все направления, даже выключенные: их рисуем полупрозрачными,
  // чтобы клиент видел, что обмен бывает, — но не мог выбрать.
  function sheetRowsFor(kind) {
    return dirs().filter((d) => (kind === 'gift' ? isGiftDir(d) : !isGiftDir(d)));
  }
  function renderAssetSheet(kind) {
    const rows = sheetRowsFor(kind);
    const cur = currentDir();
    const $title = $('#sheetTitle');
    if ($title) $title.textContent = 'Подарочные карты';
    const list = $('#sheetList');
    if (!list) return;
    list.innerHTML = rows.length
      ? rows
          .map((d) => {
            const off = !eligible(d);
            const on = d.key === cur.key && !off;
            const sub = off
              ? 'Временно недоступно'
              : kind === 'gift'
                ? `1 $ = ${fmtCrypto(d.rate, 'BTC', 8)} · выплата в BTC`
                : 'Подарочная карта в USD'
            return `<button class="sheet-row${on ? ' on' : ''}${off ? ' off' : ''}" data-key="${esc(d.key)}" role="option" aria-selected="${on ? 'true' : 'false'}"${off ? ' aria-disabled="true"' : ''}>
              <span class="coin-ic ${esc(d.coin)}">${coinInner(d)}</span>
              <span class="sheet-row-text"><b>${esc(d.label)}</b><i>${esc(sub)}</i></span>
              <span class="sheet-check">${ICONS.check}</span>
            </button>`;
          })
          .join('')
      : '<div class="sheet-empty">Сейчас нет доступных направлений</div>';
    const foot = $('#sheetFoot');
    if (foot) {
      foot.textContent = kind === 'gift' ? 'Принимаются карты США в USD · выплата в BTC' : '';
      foot.classList.toggle('hidden', !foot.textContent);
    }
    list.querySelectorAll('.sheet-row').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.classList.contains('off')) {
          haptic('error');
          toast('Направление временно недоступно');
          return;
        }
        pickAsset(b.dataset.key);
      })
    );
  }
  function openAssetSheet(kind) {
    S.sheet = kind;
    if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = null; }
    renderAssetSheet(kind);
    const sheet = $('#assetSheet');
    if (!sheet) return;
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
    // Двойной rAF — чтобы шторка появилась в DOM до запуска слайд-анимации.
    // Кадры отменяем при закрытии, чтобы «открыть и сразу закрыть» не оставляло шторку в подвисшем состоянии.
    sheetFrames = [requestAnimationFrame(() => { sheetFrames[1] = requestAnimationFrame(() => sheet.classList.add('open')); })];
    document.body.classList.add('sheet-lock');
    syncTgBack();
  }
  function closeAssetSheet() {
    S.sheet = null;
    document.body.classList.remove('sheet-lock');
    sheetFrames.forEach((f) => { try { cancelAnimationFrame(f); } catch (e) {} });
    sheetFrames = [];
    const sheet = $('#assetSheet');
    if (!sheet || sheet.classList.contains('hidden')) { syncTgBack(); return; }
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    if (sheetCloseTimer) clearTimeout(sheetCloseTimer);
    sheetCloseTimer = setTimeout(() => sheet.classList.add('hidden'), 320);
    syncTgBack();
  }
  function setScreen(name) {
    S.screen = name;
    const picker = $('#assetPicker');
    const form = $('#assetForm');
    if (picker) picker.classList.toggle('hidden', name !== 'picker');
    if (form) form.classList.toggle('hidden', name !== 'form');
    syncTgBack();
  }
  const goToAssetPicker = () => setScreen('picker');
  function syncAssetChip() {
    const dir = currentDir();
    const ic = $('#chipIc');
    if (ic) { ic.className = 'coin-ic ' + dir.coin; ic.innerHTML = coinInner(dir); }
    const lb = $('#chipLabel');
    if (lb) lb.textContent = dir.label;
  }
  // Курсы/доступность могли измениться, пока форма открыта: выключенные группы не прячем —
  // подсвечиваем полупрозрачными (как и направления внутри шторки), чтобы было видно, что обмен бывает.
  function syncPickerAvailability() {
    const cryptoEmpty = true;
    const giftEmpty = sellDirs().length === 0;
    const tradingOff = !S.settings.online;
    const c = document.querySelector('[data-group="crypto"]');
    if (c) c.classList.toggle('off', tradingOff || cryptoEmpty);
    const g = document.querySelector('[data-group="gift"]');
    if (g) g.classList.toggle('off', tradingOff || giftEmpty);
    const empty = $('#pickerEmpty');
    if (empty) empty.classList.toggle('hidden', !(cryptoEmpty && giftEmpty));
    if (S.sheet) renderAssetSheet(S.sheet);
    syncAssetChip();
  }
  function pickAsset(key) {
    const want = dirs().find((d) => d.key === key);
    if (!want) return;
    if (!eligible(want)) {
      haptic('error');
      toast('Направление временно недоступно');
      return;
    }
    S.dir = want.key;
    haptic('medium');
    closeAssetSheet();
    setScreen('form');
    const w = $('#inWallet');
    if (w) w.placeholder = want.walletHint;
    syncAssetChip();
    renderFormMeta();
  }
  // Системная кнопка «назад» в Telegram: закрывает шторку, иначе возвращает к выбору активов.
  function syncTgBack() {
    try {
      if (!tg || !tg.BackButton) return;
      const need = S.tab === 'exchange' && !S.order && (S.screen === 'form' || !!S.sheet || !!S.giftRules || !!S.adminOpen);
      if (need) tg.BackButton.show(); else tg.BackButton.hide();
    } catch (e) { /* не-Telegram окружение */ }
  }
  function onTgBackButton() {
    if (S.adminOpen) { closeAdminSheet(); return; }
    if (S.giftRules) { giftRulesClose(); return; }
    if (S.sheet) { closeAssetSheet(); return; }
    if (S.tab === 'exchange' && S.screen === 'form') goToAssetPicker();
  }

  function renderExchange() {
    const dir = currentDir();
    const sell = currentSellDir();
    const giftOn = sellDirs().length > 0;
    const cryptoOn = false;
    const step = Number(sell && sell.step) || 10;
    const minUnits = Number(sell && sell.minUnits) || step;
    $('#view-exchange').innerHTML = `
      <div id="exForm" class="${S.order ? 'hidden' : ''}">
        <div id="assetPicker" role="region" aria-label="Выбор подарочной карты">
          <section class="exchange-hero">
            <div class="hero-copy">
              <div class="hero-kicker"><i></i> PRIVATE GIFT CARD BROKERAGE</div>
              <h1>Обменивайте<br>подарочные карты<br><span>на Bitcoin</span></h1>
              <p>Приватный обмен цифровых подарочных карт. Укажите номинал — увидите расчёт выплаты в BTC до создания заявки.</p>
              <button class="hero-cta" id="heroStart">Начать обмен <span aria-hidden="true">→</span></button>
              <div class="hero-footnote"><span>Курс BTC/USD</span><b>·</b><span>Личное сопровождение</span></div>
            </div>
            <div class="hero-visual" aria-hidden="true">
              <div class="hero-aura"></div>
              <div class="hero-orbit orbit-one"></div>
              <div class="hero-orbit orbit-two"></div>
              <div class="hero-orbit orbit-three"></div>
              <div class="hero-core"><span>₿</span></div>
              ${[['APPLE_STORE_USD','token-apple'],['XBOX_USD','token-xbox'],['GOOGLE_USD','token-google'],['ITUNES_USD','token-itunes']].map(([key, placement]) => { const d = dirs().find((x) => x.key === key); return d ? `<div class="hero-token ${placement}"><span class="coin-ic ${esc(d.coin)}">${coinInner(d)}</span></div>` : ''; }).join('')}
            </div>
          </section>
          <div class="supported-head" id="supportedCards">
            <div><span class="section-overline">НАПРАВЛЕНИЯ</span><h2>Поддерживаемые карты</h2></div>
            <span class="supported-region">США · USD</span>
          </div>
          <div class="supported-grid">
            ${dirs().filter(isGiftDir).map((d) => `
              <button class="supported-card${eligible(d) && S.settings.online ? '' : ' off'}" data-key="${esc(d.key)}" ${eligible(d) && S.settings.online ? '' : 'disabled aria-disabled="true"'}>
                <span class="supported-icon coin-ic ${esc(d.coin)}">${coinInner(d)}</span>
                <b>${esc(d.label)}</b>
                <small>USD · от $${Number(d.minUnits) || 10}</small>
                <span class="supported-arrow" aria-hidden="true">↗</span>
              </button>`).join('')}
          </div>
          <div class="picker-empty${cryptoOn || giftOn ? ' hidden' : ''}" id="pickerEmpty">Направления временно недоступны.<br>Загляните чуть позже.</div>
          <div class="trust-row">
            <div class="trust-intro">Преимущества<br><b>PRICELEX</b></div>
            <div class="trust-item"><span class="trust-icon">↗</span><b>Чёткий расчёт</b><small>Сумма выплаты видна до заявки</small></div>
            <div class="trust-item"><span class="trust-icon">◇</span><b>Личный подход</b><small>Оператор сопровождает обмен</small></div>
            <div class="trust-item"><span class="trust-icon">₿</span><b>Выплата в Bitcoin</b><small>На указанный вами кошелёк</small></div>
          </div>
          <div class="telegram-cta"><span><b>Начать обмен прямо сейчас</b><small>Выберите карту и номинал</small></span><span class="telegram-cta-mark">↗</span></div>
          <div class="gain-note" role="note">
            <div class="gain-note-title"><span class="gain-note-ic" aria-hidden="true">🎁</span> Почему принимать оплату подарочными картами выгодно</div>
            <div class="gain-item"><span class="gain-num">1</span><p><b>Быстро и прозрачно.</b> Мы быстро и с прозрачным расчётом обменяем ваши карты на биткоин.</p></div>
            <div class="gain-item"><span class="gain-num">2</span><p><b>Без блокировок и цифрового следа.</b> Исключение блокировок счетов, минимизация цифрового следа. Моментальный вывод на ваш биткоин-кошелёк.</p></div>
          </div>
        </div>
        <div id="assetForm" class="hidden">
          <div class="form-topbar">
            <button class="back-btn" id="btnBackToAssets">${ICONS.left}<span>Выбор активов</span></button>
            <button class="asset-chip" id="assetChip" aria-label="Сменить актив">
              <span class="coin-ic ${esc(dir.coin)}" id="chipIc">${coinInner(dir)}</span>
              <span class="asset-chip-label" id="chipLabel">${esc(dir.label)}</span>
              ${ICONS.chevDown}
            </button>
          </div>
          <div class="trade-layout">
            <aside class="trade-steps" aria-label="Этапы обмена">
              <div class="trade-step active"><i>01</i><span>Выберите карту</span></div>
              <div class="trade-step"><i>02</i><span>Укажите данные и получите курс</span></div>
              <div class="trade-step"><i>03</i><span>Получите Bitcoin</span></div>
            </aside>
            <div class="trade-main">
        <div id="giftForm" class="hidden">
          <div class="card">
            <div class="card-title" id="giftTitle">${esc(sell.label)}</div>
            <div class="f-label"><span>Номинал карты</span><span id="giftRule"></span></div>
            <div class="seg gift-nom" id="segNom"></div>
            <div class="f-box" style="margin-top:10px"><div class="coin-ic ${esc(sell.coin)}" id="giftCardIcon">${coinInner(sell)}</div><input id="inUnits" type="number" inputmode="numeric" placeholder="10" min="${minUnits}" step="${step}" value="10"></div>
            <div class="f-hint">Введите номинал карты: от $${minUnits}, кратно $${step}</div>
            <div class="f-sep"><div class="arr">${ICONS.down}</div></div>
            <div class="f-label"><span>Вы получаете</span><span id="giftLimits"></span></div>
            <div class="f-box"><div class="coin-ic btc">₿</div><input id="outBtc" type="text" readonly placeholder="—"></div>
            <div class="f-meta" id="giftMeta"></div>
            <div class="info-note" style="margin-top:10px">⏱ На сделку даётся <b>1 час</b>: создайте заявку → <b>дождитесь подключения оператора</b> → отправьте код <b>только после его команды</b> — оператор проверит карту и выплатит BTC.</div>
          </div>
          <div class="card">
            <div class="card-title">Где взять карту</div>
            <div class="info-note" id="giftInfo">Карту можно купить на любом маркетплейсе — Яндекс Маркет, Ozon, Wildberries и т. д. Нужна карта региона <b>США</b> с номиналом в <b>USD</b>; карты других регионов и валют не принимаются.</div>
            <div class="info-warn">⚠️ Проверьте регион карты: США, валюта номинала — <b>USD ($)</b>.</div>
            <div class="info-note" style="margin-top:10px">🛡 <b>Минимальный цифровой след</b><br>Карту можно купить за <b>наличные</b> — она не привязана к вашему банковскому счёту и паспорту. Мы не запрашиваем документы и регистрацию: только код карты и Bitcoin-адрес. Выплата идёт прямо на ваш кошелёк — без банков, бирж и посредников. Меньше точек, где фиксируются ваши данные, — меньше цифрового следа.</div>
          </div>
          <div class="card">
            <div class="card-title">Bitcoin-кошелёк для выплаты BTC</div>
            <div class="f-box"><div class="coin-ic btc">₿</div><input id="inBtcWallet" placeholder="bc1… / 1… / 3…" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"></div>
            <div class="f-hint" id="giftBtcHint">Адрес Bitcoin-кошелька: bc1…, 1… или 3…</div>
            <div class="f-err" id="giftErr"></div>
          </div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnSell">${ICONS.bolt}<span>Продать карту за BTC</span></button>
        </div>
            </div>
          </div>
        </div>
      </div>
      <div id="exOrder" class="${S.order ? '' : 'hidden'}"></div>
    `;

    // Выбор поддерживаемой подарочной карты в нижней шторке.
    $('#assetPicker').querySelectorAll('[data-group]').forEach((b) =>
      b.addEventListener('click', () => {
        haptic('light');
        openAssetSheet(b.dataset.group);
      })
    );
    const heroStart = $('#heroStart');
    if (heroStart) heroStart.addEventListener('click', () => {
      haptic('light');
      $('#supportedCards').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    $('#assetPicker').querySelectorAll('.supported-card').forEach((b) =>
      b.addEventListener('click', () => pickAsset(b.dataset.key))
    );
    $('#btnBackToAssets').addEventListener('click', () => { haptic('light'); goToAssetPicker(); });
    $('#assetChip').addEventListener('click', () => {
      haptic('light');
      openAssetSheet(isGiftDir(currentDir()) ? 'gift' : 'crypto');
    });

    if (giftOn) {
      $('#segNom').innerHTML = [10, 20, 50, 100]
        .map((v) => `<button data-v="${v}" class="${v === 10 ? 'on' : ''}">$${v}</button>`)
        .join('');
      $('#segNom').querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          $('#inUnits').value = b.dataset.v;
          haptic('light');
          $('#segNom').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          renderFormMeta();
        })
      );
      const unitsInput = $('#inUnits');
      unitsInput.addEventListener('input', () => {
        // Номинал кратен $10: ввод 37 превращаем в 30.
        const n = Math.floor((Number(unitsInput.value) || 0) / step) * step;
        $('#segNom').querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === n));
        renderFormMeta();
      });
      unitsInput.addEventListener('blur', () => {
        const n = Math.max(minUnits, Math.floor((Number(unitsInput.value) || 0) / step) * step);
        unitsInput.value = String(n);
        renderFormMeta();
      });
      $('#inBtcWallet').addEventListener('input', renderFormMeta);
      $('#btnSell').addEventListener('click', submitGiftOrder);
    }
    setScreen(S.screen || 'picker');
    syncAssetChip();
    renderFormMeta();
    renderOrderStage();
  }

  function renderFormMeta() {
    const s = S.settings;
    if (!s) return;
    const dir = currentDir();
    const all = available();
    syncPickerAvailability();
    if ($('#giftForm')) $('#giftForm').classList.remove('hidden');
    renderGiftMeta();
  }

  // Гифт-карта: номинал в $ → выплата BTC по текущему курсу BTC/USD.
  function renderGiftMeta() {
    const units = $('#inUnits');
    if (!units) return;
    const s = S.settings;
    const dir = isGiftDir(currentDir()) ? currentDir() : currentSellDir();
    const step = Number(dir && dir.step) || 10;
    const minUnits = Number(dir && dir.minUnits) || step;
    const rate = Number(dir && dir.rate) || 0;
    const title = $('#giftTitle');
    if (title && dir) title.textContent = dir.label;
    const cardIcon = $('#giftCardIcon');
    if (cardIcon && dir) { cardIcon.className = 'coin-ic ' + dir.coin; cardIcon.innerHTML = coinInner(dir); }
    const nominal = Math.max(0, Math.floor((Number(units.value) || 0) / step) * step);
    const wallet = ($('#inBtcWallet') && $('#inBtcWallet').value) || '';
    const payout = giftPayout(nominal);
    const out = $('#outBtc');
    const amount = (v) => fmtCrypto(v, 'BTC', 8);
    if (out) out.value = nominal && payout ? amount(payout) : '—';
    const rule = $('#giftRule');
    if (rule) rule.textContent = `от $${minUnits} · кратно $${step}`;
    const info = $('#giftInfo');
    if (info && dir && dir.infoNote) info.innerHTML = esc(dir.infoNote).replace(/USD/g, '<b>USD</b>');
    const limits = $('#giftLimits');
    if (limits) {
      limits.textContent = rate
        ? `${fmtCrypto(rate, 'BTC', 8)} за $1 номинала`
        : 'направление недоступно';
    }
    const hint = $('#giftBtcHint');
    if (hint) {
      hint.textContent = wallet
        ? giftWalletValid(wallet)
          ? `Выплата: ${payout ? amount(payout) : '—'} за $${nominal}`
          : 'Проверьте Bitcoin-адрес: bc1…, 1… или 3…'
        : 'Адрес Bitcoin-кошелька: bc1…, 1… или 3…';
    }
    const meta = $('#giftMeta');
    if (meta) {
      meta.innerHTML = `
        <div class="row"><span>Номинал карты</span><b>$${nominal}</b></div>
        <div class="row"><span>Курс</span><b>1 $ = ${rate ? fmtCrypto(rate, 'BTC', 8) : '—'}</b></div>
        <div class="row"><span>К выплате</span><b>${payout ? amount(payout) : '—'}</b></div>`;
    }
    const btn = $('#btnSell');
    if (btn) {
      btn.disabled = !s.online || !rate;
      btn.querySelector('span').textContent = s.online ? 'Продать карту за BTC' : '⛔ Обмен временно недоступен';
    }
  }

  function giftRulesOpen() {
    const dlg = $('#giftRules');
    if (!dlg) return;
    const dir = isGiftDir(currentDir()) ? currentDir() : currentSellDir();
    S.giftRuleKey = dir && dir.key;
    const brand = $('#giftRulesBrand');
    if (brand && dir) brand.textContent = dir.label;
    if (rulesCloseTimer) { clearTimeout(rulesCloseTimer); rulesCloseTimer = null; }
    dlg.classList.remove('hidden');
    dlg.setAttribute('aria-hidden', 'false');
    rulesFrames = [requestAnimationFrame(() => { rulesFrames[1] = requestAnimationFrame(() => dlg.classList.add('open')); })];
    document.body.classList.add('sheet-lock');
    S.giftRules = true;
    syncTgBack();
  }
  function giftRulesClose() {
    const dlg = $('#giftRules');
    S.giftRules = false;
    S.giftRuleKey = null;
    document.body.classList.remove('sheet-lock');
    rulesFrames.forEach((f) => { try { cancelAnimationFrame(f); } catch (e) {} });
    rulesFrames = [];
    if (!dlg) { syncTgBack(); return; }
    if (dlg.classList.contains('hidden')) { syncTgBack(); return; }
    dlg.classList.remove('open');
    dlg.setAttribute('aria-hidden', 'true');
    if (rulesCloseTimer) clearTimeout(rulesCloseTimer);
    rulesCloseTimer = setTimeout(() => dlg.classList.add('hidden'), 320);
    syncTgBack();
  }
  // Проверка формы подарочной карты; при успехе открывает диалог с правилами.
  function submitGiftOrder() {
    const s = S.settings;
    const err = $('#giftErr');
    err.textContent = '';
    const dir = isGiftDir(currentDir()) ? currentDir() : currentSellDir();
    const step = Number(dir && dir.step) || 10;
    const minUnits = Number(dir && dir.minUnits) || step;
    const units = Math.floor((Number($('#inUnits').value) || 0) / step) * step;
    const wallet = ($('#inBtcWallet').value || '').trim();
    if (!s.online) return (err.textContent = '⛔ Обмен временно недоступен — загляните позже.');
    if (!(Number(dir.rate) > 0)) return (err.textContent = 'Продажа карт сейчас недоступна.');
    if (!units || units < minUnits) return (err.textContent = `Минимальный номинал — $${minUnits}, сумма кратна $${step}.`);
    if (!giftWalletValid(wallet, dir)) return (err.textContent = 'Укажите корректный Bitcoin-адрес: bc1…, 1… или 3….');
    const payout = giftPayout(units, dir);
    if (!(payout > 0)) return (err.textContent = 'Не удалось рассчитать выплату — проверьте курс и номинал.');
    haptic('medium');
    giftRulesOpen();
  }

  // Создание заявки — только после подтверждения правил в диалоге.
  async function createGiftOrder() {
    const s = S.settings;
    const err = $('#giftErr');
    const dir = dirs().find((d) => d.key === S.giftRuleKey) || (isGiftDir(currentDir()) ? currentDir() : currentSellDir());
    const step = Number(dir && dir.step) || 10;
    const minUnits = Number(dir && dir.minUnits) || step;
    const units = Math.floor((Number($('#inUnits').value) || 0) / step) * step;
    const wallet = ($('#inBtcWallet').value || '').trim();
    if (!s.online || !eligible(dir) || !giftWalletValid(wallet, dir) || !units || units < minUnits) {
      giftRulesClose();
      return renderGiftMeta();
    }
    const btn = $('#giftRulesConfirm');
    btn.disabled = true;
    haptic('medium');
    try {
      const r = await api('/api/orders', {
        method: 'POST',
        body: { units, wallet, currency: dir.currency, startParam },
      });
      S.order = r.order;
      S.orders.unshift(r.order);
      haptic('heavy');
      giftRulesClose();
      $('#exForm').classList.add('hidden');
      $('#exOrder').classList.remove('hidden');
      renderOrderStage();
      toast('Заявка создана — дождитесь подключения оператора');
    } catch (e) {
      if (err) err.textContent = e.message;
      toast(e.message);
      giftRulesClose();
    } finally {
      btn.disabled = false;
      renderGiftMeta();
    }
  }


  function chip(st, label) {
    const m = STATUS[st] || { label: st, color: '#8aa0b8' };
    const text = label || m.label;
    return `<span class="chip" style="color:${m.color};background:${m.color}1a;border:1px solid ${m.color}55">${text}</span>`;
  }

  // Гифт-заявка: клиент отдал код карты и ждёт выплату BTC (старые заявки сохраняют USDT).
  const GIFT_KEYS = new Set(['GOOGLE_USD', 'ITUNES_USD', 'XBOX_USD', 'APPLE_STORE_USD']);
  const isGiftOrder = (o) => !!o && (o.direction === 'sell' || GIFT_KEYS.has(String(o.currency || '').toUpperCase()));
  const giftNominal = (o) => Number(o.units) || 0;

  // Сколько осталось до конца срока (1 час на сделку).
  function timeLeft(expiresAt) {
    const left = Number(expiresAt) - Date.now();
    if (!(left > 0)) return null;
    const m = Math.floor(left / 60000);
    const sLeft = Math.floor((left % 60000) / 1000);
    return m >= 60 ? `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин` : `${m}:${String(sLeft).padStart(2, '0')}`;
  }
  const ttlText = (o) => {
    const left = timeLeft(o.expiresAt);
    return left ? `⏳ На сделку осталось <b>${left}</b>` : '⏳ Срок на сделку истёк';
  };

  function renderGiftStage(o) {
    const box = $('#exOrder');
    const payout = giftPayoutText(o);
    if (o.status === 'new' && o.giftCode) {
      // Совместимость со старыми заявками, где код был указан при создании.
      box.innerHTML = `
        <div class="card stage">
          ${chip('details')}
          <div class="pay-dir">${ICONS.swap}<span>${esc(giftLabelOf(o))} <b>$${giftNominal(o)}</b> → ${payout}</span></div>
          <div class="stage-title">Подтвердите передачу карты</div>
          <div class="stage-sub">Заявка <b>#${o.id}</b>. Проверьте код — он уйдёт оператору, как только вы нажмёте «Я оплатил».</div>
          <div class="req-box" id="giftCodeBox">Код карты: ${esc(o.giftCode)}</div>
          <div class="copy-row">
            <button class="btn btn-ghost btn-sm" id="cpGift">${ICONS.copy}<span>Копировать код</span></button>
          </div>
          <div class="note">${ttlText(o)}<br>После «Я оплатил» оператор проверит карту и выплатит ${payout}.</div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnGiftPaid">${ICONS.check}<span>Я оплатил</span></button>
          <button class="btn btn-ghost" style="margin-top:8px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#cpGift').addEventListener('click', () => copyText(o.giftCode || '', 'Код скопирован'));
      $('#btnGiftPaid').addEventListener('click', async () => {
        haptic('medium');
        await changeOrder(o, 'paid');
        const now = S.order;
        if (now && now.id === o.id && now.status === 'paid') {
          toast('Код отправлен на проверку ✅');
          renderOrderStage();
        }
      });
      $('#btnCancel').addEventListener('click', async () => { haptic('light'); await changeOrder(o, 'cancel'); });
      return true;
    }
    if (o.status === 'new') {
      // Двухфазная сделка: ждём, пока оператор подключится к заявке.
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">🤝</div></div>
          ${chip('new', 'Ожидаем оператора')}
          <div class="pay-dir">${ICONS.swap}<span>${esc(giftLabelOf(o))} <b>$${giftNominal(o)}</b> → ${payout}</span></div>
          <div class="stage-title">Ожидаем подключения оператора</div>
          <div class="stage-sub">Заявка <b>#${o.id}</b> передана оператору.<br>Обычно это занимает несколько минут — <b>не закрывайте приложение</b>.</div>
          <div class="note">${ttlText(o)}<br><b>Ничего не отправляйте и никому не сообщайте код карты</b>, пока оператор не подключится к заявке и не попросит его.</div>
          <button class="btn btn-ghost" style="margin-top:14px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#btnCancel').addEventListener('click', async () => { haptic('light'); await changeOrder(o, 'cancel'); });
      return true;
    }
    if (o.status === 'details' && !o.giftCode) {
      // Оператор подключился — теперь можно отправить код карты.
      box.innerHTML = `
        <div class="card stage">
          ${chip('details', 'Оператор на связи')}
          <div class="pay-dir">${ICONS.swap}<span>${esc(giftLabelOf(o))} <b>$${giftNominal(o)}</b> → ${payout}</span></div>
          <div class="stage-title">Оператор на связи</div>
          <div class="stage-sub">Оператор подключился к заявке <b>#${o.id}</b> и ждёт код карты.<br>Введите код карты ${esc(giftLabelOf(o))} номиналом <b>$${giftNominal(o)}</b>:</div>
          <div class="f-box" style="margin-top:12px"><div class="coin-ic ${esc(giftDirOfOrder(o).coin)}">${coinInner(giftDirOfOrder(o))}</div><input id="inGiftSendCode" placeholder="Например: XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="off"></div>
          <div class="f-err" id="giftSendErr"></div>
          <div class="note">${ttlText(o)}<br>Код увидит только оператор. Не сообщайте его больше никому — ни в поддержке, ни в личных сообщениях.</div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnGiftSend">${ICONS.check}<span>Отправить код оператору</span></button>
          <button class="btn btn-ghost" style="margin-top:8px" id="btnCancel">Отменить заявку</button>
        </div>`;
      const input = $('#inGiftSendCode');
      const errEl = $('#giftSendErr');
      input.addEventListener('input', () => { errEl.textContent = ''; });
      $('#btnGiftSend').addEventListener('click', async () => {
        const code = (input.value || '').trim();
        errEl.textContent = '';
        if (code.length < 8) { errEl.textContent = 'Введите полный код карты (не менее 8 символов).'; return; }
        const btn = $('#btnGiftSend');
        btn.disabled = true;
        haptic('medium');
        try {
          const r = await api(`/api/order/${o.id}/code`, { method: 'POST', body: { giftCode: code } });
          S.order = r.order;
          const i = S.orders.findIndex((x) => x.id === r.order.id);
          if (i >= 0) S.orders[i] = r.order; else S.orders.unshift(r.order);
          haptic('heavy');
          toast('Код отправлен оператору ✅');
          renderOrderStage();
        } catch (e) {
          errEl.textContent = e.message;
          toast(e.message);
          btn.disabled = false;
        }
      });
      $('#btnCancel').addEventListener('click', async () => { haptic('light'); await changeOrder(o, 'cancel'); });
      return true;
    }
    if (o.status === 'paid' || (o.status === 'details' && o.giftCode)) {
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">🔎</div></div>
          <div class="stage-title">Карта на проверке</div>
          <div class="stage-sub">Оператор проверяет ${esc(giftLabelOf(o))} на <b>$${giftNominal(o)}</b>, регион (<b>США</b>) и валюту (<b>USD</b>).<br>Как только всё подтвердится — пришлём ${payout} на ваш кошелёк. Обычно 5–15 минут.</div>
          <div class="req-box">Код карты: ${esc(o.giftCode || '—')}</div>
          <div class="note">Не передавайте код никому, кроме поддержки PRICELEX. Если карта окажется недействительной — заявка будет отклонена.</div>
        </div>`;
      return true;
    }
    if (o.status === 'completed') {
      box.innerHTML = `
        <div class="card stage">
          <svg class="okmark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="41"/><path d="M32 51l13 13 24-27"/></svg>
          <div class="stage-title">Карта принята — ${esc(giftCurrencyOf(o))} выплачен</div>
          <div class="stage-sub">${esc(giftLabelOf(o))} $${giftNominal(o)} → <b>${payout}</b><br>отправлены на ваш кошелёк. Спасибо, что выбираете PRICELEX ✦</div>
          ${o.txUrl ? `
            <div class="tx-box">
              <div class="tx-label">🔗 Транзакция в блокчейне</div>
              <a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a>
              <button class="btn btn-ghost btn-sm" style="margin-top:10px" id="cpTx">${ICONS.copy}<span>Копировать ссылку</span></button>
            </div>` : `<div class="note" style="margin-top:12px">Выплата отправлена вручную. Ссылка на транзакцию появится здесь, если оператор её добавит.</div>`}
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новая заявка</button>
        </div>`;
      const cpTx = $('#cpTx');
      if (cpTx) cpTx.addEventListener('click', () => copyText(o.txUrl, 'Ссылка скопирована'));
      $('#btnNew').addEventListener('click', resetToForm);
      return true;
    }
    if (o.status === 'rejected' || o.status === 'cancelled') {
      const rej = o.status === 'rejected';
      const expired = o.cancelReason === 'Срок на сделку истёк';
      box.innerHTML = `
        <div class="card stage">
          <div class="stage-title">${rej ? 'Карта не принята' : expired ? 'Срок на сделку истёк' : 'Заявка отменена'}</div>
          <div class="stage-sub">${rej ? 'Оператор не смог подтвердить карту по заявке #' + o.id + '. Проверьте код или напишите в поддержку.' : expired ? 'На сделку даётся 1 час. Создайте новую заявку с тем же кодом карты.' : 'Вы отменили заявку #' + o.id + '.'}</div>
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новая заявка</button>
        </div>`;
      $('#btnNew').addEventListener('click', resetToForm);
      return true;
    }
    // Страховка: подарочная заявка не должна попасть в обычный «куплю крипту» сценарий.
    box.innerHTML = `
      <div class="card stage">
        <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">🎁</div></div>
        <div class="stage-title">Заявка #${o.id} обрабатывается</div>
        <div class="stage-sub">Дождитесь оператора или обновите экран.</div>
        <button class="btn btn-ghost" style="margin-top:14px" id="btnCancel">Отменить заявку</button>
      </div>`;
    $('#btnCancel').addEventListener('click', async () => { haptic('light'); await changeOrder(o, 'cancel'); });
    return true;
  }

  function renderOrderStage() {
    syncTgBack();
    const box = $('#exOrder');
    const o = S.order;
    if (!box) return;
    if (!o) { box.innerHTML = ''; return; }
    if (isGiftOrder(o) && renderGiftStage(o)) return;
    box.innerHTML = `
      <div class="card stage">
        <div class="stage-title">Эта заявка не поддерживается</div>
        <div class="stage-sub">PRICELEX сейчас работает только с подарочными картами USD → BTC. Создайте новую заявку, чтобы продолжить.</div>
        <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новая заявка</button>
      </div>`;
    $('#btnNew').addEventListener('click', resetToForm);
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
    haptic('light');
    $('#exOrder').classList.add('hidden');
    $('#exForm').classList.remove('hidden');
    closeAssetSheet();
    setScreen('picker');
    renderOrderStage();
    syncTgBack();
  }

  function renderHistory() {
    const v = $('#view-history');
    if (!S.orders.length) {
      v.innerHTML = `<div class="card"><div class="empty">История пока пуста.<br>Совершите первый обмен — он появится здесь.</div></div>`;
      return;
    }
    v.innerHTML =
      `<div class="card-title" style="padding:2px 4px 10px">История обменов</div>` +
      S.orders
        .map(
          (o) => `
        <div class="card h-item" data-order="${o.id}" role="button" tabindex="0">
          <div class="h-ic ${esc(dirOfOrder(o).coin)}">${coinInner(dirOfOrder(o))}${o.network ? `<small>${esc(o.network === 'TRC20' ? 'TRC' : 'ERC')}</small>` : ''}</div>
          <div class="h-main">
            ${isGiftOrder(o)
              ? `<div class="h-top"><span>${esc(giftLabelOf(o))} $${giftNominal(o)} → ${esc(giftCurrencyOf(o))}</span><span>${giftPayoutText(o)}</span></div>`
              : `<div class="h-top"><span>${esc(dirLabel(o))} → BTC</span><span>${cryptoOf(o)}</span></div>`}
            <div class="h-sub"><span>#${o.id}${o.receipt ? ' 🧾' : ''}${o.txUrl ? ' 🔗' : ''} · ${fmtDate(o.createdAt)}</span>${chip(o.status)}</div>
            <div class="h-sub" style="margin-top:2px"><span>${esc(o.wallet.slice(0, 10) + '…' + o.wallet.slice(-6))}</span><b style="color:#9fd8ff">${cryptoOf(o)}</b></div>
            ${o.txUrl ? `<div class="h-sub" style="margin-top:6px"><a href="${esc(o.txUrl)}" target="_blank" rel="noopener" style="color:var(--teal);font-size:11px;word-break:break-all">🔗 ${esc(o.txUrl.slice(0,50))}…</a></div>` : ''}
          </div>
        </div>`
        )
        .join('');
    // Клик по записи открывает карточку заявки — в том числе завершённой или истёкшей.
    v.querySelectorAll('[data-order]').forEach((el) =>
      el.addEventListener('click', () => openOrderFromHistory(Number(el.dataset.order)))
    );
  }

  // Открывает заявку из истории в карточке на вкладке «Обмен».
  function openOrderFromHistory(id) {
    const order = S.orders.find((o) => o.id === id);
    if (!order) return;
    S.order = order;
    S.tab = 'exchange';
    haptic('light');
    document.querySelectorAll('.view').forEach((vv) => vv.classList.add('hidden'));
    $('#view-exchange').classList.remove('hidden');
    renderNav();
    if (S.order) {
      if ($('#exForm')) $('#exForm').classList.add('hidden');
      if ($('#exOrder')) $('#exOrder').classList.remove('hidden');
    }
    renderOrderStage();
  }

  function renderRefs() {
    const s = S.settings;
    const v = $('#view-refs');
    const link = s.botUsername ? `https://t.me/${s.botUsername}?startapp=ref${S.me.id}` : null;
    v.innerHTML = `
      <div class="card">
        <div class="card-title">Реферальная программа</div>
        ${
          link
            ? `<div class="ref-link" id="refLink">${esc(link)}</div>
               <button class="btn btn-primary" style="margin-top:10px" id="cpRef">${ICONS.copy}<span>Скопировать ссылку</span></button>`
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
    const s = S.settings;
    const v = $('#view-profile');
    const me = S.me || {};
    const name = me.name || 'Клиент';
    const userLine = [me.username ? '@' + me.username : null, 'ID ' + (me.id ?? '—')].filter(Boolean).join(' · ');
    const doneOrders = S.orders.filter((o) => o.status === 'completed');
    const volume = doneOrders.reduce((sum, o) => sum + Number(o.units || 0), 0);
    const opLink = 'https://t.me/' + String(s.operator || '').replace(/^@/, '');
    const link = s.botUsername ? `https://t.me/${s.botUsername}?startapp=ref${me.id}` : null;
    v.innerHTML = `
      <div class="card lc-head">
        <div class="lc-id">
          <div class="lc-name">${esc(name)}</div>
          <div class="lc-sub">${esc(userLine)}</div>
          <div class="lc-note">${s.online ? '🟢 Обменник онлайн' : '🔴 Обменник офлайн'}</div>
        </div>
      </div>
      <div class="lc-stats">
        <div class="lc-stat"><b>${S.orders.length}</b><span>заявок всего</span></div>
        <div class="lc-stat"><b>${doneOrders.length}</b><span>завершено</span></div>
        <div class="lc-stat"><b>$${volume}</b><span>выкуплено карт</span></div>
      </div>
      <div class="card">
        <div class="card-title">Реферальная программа</div>
        <div class="about" style="font-size:12.5px;line-height:1.6"><b>${s.refPercent}%</b> с каждого обмена друга — без лимитов. Приглашено: <b>${me.referredCount || 0}</b></div>
        ${link ? `<div class="ref-link" id="lcRefLink" style="margin-top:10px">${esc(link)}</div>
        <div class="copy-row">
          <button class="btn btn-ghost btn-sm" id="lcCopyRef">${ICONS.copy}<span>Копировать ссылку</span></button>
          <button class="btn btn-ghost btn-sm" id="lcGoRefs">${ICONS.right}<span>Как это работает</span></button>
        </div>` : ''}
      </div>
      ${S.me.isAdmin ? `
      <button class="btn btn-ghost lc-admin-btn" id="lcOpenAdmin">🛠 <span>Админка и настройки обменника</span></button>` : ''}
      <div class="card">
        <div class="card-title">Связь с нами</div>
        <div class="contacts">
          <a class="contact" href="${esc(opLink)}" target="_blank" rel="noopener"><span class="ci">🧩</span><span>Оператор<small>${esc(s.operator)}</small></span></a>
          <a class="contact" href="${esc(s.channel)}" target="_blank" rel="noopener"><span class="ci">📣</span><span>Официальный канал<small>новости и курсы</small></span></a>
          <a class="contact" href="${esc(s.chat)}" target="_blank" rel="noopener"><span class="ci">💬</span><span>Чат поддержки<small>отвечаем быстро</small></span></a>
        </div>
        <button class="btn btn-ghost" style="margin-top:10px" id="goSupport">${ICONS.chat}<span>Открыть чат поддержки</span></button>
      </div>
      <div class="card"><div class="about" style="text-align:center;color:var(--mut);font-size:11.5px">PRICELEX — быстро. Надёжно. Выгодно. ✦</div></div>`;
    const copy = $('#lcCopyRef');
    if (copy) copy.addEventListener('click', () => copyText(link, 'Ссылка скопирована'));
    const goRefs = $('#lcGoRefs');
    if (goRefs) goRefs.addEventListener('click', () => goTab('refs'));
    const go = $('#goSupport');
    if (go) go.addEventListener('click', () => goTab('support'));
    const openAdmin = $('#lcOpenAdmin');
    if (openAdmin) openAdmin.addEventListener('click', () => { haptic('light'); openAdminSheet(); });
  }

  /* ---------- админка в приложении (только для оператора PRICELEX) ---------- */
  S.adminOpen = S.adminOpen || false;
  S.admin = S.admin || null;
  let adminSheetTimer = null;
  let adminSheetFrames = [];
  let adminTab = S.adminTab || 'gift';
  const GIFT_DIR = [
    ['GOOGLE_USD', 'Google Gift Card', 'США · USD', 'google', BRAND_MARKS.google],
    ['ITUNES_USD', 'iTunes Gift Card', 'США · USD', 'itunes', BRAND_MARKS.itunes],
    ['XBOX_USD', 'Xbox Gift Card', 'США · USD', 'xbox', BRAND_MARKS.xbox],
    ['APPLE_STORE_USD', 'Apple Store Gift Card', 'США · USD', 'apple', BRAND_MARKS.apple],
  ];
  const giftRateOf = (fee) => {
    const A = S.admin || {};
    const currentRate = Number(A.rateGOOGLEUSD) || 0;
    const currentFee = Number(A.giftPercent) || 0;
    if (!(currentRate > 0)) return 0;
    const spotRate = currentRate / (1 - currentFee / 100);
    const p = Number(fee);
    const safe = Number.isFinite(p) ? Math.min(Math.max(p, 0), 50) : 0;
    return spotRate * (1 - safe / 100);
  };
  const giftPreviewText = (fee) => {
    const rate = giftRateOf(fee);
    const out = floorTo(10 * rate, 8);
    return `Карта $10 → ${fmtCrypto(out, 'BTC', 8)}`;
  };
  function syncAdminSession() {
    const A = S.admin || {};
    const on = !!A.online;
    const sheet = $('#adminSheet');
    if (sheet) sheet.classList.toggle('trading-on', on);
    const block = $('#admSession');
    if (block) block.classList.toggle('on', on);
    if (block) block.classList.toggle('off', !on);
    const title = $('#admSessionTitle');
    if (title) title.textContent = on ? 'Торги открыты' : 'Торги закрыты';
    const sub = $('#admSessionSub');
    if (sub) sub.textContent = on
      ? 'Направления подсвечены — клиенты могут обменивать'
      : 'Клиенты видят «обмен временно недоступен»';
    const btn = $('#admSessionBtn');
    if (btn) btn.innerHTML = on ? '🔴 Закрыть торги' : '🟢 Открыть торги';
  }

  function syncAdminTabs() {
    document.querySelectorAll('#admTabs .adm-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === adminTab));
    document.querySelectorAll('#adminSheet .adm-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== adminTab));
  }
  function openAdminSheet() {
    const sheet = $('#adminSheet');
    if (!sheet) return;
    if (adminSheetTimer) { clearTimeout(adminSheetTimer); adminSheetTimer = null; }
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
    adminSheetFrames = [requestAnimationFrame(() => { adminSheetFrames[1] = requestAnimationFrame(() => sheet.classList.add('open')); })];
    document.body.classList.add('sheet-lock');
    S.adminOpen = true;
    syncAdminTabs();
    syncTgBack();
    loadAdminSettings();
  }
  function closeAdminSheet() {
    const sheet = $('#adminSheet');
    S.adminOpen = false;
    document.body.classList.remove('sheet-lock');
    adminSheetFrames.forEach((f) => { try { cancelAnimationFrame(f); } catch (e) {} });
    adminSheetFrames = [];
    if (!sheet || sheet.classList.contains('hidden')) { syncTgBack(); return; }
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    if (adminSheetTimer) clearTimeout(adminSheetTimer);
    adminSheetTimer = setTimeout(() => sheet.classList.add('hidden'), 320);
    syncTgBack();
  }
  function renderAdminDirs(container, keys) {
    const A = S.admin || {};
    container.innerHTML = keys
      .map(([key, label, sub, coin, icon]) => `<button class="adm-toggle ${A.directions && A.directions[key] ? 'on' : ''}" data-dir="${key}" role="switch" aria-checked="${A.directions && A.directions[key] ? 'true' : 'false'}"><span class="adm-dir"><span class="coin-ic ${esc(coin)} adm-coin" aria-hidden="true">${icon}</span><span class="adm-dir-text">${esc(label)}<small>${esc(sub)}</small></span></span><span class="adm-switch" aria-hidden="true"></span></button>`)
      .join('');
    container.querySelectorAll('.adm-toggle').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const key = btn.dataset.dir;
        const next = !(S.admin && S.admin.directions && S.admin.directions[key]);
        btn.disabled = true;
        haptic('light');
        try {
          const r = await api('/api/admin/settings', { method: 'POST', body: { enabled: { [key]: next } } });
          S.admin = r.admin;
          S.settings = r.settings;
          renderAdminDirs(container, keys);
          renderExchange();
          const productLabel = GIFT_DIR.find(([giftKey]) => giftKey === key)?.[1];
          toast(next ? `${productLabel || key} включена ✅` : `${productLabel || key} выключена ⛔`);
        } catch (e) {
          toast(e.message || 'Не удалось переключить направление');
          btn.disabled = false;
        }
      })
    );
  }
  function renderAdmin() {
    const A = S.admin;
    if (!A) return;
    syncAdminSession();
    // Поддерживаемые gift-карты
    renderAdminDirs($('#admGiftDirs'), GIFT_DIR);
    $('#admGiftFee').value = A.giftPercent;
    $('#admGiftErr').textContent = '';
    updateGiftPreview();
    // Чат
    $('#admChatLink').value = A.chat || '';
    $('#admChatErr').textContent = '';
  }
  async function loadAdminSettings(force = false) {
    if (S.admin && !force) { renderAdmin(); return; }
    try {
      const r = await api('/api/admin/settings');
      S.admin = r.admin;
      S.settings = r.settings;
      renderAdmin();
    } catch (e) {
      toast('Не удалось загрузить настройки администратора');
    }
  }
  async function saveAdmin(body, errEl, okText) {
    errEl.textContent = '';
    try {
      const r = await api('/api/admin/settings', { method: 'POST', body });
      S.admin = r.admin;
      S.settings = r.settings;
      renderAdmin();
      renderExchange();
      toast(okText);
      return true;
    } catch (e) {
      errEl.textContent = e.message;
      toast(e.message);
      return false;
    }
  }
  function updateGiftPreview() {
    const el = $('#admGiftPreview');
    if (!el) return;
    el.textContent = giftPreviewText($('#admGiftFee').value);
  }
  function wireAdminSheet() {
    document.querySelectorAll('#admTabs .adm-tab').forEach((b) =>
      b.addEventListener('click', () => { adminTab = b.dataset.tab; haptic('light'); syncAdminTabs(); })
    );
    const closeBtn = $('#adminSheetClose');
    if (closeBtn) closeBtn.addEventListener('click', () => { haptic('light'); closeAdminSheet(); });
    const overlay = $('#adminSheetOverlay');
    if (overlay) overlay.addEventListener('click', closeAdminSheet);
    $('#admGiftSave').addEventListener('click', (e) => {
      e.currentTarget.disabled = true;
      haptic('medium');
      const fee = $('#admGiftFee').value;
      saveAdmin(
        { giftPercent: fee === '' ? 0 : Number(fee) },
        $('#admGiftErr'),
        'Настройки карты сохранены ✅'
      ).finally(() => { $('#admGiftSave').disabled = false; });
    });
    $('#admGiftFee').addEventListener('input', updateGiftPreview);
    $('#admSessionBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const opening = !(S.admin && S.admin.online);
      btn.disabled = true;
      haptic('medium');
      try {
        const r = await api('/api/admin/settings', { method: 'POST', body: { online: opening } });
        S.admin = r.admin;
        S.settings = r.settings;
        renderAdmin();
        renderExchange();
        if (opening) {
          const n = Number(r.announced) || 0;
          toast(n > 0 ? `Торги открыты 🟢 — объявление отправлено ${n} клиентам ✅` : 'Торги открыты 🟢 — обмен доступен всем ✅');
        } else {
          toast('Торги закрыты 🔴 — приём заявок остановлен');
        }
      } catch (err) {
        toast(err.message || 'Не удалось изменить статус торгов');
      } finally {
        btn.disabled = false;
      }
    });
    $('#admChatLink').addEventListener('input', () => { $('#admChatErr').textContent = ''; });
    $('#admChatSave').addEventListener('click', (e) => {
      e.currentTarget.disabled = true;
      haptic('medium');
      const chat = ($('#admChatLink').value || '').trim();
      saveAdmin({ chat }, $('#admChatErr'), 'Ссылка на чат сохранена — уже видна всем ✅')
        .finally(() => { $('#admChatSave').disabled = false; });
    });
  }

  // Переключение вкладки нижнего меню (для кнопок внутри экранов).
  function goTab(tab) {
    S.tab = tab;
    haptic('light');
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + tab).classList.remove('hidden');
    renderNav();
    if (tab === 'history') renderHistory();
    if (tab === 'refs') renderRefs();
    if (tab === 'profile') renderProfile();
    if (tab === 'support') renderSupport();
    syncTgBack();
  }

  /* ---------- поддержка чат ---------- */
  function renderSupport() {
    const v = $('#view-support');
    v.innerHTML = `
      <div class="card">
        <div class="card-title">Чат поддержки</div>
        <div class="about" style="font-size:12px;color:var(--mut);margin-bottom:10px">Задайте вопрос оператору — отвечаем в реальном времени. Обычно отвечаем за 1–3 минуты.</div>
        <div class="chat-box" id="chatBox">
          <div class="chat-empty" id="chatEmpty">Напишите сообщение — мы на связи 24/7</div>
          <div class="chat-list" id="chatList"></div>
        </div>
        <div class="chat-input">
          <textarea id="chatInput" placeholder="Напишите сообщение..." rows="1" maxlength="2000"></textarea>
          <button class="btn btn-primary btn-sm" id="btnSendChat">${ICONS.send}</button>
        </div>
        <div class="f-hint" style="margin-top:8px">Поддержка отвечает в этом чате и в Telegram. Не делитесь приватными ключами.</div>
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
      return `<div class="msg ${isMe ? 'me' : 'them'}"><div class="msg-bubble">${esc(m.text).replace(/\n/g,'<br>')}</div><div class="msg-time">${fmtDate(m.at)} · ${isMe ? 'Вы' : 'Поддержка'}</div></div>`;
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
    if (!S.isDemo || !(S.me && S.me.isAdmin)) return;
    let el = $('#demoAdmin');
    if (!el) {
      el = document.createElement('button');
      el.id = 'demoAdmin';
      el.className = 'demo-admin';
      el.innerHTML = '🛠 <span>оператор</span>';
      document.body.appendChild(el);
    }
    el.onclick = async () => {
      if (!S.order) return toast('Сначала создайте заявку на обмен');
      const o = S.order;
      haptic('medium');
      if (o.status === 'new' && isGiftOrder(o)) {
        // Демо: оператор подключается к заявке — после этого клиент может отправить код.
        const r = await api(`/api/admin/order/${o.id}/connect`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор подключился — клиент может отправить код (демо)');
      } else if (o.status === 'details' && isGiftOrder(o)) {
        toast('Оператор на связи — ждём код карты от клиента');
      } else if (!isGiftOrder(o)) {
        toast('Поддерживаются только заявки USD gift card → BTC');
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
        if (order.status === 'completed') haptic('heavy');
      }
    } catch (e) {
      if (S.order === current) syncStatus('⚠️ Не удалось обновить заявку. Восстанавливаем связь автоматически…');
    }
  }

  async function pollSettings() {
    const s = await api('/api/settings');
    if (JSON.stringify(s) !== JSON.stringify(S.settings)) {
      S.settings = s;
      renderHeader();
      renderAnnounce();
      renderFormMeta();
      if (S.tab === 'refs') renderRefs();
      if (S.tab === 'profile') renderProfile();
    }
  }

  async function pollProfile() {
    if (S.tab !== 'history' && S.tab !== 'refs' && S.tab !== 'profile') return;
    const m = await api('/api/me');
    S.orders = m.orders;
    S.me = m.me;
    if (!S.order) {
      const act = S.orders.find((o) => !TERMINAL.includes(o.status));
      if (act) {
        S.order = act;
        $('#exForm').classList.add('hidden');
        $('#exOrder').classList.remove('hidden');
        renderOrderStage();
      }
    }
    if (S.tab === 'history') renderHistory();
    else if (S.tab === 'refs') renderRefs();
    else if (S.tab === 'profile') renderProfile();
  }

  function startPolling() {
    const running = new Set();
    const refresh = () => Promise.all([pollOrder, pollSettings, pollProfile, () => pollSupport(false)].map(async (poll) => {
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
  }

  // Системная кнопка «назад» в Telegram и Escape на внешней клавиатуре.
  if (tg && tg.BackButton && tg.BackButton.onClick) {
    try { tg.BackButton.onClick(onTgBackButton); } catch (e) { /* старые клиенты */ }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (S.adminOpen) closeAdminSheet(); else if (S.giftRules) giftRulesClose(); else if (S.sheet) closeAssetSheet(); }
  });
  // Нижняя шторка выбора актива — разовая привязка (она в index.html, вне #view-exchange).
  const sheetCloseBtn = $('#sheetClose');
  if (sheetCloseBtn) sheetCloseBtn.addEventListener('click', () => { haptic('light'); closeAssetSheet(); });
  const sheetOverlay = $('#sheetOverlay');
  if (sheetOverlay) sheetOverlay.addEventListener('click', closeAssetSheet);
  const rulesConfirm = $('#giftRulesConfirm');
  if (rulesConfirm) rulesConfirm.addEventListener('click', createGiftOrder);
  const rulesCancel = $('#giftRulesCancel');
  if (rulesCancel) rulesCancel.addEventListener('click', () => { haptic('light'); giftRulesClose(); });
  const rulesClose = $('#giftRulesClose');
  if (rulesClose) rulesClose.addEventListener('click', () => { haptic('light'); giftRulesClose(); });
  const rulesOverlay = $('#giftRulesOverlay');
  if (rulesOverlay) rulesOverlay.addEventListener('click', giftRulesClose);
  wireAdminSheet();

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
      // preload support
      try {
        const sup = await api('/api/support/messages');
        S.support = sup.messages || [];
      } catch {}
    } catch (e) {
      document.getElementById('announce').textContent = '⚠️ Не удалось подключиться к серверу. Обновите страницу.';
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
    renderProfile();
    // show correct initial tab
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + S.tab).classList.remove('hidden');
    renderDemoAdmin();
    startPolling();
    hidePreloader();
  })();
})();
