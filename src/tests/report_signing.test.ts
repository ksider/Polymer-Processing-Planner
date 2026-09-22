import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import bcrypt from "bcryptjs";
import request from "supertest";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import { createReportConfig } from "../repos/reports_repo.js";
import { createDoeStudy } from "../repos/doe_repo.js";
import { upsertParamConfig } from "../repos/params_repo.js";
import { insertAnalysisField, listActiveAnalysisFields } from "../repos/analysis_repo.js";
import { insertRuns } from "../repos/runs_repo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-report-sign-"));
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

test("only experiment owner can sign report", async () => {
  const { createApp } = await import("../app.js");
  const app = createApp();
  const db = openDb();

  const ownerUserId = createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: bcrypt.hashSync("OwnerPass123!", 12),
    role: "engineer",
    status: "ACTIVE",
    tempPassword: 0
  });
  const otherUserId = createUser(db, {
    email: "other@example.com",
    name: "Other",
    passwordHash: bcrypt.hashSync("OtherPass123!", 12),
    role: "engineer",
    status: "ACTIVE",
    tempPassword: 0
  });
  assert.ok(ownerUserId > 0);
  assert.ok(otherUserId > 0);
  const managerUserId = createUser(db, {
    email: "manager@example.com",
    name: "Manager",
    passwordHash: bcrypt.hashSync("ManagerPass123!", 12),
    role: "manager",
    status: "ACTIVE",
    tempPassword: 0
  });
  assert.ok(managerUserId > 0);

  const experimentId = createExperimentWithDefaults(db, {
    name: "Owner sign test",
    owner_user_id: ownerUserId
  });
  const reportId = createReportConfig(db, {
    experiment_id: experimentId,
    name: "Report A",
    executors: null,
    include_json: "[]",
    doe_ids_json: "[]"
  });

  const factorAId = Number(db.prepare(
    `INSERT INTO param_definitions
     (scope, experiment_id, code, label, unit, field_kind, field_type, group_label, allowed_values_json)
     VALUES ('EXPERIMENT', ?, 'factor_a', 'Factor A', '°C', 'INPUT', 'number', NULL, NULL)`
  ).run(experimentId).lastInsertRowid);
  const outputId = Number(db.prepare(
    `INSERT INTO param_definitions
     (scope, experiment_id, code, label, unit, field_kind, field_type, group_label, allowed_values_json)
     VALUES ('EXPERIMENT', ?, 'quality', 'Quality', '%', 'OUTPUT', 'number', NULL, NULL)`
  ).run(experimentId).lastInsertRowid);
  const doeId = createDoeStudy(db, {
    experiment_id: experimentId,
    name: "Report DOE",
    design_type: "FULL_FACTORIAL",
    seed: 42,
    center_points: 0,
    max_runs: 20,
    replicate_count: 1,
    recipe_as_block: 0
  });
  upsertParamConfig(db, {
    experiment_id: experimentId,
    doe_id: doeId,
    param_def_id: factorAId,
    active: 1,
    mode: "LIST",
    fixed_value_real: null,
    range_min_real: null,
    range_max_real: null,
    list_json: "[10,20,30]",
    level_count: 3
  });
  insertAnalysisField(db, {
    scope_type: "DOE",
    scope_id: doeId,
    code: "quality",
    label: "Quality",
    field_type: "number",
    unit: "%",
    group_label: null,
    allowed_values_json: null,
    is_standard: 0,
    is_active: 1
  });
  insertRuns(
    db,
    experimentId,
    doeId,
    [10, 20, 30].map((factor, index) => ({
      run_order: index + 1,
      run_code: `DOE-${String(index + 1).padStart(3, "0")}`,
      recipe_id: null,
      replicate_key: null,
      replicate_index: null,
      owner_user_id: ownerUserId,
      done: 1,
      exclude_from_analysis: 0
    })),
    [10, 20, 30].flatMap((factor, index) => [
      { run_id: index + 1, param_def_id: factorAId, value_real: factor, value_text: null, value_tags_json: null },
      { run_id: index + 1, param_def_id: outputId, value_real: factor / 2, value_text: null, value_tags_json: null }
    ])
  );
  const qualityField = listActiveAnalysisFields(db, doeId).find((field) => field.code === "quality");
  assert.ok(qualityField);

  const ownerAgent = request.agent(app);
  const ownerLoginCsrf = await getCsrfToken(ownerAgent, "/auth/login");
  await ownerAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "owner@example.com", password: "OwnerPass123!", _csrf: ownerLoginCsrf })
    .expect(302);

  const managerAgent = request.agent(app);
  const managerLoginCsrf = await getCsrfToken(managerAgent, "/auth/login");
  await managerAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "manager@example.com", password: "ManagerPass123!", _csrf: managerLoginCsrf })
    .expect(302);

  db.prepare("UPDATE experiments SET notes = ? WHERE id = ?")
    .run("Source description from the experiment.", experimentId);
  const createReportCsrf = await getCsrfToken(ownerAgent, `/reports/${reportId}`);
  const createResponse = await ownerAgent
    .post(`/experiments/${experimentId}/reports`)
    .type("form")
    .send({ name: "Blank workspace", _csrf: createReportCsrf })
    .expect(200);
  const draftReportId = Number(createResponse.body.id);
  assert.ok(Number.isFinite(draftReportId));
  assert.equal(createResponse.body.url, `/reports/${draftReportId}`);
  const initialReportDescription = db.prepare("SELECT description FROM report_configs WHERE id = ?")
    .get(draftReportId) as { description: string | null };
  assert.equal(initialReportDescription.description, "Source description from the experiment.");

  const draftDocument = db
    .prepare("SELECT content_json, html_snapshot FROM report_documents WHERE report_id = ?")
    .get(draftReportId) as { content_json: string; html_snapshot: string | null } | undefined;
  const outline = JSON.parse(draftDocument?.content_json ?? "null") as {
    type?: string;
    content?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
  };
  assert.equal(outline.type, "doc");
  assert.equal(outline.content?.[0]?.content?.[0]?.text, "1. Objective");
  assert.equal(outline.content?.[3]?.content?.[0]?.text, "Machine");
  assert.equal(draftDocument?.html_snapshot, null);

  const setupCsrf = await getCsrfToken(managerAgent, `/reports/${draftReportId}`);
  await managerAgent
    .post(`/reports/${draftReportId}/setup`)
    .type("form")
    .send({
      name: "Configured workspace report",
      report_number: "RPT-2026-TEST",
      report_type: "COMBINED",
      signature_sla_days: 2,
      description: "Release-ready report for the owner sign test.",
      author_user_id: ownerUserId,
      responsible_user_id: otherUserId,
      due_at: "2026-10-15",
      _csrf: setupCsrf
    })
    .expect(302)
    .expect("Location", `/reports/${draftReportId}`);
  const configuredReport = db.prepare(
    "SELECT name, report_number, report_type, signature_sla_days, description, author_user_id, responsible_user_id, due_at FROM report_configs WHERE id = ?"
  ).get(draftReportId) as {
    name: string;
    report_number: string | null;
    report_type: string;
    signature_sla_days: number;
    description: string | null;
    author_user_id: number | null;
    responsible_user_id: number | null;
    due_at: string | null;
  };
  assert.equal(configuredReport.name, "Configured workspace report");
  assert.equal(configuredReport.report_number, "RPT-2026-TEST");
  assert.equal(configuredReport.report_type, "COMBINED");
  assert.equal(configuredReport.signature_sla_days, 2);
  assert.equal(configuredReport.description, "Release-ready report for the owner sign test.");
  assert.equal(configuredReport.author_user_id, ownerUserId);
  assert.equal(configuredReport.responsible_user_id, otherUserId);
  assert.equal(configuredReport.due_at, "2026-10-15");

  const authorSetupCsrf = await getCsrfToken(ownerAgent, `/reports/${draftReportId}`);
  await ownerAgent
    .post(`/reports/${draftReportId}/setup`)
    .type("form")
    .send({
      name: "Configured workspace report",
      description: "Release-ready report for the owner sign test.",
      author_user_id: otherUserId,
      responsible_user_id: ownerUserId,
      report_number: "SHOULD-NOT-CHANGE",
      report_type: "DOE",
      due_at: "2026-01-01",
      signature_sla_days: 30,
      _csrf: authorSetupCsrf
    })
    .expect(302);
  const afterAuthorEdit = db.prepare(
    "SELECT author_user_id, responsible_user_id, report_number, report_type, due_at, signature_sla_days FROM report_configs WHERE id = ?"
  ).get(draftReportId) as {
    author_user_id: number | null;
    responsible_user_id: number | null;
    report_number: string | null;
    report_type: string;
    due_at: string | null;
    signature_sla_days: number;
  };
  assert.equal(afterAuthorEdit.author_user_id, ownerUserId);
  assert.equal(afterAuthorEdit.responsible_user_id, otherUserId);
  assert.equal(afterAuthorEdit.report_number, "RPT-2026-TEST");
  assert.equal(afterAuthorEdit.report_type, "COMBINED");
  assert.equal(afterAuthorEdit.due_at, "2026-10-15");
  assert.equal(afterAuthorEdit.signature_sla_days, 2);

  const reportAssignmentTask = db.prepare(
    `SELECT ea.assignee_user_id, ea.status as assignment_status,
            t.id as task_id, t.title, t.description, t.owner_user_id, t.due_at,
            te.entity_type, te.entity_id, te.status as entity_status, te.signature_required
     FROM entity_assignments ea
     JOIN assignment_tasks assignment_task_link ON assignment_task_link.assignment_id = ea.id
     JOIN tasks t ON t.id = assignment_task_link.task_id
     JOIN task_entities te ON te.task_id = t.id
     WHERE ea.entity_type = 'report' AND ea.entity_id = ?`
  ).get(draftReportId) as {
    assignee_user_id: number;
    assignment_status: string;
    task_id: number;
    title: string;
    description: string | null;
    owner_user_id: number | null;
    due_at: string | null;
    entity_type: string;
    entity_id: number;
    entity_status: string;
    signature_required: number;
  };
  assert.equal(reportAssignmentTask.assignee_user_id, ownerUserId);
  assert.equal(reportAssignmentTask.assignment_status, "active");
  assert.equal(reportAssignmentTask.title, "Write report: Configured workspace report");
  assert.equal(reportAssignmentTask.description, "Release-ready report for the owner sign test.");
  assert.equal(reportAssignmentTask.owner_user_id, ownerUserId);
  assert.equal(reportAssignmentTask.due_at, "2026-10-15");
  assert.equal(reportAssignmentTask.entity_type, "report");
  assert.equal(reportAssignmentTask.entity_id, draftReportId);
  assert.equal(reportAssignmentTask.entity_status, "init");
  assert.equal(reportAssignmentTask.signature_required, 1);

  const experimentTasks = await ownerAgent.get(`/experiments/${experimentId}/tasks`).expect(200);
  assert.ok(experimentTasks.body.tasks.some((task: { id: number }) => task.id === reportAssignmentTask.task_id));

  const otherAgent = request.agent(app);
  const otherLoginCsrf = await getCsrfToken(otherAgent, "/auth/login");
  await otherAgent
    .post("/auth/login")
    .type("form")
    .send({ email: "other@example.com", password: "OtherPass123!", _csrf: otherLoginCsrf })
    .expect(302);
  const beforeSubmissionTasks = await otherAgent.get("/me/tasks").expect(200);
  assert.ok(!beforeSubmissionTasks.body.tasks.some((task: { task_id: number }) => task.task_id === reportAssignmentTask.task_id));
  await otherAgent.get(`/reports/${draftReportId}`).expect(403);

  const reportSetup = await ownerAgent.get(`/reports/${draftReportId}`).expect(200);
  assert.match(reportSetup.text, /Report setup/);
  assert.match(reportSetup.text, /Configured workspace report/);
  assert.match(reportSetup.text, /Release-ready report/);
  const workspace = await ownerAgent.get(`/reports/${draftReportId}/editor`).expect(200);
  assert.match(workspace.text, /report-workspace/);
  assert.match(workspace.text, /Research data/);
  assert.match(workspace.text, /sourcePreviewDialog/);
  assert.match(workspace.text, /doeAnalysisDialog/);
  assert.match(workspace.text, /Report DOE/);

  const submitCsrf = await getCsrfToken(ownerAgent, `/reports/${draftReportId}`);
  await ownerAgent
    .post(`/reports/${draftReportId}/submit-for-signature`)
    .type("form")
    .send({ _csrf: submitCsrf })
    .expect(302)
    .expect("Location", `/reports/${draftReportId}`);
  const submittedReport = db.prepare(
    "SELECT submitted_for_signature_at, submitted_by_user_id, signature_due_at FROM report_configs WHERE id = ?"
  ).get(draftReportId) as { submitted_for_signature_at: string | null; submitted_by_user_id: number | null; signature_due_at: string | null };
  assert.ok(submittedReport.submitted_for_signature_at);
  assert.equal(submittedReport.submitted_by_user_id, ownerUserId);
  assert.match(String(submittedReport.signature_due_at), /^\d{4}-\d{2}-\d{2}$/);
  const signerNotification = db.prepare(
    `SELECT n.type, n.title, n.message_id, m.id AS linked_message_id
     FROM notifications n
     JOIN messages m ON m.id = n.message_id
     WHERE n.user_id = ?
       AND n.type = 'assignment'
       AND n.title = ?
     ORDER BY n.id DESC
     LIMIT 1`
  ).get(otherUserId, "You were assigned to Report: Configured workspace report") as {
    type: string;
    title: string;
    message_id: number | null;
    linked_message_id: number;
  } | undefined;
  assert.ok(signerNotification, "report assignment should also appear in Notifications");
  assert.equal(signerNotification.message_id, signerNotification.linked_message_id);
  const unreadNotifications = await otherAgent.get("/me/notifications/unread.json").expect(200);
  const reportNotification = unreadNotifications.body.items.find((item: { id: number; title: string }) => (
    item.title === "You were assigned to Report: Configured workspace report"
  ));
  assert.ok(reportNotification, "top-bar notification feed should include the report assignment");
  const notificationReadCsrf = await getCsrfToken(otherAgent, "/me");
  await otherAgent
    .post(`/me/notifications/${reportNotification.id}/read.json`)
    .type("form")
    .send({ _csrf: notificationReadCsrf })
    .expect(200);
  const markedRead = db.prepare("SELECT status FROM notifications WHERE id = ?").get(reportNotification.id) as { status: string };
  assert.equal(markedRead.status, "read");
  const messenger = await otherAgent.get("/messages?view=chat").expect(200);
  assert.match(messenger.text, /You were assigned to Report: Configured workspace report/);
  const signerMessageBox = db.prepare(
    `SELECT mb.id
     FROM message_boxes mb
     JOIN messages m ON m.id = mb.message_id
     WHERE mb.user_id = ?
       AND m.subject = ?
     ORDER BY mb.id DESC
     LIMIT 1`
  ).get(otherUserId, "You were assigned to Report: Configured workspace report") as { id: number };
  assert.match(messenger.text, new RegExp(`href="/messages/${signerMessageBox.id}/open"`));
  await otherAgent
    .get(`/messages/${signerMessageBox.id}/open`)
    .expect(302)
    .expect("Location", `/reports/${draftReportId}`);
  const openedMessage = db.prepare("SELECT status FROM message_boxes WHERE id = ?").get(signerMessageBox.id) as { status: string };
  assert.equal(openedMessage.status, "read");
  const signerTask = db.prepare("SELECT title, owner_user_id, due_at FROM tasks WHERE id = ?")
    .get(reportAssignmentTask.task_id) as { title: string; owner_user_id: number | null; due_at: string | null };
  assert.equal(signerTask.title, "Sign report: Configured workspace report");
  assert.equal(signerTask.owner_user_id, otherUserId);
  assert.equal(signerTask.due_at, submittedReport.signature_due_at);
  const otherTasks = await otherAgent.get("/me/tasks").expect(200);
  assert.ok(otherTasks.body.tasks.some((task: { task_id: number; due_at: string | null }) => (
    task.task_id === reportAssignmentTask.task_id && task.due_at === submittedReport.signature_due_at
  )));
  await otherAgent.get(`/reports/${draftReportId}`).expect(200);

  const draftSignCsrf = await getCsrfToken(otherAgent, `/reports/${draftReportId}`);
  await otherAgent
    .post(`/reports/${draftReportId}/sign`)
    .type("form")
    .send({ _csrf: draftSignCsrf })
    .expect(302);
  const completedReportTask = db.prepare(
    `SELECT t.status as task_status, te.status as entity_status, te.signature_user_id, te.signature_at
     FROM tasks t
     JOIN task_entities te ON te.task_id = t.id
     WHERE t.id = ? AND te.entity_type = 'report' AND te.entity_id = ?`
  ).get(reportAssignmentTask.task_id, draftReportId) as {
    task_status: string;
    entity_status: string;
    signature_user_id: number | null;
    signature_at: string | null;
  };
  assert.equal(completedReportTask.task_status, "done");
  assert.equal(completedReportTask.entity_status, "done");
  assert.equal(completedReportTask.signature_user_id, otherUserId);
  assert.ok(completedReportTask.signature_at);

  const binaryParser = (response: any, callback: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => callback(null, Buffer.concat(chunks)));
    response.on("error", (error: Error) => callback(error, Buffer.alloc(0)));
  };
  const docxExport = await ownerAgent
    .get(`/reports/${draftReportId}/export.docx`)
    .buffer(true)
    .parse(binaryParser)
    .expect(200)
    .expect("Content-Type", /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  const docxBytes = docxExport.body as Buffer;
  assert.equal(docxBytes.subarray(0, 2).toString("utf8"), "PK");
  assert.match(String(docxExport.headers["content-disposition"]), /report-\d+\.docx/);

  const analysisResponse = await ownerAgent
    .get(`/reports/${reportId}/sources/doe/${doeId}/analysis?mode=factor&output=${qualityField.id}&factor=${factorAId}`)
    .expect(200);
  assert.equal(analysisResponse.body.study.name, "Report DOE");
  assert.equal(analysisResponse.body.analysis.chart.type, "line");
  assert.equal(analysisResponse.body.analysis.rows.length, 3);

  const runsResponse = await ownerAgent
    .get(`/reports/${reportId}/sources/doe/${doeId}/runs?page=1&page_size=10`)
    .expect(200);
  assert.equal(runsResponse.body.total, 3);
  assert.equal(runsResponse.body.runs[0].responsible, "Owner");
  assert.equal(runsResponse.body.runs[0].values[`input-${factorAId}`], "10 °C");
  assert.equal(runsResponse.body.runs[0].values[`analysis-${qualityField.id}`], "5 %");

  await ownerAgent
    .post(`/reports/${reportId}/sign`)
    .type("form")
    .send({ _csrf: createReportCsrf })
    .expect(302)
    .expect("Location", `/reports/${reportId}`);

  const signed = db
    .prepare("SELECT signed_at, signed_by_user_id FROM report_configs WHERE id = ?")
    .get(reportId) as { signed_at: string | null; signed_by_user_id: number | null };
  assert.ok(signed.signed_at, "signed_at should be set by owner");
  assert.equal(signed.signed_by_user_id, ownerUserId);

  db.prepare("UPDATE report_configs SET signed_at = NULL, signed_by_user_id = NULL WHERE id = ?").run(reportId);

  const otherSignCsrf = await getCsrfToken(otherAgent, "/");
  await otherAgent
    .post(`/reports/${reportId}/sign`)
    .type("form")
    .send({ _csrf: otherSignCsrf })
    .expect(403);

  const afterOtherAttempt = db
    .prepare("SELECT signed_at, signed_by_user_id FROM report_configs WHERE id = ?")
    .get(reportId) as { signed_at: string | null; signed_by_user_id: number | null };
  assert.equal(afterOtherAttempt.signed_at, null);
  assert.equal(afterOtherAttempt.signed_by_user_id, null);
});
