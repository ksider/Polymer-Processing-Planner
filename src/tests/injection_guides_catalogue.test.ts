import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { openDb } from "../db.js";
import { listQualFields, listQualSteps } from "../repos/qual_repo.js";
import { listParamDefinitionsForProcess } from "../repos/params_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import { getQualificationStudyGuide } from "../services/qualification_guides.js";
import { ensureQualificationDefaults } from "../services/qualification_service.js";
import { ensureSeedParams } from "../services/seed.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-injection-guides-"));
  dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
});

after(() => {
  if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

test("injection qualification studies have guides and canonical parameter links", () => {
  const db = openDb();
  try {
    ensureSeedParams(db);
    const injectionProcess = db.prepare(
      `SELECT process.id
       FROM processes process
       JOIN process_types type ON type.id = process.process_type_id
       WHERE type.code = 'injection'
       LIMIT 1`
    ).get() as { id: number } | undefined;
    assert.ok(injectionProcess?.id, "injection process is seeded");

    const experimentId = createExperimentWithDefaults(db, {
      name: "Injection guide and catalogue smoke",
      process_id: injectionProcess?.id
    });
    ensureQualificationDefaults(db, experimentId);

    const fields = listQualSteps(db, experimentId).flatMap((step) => listQualFields(db, step.id));
    assert.ok(fields.length > 0, "injection qualification fields are present");
    assert.ok(fields.every((field) => field.param_def_id != null), "every injection field links to the shared catalogue");

    const injectionCodes = new Set(listParamDefinitionsForProcess(db, experimentId, "injection").map((field) => field.code));
    ["fill_time_s", "cavity_weight_variation_pct", "pressure_part_95_bar", "hold_pressure_bar", "part_weight_g", "cooling_time_s"].forEach((code) => {
      assert.ok(injectionCodes.has(code), `${code} is available in the injection parameter repository`);
    });

    for (let stepNumber = 1; stepNumber <= 6; stepNumber += 1) {
      const guide = getQualificationStudyGuide("injection", stepNumber);
      assert.ok(guide, `Step ${stepNumber} has a study guide`);
      assert.equal(guide?.procedure.length, 3, `Step ${stepNumber} guide has an operational procedure`);
      assert.ok(guide?.handoff, `Step ${stepNumber} guide explains the handoff`);
    }
    for (let stepNumber = 1; stepNumber <= 10; stepNumber += 1) {
      const guide = getQualificationStudyGuide("extrusion_v1", stepNumber);
      assert.ok(guide, `Extrusion Step ${stepNumber} retains a study guide`);
      assert.ok(guide?.theory && guide.interpretation.length > 0, `Extrusion Step ${stepNumber} guide remains actionable`);
    }
  } finally {
    db.close();
  }
});
