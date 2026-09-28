const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Изолированная база для тестов
function makeTmpDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelex-test-'));
  return dir;
}

test('exchanger isolation: один партнёр не может видеть данные другого', async () => {
  const tmpDir = makeTmpDataDir();
  process.env.DATA_DIR = tmpDir;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/exchangers')];
  delete require.cache[require.resolve('../src/deposits')];
  delete require.cache[require.resolve('../src/claims')];
  delete require.cache[require.resolve('../src/audit')];
  delete require.cache[require.resolve('../src/walletProvider')];
  const store = require('../src/store');
  const exchangers = require('../src/exchangers');
  const deposits = require('../src/deposits');

  // создаём двух обменников
  const ex1 = exchangers.createExchanger({
    tgId: '1001',
    legal: {
      companyName: 'Exchanger One LLC',
      legalAddress: 'Test address 1',
      contactEmail: 'one@example.com',
      publicBtcAddresses: ['bc1qtestaddressone1234567890abcde'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Alice', role: 'Director', basis: 'Charter' }],
    },
  });
  const ex2 = exchangers.createExchanger({
    tgId: '1002',
    legal: {
      companyName: 'Exchanger Two LLC',
      legalAddress: 'Test address 2',
      contactEmail: 'two@example.com',
      publicBtcAddresses: ['bc1qtestaddresstwo1234567890abcd'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Bob', role: 'Director', basis: 'Charter' }],
    },
  });

  // Попытка получить чужой обменник через assertOwnership должна падать
  assert.throws(() => exchangers.assertOwnership(ex1.id, '1002'), /Доступ запрещён/);
  assert.throws(() => exchangers.assertOwnership(ex2.id, '1001'), /Доступ запрещён/);
  // Свой — ок
  assert.doesNotThrow(() => exchangers.assertOwnership(ex1.id, '1001'));

  // Депозиты изолированы
  deposits.createDeposit({ exchangerId: ex1.id, amountBtc: 0.01, confirmations: 3 });
  deposits.createDeposit({ exchangerId: ex2.id, amountBtc: 0.02, confirmations: 3 });
  assert.equal(deposits.getAvailableBalance(ex1.id), 0.01);
  assert.equal(deposits.getAvailableBalance(ex2.id), 0.02);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('manual approval required: нельзя торговать до ручного одобрения', async () => {
  const tmpDir = makeTmpDataDir();
  process.env.DATA_DIR = tmpDir;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/exchangers')];
  delete require.cache[require.resolve('../src/deposits')];
  delete require.cache[require.resolve('../src/claims')];
  delete require.cache[require.resolve('../src/audit')];
  delete require.cache[require.resolve('../src/walletProvider')];
  delete require.cache[require.resolve('../src/subscriptions')];
  const store = require('../src/store');
  const exchangers = require('../src/exchangers');
  const walletProvider = require('../src/walletProvider');

  const ex = exchangers.createExchanger({
    tgId: '2001',
    legal: {
      companyName: 'Pending Ex',
      legalAddress: 'Test address long enough for validation',
      contactEmail: 'p@example.com',
      publicBtcAddresses: ['bc1qpendingaddress1234567890abc'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Carol', role: 'CEO', basis: 'Agreement' }],
    },
  });
  assert.equal(ex.status, 'pending');
  assert.equal(exchangers.canTrade(ex.id).ok, false);
  assert.equal(exchangers.canTrade(ex.id).reason, 'not_approved');

  // После ручного одобрения — всё ещё нельзя без кошелька
  exchangers.updateExchangerStatus(ex.id, 'approved', 'admin1', 'Одобрено вручную с мотивировкой');
  assert.equal(exchangers.canTrade(ex.id).ok, false);
  assert.equal(exchangers.canTrade(ex.id).reason, 'no_wallet');

  // Создаём кошелёк через провайдера (mock, realLock=false)
  await exchangers.createWalletForExchanger(ex.id, 'admin1');
  const afterWallet = exchangers.getExchangerById(ex.id);
  assert.ok(afterWallet.wallet);
  assert.equal(afterWallet.wallet.isRealLock, false); // mock не обеспечивает реальную блокировку

  // В тестовом режиме mainnet выключен — торговля всё равно выключена
  const tradeCheck = exchangers.canTrade(ex.id);
  assert.equal(tradeCheck.ok, false);
  assert.ok(['trading_disabled_no_provider', 'subscription_required', 'trading_not_enabled'].includes(tradeCheck.reason));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('data freshness: marketplace помечает устаревшие данные', async () => {
  const tmpDir = makeTmpDataDir();
  process.env.DATA_DIR = tmpDir;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/exchangers')];
  delete require.cache[require.resolve('../src/deposits')];
  delete require.cache[require.resolve('../src/claims')];
  delete require.cache[require.resolve('../src/audit')];
  delete require.cache[require.resolve('../src/walletProvider')];
  delete require.cache[require.resolve('../src/subscriptions')];
  delete require.cache[require.resolve('../src/marketplace')];
  const store = require('../src/store');
  const exchangers = require('../src/exchangers');
  const marketplace = require('../src/marketplace');

  const ex = exchangers.createExchanger({
    tgId: '3001',
    legal: {
      companyName: 'Fresh Ex',
      legalAddress: 'Test address long enough for validation',
      contactEmail: 'fresh@example.com',
      publicBtcAddresses: ['bc1qfreshaddress1234567890abcde'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Dave', role: 'Owner', basis: 'Charter' }],
    },
  });
  exchangers.updateExchangerStatus(ex.id, 'approved', 'admin1', 'Одобрено');

  // Без rateUpdatedAt — isStale true
  store.mutate((db) => { db.settings.rateUpdatedAt = null; db.settings.rateSource = 'manual'; });
  let offers = marketplace.getOffers();
  assert.equal(offers.length, 1);
  assert.equal(offers[0].isStale, true);
  assert.ok(offers[0].source);

  // Свежий курс — не stale
  store.mutate((db) => { db.settings.rateUpdatedAt = Date.now(); db.settings.rateSource = 'coingecko'; });
  offers = marketplace.getOffers();
  assert.equal(offers[0].isStale, false);
  assert.equal(offers[0].source, 'coingecko');
  assert.ok(offers[0].updatedAt);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('deposit over-limit prohibition: нельзя зарезервировать больше доступного', async () => {
  const tmpDir = makeTmpDataDir();
  process.env.DATA_DIR = tmpDir;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/exchangers')];
  delete require.cache[require.resolve('../src/deposits')];
  delete require.cache[require.resolve('../src/claims')];
  delete require.cache[require.resolve('../src/audit')];
  delete require.cache[require.resolve('../src/walletProvider')];
  const exchangers = require('../src/exchangers');
  const deposits = require('../src/deposits');

  const ex = exchangers.createExchanger({
    tgId: '4001',
    legal: {
      companyName: 'Limit Ex',
      legalAddress: 'Test address long enough for validation',
      contactEmail: 'limit@example.com',
      publicBtcAddresses: ['bc1qlimitaddress1234567890abcde'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Eve', role: 'CEO', basis: 'Charter' }],
    },
  });
  exchangers.updateExchangerStatus(ex.id, 'approved', 'admin1', 'ok');
  deposits.createDeposit({ exchangerId: ex.id, amountBtc: 0.01, confirmations: 3 });

  // Попытка зарезервировать больше — должна падать
  assert.throws(() => deposits.reserveForOrder({ exchangerId: ex.id, orderId: 'order1', amountBtc: 0.02 }), /Недостаточно доступного депозита/);
  // Ровно доступное — ок
  const reserved = deposits.reserveForOrder({ exchangerId: ex.id, orderId: 'order1', amountBtc: 0.01 });
  assert.equal(reserved.length, 1);
  assert.equal(deposits.getAvailableBalance(ex.id), 0);
  assert.equal(deposits.getReservedBalance(ex.id), 0.01);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('double reservation prevention', async () => {
  const tmpDir = makeTmpDataDir();
  process.env.DATA_DIR = tmpDir;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/exchangers')];
  delete require.cache[require.resolve('../src/deposits')];
  delete require.cache[require.resolve('../src/claims')];
  delete require.cache[require.resolve('../src/audit')];
  delete require.cache[require.resolve('../src/walletProvider')];
  const exchangers = require('../src/exchangers');
  const deposits = require('../src/deposits');

  const ex = exchangers.createExchanger({
    tgId: '5001',
    legal: {
      companyName: 'Double Ex',
      legalAddress: 'Test address long enough for validation',
      contactEmail: 'double@example.com',
      publicBtcAddresses: ['bc1qdoubleaddress1234567890abc'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Frank', role: 'CEO', basis: 'Charter' }],
    },
  });
  exchangers.updateExchangerStatus(ex.id, 'approved', 'admin1', 'ok');
  deposits.createDeposit({ exchangerId: ex.id, amountBtc: 0.05, confirmations: 3 });

  deposits.reserveForOrder({ exchangerId: ex.id, orderId: 'orderA', amountBtc: 0.01 });
  // Повторный резерв на тот же orderId — запрещён
  assert.throws(() => deposits.reserveForOrder({ exchangerId: ex.id, orderId: 'orderA', amountBtc: 0.01 }), /уже зарезервирован/);
  // Другой orderId — можно, пока хватает
  deposits.reserveForOrder({ exchangerId: ex.id, orderId: 'orderB', amountBtc: 0.01 });
  assert.equal(deposits.getReservedBalance(ex.id), 0.02);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('reserve hold on open dispute: при отмене и обращении резерв не освобождается таймером', async () => {
  const tmpDir = makeTmpDataDir();
  process.env.DATA_DIR = tmpDir;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/exchangers')];
  delete require.cache[require.resolve('../src/deposits')];
  delete require.cache[require.resolve('../src/claims')];
  delete require.cache[require.resolve('../src/audit')];
  delete require.cache[require.resolve('../src/walletProvider')];
  delete require.cache[require.resolve('../src/subscriptions')];
  const exchangers = require('../src/exchangers');
  const deposits = require('../src/deposits');
  const claims = require('../src/claims');
  const store = require('../src/store');

  const ex = exchangers.createExchanger({
    tgId: '6001',
    legal: {
      companyName: 'Dispute Ex',
      legalAddress: 'Test address long enough for validation',
      contactEmail: 'dispute@example.com',
      publicBtcAddresses: ['bc1qdisputeaddress1234567890ab'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Grace', role: 'CEO', basis: 'Charter' }],
    },
  });
  exchangers.updateExchangerStatus(ex.id, 'approved', 'admin1', 'ok');
  deposits.createDeposit({ exchangerId: ex.id, amountBtc: 0.02, confirmations: 3 });

  // Создаём заявку
  const order = store.createOrder({ userId: 'user1', rub: 10000, currency: 'BTC', crypto: 0.001, wallet: 'bc1qtestwallet', exchangerId: ex.id });
  deposits.reserveForOrder({ exchangerId: ex.id, orderId: order.id, amountBtc: 0.001 });

  // Пользователь отменил и подал обращение
  store.updateOrder(order.id, { status: 'cancelled' });
  const claim = claims.createClaim({ orderId: order.id, userId: 'user1', exchangerId: ex.id, reason: 'btc_not_received', description: 'Не пришёл BTC' });

  // Попытка освободить по таймеру — должна падать
  assert.throws(() => deposits.releaseForOrder(ex.id, order.id), /открытое обращение/);
  // Резерв всё ещё в claim_pending
  assert.equal(deposits.getDeposits(ex.id).some((d) => d.orderId === String(order.id) && d.status === 'claim_pending'), true);

  // После решения человека (отклонено) — можно освободить принудительно
  claims.reviewClaim({ claimId: claim.id, reviewerId: 'admin1', decision: 'rejected', motivation: 'Проверено, выплата была, мотивировка обязательна, минимум 10 символов.' });
  // При отклонении reserve остаётся? Логика — после отклонения можно освободить вручную
  // Форс-освобождение
  deposits.forceReleaseForOrder(ex.id, order.id);
  assert.equal(deposits.getReservedBalance(ex.id), 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('no auto payouts: подача обращения не запускает выплату', async () => {
  const tmpDir = makeTmpDataDir();
  process.env.DATA_DIR = tmpDir;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/exchangers')];
  delete require.cache[require.resolve('../src/deposits')];
  delete require.cache[require.resolve('../src/claims')];
  delete require.cache[require.resolve('../src/audit')];
  delete require.cache[require.resolve('../src/walletProvider')];
  delete require.cache[require.resolve('../src/subscriptions')];
  const exchangers = require('../src/exchangers');
  const deposits = require('../src/deposits');
  const claims = require('../src/claims');
  const store = require('../src/store');

  const ex = exchangers.createExchanger({
    tgId: '7001',
    legal: {
      companyName: 'NoAuto Ex',
      legalAddress: 'Test address long enough for validation',
      contactEmail: 'noauto@example.com',
      publicBtcAddresses: ['bc1qnoautoaddress1234567890abc'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Heidi', role: 'CEO', basis: 'Charter' }],
    },
  });
  exchangers.updateExchangerStatus(ex.id, 'approved', 'admin1', 'ok');
  deposits.createDeposit({ exchangerId: ex.id, amountBtc: 0.02, confirmations: 3 });
  const order = store.createOrder({ userId: 'user2', rub: 15000, currency: 'BTC', crypto: 0.0015, wallet: 'bc1qtestwallet2', exchangerId: ex.id });
  deposits.reserveForOrder({ exchangerId: ex.id, orderId: order.id, amountBtc: 0.0015 });

  const claim = claims.createClaim({ orderId: order.id, userId: 'user2', exchangerId: ex.id, reason: 'btc_not_received' });
  // После создания — статус open, выплаты нет
  assert.equal(claim.status, 'open');
  assert.equal(claim.payout, null);

  // Попытка подтвердить выплату без решения — должна падать
  assert.throws(() => claims.confirmPayout({ claimId: claim.id, actorId: 'admin1', amountBtc: 0.001, txId: 'tx123', confirmationText: 'ПОДТВЕРЖДАЮ ВЫПЛАТУ' }), /только после одобрения/);

  // Решение с обязательной мотивировкой
  assert.throws(() => claims.reviewClaim({ claimId: claim.id, reviewerId: 'admin1', decision: 'approved', motivation: 'short' }), /Мотивировка/);
  const reviewed = claims.reviewClaim({ claimId: claim.id, reviewerId: 'admin1', decision: 'approved', motivation: 'Изучены материалы, запрошена информация, BTC действительно не пришёл. Мотивировка обязательна.' });
  assert.equal(reviewed.status, 'approved');
  assert.equal(reviewed.payout, null); // всё ещё нет автовыплаты

  // Выплата — отдельное действие с явным подтверждением
  assert.throws(() => claims.confirmPayout({ claimId: claim.id, actorId: 'admin1', amountBtc: 0.001, txId: 'tx123', confirmationText: 'не то' }), /ПОДТВЕРЖДАЮ ВЫПЛАТУ/);
  const paid = claims.confirmPayout({ claimId: claim.id, actorId: 'admin1', amountBtc: 0.001, txId: 'tx123', confirmationText: 'ПОДТВЕРЖДАЮ ВЫПЛАТУ' });
  assert.equal(paid.status, 'paid');
  assert.ok(paid.payout);
  assert.equal(paid.payout.amountBtc, 0.001);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('wallet provider does not handle seed/private keys', async () => {
  const walletProvider = require('../src/walletProvider');
  const provider = walletProvider.getProvider('mock');
  const info = walletProvider.getProviderInfo();
  assert.equal(info.realLockSupported, false);
  assert.equal(info.mainnetEnabled, false);
  assert.ok(info.note.includes('seed') || info.note.includes('блокировк') || info.note.includes('тестовый'));
  // Проверяем, что createWallet не требует seed
  const w = await provider.createWallet('test-ex-1');
  assert.ok(w.address);
  assert.ok(!w.seed);
  assert.ok(!w.privateKey);
  assert.ok(!w.mnemonic);
});

test('exchanger registration rejects seed/private key fields', async () => {
  const tmpDir = makeTmpDataDir();
  process.env.DATA_DIR = tmpDir;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/exchangers')];
  delete require.cache[require.resolve('../src/deposits')];
  delete require.cache[require.resolve('../src/claims')];
  delete require.cache[require.resolve('../src/audit')];
  delete require.cache[require.resolve('../src/walletProvider')];
  const exchangers = require('../src/exchangers');

  assert.throws(() => exchangers.createExchanger({
    tgId: '8001',
    legal: {
      companyName: 'Bad Ex',
      legalAddress: 'Test address long enough for validation',
      contactEmail: 'bad@example.com',
      publicBtcAddresses: ['bc1qbadaddress1234567890abcde'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Ivan', role: 'CEO', basis: 'Charter' }],
      seed: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    },
  }), /запрещено|seed/);

  assert.throws(() => exchangers.createExchanger({
    tgId: '8002',
    legal: {
      companyName: 'Bad Ex2',
      legalAddress: 'Test address long enough for validation',
      contactEmail: 'bad2@example.com',
      publicBtcAddresses: ['L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nU1kSbkxR2A'],
      networks: ['BTC'],
      keyHolders: [{ name: 'Ivan', role: 'CEO', basis: 'Charter' }],
      privateKey: '5KJvsngHeMpm884wtkJNzQGaCErckhHJBGFsvd3VyK5qMZXj3hS',
    },
  }), /публичный|запрещено|приватный/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
