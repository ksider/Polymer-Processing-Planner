import express from "express";
import type { Db } from "../db.js";
import { getProcessById } from "../repos/processes_repo.js";
import { listExperimentsByProcessForUserWithMeta } from "../repos/experiments_repo.js";
import {
  decodeCalendarEventToken,
  listMyCalendarEvents,
  listProcessCalendarEvents,
  moveCalendarEventDate
} from "../services/calendar_service.js";

function hasPrivilegedRole(role: string | undefined): boolean {
  return role === "admin" || role === "manager";
}

function canViewProcessCalendar(db: Db, processId: number, userId: number, role?: string): { ok: boolean; visibleExperimentIds?: number[] } {
  if (hasPrivilegedRole(role)) return { ok: true };
  const process = getProcessById(db, processId);
  if (!process) return { ok: false };
  if (process.owner_user_id === userId) return { ok: true };

  const visibleExperiments = listExperimentsByProcessForUserWithMeta(db, processId, userId, false);
  if (!visibleExperiments.length) return { ok: false };
  return { ok: true, visibleExperimentIds: visibleExperiments.map((row) => row.id) };
}

function canMoveCalendarEvent(db: Db, token: string, userId: number, role?: string): boolean {
  if (hasPrivilegedRole(role)) return true;
  const decoded = decodeCalendarEventToken(token);
  if (!decoded) return false;

  if (decoded.entityType === "task") {
    const row = db.prepare(`
      SELECT t.owner_user_id, e.process_id
      FROM tasks t
      JOIN experiments e ON e.id = t.experiment_id
      WHERE t.id = ?
    `).get(decoded.entityId) as { owner_user_id: number | null; process_id: number | null } | undefined;
    if (!row) return false;
    if (row.owner_user_id === userId) return true;
    const process = row.process_id ? getProcessById(db, row.process_id) : null;
    return Boolean(process && process.owner_user_id === userId);
  }

  if (decoded.entityType === "run") {
    const row = db.prepare(`
      SELECT r.owner_user_id, e.process_id
      FROM runs r
      JOIN experiments e ON e.id = r.experiment_id
      WHERE r.id = ?
    `).get(decoded.entityId) as { owner_user_id: number | null; process_id: number | null } | undefined;
    if (!row) return false;
    if (row.owner_user_id === userId) return true;
    const process = row.process_id ? getProcessById(db, row.process_id) : null;
    return Boolean(process && process.owner_user_id === userId);
  }

  const qRow = db.prepare(`
    SELECT e.owner_user_id, e.process_id
    FROM qual_runs qr
    JOIN experiments e ON e.id = qr.experiment_id
    WHERE qr.id = ?
  `).get(decoded.entityId) as { owner_user_id: number | null; process_id: number | null } | undefined;
  if (!qRow) return false;
  if (qRow.owner_user_id === userId) return true;
  const qProcess = qRow.process_id ? getProcessById(db, qRow.process_id) : null;
  return Boolean(qProcess && qProcess.owner_user_id === userId);
}

export function createCalendarRouter(db: Db) {
  const router = express.Router();

  router.get("/calendar/events", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });

    const scope = String(req.query.scope || "my").toLowerCase();
    if (scope === "process") {
      const processId = Number(req.query.process_id || 0);
      if (!Number.isFinite(processId) || processId <= 0) {
        return res.status(400).json({ error: "Invalid process_id" });
      }
      const access = canViewProcessCalendar(db, processId, req.user.id, req.user.role ?? undefined);
      if (!access.ok) return res.status(403).json({ error: "Forbidden" });
      const events = listProcessCalendarEvents(db, processId, {
        onlyVisibleExperimentIds: access.visibleExperimentIds
      });
      return res.json({ events });
    }

    const events = listMyCalendarEvents(db, req.user.id);
    return res.json({ events });
  });

  router.patch("/calendar/events/:id/move", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const eventToken = String(req.params.id || "");
    if (!canMoveCalendarEvent(db, eventToken, req.user.id, req.user.role ?? undefined)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const startsAt = req.body?.starts_at;
    const moved = moveCalendarEventDate(db, eventToken, startsAt);
    if (!moved) return res.status(400).json({ error: "Invalid event or date" });

    db.prepare(
      `INSERT INTO audit_log (actor_user_id, action, details_json, created_at)
       VALUES (?, 'calendar.move', ?, ?)`
    ).run(req.user.id, JSON.stringify({ event: eventToken, starts_at: moved.due_at }), new Date().toISOString());

    return res.json({ ok: true, moved });
  });

  return router;
}
