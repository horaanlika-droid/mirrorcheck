// Простая шина событий: веб-часть эмитит события заказов, бот подписывается.
const handlers = {};

module.exports = {
  on(ev, fn) {
    (handlers[ev] = handlers[ev] || []).push(fn);
  },
  async emit(ev, payload) {
    for (const fn of handlers[ev] || []) {
      try {
        await fn(payload);
      } catch (e) {
        console.error('[bus]', ev, e && e.message);
      }
    }
  },
};
