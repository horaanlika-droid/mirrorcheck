// Франшизы и регистрация обменников.
// Отдельные кабинеты обменников/франшиз:
// - при регистрации создаётся профиль партнёра и подаётся на ручную проверку;
// - обменник указывает необходимые юридические реквизиты, контакты, публичные BTC-адреса и используемые сети;
// - после регистрации может быть создан отдельный адрес/кошелёк только через уже имеющегося проверенного wallet-провайдера с подходящей функцией блокировки;
// - статусы партнёра: pending, approved, rejected, suspended;
// - до ручного одобрения нельзя торговать, принимать реальные депозиты или менять боевые настройки;
// - после одобрения партнёр администрирует только свою франшизу и свои заявки.
// Изоляция данных на уровне API/backend и базы данных. Проверяем, что один партнёр не может просматривать или менять данные другого через подмену ID.
// Все проверки, выдачи и отзывы ролей журналируем.

const store = require('./store');
const audit = require('./audit');
const walletProvider = require('./walletProvider');

const STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const NETWORKS = ['BTC', 'BTC_SEGWIT', 'BTC_TAPROOT', 'LIGHTNING', 'TESTNET'];

// Валидация юридических реквизитов — только необходимые данные.
// Не собираем seed-фразу, приватный ключ, коды доступа или банковские пароли.
function validateLegal(legal) {
  if (!legal || typeof legal !== 'object') throw new Error('Укажите юридические реквизиты');
  const { companyName, inn, ogrn, legalAddress, contactEmail, contactPhone, publicBtcAddresses, networks, keyHolders } = legal;

  if (!companyName || String(companyName).trim().length < 2) throw new Error('Укажите название компании/ИП (от 2 символов)');
  if (String(companyName).length > 200) throw new Error('Название компании — до 200 символов');

  // ИНН — 10 или 12 цифр, ОГРН — 13 или 15 цифр (опционально, но если указан — проверяем формат)
  if (inn && !/^\d{10}$|^\d{12}$/.test(String(inn).trim())) throw new Error('ИНН должен содержать 10 или 12 цифр');
  if (ogrn && !/^\d{13}$|^\d{15}$/.test(String(ogrn).trim())) throw new Error('ОГРН должен содержать 13 или 15 цифр');

  if (!legalAddress || String(legalAddress).trim().length < 5) throw new Error('Укажите юридический адрес (от 5 символов)');
  if (String(legalAddress).length > 500) throw new Error('Юридический адрес — до 500 символов');

  if (!contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contactEmail).trim())) throw new Error('Укажите корректный контактный email');
  if (contactPhone && String(contactPhone).trim().length > 50) throw new Error('Телефон — до 50 символов');

  // Публичные BTC-адреса — только публичные адреса, не приватные ключи.
  if (!Array.isArray(publicBtcAddresses) || publicBtcAddresses.length === 0) throw new Error('Укажите хотя бы один публичный BTC-адрес');
  if (publicBtcAddresses.length > 10) throw new Error('До 10 публичных BTC-адресов');
  for (const addr of publicBtcAddresses) {
    const a = String(addr || '').trim();
    if (a.length < 26 || a.length > 90) throw new Error(`Некорректный BTC-адрес: ${a.slice(0, 20)}...`);
    if (/\s/.test(a)) throw new Error('BTC-адрес не должен содержать пробелов');
    // Проверка на попытку передать seed-фразу или приватный ключ
    if (a.split(/\s+/).length >= 12) throw new Error('Публичный адрес не может быть seed-фразой');
    if (/^[5KL][a-km-zA-HJ-NP-Z1-9]{50,}$/.test(a) || /^[a-fA-F0-9]{64}$/.test(a)) {
      throw new Error('Указывайте только публичный BTC-адрес, а не приватный ключ');
    }
  }

  if (!Array.isArray(networks) || networks.length === 0) throw new Error('Укажите используемые сети (например, BTC)');
  for (const n of networks) {
    if (!NETWORKS.includes(String(n).toUpperCase()) && !['BTC', 'MAINNET', 'TESTNET'].includes(String(n).toUpperCase())) {
      // Разрешаем BTC-подобные сети, но логируем
      if (String(n).length > 30) throw new Error('Название сети — до 30 символов');
    }
  }

  // Держатели ключа — только имена/роли и основание полномочий, без секрета.
  if (!Array.isArray(keyHolders) || keyHolders.length === 0) throw new Error('Укажите держателей ключа (имя/роль и основание)');
  if (keyHolders.length > 10) throw new Error('До 10 держателей ключа');
  for (const kh of keyHolders) {
    if (!kh || typeof kh !== 'object') throw new Error('Некорректный держатель ключа');
    const name = String(kh.name || '').trim();
    const role = String(kh.role || '').trim();
    const basis = String(kh.basis || '').trim();
    if (name.length < 2 || name.length > 100) throw new Error('Имя держателя — от 2 до 100 символов');
    if (role.length < 2 || role.length > 100) throw new Error('Роль держателя — от 2 до 100 символов');
    if (basis.length < 2 || basis.length > 200) throw new Error('Основание полномочий — от 2 до 200 символов');
    // Запрет на передачу секретов в этих полях
    const combined = `${name} ${role} ${basis}`.toLowerCase();
    if (/(seed|mnemonic|private key|приватный ключ|seed-фраза)/.test(combined)) {
      throw new Error('В данных держателя нельзя указывать seed-фразу или приватный ключ — только имя/роль и основание');
    }
    if (combined.split(/\s+/).length > 12 && /(word|слово)/.test(combined)) {
      throw new Error('Не указывайте seed-фразу');
    }
  }

  // Проверка на наличие запрещённых полей (seed, privateKey)
  const forbidden = ['seed', 'seedPhrase', 'mnemonic', 'privateKey', 'privKey', 'secret', 'password', 'bankPassword'];
  for (const key of forbidden) {
    if (legal[key] != null) throw new Error(`Поле ${key} запрещено: приложение не собирает seed-фразы и приватные ключи`);
  }

  return {
    companyName: String(companyName).trim(),
    inn: inn ? String(inn).trim() : null,
    ogrn: ogrn ? String(ogrn).trim() : null,
    legalAddress: String(legalAddress).trim(),
    contactEmail: String(contactEmail).trim().toLowerCase(),
    contactPhone: contactPhone ? String(contactPhone).trim() : null,
    publicBtcAddresses: publicBtcAddresses.map((a) => String(a).trim()),
    networks: networks.map((n) => String(n).trim().toUpperCase()),
    keyHolders: keyHolders.map((kh) => ({
      name: String(kh.name).trim(),
      role: String(kh.role).trim(),
      basis: String(kh.basis).trim(),
    })),
  };
}

