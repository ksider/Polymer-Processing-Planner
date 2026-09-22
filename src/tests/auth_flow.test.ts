import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import bcrypt from "bcryptjs";
import request from "supertest";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";
import { createTask } from "../repos/tasks_repo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-"));
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

  await request(app)
    .post("/auth/login")
    .type("form")
    .send({ email: "admin@example.com", password: "TempPass123!" })
    .expect(403);

  const loginCsrf = await getCsrfToken(agent, "/auth/login");

  const loginRes = await agent
    .post("/auth/login")
    .type("form")
    .send({ email: "admin@example.com", password: "TempPass123!", _csrf: loginCsrf })
    .expect(302);
  assert.equal(loginRes.headers.location, "/", "login redirect mismatch");
  assert.ok(loginRes.headers["set-cookie"], "session cookie not set");

  await agent.get("/").expect(302).expect("Location", "/auth/change-password");

  const passwordCsrf = await getCsrfToken(agent, "/auth/change-password");
  await agent
    .post("/auth/change-password")
    .type("form")
    .send({ password: "NewPassword123!", confirm: "NewPassword123!", _csrf: passwordCsrf })
    .expect(302)
    .expect("Location", "/");

  const logoutCsrf = await getCsrfToken(agent, "/");
  await agent.post("/auth/logout").type("form").send({ _csrf: logoutCsrf }).expect(302);

  const secondLoginCsrf = await getCsrfToken(agent, "/auth/login");
  await agent
    .post("/auth/login")
    .type("form")
    .send({ email: "admin@example.com", password: "NewPassword123!", _csrf: secondLoginCsrf })
    .expect(302);

  const userId = createUser(db, {
    email: "user1@example.com",
    name: null,
    passwordHash: bcrypt.hashSync("UserPass123!", 12),
    role: "viewer",
    status: "ACTIVE",
    tempPassword: 0
  });
  assert.ok(userId > 0);

  const experimentCsrf = await getCsrfToken(agent, "/");
  await agent
    .post("/experiments")
    .type("form")
    .send({ name: "Admin Experiment", _csrf: experimentCsrf })
    .expect(302);

  const experimentRow = db
    .prepare("SELECT id, owner_user_id, name FROM experiments ORDER BY id DESC LIMIT 1")
    .get() as { id: number; owner_user_id: number | null; name: string };
  assert.ok(experimentRow.id > 0);
  assert.ok(experimentRow.owner_user_id);
  assert.match(experimentRow.name, /^injection\/\d+\b/i);

  const userAgent = request.agent(app);
  const userLoginCsrf = await getCsrfToken(userAgent, "/auth/login");
  await userAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "user1@example.com", password: "UserPass123!", _csrf: userLoginCsrf })
    .expect(302);

  await userAgent.get(`/experiments/${experimentRow.id}`).expect(403);

  const taskId = createTask(db, {
    experiment_id: experimentRow.id,
    title: "Private task"
  });
  await userAgent.get(`/tasks/${taskId}`).expect(403);
});
