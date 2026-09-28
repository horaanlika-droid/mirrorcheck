// Ручное рассмотрение споров и выплаты.
// Обращения рассматривает человек, назначенный для соответствующей франшизы.
// ИИ не участвует в рассмотрении споров, оценке доказательств, управлении залогом или запуске выплат.
// Неполучение BTC достаточно, чтобы подать обращение о выплате из залога.
// Обращение рассматривает человек; подача обращения не означает автоматическое одобрение или выплату.
// ИИ не должен: оценивать доказательства, подсказывать исход, принимать решение, менять депозитный лимит или статус заморозки, инициировать или подтверждать выплату.
// Если проект позволяет выплатить средства, это отдельное действие уполномоченного человека с явным подтверждением после ручного решения. Автоматические выплаты и удержания запрещены.

const store = require('./store');
const audit = require('./audit');
const deposits = require('./deposits');

const STATUSES = ['open', 'under_review', 'approved', 'rejected', 'paid'];
const REASONS = ['btc_not_received', 'other'];

function _nextId() {
  const db = store.get();
  if (!Number.isFinite(db.claimSeq)) db.claimSeq = (db.claims || []).reduce((m, c) => Math.max(m, c.id || 0), 0) + 1;
  return db.claimSeq++;
}

function createClaim({ orderId, userId, exchangerId, reason = 'btc_not_received', description }) {
  if (!orderId) throw new Error('orderId required');
  if (!userId) throw new Error('userId required');
  if (!exchangerId) throw new Error('exchangerId required');
  if (!REASONS.includes(reason)) throw new Error(`Недопустимая причина: ${reason}`);
  if (description && String(description).length > 2000) throw new Error('Описание — до 2000 символов');

  // Проверяем, что по заявке ещё нет открытого обращения
  const existing = (store.get().claims || []).find((c) => String(c.orderId) === String(orderId) && ['open', 'under_review'].includes(c.status));
  if (existing) throw new Error('По этой заявке уже есть открытое обращение');

  // Проверяем, что заявка существует и принадлежит пользователю (проверка делается на уровне API)
  const order = store.getOrder(orderId);
  if (!order) throw new Error('Заявка не найдена');

  return store.mutate((db) => {
    if (!Array.isArray(db.claims)) db.claims = [];
    if (!Number.isFinite(db.claimSeq)) db.claimSeq = db.claims.reduce((m, c) => Math.max(m, c.id || 0), 0) + 1;

    const now = Date.now();
    const claim = {
      id: db.claimSeq++,
      orderId: String(orderId),
      userId: String(userId),
      exchangerId: String(exchangerId),
      reason,
      description: description ? String(description).trim().slice(0, 2000) : '',
      status: 'open',
      createdAt: now,
      updatedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      decision: null,
      motivation: null,
      evidence: [],
      payout: null, // { amountBtc, txId, confirmedAt, confirmedBy }
    };
    db.claims.push(claim);

    audit.log({
      actorId: userId,
      action: 'claim_created',
      targetType: 'claim',
      targetId: claim.id,
      details: { orderId, exchangerId, reason },
    });

    // При обращении из-за неполучения BTC залог остаётся зарезервирован до человеческого решения
    // Переводим связанные депозиты в claim_pending
    try {
      const deps = (db.exchangerDeposits || []).filter((d) => String(d.orderId) === String(orderId));
      for (const dep of deps) {
        if (['reserved', 'session_active'].includes(dep.status)) {
          dep.status = 'claim_pending';
          dep.updatedAt = now;
        }
      }
    } catch (e) {
      // не критично
    }

    return { ...claim };
  });
}

function getClaim(id) {
  const c = (store.get().claims || []).find((x) => x.id === Number(id) || String(x.id) === String(id));
  return c ? { ...c } : null;
}

function listClaims({ exchangerId, userId, status, orderId } = {}) {
  let list = (store.get().claims || []).slice();
  if (exchangerId) list = list.filter((c) => String(c.exchangerId) === String(exchangerId));
  if (userId) list = list.filter((c) => String(c.userId) === String(userId));
  if (status) list = list.filter((c) => c.status === status);
  if (orderId) list = list.filter((c) => String(c.orderId) === String(orderId));
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list.map((c) => ({ ...c }));
}

