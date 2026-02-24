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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-process-routing-"));
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

test("process routing, route_code settings and process-owner access", async () => {
  const { createApp } = await import("../app.js");
  const app = createApp();
  const db = openDb();

  const adminAgent = request.agent(app);
  await adminAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "admin@example.com", password: "TempPass123!" })
    .expect(302);

  await adminAgent
    .post("/auth/change-password")
    .type("form")
    .send({ password: "NewPass123!", confirm: "NewPass123!" })
    .expect(302)
    .expect("Location", "/");

  const processRow = db
    .prepare(
      `
      SELECT p.id, p.name, p.route_code
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      WHERE pt.code = 'injection'
      ORDER BY p.id
      LIMIT 1
      `
    )
    .get() as { id: number; name: string; route_code: string | null };

  assert.ok(processRow.id > 0);
  assert.equal(processRow.route_code, "injection");

  await adminAgent
    .post("/experiments")
    .type("form")
    .send({
      name: "Routing smoke",
      process_id: String(processRow.id)
    })
    .expect(302);

  const experiment = db
    .prepare("SELECT id, process_id FROM experiments ORDER BY id DESC LIMIT 1")
    .get() as { id: number; process_id: number | null };
  assert.ok(experiment.id > 0);
  assert.equal(experiment.process_id, processRow.id);

  await adminAgent.get("/injection").expect(200);
  await adminAgent.get(`/injection/${experiment.id}`).expect(200);
  await adminAgent
    .get(`/experiments/${experiment.id}`)
    .expect(302)
    .expect("Location", `/injection/${experiment.id}`);

  // Reserved route code should be rejected.
  await adminAgent
    .post(`/processes/${processRow.id}/settings`)
    .type("form")
    .send({ route_code: "reports", owner_user_id: "" })
    .expect(400);

  const processOwnerId = createUser(db, {
    email: "process-owner@example.com",
    name: "Process Owner",
    passwordHash: bcrypt.hashSync("OwnerPass123!", 12),
    role: null,
    status: "ACTIVE",
    tempPassword: 0
  });
  assert.ok(processOwnerId > 0);

  await adminAgent
    .post(`/processes/${processRow.id}/settings`)
    .type("form")
    .send({ route_code: "extrusion", owner_user_id: String(processOwnerId) })
    .expect(302)
    .expect("Location", "/extrusion");

  await adminAgent.get("/extrusion").expect(200);
  await adminAgent.get(`/extrusion/${experiment.id}`).expect(200);

  const processOwnerAgent = request.agent(app);
  await processOwnerAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "process-owner@example.com", password: "OwnerPass123!" })
    .expect(302);

  await processOwnerAgent.get(`/extrusion/${experiment.id}`).expect(200);
  // Legacy process-type route remains available for backward compatibility.
  await processOwnerAgent.get(`/injection/${experiment.id}`).expect(200);
});
