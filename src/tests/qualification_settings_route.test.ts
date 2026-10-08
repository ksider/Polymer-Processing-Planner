import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { openDb } from "../db.js";
import { getQualStepSettings } from "../repos/qual_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

test("qualification settings autosave returns JSON and persists rheology values", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-qualification-settings-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  try {
    const { createApp } = await import("../app.js");
    const app = createApp();
    const db = openDb();
    db.prepare("UPDATE users SET password_hash = ?, temp_password = 0 WHERE email = ?").run(
      bcrypt.hashSync("AdminPass123!", 12),
      "admin@example.com"
    );
    const experimentId = createExperimentWithDefaults(db, { name: "Qualification settings" });

    const agent = request.agent(app);
    const loginCsrf = await getCsrfToken(agent, "/auth/login");
    await agent
      .post("/auth/login")
      .type("form")
      .send({ email: "admin@example.com", password: "AdminPass123!", _csrf: loginCsrf })
      .expect(302);

    const pageCsrf = await getCsrfToken(agent, `/experiments/${experimentId}/qualification/1`);
    await agent
      .post(`/experiments/${experimentId}/qualification/1/settings`)
      .set("x-csrf-token", pageCsrf)
      .set("x-requested-with", "XMLHttpRequest")
      .type("form")
      .send({ intensification_coeff: "2.5", melt_temp_c: "215", recommended_inj_speed: "42" })
      .expect(200)
      .expect({ ok: true });

    const stored = JSON.parse(getQualStepSettings(db, experimentId, 1) || "{}");
    assert.equal(stored.intensification_coeff, 2.5);
    assert.equal(stored.melt_temp_c, 215);
    assert.equal(stored.recommended_inj_speed, 42);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
