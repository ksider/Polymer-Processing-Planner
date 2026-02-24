import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import bcrypt from "bcryptjs";
import request from "supertest";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-"));
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

test("temp password flow and owner access", async () => {
  const { createApp } = await import("../app.js");
  const app = createApp();
  const agent = request.agent(app);

  assert.equal(process.env.ADMIN_TEMP_PASSWORD, "TempPass123!");
  const db = openDb();
  const adminRow = db.prepare("SELECT email, password_hash FROM users WHERE email = ?").get("admin@example.com") as
    | { email: string; password_hash: string | null }
    | undefined;
  assert.ok(adminRow, "admin user not created");
  assert.ok(adminRow.password_hash, "admin password missing");
  assert.ok(bcrypt.compareSync("TempPass123!", adminRow.password_hash), "admin password mismatch");

  await agent.get("/auth/login").expect(200);

  const loginRes = await agent
    .post("/auth/login")
    .type("form")
    .send({ email: "admin@example.com", password: "TempPass123!" })
    .expect(302);
  assert.equal(loginRes.headers.location, "/", "login redirect mismatch");
  assert.ok(loginRes.headers["set-cookie"], "session cookie not set");

  await agent.get("/").expect(302).expect("Location", "/auth/change-password");

  await agent
    .post("/auth/change-password")
    .type("form")
    .send({ password: "NewPass123!", confirm: "NewPass123!" })
    .expect(302)
    .expect("Location", "/");

  await agent.post("/auth/logout").expect(302);

  await agent
    .post("/auth/login")
    .type("form")
    .send({ email: "admin@example.com", password: "NewPass123!" })
    .expect(302);

  const userId = createUser(db, {
    email: "user1@example.com",
    name: null,
    passwordHash: bcrypt.hashSync("UserPass123!", 12),
    role: null,
    status: "ACTIVE",
    tempPassword: 0
  });
  assert.ok(userId > 0);

  await agent
    .post("/experiments")
    .type("form")
    .send({ name: "Admin Experiment" })
    .expect(302);

  const experimentRow = db
    .prepare("SELECT id, owner_user_id, name FROM experiments ORDER BY id DESC LIMIT 1")
    .get() as { id: number; owner_user_id: number | null; name: string };
  assert.ok(experimentRow.id > 0);
  assert.ok(experimentRow.owner_user_id);
  assert.match(experimentRow.name, /^injection\/\d+\b/i);

  const userAgent = request.agent(app);
  await userAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "user1@example.com", password: "UserPass123!" })
    .expect(302);

  await userAgent.get(`/experiments/${experimentRow.id}`).expect(403);
});
