import type { Db } from "../db.js";
import type {
  MessageBoxFolder,
  MessageBoxRow,
  MessageBoxStatus,
  MessageKind,
  MessageRow,
  MessageVisibility
} from "../domain/messages.js";

export type MessageListItemRow = MessageBoxRow & {
  kind: MessageKind;
  visibility: MessageVisibility;
  chat_room_id: number | null;
  reply_to_message_id: number | null;
  sender_user_id: number | null;
  subject: string;
  body: string | null;
  payload_json: string | null;
  message_created_at: string;
  edited_at: string | null;
  edit_count: number;
  sender_name: string | null;
  sender_email: string | null;
};

export type DirectConversationRow = {
  partner_user_id: number;
  partner_name: string | null;
  partner_email: string | null;
  last_message_at: string;
  last_subject: string;
  last_body: string | null;
  unread_count: number;
};

export type DirectThreadMessageRow = MessageListItemRow & {
  direction: "incoming" | "outgoing";
  message_no: number;
  is_pinned: number;
  reply_subject: string | null;
  reply_body: string | null;
  reply_sender_name: string | null;
  reply_sender_email: string | null;
};

export type ChatRoomListRow = {
  room_id: number;
  room_type: "direct" | "group" | "system";
  room_title: string | null;
  room_updated_at: string;
  partner_user_id: number | null;
  partner_name: string | null;
  partner_email: string | null;
  last_message_at: string | null;
  last_subject: string | null;
  last_body: string | null;
  unread_count: number;
  mention_unread_count: number;
  members_count: number;
};

export type ChatRoomMemberRow = {
  room_id: number;
  user_id: number;
  member_role: "owner" | "member";
  status: "active" | "removed";
  added_at: string;
  removed_at: string | null;
  name: string | null;
  email: string | null;
};

