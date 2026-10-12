import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-process-route-migration-"));
  dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = "test";
});

after(() => {
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("startup assigns a distinct route to legacy processes with an empty route_code", () => {
  const initialDb = openDb();
  const injectionType = initialDb
    .prepare("SELECT id FROM process_types WHERE code = 'injection'")
    .get() as { id: number };

  const legacyProcessId = Number(
    initialDb.prepare(
      `INSERT INTO processes (process_type_id, name, route_code, owner_user_id, status, meta_json, created_at)
       VALUES (?, ?, NULL, NULL, 'active', NULL, ?)`
    ).run(injectionType.id, "Legacy injection process", new Date().toISOString()).lastInsertRowid
  );
  initialDb.close();

  const migratedDb = openDb();
  const routes = migratedDb
    .prepare("SELECT id, route_code FROM processes WHERE id = ? OR route_code = 'injection' ORDER BY id")
    .all(legacyProcessId) as Array<{ id: number; route_code: string }>;

  assert.equal(routes.length, 2);
  assert.equal(routes.find((route) => route.id === legacyProcessId)?.route_code, `injection-${legacyProcessId}`);
  assert.equal(new Set(routes.map((route) => route.route_code)).size, 2);
  assert.equal(
    migratedDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_processes_route_code_unique").count,
    1
  );
  migratedDb.close();
});
