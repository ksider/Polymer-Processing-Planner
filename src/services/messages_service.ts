import type { Db } from "../db.js";
import { findUserById } from "../repos/users_repo.js";
import {
  normalizeMessageBoxFolder,
  normalizeMessageKind,
  normalizeMessageVisibility,
  type MessageBoxFolder,
  type MessageBoxStatus,
  type MessagePayload,
  type MessageVisibility,
  type SendMessageInput
} from "../domain/messages.js";
import {
  createChatRoom,
  countUnreadMessageBoxes,
  createMessage,
  createMessageBox,
  deleteChatRoomById,
  deleteMessagesByRoomId,
  getChatRoomByIdForUser,
  getDirectRoomByUsers,
  getSystemRoomByUser,
  getMessageBoxById,
  getMessageById,
  listChatRoomMembers,
  listChatRoomMessages,
  listChatRoomsForUser,
  listCollectiveMessageBoxes,
  listMessageBoxesByFolder,
  listUnreadMessageBoxes,
  markChatRoomRead,
  markAllCollectiveMessageBoxesRead,
  markAllMessageBoxesRead,
  markMessageBoxRead,
  moveMessageBoxToDeleted,
  removeChatRoomMember,
  updateChatRoomUpdatedAt,
  upsertChatRoomMember,
  restoreDeletedMessageBox
} from "../repos/messages_repo.js";

export type MessageListItem = {
  id: number;
  message_id: number;
  user_id: number;
  folder: MessageBoxFolder;
  status: MessageBoxStatus;
  mention_flag: number;
  deleted_at: string | null;
  read_at: string | null;
  created_at: string;
  kind: string;
  visibility: string;
  sender_user_id: number | null;
  subject: string;
  body: string | null;
  payload_json: string | null;
  message_created_at: string;
  sender_name: string | null;
  sender_email: string | null;
  payload: MessagePayload | null;
};

export type DirectConversationItem = {
  room_id: number;
  room_type: "direct" | "group" | "system";
  title: string;
  partner_user_id: number | null;
  partner_name: string | null;
  partner_email: string | null;
  last_message_at: string;
  last_subject: string;
  last_body: string | null;
  unread_count: number;
  mention_unread_count: number;
  members_count: number;
};

export type DirectThreadMessageItem = MessageListItem & {
  direction: "incoming" | "outgoing";
  message_no: number;
};

export type ChatRoomMemberItem = {
  room_id: number;
  user_id: number;
  member_role: "owner" | "member";
  status: "active" | "removed";
  added_at: string;
  removed_at: string | null;
  name: string | null;
  email: string | null;
};

function normalizeSubject(subject: unknown) {
  return String(subject ?? "").trim();
}

function roleWeight(role: string | null | undefined): number {
  switch (String(role ?? "").toLowerCase()) {
    case "admin":
      return 5;
    case "manager":
      return 4;
    case "engineer":
      return 3;
    case "operator":
      return 2;
    case "viewer":
      return 1;
    default:
      return 0;
  }
}

function mentionTokenVariants(name: string | null | undefined, email: string | null | undefined): string[] {
  const tokens: string[] = [];
  const safeName = String(name ?? "").trim();
  const safeEmail = String(email ?? "").trim();
  if (safeName) tokens.push(`@${safeName.toLowerCase()}`);
  if (safeEmail) tokens.push(`@${safeEmail.toLowerCase()}`);
  return [...new Set(tokens)];
}

function extractMentionedUserIds(
  body: string,
  members: Array<{ user_id: number; name: string | null; email: string | null }>,
  senderUserId: number
): number[] {
  const text = String(body || "").toLowerCase();
  if (!text.includes("@")) return [];
  const mentioned = new Set<number>();
  for (const member of members) {
    if (member.user_id === senderUserId) continue;
    const variants = mentionTokenVariants(member.name, member.email);
    if (variants.some((token) => text.includes(token))) {
      mentioned.add(member.user_id);
    }
  }
  return [...mentioned];
}