export type ChatRoomRow = {
  id: number;
  room_type: "direct" | "group" | "system";
  title: string | null;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export type MessagePinRow = {
  id: number;
  room_id: number;
  message_id: number;
  pinned_by_user_id: number | null;
  pinned_at: string;
  subject: string;
  body: string | null;
  sender_name: string | null;
  sender_email: string | null;
  message_created_at: string;
};

export type MessageEditRow = {
  id: number;
  message_id: number;
  editor_user_id: number | null;
  subject: string;
  body: string | null;
  created_at: string;
  editor_name: string | null;
  editor_email: string | null;
};

export type MessageDraftRow = {
  id: number;
  user_id: number;
  room_id: number;
  subject: string | null;
  body: string | null;
  reply_to_message_id: number | null;
  updated_at: string;
};

export type MessageReactionRow = {
  id: number;
  message_id: number;
  user_id: number;
  reaction: string;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
};

export function createMessage(
  db: Db,
  data: {
    kind: MessageKind;
    visibility: MessageVisibility;
    chat_room_id?: number | null;
    reply_to_message_id?: number | null;
    sender_user_id: number | null;
    subject: string;
    body?: string | null;
    payload_json?: string | null;
    created_at?: string;
  }
): number {
  const createdAt = data.created_at ?? new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO messages
       (kind, visibility, chat_room_id, reply_to_message_id, sender_user_id, subject, body, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.kind,
      data.visibility,
      data.chat_room_id ?? null,
      data.reply_to_message_id ?? null,
      data.sender_user_id ?? null,
      data.subject,
      data.body ?? null,
      data.payload_json ?? null,
      createdAt
    );
  return Number(result.lastInsertRowid);
}

export function createMessageBox(
  db: Db,
  data: {
    message_id: number;
    user_id: number;
    folder: MessageBoxFolder;
    status: MessageBoxStatus;
    mention_flag?: number;
    read_at?: string | null;
    deleted_at?: string | null;
    created_at?: string;
  }
): number {
  const createdAt = data.created_at ?? new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO message_boxes
       (message_id, user_id, folder, status, mention_flag, deleted_at, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.message_id,
      data.user_id,
      data.folder,
      data.status,
      Number(data.mention_flag || 0) ? 1 : 0,
      data.deleted_at ?? null,
      data.read_at ?? null,
      createdAt
    );
  return Number(result.lastInsertRowid);
}

export function getMessageBoxById(db: Db, messageBoxId: number, userId: number): MessageBoxRow | null {
  const row = db
    .prepare("SELECT * FROM message_boxes WHERE id = ? AND user_id = ? LIMIT 1")
    .get(messageBoxId, userId) as MessageBoxRow | undefined;
  return row ?? null;
}

export function listMessageReactionsForRoom(db: Db, roomId: number): MessageReactionRow[] {
  return db.prepare(
    `SELECT
       mr.id,
       mr.message_id,
       mr.user_id,
       mr.reaction,
       mr.created_at,
       u.name as user_name,
       u.email as user_email
     FROM message_reactions mr
     JOIN messages m ON m.id = mr.message_id
     LEFT JOIN users u ON u.id = mr.user_id
     WHERE m.chat_room_id = ?
     ORDER BY mr.message_id ASC, mr.reaction ASC, datetime(mr.created_at) ASC, mr.id ASC`
  ).all(roomId) as MessageReactionRow[];
}

export function hasMessageReaction(db: Db, messageId: number, userId: number, reaction: string): boolean {
  const row = db
    .prepare("SELECT 1 as ok FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ? LIMIT 1")
    .get(messageId, userId, reaction) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

export function getUserMessageReaction(
  db: Db,
  messageId: number,
  userId: number
): Pick<MessageReactionRow, "id" | "reaction"> | null {
  const row = db
    .prepare("SELECT id, reaction FROM message_reactions WHERE message_id = ? AND user_id = ? LIMIT 1")
    .get(messageId, userId) as Pick<MessageReactionRow, "id" | "reaction"> | undefined;
  return row ?? null;
}

export function createMessageReaction(
  db: Db,
  data: { message_id: number; user_id: number; reaction: string; created_at?: string }
): number {
  const createdAt = data.created_at ?? new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO message_reactions (message_id, user_id, reaction, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(data.message_id, data.user_id, data.reaction, createdAt);
  return Number(result.lastInsertRowid);
}

export function deleteMessageReaction(db: Db, messageId: number, userId: number, reaction: string) {
  db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?")
    .run(messageId, userId, reaction);
}

export function deleteUserMessageReactions(db: Db, messageId: number, userId: number) {
  db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?").run(messageId, userId);
}

export function listMessageBoxesByFolder(
  db: Db,
  userId: number,
  folder: MessageBoxFolder,
  limit = 50
): MessageListItemRow[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 50;
  return db
    .prepare(
      `SELECT
         mb.id,
         mb.message_id,
         mb.user_id,
         mb.folder,
         mb.status,
         mb.mention_flag,
         mb.deleted_at,
         mb.read_at,
         mb.created_at,
         m.kind,
         m.visibility,
         m.chat_room_id,
         m.reply_to_message_id,
         m.sender_user_id,
         m.subject,
         m.body,
         m.payload_json,
         m.created_at as message_created_at,
         m.edited_at,
         m.edit_count,
         su.name as sender_name,
         su.email as sender_email
       FROM message_boxes mb
       JOIN messages m ON m.id = mb.message_id
       LEFT JOIN users su ON su.id = m.sender_user_id
       WHERE mb.user_id = ?
         AND mb.folder = ?
       ORDER BY datetime(m.created_at) DESC, m.id DESC
       LIMIT ?`
    )
    .all(userId, folder, safeLimit) as MessageListItemRow[];
}

export function listUnreadMessageBoxes(db: Db, userId: number, limit = 20): MessageListItemRow[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 20;
  return db
    .prepare(
      `SELECT
         mb.id,
         mb.message_id,
         mb.user_id,
         mb.folder,
         mb.status,
         mb.mention_flag,
         mb.deleted_at,
         mb.read_at,
         mb.created_at,
         m.kind,
         m.visibility,
         m.chat_room_id,
         m.reply_to_message_id,
         m.sender_user_id,
         m.subject,
         m.body,
         m.payload_json,
         m.created_at as message_created_at,
         m.edited_at,
         m.edit_count,
         su.name as sender_name,
         su.email as sender_email
       FROM message_boxes mb
       JOIN messages m ON m.id = mb.message_id
       LEFT JOIN users su ON su.id = m.sender_user_id
       WHERE mb.user_id = ?
         AND mb.status = 'unread'
         AND mb.folder != 'deleted'
       ORDER BY datetime(m.created_at) DESC, m.id DESC
       LIMIT ?`
    )
    .all(userId, safeLimit) as MessageListItemRow[];
}

export function listCollectiveMessageBoxes(db: Db, userId: number, limit = 50): MessageListItemRow[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 50;
  return db
    .prepare(
      `SELECT
         mb.id,
         mb.message_id,
         mb.user_id,
         mb.folder,
         mb.status,
         mb.mention_flag,
         mb.deleted_at,
         mb.read_at,
         mb.created_at,
         m.kind,
         m.visibility,
         m.chat_room_id,
         m.reply_to_message_id,
         m.sender_user_id,
         m.subject,
         m.body,
         m.payload_json,
         m.created_at as message_created_at,
         m.edited_at,
         m.edit_count,
         su.name as sender_name,
         su.email as sender_email
       FROM message_boxes mb
       JOIN messages m ON m.id = mb.message_id
       LEFT JOIN users su ON su.id = m.sender_user_id
       WHERE mb.user_id = ?
         AND mb.folder != 'deleted'
         AND m.visibility = 'collective'
       ORDER BY datetime(m.created_at) DESC, m.id DESC
       LIMIT ?`
    )
    .all(userId, safeLimit) as MessageListItemRow[];
}

export function countUnreadMessageBoxes(db: Db, userId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM message_boxes
       WHERE user_id = ?
         AND status = 'unread'
         AND folder != 'deleted'`
    )
    .get(userId) as { count: number };
  return Number(row?.count || 0);
}

export function markMessageBoxRead(db: Db, messageBoxId: number, userId: number, readAt = new Date().toISOString()) {
  db.prepare(
    `UPDATE message_boxes
     SET status = 'read', read_at = COALESCE(read_at, ?)
     WHERE id = ? AND user_id = ?`
  ).run(readAt, messageBoxId, userId);
}

export function markAllMessageBoxesRead(
  db: Db,
  userId: number,
  folder?: MessageBoxFolder,
  readAt = new Date().toISOString()
) {
  if (folder) {
    db.prepare(
      `UPDATE message_boxes
       SET status = 'read', read_at = COALESCE(read_at, ?)
       WHERE user_id = ?
         AND folder = ?
         AND status = 'unread'`
    ).run(readAt, userId, folder);
    return;
  }
  db.prepare(
    `UPDATE message_boxes
     SET status = 'read', read_at = COALESCE(read_at, ?)
     WHERE user_id = ?
       AND folder != 'deleted'
       AND status = 'unread'`
  ).run(readAt, userId);
}

export function markAllCollectiveMessageBoxesRead(db: Db, userId: number, readAt = new Date().toISOString()) {
  db.prepare(
    `UPDATE message_boxes
     SET status = 'read', read_at = COALESCE(read_at, ?)
     WHERE user_id = ?
       AND folder != 'deleted'
       AND status = 'unread'
       AND message_id IN (
         SELECT id FROM messages WHERE visibility = 'collective'
       )`
  ).run(readAt, userId);
}

export function moveMessageBoxToDeleted(
  db: Db,
  messageBoxId: number,
  userId: number,
  deletedAt = new Date().toISOString()
) {
  db.prepare(
    `UPDATE message_boxes
     SET folder = 'deleted',
         deleted_at = COALESCE(deleted_at, ?),
         status = 'read',
         read_at = COALESCE(read_at, ?)
     WHERE id = ? AND user_id = ?`
  ).run(deletedAt, deletedAt, messageBoxId, userId);
}

export function restoreDeletedMessageBox(
  db: Db,
  messageBoxId: number,
  userId: number,
  folder: MessageBoxFolder
) {
  db.prepare(
    `UPDATE message_boxes
     SET folder = ?, deleted_at = NULL
     WHERE id = ? AND user_id = ? AND folder = 'deleted'`
  ).run(folder, messageBoxId, userId);
}

export function getMessageById(db: Db, messageId: number): MessageRow | null {
  const row = db
    .prepare("SELECT * FROM messages WHERE id = ? LIMIT 1")
    .get(messageId) as MessageRow | undefined;
  return row ?? null;
}

export function createMessageEdit(
  db: Db,
  data: {
    message_id: number;
    editor_user_id?: number | null;
    subject: string;
    body?: string | null;
    created_at?: string;
  }
) {
  db.prepare(
    `INSERT INTO message_edits
     (message_id, editor_user_id, subject, body, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    data.message_id,
    data.editor_user_id ?? null,
    data.subject,
    data.body ?? null,
    data.created_at ?? new Date().toISOString()
  );
}

export function updateMessageContent(
  db: Db,
  data: {
    message_id: number;
    subject: string;
    body?: string | null;
    reply_to_message_id?: number | null;
    edited_at?: string;
  }
) {
  db.prepare(
    `UPDATE messages
     SET subject = ?,
         body = ?,
         reply_to_message_id = ?,
         edited_at = ?,
         edit_count = COALESCE(edit_count, 0) + 1
     WHERE id = ?`
  ).run(
    data.subject,
    data.body ?? null,
    data.reply_to_message_id ?? null,
    data.edited_at ?? new Date().toISOString(),
    data.message_id
  );
}

export function listMessageEditsForRoom(db: Db, userId: number, roomId: number): MessageEditRow[] {
  return db.prepare(
    `SELECT
       e.id,
       e.message_id,
       e.editor_user_id,
       e.subject,
       e.body,
       e.created_at,
       u.name as editor_name,
       u.email as editor_email
     FROM message_edits e
     JOIN messages m ON m.id = e.message_id
     JOIN chat_room_members crm ON crm.room_id = m.chat_room_id AND crm.user_id = ? AND crm.status = 'active'
     LEFT JOIN users u ON u.id = e.editor_user_id
     WHERE m.chat_room_id = ?
     ORDER BY e.message_id ASC, datetime(e.created_at) DESC, e.id DESC`
  ).all(userId, roomId) as MessageEditRow[];
}

export function pinMessageInRoom(
  db: Db,
  data: {
    room_id: number;
    message_id: number;
    pinned_by_user_id?: number | null;
    pinned_at?: string;
  }
) {
  db.prepare(
    `INSERT OR IGNORE INTO chat_room_pins
     (room_id, message_id, pinned_by_user_id, pinned_at)
     VALUES (?, ?, ?, ?)`
  ).run(
    data.room_id,
    data.message_id,
    data.pinned_by_user_id ?? null,
    data.pinned_at ?? new Date().toISOString()
  );
}

export function unpinMessageInRoom(db: Db, roomId: number, messageId: number) {
  db.prepare("DELETE FROM chat_room_pins WHERE room_id = ? AND message_id = ?").run(roomId, messageId);
}

export function isMessagePinnedInRoom(db: Db, roomId: number, messageId: number): boolean {
  const row = db
    .prepare("SELECT 1 as ok FROM chat_room_pins WHERE room_id = ? AND message_id = ? LIMIT 1")
    .get(roomId, messageId) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

export function listPinnedMessagesForRoom(db: Db, userId: number, roomId: number, limit = 20): MessagePinRow[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 20;
  return db.prepare(
    `SELECT
       p.id,
       p.room_id,
       p.message_id,
       p.pinned_by_user_id,
       p.pinned_at,
       m.subject,
       m.body,
       m.created_at as message_created_at,
       u.name as sender_name,
       u.email as sender_email
     FROM chat_room_pins p
     JOIN messages m ON m.id = p.message_id
     JOIN chat_room_members crm ON crm.room_id = p.room_id AND crm.user_id = ? AND crm.status = 'active'
     LEFT JOIN users u ON u.id = m.sender_user_id
     WHERE p.room_id = ?
     ORDER BY datetime(p.pinned_at) DESC, p.id DESC
     LIMIT ?`
  ).all(userId, roomId, safeLimit) as MessagePinRow[];
}

export function getMessageDraft(db: Db, userId: number, roomId: number): MessageDraftRow | null {
  const row = db
    .prepare("SELECT * FROM message_drafts WHERE user_id = ? AND room_id = ? LIMIT 1")
    .get(userId, roomId) as MessageDraftRow | undefined;
  return row ?? null;
}

export function upsertMessageDraft(
  db: Db,
  data: {
    user_id: number;
    room_id: number;
    subject?: string | null;
    body?: string | null;
    reply_to_message_id?: number | null;
    updated_at?: string;
  }
) {
  db.prepare(
    `INSERT INTO message_drafts
     (user_id, room_id, subject, body, reply_to_message_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, room_id) DO UPDATE SET
       subject = excluded.subject,
       body = excluded.body,
       reply_to_message_id = excluded.reply_to_message_id,
       updated_at = excluded.updated_at`
  ).run(
    data.user_id,
    data.room_id,
    data.subject ?? null,
    data.body ?? null,
    data.reply_to_message_id ?? null,
    data.updated_at ?? new Date().toISOString()
  );
}

export function deleteMessageDraft(db: Db, userId: number, roomId: number) {
  db.prepare("DELETE FROM message_drafts WHERE user_id = ? AND room_id = ?").run(userId, roomId);
}

export function createChatRoom(
  db: Db,
  data: {
    room_type: "direct" | "group" | "system";
    title?: string | null;
    created_by_user_id?: number | null;
    created_at?: string;
    updated_at?: string;
  }
): number {
  const createdAt = data.created_at ?? new Date().toISOString();
  const updatedAt = data.updated_at ?? createdAt;
  const result = db
    .prepare(
      `INSERT INTO chat_rooms
       (room_type, title, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(data.room_type, data.title ?? null, data.created_by_user_id ?? null, createdAt, updatedAt);
  return Number(result.lastInsertRowid);
}

export function upsertChatRoomMember(
  db: Db,
  data: {
    room_id: number;
    user_id: number;
    member_role?: "owner" | "member";
    added_at?: string;
  }
) {
  const addedAt = data.added_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO chat_room_members
     (room_id, user_id, member_role, status, added_at, removed_at)
     VALUES (?, ?, ?, 'active', ?, NULL)
     ON CONFLICT(room_id, user_id) DO UPDATE SET
       status = 'active',
       removed_at = NULL,
       member_role = excluded.member_role`
  ).run(data.room_id, data.user_id, data.member_role ?? "member", addedAt);
}

export function removeChatRoomMember(db: Db, roomId: number, userId: number, removedAt = new Date().toISOString()) {
  db.prepare(
    `UPDATE chat_room_members
     SET status = 'removed', removed_at = COALESCE(removed_at, ?)
     WHERE room_id = ? AND user_id = ?`
  ).run(removedAt, roomId, userId);
}

export function deleteMessagesByRoomId(db: Db, roomId: number) {
  db.prepare("DELETE FROM messages WHERE chat_room_id = ?").run(roomId);
}

export function deleteChatRoomById(db: Db, roomId: number) {
  db.prepare("DELETE FROM chat_rooms WHERE id = ?").run(roomId);
}

export function getChatRoomByIdForUser(db: Db, roomId: number, userId: number): ChatRoomRow | null {
  const row = db
    .prepare(
      `SELECT r.*
       FROM chat_rooms r
       JOIN chat_room_members m ON m.room_id = r.id
       WHERE r.id = ?
         AND m.user_id = ?
         AND m.status = 'active'
       LIMIT 1`
    )
    .get(roomId, userId) as ChatRoomRow | undefined;
  return row ?? null;
}

export function getDirectRoomByUsers(db: Db, userA: number, userB: number): ChatRoomRow | null {
  const row = db
    .prepare(
      `SELECT r.*
       FROM chat_rooms r
       JOIN chat_room_members m1 ON m1.room_id = r.id AND m1.user_id = ? AND m1.status = 'active'
       JOIN chat_room_members m2 ON m2.room_id = r.id AND m2.user_id = ? AND m2.status = 'active'
       WHERE r.room_type = 'direct'
         AND (
           SELECT COUNT(*)
           FROM chat_room_members m3
           WHERE m3.room_id = r.id
             AND m3.status = 'active'
         ) = 2
       ORDER BY r.id
       LIMIT 1`
    )
    .get(userA, userB) as ChatRoomRow | undefined;
  return row ?? null;
}

export function getSystemRoomByUser(db: Db, userId: number): ChatRoomRow | null {
  const row = db
    .prepare(
      `SELECT r.*
       FROM chat_rooms r
       JOIN chat_room_members m ON m.room_id = r.id
       WHERE r.room_type = 'system'
         AND m.user_id = ?
         AND m.status = 'active'
       ORDER BY r.id
       LIMIT 1`
    )
    .get(userId) as ChatRoomRow | undefined;
  return row ?? null;
}

export function updateChatRoomUpdatedAt(db: Db, roomId: number, updatedAt = new Date().toISOString()) {
  db.prepare("UPDATE chat_rooms SET updated_at = ? WHERE id = ?").run(updatedAt, roomId);
}

export function listChatRoomMembers(db: Db, roomId: number): ChatRoomMemberRow[] {
  return db
    .prepare(
      `SELECT
         m.room_id,
         m.user_id,
         m.member_role,
         m.status,
         m.added_at,
         m.removed_at,
         u.name,
         u.email
       FROM chat_room_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ?
         AND m.status = 'active'
       ORDER BY CASE WHEN m.member_role = 'owner' THEN 0 ELSE 1 END, lower(COALESCE(u.name, u.email))`
    )
    .all(roomId) as ChatRoomMemberRow[];
}

export function listChatRoomsForUser(db: Db, userId: number, limit = 300): ChatRoomListRow[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 200;
  return db
    .prepare(
      `WITH user_rooms AS (
         SELECT r.id as room_id, r.room_type, r.title as room_title, r.updated_at as room_updated_at
         FROM chat_rooms r
         JOIN chat_room_members me ON me.room_id = r.id AND me.user_id = ? AND me.status = 'active'
       ),
       room_last AS (
         SELECT m.chat_room_id as room_id, MAX(m.id) as last_message_id
         FROM messages m
         JOIN message_boxes mbu ON mbu.message_id = m.id
         WHERE m.chat_room_id IN (SELECT room_id FROM user_rooms)
           AND mbu.user_id = ?
           AND mbu.folder != 'deleted'
         GROUP BY m.chat_room_id
       )
       SELECT
         ur.room_id,
         ur.room_type,
         ur.room_title,
         ur.room_updated_at,
         CASE WHEN ur.room_type = 'direct'
           THEN (
             SELECT m2.user_id
             FROM chat_room_members m2
             WHERE m2.room_id = ur.room_id
               AND m2.user_id != ?
               AND m2.status = 'active'
             LIMIT 1
           )
           ELSE NULL
         END as partner_user_id,
         CASE WHEN ur.room_type = 'direct'
           THEN (
             SELECT u2.name
             FROM chat_room_members m2
             JOIN users u2 ON u2.id = m2.user_id
             WHERE m2.room_id = ur.room_id
               AND m2.user_id != ?
               AND m2.status = 'active'
             LIMIT 1
           )
           ELSE NULL
         END as partner_name,
         CASE WHEN ur.room_type = 'direct'
           THEN (
             SELECT u2.email
             FROM chat_room_members m2
             JOIN users u2 ON u2.id = m2.user_id
             WHERE m2.room_id = ur.room_id
               AND m2.user_id != ?
               AND m2.status = 'active'
             LIMIT 1
           )
           ELSE NULL
         END as partner_email,
         lm.created_at as last_message_at,
         lm.subject as last_subject,
         lm.body as last_body,
         COALESCE((
           SELECT COUNT(*)
           FROM message_boxes mb
           JOIN messages m ON m.id = mb.message_id
           WHERE mb.user_id = ?
             AND mb.status = 'unread'
             AND mb.folder != 'deleted'
             AND m.chat_room_id = ur.room_id
         ), 0) as unread_count
         ,
         COALESCE((
           SELECT COUNT(*)
           FROM message_boxes mb
           JOIN messages m ON m.id = mb.message_id
           WHERE mb.user_id = ?
             AND mb.status = 'unread'
             AND mb.folder != 'deleted'
             AND mb.mention_flag = 1
             AND m.chat_room_id = ur.room_id
         ), 0) as mention_unread_count
         ,
         (
           SELECT COUNT(*)
           FROM chat_room_members cmc
           WHERE cmc.room_id = ur.room_id
             AND cmc.status = 'active'
         ) as members_count
       FROM user_rooms ur
       LEFT JOIN room_last rl ON rl.room_id = ur.room_id
       LEFT JOIN messages lm ON lm.id = rl.last_message_id
       ORDER BY datetime(COALESCE(lm.created_at, ur.room_updated_at)) DESC, ur.room_id DESC
       LIMIT ?`
    )
    .all(userId, userId, userId, userId, userId, userId, userId, safeLimit) as ChatRoomListRow[];
}

export function listChatRoomMessages(
  db: Db,
  userId: number,
  roomId: number,
  options?: {
    limit?: number;
    searchQuery?: string;
    filter?: "all" | "mentions" | "attachments" | "system";
  }
): DirectThreadMessageRow[] {
  const limit = options?.limit ?? 500;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 500;
  const searchQuery = String(options?.searchQuery ?? "").trim();
  const filter = String(options?.filter ?? "all").trim().toLowerCase();
  const searchLike = searchQuery ? `%${searchQuery.replace(/[%_]/g, "\\$&")}%` : null;
  return db
    .prepare(
      `WITH room_seq AS (
         SELECT
           m.id as message_id,
           ROW_NUMBER() OVER (
             PARTITION BY m.chat_room_id
             ORDER BY datetime(m.created_at) ASC, m.id ASC
           ) as message_no
         FROM messages m
         WHERE m.chat_room_id = ?
       )
       SELECT
         mb.id,
         mb.message_id,
         mb.user_id,
         mb.folder,
         mb.status,
         mb.mention_flag,
         mb.deleted_at,
         mb.read_at,
         mb.created_at,
         m.kind,
         m.visibility,
         m.chat_room_id,
         m.reply_to_message_id,
         m.sender_user_id,
         m.subject,
         m.body,
         m.payload_json,
         m.created_at as message_created_at,
         m.edited_at,
         m.edit_count,
         su.name as sender_name,
         su.email as sender_email,
         CASE WHEN pin.message_id IS NULL THEN 0 ELSE 1 END as is_pinned,
         rm.subject as reply_subject,
         rm.body as reply_body,
         rsu.name as reply_sender_name,
         rsu.email as reply_sender_email,
         CASE WHEN m.sender_user_id = ? THEN 'outgoing' ELSE 'incoming' END as direction,
         rs.message_no as message_no
       FROM message_boxes mb
       JOIN messages m ON m.id = mb.message_id
       JOIN room_seq rs ON rs.message_id = m.id
       LEFT JOIN users su ON su.id = m.sender_user_id
       LEFT JOIN chat_room_pins pin ON pin.message_id = m.id AND pin.room_id = m.chat_room_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
       LEFT JOIN users rsu ON rsu.id = rm.sender_user_id
       WHERE mb.user_id = ?
         AND mb.folder != 'deleted'
         AND m.chat_room_id = ?
         AND (
           ? = ''
           OR COALESCE(m.subject, '') LIKE ? ESCAPE '$'
           OR COALESCE(m.body, '') LIKE ? ESCAPE '$'
           OR COALESCE(su.name, '') LIKE ? ESCAPE '$'
           OR COALESCE(su.email, '') LIKE ? ESCAPE '$'
         )
         AND (
           ? = 'all'
           OR (? = 'mentions' AND mb.mention_flag = 1)
           OR (? = 'attachments' AND COALESCE(m.payload_json, '') != '')
           OR (? = 'system' AND m.kind = 'system')
         )
       ORDER BY datetime(m.created_at) ASC, m.id ASC
       LIMIT ?`
    )
    .all(
      roomId,
      userId,
      userId,
      roomId,
      searchQuery,
      searchLike,
      searchLike,
      searchLike,
      searchLike,
      filter,
      filter,
      filter,
      filter,
      safeLimit
    ) as DirectThreadMessageRow[];
}

export function markChatRoomRead(
  db: Db,
  userId: number,
  roomId: number,
  readAt = new Date().toISOString()
) {
  db.prepare(
    `UPDATE message_boxes
     SET status = 'read', read_at = COALESCE(read_at, ?)
     WHERE user_id = ?
       AND folder != 'deleted'
       AND status = 'unread'
       AND message_id IN (
         SELECT m.id
         FROM messages m
         WHERE m.chat_room_id = ?
       )`
  ).run(readAt, userId, roomId);
}
