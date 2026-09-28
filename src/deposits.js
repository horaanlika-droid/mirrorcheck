// Торговый лимит и жизненный цикл депозита.
// Обеспечивает, чтобы совокупная экспозиция обменника по всем открытым сессиям
// не превышала его подтверждённый доступный депозит. Резервирует сумму под сессию
// так, чтобы один и тот же депозит нельзя было одновременно использовать для
// нескольких несвязанных заявок.
// Состояния: available, reserved, session_active, claim_pending, release_pending, released.
// Депозит резервируется при фактическом начале сессии по согласованному правилу.
// Автоматическая разблокировка возможна только после завершения сессии, если нет
// незакрытой заявки, обращения или спора.
// Если пользователь отменил заявку и подал обращение из-за неполучения BTC,
// не освобождать соответствующий резерв таймером: держать заблокированным до
// человеческого решения и завершения предусмотренного процессом разбирательства.
// Не задавать срок подачи обращения и не вводить новые условия допуска к обращению.
// Не запускать автоматическую выплату при подаче обращения, отмене или смене статуса.
// Не выдумывать источник цены BTC, haircut, коэффициент риска или способ переоценки депозита.
// Учитывать только подтверждённый депозит; резервировать под открытые сессии,
// не допускать превышения доступного остатка и двойного использования.

const store = require('./store');
const walletProvider = require('./walletProvider');
const audit = require('./audit');

const STATUSES = ['available', 'reserved', 'session_active', 'claim_pending', 'release_pending', 'released'];
const CONFIRMATIONS_REQUIRED = walletProvider.getConfirmationRule().required;

function _nextId() {
  const db = store.get();
  if (!Number.isFinite(db.exchangerDepositSeq)) db.exchangerDepositSeq = (db.exchangerDeposits || []).reduce((m, d) => Math.max(m, d.id || 0), 0) + 1;
  return db.exchangerDepositSeq++;
}

function createDeposit({ exchangerId, amountBtc, txId, confirmations = 0, providerRef = null }) {
  const amt = Math.round(Number(amountBtc) * 1e8) / 1e8;
  if (!(amt > 0)) throw new Error('Сумма депозита должна быть положительной');
  if (!exchangerId) throw new Error('exchangerId required');

  return store.mutate((db) => {
    if (!Array.isArray(db.exchangerDeposits)) db.exchangerDeposits = [];
    if (!Number.isFinite(db.exchangerDepositSeq)) db.exchangerDepositSeq = db.exchangerDeposits.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1;

    const now = Date.now();
    const isConfirmed = Number(confirmations) >= CONFIRMATIONS_REQUIRED;
    const deposit = {
      id: db.exchangerDepositSeq++,
      exchangerId: String(exchangerId),
      amountBtc: amt,
      confirmedAmountBtc: isConfirmed ? amt : 0,
      unconfirmedAmountBtc: isConfirmed ? 0 : amt,
      status: isConfirmed ? 'available' : 'available', // но confirmedAmount=0, поэтому не учитывается в лимите
      confirmations: Number(confirmations) || 0,
      txId: txId ? String(txId).slice(0, 128) : null,
      providerRef: providerRef ? String(providerRef).slice(0, 128) : null,
      orderId: null,
      reservationId: null,
      createdAt: now,
      updatedAt: now,
    };
    db.exchangerDeposits.push(deposit);
    audit.log({
      actorId: exchangerId,
      action: 'deposit_created',
      targetType: 'deposit',
      targetId: deposit.id,
      details: { amountBtc: amt, confirmations, isConfirmed },
    });
    return { ...deposit };
  });
}

function confirmDeposit(depositId, confirmations) {
  return store.mutate((db) => {
    const dep = (db.exchangerDeposits || []).find((d) => d.id === Number(depositId));
    if (!dep) throw new Error('Депозит не найден');
    dep.confirmations = Number(confirmations) || dep.confirmations;
    if (dep.confirmations >= CONFIRMATIONS_REQUIRED && dep.confirmedAmountBtc === 0) {
      dep.confirmedAmountBtc = dep.amountBtc;
      dep.unconfirmedAmountBtc = 0;
      dep.updatedAt = Date.now();
      audit.log({
        actorId: dep.exchangerId,
        action: 'deposit_confirmed',
        targetType: 'deposit',
        targetId: dep.id,
        details: { confirmations: dep.confirmations, amount: dep.amountBtc },
      });
    }
    return { ...dep };
  });
}

