// Маркетплейс и актуальные данные.
// Показываем предложения обменников и сравнение доступных параметров.
// Для каждого значения отображаем источник и время обновления.
// Устаревшие или недоступные данные помечаем явно, не выдаём их за текущий курс
// и не гарантируем исполнение по показанной цене.
// Не добавляем автоматический матчинг, принятие поручений, маршрутизацию платежа
// или совершение обмена, если этого нет в утверждённой модели.
// Не придумываем курсы, лимиты, сроки, комиссии, способы оплаты и условия отказа.

const store = require('./store');
const exchangers = require('./exchangers');

function getOffers() {
  const now = Date.now();
  const settings = store.get().settings;
  const approved = exchangers.listApprovedExchangersForMarketplace();

  // Для каждого обменника — параметры с источником и временем
  return approved.map((ex) => {
    const staleThreshold = 5 * 60 * 1000;
    const rateAge = ex.rateUpdatedAt ? now - ex.rateUpdatedAt : Infinity;
    const isStale = rateAge > staleThreshold || ex.isStale;
    return {
      id: ex.id,
      companyName: ex.companyName,
      login: ex.login,
      networks: ex.networks,
      publicBtcAddresses: ex.publicBtcAddresses,
      legal: { companyName: ex.companyName },
      // Flat fields for backward compatibility with UI that expects simple structure
      rate: ex.rateBTC,
      source: ex.rateSource,
      updatedAt: ex.rateUpdatedAt,
      isStale,
      deposit: { available: 0, reserved: 0, confirmationRule: { required: 3, realLockSupported: false } },
      walletProvider: { provider: 'mock', mainnetEnabled: false, note: 'тестовый режим' },
      // Nested detailed fields
      minRub: {
        value: ex.minRub,
        source: 'exchanger_settings',
        updatedAt: ex.createdAt,
        isStale: false,
      },
      maxRub: {
        value: ex.maxRub,
        source: 'exchanger_settings',
        updatedAt: ex.createdAt,
        isStale: false,
      },
      rateBTC: {
        value: ex.rateBTC,
        source: ex.rateSource,
        updatedAt: ex.rateUpdatedAt,
        isStale,
        note: isStale ? 'Данные устарели — не гарантируем исполнение по показанной цене' : null,
      },
      rateGRAM: {
        value: ex.rateGRAM,
        source: ex.rateSource,
        updatedAt: ex.rateUpdatedAt,
        isStale,
        note: isStale ? 'Данные устарели — не гарантируем исполнение по показанной цене' : null,
      },
      guaranteeFundBtc: {
        value: settings.guaranteeFundBtc,
        source: 'platform_settings',
        updatedAt: settings.rateUpdatedAt,
      },
      // Не гарантируем исполнение по показанной цене — явно указываем
      disclaimer: 'Курс и лимиты — справочно, актуальность зависит от источника. Исполнение по показанной цене не гарантируется.',
    };
  });
}

function getOfferComparison() {
  const offers = getOffers();
  if (!offers.length) return { offers: [], best: null, disclaimer: 'Нет доступных предложений' };
  // Сравнение доступных параметров — без автоматического матчинга
  const sortedByRate = offers.slice().sort((a, b) => (a.rateBTC.value || 0) - (b.rateBTC.value || 0));
  return {
    offers,
    comparison: {
      cheapestBTC: sortedByRate[0] ? { id: sortedByRate[0].id, rate: sortedByRate[0].rateBTC } : null,
      count: offers.length,
    },
    disclaimer: 'Сравнение — справочно, не является автоматическим матчингом или принятием поручений.',
  };
}

module.exports = { getOffers, getOfferComparison };
