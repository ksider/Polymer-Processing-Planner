import express from "express";
import type { Db } from "../db.js";
import { ensureExperimentAccess } from "../middleware/experiment_access.js";
import { requireTaskManager, requireTaskOperator, requireTaskRead } from "../middleware/task_permissions.js";
import {
  createTask,
  createTaskAssignment,
  createTaskEntity,
  deleteTask,
  deleteTaskAssignment,
  deleteTaskEntity,
  getTaskEntity,
  type TaskEntityRow,
  type TaskStatus,
  getTask,
  listTaskAssignments,
  listTaskEntities,
  listTasksByExperiment,
  updateTask,
  updateTaskEntity
} from "../repos/tasks_repo.js";
import { computeTaskProgress, suggestTaskStatusWithRules, getDefaultEntityWeight } from "../services/tasks_service.js";
import { listTasksForUser } from "../repos/tasks_read_repo.js";
import { findUserById } from "../repos/users_repo.js";
import { listQualSummarySteps } from "../repos/qual_repo.js";
import { getQualificationSteps } from "../services/qualification_service.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { getDoeStudy } from "../repos/doe_repo.js";
import { getReportConfig } from "../repos/reports_repo.js";

export function createTasksRouter(db: Db) {
  const router = express.Router();

  // List tasks for experiment.
  router.get("/experiments/:id/tasks", requireTaskRead, ensureExperimentAccess(db), (req, res) => {
    const experimentId = Number(req.params.id);
    const summarySteps = new Set(listQualSummarySteps(db, experimentId));
    const tasks = listTasksByExperiment(db, experimentId).map((task) => {
      const entities = listTaskEntities(db, task.id);
      const hydrated: TaskEntityRow[] = entities.map((entity) => {
        if (entity.entity_type === "qualification_step") {
          if (summarySteps.has(entity.entity_id)) {
            return { ...entity, status: "done" as const };
          }
        }
        return entity;
      });
      const progress = computeTaskProgress(hydrated);
      const owner = task.owner_user_id ? findUserById(db, task.owner_user_id) : null;
      return {
        ...task,
        progress,
        owner_name: owner?.name ?? null,
        owner_email: owner?.email ?? null
      };
    });
    res.json({ tasks });
  });

  // Task details + entities for popup.
  router.get("/tasks/:id", requireTaskRead, (req, res) => {
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: "Invalid task" });
    const task = getTask(db, taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const entities = listTaskEntities(db, taskId).map((entity) => ({
      ...entity,
      display_label: getEntityLabel(db, entity.entity_type, entity.entity_id)
    }));
    const summarySteps = new Set(listQualSummarySteps(db, task.experiment_id));
    const hydrated: TaskEntityRow[] = entities.map((entity) => {
      if (entity.entity_type === "qualification_step") {
        if (summarySteps.has(entity.entity_id)) {
          return { ...entity, status: "done" as const };
        }
      }
      return entity;
    });
    const progress = computeTaskProgress(hydrated);
    const suggestedStatus = suggestTaskStatusWithRules(hydrated, progress);
    const owner = task.owner_user_id ? findUserById(db, task.owner_user_id) : null;
    res.json({
      task,
      entities: hydrated,
      progress,
      suggestedStatus,
      owner_name: owner?.name ?? null,
      owner_email: owner?.email ?? null
    });
  });

  // List tasks for current user.
  router.get("/me/tasks", requireTaskRead, (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const tasks = listTasksForUser(db, req.user.id);
    res.json({ tasks });
  });

  // Create a new task.
  router.post("/experiments/:id/tasks", requireTaskManager, ensureExperimentAccess(db), (req, res) => {
    const experimentId = Number(req.params.id);
    const title = String(req.body?.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "Title required" });
    const description = req.body?.description ? String(req.body.description) : null;
    const ownerUserId = req.body?.owner_user_id ? Number(req.body.owner_user_id) : null;
    const dueAt = req.body?.due_at ? String(req.body.due_at) : null;
    const taskId = createTask(db, {
      experiment_id: experimentId,
      title,
      description,
      owner_user_id: Number.isFinite(ownerUserId) ? ownerUserId : null,
      due_at: dueAt
    });
    res.json({ id: taskId });
  });

  // Update task base fields.
  router.post("/tasks/:id", requireTaskManager, (req, res) => {
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: "Invalid task" });
    const updates: Record<string, unknown> = {};
    if (req.body?.title !== undefined) {
      updates.title = String(req.body.title);
    }
    if (req.body?.description !== undefined) {
      const rawDesc = String(req.body.description);
      updates.description = rawDesc.trim() ? rawDesc : null;
    }
    if (req.body?.status !== undefined) {
      const status = toTaskStatus(req.body.status);
      if (!status) return res.status(400).json({ error: "Invalid status" });
      updates.status = status;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "owner_user_id")) {
      const rawOwner = req.body?.owner_user_id;
      const ownerUserId = rawOwner === "" || rawOwner == null ? null : Number(rawOwner);
      updates.owner_user_id = Number.isFinite(ownerUserId) ? ownerUserId : null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "due_at")) {
      const rawDue = String(req.body?.due_at ?? "");
      updates.due_at = rawDue.trim() ? rawDue : null;
    }
    updateTask(db, taskId, updates);
    res.json({ ok: true });
  });

  // Update task status explicitly.
  router.post("/tasks/:id/status", requireTaskManager, (req, res) => {
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: "Invalid task" });
    const status = toTaskStatus(req.body?.status) ?? "init";
    updateTask(db, taskId, { status });
    res.json({ ok: true });
  });

  // Add entity to task.
  router.post("/tasks/:id/entities", requireTaskManager, (req, res) => {
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: "Invalid task" });
    const entityType = String(req.body?.entity_type ?? "");
    const entityId = Number(req.body?.entity_id);
    if (!entityType || !Number.isFinite(entityId)) {
      return res.status(400).json({ error: "Invalid entity" });
    }
    const weight = req.body?.weight ? Number(req.body.weight) : getDefaultEntityWeight(entityType, entityId);
    const progressMode = req.body?.progress_mode ? String(req.body.progress_mode) : "toggle";
    const signatureRequired = req.body?.signature_required ? 1 : 0;
    const entityIdCreated = createTaskEntity(db, {
      task_id: taskId,
      entity_type: entityType as "qualification_step" | "doe" | "report",
      entity_id: entityId,
      label: req.body?.label ? String(req.body.label) : null,
      weight,
      progress_mode: progressMode as "toggle" | "milestone",
      signature_required: signatureRequired
    });
    res.json({ id: entityIdCreated });
  });

  // Update entity progress or weight.
  router.post("/tasks/:id/entities/:entityId", requireTaskOperator, (req, res) => {
    const entityId = Number(req.params.entityId);
    if (!Number.isFinite(entityId)) return res.status(400).json({ error: "Invalid entity" });
    const updates: Record<string, unknown> = {};
    if (req.body?.status !== undefined) {
      const status = toTaskStatus(req.body.status);
      if (!status) return res.status(400).json({ error: "Invalid status" });
      updates.status = status;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "weight")) {
      const rawWeight = String(req.body?.weight ?? "").trim();
      if (rawWeight) {
        const weight = Number(rawWeight);
        if (!Number.isFinite(weight)) {
          return res.status(400).json({ error: "Invalid weight" });
        }
        updates.weight = weight;
      }
    }
    if (req.body?.progress_mode !== undefined) {
      updates.progress_mode = String(req.body.progress_mode);
    }
    if (Object.keys(updates).length === 0) {
      return res.json({ ok: true });
    }
    updateTaskEntity(db, entityId, updates);
    res.json({ ok: true });
  });

  // Remove entity.
  router.post("/tasks/:id/entities/:entityId/delete", requireTaskManager, (req, res) => {
    const entityId = Number(req.params.entityId);
    if (!Number.isFinite(entityId)) return res.status(400).json({ error: "Invalid entity" });
    deleteTaskEntity(db, entityId);
    res.json({ ok: true });
  });

  // Assign operator to task.
  router.post("/tasks/:id/assign", requireTaskManager, (req, res) => {
    const taskId = Number(req.params.id);
    const userId = Number(req.body?.user_id);
    if (!Number.isFinite(taskId) || !Number.isFinite(userId)) {
      return res.status(400).json({ error: "Invalid assignment" });
    }
    const assignmentId = createTaskAssignment(db, { task_id: taskId, user_id: userId, role: "operator" });
    res.json({ id: assignmentId });
  });

  router.post("/tasks/:id/assign/:assignmentId/delete", requireTaskManager, (req, res) => {
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isFinite(assignmentId)) return res.status(400).json({ error: "Invalid assignment" });
    deleteTaskAssignment(db, assignmentId);
    res.json({ ok: true });
  });

  // Sign report entity (manager/engineer).
  router.post("/tasks/:id/sign", requireTaskManager, (req, res) => {
    const entityId = Number(req.body?.entity_id);
    if (!Number.isFinite(entityId)) return res.status(400).json({ error: "Invalid entity" });
    const entity = getTaskEntity(db, entityId);
    if (!entity) return res.status(404).json({ error: "Entity not found" });
    if (entity.entity_type === "report") {
      const task = getTask(db, entity.task_id);
      const experiment = task ? getExperiment(db, task.experiment_id) : null;
      if (!experiment || !req.user?.id || experiment.owner_user_id !== req.user.id) {
        return res.status(403).json({ error: "Only experiment owner can sign report entities." });
      }
    }
    updateTaskEntity(db, entityId, {
      signature_required: 1,
      signature_user_id: req.user?.id ?? null,
      signature_at: new Date().toISOString()
    });
    res.json({ ok: true });
  });

  // Recompute status from linked entities (callable by UI).
  router.post("/tasks/:id/recompute", requireTaskManager, (req, res) => {
    const taskId = Number(req.params.id);
    const task = getTask(db, taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const entities = listTaskEntities(db, taskId);
    const progress = computeTaskProgress(entities);
    const status = suggestTaskStatusWithRules(entities, progress);
    updateTask(db, taskId, { status });
    res.json({ ok: true, progress, status });
  });

  // Delete task.
  router.post("/tasks/:id/delete", requireTaskManager, (req, res) => {
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: "Invalid task" });
    deleteTask(db, taskId);
    res.json({ ok: true });
  });

  // Calendar endpoints (placeholders for now).
  router.get("/tasks/:id/calendar.ics", requireTaskRead, (req, res) => {
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).send("Invalid task");
    const task = getTask(db, taskId);
    if (!task) return res.status(404).send("Task not found");
    if (!task.due_at) return res.status(400).send("Task has no due date");
    const experiment = getExperiment(db, task.experiment_id);
    const date = parseDate(task.due_at);
    if (!date) return res.status(400).send("Invalid due date");
    const start = formatDateForCalendar(date);
    const end = formatDateForCalendar(addDays(date, 1));
    const summary = experiment ? `${task.title} · ${experiment.name}` : task.title;
    const description = [task.description, experiment ? `Experiment: ${experiment.name}` : null]
      .filter(Boolean)
      .join("\\n");
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//IM Planner//EN",
      "BEGIN:VEVENT",
      `UID:task-${task.id}@im-planner`,
      `DTSTAMP:${formatDateTimeUTC(new Date())}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"task-${task.id}.ics\"`);
    res.send(ics);
  });

  router.get("/tasks/:id/calendar/google", requireTaskRead, (req, res) => {
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).send("Invalid task");
    const task = getTask(db, taskId);
    if (!task) return res.status(404).send("Task not found");
    if (!task.due_at) return res.status(400).send("Task has no due date");
    const experiment = getExperiment(db, task.experiment_id);
    const date = parseDate(task.due_at);
    if (!date) return res.status(400).send("Invalid due date");
    const start = formatDateForCalendar(date);
    const end = formatDateForCalendar(addDays(date, 1));
    const summary = experiment ? `${task.title} · ${experiment.name}` : task.title;
    const details = [task.description, experiment ? `Experiment: ${experiment.name}` : null]
      .filter(Boolean)
      .join("\n");
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: summary,
      details,
      dates: `${start}/${end}`
    });
    res.redirect(`https://calendar.google.com/calendar/render?${params.toString()}`);
  });

  return router;
}

