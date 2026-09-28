// Аудит действий с ролями, проверками, выдачами и отзывами.
// Все проверки, выдачи и отзывы ролей журналируются для последующего разбора.
const store = require('./store');

function log({ actorId, action, targetType, targetId, details }) {
  const entry = {
    id: store.get().auditSeq ? store.get().auditSeq++ : 1,
    at: Date.now(),
    actorId: actorId != null ? String(actorId) : null,
    action: String(action || ''),
    targetType: targetType ? String(targetType) : null,
    targetId: targetId != null ? String(targetId) : null,
    details: details || null,
  };
  store.mutate((db) => {
    if (!Array.isArray(db.auditLog)) db.auditLog = [];
    if (!Number.isFinite(db.auditSeq)) db.auditSeq = (db.auditLog.length || 0) + 1;
    entry.id = db.auditSeq++;
    db.auditLog.push(entry);
    if (db.auditLog.length > 5000) db.auditLog.splice(0, db.auditLog.length - 5000);
  });
  return entry;
}

function list({ targetType, targetId, limit = 100 } = {}) {
  let logs = (store.get().auditLog || []).slice();
  if (targetType) logs = logs.filter((l) => l.targetType === targetType);
  if (targetId) logs = logs.filter((l) => String(l.targetId) === String(targetId));
  logs.sort((a, b) => b.at - a.at);
  return logs.slice(0, limit);
}

module.exports = { log, list };