function normalizeRecipientIds(recipientIds: unknown): number[] {
  if (!Array.isArray(recipientIds)) return [];
  const set = new Set<number>();
  for (const raw of recipientIds) {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0) continue;
    set.add(id);
  }
  return [...set];
}

function serializePayload(payload: MessagePayload | null | undefined): string | null {
  if (!payload || typeof payload !== "object") return null;
  return JSON.stringify(payload);
}

function parsePayload(payloadJson: string | null): MessagePayload | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as MessagePayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hydrateListItem(row: Omit<MessageListItem, "payload">): MessageListItem {
  return {
    ...row,
    payload: parsePayload(row.payload_json)
  };
}

function defaultRestoreFolder(senderUserId: number | null, userId: number): MessageBoxFolder {
  return senderUserId && senderUserId === userId ? "sent" : "inbox";
}

export function sendMessage(db: Db, input: SendMessageInput) {
  const subject = normalizeSubject(input.subject);
  if (!subject) {
    throw new Error("Message subject is required.");
  }

  const senderUserId = Number(input.sender_user_id);
  const normalizedSenderUserId =
    Number.isFinite(senderUserId) && senderUserId > 0 ? senderUserId : null;
  const recipientIds = normalizeRecipientIds(input.recipient_user_ids);
  if (recipientIds.length === 0) {
    throw new Error("At least one recipient is required.");
  }

  const visibility = normalizeMessageVisibility(input.visibility);
  const kind = normalizeMessageKind(input.kind);
  const payloadJson = serializePayload(input.payload ?? null);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    let chatRoomId: number | null = null;
    if (visibility === "direct" && normalizedSenderUserId && recipientIds.length === 1) {
      const existing = getDirectRoomByUsers(db, normalizedSenderUserId, recipientIds[0]);
      if (existing?.id) {
        chatRoomId = existing.id;
      } else {
        chatRoomId = createChatRoom(db, {
          room_type: "direct",
          title: null,
          created_by_user_id: normalizedSenderUserId,
          created_at: now,
          updated_at: now
        });
        upsertChatRoomMember(db, {
          room_id: chatRoomId,
          user_id: normalizedSenderUserId,
          member_role: "owner",
          added_at: now
        });
        upsertChatRoomMember(db, {
          room_id: chatRoomId,
          user_id: recipientIds[0],
          member_role: "member",
          added_at: now
        });
      }
    } else if (visibility === "collective" || recipientIds.length > 1) {
      chatRoomId = createChatRoom(db, {
        room_type: "group",
        title: subject,
        created_by_user_id: normalizedSenderUserId,
        created_at: now,
        updated_at: now
      });
      const participants = new Set<number>(recipientIds);
      if (normalizedSenderUserId) participants.add(normalizedSenderUserId);
      for (const participant of participants) {
        upsertChatRoomMember(db, {
          room_id: chatRoomId,
          user_id: participant,
          member_role: normalizedSenderUserId === participant ? "owner" : "member",
          added_at: now
        });
      }
    } else if (!normalizedSenderUserId && recipientIds.length === 1) {
      const existing = getSystemRoomByUser(db, recipientIds[0]);
      chatRoomId = existing?.id ?? createChatRoom(db, {
        room_type: "system",
        title: "Notifications",
        created_by_user_id: null,
        created_at: now,
        updated_at: now
      });
      upsertChatRoomMember(db, {
        room_id: chatRoomId,
        user_id: recipientIds[0],
        member_role: "member",
        added_at: now
      });
    }

    const messageId = createMessage(db, {
      kind,
      visibility,
      chat_room_id: chatRoomId,
      sender_user_id: normalizedSenderUserId,
      subject,
      body: input.body ?? null,
      payload_json: payloadJson,
      created_at: now
    });

    const boxIds: number[] = [];

    if (normalizedSenderUserId) {
      const senderBoxId = createMessageBox(db, {
        message_id: messageId,
        user_id: normalizedSenderUserId,
        folder: "sent",
        status: "read",
        mention_flag: 0,
        read_at: now,
        created_at: now
      });
      boxIds.push(senderBoxId);
    }

    const recipientSet = new Set(recipientIds);
    if (normalizedSenderUserId) recipientSet.delete(normalizedSenderUserId);
    for (const recipientUserId of recipientSet) {
      const boxId = createMessageBox(db, {
        message_id: messageId,
        user_id: recipientUserId,
        folder: "inbox",
        status: "unread",
        mention_flag: 0,
        created_at: now
      });
      boxIds.push(boxId);
    }

    if (chatRoomId) {
      updateChatRoomUpdatedAt(db, chatRoomId, now);
    }

    return {
      messageId,
      roomId: chatRoomId,
      boxIds,
      recipientCount: recipientSet.size
    };
  });

  return tx();
}

