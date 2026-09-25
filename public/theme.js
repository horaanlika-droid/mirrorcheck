/* PRICELEX · тема оформления: тёмная, светлая и «авто».
   Слой theme.css переключает палитру по <html data-theme="dark|light">.
   Приоритет разрешения: сохранённый выбор клиента → тема Telegram
   (WebApp.colorScheme и событие themeChanged) → системная
   prefers-color-scheme → тёмная. Скрипт выполняется в <head> до стилей,
   поэтому первая отрисовка сразу идёт в нужной теме, без мигания. */
(() => {
  'use strict';

  const KEY = 'pricelex_theme';
  const MODES = ['dark', 'light', 'system'];
  // Цвет хромированныx панелей Telegram и meta theme-color под каждую тему.
  const CHROME = { dark: '#080d11', light: '#f6f5f2' };

  const tgApp = () => (window.Telegram && window.Telegram.WebApp) || null;

  // Чистое разрешение режима в «dark»/«light» — его гоняют тесты без браузера.
  function resolve(mode, env = {}) {
    if (mode === 'dark' || mode === 'light') return mode;
    const tgScheme = String(env.telegramScheme || '').toLowerCase();
    if (tgScheme === 'dark' || tgScheme === 'light') return tgScheme;
    const system = String(env.systemScheme || '').toLowerCase();
    if (system === 'dark' || system === 'light') return system;
    return 'dark';
  }

  function envNow() {
    const tg = tgApp();
    let systemScheme = '';
    try {
      if (window.matchMedia) {
        systemScheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
    } catch (e) { /* старые WebView без matchMedia */ }
    return {
      telegramScheme: (tg && tg.colorScheme) || '',
      systemScheme,
    };
  }

  function readMode() {
    try {
      const saved = localStorage.getItem(KEY);
      return MODES.includes(saved) ? saved : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function writeMode(mode) {
    try {
      localStorage.setItem(KEY, mode);
    } catch (e) { /* приватный режим — выбор живёт до закрытия вкладки */ }
  }

  const listeners = new Set();
  const state = { mode: 'system', theme: 'dark' };

  function paint() {
    const root = document.documentElement;
    if (root && root.setAttribute) {
      root.setAttribute('data-theme', state.theme);
      root.setAttribute('data-theme-mode', state.mode);
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', CHROME[state.theme]);
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute('content', state.theme);
    const tg = tgApp();
    if (tg) {
      try {
        if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor(CHROME[state.theme]);
        if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor(CHROME[state.theme]);
      } catch (e) { /* до ready() Telegram цвета не принимает */ }
    }
  }

  function apply(mode, opts = {}) {
    if (MODES.includes(mode)) state.mode = mode;
    state.theme = resolve(state.mode, opts.env || envNow());
    if (opts.persist !== false) writeMode(state.mode);
    paint();
    listeners.forEach((fn) => {
      try { fn({ mode: state.mode, theme: state.theme }); } catch (e) { /* слушатель не ломает тему */ }
    });
    return { mode: state.mode, theme: state.theme };
  }

  state.mode = readMode();
  state.theme = resolve(state.mode, envNow());
  paint();

  // Telegram переключает тему на лету — следуем, пока клиент не выбрал сам.
  const tg = tgApp();
  if (tg && typeof tg.onEvent === 'function') {
    try {
      tg.onEvent('themeChanged', () => {
        if (state.mode === 'system') apply('system', { persist: false });
      });
    } catch (e) { /* старые версии Web App без событий */ }
  }

  // То же для системной темы в обычном браузере.
  try {
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => {
        const app = tgApp();
        if (state.mode === 'system' && !((app && app.colorScheme) || '')) apply('system', { persist: false });
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (e) { /* matchMedia недоступен */ }

  // Приложению и тестам — управление темой без знания внутренних деталей.
  window.PRICELEX_THEME = {
    MODES,
    CHROME,
    resolve,
    envNow,
    apply: (mode, opts) => apply(mode, opts),
    set: (mode) => apply(mode),
    get: () => ({ mode: state.mode, theme: state.theme }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
