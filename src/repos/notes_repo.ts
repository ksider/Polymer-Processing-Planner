import type { Db } from "../db.js";

export type NoteEntityType =
  | "experiment"
  | "qualification_step"
  | "doe"
  | "run"
  | "report"
  | "task";

export type NoteRow = {
  id: number;
  experiment_id: number;
  author_id: number | null;
  title: string;
  body_md: string;
  pinned: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  entity_type: NoteEntityType | null;
  entity_id: number | null;
  author_name: string | null;
  author_email: string | null;
};

function snapshotNoteVersion(
  db: Db,
  noteId: number,
  bodyMd: string,
  editedByUserId: number | null,
  editKind: "manual" | "append" | "checklist" | "system"
) {
  db.prepare(
    `
    INSERT INTO note_versions (note_id, body_md, edited_by_user_id, edit_kind, created_at)
    VALUES (?, ?, ?, ?, ?)
    `
  ).run(noteId, bodyMd, editedByUserId, editKind, new Date().toISOString());
}

export function listNotesByExperiment(
  db: Db,
  experimentId: number,
  options?: {
    entity_type?: NoteEntityType;
    entity_id?: number;
    limit?: number;
  }
): NoteRow[] {
  const where: string[] = ["n.experiment_id = ?", "n.archived_at IS NULL"];
  const args: Array<string | number> = [experimentId];

  if (options?.entity_type) {
    where.push("nl.entity_type = ?");
    args.push(options.entity_type);
  }
  if (options?.entity_id !== undefined && Number.isFinite(options.entity_id)) {
    where.push("nl.entity_id = ?");
    args.push(options.entity_id);
  }

  const limit = Number.isFinite(options?.limit) ? Math.max(1, Number(options?.limit)) : 200;
  args.push(limit);

  return db
    .prepare(
      `
      SELECT
        n.id,
        n.experiment_id,
        n.author_id,
        n.title,
        n.body_md,
        n.pinned,
        n.created_at,
        n.updated_at,
        n.archived_at,
        nl.entity_type,
        nl.entity_id,
        u.name AS author_name,
        u.email AS author_email
      FROM notes n
      LEFT JOIN note_links nl ON nl.note_id = n.id
      LEFT JOIN users u ON u.id = n.author_id
      WHERE ${where.join(" AND ")}
      ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC
      LIMIT ?
      `
    )
    .all(...args) as NoteRow[];
}

