import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import { getParamDefinition } from "../repos/params_repo.js";
import {
  createQualRuns,
  getQualStep,
  listQualFields,
  listQualRuns,
  upsertQualRunValue,
  type QualField
} from "../repos/qual_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import { renderExecutionProtocolPdf } from "../services/execution_protocol_pdf.js";
import { ExecutionProtocolError } from "../services/execution_protocol_types.js";
import {
  buildQualificationExecutionProtocol,
  type QualificationProtocolOptions
} from "../services/qualification_execution_protocol_service.js";
import { ensureQualificationDefaults } from "../services/qualification_service.js";
import { ensureSeedParams } from "../services/seed.js";

test("qualification protocol separates planned, recorded and calculated fields", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-qualification-protocol-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  const db = openDb();
  try {
    ensureSeedParams(db);
    const experimentId = createExperimentWithDefaults(db, { name: "Qualification protocol fixture" });
    ensureQualificationDefaults(db, experimentId);
    const step = getQualStep(db, experimentId, 1);
    assert.ok(step);
    if (!listQualRuns(db, step.id).length) createQualRuns(db, experimentId, step.id, 1);
    const run = listQualRuns(db, step.id)[0];
    assert.ok(run);
    const fields = listQualFields(db, step.id).filter((field) => field.is_enabled === 1);
    const planned = fields.find((field) => {
      const param = field.param_def_id ? getParamDefinition(db, field.param_def_id) : undefined;
      return field.field_type === "number" && field.is_derived !== 1 && param?.field_kind === "INPUT";
    });
    const recorded = fields.find((field) => {
      const param = field.param_def_id ? getParamDefinition(db, field.param_def_id) : undefined;
      return field.field_type === "number" && field.is_derived !== 1 && param?.field_kind !== "INPUT";
    });
    const calculated = fields.find((field) => field.field_type === "number" && field.is_derived === 1);
    assert.ok(planned, "fixture has a planned numeric field");
    assert.ok(recorded, "fixture has a recorded numeric field");
    assert.ok(calculated, "fixture has a calculated numeric field");
    setNumeric(db, run.id, planned, 80);
    setNumeric(db, run.id, recorded, 12.5);
    setNumeric(db, run.id, calculated, 4.25);

    const blankOptions: QualificationProtocolOptions = {
      layout: "matrix",
      values: "blank",
      includeInstructions: true
    };
    const blank = buildQualificationExecutionProtocol(
      db, experimentId, 1, blankOptions, "2026-11-10T12:00:00.000Z"
    );
    const current = buildQualificationExecutionProtocol(
      db, experimentId, 1, { ...blankOptions, values: "current" }, "2026-11-10T12:00:00.000Z"
    );
    const plannedKey = blank.plannedFields.find((field) => field.label === planned.label)?.key;
    const recordedKey = blank.recordedFields.find((field) => field.label === recorded.label)?.key;
    const calculatedKey = blank.calculatedFields.find((field) => field.label === calculated.label)?.key;
    assert.ok(plannedKey && recordedKey && calculatedKey);
    assert.equal(blank.runs[0].plannedValues[plannedKey], "80");
    assert.equal(blank.runs[0].recordedValues[recordedKey], "");
    assert.equal(blank.runs[0].calculatedValues[calculatedKey], "");
    assert.equal(current.runs[0].recordedValues[recordedKey], "12.5");
    assert.equal(current.runs[0].calculatedValues[calculatedKey], "4.25");
    assert.equal(blank.revisionFingerprint, current.revisionFingerprint);
    assert.ok(blank.referenceSections.some((section) => section.title === "Procedure"));
    assert.doesNotMatch(
      JSON.stringify(blank),
      /due_at|performed_at|responsible_user_id|exclude_from_analysis|\"done\"/
    );

    setNumeric(db, run.id, recorded, 99);
    const changedResult = buildQualificationExecutionProtocol(db, experimentId, 1, blankOptions);
    assert.equal(blank.revisionFingerprint, changedResult.revisionFingerprint);
    setNumeric(db, run.id, planned, 81);
    const changedPlan = buildQualificationExecutionProtocol(db, experimentId, 1, blankOptions);
    assert.notEqual(blank.revisionFingerprint, changedPlan.revisionFingerprint);

    const pdf = await renderExecutionProtocolPdf(blank, "run-sheets");
    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.length > 5_000);

    const extrusionProcess = db.prepare(
      `SELECT process.id FROM processes process
       JOIN process_types type ON type.id = process.process_type_id
       WHERE type.code = 'extrusion_v1' LIMIT 1`
    ).get() as { id: number } | undefined;
    assert.ok(extrusionProcess);
    const extrusionExperimentId = createExperimentWithDefaults(db, {
      name: "Multi-table qualification protocol",
      process_id: extrusionProcess.id
    });
    ensureQualificationDefaults(db, extrusionExperimentId);
    const extrusionProtocol = buildQualificationExecutionProtocol(
      db, extrusionExperimentId, 1, blankOptions, "2026-11-10T12:00:00.000Z"
    );
    assert.deepEqual(
      extrusionProtocol.sections.map((section) => section.title),
      ["Capillary rheometry", "Thermal-hold stability", "DSC heating / cooling", "TGA thermogram"]
    );
    assert.ok(extrusionProtocol.sections[0].plannedFields.some((field) => field.label === "Capillary diameter"));
    assert.ok(extrusionProtocol.sections[1].plannedFields.some((field) => field.label === "Hold time"));
    assert.equal(extrusionProtocol.sections[2].plannedFields.length, 0);
    assert.equal(extrusionProtocol.sections[2].recordedFields.length, 0);
    const matrixPdf = await renderExecutionProtocolPdf(extrusionProtocol, "matrix");
    assert.equal(matrixPdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(matrixPdf.length > 5_000);

    db.prepare("DELETE FROM qual_run_values WHERE run_id IN (SELECT id FROM qual_runs WHERE step_id = ?)").run(step.id);
    db.prepare("DELETE FROM qual_runs WHERE step_id = ?").run(step.id);
    assert.throws(
      () => buildQualificationExecutionProtocol(db, experimentId, 1, blankOptions),
      (error) => error instanceof ExecutionProtocolError && error.status === 409
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function setNumeric(db: ReturnType<typeof openDb>, runId: number, field: QualField, value: number) {
  upsertQualRunValue(db, {
    run_id: runId,
    field_id: field.id,
    value_real: value,
    value_text: null,
    value_tags_json: null
  });
}