const qualificationStepLabels = new Map(
  getQualificationSteps().map((step) => [step.step_number, step.name])
);

function toTaskStatus(raw: unknown): TaskStatus | null {
  const value = String(raw ?? "").trim();
  if (value === "init" || value === "in_progress" || value === "done" || value === "failed") {
    return value;
  }
  return null;
}

function getEntityLabel(db: Db, type: string, id: number): string {
  if (type === "qualification_step") {
    const name = qualificationStepLabels.get(id);
    return name ? `Step ${id}: ${name}` : `Step ${id}`;
  }
  if (type === "doe") {
    const doe = getDoeStudy(db, id);
    return doe?.name ?? `DOE #${id}`;
  }
  if (type === "report") {
    const report = getReportConfig(db, id);
    return report?.name ?? `Report #${id}`;
  }
  return `${type} #${id}`;
}

function parseDate(raw: string): { year: number; month: number; day: number } | null {
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { year, month, day };
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(date: { year: number; month: number; day: number }, delta: number) {
  const base = new Date(Date.UTC(date.year, date.month - 1, date.day));
  base.setUTCDate(base.getUTCDate() + delta);
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate()
  };
}

function formatDateForCalendar(date: { year: number; month: number; day: number }) {
  const y = String(date.year).padStart(4, "0");
  const m = String(date.month).padStart(2, "0");
  const d = String(date.day).padStart(2, "0");
  return `${y}${m}${d}`;
}

function formatDateTimeUTC(date: Date) {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

function escapeIcsText(value: string) {
  return String(value ?? "")
    .replace(/\\\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
