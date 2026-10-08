import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

test("administrator can view safe system health and run diagnostics", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-health-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  try {
    const db = openDb();
    createUser(db, {
      email: "admin@example.com",
      name: "Admin",
      passwordHash: bcrypt.hashSync("AdminPass123!", 12),
      role: "admin",
      status: "ACTIVE",
      tempPassword: 0
    });
    const { createApp } = await import("../app.js");
    const agent = request.agent(createApp());
    const loginCsrf = await getCsrfToken(agent, "/auth/login");
    await agent
      .post("/auth/login")
      .type("form")
      .send({ email: "admin@example.com", password: "AdminPass123!", _csrf: loginCsrf })
      .expect(302);

    const page = await agent.get("/system-health").expect(200);
    assert.match(page.text, /System Health/);
    assert.match(page.text, /DOE background jobs/);
    assert.match(page.text, /href="\/system-health" aria-current="page"/);

    const csrf = await getCsrfToken(agent, "/system-health");
    const diagnostics = await agent
      .post("/system-health/check")
      .set("X-Requested-With", "fetch")
      .type("form")
      .send({ _csrf: csrf })
      .expect(200);
    assert.equal(diagnostics.body.ok, true);
    assert.equal(diagnostics.body.checks.database.status, "healthy");
    assert.equal(diagnostics.body.checks.analytics.status, "healthy");
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
