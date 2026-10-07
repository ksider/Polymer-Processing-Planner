import type { Db } from "../db.js";

export type AuditRow = {
  id: number;
  actor_user_id: number | null;
  action: string;
  target_user_id: number | null;
  details_json: string | null;
  created_at: string;
  actor_email: string | null;
};

export function insertAudit(
  db: Db,
  {
    actorUserId,
    action,
    targetUserId,
    detailsJson
  }: { actorUserId: number | null; action: string; targetUserId: number | null; detailsJson: string | null }
) {
  db.prepare(
    `INSERT INTO audit_log (actor_user_id, action, target_user_id, details_json)
     VALUES (?, ?, ?, ?)`
  ).run(actorUserId, action, targetUserId, detailsJson);
}

export function listAudit(db: Db, limit = 200): AuditRow[] {
  return db.prepare(
    `SELECT a.id, a.actor_user_id, a.action, a.target_user_id, a.details_json, a.created_at,
            u.email as actor_email
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.created_at DESC
     LIMIT ?`
  ).all(limit) as AuditRow[];
}

export function listRecentAuditForUsers(db: Db, limitPerUser = 5): AuditRow[] {
  return db.prepare(
    `SELECT id, actor_user_id, action, target_user_id, details_json, created_at, actor_email
     FROM (
       SELECT a.id, a.actor_user_id, a.action, a.target_user_id, a.details_json, a.created_at,
              u.email AS actor_email,
              ROW_NUMBER() OVER (PARTITION BY a.actor_user_id ORDER BY a.created_at DESC) AS row_number
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.actor_user_id IS NOT NULL
     ) WHERE row_number <= ? ORDER BY created_at DESC`
  ).all(limitPerUser) as AuditRow[];
}
