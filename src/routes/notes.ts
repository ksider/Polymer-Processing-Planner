import express from "express";
import type { Db } from "../db.js";
import { ensureExperimentAccess } from "../middleware/experiment_access.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { getDoeStudy } from "../repos/doe_repo.js";
import { getReportConfig } from "../repos/reports_repo.js";
import { getRun } from "../repos/runs_repo.js";
import { getTask } from "../repos/tasks_repo.js";
import {
  appendToNote,
  createNote,
  findLatestNoteForDay,
  findRecentDuplicateNote,
  getNoteById,
  listNotesByExperiment,
  softDeleteNote,
  toggleChecklistItem,
  updateNoteBody,
  type NoteEntityType,
  type NoteRow
} from "../repos/notes_repo.js";
import { htmlToMarkdown, markdownToSafeHtml } from "../services/markdown_service.js";

const NOTE_WRITER_ROLES = ["admin", "manager", "engineer"];
const VALID_ENTITY_TYPES: NoteEntityType[] = [
  "experiment",
  "qualification_step",
  "doe",
  "run",
  "report",
  "task"
];

function hasRole(req: express.Request, roles: string[]) {
  return roles.includes(req.user?.role ?? "");
}

function canEditNote(req: express.Request, note: NoteRow): boolean {
  const role = req.user?.role ?? "";
  if (role === "admin" || role === "manager") return true;
  if (!NOTE_WRITER_ROLES.includes(role)) return false;
  return Boolean(req.user?.id) && note.author_id === req.user?.id;
}

function cleanBody(raw: unknown): string {
  return String(raw ?? "").replace(/\r\n/g, "\n").trim();
}

function toEntityType(raw: unknown): NoteEntityType {
  const value = String(raw ?? "experiment").trim() as NoteEntityType;
  return VALID_ENTITY_TYPES.includes(value) ? value : "experiment";
}

