import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { openDb } from "../db.js";
import { insertAudit } from "../repos/audit_repo.js";
import { createUser } from "../repos/users_repo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

test("audit console renders recent events and exports the complete log", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-audit-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  try {
    const db = openDb();
    const adminId = createUser(db, {
      email: "admin@example.com",
      name: "Admin",
      passwordHash: bcrypt.hashSync("AdminPass123!", 12),
      role: "admin",
      status: "ACTIVE",
      tempPassword: 0
    });
    insertAudit(db, {
      actorUserId: adminId,
      action: "admin.process.settings.update",
      targetUserId: null,
      detailsJson: JSON.stringify({ route_code: "injection" })
    });
    const { createApp } = await import("../app.js");
    const agent = request.agent(createApp());
    const loginCsrf = await getCsrfToken(agent, "/auth/login");
    await agent
      .post("/auth/login")
      .type("form")
      .send({ email: "admin@example.com", password: "AdminPass123!", _csrf: loginCsrf })
      .expect(302);

    const page = await agent.get("/audit").expect(200);
    assert.match(page.text, /Event console/);
    assert.match(page.text, /admin\.process\.settings\.update/);
    assert.match(page.text, /href="\/audit" aria-current="page"/);
    assert.doesNotMatch(page.text, /href="\/machines" aria-current="page"/);

    const exported = await agent.get("/audit/export.jsonl").expect(200);
    assert.match(String(exported.headers["content-disposition"]), /planner-audit-.*\.jsonl/);
    assert.match(exported.text, /admin\.process\.settings\.update/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