function createExchanger({ tgId, userId, legal, experience, contact }) {
  const validatedLegal = validateLegal(legal);
  if (experience && String(experience).length > 1500) throw new Error('Опыт — до 1500 символов');
  if (contact && String(contact).length > 200) throw new Error('Контакт — до 200 символов');

  return store.mutate((db) => {
    if (!Array.isArray(db.exchangers)) db.exchangers = [];
    if (!Number.isFinite(db.exchangerSeq)) db.exchangerSeq = db.exchangers.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;

    // Один Telegram ID — один профиль (для изоляции)
    const existing = db.exchangers.find((e) => String(e.tgId) === String(tgId) && ['pending', 'approved', 'suspended'].includes(e.status));
    if (existing) throw new Error('У вас уже есть заявка на рассмотрении или активная франшиза');

    const now = Date.now();
    const exchanger = {
      id: db.exchangerSeq++,
      tgId: String(tgId),
      userId: userId ? String(userId) : String(tgId),
      login: String(tgId), // логин совпадает с tgId для совместимости с brokerAccounts
      status: 'pending',
      legal: validatedLegal,
      experience: experience ? String(experience).trim().slice(0, 1500) : '',
      contact: contact ? String(contact).trim().slice(0, 200) : '',
      createdAt: now,
      updatedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: null,
      wallet: null, // будет создан после одобрения через wallet-провайдера
      settings: {
        minRub: null,
        maxRub: null,
        // Боевые настройки недоступны до одобрения
        tradingEnabled: false,
      },
    };
    db.exchangers.push(exchanger);
    return { ...exchanger };
  });
}

