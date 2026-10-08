import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../db.js";
import { createQualRuns, ensureQualSteps, listQualRuns, listQualSteps } from "../repos/qual_repo.js";

test("qualification run codes include the experiment and migrate legacy labels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-qual-run-codes-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  let db = openDb();
  try {
    const createBareExperiment = (name: string) => Number(
      db
        .prepare(
          "INSERT INTO experiments (name, design_type, seed, created_at) VALUES (?, 'SIM', 42, datetime('now'))"
        )
        .run(name).lastInsertRowid
    );
    const firstExperimentId = createBareExperiment("First qualification code");
    const secondExperimentId = createBareExperiment("Second qualification code");
    const stepSeed = [{ step_number: 1, stage_code: "test.rheology", display_order: 1, title: "Rheology" }];

    ensureQualSteps(db, firstExperimentId, stepSeed);
    ensureQualSteps(db, secondExperimentId, stepSeed);
    const firstStep = listQualSteps(db, firstExperimentId)[0];
    const secondStep = listQualSteps(db, secondExperimentId)[0];
    assert.ok(firstStep);
    assert.ok(secondStep);

    createQualRuns(db, firstExperimentId, firstStep.id, 1);
    createQualRuns(db, secondExperimentId, secondStep.id, 1);
    assert.equal(listQualRuns(db, firstStep.id)[0]?.run_code, `E${firstExperimentId}-Q1-R001`);
    assert.equal(listQualRuns(db, secondStep.id)[0]?.run_code, `E${secondExperimentId}-Q1-R001`);

    // Simulate an existing database before the globally unambiguous format.
    db.prepare("UPDATE qual_runs SET run_code = 'Q1-R001' WHERE step_id = ?").run(firstStep.id);
    db.close();
    db = openDb();
    const migratedStep = listQualSteps(db, firstExperimentId)[0];
    assert.equal(listQualRuns(db, migratedStep.id)[0]?.run_code, `E${firstExperimentId}-Q1-R001`);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