function getDeposits(exchangerId) {
  return (store.get().exchangerDeposits || [])
    .filter((d) => !exchangerId || String(d.exchangerId) === String(exchangerId))
    .map((d) => ({ ...d }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function getAvailableBalance(exchangerId) {
  // Учитываем только подтверждённый депозит
  const deposits = (store.get().exchangerDeposits || []).filter((d) => String(d.exchangerId) === String(exchangerId));
  const available = deposits
    .filter((d) => d.status === 'available')
    .reduce((s, d) => s + (Number(d.confirmedAmountBtc) || 0), 0);
  return Math.round(available * 1e8) / 1e8;
}

function getReservedBalance(exchangerId) {
  const deposits = (store.get().exchangerDeposits || []).filter((d) => String(d.exchangerId) === String(exchangerId));
  const reserved = deposits
    .filter((d) => ['reserved', 'session_active', 'claim_pending', 'release_pending'].includes(d.status))
    .reduce((s, d) => s + (Number(d.confirmedAmountBtc) || Number(d.amountBtc) || 0), 0);
  return Math.round(reserved * 1e8) / 1e8;
}

function getTotalExposure(exchangerId) {
  // Совокупная экспозиция по всем открытым сессиям
  const deposits = (store.get().exchangerDeposits || []).filter((d) => String(d.exchangerId) === String(exchangerId));
  const exposure = deposits
    .filter((d) => ['reserved', 'session_active', 'claim_pending'].includes(d.status))
    .reduce((s, d) => s + (Number(d.confirmedAmountBtc) || Number(d.amountBtc) || 0), 0);
  return Math.round(exposure * 1e8) / 1e8;
}

// Резервирование депозита под сессию.
// Проверяет, что один и тот же депозит нельзя одновременно использовать для нескольких несвязанных заявок.
function reserveForOrder({ exchangerId, orderId, amountBtc, actorId }) {
  const amt = Math.round(Number(amountBtc) * 1e8) / 1e8;
  if (!(amt > 0)) throw new Error('Сумма резерва должна быть положительной');
  if (!exchangerId || !orderId) throw new Error('exchangerId и orderId обязательны');

  // Проверка на двойное резервирование: один orderId — один резерв
  const existing = (store.get().exchangerDeposits || []).find((d) => String(d.orderId) === String(orderId) && ['reserved', 'session_active', 'claim_pending', 'release_pending'].includes(d.status));
  if (existing) throw new Error('Депозит уже зарезервирован под эту заявку — двойное резервирование запрещено');

  const available = getAvailableBalance(exchangerId);
  if (available < amt) {
    throw new Error(`Недостаточно доступного депозита: доступно ${available} BTC, требуется ${amt} BTC. Совокупная экспозиция не должна превышать подтверждённый депозит.`);
  }

  // Находим свободный депозит (available) с достаточной суммой или комбинируем?
  // Для простоты — создаём запись резерва, списывая с available.
  // В реальной системе — выбираем конкретные UTXO/депозиты.
  return store.mutate((db) => {
    if (!Array.isArray(db.exchangerDeposits)) db.exchangerDeposits = [];
    if (!Number.isFinite(db.exchangerDepositSeq)) db.exchangerDepositSeq = db.exchangerDeposits.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1;

    // Проверяем ещё раз внутри mutate (защита от race)
    const availDeposits = db.exchangerDeposits.filter((d) => String(d.exchangerId) === String(exchangerId) && d.status === 'available' && Number(d.confirmedAmountBtc) > 0);
    const totalAvail = availDeposits.reduce((s, d) => s + Number(d.confirmedAmountBtc), 0);
    if (totalAvail < amt) throw new Error(`Недостаточно доступного депозита (внутри транзакции): ${totalAvail} < ${amt}`);

    // Для изоляции — помечаем первый подходящий депозит как reserved, или дробим
    // Упрощённо: если есть депозит с достаточной суммой, резервируем его целиком под order
    // Если нет — создаём новую запись резерва, а исходные available уменьшаем
    let remaining = amt;
    const reservedDeposits = [];
    for (const dep of availDeposits) {
      if (remaining <= 0) break;
      const depAmt = Number(dep.confirmedAmountBtc);
      if (depAmt <= remaining + 1e-8) {
        dep.status = 'reserved';
        dep.orderId = String(orderId);
        dep.updatedAt = Date.now();
        remaining = Math.round((remaining - depAmt) * 1e8) / 1e8;
        reservedDeposits.push({ ...dep });
      } else {
        // Дробим депозит: часть остаётся available, часть уходит в reserved
        const reservedPart = {
          id: db.exchangerDepositSeq++,
          exchangerId: String(exchangerId),
          amountBtc: remaining,
          confirmedAmountBtc: remaining,
          unconfirmedAmountBtc: 0,
          status: 'reserved',
          confirmations: dep.confirmations,
          txId: dep.txId,
          providerRef: dep.providerRef,
          orderId: String(orderId),
          reservationId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        dep.confirmedAmountBtc = Math.round((depAmt - remaining) * 1e8) / 1e8;
        dep.amountBtc = dep.confirmedAmountBtc;
        dep.updatedAt = Date.now();
        db.exchangerDeposits.push(reservedPart);
        reservedDeposits.push({ ...reservedPart });
        remaining = 0;
      }
    }

    if (remaining > 1e-8) {
      throw new Error('Не удалось зарезервировать депозит — логическая ошибка дробления');
    }

    // Логируем резерв
    for (const rd of reservedDeposits) {
      audit.log({
        actorId: actorId || exchangerId,
        action: 'deposit_reserved',
        targetType: 'deposit',
        targetId: rd.id,
        details: { orderId, amountBtc: rd.confirmedAmountBtc || rd.amountBtc, exchangerId },
      });
    }

    return reservedDeposits.map((d) => ({ ...d }));
  });
}

function activateReservation(orderId, actorId) {
  return store.mutate((db) => {
    const deps = (db.exchangerDeposits || []).filter((d) => String(d.orderId) === String(orderId) && d.status === 'reserved');
    if (!deps.length) return [];
    for (const dep of deps) {
      dep.status = 'session_active';
      dep.updatedAt = Date.now();
      audit.log({
        actorId,
        action: 'deposit_session_active',
        targetType: 'deposit',
        targetId: dep.id,
        details: { orderId },
      });
    }
    return deps.map((d) => ({ ...d }));
  });
}

function releaseReservation(orderId, actorId, { force = false } = {}) {
  // Автоматическая разблокировка возможна только после завершения сессии,
  // если нет незакрытой заявки, обращения или спора.
  // Если по сессии есть открытое обращение — не освобождаем таймером.
  const claims = store.get().claims || [];
  const openClaim = claims.find((c) => String(c.orderId) === String(orderId) && ['open', 'under_review'].includes(c.status));
  if (openClaim && !force) {
    throw new Error('Нельзя разблокировать залог по таймеру — по сессии есть открытое обращение. Залог остаётся зарезервирован до человеческого решения.');
  }

  return store.mutate((db) => {
    const allowed = force ? ['reserved', 'session_active', 'release_pending', 'claim_pending'] : ['reserved', 'session_active', 'release_pending'];
    const deps = (db.exchangerDeposits || []).filter((d) => String(d.orderId) === String(orderId) && allowed.includes(d.status));
    for (const dep of deps) {
      dep.status = 'release_pending';
      dep.updatedAt = Date.now();
    }
    // Сразу переводим в released и возвращаем в available (в реальности — после подтверждения провайдера)
    for (const dep of deps) {
      dep.status = 'released';
      dep.updatedAt = Date.now();
      // Создаём новый available депозит на ту же сумму (депозит — залог, не расходуется)
      const newAvail = {
        id: db.exchangerDepositSeq++,
        exchangerId: dep.exchangerId,
        amountBtc: dep.confirmedAmountBtc || dep.amountBtc,
        confirmedAmountBtc: dep.confirmedAmountBtc || dep.amountBtc,
        unconfirmedAmountBtc: 0,
        status: 'available',
        confirmations: dep.confirmations,
        txId: dep.txId,
        providerRef: dep.providerRef,
        orderId: null,
        reservationId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      db.exchangerDeposits.push(newAvail);
      audit.log({
        actorId,
        action: 'deposit_released',
        targetType: 'deposit',
        targetId: dep.id,
        details: { orderId, newAvailableId: newAvail.id },
      });
    }
    return deps.map((d) => ({ ...d }));
  });
}

function holdForClaim(orderId, actorId) {
  return store.mutate((db) => {
    const deps = (db.exchangerDeposits || []).filter((d) => String(d.orderId) === String(orderId) && ['reserved', 'session_active'].includes(d.status));
    for (const dep of deps) {
      dep.status = 'claim_pending';
      dep.updatedAt = Date.now();
      audit.log({
        actorId,
        action: 'deposit_claim_pending',
        targetType: 'deposit',
        targetId: dep.id,
        details: { orderId },
      });
    }
    return deps.map((d) => ({ ...d }));
  });
}

// Принудительное удержание резерва при открытом споре — даже если пользователь отменил заявку
function isDepositLockedForClaim(orderId) {
  const deps = (store.get().exchangerDeposits || []).filter((d) => String(d.orderId) === String(orderId));
  return deps.some((d) => d.status === 'claim_pending');
}

function releaseForOrder(exchangerId, orderId) {
  return releaseReservation(orderId, exchangerId, { force: false });
}
function forceReleaseForOrder(exchangerId, orderId) {
  return releaseReservation(orderId, exchangerId, { force: true });
}

module.exports = {
  STATUSES,
  createDeposit,
  confirmDeposit,
  getDeposits,
  getAvailableBalance,
  getReservedBalance,
  getTotalExposure,
  reserveForOrder,
  activateReservation,
  releaseReservation,
  releaseForOrder,
  forceReleaseForOrder,
  holdForClaim,
  isDepositLockedForClaim,
  CONFIRMATIONS_REQUIRED,
};