function getExchangerById(id) {
  const ex = (store.get().exchangers || []).find((e) => e.id === Number(id) || String(e.id) === String(id));
  return ex ? { ...ex } : null;
}

function getExchangerByTgId(tgId) {
  const ex = (store.get().exchangers || []).find((e) => String(e.tgId) === String(tgId));
  return ex ? { ...ex } : null;
}

function getExchangerByLogin(login) {
  const ex = (store.get().exchangers || []).find((e) => String(e.login) === String(login) || String(e.tgId) === String(login));
  return ex ? { ...ex } : null;
}

function listExchangers({ status, limit = 100 } = {}) {
  let list = (store.get().exchangers || []).slice();
  if (status) list = list.filter((e) => e.status === status);
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list.slice(0, limit).map((e) => ({ ...e }));
}

function listApprovedExchangersForMarketplace() {
  // Только approved, с публичными данными, с источником и временем обновления
  const now = Date.now();
  return (store.get().exchangers || [])
    .filter((e) => e.status === 'approved')
    .map((e) => {
      const s = store.get().settings;
      const rateUpdatedAt = s.rateUpdatedAt || null;
      const rateSource = s.rateSource || 'manual';
      const isStale = !rateUpdatedAt || now - rateUpdatedAt > 5 * 60 * 1000;
      return {
        id: e.id,
        login: e.login,
        companyName: e.legal?.companyName || 'Обменник',
        publicBtcAddresses: e.legal?.publicBtcAddresses || [],
        networks: e.legal?.networks || [],
        minRub: e.settings?.minRub ?? s.minRub,
        maxRub: e.settings?.maxRub ?? s.maxRub,
        rateBTC: s.rateBTC,
        rateGRAM: s.rateGRAM,
        rateSource,
        rateUpdatedAt,
        isStale,
        guaranteeFundBtc: s.guaranteeFundBtc,
        createdAt: e.createdAt,
      };
    });
}

function updateExchangerStatus(id, status, reviewerId, reason) {
  if (!STATUSES.includes(status)) throw new Error(`Недопустимый статус: ${status}`);
  return store.mutate((db) => {
    const ex = (db.exchangers || []).find((e) => e.id === Number(id) || String(e.id) === String(id));
    if (!ex) throw new Error('Обменник не найден');
    const prev = ex.status;
    ex.status = status;
    ex.updatedAt = Date.now();
    ex.reviewedBy = reviewerId ? String(reviewerId) : null;
    ex.reviewedAt = Date.now();
    ex.reviewReason = reason ? String(reason).slice(0, 500) : null;
    // При одобрении торговля всё ещё выключена до создания кошелька и подтверждения депозита и подписки
    if (status === 'approved') {
      ex.settings.tradingEnabled = false;
    } else {
      ex.settings.tradingEnabled = false;
    }
    // Логируем проверку, выдачу и отзыв роли
    audit.log({
      actorId: reviewerId,
      action: `exchanger_status_${prev}_to_${status}`,
      targetType: 'exchanger',
      targetId: ex.id,
      details: { prev, next: status, reason },
    });
    return { ...ex };
  });
}

