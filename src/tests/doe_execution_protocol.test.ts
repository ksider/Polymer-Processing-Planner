import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import { insertAnalysisField, upsertAnalysisRunValue } from "../repos/analysis_repo.js";
import { listRuns } from "../repos/runs_repo.js";
import {
  createDoeWithDefaults,
  createExperimentWithDefaults,
  generateRuns
} from "../services/experiments_service.js";
import { ensureSeedParams } from "../services/seed.js";
import {
  buildDoeExecutionProtocol,
  DoeProtocolError,
  type DoeProtocolOptions
} from "../services/doe_execution_protocol_service.js";
import { renderDoeExecutionProtocolPdf } from "../services/execution_protocol_pdf.js";

test("DOE execution protocol keeps measurements blank by default and renders a PDF", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-doe-protocol-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  const db = openDb();
  try {
    ensureSeedParams(db);
    const experimentId = createExperimentWithDefaults(db, { name: "Protocol fixture" });
    const doeId = createDoeWithDefaults(db, {
      experimentId,
      name: "Screening plan",
      design_type: "FFA",
      seed: 42,
      center_points: 3,
      max_runs: 40,
      replicate_count: 1,
      recipe_as_block: 0
    });
    generateRuns(db, experimentId, doeId);
    const responseInsert = insertAnalysisField(db, {
      scope_type: "DOE",
      scope_id: doeId,
      code: "protocol_response_fixture",
      label: "Measured strength",
      field_type: "number",
      unit: "MPa",
      group_label: "Results",
      allowed_values_json: null,
      param_def_id: null,
      is_standard: 0,
      is_active: 1
    });
    const responseId = Number(responseInsert.lastInsertRowid);
    const firstRun = listRuns(db, doeId)[0];
    assert.ok(firstRun);
    upsertAnalysisRunValue(db, firstRun.id, responseId, 12.5, null, null);

    const blankOptions: DoeProtocolOptions = { layout: "matrix", values: "blank", includeRecipes: false };
    const currentOptions: DoeProtocolOptions = { ...blankOptions, values: "current" };
    const blank = buildDoeExecutionProtocol(db, experimentId, doeId, blankOptions, "2026-11-10T12:00:00.000Z");
    const current = buildDoeExecutionProtocol(db, experimentId, doeId, currentOptions, "2026-11-10T12:00:00.000Z");
    const responseKey = blank.recordedFields.find((field) => field.label === "Measured strength")?.key;
    assert.ok(responseKey);
    assert.equal(blank.runs[0].recordedValues[responseKey], "");
    assert.equal(current.runs[0].recordedValues[responseKey], "12.5");
    assert.equal(blank.revisionFingerprint, current.revisionFingerprint, "recorded results do not change the plan revision");
    assert.ok(blank.plannedFields.length > 0);
    assert.doesNotMatch(JSON.stringify(blank), /due_at|owner_user_id|exclude_from_analysis|\"done\"/);

    db.prepare(
      `UPDATE run_values
       SET value_real = value_real + 0.5
       WHERE run_id = ? AND param_def_id = (
         SELECT param_def_id FROM run_values WHERE run_id = ? AND value_real IS NOT NULL LIMIT 1
       )`
    ).run(firstRun.id, firstRun.id);
    const changedPlan = buildDoeExecutionProtocol(db, experimentId, doeId, blankOptions, "2026-11-10T12:00:00.000Z");
    assert.notEqual(blank.revisionFingerprint, changedPlan.revisionFingerprint);

    const pdf = await renderDoeExecutionProtocolPdf(blank, "matrix");
    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.length > 5_000);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DOE execution protocol requires generated runs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-empty-doe-protocol-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  const db = openDb();
  try {
    ensureSeedParams(db);
    const experimentId = createExperimentWithDefaults(db, { name: "Empty protocol fixture" });
    const doeId = createDoeWithDefaults(db, {
      experimentId,
      name: "Empty plan",
      design_type: "FFA",
      seed: 42,
      center_points: 3,
      max_runs: 40,
      replicate_count: 1,
      recipe_as_block: 0
    });
    assert.throws(
      () => buildDoeExecutionProtocol(db, experimentId, doeId, {
        layout: "matrix",
        values: "blank",
        includeRecipes: false
      }),
      (error) => error instanceof DoeProtocolError && error.status === 409
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
