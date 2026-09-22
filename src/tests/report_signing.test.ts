import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import bcrypt from "bcryptjs";
import request from "supertest";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import { createReportConfig } from "../repos/reports_repo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-report-sign-"));
  dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
});

after(() => {
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // ignore locked db on Windows
    }
  }
});

test("only experiment owner can sign report", async () => {
  const { createApp } = await import("../app.js");
  const app = createApp();
  const db = openDb();

  const ownerUserId = createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: bcrypt.hashSync("OwnerPass123!", 12),
    role: "engineer",
    status: "ACTIVE",
    tempPassword: 0
  });
  const otherUserId = createUser(db, {
    email: "other@example.com",
    name: "Other",
    passwordHash: bcrypt.hashSync("OtherPass123!", 12),
    role: "engineer",
    status: "ACTIVE",
    tempPassword: 0
  });
  assert.ok(ownerUserId > 0);
  assert.ok(otherUserId > 0);

  const experimentId = createExperimentWithDefaults(db, {
    name: "Owner sign test",
    owner_user_id: ownerUserId
  });
  const reportId = createReportConfig(db, {
    experiment_id: experimentId,
    name: "Report A",
    executors: null,
    include_json: "[]",
    doe_ids_json: "[]"
  });

  const ownerAgent = request.agent(app);
  const ownerLoginCsrf = await getCsrfToken(ownerAgent, "/auth/login");
  await ownerAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "owner@example.com", password: "OwnerPass123!", _csrf: ownerLoginCsrf })
    .expect(302);

  const createReportCsrf = await getCsrfToken(ownerAgent, `/reports/${reportId}`);
  const createResponse = await ownerAgent
    .post(`/experiments/${experimentId}/reports`)
    .type("form")
    .send({ name: "Blank workspace", _csrf: createReportCsrf })
    .expect(200);
  const draftReportId = Number(createResponse.body.id);
  assert.ok(Number.isFinite(draftReportId));
  assert.equal(createResponse.body.url, `/reports/${draftReportId}/editor`);

  const draftDocument = db
    .prepare("SELECT content_json, html_snapshot FROM report_documents WHERE report_id = ?")
    .get(draftReportId) as { content_json: string; html_snapshot: string | null } | undefined;
  const outline = JSON.parse(draftDocument?.content_json ?? "null") as {
    type?: string;
    content?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
  };
  assert.equal(outline.type, "doc");
  assert.equal(outline.content?.[0]?.content?.[0]?.text, "1. Objective");
  assert.equal(outline.content?.[3]?.content?.[0]?.text, "Machine");
  assert.equal(draftDocument?.html_snapshot, null);

  const workspace = await ownerAgent.get(`/reports/${draftReportId}/editor`).expect(200);
  assert.match(workspace.text, /report-workspace/);
  assert.match(workspace.text, /Research data/);
  assert.match(workspace.text, /sourcePreviewDialog/);

  await ownerAgent
    .post(`/reports/${reportId}/sign`)
    .type("form")
    .send({ _csrf: createReportCsrf })
    .expect(302)
    .expect("Location", `/reports/${reportId}`);

  const signed = db
    .prepare("SELECT signed_at, signed_by_user_id FROM report_configs WHERE id = ?")
    .get(reportId) as { signed_at: string | null; signed_by_user_id: number | null };
  assert.ok(signed.signed_at, "signed_at should be set by owner");
  assert.equal(signed.signed_by_user_id, ownerUserId);

  db.prepare("UPDATE report_configs SET signed_at = NULL, signed_by_user_id = NULL WHERE id = ?").run(reportId);

  const otherAgent = request.agent(app);
  const otherLoginCsrf = await getCsrfToken(otherAgent, "/auth/login");
  await otherAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "other@example.com", password: "OtherPass123!", _csrf: otherLoginCsrf })
    .expect(302);

  const otherSignCsrf = await getCsrfToken(otherAgent, "/");
  await otherAgent
    .post(`/reports/${reportId}/sign`)
    .type("form")
    .send({ _csrf: otherSignCsrf })
    .expect(403);

  const afterOtherAttempt = db
    .prepare("SELECT signed_at, signed_by_user_id FROM report_configs WHERE id = ?")
    .get(reportId) as { signed_at: string | null; signed_by_user_id: number | null };
  assert.equal(afterOtherAttempt.signed_at, null);
  assert.equal(afterOtherAttempt.signed_by_user_id, null);
});
