import type { Db } from "../db.js";

export type NotificationRow = {
  id: number;
  user_id: number;
  type: string;
  title: string;
  body: string | null;
  payload_json: string | null;
  message_id: number | null;
  status: "unread" | "read" | "archived";
  created_at: string;
  read_at: string | null;
};

export function createNotification(
  db: Db,
  data: {
    user_id: number;
    type: string;
    title: string;
    body?: string | null;
    payload_json?: string | null;
    message_id?: number | null;
  }
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO notifications
       (user_id, type, title, body, payload_json, message_id, status, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unread', ?, NULL)`
    )
    .run(
      data.user_id,
      data.type,
      data.title,
      data.body ?? null,
      data.payload_json ?? null,
      data.message_id ?? null,
      now
    );
  return Number(result.lastInsertRowid);
}

export function countUnreadNotifications(db: Db, userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND status = 'unread'")
    .get(userId) as { count: number };
  return Number(row?.count || 0);
}

export function listNotificationsByUser(db: Db, userId: number, limit = 20): NotificationRow[] {
  return db
    .prepare(
      `SELECT *
       FROM notifications
       WHERE user_id = ?
         AND status != 'archived'
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(userId, limit) as NotificationRow[];
}

export function listUnreadNotificationsByUser(db: Db, userId: number, limit = 20): NotificationRow[] {
  return db
    .prepare(
      `SELECT *
       FROM notifications
       WHERE user_id = ?
         AND status = 'unread'
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(userId, limit) as NotificationRow[];
}

export function markNotificationRead(db: Db, notificationId: number, userId: number) {
  db.prepare(
    `UPDATE notifications
     SET status = 'read', read_at = COALESCE(read_at, ?)
     WHERE id = ? AND user_id = ?`
  ).run(new Date().toISOString(), notificationId, userId);
}

export function markAllNotificationsRead(db: Db, userId: number) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notifications
     SET status = 'read', read_at = COALESCE(read_at, ?)
     WHERE user_id = ? AND status = 'unread'`
  ).run(now, userId);
}
