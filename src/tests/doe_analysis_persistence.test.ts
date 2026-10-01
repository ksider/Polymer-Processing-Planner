import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import { ensureSeedParams } from "../services/seed.js";
import {
  createDoeWithDefaults,
  createExperimentWithDefaults,
  generateRuns
} from "../services/experiments_service.js";
import {
  buildDoeAnalysisDataset,
  createAnalyticsRequest,
  createDoeAnalysis,
  getDoeAnalysis,
  getLatestSuccessfulDoeAnalysisRevision,
  listDoeAnalysisRevisions,
  MockDoeAnalyticsClient,
  resolveDoeAnalysisState,
  saveFailedDoeAnalysisRevision,
  saveSuccessfulDoeAnalysisRevision
} from "../modules/doe_analysis/index.js";

test("saved DOE analysis keeps successful revisions and becomes stale with source data", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-saved-analysis-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  const db = openDb();
  try {
    ensureSeedParams(db);
    const experimentId = createExperimentWithDefaults(db, { name: "Saved analysis fixture" });
    const doeId = createDoeWithDefaults(db, {
      experimentId,
      name: "Saved FFA",
      design_type: "FFA",
      seed: 42,
      center_points: 3,
      max_runs: 200,
      replicate_count: 1,
      recipe_as_block: 0
    });
    generateRuns(db, experimentId, doeId);

    const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
    const request = createAnalyticsRequest(dataset, { includeIncomplete: true }, "saved-success");
    const analysis = createDoeAnalysis(db, {
      doeId,
      name: "Part weight model",
      specification: request.specification
    });
    assert.equal(resolveDoeAnalysisState(db, analysis, dataset.datasetRevision), "draft");

    const result = await new MockDoeAnalyticsClient().analyze(request);
    const successful = saveSuccessfulDoeAnalysisRevision(db, analysis, result);
    const afterSuccess = getDoeAnalysis(db, doeId, analysis.id);
    assert.ok(afterSuccess);
    assert.equal(afterSuccess.latestSuccessfulRevisionId, successful.id);
    assert.equal(resolveDoeAnalysisState(db, afterSuccess, dataset.datasetRevision), "calculated");

    const factorValue = db.prepare(
      `SELECT rv.run_id, rv.param_def_id, rv.value_real
       FROM run_values rv
       JOIN runs r ON r.id = rv.run_id
       JOIN param_definitions p ON p.id = rv.param_def_id
       WHERE r.doe_id = ? AND p.field_kind = 'INPUT' AND rv.value_real IS NOT NULL
       LIMIT 1`
    ).get(doeId) as { run_id: number; param_def_id: number; value_real: number };
    db.prepare(
      "UPDATE run_values SET value_real = ? WHERE run_id = ? AND param_def_id = ?"
    ).run(factorValue.value_real + 0.25, factorValue.run_id, factorValue.param_def_id);
    const changedDataset = buildDoeAnalysisDataset(db, experimentId, doeId);
    assert.notEqual(changedDataset.datasetRevision, dataset.datasetRevision);
    assert.equal(resolveDoeAnalysisState(db, afterSuccess, changedDataset.datasetRevision), "stale");

    const failed = saveFailedDoeAnalysisRevision(db, afterSuccess, {
      datasetRevision: changedDataset.datasetRevision,
      contractVersion: "1.0",
      requestId: "saved-failure",
      specification: request.specification,
      error: { code: "FIXTURE_FAILURE", message: "Expected failure", retryable: false }
    });
    assert.equal(failed.status, "FAILED");
    const afterFailure = getDoeAnalysis(db, doeId, analysis.id);
    assert.ok(afterFailure);
    assert.equal(afterFailure.latestSuccessfulRevisionId, successful.id);
    assert.equal(resolveDoeAnalysisState(db, afterFailure, changedDataset.datasetRevision), "failed");
    assert.equal(getLatestSuccessfulDoeAnalysisRevision(db, afterFailure)?.id, successful.id);
    assert.equal(listDoeAnalysisRevisions(db, analysis.id).length, 2);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
