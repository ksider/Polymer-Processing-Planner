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

test("administrator can save a Resend connection and auth sender without exposing its key", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-email-admin-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  process.env.APP_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");

  try {
    const db = openDb();
    createUser(db, { email: "admin@example.com", name: "Admin", passwordHash: bcrypt.hashSync("AdminPass123!", 12), role: "admin", status: "ACTIVE", tempPassword: 0 });
    const { createApp } = await import("../app.js");
    const agent = request.agent(createApp());
    const loginCsrf = await getCsrfToken(agent, "/auth/login");
    await agent.post("/auth/login").type("form").send({ email: "admin@example.com", password: "AdminPass123!", _csrf: loginCsrf }).expect(302);

    const csrf = await getCsrfToken(agent, "/admin");
    const connection = await agent.post("/admin/email-providers").set("X-Requested-With", "fetch").type("form").send({ name: "Primary Resend", api_key: "re_route_test_secret", _csrf: csrf }).expect(200);
    assert.equal(connection.body.ok, true);
    const provider = db.prepare("SELECT id, api_key_ciphertext FROM email_provider_profiles").get() as { id: number; api_key_ciphertext: string };
    assert.notEqual(provider.api_key_ciphertext, "re_route_test_secret");

    const sender = await agent.post("/admin/email-senders").set("X-Requested-With", "fetch").type("form").send({ provider_profile_id: provider.id, purpose: "auth", name: "Planner auth", from_name: "IM Planner", from_email: "noreply@example.com", reply_to: "support@example.com", is_default: "1", _csrf: csrf }).expect(200);
    assert.equal(sender.body.ok, true);
    const page = await agent.get("/admin").expect(200);
    assert.match(page.text, /Primary Resend/);
    assert.match(page.text, /Planner auth/);
    assert.doesNotMatch(page.text, /re_route_test_secret/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