function toEntityId(raw: unknown, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function entityHref(
  note: { entity_type: NoteEntityType | null; entity_id: number | null },
  experimentId: number
): string {
  const entityType = note.entity_type || "experiment";
  const entityId = Number(note.entity_id || experimentId);
  if (entityType === "experiment") return `/experiments/${experimentId}`;
  if (entityType === "qualification_step") return `/experiments/${experimentId}/qualification/${entityId}`;
  if (entityType === "doe") return `/experiments/${experimentId}/doe/${entityId}`;
  if (entityType === "run") return `/experiments/${experimentId}/runs/${entityId}`;
  if (entityType === "report") return `/reports/${entityId}`;
  if (entityType === "task") return `/experiments/${experimentId}#tasks`;
  return `/experiments/${experimentId}`;
}

function toResponseNote(
  note: NoteRow,
  user: { id?: number | null; role?: string | null } | null,
  db: Db,
  experimentId: number
) {
  const role = user?.role ?? "";
  const parts = String(note.title || "").split(" · ").map((part) => part.trim()).filter(Boolean);
  const displayTitle = parts.length >= 2 ? `${parts[0]} · ${parts[1]}` : String(note.title || "");
  const activityAt = note.updated_at || note.created_at;
  const canEdit =
    role === "admin" ||
    role === "manager" ||
    (role === "engineer" && Boolean(user?.id) && note.author_id === user?.id);
  return {
    ...note,
    display_title: displayTitle,
    body_html: markdownToSafeHtml(note.body_md),
    author_label: note.author_name?.trim() || note.author_email?.trim() || "Unknown",
    timestamp: new Date(activityAt).toLocaleString(),
    activity_at: activityAt,
    entity_label: entityLabel(
      db,
      {
        entity_type: (note.entity_type || "experiment") as NoteEntityType,
        entity_id: Number(note.entity_id || experimentId)
      },
      experimentId
    ),
    entity_href: entityHref(note, experimentId),
    can_edit: canEdit,
    can_delete: role === "admin" || role === "manager"
  };
}

function entityLabel(db: Db, note: { entity_type: NoteEntityType; entity_id: number }, experimentId: number): string {
  if (note.entity_type === "experiment") return `Experiment #${experimentId}`;
  if (note.entity_type === "qualification_step") return `Qualification Step ${note.entity_id}`;
  if (note.entity_type === "doe") {
    const doe = getDoeStudy(db, note.entity_id);
    return doe?.name?.trim() || `DOE #${note.entity_id}`;
  }
  if (note.entity_type === "run") {
    const run = getRun(db, note.entity_id);
    return run?.run_code?.trim() || `Run #${note.entity_id}`;
  }
  if (note.entity_type === "report") {
    const report = getReportConfig(db, note.entity_id);
    return report?.name?.trim() || `Report #${note.entity_id}`;
  }
  if (note.entity_type === "task") {
    const task = getTask(db, note.entity_id);
    return task?.title?.trim() || `Task #${note.entity_id}`;
  }
  return `Entity #${note.entity_id}`;
}

export function createNotesRouter(db: Db) {
  const router = express.Router();

  router.use("/experiments/:id", ensureExperimentAccess(db));

  router.get("/experiments/:id/journal", (req, res) => {
    const experimentId = Number(req.params.id);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");

    const notes = listNotesByExperiment(db, experimentId, { limit: 200 })
      .map((note) => toResponseNote(note, req.user ?? null, db, experimentId))
      .sort((a, b) => new Date(a.activity_at).getTime() - new Date(b.activity_at).getTime());
    const canWrite = hasRole(req, NOTE_WRITER_ROLES);

    res.render("journal", {
      experiment,
      notes,
      canWrite
    });
  });

  router.get("/experiments/:id/notes.json", (req, res) => {
    const experimentId = Number(req.params.id);
    const entityTypeRaw = req.query.entity_type;
    const entityType = entityTypeRaw ? toEntityType(entityTypeRaw) : undefined;
    const entityId = req.query.entity_id !== undefined
      ? toEntityId(req.query.entity_id, experimentId)
      : undefined;
    const onlyCurrent = String(req.query.only_current || "0") === "1";

    const notes = listNotesByExperiment(db, experimentId, {
      entity_type: onlyCurrent ? entityType : undefined,
      entity_id: onlyCurrent ? entityId : undefined,
      limit: 200
    }).map((note) => toResponseNote(note, req.user ?? null, db, experimentId));

    res.json({ notes });
  });

  router.post("/experiments/:id/notes", (req, res) => {
    if (!hasRole(req, NOTE_WRITER_ROLES)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    const experimentId = Number(req.params.id);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).json({ ok: false, message: "Experiment not found" });

    const bodyHtml = String(req.body?.body_html ?? "").trim();
    const bodyMdRaw = cleanBody(req.body?.body_md);
    const bodyMd = bodyMdRaw || (bodyHtml ? htmlToMarkdown(bodyHtml) : "");
    if (!bodyMd) {
      return res.status(400).json({ ok: false, message: "Note text is required" });
    }

    const entity_type = toEntityType(req.body?.entity_type);
    const entity_id = toEntityId(req.body?.entity_id, experimentId);
    const title = `${experiment.name} · ${entityLabel(db, { entity_type, entity_id }, experimentId)}`;
    const forceNew = String(req.body?.force_new || "0") === "1";
    const authorId = req.user?.id ?? null;
    const today = new Date().toISOString().slice(0, 10);
    const dedupeSince = new Date(Date.now() - 5000).toISOString();
    let noteId: number | null = null;

    const duplicate = findRecentDuplicateNote(db, {
      experiment_id: experimentId,
      author_id: authorId,
      entity_type,
      entity_id,
      body_md: bodyMd,
      created_at_gte_iso: dedupeSince
    });
    if (duplicate) {
      noteId = duplicate.id;
    }

    if (!noteId && !forceNew && authorId) {
      const existing = findLatestNoteForDay(db, {
        experiment_id: experimentId,
        author_id: authorId,
        entity_type,
        entity_id,
        day_iso: today
      });
      if (existing) {
        appendToNote(db, existing.id, bodyMd, req.user?.id ?? null);
        noteId = existing.id;
      }
    }

    if (!noteId) {
      noteId = createNote(db, {
        experiment_id: experimentId,
        author_id: authorId,
        title,
        body_md: bodyMd,
        entity_type,
        entity_id,
        pinned: req.body?.pinned ? 1 : 0
      });
    }

    const created = getNoteById(db, noteId);
    return res.json({
      ok: true,
      note: created ? toResponseNote(created, req.user ?? null, db, experimentId) : null
    });
  });

  router.post("/experiments/:id/notes/:noteId/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager"])) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const noteId = Number(req.params.noteId);
    if (!Number.isFinite(noteId)) {
      return res.status(400).json({ ok: false, message: "Invalid note" });
    }
    const note = getNoteById(db, noteId);
    if (!note || note.experiment_id !== experimentId) {
      return res.status(404).json({ ok: false, message: "Note not found" });
    }
    softDeleteNote(db, noteId);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/notes/:noteId/update", (req, res) => {
    const experimentId = Number(req.params.id);
    const noteId = Number(req.params.noteId);
    if (!Number.isFinite(noteId)) {
      return res.status(400).json({ ok: false, message: "Invalid note" });
    }
    const note = getNoteById(db, noteId);
    if (!note || note.experiment_id !== experimentId) {
      return res.status(404).json({ ok: false, message: "Note not found" });
    }
    if (!canEditNote(req, note)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }
    const bodyHtml = String(req.body?.body_html ?? "").trim();
    const bodyMdRaw = cleanBody(req.body?.body_md);
    const bodyMd = bodyMdRaw || (bodyHtml ? htmlToMarkdown(bodyHtml) : "");
    if (!bodyMd) {
      return res.status(400).json({ ok: false, message: "Note text is required" });
    }
    updateNoteBody(db, {
      note_id: noteId,
      body_md: bodyMd,
      edited_by_user_id: req.user?.id ?? null,
      edit_kind: "manual"
    });
    const updated = getNoteById(db, noteId);
    return res.json({
      ok: true,
      note: updated ? toResponseNote(updated, req.user ?? null, db, experimentId) : null
    });
  });

  router.post("/experiments/:id/notes/:noteId/checklist", (req, res) => {
    const experimentId = Number(req.params.id);
    const noteId = Number(req.params.noteId);
    if (!Number.isFinite(noteId)) {
      return res.status(400).json({ ok: false, message: "Invalid note" });
    }
    const note = getNoteById(db, noteId);
    if (!note || note.experiment_id !== experimentId) {
      return res.status(404).json({ ok: false, message: "Note not found" });
    }
    if (!canEditNote(req, note)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }
    const itemIndex = Number(req.body?.item_index);
    if (!Number.isInteger(itemIndex) || itemIndex < 0) {
      return res.status(400).json({ ok: false, message: "Invalid checklist item" });
    }
    const checked = String(req.body?.checked || "0") === "1";
    const ok = toggleChecklistItem(db, {
      note_id: noteId,
      item_index: itemIndex,
      checked,
      edited_by_user_id: req.user?.id ?? null
    });
    if (!ok) {
      return res.status(400).json({ ok: false, message: "Checklist item not found" });
    }
    const updated = getNoteById(db, noteId);
    return res.json({
      ok: true,
      note: updated ? toResponseNote(updated, req.user ?? null, db, experimentId) : null
    });
  });

  return router;
}
