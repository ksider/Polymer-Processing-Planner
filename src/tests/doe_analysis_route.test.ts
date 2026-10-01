import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import request from "supertest";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";
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

    const workspace = await agent
      .get(`/experiments/${experimentId}/doe/${doeId}/analysis-v2`)
      .expect(200)
      .expect(/Analysis V2/)
      .expect(/Data worksheet/);
    assert.match(workspace.text, /<script nonce="[^"]+" src="\/doe_analysis_workspace\.js" defer><\/script>/);
    assert.match(workspace.text, /<script nonce="[^"]+" src="\/vendor\/echarts\/dist\/echarts\.min\.js" defer><\/script>/);

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
    assert.equal(calculation.body.datasetRevision, datasetAfterNewResponse.body.datasetRevision);

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
      .expect(200);
    assert.equal(savedCalculation.body.result.ok, true);
    assert.equal(savedCalculation.body.revision.status, "SUCCEEDED");
    assert.equal(savedCalculation.body.state, "calculated");

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
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
