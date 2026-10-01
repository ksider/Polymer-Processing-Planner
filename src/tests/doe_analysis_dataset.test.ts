import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import {
  createDoeWithDefaults,
  createExperimentWithDefaults,
  generateRuns
} from "../services/experiments_service.js";
import { ensureSeedParams } from "../services/seed.js";
import { createParamDefinition } from "../repos/params_repo.js";
import { upsertAnalysisRunValue } from "../repos/analysis_repo.js";
import {
  auditLegacyDoeResponses,
  buildDoeAnalysisDataset,
  DoeAnalysisDatasetNotFoundError
} from "../modules/doe_analysis/index.js";

type RunRow = { id: number; run_code: string; run_order: number };
type FieldRow = { id: number; code: string; label: string };

test("canonical DOE dataset resolves response provenance, coding and revision deterministically", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-analysis-v2-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  const db = openDb();
  try {
    ensureSeedParams(db);
    const experimentId = createExperimentWithDefaults(db, { name: "Analysis V2 dataset" });
    const doeId = createDoeWithDefaults(db, {
      experimentId,
      name: "FFA dataset fixture",
      design_type: "FFA",
      seed: 42,
      center_points: 3,
      max_runs: 200,
      replicate_count: 1,
      recipe_as_block: 0
    });
    generateRuns(db, experimentId, doeId);

    const runs = db
      .prepare("SELECT id, run_code, run_order FROM runs WHERE doe_id = ? ORDER BY run_order")
      .all(doeId) as RunRow[];
    assert.equal(runs.length, 27);

    const fields = db
      .prepare(
        "SELECT id, code, label FROM analysis_fields WHERE scope_type = 'DOE' AND scope_id = ? ORDER BY id"
      )
      .all(doeId) as FieldRow[];
    const partWeight = requiredField(fields, "part_weight");
    const defects = requiredField(fields, "defects");
    const cycleTime = requiredField(fields, "cycle_time");

    setLegacyNumber(db, runs[0].id, "part_weight", 10);

    upsertAnalysisRunValue(db, runs[1].id, partWeight.id, 11, null, null);

    setLegacyNumber(db, runs[2].id, "part_weight", 12);
    upsertAnalysisRunValue(db, runs[2].id, partWeight.id, 12, null, null);

    setLegacyNumber(db, runs[3].id, "part_weight", 14);
    upsertAnalysisRunValue(db, runs[3].id, partWeight.id, 13, null, null);

    setLegacyNumber(db, runs[4].id, "part_weight", 20);
    const duplicatePartWeightParamId = createParamDefinition(db, {
      scope: "EXPERIMENT",
      experiment_id: experimentId,
      code: "part_weight",
      label: "Duplicate legacy part weight",
      unit: "g",
      field_kind: "OUTPUT",
      field_type: "number",
      group_label: "Legacy fixture",
      allowed_values_json: null
    });
    db.prepare(
      `INSERT INTO run_values
       (run_id, param_def_id, value_real, value_text, value_tags_json)
       VALUES (?, ?, ?, NULL, NULL)`
    ).run(runs[4].id, duplicatePartWeightParamId, 21);

    setLegacyTags(db, runs[5].id, "defects", []);
    setLegacyTags(db, runs[6].id, "defects", ["short shot", "flash"]);
    upsertAnalysisRunValue(
      db,
      runs[6].id,
      defects.id,
      null,
      null,
      JSON.stringify(["flash", "short shot"])
    );

    db.prepare("UPDATE analysis_fields SET is_active = 0 WHERE id = ?").run(cycleTime.id);
    setLegacyNumber(db, runs[7].id, "cycle_time", 55);

    const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
    const secondBuild = buildDoeAnalysisDataset(db, experimentId, doeId);
    assert.equal(dataset.contractVersion, "1.0");
    assert.match(dataset.datasetRevision, /^[a-f0-9]{64}$/);
    assert.equal(dataset.datasetRevision, secondBuild.datasetRevision);
    assert.equal(dataset.rows.length, 27);

    const factorColumns = dataset.columns.filter((column) => column.role === "factor");
    assert.deepEqual(
      factorColumns.map((column) => column.code).sort(),
      ["hold_time", "inj_speed", "moisture_pct"]
    );
    for (const row of dataset.rows) {
      for (const column of factorColumns) {
        assert.ok([-1, 0, 1].includes(row.codedValues[column.key] ?? Number.NaN));
      }
    }

    const partWeightColumn = dataset.columns.find(
      (column) => column.role === "response" && column.code === "part_weight"
    );
    const defectsColumn = dataset.columns.find(
      (column) => column.role === "response" && column.code === "defects"
    );
    assert.ok(partWeightColumn);
    assert.ok(defectsColumn);
    assert.equal(
      dataset.columns.some((column) => column.role === "response" && column.code === "cycle_time"),
      false
    );

    assert.equal(dataset.rows[0].values[partWeightColumn.key], 10);
    assert.equal(dataset.rows[0].responseSources[partWeightColumn.key], "legacy_run_value");
    assert.equal(dataset.rows[1].values[partWeightColumn.key], 11);
    assert.equal(dataset.rows[1].responseSources[partWeightColumn.key], "measurement");
    assert.equal(dataset.rows[2].values[partWeightColumn.key], 12);
    assert.equal(dataset.rows[2].responseSources[partWeightColumn.key], "measurement");
    assert.equal(dataset.rows[3].values[partWeightColumn.key], 13);
    assert.equal(dataset.rows[3].responseSources[partWeightColumn.key], "measurement_conflict");
    assert.equal(dataset.rows[4].values[partWeightColumn.key], null);
    assert.equal(dataset.rows[4].responseSources[partWeightColumn.key], "ambiguous_legacy");
    assert.deepEqual(dataset.rows[5].values[defectsColumn.key], []);
    assert.equal(dataset.rows[5].responseSources[defectsColumn.key], "legacy_run_value");
    assert.deepEqual(dataset.rows[6].values[defectsColumn.key], ["flash", "short shot"]);

    assert.equal(dataset.responseAudit.counts.legacy_only >= 2, true);
    assert.equal(dataset.responseAudit.counts.measurement_only >= 1, true);
    assert.equal(dataset.responseAudit.counts.equal >= 2, true);
    assert.equal(dataset.responseAudit.counts.conflict, 1);
    assert.equal(dataset.responseAudit.counts.ambiguous_legacy, 1);
    assert.equal(dataset.responseAudit.hasConflicts, true);
    assert.equal(dataset.responseAudit.hasLegacyOnlyValues, true);

    const revisionBeforeScheduleChange = dataset.datasetRevision;
    db.prepare("UPDATE runs SET due_at = ? WHERE id = ?").run("2030-01-02", runs[0].id);
    assert.equal(
      buildDoeAnalysisDataset(db, experimentId, doeId).datasetRevision,
      revisionBeforeScheduleChange,
      "run scheduling must not make a statistical result stale"
    );

    upsertAnalysisRunValue(db, runs[1].id, partWeight.id, 11.5, null, null);
    assert.notEqual(
      buildDoeAnalysisDataset(db, experimentId, doeId).datasetRevision,
      revisionBeforeScheduleChange,
      "response changes must make a statistical result stale"
    );

    const fullAudit = auditLegacyDoeResponses(db, experimentId, doeId);
    assert.ok(
      fullAudit.entries.some((entry) =>
        entry.runId === runs[7].id &&
        entry.responseFieldId === cycleTime.id &&
        entry.status === "legacy_only"
      ),
      "migration audit must include inactive response fields"
    );

    assert.throws(
      () => buildDoeAnalysisDataset(db, experimentId + 999, doeId),
      DoeAnalysisDatasetNotFoundError
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function requiredField(fields: FieldRow[], code: string): FieldRow {
  const field = fields.find((row) => row.code === code);
  assert.ok(field, `analysis field ${code} is missing`);
  return field;
}

function setLegacyNumber(db: ReturnType<typeof openDb>, runId: number, code: string, value: number) {
  const param = db
    .prepare(
      `SELECT p.id
       FROM run_values rv
       JOIN param_definitions p ON p.id = rv.param_def_id
       WHERE rv.run_id = ? AND p.field_kind = 'OUTPUT' AND p.code = ?
       ORDER BY p.id
       LIMIT 1`
    )
    .get(runId, code) as { id: number } | undefined;
  assert.ok(param, `legacy output ${code} is missing for run ${runId}`);
  db.prepare(
    `UPDATE run_values
     SET value_real = ?, value_text = NULL, value_tags_json = NULL
     WHERE run_id = ? AND param_def_id = ?`
  ).run(value, runId, param.id);
}

function setLegacyTags(db: ReturnType<typeof openDb>, runId: number, code: string, tags: string[]) {
  const param = db
    .prepare(
      `SELECT p.id
       FROM run_values rv
       JOIN param_definitions p ON p.id = rv.param_def_id
       WHERE rv.run_id = ? AND p.field_kind = 'OUTPUT' AND p.code = ?
       ORDER BY p.id
       LIMIT 1`
    )
    .get(runId, code) as { id: number } | undefined;
  assert.ok(param, `legacy output ${code} is missing for run ${runId}`);
  db.prepare(
    `UPDATE run_values
     SET value_real = NULL, value_text = NULL, value_tags_json = ?
     WHERE run_id = ? AND param_def_id = ?`
  ).run(JSON.stringify(tags), runId, param.id);
}