export function sendSystemMessageFromActor(
  db: Db,
  data: {
    actor_user_id: number | null;
    recipient_user_ids: number[];
    subject: string;
    body?: string | null;
    payload?: MessagePayload | null;
    kind?: "system" | "assignment" | "task";
    visibility?: "direct" | "collective";
  }
) {
  const kind = data.kind ?? "system";
  const visibility = data.visibility ?? (data.recipient_user_ids.length > 1 ? "collective" : "direct");
  return sendMessage(db, {
    kind,
    visibility,
    sender_user_id: data.actor_user_id,
    recipient_user_ids: data.recipient_user_ids,
    subject: data.subject,
    body: data.body ?? null,
    payload: data.payload ?? null
  });
}

export function listByFolder(db: Db, userId: number, folder: MessageBoxFolder, limit = 50): MessageListItem[] {
  const normalizedFolder = normalizeMessageBoxFolder(folder);
  return listMessageBoxesByFolder(db, userId, normalizedFolder, limit).map((row) =>
    hydrateListItem(row as Omit<MessageListItem, "payload">)
  );
}

export function listUnreadForPopup(db: Db, userId: number, limit = 20): MessageListItem[] {
  return listUnreadMessageBoxes(db, userId, limit).map((row) =>
    hydrateListItem(row as Omit<MessageListItem, "payload">)
  );
}

export function listCollectiveForUser(db: Db, userId: number, limit = 50): MessageListItem[] {
  return listCollectiveMessageBoxes(db, userId, limit).map((row) =>
    hydrateListItem(row as Omit<MessageListItem, "payload">)
  );
}

export function countUnread(db: Db, userId: number): number {
  return countUnreadMessageBoxes(db, userId);
}

export function markRead(db: Db, userId: number, messageBoxId: number) {
  markMessageBoxRead(db, messageBoxId, userId);
}

export function markAllRead(db: Db, userId: number, folder?: MessageBoxFolder) {
  const normalized = folder ? normalizeMessageBoxFolder(folder) : undefined;
  markAllMessageBoxesRead(db, userId, normalized);
}

export function markAllCollectiveRead(db: Db, userId: number) {
  markAllCollectiveMessageBoxesRead(db, userId);
}

export function deleteForUser(db: Db, userId: number, messageBoxId: number) {
  moveMessageBoxToDeleted(db, messageBoxId, userId);
}

export function deleteForUserWithPolicy(
  db: Db,
  data: { userId: number; actorRole?: string | null; messageBoxId: number }
): boolean {
  const box = getMessageBoxById(db, data.messageBoxId, data.userId);
  if (!box) return false;
  const message = getMessageById(db, box.message_id);
  if (!message) return false;
  const isOwn = Number(message.sender_user_id) === Number(data.userId);
  const isAdmin = String(data.actorRole ?? "").toLowerCase() === "admin";
  if (!isOwn && !isAdmin) return false;
  moveMessageBoxToDeleted(db, data.messageBoxId, data.userId);
  return true;
}

export function restoreForUser(db: Db, userId: number, messageBoxId: number) {
  const box = getMessageBoxById(db, messageBoxId, userId);
  if (!box || box.folder !== "deleted") return;
  const message = getMessageById(db, box.message_id);
  const restoreFolder = defaultRestoreFolder(message?.sender_user_id ?? null, userId);
  restoreDeletedMessageBox(db, messageBoxId, userId, restoreFolder);
}

