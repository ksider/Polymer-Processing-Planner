import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { openDb } from "../db.js";

let tempDir = "";

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-demo-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.SESSION_SECRET = "demo-route-test-secret";
  process.env.NODE_ENV = "test";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  process.env.DEMO_USER_EMAIL = "demo@example.com";
});

after(() => {
  process.env.DEMO_MODE_ENABLED = "false";
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test("public demo link is opt-in and its session is read-only", async () => {
  const { createApp } = await import("../app.js");

  process.env.DEMO_MODE_ENABLED = "false";
  const disabledApp = createApp();
  await request(disabledApp).get("/demo").expect(404);
  const disabledLogin = await request(disabledApp).get("/auth/login").expect(200);
  assert.doesNotMatch(disabledLogin.text, /aria-label="Demo access"/);
  assert.equal(
    openDb().prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get("demo@example.com").count,
    0,
    "disabled demo must not create an account"
  );

  process.env.DEMO_MODE_ENABLED = "true";
  const app = createApp();
  const agent = request.agent(app);
  const enabledLogin = await request(app).get("/auth/login").expect(200);
  assert.match(enabledLogin.text, /href="\/demo"/);
  await agent.get("/demo").expect(302).expect("Location", "/");
  const home = await agent.get("/").expect(200);
  assert.match(home.text, /Demo · read-only/);

  const demoUser = openDb().prepare("SELECT role, password_hash FROM users WHERE email = ?").get("demo@example.com") as
    | { role: string; password_hash: string | null }
    | undefined;
  assert.deepEqual(demoUser, { role: "viewer", password_hash: null });

  await agent.post("/me/name").type("form").send({ name: "No change" }).expect(403);
  await agent.get("/admin").expect(403);
});
