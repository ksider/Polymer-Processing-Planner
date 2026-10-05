import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import request from "supertest";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";
import { createReportConfig } from "../repos/reports_repo.js";
import {
  createDoeWithDefaults,
  createExperimentWithDefaults,
  generateRuns
} from "../services/experiments_service.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

test("Analysis V2 dataset endpoint uses experiment access and DOE ownership", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-analysis-v2-route-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  process.env.DOE_ANALYSIS_LLM_ENABLED = "true";

  const { createApp } = await import("../app.js");
  const app = createApp();
  const db = openDb();
  try {
    const userId = createUser(db, {
      email: "analysis-owner@example.com",
      name: "Analysis Owner",
      passwordHash: bcrypt.hashSync("OwnerPass123!", 12),
      role: "engineer",
      status: "ACTIVE",
      tempPassword: 0
    });
    const experimentId = createExperimentWithDefaults(db, {
      name: "Analysis route fixture",
      owner_user_id: userId
    });
    const doeId = createDoeWithDefaults(db, {
      experimentId,
      name: "BBD route fixture",
      design_type: "BBD",
      seed: 42,
      center_points: 3,
      max_runs: 200,
      replicate_count: 1,
      recipe_as_block: 0
    });
    generateRuns(db, experimentId, doeId);

    await request(app)
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/dataset`)
      .expect(302)
      .expect("Location", "/auth/login");

    const agent = request.agent(app);
    const loginCsrf = await getCsrfToken(agent, "/auth/login");
    await agent
      .post("/auth/login")
      .type("form")
      .send({
        email: "analysis-owner@example.com",
        password: "OwnerPass123!",
        _csrf: loginCsrf
      })
      .expect(302);

    const response = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/dataset`)
      .expect(200)
      .expect("Cache-Control", "no-store");

    assert.equal(response.body.contractVersion, "1.0");
    assert.equal(response.body.experimentId, experimentId);
    assert.equal(response.body.doe.id, doeId);
    assert.equal(response.body.doe.designType, "BBD");
    assert.equal(response.body.rows.length, 15);

    const canonicalExport = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/export.csv`)
      .expect(200)
      .expect("Cache-Control", "no-store")
      .expect("Content-Type", /text\/csv/);
    assert.doesNotMatch(canonicalExport.text, /# "contract_version"/);
    assert.match(canonicalExport.text, /"Run","[a-z0-9_]+","[a-z0-9_]+"/);
    assert.doesNotMatch(canonicalExport.text, /\[coded\]|"Done"|"Excluded"/);
    const exportMetadata = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/export.metadata.json`)
      .expect(200)
      .expect("Cache-Control", "no-store");
    assert.equal(exportMetadata.body.contractVersion, "1.0");
    assert.equal(exportMetadata.body.datasetRevision, response.body.datasetRevision);
    assert.ok(exportMetadata.body.columns.some((column: { role: string }) => column.role === "factor"));

    const workspace = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2`)
      .expect(200)
      .expect(/Analysis V2/)
      .expect(/Data worksheet/);
    assert.match(workspace.text, /<script nonce="[^"]+" src="\/doe_analysis_workspace\.js(?:\?[^\"]+)?" defer><\/script>/);
    assert.match(workspace.text, /<script nonce="[^"]+" src="\/vendor\/echarts\/dist\/echarts\.min\.js" defer><\/script>/);
    assert.doesNotMatch(workspace.text, /Old analysis/);
    assert.match(workspace.text, /data-model-term-feedback/);

    const pageCsrf = await getCsrfToken(
      agent,
      `/experiments/${experimentId}/doe/${doeId}?tab=analysis`
    );
    const designPage = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}?tab=design&manage_fields=1`)
      .expect(200);
    assert.match(designPage.text, /Measured Responses/);
    assert.match(designPage.text, /Configure measured responses/);
    assert.match(designPage.text, /if \(measuredDialog && true\)/);

    const runCountBeforeNewResponse = db
      .prepare("SELECT COUNT(*) AS count FROM runs WHERE doe_id = ?")
      .get(doeId) as { count: number };
    await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-fields/new`)
      .set("accept", "text/html")
      .set("x-csrf-token", pageCsrf)
      .type("form")
      .send({ label: "Late observation", field_type: "number", unit: "score" })
      .expect(302)
      .expect("Location", `/experiments/${experimentId}/doe/${doeId}?tab=design&manage_fields=1`);
    const runCountAfterNewResponse = db
      .prepare("SELECT COUNT(*) AS count FROM runs WHERE doe_id = ?")
      .get(doeId) as { count: number };
    assert.equal(runCountAfterNewResponse.count, runCountBeforeNewResponse.count);
    const datasetAfterNewResponse = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/dataset`)
      .expect(200);
    assert.notEqual(datasetAfterNewResponse.body.datasetRevision, response.body.datasetRevision);

    const confirmationSettings = Object.fromEntries(datasetAfterNewResponse.body.columns
      .filter((column: { role: string; dataType: string }) => column.role === "factor" && column.dataType === "number")
      .map((column: { key: string; factor?: { levels?: number[] } }) => [column.key, column.factor?.levels?.[0] ?? 0]));
    const confirmationRun = await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/confirmation-runs`)
      .set("x-csrf-token", pageCsrf)
      .send({ factorValues: confirmationSettings })
      .expect(201);
    assert.match(confirmationRun.body.run.run_code, /^CONF-/);
    assert.equal(confirmationRun.body.run.done, 0);
    const datasetAfterConfirmation = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/dataset`)
      .expect(200);

    const engine = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/engine`)
      .expect(200);
    assert.equal(engine.body.status, "ok");
    assert.equal(engine.body.engine.mode, "mock");

    const calculation = await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/calculate`)
      .set("x-csrf-token", pageCsrf)
      .send({})
      .expect(200);
    assert.equal(calculation.body.ok, true);
    assert.equal(calculation.body.engine.mode, "mock");
    assert.equal(calculation.body.datasetRevision, datasetAfterConfirmation.body.datasetRevision);

    const createdAnalysis = await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses`)
      .set("x-csrf-token", pageCsrf)
      .send({ name: "Saved BBD model" })
      .expect(201);
    assert.equal(createdAnalysis.body.analysis.name, "Saved BBD model");
    assert.equal(createdAnalysis.body.state, "draft");

    const savedCalculation = await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses/${createdAnalysis.body.analysis.id}/calculate`)
      .set("x-csrf-token", pageCsrf)
      .send({})
      .expect(202);
    assert.equal(savedCalculation.body.job.status, "QUEUED");
    const finishedCalculation = await waitForCalculationJob(
      agent,
      `/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses/${createdAnalysis.body.analysis.id}/jobs/${savedCalculation.body.job.id}`
    );
    assert.equal(finishedCalculation.body.job.status, "SUCCEEDED");
    assert.equal(finishedCalculation.body.result.ok, true);
    assert.equal(finishedCalculation.body.revision.status, "SUCCEEDED");

    const interpretation = await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/interpret`)
      .set("x-csrf-token", pageCsrf)
      .send({
        analysisId: createdAnalysis.body.analysis.id,
        revisionId: finishedCalculation.body.revision.id,
        question: "How should I optimize this response?",
        locale: "en"
      })
      .expect(200);
    assert.equal(interpretation.body.mode, "mock");
    assert.equal(interpretation.body.source.revisionId, finishedCalculation.body.revision.id);
    assert.ok(interpretation.body.interpretation.clarifyingQuestions.length <= 1);
    assert.doesNotMatch(JSON.stringify(interpretation.body), /"rows"\s*:/);

    const reportId = createReportConfig(db, {
      experiment_id: experimentId,
      name: "Analysis snapshot report",
      executors: null,
      include_json: "[]",
      doe_ids_json: "[]"
    });
    const reportSnapshot = await agent
      .get(`/reports/${reportId}/sources/doe/${doeId}/analysis-v2`)
      .expect(200);
    assert.equal(reportSnapshot.body.study.id, doeId);
    assert.equal(reportSnapshot.body.analyses[0].name, "Saved BBD model");
    assert.equal(reportSnapshot.body.selected.analysisId, createdAnalysis.body.analysis.id);
    assert.equal(reportSnapshot.body.revision.id, finishedCalculation.body.revision.id);
    assert.equal(reportSnapshot.body.revision.result.requestId, finishedCalculation.body.result.requestId);

    const analysisList = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses`)
      .expect(200);
    assert.equal(analysisList.body.analyses.length, 1);
    assert.equal(analysisList.body.analyses[0].revisions.length, 1);

    await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2?analysis_id=${createdAnalysis.body.analysis.id}`)
      .expect(200)
      .expect(/Saved BBD model/)
      .expect(/Recalculate and save/);

    await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/calculate`)
      .set("x-csrf-token", pageCsrf)
      .send({ specification: { responseKey: "response:missing" } })
      .expect(400);

    await agent
      .get(`/experiments/${experimentId + 999}/doe/${doeId}/analysis-v2/dataset`)
      .expect(404);

    const renamedAnalysis = await agent
      .patch(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses/${createdAnalysis.body.analysis.id}`)
      .set("x-csrf-token", pageCsrf)
      .send({ name: "Renamed BBD model" })
      .expect(200);
    assert.equal(renamedAnalysis.body.analysis.name, "Renamed BBD model");

    const duplicatedAnalysis = await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses/${createdAnalysis.body.analysis.id}/duplicate`)
      .set("x-csrf-token", pageCsrf)
      .send({ name: "BBD model copy" })
      .expect(201);
    assert.equal(duplicatedAnalysis.body.analysis.name, "BBD model copy");
    assert.equal(duplicatedAnalysis.body.analysis.latestSuccessfulRevisionId, null);

    await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses/${createdAnalysis.body.analysis.id}/archive`)
      .set("x-csrf-token", pageCsrf)
      .send({})
      .expect(200)
      .expect((response) => assert.equal(response.body.state, "archived"));
    await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses/${createdAnalysis.body.analysis.id}/calculate`)
      .set("x-csrf-token", pageCsrf)
      .send({})
      .expect(409);
    const restoredAnalysis = await agent
      .post(`/experiments/${experimentId}/doe/${doeId}/analysis-v2/analyses/${createdAnalysis.body.analysis.id}/restore`)
      .set("x-csrf-token", pageCsrf)
      .send({})
      .expect(200);
    assert.equal(restoredAnalysis.body.analysis.archivedAt, null);

    const events = db.prepare(
      "SELECT action, details_json FROM doe_analysis_events WHERE analysis_id = ? ORDER BY id"
    ).all(createdAnalysis.body.analysis.id) as Array<{ action: string; details_json: string | null }>;
    assert.deepEqual(events.map((event) => event.action), [
      "CREATED",
      "CALCULATION_QUEUED",
      "CALCULATED",
      "RENAMED",
      "ARCHIVED",
      "RESTORED"
    ]);
    assert.equal(JSON.parse(events[0].details_json || "{}").name, "Saved BBD model");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function waitForCalculationJob(
  agent: ReturnType<typeof request.agent>,
  url: string
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await agent.get(url).expect(200);
    if (!["QUEUED", "RUNNING"].includes(response.body.job.status)) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Calculation job did not finish within the test timeout");
}
