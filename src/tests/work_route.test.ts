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
import { buildWorkQueue } from "../services/work_queue_service.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

test("work queue only projects accessible experiments and renders its route", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-work-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  const password = "Password123!";
  try {
    const db = openDb();
    const engineerId = createUser(db, { email: "work-engineer@example.com", name: "Work engineer", passwordHash: bcrypt.hashSync(password, 10), role: "engineer", status: "ACTIVE", tempPassword: 0 });
    const otherId = createUser(db, { email: "work-other@example.com", name: "Other engineer", passwordHash: bcrypt.hashSync(password, 10), role: "engineer", status: "ACTIVE", tempPassword: 0 });
    const viewerId = createUser(db, { email: "work-viewer@example.com", name: "Work viewer", passwordHash: bcrypt.hashSync(password, 10), role: "viewer", status: "ACTIVE", tempPassword: 0 });
    const process = db.prepare("SELECT id FROM processes ORDER BY id LIMIT 1").get() as { id: number };
    const visibleId = createExperimentWithDefaults(db, { name: "Visible work experiment", process_id: process.id, owner_user_id: engineerId });
    const hiddenId = createExperimentWithDefaults(db, { name: "Hidden work experiment", process_id: process.id, owner_user_id: otherId });
    const visibleTask = createTask(db, { experiment_id: visibleId, title: "Visible manual work", owner_user_id: engineerId, due_at: "2030-01-10" });
    createTask(db, { experiment_id: visibleId, title: "Overdue manual work", owner_user_id: engineerId, due_at: "2020-01-10" });
    createTask(db, { experiment_id: hiddenId, title: "Hidden manual work", owner_user_id: otherId });
    const directTask = createTask(db, { experiment_id: hiddenId, title: "Directly assigned work", owner_user_id: otherId });
    createTaskAssignment(db, { task_id: directTask, user_id: engineerId, role: "operator" });
    createTaskAssignment(db, { task_id: directTask, user_id: viewerId, role: "operator" });

    const filters = { processId: null, experimentId: null, type: "all" as const, scope: "all" as const, state: "all" as const, responsibleUserId: null, query: "", page: 1, pageSize: 50 };
    const queue = buildWorkQueue(db, { id: engineerId, email: "work-engineer@example.com", role: "engineer", status: "ACTIVE", temp_password: 0 }, filters);
    assert.ok(queue.items.some((item) => item.title === "Visible manual work"));
    assert.ok(queue.items.some((item) => item.title === "Directly assigned work"));
    assert.ok(!queue.items.some((item) => item.title === "Hidden manual work"));
    assert.ok(queue.attentionItems.some((item) => item.title === "Overdue manual work"));
    assert.match(queue.attentionItems.find((item) => item.title === "Overdue manual work")?.nextAction || "", /^Complete overdue task/);

    const { createApp } = await import("../app.js");
    const agent = request.agent(createApp());
    const csrf = await getCsrfToken(agent, "/auth/login");
    await agent.post("/auth/login").type("form").send({ email: "work-engineer@example.com", password, _csrf: csrf }).expect(302);
    await agent.get("/work?scope=all").expect(200).expect(/data-work-shell/).expect(/Requires attention/).expect(/Visible manual work/).expect(/Directly assigned work/).expect((response) => {
      assert.doesNotMatch(response.text, /Hidden manual work/);
    });
    await agent.get("/work/board?scope=all").expect(200).expect(/data-work-board/).expect(/"changeStatus":true/);
    await agent.get("/work/calendar?scope=all").expect(200).expect(/data-work-calendar/);
    const workCsrf = await getCsrfToken(agent, "/work/board?scope=all");
    await agent.post(`/tasks/${visibleTask}/status`).set("X-CSRF-Token", workCsrf).send({ status: "in_progress" }).expect(200);
    assert.equal((db.prepare("SELECT status FROM tasks WHERE id = ?").get(visibleTask) as { status: string }).status, "in_progress");
    await agent.post("/work/preferences").set("X-CSRF-Token", workCsrf).send({ default_view: "board", last_scope: "all", density: "compact" }).expect(200);
    await agent.get("/work").expect(200).expect(/data-work-density="compact"/).expect(/name="view" value="board"/);
    await agent.get("/calendar/events?scope=workspace").expect(200).expect((response) => {
      assert.ok(response.body.events.some((event: { title: string }) => event.title.includes("Visible manual work")));
      assert.ok(!response.body.events.some((event: { title: string }) => event.title.includes("Hidden manual work")));
    });
    const viewer = request.agent(createApp());
    const viewerCsrf = await getCsrfToken(viewer, "/auth/login");
    await viewer.post("/auth/login").type("form").send({ email: "work-viewer@example.com", password, _csrf: viewerCsrf }).expect(302);
    await viewer.get("/work/board").expect(200).expect(/"changeStatus":false/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