export function listDirectConversations(db: Db, userId: number, limit = 200): DirectConversationItem[] {
  return listChatRoomsForUser(db, userId, limit)
    .filter((row) => row.room_type === "group" || Boolean(row.last_message_at))
    .map((row) => {
      const partnerLabel = row.partner_name || row.partner_email || (row.partner_user_id ? `User #${row.partner_user_id}` : null);
      const title =
        row.room_type === "direct"
          ? partnerLabel || "Direct chat"
          : (row.room_title || (row.room_type === "system" ? "Notifications" : "Group chat"));
      return {
        room_id: row.room_id,
        room_type: row.room_type,
        title,
        partner_user_id: row.partner_user_id,
        partner_name: row.partner_name,
        partner_email: row.partner_email,
        last_message_at: row.last_message_at || row.room_updated_at,
        last_subject: row.last_subject || "",
        last_body: row.last_body,
        unread_count: Number(row.unread_count || 0),
        mention_unread_count: Number(row.mention_unread_count || 0),
        members_count: Number(row.members_count || 0)
      };
    });
}

export function listDirectThread(
  db: Db,
  userId: number,
  roomId: number,
  limit = 500
): DirectThreadMessageItem[] {
  return listChatRoomMessages(db, userId, roomId, limit).map((row) => ({
    ...row,
    payload: parsePayload(row.payload_json)
  }));
}

export function markDirectThreadRead(db: Db, userId: number, roomId: number) {
  markChatRoomRead(db, userId, roomId);
}

export function getRoomForUser(db: Db, userId: number, roomId: number) {
  return getChatRoomByIdForUser(db, roomId, userId);
}

export function listRoomMembersForUser(db: Db, userId: number, roomId: number): ChatRoomMemberItem[] {
  const room = getChatRoomByIdForUser(db, roomId, userId);
  if (!room) return [];
  return listChatRoomMembers(db, roomId);
}

export function ensureDirectRoom(db: Db, userId: number, partnerUserId: number): number {
  const existing = getDirectRoomByUsers(db, userId, partnerUserId);
  if (existing?.id) return existing.id;
  const now = new Date().toISOString();
  const roomId = createChatRoom(db, {
    room_type: "direct",
    title: null,
    created_by_user_id: userId,
    created_at: now,
    updated_at: now
  });
  upsertChatRoomMember(db, { room_id: roomId, user_id: userId, member_role: "owner", added_at: now });
  upsertChatRoomMember(db, { room_id: roomId, user_id: partnerUserId, member_role: "member", added_at: now });
  return roomId;
}

export function createGroupRoom(
  db: Db,
  creatorUserId: number,
  memberUserIds: number[],
  title: string
): number {
  const now = new Date().toISOString();
  const roomId = createChatRoom(db, {
    room_type: "group",
    title: title.trim() || "Group chat",
    created_by_user_id: creatorUserId,
    created_at: now,
    updated_at: now
  });
  const members = new Set<number>(memberUserIds.filter((id) => Number.isFinite(id) && id > 0));
  members.add(creatorUserId);
  for (const userId of members) {
    upsertChatRoomMember(db, {
      room_id: roomId,
      user_id: userId,
      member_role: userId === creatorUserId ? "owner" : "member",
      added_at: now
    });
  }
  return roomId;
}

