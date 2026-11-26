/* Pricelex Worldwide — веб-приложение: подарочные карты USD → BTC. */
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

  /* ---------- preloader: branded loading screen ---------- */
  // Keep the logo screen for at least PRELOAD_MIN_MS, then fade it out softly.
  const PRELOAD_MIN_MS = 3000;
  const bootTs = Date.now();
  let preloaderDone = false;
  function hidePreloader() {
    const el = document.getElementById('preloader');
    if (!el || preloaderDone) return;
    preloaderDone = true;
    const wait = Math.max(0, PRELOAD_MIN_MS - (Date.now() - bootTs));
    setTimeout(() => {
      el.classList.add('done');
      setTimeout(() => el.remove(), 400);
    }, wait);
  }
  // Safety net: even if init hangs, the screen never stays forever.
  setTimeout(hidePreloader, 6500);

  const $ = (s) => document.querySelector(s);
  const TERMINAL = ['completed', 'rejected', 'cancelled'];
  // dir — selected direction (key from /api/settings → rates[]).
  // screen — which exchange sub-screen we are on: 'picker' (asset selection) or 'form' (exchange form).
  // sheet — which bottom sheet is open (crypto | gift) or null.
  const S = { settings: null, me: null, orders: [], order: null, tab: 'exchange', dir: 'GOOGLE_USD', isDemo: false, support: [], screen: 'picker', sheet: null, giftRules: false, giftRuleKey: null, adminOpen: false, admin: null, reviews: null, reviewsLoading: false, reviewTarget: null, reviewRating: 5, reviewOpen: false, adminReviewRating: 5, adminReviewEditId: null, adminReviews: [], adminPromos: [], adminPromoEditId: null, appliedPromo: null };

  // Fallback direction registry: needed if an older server did not send rates.
  const giftFallback = (key, label, symbol, coin) => ({
    key, direction: 'sell', currency: key, network: null, kind: 'gift', payoutCurrency: 'BTC', payoutDecimals: 8,
    label, symbol, coin, decimals: 0, display: 0, unit: 'USD', step: 10, minUnits: 10,
    walletHint: 'Адрес Bitcoin-кошелька (bc1… / 1… / 3…)',
    walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    walletError: 'Проверьте адрес Bitcoin-кошелька — он выглядит неверно.',
    infoNote: 'Где и по какому курсу куплена карта — не важно. Главное, чтобы она работала: США, USD ($), полный баланс.', currencyNote: 'Нужна карта региона США в USD ($).',
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

  // How much BTC we pay for a card of `units` $; the BTC per $1 rate comes from the server.
  function applyPromoRate(baseRate, percent) {
    const r = Number(baseRate) || 0;
    const p = Number(percent) || 0;
    if (!(r > 0)) return 0;
    if (!(p > 0)) return r;
    return Math.round((r * (1 + Math.min(p, 50) / 100)) * 1e12) / 1e12;
  }
  function giftPayout(units, product = null, promoPercent = 0) {
    const dir = product || (isGiftDir(currentDir()) ? currentDir() : currentSellDir());
    const baseRate = Number(dir && dir.rate) || 0;
    if (!(baseRate > 0)) return null;
    const effectiveRate = promoPercent > 0 ? applyPromoRate(baseRate, promoPercent) : baseRate;
    return floorTo((Number(units) || 0) * effectiveRate, 8);
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
  // The operator may have changed settings and the selected direction disappeared — fall back to an available one.
  function selectDir(key) {
    const all = dirs();
    const want = all.find((d) => d.key === key);
    const dir = want && eligible(want) ? want : available()[0] || want || all[0];
    S.dir = dir ? dir.key : key;
    return S.dir;
  }
  // Storage/rounding precision (USDT — 6, BTC/LTC — 8).
  function decimalsOf(dir) {
    return Number.isFinite(Number(dir.decimals)) ? Number(dir.decimals) : 8;
  }
  // Display precision for the client (USDT — 2 decimals, BTC/LTC — 8).
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
  const giftLabelOf = (o) => giftDirOfOrder(o)?.label || o.currencyLabel || 'Подарочная карта';
  function dirLabel(o) {
    const d = dirs().find((x) => x.currency === o.currency && (x.network || null) === (o.network || null));
    if (d) return d.label;
    if (isGiftOrder(o)) return giftLabelOf(o);
    return o.currencyLabel || [o.currency, o.network].filter(Boolean).join(' ');
  }
  const floorTo = (v, dec) => Math.floor(Number(v) * 10 ** dec + 1e-6) / 10 ** dec;
  // Direction parameters for an order (orders store currency + network).
  function dirOfOrder(o) {
    const d = dirs().find((x) => x.currency === o.currency && (x.network || null) === (o.network || null));
    if (d) return d;
    // Legacy orders may store network TRC20/ERC20; detect the product by currency.
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
  // Payout amount for display to the client.
  const cryptoOf = (o) => (isGiftOrder(o)
    ? giftPayoutText(o)
    : fmtCrypto(o.crypto, o.currency, currenciesDecimals(o)));

  const STATUS = {
    new: { label: 'Новая', color: '#ffb648' },
    quote: { label: 'Рассчитана', color: '#38bdf8' },
    details: { label: 'В работе', color: '#38bdf8' },
    paid: { label: 'На проверке', color: '#ffb648' },
    completed: { label: 'Завершена', color: '#22e5a2' },
    rejected: { label: 'Отклонена', color: '#ff5470' },
    cancelled: { label: 'Отменена', color: '#8aa0b8' },
  };

  const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
  // dec — precision from the direction (USDT — 2 decimals, BTC/LTC — 8); without it, precision is inferred from magnitude.
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
  const fmtDateFull = (ts) => {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const toDatetimeLocal = (ts) => {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fromDatetimeLocal = (val) => {
    const s = String(val || '').trim();
    if (!s) return null;
    const ts = new Date(s).getTime();
    return Number.isFinite(ts) ? ts : NaN;
  };
  const fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
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
      const method = (opts.method || 'GET').toUpperCase();
      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
      const res = await fetch(path + sep + q.toString(), {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(Object.assign({ initData, demo }, opts.body || {})) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  // The official Google "G" mark — the gift-card logo instead of an emoji.
  const GIFT_ICON =
    '<svg viewBox="0 0 48 48" style="width:66%;height:66%;display:block" role="img" aria-label="Google Gift Card">' +
    '<path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v9h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.16z"/>' +
    '<path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.34l-7.11-5.52c-1.97 1.32-4.5 2.1-7.45 2.1-5.73 0-10.59-3.87-12.32-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>' +
    '<path fill="#FBBC05" d="M11.68 28.17A13.9 13.9 0 0 1 10.96 24c0-1.45.25-2.86.69-4.17v-5.7H4.34A23 23 0 0 0 2 24c0 3.72.9 7.24 2.48 10.4l7.2-6.23z"/>' +
    '<path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 30.08 2 24 2 15.4 2 7.96 6.93 4.34 12.12l7.34 5.7c1.73-5.2 6.59-9.07 12.32-9.07z"/>' +
    '</svg>';
  // Brand SVGs: iTunes, Xbox and Apple adapted from Font Awesome Free Brands 7.3.1
  // (Fonticons, Inc., CC BY 4.0; https://fontawesome.com/license/free), with currentColor for the Pricelex Worldwide theme.
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
    star: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6l2.9 6.24 6.86.72-5.12 4.6 1.4 6.72L12 17.6l-6.04 3.46 1.4-6.72-5.12-4.6 6.86-.72L12 2.6z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7.6" width="18" height="12.4" rx="2.6"/><path d="M9.2 7.6V6.1A2.1 2.1 0 0 1 11.3 4h1.4a2.1 2.1 0 0 1 2.1 2.1v1.5"/><path d="M3 13.2h18"/><path d="M12 12v2.6"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.6" width="18" height="12.8" rx="4.1"/><path d="M8.4 17.4v3.9c0 .7.8 1.1 1.3.6l3.9-4.1"/><circle cx="8.6" cy="11" r="1.05" fill="currentColor" stroke="none"/><circle cx="12" cy="11" r="1.05" fill="currentColor" stroke="none"/><circle cx="15.4" cy="11" r="1.05" fill="currentColor" stroke="none"/></svg>',
    down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="m6 14 6 6 6-6"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
    bolt: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>',
    left: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
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

  function renderNav() {
    const items = [
      ['exchange', 'Обмен', ICONS.swap],
      ['history', 'История', ICONS.clock],
      ['reviews', 'Отзывы', ICONS.star],
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
        if (S.tab === 'reviews') renderReviews();
        if (S.tab === 'profile') renderProfile();
        if (S.tab === 'support') renderSupport();
        syncTgBack();
      })
    );
  }

  // ---------- Asset selection: the "choose assets" screen + bottom sheets ----------
  // The exchange opens on the asset-selection screen (crypto / gift cards).
  // Asset selection always happens through a bottom sheet — for both crypto and gift cards.
  // All supported cards share the same rules: USA, USD, $10 and multiples of $10.
  let sheetCloseTimer = null;
  let sheetFrames = [];
  let rulesCloseTimer = null;
  let rulesFrames = [];
  // Show all directions, including disabled ones: render them semi-transparent,
  // so the client sees what exists — but cannot pick them.
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
              ? 'Временно недоступна'
              : kind === 'gift'
                ? `1 $ = ${fmtCrypto(d.rate, 'BTC', 8)} · выплата в BTC`
                : 'Карта в USD'
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
      foot.textContent = kind === 'gift' ? 'Принимаем карты США в USD · выплата в BTC' : '';
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
    // Double rAF — so the sheet is in the DOM before the slide animation starts.
    // Frames are cancelled on close, so "open then immediately close" never leaves the sheet in a limbo state.
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
  // Rates/availability may have changed while the form is open: disabled groups are not hidden —
  // they are highlighted semi-transparent (like directions inside the sheet), so it's visible that the exchange exists.
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
  // Telegram system back button: closes the sheet, otherwise returns to asset selection.
  function syncTgBack() {
    try {
      if (!tg || !tg.BackButton) return;
      const need = !!S.reviewOpen || !!S.adminOpen || (S.tab === 'exchange' && !S.order && (S.screen === 'form' || !!S.sheet || !!S.giftRules));
      if (need) tg.BackButton.show(); else tg.BackButton.hide();
    } catch (e) { /* non-Telegram environment */ }
  }
  function onTgBackButton() {
    if (S.reviewOpen) { closeReviewSheet(); return; }
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
        <div id="assetPicker" role="region" aria-label="Выберите подарочную карту">
          <section class="exchange-hero">
            <div class="hero-copy">
              <div class="hero-kicker"><i></i> ПРИВАТНЫЙ ОБМЕН ЦИФРОВЫХ ПОДАРОЧНЫХ КАРТ</div>
              <h1>Подарочные карты<br>на <span>Bitcoin</span></h1>
              <p>Приватный обмен цифровых подарочных карт. Укажите номинал — увидите выплату в BTC до создания заявки.</p>
              <button class="hero-cta" id="heroStart">Начать обмен <span aria-hidden="true">→</span></button>
              <div class="hero-footnote"><span>Курс BTC/USD</span><b>·</b><span>Личная поддержка</span></div>
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
            <div><span class="section-overline">НАПРАВЛЕНИЯ</span><h2>Какие карты принимаем</h2></div>
            <span class="supported-region">США · USD</span>
          </div>
          <div class="supported-grid">
            ${dirs().filter(isGiftDir).map((d) => `
              <button class="supported-card${eligible(d) && S.settings.online ? '' : ' off'}" data-key="${esc(d.key)}" ${eligible(d) && S.settings.online ? '' : 'disabled aria-disabled="true"'}>
                <span class="supported-icon coin-ic ${esc(d.coin)}">${coinInner(d)}</span>
                <b>${esc(d.label)}</b>
                <small>${Number(d.rate) > 0 ? '1 $ = ' + fmtCrypto(d.rate, 'BTC', 8) : 'USD · от $10'}</small>
                <span class="supported-arrow" aria-hidden="true">↗</span>
              </button>`).join('')}
          </div>
          <div class="picker-empty${cryptoOn || giftOn ? ' hidden' : ''}" id="pickerEmpty">Направления временно недоступны.<br>Загляните чуть позже.</div>
          <div class="telegram-cta"><span><b>Начните обмен прямо сейчас</b><small>Выберите карту и номинал</small></span><span class="telegram-cta-mark">↗</span></div>
          <div class="buy-note" role="note">
            <div class="gain-note-title"><span class="gain-note-ic" aria-hidden="true">🛒</span>Где купить карту — решать вам</div>
            <div class="gain-item"><span class="gain-num">✦</span><p>Нам <b>не важно, где вы купили карту и по какому курсу</b>: на маркетплейсе, в магазине цифровых кодов, у знакомых, за наличные — где угодно. Чек и цену покупки мы не спрашиваем.</p></div>
            <div class="gain-item"><span class="gain-num">✓</span><p>Важно одно: <b>карта работает</b>. Регион <b>США</b>, номинал в <b>USD ($)</b>, баланс полный и не тронутый. Всё остальное — детали, которые нас не касаются.</p></div>
            <div class="gain-item"><span class="gain-num">₿</span><p>Сумма выплаты видна до создания заявки и не зависит от того, сколько вы заплатили за карту.</p></div>
          </div>
        </div>
        <div id="assetForm" class="hidden">
          <div class="form-topbar">
            <button class="back-btn" id="btnBackToAssets">${ICONS.left}<span>К картам</span></button>
            <button class="asset-chip" id="assetChip" aria-label="Сменить карту">
              <span class="coin-ic ${esc(dir.coin)}" id="chipIc">${coinInner(dir)}</span>
              <span class="asset-chip-label" id="chipLabel">${esc(dir.label)}</span>
              ${ICONS.chevDown}
            </button>
          </div>
          <div class="trade-layout">
            <aside class="trade-steps" aria-label="Шаги обмена">
              <div class="trade-step active"><i>01</i><span>Выберите карту</span></div>
              <div class="trade-step"><i>02</i><span>Укажите данные и курс</span></div>
              <div class="trade-step"><i>03</i><span>Получите Bitcoin</span></div>
            </aside>
            <div class="trade-main">
        <div id="giftForm" class="hidden">
          <div class="card">
            <div class="card-title" id="giftTitle">${esc(sell.label)}</div>
            <div class="f-label"><span>Номинал карты</span><span id="giftRule"></span></div>
            <div class="seg gift-nom" id="segNom"></div>
            <div class="f-box" style="margin-top:10px"><div class="coin-ic ${esc(sell.coin)}" id="giftCardIcon">${coinInner(sell)}</div><input id="inUnits" type="number" inputmode="numeric" placeholder="10" min="${minUnits}" step="${step}" value="10"></div>
            <div class="f-hint">Номинал карты: от $${minUnits}, шаг $${step}</div>
            <div class="f-sep"><div class="arr">${ICONS.down}</div></div>
            <div class="f-label"><span>Вы получите</span><span id="giftLimits"></span></div>
            <div class="f-box"><div class="coin-ic btc">₿</div><input id="outBtc" type="text" readonly placeholder="—"></div>
            <div class="promo-wrap">
              <div class="promo-row">
                <div class="f-box promo-box"><span class="promo-ic" aria-hidden="true">🏷</span><input id="inPromo" placeholder="Промокод (если есть)" maxlength="32" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="off" value="${esc(S.appliedPromo ? S.appliedPromo.code : '')}"></div>
                <button type="button" class="btn btn-ghost btn-sm promo-apply" id="btnPromoApply">Применить</button>
              </div>
              <div class="promo-applied hidden" id="promoApplied"></div>
              <div class="f-err" id="promoErr"></div>
            </div>
            <div class="f-meta" id="giftMeta"></div>
            <div class="info-note" style="margin-top:10px">⏱ На сделку даётся <b>1 час</b>: создайте заявку → <b>дождитесь оператора</b> → отправьте код <b>только после его запроса</b> — оператор проверит карту и выплатит BTC.</div>
          </div>
          <div class="card">
            <div class="card-title">Где взять карту</div>
            <div class="info-note" id="giftInfo">Где и по какому курсу вы купили карту — не важно. Мы не спрашиваем чек и цену покупки: важно, чтобы карта работала. Регион <b>США</b>, номинал в <b>USD</b>, полный неиспользованный баланс.</div>
            <div class="info-warn">⚠️ Проверьте регион карты: США, валюта номинала — <b>USD ($)</b>.</div>
            <div class="info-note" style="margin-top:10px">🛡 <b>Минимальный цифровой след</b><br>Карту можно купить <b>за наличные</b> — она не привязана к банковскому счёту или паспорту. Мы не просим документы и регистрацию: только код карты и Bitcoin-адрес. Выплата приходит прямо на кошелёк — без банков, бирж и посредников. Меньше следов данных — спокойнее.</div>
          </div>
          <div class="card">
            <div class="card-title">Bitcoin-кошелёк для выплаты</div>
            <div class="f-box"><div class="coin-ic btc">₿</div><input id="inBtcWallet" placeholder="bc1… / 1… / 3…" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"></div>
            <div class="f-hint" id="giftBtcHint">Адрес Bitcoin-кошелька: bc1…, 1… или 3…</div>
            <div class="f-err" id="giftErr"></div>
          </div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnSell">${ICONS.bolt}<span>Сдать карту за BTC</span></button>
        </div>
            </div>
          </div>
        </div>
      </div>
      <div id="exOrder" class="${S.order ? '' : 'hidden'}"></div>
    `;

    // Selection of a supported gift card in the bottom sheet.
    $('#assetPicker').querySelectorAll('[data-group]').forEach((b) =>
      b.addEventListener('click', () => {
        haptic('light');
        openAssetSheet(b.dataset.group);
      })
    );
    const heroStart = $('#heroStart');
    if (heroStart) heroStart.addEventListener('click', () => {
      haptic('light');
      if (!S.settings || !S.settings.online) { toast('Обмен временно недоступен'); return; }
      const dir = currentSellDir() || dirs().find(isGiftDir) || FALLBACK_DIRS[0];
      if (!dir || !eligible(dir) || Number(dir.rate || 0) <= 0) { toast('Направления временно недоступны'); return; }
      S.dir = dir.key;
      syncAssetChip();
      renderFormMeta();
      setScreen('form');
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
        // The amount must be a multiple of $10: 37 becomes 30.
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
      const promoInput = $('#inPromo');
      const promoBtn = $('#btnPromoApply');
      if (promoInput) {
        promoInput.addEventListener('input', () => {
          const errEl = $('#promoErr');
          if (errEl) errEl.textContent = '';
          const typed = (promoInput.value || '').trim().toUpperCase();
          if (S.appliedPromo && S.appliedPromo.code !== typed) {
            S.appliedPromo = null;
            renderGiftMeta();
          }
        });
        promoInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            applyPromoCode();
          }
        });
      }
      if (promoBtn) promoBtn.addEventListener('click', () => { haptic('light'); applyPromoCode(); });
      $('#btnSell').addEventListener('click', submitGiftOrder);
    }
    setScreen(S.screen || 'picker');
    syncAssetChip();
    renderFormMeta();
    renderOrderStage();
  }

  async function applyPromoCode(silent = false) {
    const input = $('#inPromo');
    const errEl = $('#promoErr');
    const btn = $('#btnPromoApply');
    if (!input) return false;
    const code = (input.value || '').trim().toUpperCase();
    if (errEl) errEl.textContent = '';
    if (!code) {
      S.appliedPromo = null;
      renderGiftMeta();
      if (!silent && errEl) errEl.textContent = 'Введите промокод.';
      return false;
    }
    const dir = isGiftDir(currentDir()) ? currentDir() : currentSellDir();
    const step = Number(dir && dir.step) || 10;
    const units = Math.max(0, Math.floor((Number($('#inUnits')?.value) || 0) / step) * step);
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/promo/check', {
        method: 'POST',
        body: { code, currency: dir && dir.currency, units: units || null },
      });
      S.appliedPromo = r.promo;
      input.value = r.promo.code;
      renderGiftMeta();
      if (!silent) {
        haptic('medium');
        toast(`Промокод ${r.promo.code} применён (+${r.promo.percent}%) ✅`);
      }
      return true;
    } catch (e) {
      S.appliedPromo = null;
      renderGiftMeta();
      if (errEl) errEl.textContent = e.message || 'Промокод недействителен.';
      if (!silent) haptic('error');
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
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

  // Gift card: nominal in $ → BTC payout at the current BTC/USD rate.
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
    const promo = S.appliedPromo;
    const promoExpired = promo && promo.expiresAt && Date.now() > Number(promo.expiresAt);
    const promoTooLow = promo && promo.minUnits && nominal > 0 && nominal < Number(promo.minUnits);
    const promoActive = !!(promo && !promoExpired && !promoTooLow);
    const effectiveRate = promoActive ? applyPromoRate(rate, promo.percent) : rate;
    const basePayout = giftPayout(nominal, dir, 0);
    const payout = promoActive ? giftPayout(nominal, dir, promo.percent) : basePayout;
    const bonus = promoActive && payout && basePayout ? Math.max(0, Math.round((payout - basePayout) * 1e8) / 1e8) : 0;
    const out = $('#outBtc');
    const amount = (v) => fmtCrypto(v, 'BTC', 8);
    if (out) out.value = nominal && payout ? amount(payout) : '—';
    const rule = $('#giftRule');
    if (rule) rule.textContent = `от $${minUnits} · шаг $${step}`;
    const info = $('#giftInfo');
    if (info && dir && dir.infoNote) info.innerHTML = esc(dir.infoNote).replace(/США|USD \(\$\)|рабочей/g, '<b>$&</b>');
    const limits = $('#giftLimits');
    if (limits) {
      limits.textContent = effectiveRate
        ? `${fmtCrypto(effectiveRate, 'BTC', 8)} за $1 номинала`
        : 'направление недоступно';
    }
    const promoBox = $('#promoApplied');
    if (promoBox) {
      if (promo) {
        promoBox.classList.remove('hidden');
        promoBox.classList.toggle('warn', !!(promoExpired || promoTooLow));
        const text = promoExpired
          ? `Срок действия промокода ${esc(promo.code)} истёк`
          : promoTooLow
            ? `Промокод ${esc(promo.code)} (+${promo.percent}%) действует от $${promo.minUnits}`
            : `✓ Промокод <b>${esc(promo.code)}</b>: <b>+${promo.percent}%</b> к выплате`;
        promoBox.innerHTML = `<span>${text}</span><button type="button" class="promo-clear" id="btnPromoClear" aria-label="Убрать промокод">✕</button>`;
        const clr = $('#btnPromoClear');
        if (clr) clr.addEventListener('click', () => {
          S.appliedPromo = null;
          const inp = $('#inPromo');
          if (inp) inp.value = '';
          const perr = $('#promoErr');
          if (perr) perr.textContent = '';
          haptic('light');
          renderGiftMeta();
        });
      } else {
        promoBox.classList.add('hidden');
        promoBox.classList.remove('warn');
        promoBox.innerHTML = '';
      }
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
        <div class="row"><span>Курс карты</span><b>1 $ = ${effectiveRate ? fmtCrypto(effectiveRate, 'BTC', 8) : '—'}</b></div>
        ${promoActive ? `<div class="row"><span>Промокод ${esc(promo.code)}</span><b class="meta-promo">+${promo.percent}%${bonus > 0 ? ` (+${amount(bonus)})` : ''}</b></div>` : ''}
        <div class="row"><span>Выплата</span><b>${payout ? amount(payout) : '—'}</b></div>`;
    }
    const btn = $('#btnSell');
    if (btn) {
      btn.disabled = !s.online || !rate;
      btn.querySelector('span').textContent = s.online ? 'Сдать карту за BTC' : '⛔ Обмен временно недоступен';
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
  // Gift-card form validation; on success opens the rules dialog.
  async function submitGiftOrder() {
    const s = S.settings;
    const err = $('#giftErr');
    err.textContent = '';
    const dir = isGiftDir(currentDir()) ? currentDir() : currentSellDir();
    const step = Number(dir && dir.step) || 10;
    const minUnits = Number(dir && dir.minUnits) || step;
    const units = Math.floor((Number($('#inUnits').value) || 0) / step) * step;
    const wallet = ($('#inBtcWallet').value || '').trim();
    if (!s.online) return (err.textContent = '⛔ Обмен временно недоступен — попробуйте позже.');
    if (!(Number(dir.rate) > 0)) return (err.textContent = 'Выкуп этой карты сейчас недоступен.');
    if (!units || units < minUnits) return (err.textContent = `Минимум $${minUnits}, шаг $${step}.`);
    if (!giftWalletValid(wallet, dir)) return (err.textContent = 'Введите корректный Bitcoin-адрес: bc1…, 1… или 3….');
    const typedPromo = ($('#inPromo') && $('#inPromo').value || '').trim().toUpperCase();
    if (typedPromo && (!S.appliedPromo || S.appliedPromo.code !== typedPromo)) {
      const ok = await applyPromoCode(true);
      if (!ok) return (err.textContent = ($('#promoErr') && $('#promoErr').textContent) || 'Проверьте промокод.');
    }
    if (S.appliedPromo && S.appliedPromo.minUnits && units < Number(S.appliedPromo.minUnits)) {
      return (err.textContent = `Промокод ${S.appliedPromo.code} действует от номинала $${S.appliedPromo.minUnits}.`);
    }
    const payout = giftPayout(units, dir, S.appliedPromo ? S.appliedPromo.percent : 0);
    if (!(payout > 0)) return (err.textContent = 'Не удалось рассчитать выплату — проверьте курс и номинал.');
    haptic('medium');
    giftRulesOpen();
  }

  // The order is created only after the rules are confirmed in the dialog.
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
      const promoCode = S.appliedPromo ? S.appliedPromo.code : '';
      const r = await api('/api/orders', {
        method: 'POST',
        body: { units, wallet, currency: dir.currency, promoCode, startParam },
      });
      S.order = r.order;
      S.orders.unshift(r.order);
      S.appliedPromo = null;
      const inPromo = $('#inPromo');
      if (inPromo) inPromo.value = '';
      haptic('heavy');
      giftRulesClose();
      $('#exForm').classList.add('hidden');
      $('#exOrder').classList.remove('hidden');
      renderOrderStage();
      toast('Заявка создана — дождитесь оператора');
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

  // Gift order: the client gave the card code and awaits the BTC payout (legacy orders may still pay USDT).
  const GIFT_KEYS = new Set(['GOOGLE_USD', 'ITUNES_USD', 'XBOX_USD', 'APPLE_STORE_USD']);
  const isGiftOrder = (o) => !!o && (o.direction === 'sell' || GIFT_KEYS.has(String(o.currency || '').toUpperCase()));
  const giftNominal = (o) => Number(o.units) || 0;

  // How much time is left (1 hour per deal).
  function timeLeft(expiresAt) {
    const left = Number(expiresAt) - Date.now();
    if (!(left > 0)) return null;
    const m = Math.floor(left / 60000);
    const sLeft = Math.floor((left % 60000) / 1000);
    return m >= 60 ? `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин` : `${m}:${String(sLeft).padStart(2, '0')}`;
  }
  const ttlText = (o) => {
    const left = timeLeft(o.expiresAt);
    return left ? `⏳ На сделку осталось <b>${left}</b>` : '⏳ Время на сделку истекло';
  };

  function renderGiftStage(o) {
    const box = $('#exOrder');
    const payout = giftPayoutText(o);
    const promoBadge = o.promoCode
      ? `<div class="order-promo-badge">🏷 Промокод <b>${esc(o.promoCode)}</b> · +${o.promoPercent}%</div>`
      : '';
    if (o.status === 'new' && o.giftCode) {
      // Compatibility with legacy orders where the code was provided at creation time.
      box.innerHTML = `
        <div class="card stage">
          ${chip('details')}
          <div class="pay-dir">${ICONS.swap}<span>${esc(giftLabelOf(o))} <b>$${giftNominal(o)}</b> → ${payout}</span></div>
          ${promoBadge}
          <div class="stage-title">Подтвердите передачу карты</div>
          <div class="stage-sub">Заявка <b>#${o.id}</b>. Проверьте код — он уйдёт оператору, как только вы нажмёте «Я оплатил».</div>
          <div class="req-box" id="giftCodeBox">Код карты: ${esc(o.giftCode)}</div>
          <div class="copy-row">
            <button class="btn btn-ghost btn-sm" id="cpGift">${ICONS.copy}<span>Скопировать код</span></button>
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
      // Two-phase deal: wait until the operator joins the order.
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">🤝</div></div>
          ${chip('new', 'Ждём оператора')}
          <div class="pay-dir">${ICONS.swap}<span>${esc(giftLabelOf(o))} <b>$${giftNominal(o)}</b> → ${payout}</span></div>
          ${promoBadge}
          <div class="stage-title">Ждём подключения оператора</div>
          <div class="stage-sub">Заявка <b>#${o.id}</b> передана оператору.<br>Обычно это несколько минут — <b>не закрывайте приложение</b>.</div>
          <div class="note">${ttlText(o)}<br><b>Ничего не отправляйте и никому не сообщайте код карты</b>, пока оператор не подключится и не попросит его.</div>
          <button class="btn btn-ghost" style="margin-top:14px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#btnCancel').addEventListener('click', async () => { haptic('light'); await changeOrder(o, 'cancel'); });
      return true;
    }
    if (o.status === 'details' && !o.giftCode) {
      // The operator has joined — now the card code can be sent.
      box.innerHTML = `
        <div class="card stage">
          ${chip('details', 'Оператор на связи')}
          <div class="pay-dir">${ICONS.swap}<span>${esc(giftLabelOf(o))} <b>$${giftNominal(o)}</b> → ${payout}</span></div>
          ${promoBadge}
          <div class="stage-title">Оператор на связи</div>
          <div class="stage-sub">Оператор подключился к заявке <b>#${o.id}</b> и ждёт код карты.<br>Введите код ${esc(giftLabelOf(o))} на <b>$${giftNominal(o)}</b>:</div>
          <div class="f-box" style="margin-top:12px"><div class="coin-ic ${esc(giftDirOfOrder(o).coin)}">${coinInner(giftDirOfOrder(o))}</div><input id="inGiftSendCode" placeholder="Например XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="off"></div>
          <div class="f-err" id="giftSendErr"></div>
          <div class="note">${ttlText(o)}<br>Код увидит только оператор. Не передавайте его больше никому — ни в поддержке, ни в личных сообщениях.</div>
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
          ${promoBadge}
          <div class="stage-title">Карта на проверке</div>
          <div class="stage-sub">Оператор проверяет ${esc(giftLabelOf(o))} на <b>$${giftNominal(o)}</b>, регион (<b>США</b>) и валюту (<b>USD</b>).<br>Если всё сходится, отправим ${payout} на ваш кошелёк. Обычно 5–15 минут.</div>
          <div class="req-box">Код карты: ${esc(o.giftCode || '—')}</div>
          <div class="note">Не сообщайте код никому, кроме поддержки Pricelex Worldwide. Если карта окажется недействительной, заявку отклонят.</div>
        </div>`;
      return true;
    }
    if (o.status === 'completed') {
      box.innerHTML = `
        <div class="card stage">
          <svg class="okmark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="41"/><path d="M32 51l13 13 24-27"/></svg>
          <div class="stage-title">Карта принята — ${esc(giftCurrencyOf(o))} выплачен</div>
          ${promoBadge}
          <div class="stage-sub">${esc(giftLabelOf(o))} $${giftNominal(o)} → <b>${payout}</b><br>отправлены на ваш кошелёк. Спасибо, что выбрали Pricelex Worldwide ✦</div>
          ${o.txUrl ? `
            <div class="tx-box">
              <div class="tx-label">🔗 Транзакция в блокчейне</div>
              <a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a>
              <button class="btn btn-ghost btn-sm" style="margin-top:10px" id="cpTx">${ICONS.copy}<span>Скопировать ссылку</span></button>
            </div>` : `<div class="note" style="margin-top:12px">Выплата отправлена вручную. Ссылка на транзакцию появится здесь, если оператор её добавит.</div>`}
          ${o.reviewed
            ? `<div class="note note-ok" style="margin-top:14px">✦ Спасибо за отзыв об обмене!</div>`
            : `<button class="btn btn-ghost" style="margin-top:14px" id="btnReview">${ICONS.star}<span>Оставить отзыв</span></button>`}
          <button class="btn btn-primary" style="margin-top:10px" id="btnNew">Новая заявка</button>
        </div>`;
      const cpTx = $('#cpTx');
      if (cpTx) cpTx.addEventListener('click', () => copyText(o.txUrl, 'Ссылка скопирована'));
      const btnReview = $('#btnReview');
      if (btnReview) btnReview.addEventListener('click', () => openReviewSheet(o.id));
      $('#btnNew').addEventListener('click', resetToForm);
      return true;
    }
    if (o.status === 'rejected' || o.status === 'cancelled') {
      const rej = o.status === 'rejected';
      const expired = o.cancelReason === 'expired' || o.cancelReason === 'Срок на сделку истёк'; // 'expired' — new rows, the Russian string — legacy rows
      box.innerHTML = `
        <div class="card stage">
          <div class="stage-title">${rej ? 'Карта не принята' : expired ? 'Время на сделку истекло' : 'Заявка отменена'}</div>
          <div class="stage-sub">${rej ? 'Оператор не смог проверить карту по заявке #' + o.id + '. Проверьте код или напишите в поддержку.' : expired ? 'На сделку даётся 1 час. Создайте новую заявку с тем же кодом карты.' : 'Вы отменили заявку #' + o.id + '.'}</div>
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новая заявка</button>
        </div>`;
      $('#btnNew').addEventListener('click', resetToForm);
      return true;
    }
    // Safety net: a gift order should never fall into the regular "buy crypto" scenario.
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
        <div class="stage-sub">Pricelex Worldwide работает только с подарочными картами USD → BTC. Создайте новую заявку.</div>
        <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новая заявка</button>
      </div>`;
    $('#btnNew').addEventListener('click', resetToForm);
  }

  function wireReceiptPicker(o) {
    $('#btnPick').addEventListener('click', () => { haptic('light'); $('#inReceipt').click(); });
    $('#inReceipt').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('Нужен PDF-файл'); e.target.value = ''; return; }
      if (f.size > 8 * 1024 * 1024) { toast('PDF должен быть не больше 8 МБ'); e.target.value = ''; return; }
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
          toast('📎 Сначала прикрепите PDF-чек');
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
      toast(e.message || 'Не удалось отправить. Проверьте соединение и попробуйте ещё раз.');
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
      toast('Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.');
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
      v.innerHTML = `<div class="card"><div class="empty">История пока пуста.<br>Здесь появится ваш первый обмен.</div></div>`;
      return;
    }
    v.innerHTML =
      `<div class="card-title" style="padding:2px 4px 10px">История обмена</div>` +
      S.orders
        .map(
          (o) => `
        <div class="card h-item" data-order="${o.id}" role="button" tabindex="0">
          <div class="h-ic ${esc(dirOfOrder(o).coin)}">${coinInner(dirOfOrder(o))}${o.network ? `<small>${esc(o.network === 'TRC20' ? 'TRC' : 'ERC')}</small>` : ''}</div>
          <div class="h-main">
            ${isGiftOrder(o)
              ? `<div class="h-top"><span>${esc(giftLabelOf(o))} $${giftNominal(o)} → ${esc(giftCurrencyOf(o))}</span><span>${giftPayoutText(o)}</span></div>`
              : `<div class="h-top"><span>${esc(dirLabel(o))} → BTC</span><span>${cryptoOf(o)}</span></div>`}
            <div class="h-sub"><span>#${o.id}${o.receipt ? ' 🧾' : ''}${o.txUrl ? ' 🔗' : ''}${o.promoCode ? ` · 🏷 ${esc(o.promoCode)}` : ''} · ${fmtDate(o.createdAt)}</span>${chip(o.status)}</div>
            <div class="h-sub" style="margin-top:2px"><span>${esc(o.wallet.slice(0, 10) + '…' + o.wallet.slice(-6))}</span><b style="color:#9fd8ff">${cryptoOf(o)}</b></div>
            ${o.txUrl ? `<div class="h-sub" style="margin-top:6px"><a href="${esc(o.txUrl)}" target="_blank" rel="noopener" style="color:var(--teal);font-size:11px;word-break:break-all">🔗 ${esc(o.txUrl.slice(0,50))}…</a></div>` : ''}
            ${o.status === 'completed' ? `<div class="h-review">${o.reviewed ? `<span class="h-review-done">★ Вы оставили отзыв</span>` : `<button class="h-review-btn" data-review="${o.id}">★ Оставить отзыв</button>`}</div>` : ''}
          </div>
        </div>`
        )
        .join('');
    // Clicking an entry opens the order card — including completed or expired ones.
    v.querySelectorAll('[data-order]').forEach((el) =>
      el.addEventListener('click', () => openOrderFromHistory(Number(el.dataset.order)))
    );
    v.querySelectorAll('[data-review]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openReviewSheet(Number(el.dataset.review));
      })
    );
  }

  // Opens an order from history in the card on the "Exchange" tab.
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

  /* ---------- reviews ---------- */
  // Clients leave reviews after a completed deal; the operator can add any review
  // manually through the admin panel. The showcase is a simple average and a list of recent reviews.
  const initialsOf = (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    const out = parts.map((w) => (w[0] || '').toUpperCase()).join('');
    return out || '?';
  };
  // Static showcase stars: the filled fraction is computed from the rating.
  const starsHtml = (rating, cls) => {
    const pct = Math.max(0, Math.min(100, ((Number(rating) || 0) / 5) * 100));
    const row = ICONS.star + ICONS.star + ICONS.star + ICONS.star + ICONS.star;
    return `<span class="stars${cls ? ' ' + cls : ''}" aria-hidden="true"><span class="stars-bg">${row}</span><span class="stars-fg" style="width:${pct}%">${row}</span></span>`;
  };

  function renderStarInput(container, rating, onChange) {
    if (!container) return;
    container.innerHTML = [1, 2, 3, 4, 5]
      .map((i) => `<button type="button" class="star-btn${i <= rating ? ' on' : ''}" data-v="${i}" role="radio" aria-checked="${i === rating ? 'true' : 'false'}" aria-label="${i} из 5">${ICONS.star}</button>`)
      .join('');
    container.querySelectorAll('.star-btn').forEach((b) =>
      b.addEventListener('click', () => {
        const v = Number(b.dataset.v);
        container.querySelectorAll('.star-btn').forEach((x) => {
          const on = Number(x.dataset.v) <= v;
          x.classList.toggle('on', on);
          x.setAttribute('aria-checked', on && Number(x.dataset.v) === v ? 'true' : 'false');
        });
        haptic('light');
        onChange(v);
      })
    );
  }

  const referralLinkOf = () => {
    const s = S.settings || {};
    return s.botUsername ? `https://t.me/${s.botUsername}?startapp=ref${(S.me && S.me.id) || ''}` : null;
  };
  // Referral card — shared between the Reviews view and the profile.
  const referralCardHtml = (copyBtnId) => {
    const s = S.settings || {};
    const link = referralLinkOf();
    return `<div class="card ref-card">
        <div class="card-title">Реферальная программа</div>
        <div class="about" style="font-size:12.5px;line-height:1.6;color:var(--mut)"><b style="color:var(--teal)">${esc(String(s.refPercent ?? '—'))}%</b> с каждого обмена друга по вашей ссылке — без ограничений.</div>
        ${link ? `<div class="ref-link" id="${copyBtnId}Link" style="margin-top:10px">${esc(link)}</div>
        <button class="btn btn-ghost btn-sm" id="${copyBtnId}" style="margin-top:10px">${ICONS.copy}<span>Скопировать ссылку</span></button>` : `<div class="empty" style="margin-top:8px">Ваша реферальная ссылка появится после подключения бота.</div>`}
      </div>`;
  };
  const bindReferralCopy = (copyBtnId) => {
    const btn = document.getElementById(copyBtnId);
    if (btn) btn.addEventListener('click', () => copyText(referralLinkOf() || '', 'Ссылка скопирована'));
  };

  const reviewWord = (n) => {
    const k = Math.abs(Number(n) || 0) % 100;
    const last = k % 10;
    if (k > 10 && k < 20) return 'отзывов';
    if (last === 1) return 'отзыв';
    if (last >= 2 && last <= 4) return 'отзыва';
    return 'отзывов';
  };
  const reviewableOrder = () => (S.orders || []).find((o) => o.status === 'completed' && !o.reviewed) || null;

  async function renderReviews(force) {
    const v = $('#view-reviews');
    if (!v) return;
    if (!S.reviews || force) {
      if (S.reviewsLoading) return;
      S.reviewsLoading = true;
      v.innerHTML = `<div class="card rev-loading"><div class="spinner"></div><div class="rev-loading-text">Загружаем отзывы…</div></div>`;
      try {
        S.reviews = await api('/api/reviews');
      } catch (e) {
        S.reviewsLoading = false;
        v.innerHTML = `<div class="card"><div class="empty">Не удалось загрузить отзывы.<br>Проверьте соединение и попробуйте ещё раз.</div><button class="btn btn-ghost" style="margin-top:12px" id="revRetry">Повторить</button></div>`;
        const retry = $('#revRetry');
        if (retry) retry.addEventListener('click', () => renderReviews(true));
        return;
      }
      S.reviewsLoading = false;
    }
    const data = S.reviews || { summary: { count: 0, avg: 0, dist: {} }, reviews: [] };
    const summary = data.summary || { count: 0, avg: 0, dist: {} };
    const dist = summary.dist || {};
    const total = Math.max(0, Number(summary.count) || 0);
    const avg = Number(summary.avg) || 0;
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    const pending = reviewableOrder();
    const distRow = (n) => {
      const c = Number(dist[n]) || 0;
      const pct = total ? Math.round((c / total) * 100) : 0;
      return `<div class="rev-dist-row"><span class="rev-dist-n">${n} ★</span><div class="rev-dist-bar"><i style="width:${pct}%"></i></div><span class="rev-dist-c">${c}</span></div>`;
    };
    v.innerHTML = `
      <div class="card rev-summary">
        <div class="rev-score">
          <div class="rev-avg">${total ? avg.toFixed(1) : '—'}</div>
          ${starsHtml(avg)}
          <div class="rev-count">${total ? `${total} ${reviewWord(total)}` : 'Отзывов пока нет'}</div>
        </div>
        <div class="rev-dist">${[5, 4, 3, 2, 1].map(distRow).join('')}</div>
      </div>
      ${pending ? `<button class="btn btn-primary rev-cta" id="revCta">${ICONS.star}<span>Оцените обмен</span></button>` : ''}
      ${total && reviews.length ? `<div class="rev-list-title">Последние отзывы</div>
      <div class="rev-list">${reviews
        .map(
          (r) => `
        <div class="card rev-item">
          <div class="rev-head">
            <div class="rev-avatar">${esc(initialsOf(r.name))}</div>
            <div class="rev-meta"><div class="rev-name">${esc(r.name)}</div><div class="rev-date">${fmtDateFull(r.at)}</div></div>
            ${starsHtml(r.rating, 'small')}
          </div>
          ${r.text ? `<div class="rev-text">${esc(r.text)}</div>` : ''}
        </div>`
        )
        .join('')}
      </div>` : `<div class="card"><div class="empty">Отзывов пока нет.<br>Первый появится после завершённого обмена.</div></div>`}
      ${referralCardHtml('revCopyRef')}`;
    const cta = $('#revCta');
    if (cta && pending) cta.addEventListener('click', () => openReviewSheet(pending.id));
    bindReferralCopy('revCopyRef');
  }

  /* ---------- "Rate your exchange" sheet ---------- */
  let reviewSheetTimer = null;
  let reviewSheetFrames = [];
  function openReviewSheet(orderId) {
    const o = (S.orders || []).find((x) => Number(x.id) === Number(orderId))
      || (S.order && Number(S.order.id) === Number(orderId) ? S.order : null);
    if (!o) { toast('Заявка не найдена'); return; }
    S.reviewTarget = o.id;
    S.reviewRating = 5;
    const line = $('#reviewOrderLine');
    if (line) {
      line.innerHTML = `<b>${esc(giftLabelOf(o))}</b> $${esc(giftNominal(o))} → ${esc(giftCurrencyOf(o))}<span>заявка #${o.id}</span>`;
    }
    renderStarInput($('#reviewStars'), S.reviewRating, (val) => { S.reviewRating = val; });
    const text = $('#reviewText');
    if (text) text.value = '';
    const err = $('#reviewErr');
    if (err) err.textContent = '';
    const submit = $('#reviewSubmit');
    if (submit) submit.disabled = false;
    const dlg = $('#reviewSheet');
    if (!dlg) return;
    if (reviewSheetTimer) { clearTimeout(reviewSheetTimer); reviewSheetTimer = null; }
    dlg.classList.remove('hidden');
    dlg.setAttribute('aria-hidden', 'false');
    reviewSheetFrames = [requestAnimationFrame(() => { reviewSheetFrames[1] = requestAnimationFrame(() => dlg.classList.add('open')); })];
    document.body.classList.add('sheet-lock');
    S.reviewOpen = true;
    syncTgBack();
  }
  function closeReviewSheet() {
    const dlg = $('#reviewSheet');
    S.reviewOpen = false;
    S.reviewTarget = null;
    document.body.classList.remove('sheet-lock');
    reviewSheetFrames.forEach((f) => { try { cancelAnimationFrame(f); } catch (e) {} });
    reviewSheetFrames = [];
    if (!dlg) { syncTgBack(); return; }
    if (dlg.classList.contains('hidden')) { syncTgBack(); return; }
    dlg.classList.remove('open');
    dlg.setAttribute('aria-hidden', 'true');
    if (reviewSheetTimer) clearTimeout(reviewSheetTimer);
    reviewSheetTimer = setTimeout(() => dlg.classList.add('hidden'), 320);
    syncTgBack();
  }
  async function submitReview() {
    const orderId = S.reviewTarget;
    if (!orderId) return;
    const btn = $('#reviewSubmit');
    const err = $('#reviewErr');
    if (err) err.textContent = '';
    if (btn) btn.disabled = true;
    try {
      const text = ($('#reviewText') && $('#reviewText').value || '').trim();
      await api('/api/reviews', { method: 'POST', body: { orderId, rating: S.reviewRating, text, startParam } });
      const mark = (o) => (Number(o.id) === Number(orderId) ? { ...o, reviewed: true } : o);
      S.orders = (S.orders || []).map(mark);
      if (S.order) S.order = mark(S.order);
      haptic('heavy');
      toast('Спасибо за отзыв! ✦');
      closeReviewSheet();
      S.reviews = null; // the showcase needs to re-read the average
      renderHistory();
      renderOrderStage();
      if (S.tab === 'reviews') renderReviews(true);
    } catch (e) {
      if (err) err.textContent = e.message || 'Не удалось отправить отзыв. Попробуйте ещё раз.';
      if (btn) btn.disabled = false;
    }
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
    v.innerHTML = `
      <div class="card lc-head">
        <div class="lc-id">
          <div class="lc-name">${esc(name)}</div>
          <div class="lc-sub">${esc(userLine)}</div>
          <div class="lc-note">${s.online ? '🟢 Обмен онлайн' : '🔴 Обмен оффлайн'}</div>
        </div>
      </div>
      <div class="lc-stats">
        <div class="lc-stat"><b>${S.orders.length}</b><span>всего заявок</span></div>
        <div class="lc-stat"><b>${doneOrders.length}</b><span>завершено</span></div>
        <div class="lc-stat"><b>$${volume}</b><span>карт сдано</span></div>
      </div>
      ${referralCardHtml('lcCopyRef')}
      ${S.me.isAdmin ? `
      <button class="btn btn-ghost lc-admin-btn" id="lcOpenAdmin">🛠 <span>Панель оператора и настройки обмена</span></button>` : ''}
      <div class="card">
        <div class="card-title">Связаться с нами</div>
        <div class="contacts">
          <a class="contact" href="${esc(opLink)}" target="_blank" rel="noopener"><span class="ci">🧩</span><span>Оператор<small>${esc(s.operator)}</small></span></a>
          <a class="contact" href="${esc(s.channel)}" target="_blank" rel="noopener"><span class="ci">📣</span><span>Официальный канал<small>новости и курсы</small></span></a>
          <a class="contact" href="${esc(s.chat)}" target="_blank" rel="noopener"><span class="ci">💬</span><span>Чат поддержки<small>отвечаем быстро</small></span></a>
        </div>
        <button class="btn btn-ghost" style="margin-top:10px" id="goSupport">${ICONS.chat}<span>Открыть чат поддержки</span></button>
      </div>
      <div class="card"><div class="about" style="text-align:center;color:var(--mut);font-size:11.5px">Pricelex Worldwide — быстро. Надёжно. По-честному. ✦</div></div>`;
    bindReferralCopy('lcCopyRef');
    const go = $('#goSupport');
    if (go) go.addEventListener('click', () => goTab('support'));
    const openAdmin = $('#lcOpenAdmin');
    if (openAdmin) openAdmin.addEventListener('click', () => { haptic('light'); openAdminSheet(); });
  }

  /* ---------- in-app admin panel (Pricelex Worldwide operator only) ---------- */
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
  // У каждой карты своя скидка → свой курс. Предпросмотр считается из общего спота BTC/USD.
  const cardRateOf = (key, fee) => {
    const A = S.admin || {};
    const btcUsd = Number(A.btcUsd) || 0;
    if (!(btcUsd > 0)) return 0;
    const p = Number(fee);
    const safe = Number.isFinite(p) ? Math.min(Math.max(p, 0), 50) : 0;
    return (1 / btcUsd) * (1 - safe / 100);
  };
  const cardPreviewText = (key, fee) => {
    const rate = cardRateOf(key, fee);
    const out = floorTo(10 * rate, 8);
    return `Карта $10 → ${fmtCrypto(out, 'BTC', 8)}`;
  };
  // Строка настроек курса для каждой карты: иконка, название, скидка %, итоговый курс и выплата за $10.
  function renderAdminFees() {
    const box = $('#admGiftFees');
    if (!box) return;
    const A = S.admin || {};
    const fees = A.cardFees || {};
    const rates = A.cardRates || {};
    box.innerHTML = GIFT_DIR
      .map(([key, label, , coin, icon]) => `<div class="adm-fee-row" data-fee="${esc(key)}">
        <div class="adm-fee-head"><span class="coin-ic ${esc(coin)} adm-coin" aria-hidden="true">${icon}</span><b>${esc(label)}</b><small>1 $ = ${Number(rates[key]) > 0 ? fmtCrypto(rates[key], 'BTC', 8) : '—'}</small></div>
        <div class="f-box"><input type="number" inputmode="decimal" min="0" max="50" step="1" data-fee-input="${esc(key)}" value="${Number(fees[key]) || 0}" aria-label="Скидка для ${esc(label)}, %"></div>
        <div class="adm-fee-preview" data-fee-preview="${esc(key)}">${cardPreviewText(key, Number(fees[key]) || 0)}</div>
      </div>`)
      .join('');
    box.querySelectorAll('[data-fee-input]').forEach((input) =>
      input.addEventListener('input', () => {
        const key = input.dataset.feeInput;
        const preview = box.querySelector(`[data-fee-preview="${key}"]`);
        if (preview) preview.textContent = cardPreviewText(key, input.value);
      })
    );
  }
  function syncAdminSession() {
    const A = S.admin || {};
    const on = !!A.online;
    const sheet = $('#adminSheet');
    if (sheet) sheet.classList.toggle('trading-on', on);
    const block = $('#admSession');
    if (block) block.classList.toggle('on', on);
    if (block) block.classList.toggle('off', !on);
    const title = $('#admSessionTitle');
    if (title) title.textContent = on ? 'Приём открыт' : 'Приём закрыт';
    const sub = $('#admSessionSub');
    if (sub) sub.textContent = on
      ? 'Направления активны — клиенты могут обменивать'
      : 'Клиенты видят «обмен временно недоступен»';
    const btn = $('#admSessionBtn');
    if (btn) btn.innerHTML = on ? '🔴 Закрыть приём' : '🟢 Открыть приём';
  }

  function syncAdminTabs() {
    document.querySelectorAll('#admTabs .adm-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === adminTab));
    document.querySelectorAll('#adminSheet .adm-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== adminTab));
    if (adminTab === 'reviews') loadAdminReviews();
    if (adminTab === 'promos') loadAdminPromos();
    if (adminTab === 'texts') loadAdminTexts();
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
    // Поддерживаемые карты и курс каждой из них
    renderAdminDirs($('#admGiftDirs'), GIFT_DIR);
    renderAdminFees();
    $('#admGiftErr').textContent = '';
    // Чат
    $('#admChatLink').value = A.chat || '';
    $('#admChatErr').textContent = '';
    // Предпросмотр промокода зависит от актуального курса
    updateAdminPromoPreview();
  }
  /* ---------- admin: reviews ---------- */
  const adminStarsText = (r) => {
    const n = Math.min(5, Math.max(1, Math.round(Number(r) || 0)));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  };
  function resetAdminReviewForm() {
    S.adminReviewEditId = null;
    S.adminReviewRating = 5;
    const nameEl = $('#admRevName');
    const atEl = $('#admRevAt');
    const textEl = $('#admRevText');
    const errEl = $('#admRevErr');
    const banner = $('#admRevEditBanner');
    const cancelBtn = $('#admRevCancel');
    const addBtn = $('#admRevAdd');
    if (nameEl) nameEl.value = '';
    if (atEl) atEl.value = '';
    if (textEl) textEl.value = '';
    if (errEl) errEl.textContent = '';
    if (banner) banner.classList.add('hidden');
    if (cancelBtn) cancelBtn.classList.add('hidden');
    if (addBtn) {
      const sp = addBtn.querySelector('span');
      if (sp) sp.textContent = 'Добавить отзыв';
    }
    renderStarInput($('#admRevRating'), S.adminReviewRating, (v) => { S.adminReviewRating = v; });
    renderAdminReviews();
  }
  function startEditAdminReview(review) {
    if (!review) return;
    S.adminReviewEditId = review.id;
    S.adminReviewRating = Math.min(5, Math.max(1, Math.round(Number(review.rating) || 5)));
    const nameEl = $('#admRevName');
    const atEl = $('#admRevAt');
    const textEl = $('#admRevText');
    const errEl = $('#admRevErr');
    const banner = $('#admRevEditBanner');
    const bannerLabel = $('#admRevEditLabel');
    const cancelBtn = $('#admRevCancel');
    const addBtn = $('#admRevAdd');
    if (nameEl) nameEl.value = review.name || '';
    if (atEl) atEl.value = toDatetimeLocal(review.at);
    if (textEl) textEl.value = review.text || '';
    if (errEl) errEl.textContent = '';
    if (banner) banner.classList.remove('hidden');
    if (bannerLabel) bannerLabel.textContent = `Редактирование отзыва #${review.id}`;
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    if (addBtn) {
      const sp = addBtn.querySelector('span');
      if (sp) sp.textContent = 'Сохранить изменения';
    }
    renderStarInput($('#admRevRating'), S.adminReviewRating, (v) => { S.adminReviewRating = v; });
    renderAdminReviews();
    const panel = $('#adminSheet .adm-panel');
    if (panel) panel.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function renderAdminReviews() {
    const list = $('#admRevList');
    if (!list) return;
    const data = S.adminReviews || { summary: { count: 0, avg: 0 }, reviews: [] };
    const summary = data.summary || { count: 0, avg: 0 };
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    const summaryEl = $('#admRevSummary');
    if (summaryEl) {
      summaryEl.textContent = summary.count
        ? `На витрине: ${Number(summary.avg).toFixed(1)} ★ · ${summary.count} ${reviewWord(summary.count)}`
        : 'Витрина пуста — добавьте первый отзыв';
    }
    list.innerHTML = reviews.length
      ? reviews
          .map(
            (r) => `
        <div class="adm-rev-item${Number(S.adminReviewEditId) === Number(r.id) ? ' editing' : ''}" data-id="${r.id}">
          <div class="adm-rev-top">
            <b>${esc(r.name)}</b>
            <span class="adm-rev-stars">${adminStarsText(r.rating)}</span>
            <button type="button" class="adm-icon-btn edit" data-edit-rev="${r.id}" title="Редактировать" aria-label="Редактировать отзыв">✎</button>
            <button type="button" class="adm-rev-del" data-del="${r.id}" title="Удалить" aria-label="Удалить отзыв">✕</button>
          </div>
          ${r.text ? `<div class="adm-rev-text">${esc(r.text)}</div>` : ''}
          <div class="adm-rev-date">${fmtDateFull(r.at)}${r.source === 'admin' ? ' · добавлен вручную' : ''}</div>
        </div>`
          )
          .join('')
      : '<div class="adm-rev-empty">Отзывов пока нет.</div>';
    list.querySelectorAll('[data-edit-rev]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const rev = reviews.find((x) => Number(x.id) === Number(btn.dataset.editRev));
        if (rev) {
          haptic('light');
          startEditAdminReview(rev);
        }
      })
    );
    list.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const id = btn.dataset.del;
        btn.disabled = true;
        haptic('light');
        try {
          await api('/api/admin/reviews/' + encodeURIComponent(id), { method: 'DELETE' });
          if (Number(S.adminReviewEditId) === Number(id)) resetAdminReviewForm();
          toast('Отзыв удалён');
          await loadAdminReviews();
          S.reviews = null;
          if (S.tab === 'reviews') renderReviews(true);
        } catch (e) {
          toast(e.message || 'Не удалось удалить отзыв');
          btn.disabled = false;
        }
      })
    );
  }
  async function loadAdminReviews() {
    try {
      S.adminReviews = await api('/api/admin/reviews');
      renderAdminReviews();
    } catch (e) {
      const list = $('#admRevList');
      if (list) list.innerHTML = `<div class="adm-rev-empty">Не удалось загрузить отзывы${e && e.message ? ': ' + esc(e.message) : ''}</div>`;
    }
  }

  /* ---------- admin: promo codes ---------- */
  function generatePromoCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    for (let i = 0; i < 6; i += 1) suffix += chars[Math.floor(Math.random() * chars.length)];
    return 'PRX-' + suffix;
  }
  function promoStatusOf(p) {
    if (!p.active) return { cls: 'paused', label: 'Пауза' };
    if (p.expiresAt && Date.now() > Number(p.expiresAt)) return { cls: 'expired', label: 'Истёк' };
    if (p.maxUses != null && (Number(p.usedCount) || 0) >= Number(p.maxUses)) return { cls: 'expired', label: 'Исчерпан' };
    return { cls: 'active', label: 'Активен' };
  }
  function updateAdminPromoPreview() {
    const el = $('#admPromoPreview');
    const inp = $('#admPromoPercent');
    if (!el || !inp) return;
    const pct = Number(String(inp.value || '').replace(',', '.'));
    const rates = (S.admin && S.admin.cardRates) || {};
    const sampleRate = Number(rates.GOOGLE_USD) || Object.values(rates).find((v) => Number(v) > 0) || Number(currentSellDir()?.rate) || 0;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 50 || !(sampleRate > 0)) {
      el.classList.add('hidden');
      return;
    }
    const baseOut = floorTo(100 * sampleRate, 8);
    const boostedOut = floorTo(100 * applyPromoRate(sampleRate, pct), 8);
    el.textContent = `Пример для $100: +${pct}% → ${fmtCrypto(boostedOut, 'BTC', 8)} вместо ${fmtCrypto(baseOut, 'BTC', 8)}`;
    el.classList.remove('hidden');
  }
  function resetAdminPromoForm() {
    S.adminPromoEditId = null;
    const ids = ['#admPromoCode', '#admPromoPercent', '#admPromoMaxUses', '#admPromoMinUnits', '#admPromoExpires'];
    ids.forEach((sel) => { const el = $(sel); if (el) el.value = ''; });
    const err = $('#admPromoErr');
    if (err) err.textContent = '';
    const banner = $('#admPromoEditBanner');
    if (banner) banner.classList.add('hidden');
    const cancelBtn = $('#admPromoCancel');
    if (cancelBtn) cancelBtn.classList.add('hidden');
    const saveBtn = $('#admPromoSave');
    if (saveBtn) {
      const sp = saveBtn.querySelector('span');
      if (sp) sp.textContent = 'Создать промокод';
    }
    updateAdminPromoPreview();
    renderAdminPromos();
  }
  function startEditAdminPromo(promo) {
    if (!promo) return;
    S.adminPromoEditId = promo.id;
    const setVal = (sel, val) => { const el = $(sel); if (el) el.value = val; };
    setVal('#admPromoCode', promo.code || '');
    setVal('#admPromoPercent', promo.percent != null ? String(promo.percent) : '');
    setVal('#admPromoMaxUses', promo.maxUses != null ? String(promo.maxUses) : '');
    setVal('#admPromoMinUnits', promo.minUnits != null ? String(promo.minUnits) : '');
    setVal('#admPromoExpires', promo.expiresAt ? toDatetimeLocal(promo.expiresAt) : '');
    const err = $('#admPromoErr');
    if (err) err.textContent = '';
    const banner = $('#admPromoEditBanner');
    if (banner) banner.classList.remove('hidden');
    const bannerLabel = $('#admPromoEditLabel');
    if (bannerLabel) bannerLabel.textContent = `Редактирование промокода ${promo.code}`;
    const cancelBtn = $('#admPromoCancel');
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    const saveBtn = $('#admPromoSave');
    if (saveBtn) {
      const sp = saveBtn.querySelector('span');
      if (sp) sp.textContent = 'Сохранить промокод';
    }
    updateAdminPromoPreview();
    renderAdminPromos();
    const panel = $('#adminSheet .adm-panel');
    if (panel) panel.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function renderAdminPromos() {
    const list = $('#admPromoList');
    if (!list) return;
    const promos = Array.isArray(S.adminPromos) ? S.adminPromos : [];
    const activeCount = promos.filter((p) => promoStatusOf(p).cls === 'active').length;
    const summaryEl = $('#admPromoSummary');
    if (summaryEl) {
      summaryEl.textContent = promos.length
        ? `Промокодов: ${promos.length} · активных: ${activeCount}`
        : 'Промокодов пока нет — создайте первый';
    }
    list.innerHTML = promos.length
      ? promos
          .map((p) => {
            const st = promoStatusOf(p);
            const metaParts = [
              `Использован: ${Number(p.usedCount) || 0}${p.maxUses != null ? ' / ' + p.maxUses : ''}`,
              p.minUnits != null ? `от $${p.minUnits}` : null,
              p.expiresAt ? `до ${fmtDateFull(p.expiresAt)}` : 'бессрочно',
            ].filter(Boolean);
            return `
        <div class="adm-promo-item${st.cls !== 'active' ? ' off' : ''}${Number(S.adminPromoEditId) === Number(p.id) ? ' editing' : ''}" data-promo-id="${p.id}">
          <div class="adm-promo-top">
            <button type="button" class="adm-promo-code" data-copy-promo="${esc(p.code)}" title="Скопировать промокод">${esc(p.code)}</button>
            <span class="adm-promo-pct">+${p.percent}%</span>
            <span class="adm-promo-st ${st.cls}">${st.label}</span>
            <button type="button" class="adm-icon-btn" data-toggle-promo="${p.id}" title="${p.active ? 'Приостановить' : 'Включить'}" aria-label="${p.active ? 'Приостановить промокод' : 'Включить промокод'}">${p.active ? '⏸' : '▶'}</button>
            <button type="button" class="adm-icon-btn edit" data-edit-promo="${p.id}" title="Редактировать" aria-label="Редактировать промокод">✎</button>
            <button type="button" class="adm-rev-del" data-del-promo="${p.id}" title="Удалить" aria-label="Удалить промокод">✕</button>
          </div>
          <div class="adm-promo-meta">${esc(metaParts.join(' · '))}</div>
        </div>`;
          })
          .join('')
      : '<div class="adm-rev-empty">Промокодов пока нет.</div>';

    list.querySelectorAll('[data-copy-promo]').forEach((btn) =>
      btn.addEventListener('click', () => copyText(btn.dataset.copyPromo || '', `Промокод ${btn.dataset.copyPromo} скопирован`))
    );
    list.querySelectorAll('[data-toggle-promo]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const promo = promos.find((x) => Number(x.id) === Number(btn.dataset.togglePromo));
        if (!promo) return;
        btn.disabled = true;
        haptic('light');
        try {
          await api('/api/admin/promos/' + encodeURIComponent(promo.id), {
            method: 'PATCH',
            body: { active: !promo.active },
          });
          toast(promo.active ? `Промокод ${promo.code} на паузе` : `Промокод ${promo.code} активен ✅`);
          await loadAdminPromos();
        } catch (e) {
          toast(e.message || 'Не удалось обновить промокод');
          btn.disabled = false;
        }
      })
    );
    list.querySelectorAll('[data-edit-promo]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const promo = promos.find((x) => Number(x.id) === Number(btn.dataset.editPromo));
        if (promo) {
          haptic('light');
          startEditAdminPromo(promo);
        }
      })
    );
    list.querySelectorAll('[data-del-promo]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const id = btn.dataset.delPromo;
        btn.disabled = true;
        haptic('light');
        try {
          await api('/api/admin/promos/' + encodeURIComponent(id), { method: 'DELETE' });
          if (Number(S.adminPromoEditId) === Number(id)) resetAdminPromoForm();
          toast('Промокод удалён');
          await loadAdminPromos();
        } catch (e) {
          toast(e.message || 'Не удалось удалить промокод');
          btn.disabled = false;
        }
      })
    );
  }
  async function loadAdminPromos() {
    try {
      const r = await api('/api/admin/promos');
      S.adminPromos = Array.isArray(r.promos) ? r.promos : [];
      renderAdminPromos();
    } catch (e) {
      const list = $('#admPromoList');
      if (list) list.innerHTML = `<div class="adm-rev-empty">Не удалось загрузить промокоды${e && e.message ? ': ' + esc(e.message) : ''}</div>`;
    }
  }

  async function loadAdminSettings(force = false) {
    if (S.admin && !force) { renderAdmin(); return; }
    try {
      const r = await api('/api/admin/settings');
      S.admin = r.admin;
      S.settings = r.settings;
      renderAdmin();
    } catch (e) {
      toast('Не удалось загрузить настройки');
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
  let adminTextsLoaded = false;
  async function loadAdminTexts() {
    if (adminTextsLoaded) return;
    const list = $('#admTextList');
    try {
      const data = await api('/api/admin/texts');
      list.replaceChildren();
      for (const item of data.texts) {
        const row = document.createElement('div');
        row.className = 'adm-text-row';
        row.dataset.search = item.text.toLocaleLowerCase('ru');
        const label = document.createElement('label');
        label.textContent = item.text;
        const input = document.createElement('textarea');
        input.rows = 2;
        input.maxLength = 1000;
        input.value = data.overrides[item.id] ?? item.text;
        input.setAttribute('aria-label', 'Изменить: ' + item.text);
        const actions = document.createElement('div');
        actions.className = 'adm-actions';
        const save = document.createElement('button');
        save.type = 'button'; save.className = 'btn btn-primary'; save.textContent = 'Сохранить';
        const reset = document.createElement('button');
        reset.type = 'button'; reset.className = 'btn btn-ghost'; reset.textContent = 'Вернуть исходный';
        async function update(value) {
          save.disabled = reset.disabled = true;
          try {
            const result = await api('/api/admin/texts', { method: 'PUT', body: { id: item.id, value } });
            S.settings = result.settings;
            if (value === null) input.value = item.text;
            applyCopy();
            $('#admTextStatus').textContent = 'Сохранено. Изменение увидят все клиенты.';
          } catch (e) { $('#admTextStatus').textContent = e.message; }
          finally { save.disabled = reset.disabled = false; }
        }
        save.addEventListener('click', () => update(input.value));
        reset.addEventListener('click', () => update(null));
        actions.append(save, reset); row.append(label, input, actions); list.append(row);
      }
      adminTextsLoaded = true;
    } catch (e) { $('#admTextStatus').textContent = e.message; }
  }

  // Replace fixed copy as text, never as HTML. Preserve source values so that
  // subsequent edits and resets also update already-rendered screens.
  const copyNodes = new WeakMap();
  function applyCopy() {
    const replacements = new Map(((S.settings && S.settings.texts) || []).map((x) => [x.text, x.value]));
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walk.nextNode())) {
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (!element || element.closest('#adminSheet, script, style, .rev-text, .rev-name, .msg-bubble') || (node.nodeType === 3 && element.closest('input, textarea'))) continue;
      if (node.nodeType === 3) {
        const old = copyNodes.get(node);
        const current = node.nodeValue;
        const source = old && current === old.applied ? old.source : current;
        const trimmed = source.trim();
        const replacement = replacements.get(trimmed);
        const applied = replacement === undefined ? source : source.replace(trimmed, replacement);
        copyNodes.set(node, { source, applied });
        if (current !== applied) node.nodeValue = applied;
      } else {
        for (const attr of ['placeholder', 'aria-label', 'title']) {
          if (!node.hasAttribute(attr)) continue;
          let state = copyNodes.get(node) || {};
          const current = node.getAttribute(attr);
          const prev = state[attr];
          const source = prev && current === prev.applied ? prev.source : current;
          const applied = replacements.has(source) ? replacements.get(source) : source;
          state[attr] = { source, applied }; copyNodes.set(node, state);
          if (current !== applied) node.setAttribute(attr, applied);
        }
      }
    }
  }
  const copyObserver = new MutationObserver(() => applyCopy());
  copyObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'aria-label', 'title'] });

  function wireAdminSheet() {
    $('#admTextSearch').addEventListener('input', (e) => {
      const query = e.target.value.trim().toLocaleLowerCase('ru');
      document.querySelectorAll('.adm-text-row').forEach((row) => { row.hidden = !row.dataset.search.includes(query); });
    });
    document.querySelectorAll('#admTabs .adm-tab').forEach((b) =>
      b.addEventListener('click', () => { adminTab = b.dataset.tab; haptic('light'); syncAdminTabs(); })
    );
    const closeBtn = $('#adminSheetClose');
    if (closeBtn) closeBtn.addEventListener('click', () => { haptic('light'); closeAdminSheet(); });
    const overlay = $('#adminSheetOverlay');
    if (overlay) overlay.addEventListener('click', closeAdminSheet);
    renderStarInput($('#admRevRating'), S.adminReviewRating, (v) => { S.adminReviewRating = v; });
    const revNow = $('#admRevNow');
    if (revNow) revNow.addEventListener('click', () => {
      const atEl = $('#admRevAt');
      if (atEl) atEl.value = toDatetimeLocal(Date.now());
      const err = $('#admRevErr');
      if (err) err.textContent = '';
      haptic('light');
    });
    const revCancel = $('#admRevCancel');
    if (revCancel) revCancel.addEventListener('click', () => { haptic('light'); resetAdminReviewForm(); });
    const revReset = $('#admRevEditReset');
    if (revReset) revReset.addEventListener('click', () => { haptic('light'); resetAdminReviewForm(); });
    const revAdd = $('#admRevAdd');
    if (revAdd) revAdd.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const err = $('#admRevErr');
      if (err) err.textContent = '';
      const atRaw = ($('#admRevAt') && $('#admRevAt').value || '').trim();
      const atTs = fromDatetimeLocal(atRaw);
      if (atRaw && !Number.isFinite(atTs)) {
        if (err) err.textContent = 'Некорректная дата и время отзыва.';
        return;
      }
      btn.disabled = true;
      haptic('medium');
      try {
        const body = {
          name: ($('#admRevName').value || '').trim(),
          rating: S.adminReviewRating || 5,
          text: ($('#admRevText').value || '').trim(),
          ...(atTs != null ? { at: atTs } : {}),
        };
        if (S.adminReviewEditId != null) {
          await api('/api/admin/reviews/' + encodeURIComponent(S.adminReviewEditId), { method: 'PUT', body });
          toast('Отзыв обновлён ✅');
          resetAdminReviewForm();
        } else {
          await api('/api/admin/reviews', { method: 'POST', body });
          $('#admRevName').value = '';
          $('#admRevText').value = '';
          if ($('#admRevAt')) $('#admRevAt').value = '';
          toast('Отзыв добавлен ✅');
        }
        await loadAdminReviews();
        S.reviews = null;
        if (S.tab === 'reviews') renderReviews(true);
      } catch (e) {
        if (err) err.textContent = e.message || 'Не удалось сохранить отзыв';
      } finally {
        btn.disabled = false;
      }
    });
    ['#admRevName', '#admRevText', '#admRevAt'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('input', () => { const err = $('#admRevErr'); if (err) err.textContent = ''; });
    });

    // Промокоды: генерация, предпросмотр, создание и редактирование
    const promoGen = $('#admPromoGen');
    if (promoGen) promoGen.addEventListener('click', () => {
      const codeEl = $('#admPromoCode');
      if (codeEl) codeEl.value = generatePromoCode();
      const err = $('#admPromoErr');
      if (err) err.textContent = '';
      haptic('light');
    });
    const promoPercentEl = $('#admPromoPercent');
    if (promoPercentEl) promoPercentEl.addEventListener('input', updateAdminPromoPreview);
    ['#admPromoCode', '#admPromoPercent', '#admPromoMaxUses', '#admPromoMinUnits', '#admPromoExpires'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('input', () => { const err = $('#admPromoErr'); if (err) err.textContent = ''; });
    });
    const promoCancel = $('#admPromoCancel');
    if (promoCancel) promoCancel.addEventListener('click', () => { haptic('light'); resetAdminPromoForm(); });
    const promoReset = $('#admPromoEditReset');
    if (promoReset) promoReset.addEventListener('click', () => { haptic('light'); resetAdminPromoForm(); });
    const promoSave = $('#admPromoSave');
    if (promoSave) promoSave.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const err = $('#admPromoErr');
      if (err) err.textContent = '';
      const expRaw = ($('#admPromoExpires') && $('#admPromoExpires').value || '').trim();
      const expTs = fromDatetimeLocal(expRaw);
      if (expRaw && !Number.isFinite(expTs)) {
        if (err) err.textContent = 'Некорректная дата окончания промокода.';
        return;
      }
      const maxRaw = ($('#admPromoMaxUses') && $('#admPromoMaxUses').value || '').trim();
      const minRaw = ($('#admPromoMinUnits') && $('#admPromoMinUnits').value || '').trim();
      const body = {
        code: ($('#admPromoCode') && $('#admPromoCode').value || '').trim().toUpperCase(),
        percent: ($('#admPromoPercent') && $('#admPromoPercent').value || '').trim(),
        maxUses: maxRaw === '' ? null : Number(maxRaw),
        minUnits: minRaw === '' ? null : Number(minRaw),
        expiresAt: expRaw === '' ? null : expTs,
      };
      btn.disabled = true;
      haptic('medium');
      try {
        if (S.adminPromoEditId != null) {
          await api('/api/admin/promos/' + encodeURIComponent(S.adminPromoEditId), { method: 'PUT', body });
          toast('Промокод обновлён ✅');
          resetAdminPromoForm();
        } else {
          const r = await api('/api/admin/promos', { method: 'POST', body });
          toast(`Промокод ${r.promo.code} создан ✅`);
          resetAdminPromoForm();
        }
        await loadAdminPromos();
      } catch (e) {
        if (err) err.textContent = e.message || 'Не удалось сохранить промокод';
      } finally {
        btn.disabled = false;
      }
    });
    $('#admGiftSave').addEventListener('click', (e) => {
      e.currentTarget.disabled = true;
      haptic('medium');
      // Собираем индивидуальную скидку каждой карты — меняется только то, что отредактировал оператор.
      const cardFees = {};
      $('#admGiftFees').querySelectorAll('[data-fee-input]').forEach((input) => {
        cardFees[input.dataset.feeInput] = input.value === '' ? 0 : Number(input.value);
      });
      saveAdmin(
        { cardFees },
        $('#admGiftErr'),
        'Курсы карт сохранены ✅'
      ).finally(() => { $('#admGiftSave').disabled = false; });
    });
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
          toast(n > 0 ? `Приём открыт 🟢 — объявление отправлено ${n} клиентам ✅` : 'Приём открыт 🟢 — обмен доступен всем ✅');
        } else {
          toast('Приём закрыт 🔴 — заявки на паузе');
        }
      } catch (err) {
        toast(err.message || 'Не удалось изменить статус приёма');
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

  // Switch the bottom menu tab (for buttons inside screens).
  function goTab(tab) {
    S.tab = tab;
    haptic('light');
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + tab).classList.remove('hidden');
    renderNav();
    if (tab === 'history') renderHistory();
    if (tab === 'reviews') renderReviews();
    if (tab === 'profile') renderProfile();
    if (tab === 'support') renderSupport();
    syncTgBack();
  }

  /* ---------- support chat ---------- */
  function renderSupport() {
    const v = $('#view-support');
    v.innerHTML = `
      <div class="card">
        <div class="card-title">Чат поддержки</div>
        <div class="about" style="font-size:12px;color:var(--mut);margin-bottom:10px">Задайте вопрос оператору — отвечаем онлайн, обычно за 1–3 минуты.</div>
        <div class="chat-box" id="chatBox">
          <div class="chat-empty" id="chatEmpty">Напишите сообщение — мы на связи 24/7</div>
          <div class="chat-list" id="chatList"></div>
        </div>
        <div class="chat-input">
          <textarea id="chatInput" placeholder="Напишите сообщение…" rows="1" maxlength="2000"></textarea>
          <button class="btn btn-primary btn-sm" id="btnSendChat">${ICONS.send}</button>
        </div>
        <div class="f-hint" style="margin-top:8px">Поддержка отвечает в этом чате и в Telegram. Никогда не сообщайте приватные ключи.</div>
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
      if (!S.order) return toast('Сначала создайте заявку');
      const o = S.order;
      haptic('medium');
      if (o.status === 'new' && isGiftOrder(o)) {
        // Demo: the operator joins the order — after that the client can send the code.
        const r = await api(`/api/admin/order/${o.id}/connect`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор подключился — клиент может отправить код (демо)');
      } else if (o.status === 'details' && isGiftOrder(o)) {
        toast('Оператор на связи — ждём код карты от клиента');
      } else if (!isGiftOrder(o)) {
        toast('Поддерживаются только заявки «карта USD → BTC»');
      } else if (o.status === 'paid') {
        const r = await api(`/api/admin/order/${o.id}/confirm`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор подтвердил выплату (демо)');
      } else if (o.status === 'completed') {
        const url = prompt('Ссылка на блокчейн (необязательно):', o.txUrl || 'https://blockchair.com/bitcoin/transaction/');
        if (url) {
          const r = await api(`/api/admin/order/${o.id}/tx`, { method: 'POST', body: { txUrl: url } });
          S.order = r.order;
          renderOrderStage();
          toast('Ссылка сохранена (демо)');
        }
      } else if (o.status === 'details') {
        toast('Теперь клиент нажимает «Я оплатил»');
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
      if (S.order === current) syncStatus('⚠️ Не удалось обновить заявку. Переподключаемся автоматически…');
    }
  }

  async function pollSettings() {
    const s = await api('/api/settings');
    if (JSON.stringify(s) !== JSON.stringify(S.settings)) {
      S.settings = s;
      applyCopy();
      renderHeader();
      renderFormMeta();
      if (S.tab === 'reviews') renderReviews();
      if (S.tab === 'profile') renderProfile();
    }
  }

  async function pollProfile() {
    if (S.tab !== 'history' && S.tab !== 'reviews' && S.tab !== 'profile') return;
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
    else if (S.tab === 'reviews') renderReviews();
    else if (S.tab === 'profile') renderProfile();
  }

  function startPolling() {
    const running = new Set();
    const refresh = () => Promise.all([pollOrder, pollSettings, pollProfile, () => pollSupport(false)].map(async (poll) => {
      if (typeof poll !== 'function') return;
      if (running.has(poll)) return;
      running.add(poll);
      try { await poll(); }
      catch (e) { console.warn('[Pricelex Worldwide] Refresh failed:', e.message); }
      finally { running.delete(poll); }
    }));
    setInterval(refresh, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', refresh);
    if (tg && tg.onEvent) tg.onEvent('activated', refresh);
  }

  // Telegram system back button and Escape on an external keyboard.
  if (tg && tg.BackButton && tg.BackButton.onClick) {
    try { tg.BackButton.onClick(onTgBackButton); } catch (e) { /* older clients */ }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (S.reviewOpen) closeReviewSheet(); else if (S.adminOpen) closeAdminSheet(); else if (S.giftRules) giftRulesClose(); else if (S.sheet) closeAssetSheet(); }
  });
  // The bottom asset-selection sheet — one-time binding (it lives in index.html, outside #view-exchange).
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
  const revClose = $('#reviewSheetClose');
  if (revClose) revClose.addEventListener('click', () => { haptic('light'); closeReviewSheet(); });
  const revOverlay = $('#reviewSheetOverlay');
  if (revOverlay) revOverlay.addEventListener('click', closeReviewSheet);
  const revCancel = $('#reviewCancel');
  if (revCancel) revCancel.addEventListener('click', () => { haptic('light'); closeReviewSheet(); });
  const revSubmit = $('#reviewSubmit');
  if (revSubmit) revSubmit.addEventListener('click', submitReview);
  const revText = $('#reviewText');
  if (revText) revText.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitReview();
  });
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
      try { syncStatus('⚠️ Не удалось связаться с сервером. Обновите страницу.'); } catch (_) {}
      hidePreloader();
      return;
    }
    renderHeader();
    renderNav();
    renderExchange();
    renderHistory();
    renderReviews();
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
