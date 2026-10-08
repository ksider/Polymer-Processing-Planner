import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../db.js";
import { createTask } from "../repos/tasks_repo.js";
import { listExperimentCalendarEvents } from "../services/calendar_service.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import { ensureSeedParams } from "../services/seed.js";

test("experiment calendar returns only events belonging to the selected experiment", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-experiment-calendar-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";

  const db = openDb();
  try {
    ensureSeedParams(db);
    const selectedExperimentId = createExperimentWithDefaults(db, { name: "Scheduled experiment" });
    const otherExperimentId = createExperimentWithDefaults(db, { name: "Other experiment" });
    createTask(db, { experiment_id: selectedExperimentId, title: "Selected task", due_at: "2026-10-15" });
    createTask(db, { experiment_id: otherExperimentId, title: "Other task", due_at: "2026-10-16" });

    const events = listExperimentCalendarEvents(db, selectedExperimentId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.experimentId, selectedExperimentId);
    assert.match(String(events[0]?.title), /Selected task$/);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
