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

test("an administrator can save an encrypted universal AI provider profile", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-llm-admin-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  process.env.LLM_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");

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

    const csrf = await getCsrfToken(agent, "/admin");
    const created = await agent
      .post("/admin/ai-providers")
      .set("X-Requested-With", "fetch")
      .type("form")
      .send({
        name: "Test hosted model",
        provider_kind: "openai_compatible",
        base_url: "https://llm.example.test/v1",
        model: "test-model",
        max_output_tokens: "1200",
        temperature: "0.2",
        timeout_ms: "30000",
        enabled: "on",
        default_for_doe: "on",
        api_key: "route-test-secret",
        _csrf: csrf
      })
      .expect(200);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.profile.hasApiKey, true);
    assert.equal("apiKey" in created.body.profile, false);

    const stored = db.prepare("SELECT api_key_ciphertext FROM llm_provider_profiles").get() as {
      api_key_ciphertext: string;
    };
    assert.notEqual(stored.api_key_ciphertext, "route-test-secret");
    const page = await agent.get("/admin").expect(200);
    assert.doesNotMatch(page.text, /route-test-secret/);
    assert.match(page.text, /Test hosted model/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
