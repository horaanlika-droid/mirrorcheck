/* PRICELEX · размеры интерфейса под устройство: iPhone, iPad, Android.
   Определяем класс устройства и помечаем <html data-device="iphone|android|ipad"> —
   слой devices.css по этому атрибуту переключает шкалу интерфейса (ширина
   колонки, поля, кнопки, заголовки, tab bar). Широкие экраны получают
   планшетную сетку ещё и по медиазапросам, поэтому Android-планшеты и
   десктопный браузер тоже раскладываются просторно. */
(() => {
  'use strict';

  // Чистая детекция по окружению — её гоняют тесты с разными платформами.
  // platform — Telegram.WebApp.platform (ios, android, …); ua — user agent;
  // screenMin — меньшая сторона экрана; width — ширина окна; touchPoints —
  // сколько касаний поддерживает экран.
  function detect(env = {}) {
    const platform = String(env.platform || '').toLowerCase();
    const ua = String(env.ua || '');
    const screenMin = Number(env.screenMin) || 0;
    const width = Number(env.width) || 0;
    const touchPoints = Number(env.touchPoints) || 0;

    if (platform === 'android' || /android/i.test(ua)) return 'android';
    if (/ipad/i.test(ua)) return 'ipad';
    if (/iphone/i.test(ua)) return 'iphone';
    // Telegram на iOS отдаёт platform «ios» и для iPhone, и для iPad —
    // различаем по стороне экрана: у телефонов она меньше 700 px.
    if (platform === 'ios') return screenMin >= 700 || width >= 700 ? 'ipad' : 'iphone';
    // iPadOS в браузере маскируется под macOS, но знает про мультитач.
    if (/macintosh|mac os x/i.test(ua) && touchPoints > 1) return 'ipad';
    // Веб и десктоп-клиенты Telegram: широкое окно — планшетная шкала,
    // узкое — телефонная.
    return width >= 700 ? 'ipad' : 'iphone';
  }

  function envNow() {
    const tg = window.Telegram && window.Telegram.WebApp;
    const scr = window.screen || {};
    const nav = window.navigator || {};
    return {
      platform: (tg && tg.platform) || '',
      ua: nav.userAgent || '',
      screenMin: Math.min(Number(scr.width) || 0, Number(scr.height) || 0),
      width: window.innerWidth || 0,
      touchPoints: Number(nav.maxTouchPoints) || 0,
    };
  }

  function apply(env) {
    const value = detect(env || envNow());
    const root = document.documentElement;
    if (root && root.setAttribute) root.setAttribute('data-device', value);
    return value;
  }

  apply();

  // Окно браузера может перейти границу планшета — обновляем шкалу.
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => apply(), 150);
  });

  // Тестам и отладке — детекция без реального окружения браузера.
  window.PRICELEX_DEVICE = { detect, apply, envNow };
})();
