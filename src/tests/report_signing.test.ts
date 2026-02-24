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

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-report-sign-"));
  dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret";
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
  await ownerAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "owner@example.com", password: "OwnerPass123!" })
    .expect(302);

  await ownerAgent
    .post(`/reports/${reportId}/sign`)
    .expect(302)
    .expect("Location", `/reports/${reportId}`);

  const signed = db
    .prepare("SELECT signed_at, signed_by_user_id FROM report_configs WHERE id = ?")
    .get(reportId) as { signed_at: string | null; signed_by_user_id: number | null };
  assert.ok(signed.signed_at, "signed_at should be set by owner");
  assert.equal(signed.signed_by_user_id, ownerUserId);

  db.prepare("UPDATE report_configs SET signed_at = NULL, signed_by_user_id = NULL WHERE id = ?").run(reportId);

  const otherAgent = request.agent(app);
  await otherAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "other@example.com", password: "OtherPass123!" })
    .expect(302);

  await otherAgent
    .post(`/reports/${reportId}/sign`)
    .expect(403);

  const afterOtherAttempt = db
    .prepare("SELECT signed_at, signed_by_user_id FROM report_configs WHERE id = ?")
    .get(reportId) as { signed_at: string | null; signed_by_user_id: number | null };
  assert.equal(afterOtherAttempt.signed_at, null);
  assert.equal(afterOtherAttempt.signed_by_user_id, null);
});
