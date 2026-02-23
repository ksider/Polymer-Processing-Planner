import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db.js";
import { openDb } from "../db.js";
import { appendToNote, createNote, findRecentDuplicateNote, getNoteById, toggleChecklistItem } from "../repos/notes_repo.js";

let db: Db;
let dbPath = "";

function insertExperiment(name: string): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `
      INSERT INTO experiments (name, design_type, seed, created_at)
      VALUES (?, 'D_OPTIMAL', 42, ?)
      `
    )
    .run(name, now);
  return Number(result.lastInsertRowid);
}

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-notes-"));
  dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  db = openDb();
});

after(() => {
  db?.close();
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // ignore locked db on Windows
    }
  }
});

test("toggleChecklistItem updates only target item and stores previous version", () => {
  const experimentId = insertExperiment("Checklist experiment");
  const noteId = createNote(db, {
    experiment_id: experimentId,
    author_id: null,
    title: "Checklist",
    body_md: "- [ ] first\n- [ ] second\n- [x] third",
    entity_type: "experiment",
    entity_id: experimentId
  });

  const ok = toggleChecklistItem(db, {
    note_id: noteId,
    item_index: 1,
    checked: true,
    edited_by_user_id: null
  });

  assert.equal(ok, true);
  const updated = getNoteById(db, noteId);
  assert.ok(updated);
  assert.equal(updated.body_md, "- [ ] first\n- [x] second\n- [x] third");

  const versions = db
    .prepare("SELECT body_md, edit_kind FROM note_versions WHERE note_id = ? ORDER BY id ASC")
    .all(noteId) as Array<{ body_md: string; edit_kind: string }>;
  assert.equal(versions.length, 1);
  assert.equal(versions[0].edit_kind, "checklist");
  assert.equal(versions[0].body_md, "- [ ] first\n- [ ] second\n- [x] third");
});

test("toggleChecklistItem returns false when checklist index is out of range", () => {
  const experimentId = insertExperiment("Checklist bounds");
  const noteId = createNote(db, {
    experiment_id: experimentId,
    author_id: null,
    title: "Checklist",
    body_md: "- [ ] first",
    entity_type: "experiment",
    entity_id: experimentId
  });

  const ok = toggleChecklistItem(db, {
    note_id: noteId,
    item_index: 5,
    checked: true,
    edited_by_user_id: null
  });

  assert.equal(ok, false);
  const unchanged = getNoteById(db, noteId);
  assert.ok(unchanged);
  assert.equal(unchanged.body_md, "- [ ] first");

  const versionCount = db
    .prepare("SELECT COUNT(1) as cnt FROM note_versions WHERE note_id = ?")
    .get(noteId) as { cnt: number };
  assert.equal(versionCount.cnt, 0);
});

test("appendToNote ignores duplicate trailing chunk", () => {
  const experimentId = insertExperiment("Append dedupe");
  const noteId = createNote(db, {
    experiment_id: experimentId,
    author_id: null,
    title: "Daily note",
    body_md: "Initial",
    entity_type: "experiment",
    entity_id: experimentId
  });

  appendToNote(db, noteId, "Repeated block", null);
  appendToNote(db, noteId, "Repeated block", null);

  const updated = getNoteById(db, noteId);
  assert.ok(updated);
  assert.equal(updated.body_md, "Initial\n\nRepeated block");
});

test("findRecentDuplicateNote finds identical recent note", () => {
  const experimentId = insertExperiment("Recent duplicate");
  const noteId = createNote(db, {
    experiment_id: experimentId,
    author_id: null,
    title: "New note",
    body_md: "Same payload",
    entity_type: "experiment",
    entity_id: experimentId
  });
  assert.ok(noteId > 0);

  const duplicate = findRecentDuplicateNote(db, {
    experiment_id: experimentId,
    author_id: null,
    entity_type: "experiment",
    entity_id: experimentId,
    body_md: "Same payload",
    created_at_gte_iso: new Date(Date.now() - 60_000).toISOString()
  });
  assert.ok(duplicate);
  assert.equal(duplicate.id, noteId);
});