export function createNote(
  db: Db,
  data: {
    experiment_id: number;
    author_id: number | null;
    title: string;
    body_md: string;
    pinned?: number;
    entity_type: NoteEntityType;
    entity_id: number;
  }
): number {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `
        INSERT INTO notes (experiment_id, author_id, title, body_md, pinned, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        data.experiment_id,
        data.author_id,
        data.title,
        data.body_md,
        data.pinned ?? 0,
        now,
        now
      );

    const noteId = Number(result.lastInsertRowid);
    db.prepare(
      `
      INSERT INTO note_links (note_id, entity_type, entity_id, created_at)
      VALUES (?, ?, ?, ?)
      `
    ).run(noteId, data.entity_type, data.entity_id, now);

    return noteId;
  });

  return tx();
}

export function getNoteById(db: Db, noteId: number): NoteRow | null {
  const row = db
    .prepare(
      `
      SELECT
        n.id,
        n.experiment_id,
        n.author_id,
        n.title,
        n.body_md,
        n.pinned,
        n.created_at,
        n.updated_at,
        n.archived_at,
        nl.entity_type,
        nl.entity_id,
        u.name AS author_name,
        u.email AS author_email
      FROM notes n
      LEFT JOIN note_links nl ON nl.note_id = n.id
      LEFT JOIN users u ON u.id = n.author_id
      WHERE n.id = ?
      LIMIT 1
      `
    )
    .get(noteId) as NoteRow | undefined;
  return row ?? null;
}

export function softDeleteNote(db: Db, noteId: number): void {
  db.prepare("UPDATE notes SET archived_at = datetime('now') WHERE id = ?").run(noteId);
}

export function findLatestNoteForDay(
  db: Db,
  data: {
    experiment_id: number;
    author_id: number;
    entity_type: NoteEntityType;
    entity_id: number;
    day_iso: string;
  }
): NoteRow | null {
  const row = db
    .prepare(
      `
      SELECT
        n.id,
        n.experiment_id,
        n.author_id,
        n.title,
        n.body_md,
        n.pinned,
        n.created_at,
        n.updated_at,
        n.archived_at,
        nl.entity_type,
        nl.entity_id,
        u.name AS author_name,
        u.email AS author_email
      FROM notes n
      LEFT JOIN note_links nl ON nl.note_id = n.id
      LEFT JOIN users u ON u.id = n.author_id
      WHERE
        n.experiment_id = ?
        AND n.author_id = ?
        AND n.archived_at IS NULL
        AND nl.entity_type = ?
        AND nl.entity_id = ?
        AND substr(n.created_at, 1, 10) = ?
      ORDER BY n.updated_at DESC, n.id DESC
      LIMIT 1
      `
    )
    .get(
      data.experiment_id,
      data.author_id,
      data.entity_type,
      data.entity_id,
      data.day_iso
    ) as NoteRow | undefined;
  return row ?? null;
}

export function findRecentDuplicateNote(
  db: Db,
  data: {
    experiment_id: number;
    author_id: number | null;
    entity_type: NoteEntityType;
    entity_id: number;
    body_md: string;
    created_at_gte_iso: string;
  }
): NoteRow | null {
  const row = db
    .prepare(
      `
      SELECT
        n.id,
        n.experiment_id,
        n.author_id,
        n.title,
        n.body_md,
        n.pinned,
        n.created_at,
        n.updated_at,
        n.archived_at,
        nl.entity_type,
        nl.entity_id,
        u.name AS author_name,
        u.email AS author_email
      FROM notes n
      LEFT JOIN note_links nl ON nl.note_id = n.id
      LEFT JOIN users u ON u.id = n.author_id
      WHERE
        n.experiment_id = ?
        AND n.archived_at IS NULL
        AND nl.entity_type = ?
        AND nl.entity_id = ?
        AND n.body_md = ?
        AND n.created_at >= ?
        AND ((? IS NULL AND n.author_id IS NULL) OR n.author_id = ?)
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 1
      `
    )
    .get(
      data.experiment_id,
      data.entity_type,
      data.entity_id,
      data.body_md,
      data.created_at_gte_iso,
      data.author_id,
      data.author_id
    ) as NoteRow | undefined;
  return row ?? null;
}

export function appendToNote(db: Db, noteId: number, bodyMd: string, editedByUserId: number | null = null): void {
  const existing = db
    .prepare("SELECT body_md FROM notes WHERE id = ? LIMIT 1")
    .get(noteId) as { body_md: string } | undefined;
  if (!existing) return;
  const prev = String(existing.body_md || "");
  const nextChunk = String(bodyMd || "").trim();
  if (!nextChunk) return;
  // Idempotency guard: if the latest chunk is identical, skip duplicate append.
  if (prev.trimEnd().endsWith(nextChunk)) return;
  const now = new Date().toISOString();
  const prefix = prev.trim() ? "\n\n" : "";
  snapshotNoteVersion(db, noteId, prev, editedByUserId, "append");
  db.prepare(
    `
    UPDATE notes
    SET body_md = ?, updated_at = ?
    WHERE id = ?
    `
  ).run(`${prev}${prefix}${nextChunk}`, now, noteId);
}

export function updateNoteBody(
  db: Db,
  data: {
    note_id: number;
    body_md: string;
    edited_by_user_id: number | null;
    edit_kind?: "manual" | "append" | "checklist" | "system";
  }
): void {
  const existing = db
    .prepare("SELECT body_md FROM notes WHERE id = ? LIMIT 1")
    .get(data.note_id) as { body_md: string } | undefined;
  if (!existing) return;
  const nextBody = String(data.body_md || "");
  if (nextBody === String(existing.body_md || "")) return;
  snapshotNoteVersion(
    db,
    data.note_id,
    String(existing.body_md || ""),
    data.edited_by_user_id ?? null,
    data.edit_kind ?? "manual"
  );
  db.prepare(
    `
    UPDATE notes
    SET body_md = ?, updated_at = ?
    WHERE id = ?
    `
  ).run(nextBody, new Date().toISOString(), data.note_id);
}

export function toggleChecklistItem(
  db: Db,
  data: {
    note_id: number;
    item_index: number;
    checked: boolean;
    edited_by_user_id: number | null;
  }
): boolean {
  const existing = db
    .prepare("SELECT body_md FROM notes WHERE id = ? LIMIT 1")
    .get(data.note_id) as { body_md: string } | undefined;
  if (!existing) return false;
  const lines = String(existing.body_md || "").replace(/\r\n/g, "\n").split("\n");
  let currentIndex = -1;
  let updated = false;
  const nextLines = lines.map((line) => {
    const match = line.match(/^(\s*-\s)\[( |x|X)\](\s+.*)$/);
    if (!match) return line;
    currentIndex += 1;
    if (currentIndex !== data.item_index) return line;
    updated = true;
    const marker = data.checked ? "x" : " ";
    return `${match[1]}[${marker}]${match[3]}`;
  });
  if (!updated) return false;
  updateNoteBody(db, {
    note_id: data.note_id,
    body_md: nextLines.join("\n"),
    edited_by_user_id: data.edited_by_user_id,
    edit_kind: "checklist"
  });
  return true;
}
