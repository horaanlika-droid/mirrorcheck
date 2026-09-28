// Интерфейс wallet-провайдера и тестовый режим.
// Требование: автоматическая выдача кошелька и заморозка должны быть реальными,
// а не только статусом в интерфейсе. Используем только существующий
// wallet-провайдер/хранителя с документированной интеграцией и фактической
// поддержкой нужной блокировки. Не создаём приложение, которое само генерирует
// или хранит seed-фразы/приватные ключи.
// В проекте нет подходящего провайдера с подтверждённой блокировкой, поэтому
// реализован интерфейс провайдера и тестовый режим; реальные mainnet-депозиты,
// автозаморозка и торговля остаются выключенными. Пользователю не показывается,
// что деньги заморожены, если блокировки фактически нет.
// Не путать публичный BTC-адрес с приватным ключом. Seed-фраза может быть
// доверена инициатором уполномоченным лицам, но приложение не собирает,
// не отображает, не хранит и не пересылает её. Фиксируются только имена/роли
// держателей ключа и основание полномочий — без самого секрета.

const store = require('./store');

// Конфигурация: только тестовый режим.
// WALLET_PROVIDER — имя провайдера, WALLET_MAINNET_ENABLED — feature flag.
// Реальные mainnet-депозиты выключены до отдельного подтверждения механизма блокировки.
const PROVIDER_NAME = (process.env.WALLET_PROVIDER || 'mock').trim() || 'mock';
const MAINNET_ENABLED = process.env.WALLET_MAINNET_ENABLED === '1'; // по умолчанию выключено
const CONFIRMATIONS_REQUIRED = Math.max(1, Number(process.env.WALLET_CONFIRMATIONS) || 3);

// Документированная интеграция: интерфейс, который должен реализовать провайдер.
class WalletProviderInterface {
  // Создать отдельный адрес/кошелёк для обменника.
  // Должен вызываться только через уже имеющегося проверенного wallet-провайдера
  // с подходящей функцией блокировки. Возвращает { walletId, address, network, provider }.
  async createWallet(exchangerId) { throw new Error('not implemented'); }
  // Получить баланс по адресу: { confirmed, unconfirmed, confirmations, txs }
  async getBalance(address) { throw new Error('not implemented'); }
  // Проверить возможность блокировки: возвращает { supported: boolean, mechanism: string }
  async getLockCapability() { throw new Error('not implemented'); }
  // Заблокировать сумму под сессию (резерв).
  async lock({ exchangerId, orderId, amountBtc }) { throw new Error('not implemented'); }
  // Разблокировать.
  async unlock({ reservationId }) { throw new Error('not implemented'); }
  // Получить статус блокировки.
  async getLockStatus(reservationId) { throw new Error('not implemented'); }
}

// Mock-провайдер для тестового режима. Не генерирует seed/приватные ключи,
// не хранит секреты. Адреса — детерминированные тестовые, баланс — симулированный.
class MockWalletProvider extends WalletProviderInterface {
  constructor() {
    super();
    this.name = 'mock';
    // В памяти: address -> { confirmed, unconfirmed, txs }
    this.balances = new Map();
    this.wallets = new Map(); // exchangerId -> wallet
    this.locks = new Map(); // reservationId -> { exchangerId, orderId, amountBtc, status }
    this.lockSeq = 1;
  }

