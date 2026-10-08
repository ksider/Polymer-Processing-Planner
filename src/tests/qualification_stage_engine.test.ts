import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../db.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import {
  ensureQualSteps,
  getQualStep,
  listQualSteps,
  setQualStepBlocked,
  updateQualStepStatus
} from "../repos/qual_repo.js";
import { ensureSeedParams } from "../services/seed.js";

test("qualification catalogue supports more than six stages and preserves a blocked stage status", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-stage-engine-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  const db = openDb();
  try {
    ensureSeedParams(db);
    const experimentId = createExperimentWithDefaults(db, { name: "Unlimited stages" });
    const seeds = Array.from({ length: 8 }, (_, index) => {
      const number = index + 1;
      return {
        step_number: number,
        stage_code: `test.qualification.${String(number).padStart(3, "0")}`,
        display_order: number * 10,
        title: `Test stage ${number}`
      };
    });

    ensureQualSteps(db, experimentId, seeds);
    const stages = listQualSteps(db, experimentId);
    assert.equal(stages.length, 8);
    assert.deepEqual(stages.map((stage) => stage.stage_code), seeds.map((seed) => seed.stage_code));
    assert.deepEqual(stages.map((stage) => stage.display_order), seeds.map((seed) => seed.display_order));

    const stageSeven = stages.find((stage) => stage.step_number === 7);
    assert.ok(stageSeven, "seventh catalogue stage should be instantiated");
    updateQualStepStatus(db, stageSeven.id, "RUNNING");
    setQualStepBlocked(db, stageSeven.id, {
      blocked: true,
      reason: "Awaiting calibration certificate",
      actorUserId: null
    });
    let blocked = getQualStep(db, experimentId, 7);
    assert.equal(blocked?.status, "BLOCKED");
    assert.equal(blocked?.is_blocked, 1);
    assert.equal(blocked?.blocked_reason, "Awaiting calibration certificate");

    setQualStepBlocked(db, stageSeven.id, { blocked: false, actorUserId: null });
    blocked = getQualStep(db, experimentId, 7);
    assert.equal(blocked?.status, "RUNNING");
    assert.equal(blocked?.is_blocked, 0);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
