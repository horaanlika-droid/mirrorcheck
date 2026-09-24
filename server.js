const config = require('./src/config');
const store = require('./src/store');
const { startWeb } = require('./src/web');
const { startBot } = require('./src/bot');
const { startRates } = require('./src/rates');

console.log('🌌 PRICELEX | Official — BTC & GRAM Exchange');
console.log(
  `[PRICELEX] HTTP ${config.host}:${config.port} ← ${config.portSource}` +
    (process.env.SERVER_PORT ? ` SERVER_PORT=${process.env.SERVER_PORT}` : '') +
    (process.env.PORT ? ` PORT=${process.env.PORT}` : '')
);

if (config.publicUrl && store.get().settings.publicUrl !== config.publicUrl) {
  store.mutate((db) => {
    db.settings.publicUrl = config.publicUrl;
  });
  console.log('[PRICELEX] PUBLIC_URL из окружения:', config.publicUrl);
}

startWeb();
startRates();
startBot().catch((e) => {
  console.error('[PRICELEX] ошибка запуска бота:', e.message);
  console.error('[PRICELEX] сайт продолжит работать без бота.');
});

process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));