  _genAddress(exchangerId) {
    // Детерминированный тестовый адрес, не связанный с реальным ключом.
    // Формат bc1q... для тестов, не используется в mainnet.
    const base = String(exchangerId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'test';
    return `bc1qmock${base}${String(Date.now()).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async createWallet(exchangerId) {
    if (!exchangerId) throw new Error('exchangerId required');
    const existing = this.wallets.get(String(exchangerId));
    if (existing) return existing;
    const wallet = {
      walletId: `mock_${exchangerId}_${Date.now()}`,
      address: this._genAddress(exchangerId),
      network: 'BTC',
      provider: this.name,
      createdAt: Date.now(),
      status: 'active',
      // Важно: реальная блокировка в mock не обеспечивается on-chain,
      // поэтому isRealLock = false. UI не должен показывать "заморожено",
      // если блокировки фактически нет.
      isRealLock: false,
      mechanism: 'mock_db_lock_only',
    };
    this.wallets.set(String(exchangerId), wallet);
    if (!this.balances.has(wallet.address)) {
      this.balances.set(wallet.address, { confirmed: 0, unconfirmed: 0, confirmations: 0, txs: [] });
    }
    return wallet;
  }

  async getWallet(exchangerId) {
    return this.wallets.get(String(exchangerId)) || null;
  }

  async getBalance(address) {
    const b = this.balances.get(address);
    if (!b) return { confirmed: 0, unconfirmed: 0, confirmations: 0, txs: [] };
    return { ...b };
  }

  // Симуляция поступления депозита в тестовом режиме.
  async simulateDeposit(address, amountBtc, confirmations = 0, txId = null) {
    if (!this.balances.has(address)) {
      this.balances.set(address, { confirmed: 0, unconfirmed: 0, confirmations: 0, txs: [] });
    }
    const bal = this.balances.get(address);
    const amt = Math.max(0, Number(amountBtc) || 0);
    if (confirmations >= CONFIRMATIONS_REQUIRED) {
      bal.confirmed = Math.round((bal.confirmed + amt) * 1e8) / 1e8;
      bal.confirmations = confirmations;
    } else {
      bal.unconfirmed = Math.round((bal.unconfirmed + amt) * 1e8) / 1e8;
      bal.confirmations = confirmations;
    }
    bal.txs.push({ txId: txId || `mock_tx_${Date.now()}`, amount: amt, confirmations, at: Date.now() });
    return { ...bal };
  }

  async getLockCapability() {
    // Mock не обеспечивает реальную on-chain блокировку.
    // Возвращаем supported=false, чтобы UI не показывал "заморожено".
    return {
      supported: false,
      mechanism: 'mock_db_lock_only',
      note: 'Реальная автоматическая блокировка должна обеспечиваться кошельком, провайдером или on-chain-механизмом, а не только статусом в базе. В тестовом режиме блокировка — только статус в БД.',
      mainnetEnabled: MAINNET_ENABLED,
    };
  }

  async lock({ exchangerId, orderId, amountBtc }) {
    const cap = await this.getLockCapability();
    // В тестовом режиме позволяем резервировать в БД, но помечаем как не реальную блокировку.
    const reservationId = `lock_${this.lockSeq++}`;
    const res = {
      reservationId,
      exchangerId: String(exchangerId),
      orderId: String(orderId),
      amountBtc: Math.round(Number(amountBtc) * 1e8) / 1e8,
      status: 'locked',
      createdAt: Date.now(),
      isRealLock: cap.supported && MAINNET_ENABLED,
      mechanism: cap.mechanism,
    };
    this.locks.set(reservationId, res);
    return res;
  }

  async unlock({ reservationId }) {
    const lock = this.locks.get(String(reservationId));
    if (!lock) throw new Error('reservation not found');
    lock.status = 'released';
    lock.releasedAt = Date.now();
    return lock;
  }

  async getLockStatus(reservationId) {
    return this.locks.get(String(reservationId)) || null;
  }
}

// Реестр провайдеров. Сейчас только mock, т.к. в проекте нет подходящего
// провайдера с подтверждённой блокировкой. Реальные mainnet-депозиты выключены.
const providers = {
  mock: new MockWalletProvider(),
};

function getProvider(name = PROVIDER_NAME) {
  return providers[name] || providers.mock;
}

function isMainnetEnabled() {
  return MAINNET_ENABLED;
}

function getConfirmationRule() {
  return { required: CONFIRMATIONS_REQUIRED, note: 'Учитывается только подтверждённый депозит; неподтверждённый баланс не считается доступным лимитом без утверждённого правила подтверждений.' };
}

function getProviderInfo() {
  return {
    provider: PROVIDER_NAME,
    mainnetEnabled: MAINNET_ENABLED,
    confirmationRule: getConfirmationRule(),
    realLockSupported: false,
    note: 'Если в проекте нет подходящего провайдера или невозможно подтвердить механизм блокировки, реализован интерфейс провайдера и тестовый режим; реальные mainnet-депозиты, автозаморозку и торговлю оставляем выключенными. Не показываем пользователю, что деньги заморожены, если блокировки фактически нет.',
  };
}

module.exports = {
  WalletProviderInterface,
  MockWalletProvider,
  getProvider,
  isMainnetEnabled,
  getConfirmationRule,
  getProviderInfo,
  PROVIDER_NAME,
};
