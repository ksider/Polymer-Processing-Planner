import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { openDb } from "../db.js";
import { createMachine } from "../repos/machines_repo.js";
import { createMachineParam } from "../repos/machine_params_repo.js";
import { createUser } from "../repos/users_repo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

test("machine custom-field values are rendered from persisted machine parameters", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-machines-"));
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
    const machineId = createMachine(db, {
      name: "Press 1",
      image_url: null,
      vendor: null,
      model: null,
      settings_json: "{}",
      notes: null
    });
    createMachineParam(db, {
      machine_id: machineId,
      code: "barrel_capacity",
      label: "Barrel capacity",
      unit: "cm3",
      value_text: "275"
    });

    const { createApp } = await import("../app.js");
    const agent = request.agent(createApp());
    const loginCsrf = await getCsrfToken(agent, "/auth/login");
    await agent
      .post("/auth/login")
      .type("form")
      .send({ email: "admin@example.com", password: "AdminPass123!", _csrf: loginCsrf })
      .expect(302);

    const page = await agent.get(`/machines/${machineId}`).expect(200);
    assert.match(page.text, /"label":"Barrel capacity"/);
    assert.match(page.text, /"value":"275"/);
    assert.match(page.text, /ui:\s*'flowbite'/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
