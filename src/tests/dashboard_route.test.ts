import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";
import { createTask, createTaskAssignment } from "../repos/tasks_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import { ensureQualificationDefaults } from "../services/qualification_service.js";
import { createReportConfig, submitReportForSignature } from "../repos/reports_repo.js";
import { buildDashboard } from "../services/dashboard_service.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

async function signIn(app: Parameters<typeof request.agent>[0], email: string, password: string) {
  const agent = request.agent(app);
  const csrf = await getCsrfToken(agent, "/auth/login");
  await agent.post("/auth/login").type("form").send({ email, password, _csrf: csrf }).expect(302);
  return agent;
}

test("dashboard scopes actions and renders the supported roles", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-dashboard-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  const password = "Password123!";
  try {
    const db = openDb();
    const roles = ["admin", "manager", "engineer", "operator", "viewer"] as const;
    const users = new Map<string, number>();
    for (const role of roles) {
      users.set(role, createUser(db, {
        email: `${role}@example.com`, name: role, passwordHash: bcrypt.hashSync(password, 10), role, status: "ACTIVE", tempPassword: 0
      }));
    }
    const process = db.prepare("SELECT id FROM processes ORDER BY id LIMIT 1").get() as { id: number };
    const engineerId = users.get("engineer")!;
    const otherEngineerId = createUser(db, {
      email: "other@example.com", name: "Other engineer", passwordHash: bcrypt.hashSync(password, 10), role: "engineer", status: "ACTIVE", tempPassword: 0
    });
    const visibleExperimentId = createExperimentWithDefaults(db, { name: "Visible dashboard experiment", process_id: process.id, owner_user_id: engineerId });
    const hiddenExperimentId = createExperimentWithDefaults(db, { name: "Hidden dashboard experiment", process_id: process.id, owner_user_id: otherEngineerId });
    const archivedExperimentId = createExperimentWithDefaults(db, { name: "Archived dashboard experiment", process_id: process.id, owner_user_id: engineerId });
    db.prepare("UPDATE experiments SET archived_at = datetime('now') WHERE id = ?").run(archivedExperimentId);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const visibleTask = createTask(db, { experiment_id: visibleExperimentId, title: "Visible overdue task", due_at: yesterday, owner_user_id: engineerId });
    createTaskAssignment(db, { task_id: visibleTask, user_id: engineerId, role: "operator" });
    createTask(db, { experiment_id: hiddenExperimentId, title: "Hidden overdue task", due_at: yesterday, owner_user_id: otherEngineerId });
    ensureQualificationDefaults(db, visibleExperimentId);
    db.prepare("UPDATE qual_steps SET status = 'BLOCKED', is_blocked = 1, blocked_reason = 'Waiting for material' WHERE experiment_id = ? AND is_active = 1").run(visibleExperimentId);
    const reportId = createReportConfig(db, { experiment_id: visibleExperimentId, name: "Signature report", executors: null, include_json: "[]", doe_ids_json: "[]", author_user_id: engineerId, responsible_user_id: engineerId });
    submitReportForSignature(db, reportId, engineerId, yesterday);

    const data = buildDashboard(db, { id: engineerId, email: "engineer@example.com", role: "engineer", status: "ACTIVE", temp_password: 0 }, null);
    assert.ok(data.actions.some((item) => item.title.includes("Visible overdue task")));
    assert.ok(!data.actions.some((item) => item.title.includes("Hidden overdue task")));
    assert.ok(data.actions.some((item) => item.title.includes("Sign: Signature report")));
    assert.equal(data.qualifications[0]?.blocked > 0, true);
    assert.ok(!data.continueWorking.some((experiment) => experiment.name === "Archived dashboard experiment"));

    const { createApp } = await import("../app.js");
    const app = createApp();
    for (const role of roles) {
      const agent = await signIn(app, `${role}@example.com`, password);
      const page = await agent.get("/");
      assert.equal(page.status, 200, page.text);
      assert.match(page.text, /R&amp;D dashboard/);
      assert.match(page.text, /Action inbox/);
      if (role === "viewer") assert.doesNotMatch(page.text, /Create experiment/);
    }
    const engineerAgent = await signIn(app, "engineer@example.com", password);
    await engineerAgent.get("/processes").expect(200).expect(/Available process types/);
    await engineerAgent.get(`/?process_id=${process.id}`).expect(200).expect(/Visible dashboard experiment/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