// Ручное рассмотрение — только человек, с обязательной мотивировкой.
function reviewClaim({ claimId, reviewerId, decision, motivation }) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Решение должно быть approved или rejected');
  if (!motivation || String(motivation).trim().length < 10) throw new Error('Мотивировка обязательна (от 10 символов)');
  if (String(motivation).length > 2000) throw new Error('Мотивировка — до 2000 символов');

  return store.mutate((db) => {
    const claim = (db.claims || []).find((c) => c.id === Number(claimId));
    if (!claim) throw new Error('Обращение не найдено');
    if (!['open', 'under_review'].includes(claim.status)) throw new Error('Обращение уже рассмотрено');

    claim.status = decision === 'approved' ? 'approved' : 'rejected';
    claim.decision = decision;
    claim.motivation = String(motivation).trim().slice(0, 2000);
    claim.reviewedBy = String(reviewerId);
    claim.reviewedAt = Date.now();
    claim.updatedAt = Date.now();

    audit.log({
      actorId: reviewerId,
      action: `claim_${decision}`,
      targetType: 'claim',
      targetId: claim.id,
      details: { orderId: claim.orderId, motivation: claim.motivation },
    });

    // При отклонении — депозит можно разблокировать только после человеческого решения
    // (но не автоматически при подаче). При одобрении — депозит остаётся claim_pending до отдельной выплаты.
    // Разблокировка — отдельное действие, не здесь.

    return { ...claim };
  });
}

function setUnderReview(claimId, reviewerId) {
  return store.mutate((db) => {
    const claim = (db.claims || []).find((c) => c.id === Number(claimId));
    if (!claim) throw new Error('Обращение не найдено');
    if (claim.status !== 'open') throw new Error('Обращение уже в работе или рассмотрено');
    claim.status = 'under_review';
    claim.reviewedBy = String(reviewerId);
    claim.updatedAt = Date.now();
    audit.log({
      actorId: reviewerId,
      action: 'claim_under_review',
      targetType: 'claim',
      targetId: claim.id,
      details: { orderId: claim.orderId },
    });
    return { ...claim };
  });
}

function addEvidence(claimId, { addedBy, text, url }) {
  if (!text && !url) throw new Error('Укажите текст или ссылку');
  return store.mutate((db) => {
    const claim = (db.claims || []).find((c) => c.id === Number(claimId));
    if (!claim) throw new Error('Обращение не найдено');
    claim.evidence.push({
      at: Date.now(),
      by: String(addedBy),
      text: text ? String(text).slice(0, 1000) : null,
      url: url ? String(url).slice(0, 500) : null,
    });
    claim.updatedAt = Date.now();
    audit.log({
      actorId: addedBy,
      action: 'claim_evidence_added',
      targetType: 'claim',
      targetId: claim.id,
      details: { text, url },
    });
    return { ...claim };
  });
}

// Отдельное действие уполномоченного человека с явным подтверждением после ручного решения.
// Автоматические выплаты запрещены.
function confirmPayout({ claimId, actorId, amountBtc, txId, confirmationText }) {
  // confirmationText — явное подтверждение, например "ПОДТВЕРЖДАЮ ВЫПЛАТУ"
  if (!confirmationText || String(confirmationText).trim() !== 'ПОДТВЕРЖДАЮ ВЫПЛАТУ') {
    throw new Error('Для выплаты требуется явное подтверждение: введите "ПОДТВЕРЖДАЮ ВЫПЛАТУ"');
  }
  if (!(Number(amountBtc) > 0)) throw new Error('Сумма выплаты должна быть положительной');
  if (!txId || String(txId).length < 5) throw new Error('Укажите txId выплаты');

  return store.mutate((db) => {
    const claim = (db.claims || []).find((c) => c.id === Number(claimId));
    if (!claim) throw new Error('Обращение не найдено');
    if (claim.status !== 'approved') throw new Error('Выплата возможна только после одобрения обращения человеком');
    if (claim.payout) throw new Error('Выплата по этому обращению уже проведена');

    claim.payout = {
      amountBtc: Math.round(Number(amountBtc) * 1e8) / 1e8,
      txId: String(txId).slice(0, 128),
      confirmedAt: Date.now(),
      confirmedBy: String(actorId),
    };
    claim.status = 'paid';
    claim.updatedAt = Date.now();

    audit.log({
      actorId,
      action: 'claim_payout_confirmed',
      targetType: 'claim',
      targetId: claim.id,
      details: { amountBtc, txId, orderId: claim.orderId },
    });

    // После выплаты депозит можно перевести в released и создать новый available?
    // Но выплата — из залога, поэтому часть залога уходит. Упрощённо — помечаем депозиты как released.
    const deps = (db.exchangerDeposits || []).filter((d) => String(d.orderId) === String(claim.orderId) && d.status === 'claim_pending');
    for (const dep of deps) {
      dep.status = 'released';
      dep.updatedAt = Date.now();
    }

    return { ...claim };
  });
}

module.exports = {
  STATUSES,
  REASONS,
  createClaim,
  getClaim,
  listClaims,
  reviewClaim,
  setUnderReview,
  addEvidence,
  confirmPayout,
};