export function sendMessageToRoom(
  db: Db,
  data: {
    roomId: number;
    senderUserId: number;
    subject: string;
    body?: string | null;
    kind?: "manual" | "system" | "assignment" | "task";
    payload?: MessagePayload | null;
  }
) {
  const roomMemberRows = listChatRoomMembers(db, data.roomId);
  const roomMembers = roomMemberRows.map((member) => member.user_id);
  if (!roomMembers.includes(data.senderUserId)) {
    throw new Error("Sender is not room member.");
  }
  const room = getChatRoomByIdForUser(db, data.roomId, data.senderUserId);
  if (!room) throw new Error("Room not found.");
  const visibility: MessageVisibility = room.room_type === "group" ? "collective" : "direct";
  const now = new Date().toISOString();
  const payloadJson = serializePayload(data.payload ?? null);
  const kind = normalizeMessageKind(data.kind ?? "manual");
  const mentionedUserIds = new Set<number>(
    extractMentionedUserIds(data.body ?? "", roomMemberRows, data.senderUserId)
  );

  const tx = db.transaction(() => {
    const messageId = createMessage(db, {
      kind,
      visibility,
      chat_room_id: data.roomId,
      sender_user_id: data.senderUserId,
      subject: normalizeSubject(data.subject),
      body: data.body ?? null,
      payload_json: payloadJson,
      created_at: now
    });
    for (const memberId of roomMembers) {
      createMessageBox(db, {
        message_id: messageId,
        user_id: memberId,
        folder: memberId === data.senderUserId ? "sent" : "inbox",
        status: memberId === data.senderUserId ? "read" : "unread",
        mention_flag: memberId !== data.senderUserId && mentionedUserIds.has(memberId) ? 1 : 0,
        read_at: memberId === data.senderUserId ? now : null,
        created_at: now
      });
    }
    updateChatRoomUpdatedAt(db, data.roomId, now);
    return messageId;
  });
  return tx();
}

export function addRoomMember(
  db: Db,
  roomId: number,
  actorUserId: number,
  targetUserId: number,
  actorRole?: string | null
) {
  const room = getChatRoomByIdForUser(db, roomId, actorUserId);
  if (!room) throw new Error("Room not found.");
  if (room.room_type === "direct" || room.room_type === "system") {
    throw new Error("Cannot change participants in this room.");
  }
  const members = listChatRoomMembers(db, roomId);
  const actorMember = members.find((member) => member.user_id === actorUserId);
  const canManage = actorRole === "admin" || actorRole === "manager" || actorMember?.member_role === "owner";
  if (!canManage) throw new Error("Forbidden");
  const actorUser = findUserById(db, actorUserId);
  const targetUser = findUserById(db, targetUserId);
  if (!targetUser || targetUser.status !== "ACTIVE") throw new Error("Target user is not active.");
  const actorRank = roleWeight(actorRole ?? actorUser?.role ?? null);
  const targetRank = roleWeight(targetUser.role ?? null);
  if (targetRank >= actorRank) throw new Error("Cannot add user with equal/higher role.");
  upsertChatRoomMember(db, {
    room_id: roomId,
    user_id: targetUserId,
    member_role: "member"
  });
}

export function removeRoomMember(
  db: Db,
  roomId: number,
  actorUserId: number,
  targetUserId: number,
  actorRole?: string | null
) {
  const room = getChatRoomByIdForUser(db, roomId, actorUserId);
  if (!room) throw new Error("Room not found.");
  if (room.room_type === "direct" || room.room_type === "system") {
    throw new Error("Cannot change participants in this room.");
  }
  const members = listChatRoomMembers(db, roomId);
  const actorMember = members.find((member) => member.user_id === actorUserId);
  const targetMember = members.find((member) => member.user_id === targetUserId);
  const canManage = actorRole === "admin" || actorRole === "manager" || actorMember?.member_role === "owner";
  if (!canManage || !targetMember) throw new Error("Forbidden");
  if (targetMember.member_role === "owner" && actorRole !== "admin") {
    throw new Error("Owner cannot be removed.");
  }
  removeChatRoomMember(db, roomId, targetUserId);
}

export function deleteGroupRoom(
  db: Db,
  roomId: number,
  actorUserId: number,
  actorRole?: string | null
) {
  const room = getChatRoomByIdForUser(db, roomId, actorUserId);
  if (!room) throw new Error("Room not found.");
  if (room.room_type !== "group") throw new Error("Only group chats can be deleted.");
  const members = listChatRoomMembers(db, roomId);
  const actorMember = members.find((member) => member.user_id === actorUserId);
  const canDelete = actorRole === "admin" || actorRole === "manager" || actorMember?.member_role === "owner";
  if (!canDelete) throw new Error("Forbidden");

  const tx = db.transaction(() => {
    deleteMessagesByRoomId(db, roomId);
    deleteChatRoomById(db, roomId);
  });
  tx();
}