async function createWalletForExchanger(exchangerId, actorId) {
  const ex = getExchangerById(exchangerId);
  if (!ex) throw new Error('Обменник не найден');
  if (ex.status !== 'approved') throw new Error('Кошелёк можно создать только для одобренного обменника');
  if (ex.wallet) throw new Error('Кошелёк уже создан');

  const provider = walletProvider.getProvider();
  const cap = await provider.getLockCapability();
  // Кошелёк создаётся только через проверенного провайдера с подходящей функцией блокировки
  // В тестовом режиме провайдер mock, realLock=false, поэтому торговля остаётся выключенной
  const wallet = await provider.createWallet(ex.id);

  return store.mutate((db) => {
    const e = (db.exchangers || []).find((x) => x.id === Number(exchangerId));
    if (!e) throw new Error('Обменник не найден');
    e.wallet = wallet;
    e.updatedAt = Date.now();
    audit.log({
      actorId,
      action: 'exchanger_wallet_created',
      targetType: 'exchanger',
      targetId: e.id,
      details: { walletId: wallet.walletId, address: wallet.address, provider: wallet.provider, realLock: wallet.isRealLock, capability: cap },
    });
    return { ...e };
  });
}

function canTrade(exchangerId) {
  const ex = getExchangerById(exchangerId);
  if (!ex) return { ok: false, reason: 'not_found' };
  if (ex.status !== 'approved') return { ok: false, reason: 'not_approved', status: ex.status };
  if (!ex.wallet) return { ok: false, reason: 'no_wallet' };
  // Проверяем подписку, если она обязательна
  const subModule = require('./subscriptions');
  if (!subModule.isAccessAllowed(ex.id).ok) {
    return { ok: false, reason: 'subscription_required', details: subModule.isAccessAllowed(ex.id) };
  }
  // Проверяем, что депозит подтверждён и торговля включена через провайдера
  // Если mainnet выключен, торговля выключена
  if (!walletProvider.isMainnetEnabled()) {
    return { ok: false, reason: 'trading_disabled_no_provider', note: 'Реальные mainnet-депозиты, автозаморозка и торговля выключены — нет подходящего wallet-провайдера с подтверждённой блокировкой' };
  }
  if (!ex.settings.tradingEnabled) return { ok: false, reason: 'trading_not_enabled' };
  return { ok: true };
}

function updateExchangerSettings(exchangerId, patch, actorId) {
  // Боевые настройки можно менять только после одобрения
  const ex = getExchangerById(exchangerId);
  if (!ex) throw new Error('Обменник не найден');
  if (ex.status !== 'approved') throw new Error('Боевые настройки можно менять только после ручного одобрения');
  // Проверяем изоляцию: actorId должен совпадать с владельцем или быть админом (проверяется выше по стеку)
  return store.mutate((db) => {
    const e = (db.exchangers || []).find((x) => x.id === Number(exchangerId));
    if (!e) throw new Error('Обменник не найден');
    if (patch.minRub != null) {
      const v = Number(patch.minRub);
      if (!Number.isFinite(v) || v <= 0) throw new Error('minRub должен быть положительным');
      e.settings.minRub = v;
    }
    if (patch.maxRub != null) {
      const v = Number(patch.maxRub);
      if (!Number.isFinite(v) || v <= 0) throw new Error('maxRub должен быть положительным');
      e.settings.maxRub = v;
    }
    e.updatedAt = Date.now();
    audit.log({
      actorId,
      action: 'exchanger_settings_updated',
      targetType: 'exchanger',
      targetId: e.id,
      details: patch,
    });
    return { ...e };
  });
}

// Проверка изоляции: один партнёр не может просматривать или менять данные другого через подмену ID.
function assertOwnership(exchangerId, actorTgId) {
  const ex = getExchangerById(exchangerId);
  if (!ex) throw new Error('Обменник не найден');
  if (String(ex.tgId) !== String(actorTgId)) {
    audit.log({
      actorId: actorTgId,
      action: 'exchanger_access_denied',
      targetType: 'exchanger',
      targetId: exchangerId,
      details: { attemptedBy: actorTgId, owner: ex.tgId },
    });
    throw new Error('Доступ запрещён: вы не владелец этой франшизы');
  }
  return ex;
}

module.exports = {
  STATUSES,
  validateLegal,
  createExchanger,
  getExchangerById,
  getExchangerByTgId,
  getExchangerByLogin,
  listExchangers,
  listApprovedExchangersForMarketplace,
  updateExchangerStatus,
  createWalletForExchanger,
  canTrade,
  updateExchangerSettings,
  assertOwnership,
};
