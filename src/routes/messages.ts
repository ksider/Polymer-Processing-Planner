import express from "express";
import type { Db } from "../db.js";
import { findUserById, listUsers } from "../repos/users_repo.js";
import {
  addRoomMember,
  countUnread,
  createGroupRoom,
  deleteForUserWithPolicy,
  ensureDirectRoom,
  getRoomForUser,
  listByFolder,
  listDirectConversations,
  listDirectThread,
  listRoomMembersForUser,
  listUnreadForPopup,
  markDirectThreadRead,
  markRead,
  deleteGroupRoom,
  removeRoomMember,
  restoreForUser,
  sendMessageToRoom
} from "../services/messages_service.js";

type MessagesView = "chat" | "deleted";

function roleWeight(role: unknown): number {
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

function normalizeView(value: unknown): MessagesView {
  const view = String(value ?? "").trim().toLowerCase();
  if (view === "deleted") return "deleted";
  return "chat";
}

function toUserId(value: unknown): number | null {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function createMessagesRouter(db: Db) {
  const router = express.Router();

  router.get("/messages/unread.json", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const limit = Number(req.query.limit);
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 12;
    const unread = listUnreadForPopup(db, req.user.id, safeLimit);
    return res.json({
      unread_count: countUnread(db, req.user.id),
      items: unread
    });
  });

  router.get("/messages", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const view = normalizeView(req.query.view);

    const openUserId = toUserId(req.query.user_id);
    if (view === "chat" && openUserId && openUserId !== req.user.id) {
      const partner = findUserById(db, openUserId);
      if (partner && partner.status === "ACTIVE") {
        const roomId = ensureDirectRoom(db, req.user.id, openUserId);
        return res.redirect(`/messages?view=chat&room_id=${roomId}`);
      }
    }

    const users = listUsers(db)
      .filter((user) => user.status === "ACTIVE" && user.id !== req.user?.id)
      .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    const currentRank = roleWeight(req.user?.role);
    const subordinateUsers = users.filter((user) => roleWeight(user.role) < currentRank);

    const rooms = listDirectConversations(db, req.user.id, 500).sort((a, b) => {
      const weight = (type: string) => (type === "system" ? 0 : type === "group" ? 1 : 2);
      const byType = weight(a.room_type) - weight(b.room_type);
      if (byType !== 0) return byType;
      const aTs = new Date(a.last_message_at || 0).getTime();
      const bTs = new Date(b.last_message_at || 0).getTime();
      return bTs - aTs;
    });
    const directPartnerIds = new Set(
      rooms
        .filter((room) => room.room_type === "direct" && room.partner_user_id)
        .map((room) => Number(room.partner_user_id))
    );
    const usersWithoutConversation = users.filter((user) => !directPartnerIds.has(Number(user.id)));

    const roomId = toUserId(req.query.room_id);
    const selectedMessageId = toUserId(req.query.message_id);
    let activeRoom = null as ReturnType<typeof getRoomForUser>;
    let threadMessages = [] as ReturnType<typeof listDirectThread>;
    let roomMembers = [] as ReturnType<typeof listRoomMembersForUser>;
    if (view === "chat") {
      const fallbackRoomId = roomId ?? rooms[0]?.room_id ?? null;
      if (fallbackRoomId) {
        activeRoom = getRoomForUser(db, req.user.id, fallbackRoomId);
        if (activeRoom) {
          markDirectThreadRead(db, req.user.id, fallbackRoomId);
          threadMessages = listDirectThread(db, req.user.id, fallbackRoomId, 1000);
          roomMembers = listRoomMembersForUser(db, req.user.id, fallbackRoomId);
        }
      }
    }

    const deletedItems = view === "deleted" ? listByFolder(db, req.user.id, "deleted", 500) : [];
    const canManageMembers =
      req.user.role === "admin" ||
      req.user.role === "manager" ||
      (activeRoom &&
        roomMembers.some((member) => member.user_id === req.user?.id && member.member_role === "owner"));

    return res.render("messages", {
      title: "Messages",
      view,
      rooms,
      users,
      subordinateUsers,
      usersWithoutConversation,
      activeRoom,
      threadMessages,
      selectedMessageId,
      roomMembers,
      deletedItems,
      canManageMembers: Boolean(canManageMembers),
      sendError: null
    });
  });

  router.post("/messages/rooms/create-group", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const title = String(req.body?.title ?? "").trim();
    const recipientsRaw = Array.isArray(req.body?.recipient_user_ids)
      ? req.body.recipient_user_ids
      : req.body?.recipient_user_ids != null
        ? [req.body.recipient_user_ids]
        : [];
    const recipients = recipientsRaw
      .map((value: unknown) => Number(value))
      .filter((id: number) => Number.isFinite(id) && id > 0 && id !== req.user?.id);
    const roomId = createGroupRoom(db, req.user.id, recipients, title || "Group chat");
    return res.redirect(`/messages?view=chat&room_id=${roomId}`);
  });

  router.post("/messages/rooms/:roomId/send", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const roomId = toUserId(req.params.roomId);
    if (!roomId) return res.redirect("/messages?view=chat");
    const subject = String(req.body?.subject ?? "").trim();
    const body = String(req.body?.body ?? "").trim();
    try {
      sendMessageToRoom(db, {
        roomId,
        senderUserId: req.user.id,
        subject,
        body: body || null,
        kind: "manual"
      });
    } catch {
      // no-op; stay in room
    }
    return res.redirect(`/messages?view=chat&room_id=${roomId}`);
  });

  router.post("/messages/rooms/:roomId/read", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const roomId = toUserId(req.params.roomId);
    if (!roomId) return res.redirect("/messages?view=chat");
    markDirectThreadRead(db, req.user.id, roomId);
    return res.redirect(`/messages?view=chat&room_id=${roomId}`);
  });

  router.post("/messages/rooms/:roomId/members/add", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const roomId = toUserId(req.params.roomId);
    const targetUserId = toUserId(req.body?.user_id);
    if (!roomId || !targetUserId) return res.redirect("/messages?view=chat");
    try {
      addRoomMember(db, roomId, req.user.id, targetUserId, req.user.role);
    } catch {
      // ignore; no change
    }
    return res.redirect(`/messages?view=chat&room_id=${roomId}`);
  });

  router.post("/messages/rooms/:roomId/members/:userId/remove", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const roomId = toUserId(req.params.roomId);
    const targetUserId = toUserId(req.params.userId);
    if (!roomId || !targetUserId) return res.redirect("/messages?view=chat");
    try {
      removeRoomMember(db, roomId, req.user.id, targetUserId, req.user.role);
    } catch {
      // ignore; no change
    }
    return res.redirect(`/messages?view=chat&room_id=${roomId}`);
  });

  router.post("/messages/rooms/:roomId/delete", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const roomId = toUserId(req.params.roomId);
    if (!roomId) return res.redirect("/messages?view=chat");
    try {
      deleteGroupRoom(db, roomId, req.user.id, req.user.role);
    } catch {
      return res.redirect(`/messages?view=chat&room_id=${roomId}`);
    }
    return res.redirect("/messages?view=chat");
  });

  router.post("/messages/:id/read", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const messageBoxId = Number(req.params.id);
    if (Number.isFinite(messageBoxId)) {
      markRead(db, req.user.id, messageBoxId);
    }
    return res.redirect("/messages?view=deleted");
  });

  router.post("/messages/:id/read.json", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const messageBoxId = Number(req.params.id);
    if (!Number.isFinite(messageBoxId)) return res.status(400).json({ error: "Invalid message id" });
    markRead(db, req.user.id, messageBoxId);
    return res.json({ ok: true, unread_count: countUnread(db, req.user.id) });
  });

  router.post("/messages/read-all.json", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const userId = req.user.id;
    const rooms = listDirectConversations(db, userId, 500);
    rooms.forEach((room) => markDirectThreadRead(db, userId, room.room_id));
    return res.json({ ok: true, unread_count: countUnread(db, userId) });
  });

  router.post("/messages/:id/delete", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const messageBoxId = Number(req.params.id);
    if (Number.isFinite(messageBoxId)) {
      deleteForUserWithPolicy(db, {
        userId: req.user.id,
        actorRole: req.user.role,
        messageBoxId
      });
    }
    return res.redirect("/messages?view=deleted");
  });

  router.post("/messages/:id/restore", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const messageBoxId = Number(req.params.id);
    if (Number.isFinite(messageBoxId)) {
      restoreForUser(db, req.user.id, messageBoxId);
    }
    return res.redirect("/messages?view=deleted");
  });

  return router;
}
