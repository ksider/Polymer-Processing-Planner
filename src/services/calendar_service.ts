import type { Db } from "../db.js";
import { getProcessRouteCode } from "../repos/processes_repo.js";
import { getEntityColor } from "./entity_colors.js";
import { getTask, updateTask } from "../repos/tasks_repo.js";
import { getRun, updateRunSchedule } from "../repos/runs_repo.js";
import { getQualRun, updateQualRunDueAt } from "../repos/qual_repo.js";

export type CalendarScope = "my" | "process";

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  allDay: boolean;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  url: string;
  entityType: "task" | "run" | "qual_run";
  entityId: number;
  processId: number | null;
  experimentId: number;
  classNames?: string[];
  extendedProps: {
    kind: "task" | "run" | "qual_run";
    kindLabel: string;
    status: string;
    isDone: boolean;
    ownerLabel: string;
    entityLabel: string;
    entityUrl: string;
    detailUrl: string;
    processName: string | null;
    experimentName: string;
  };
};

type EventRow = {
  id: number;
  title: string;
  due_at: string;
  process_id: number | null;
  process_name: string | null;
  process_route_code: string | null;
  process_type_code: string | null;
  experiment_id: number;
  experiment_name: string;
  owner_name: string | null;
  owner_email: string | null;
  is_done: number;
  status: string | null;
};

function hexToRgba(hex: string, alpha: number): string {
  const value = String(hex || "").trim().replace("#", "");
  const full = value.length === 3
    ? `${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}`
    : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return `rgba(127,127,127,${alpha})`;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resolveOwnerLabel(row: EventRow): string {
  const name = String(row.owner_name || "").trim();
  const email = String(row.owner_email || "").trim();
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  return "Unassigned";
}

function withVisualColors(
  baseHex: string,
  isDone: boolean
): Pick<CalendarEvent, "backgroundColor" | "borderColor" | "textColor" | "classNames"> {
  const openAlpha = 0.4;
  const doneAlpha = 0.84;
  const borderOpen = 0.58;
  const borderDone = 0.96;
  return {
    backgroundColor: hexToRgba(baseHex, isDone ? doneAlpha : openAlpha),
    borderColor: hexToRgba(baseHex, isDone ? borderDone : borderOpen),
    textColor: "#1f1f1f",
    classNames: [isDone ? "calendar-event-done" : "calendar-event-open"]
  };
}

function normalizeDateOnly(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function buildExperimentPath(row: Pick<EventRow, "process_route_code" | "process_type_code" | "experiment_id">): string {
  const processCode = getProcessRouteCode({
    route_code: row.process_route_code,
    process_type_code: row.process_type_code ?? undefined
  });
  return processCode ? `/${processCode}/${row.experiment_id}` : `/experiments/${row.experiment_id}`;
}

function toTaskEvent(row: EventRow): CalendarEvent {
  const isDone = row.status === "done";
  const base = buildExperimentPath(row);
  const detailUrl = `${base}#task-${row.id}`;
  const entityUrl = base;
  const visual = withVisualColors(getEntityColor("task"), isDone);
  return {
    id: `task-${row.id}`,
    title: `${row.experiment_name} | Task | ${row.title}`,
    start: row.due_at,
    allDay: true,
    backgroundColor: visual.backgroundColor,
    borderColor: visual.borderColor,
    textColor: visual.textColor,
    classNames: visual.classNames,
    url: detailUrl,
    entityType: "task",
    entityId: row.id,
    processId: row.process_id ?? null,
    experimentId: row.experiment_id,
    extendedProps: {
      kind: "task",
      kindLabel: "Task",
      status: row.status || "init",
      isDone,
      ownerLabel: resolveOwnerLabel(row),
      entityLabel: row.experiment_name,
      entityUrl,
      detailUrl,
      processName: row.process_name,
      experimentName: row.experiment_name
    }
  };
}

function toRunEvent(row: EventRow): CalendarEvent {
  const isDone = row.is_done === 1;
  const base = buildExperimentPath(row);
  const detailUrl = `${base}/runs/${row.id}`;
  const entityUrl = base;
  const visual = withVisualColors(getEntityColor("doe"), isDone);
  return {
    id: `run-${row.id}`,
    title: `${row.experiment_name} | DOE | ${row.title.replace(/^Run\s+/i, "")}`,
    start: row.due_at,
    allDay: true,
    backgroundColor: visual.backgroundColor,
    borderColor: visual.borderColor,
    textColor: visual.textColor,
    classNames: visual.classNames,
    url: detailUrl,
    entityType: "run",
    entityId: row.id,
    processId: row.process_id ?? null,
    experimentId: row.experiment_id,
    extendedProps: {
      kind: "run",
      kindLabel: "DOE run",
      status: isDone ? "done" : "in_progress",
      isDone,
      ownerLabel: resolveOwnerLabel(row),
      entityLabel: row.experiment_name,
      entityUrl,
      detailUrl,
      processName: row.process_name,
      experimentName: row.experiment_name
    }
  };
}

function toQualRunEvent(
  row: EventRow & { step_number: number }
): CalendarEvent {
  const isDone = row.is_done === 1;
  const detailUrl = `/qual-runs/${row.id}`;
  const entityUrl = buildExperimentPath(row);
  const visual = withVisualColors(getEntityColor("qualification_step"), isDone);
  return {
    id: `qual-run-${row.id}`,
    title: `${row.experiment_name} | Q${row.step_number} | ${row.title}`,
    start: row.due_at,
    allDay: true,
    backgroundColor: visual.backgroundColor,
    borderColor: visual.borderColor,
    textColor: visual.textColor,
    classNames: visual.classNames,
    url: detailUrl,
    entityType: "qual_run",
    entityId: row.id,
    processId: row.process_id ?? null,
    experimentId: row.experiment_id,
    extendedProps: {
      kind: "qual_run",
      kindLabel: "Qualification run",
      status: isDone ? "done" : "in_progress",
      isDone,
      ownerLabel: resolveOwnerLabel(row),
      entityLabel: `${row.experiment_name} | Q${row.step_number}`,
      entityUrl,
      detailUrl,
      processName: row.process_name,
      experimentName: row.experiment_name
    }
  };
}

function loadTaskEventsByWhere(
  db: Db,
  whereSql: string,
  args: unknown[]
): CalendarEvent[] {
  const sql = `
    SELECT DISTINCT
      t.id,
      t.title,
      t.due_at,
      e.process_id,
      p.name as process_name,
      p.route_code as process_route_code,
      pt.code as process_type_code,
      e.id as experiment_id,
      e.name as experiment_name,
      u.name as owner_name,
      u.email as owner_email,
      0 as is_done,
      t.status as status
    FROM tasks t
    JOIN experiments e ON e.id = t.experiment_id
    LEFT JOIN processes p ON p.id = e.process_id
    LEFT JOIN process_types pt ON pt.id = p.process_type_id
    LEFT JOIN users u ON u.id = t.owner_user_id
    ${whereSql}
    ORDER BY t.due_at ASC, t.id ASC
  `;
  const rows = db.prepare(sql).all(...args) as EventRow[];
  return rows
    .filter((row) => normalizeDateOnly(row.due_at))
    .map((row) => toTaskEvent({ ...row, due_at: normalizeDateOnly(row.due_at) as string }));
}

function loadRunEventsByWhere(
  db: Db,
  whereSql: string,
  args: unknown[]
): CalendarEvent[] {
  const sql = `
    SELECT
      r.id,
      ('Run ' || r.run_code) as title,
      r.due_at,
      e.process_id,
      p.name as process_name,
      p.route_code as process_route_code,
      pt.code as process_type_code,
      e.id as experiment_id,
      e.name as experiment_name,
      u.name as owner_name,
      u.email as owner_email,
      r.done as is_done,
      NULL as status
    FROM runs r
    JOIN experiments e ON e.id = r.experiment_id
    LEFT JOIN processes p ON p.id = e.process_id
    LEFT JOIN process_types pt ON pt.id = p.process_type_id
    LEFT JOIN users u ON u.id = r.owner_user_id
    ${whereSql}
    ORDER BY r.due_at ASC, r.id ASC
  `;
  const rows = db.prepare(sql).all(...args) as EventRow[];
  return rows
    .filter((row) => normalizeDateOnly(row.due_at))
    .map((row) => toRunEvent({ ...row, due_at: normalizeDateOnly(row.due_at) as string }));
}

function loadQualRunEventsByWhere(
  db: Db,
  whereSql: string,
  args: unknown[]
): CalendarEvent[] {
  const sql = `
    SELECT
      qr.id,
      qr.run_code as title,
      qr.due_at,
      qs.step_number,
      e.process_id,
      p.name as process_name,
      p.route_code as process_route_code,
      pt.code as process_type_code,
      e.id as experiment_id,
      e.name as experiment_name,
      u.name as owner_name,
      u.email as owner_email,
      qr.done as is_done,
      NULL as status
    FROM qual_runs qr
    JOIN qual_steps qs ON qs.id = qr.step_id
    JOIN experiments e ON e.id = qr.experiment_id
    LEFT JOIN processes p ON p.id = e.process_id
    LEFT JOIN process_types pt ON pt.id = p.process_type_id
    LEFT JOIN users u ON u.id = e.owner_user_id
    ${whereSql}
    ORDER BY qr.due_at ASC, qr.id ASC
  `;
  const rows = db.prepare(sql).all(...args) as Array<EventRow & { step_number: number }>;
  return rows
    .filter((row) => normalizeDateOnly(row.due_at))
    .map((row) => toQualRunEvent({ ...row, due_at: normalizeDateOnly(row.due_at) as string }));
}

export function listMyCalendarEvents(db: Db, userId: number): CalendarEvent[] {
  const taskEvents = loadTaskEventsByWhere(
    db,
    `
    LEFT JOIN task_assignments ta ON ta.task_id = t.id AND ta.user_id = ?
    WHERE e.archived_at IS NULL
      AND t.due_at IS NOT NULL
      AND (t.owner_user_id = ? OR ta.user_id = ?)
    `,
    [userId, userId, userId]
  );
  const runEvents = loadRunEventsByWhere(
    db,
    `
    WHERE e.archived_at IS NULL
      AND r.due_at IS NOT NULL
      AND r.owner_user_id = ?
    `,
    [userId]
  );
  const qualRunEvents = loadQualRunEventsByWhere(
    db,
    `
    LEFT JOIN entity_assignments ea ON ea.entity_type = 'qualification_step' AND ea.entity_id = qs.id AND ea.status = 'active'
    WHERE e.archived_at IS NULL
      AND qr.due_at IS NOT NULL
      AND (e.owner_user_id = ? OR ea.assignee_user_id = ?)
    `,
    [userId, userId]
  );
  return [...taskEvents, ...runEvents, ...qualRunEvents];
}

export function listProcessCalendarEvents(
  db: Db,
  processId: number,
  options?: { onlyVisibleExperimentIds?: number[] }
): CalendarEvent[] {
  const visibleExperimentIds = (options?.onlyVisibleExperimentIds || []).filter((id) => Number.isFinite(id));
  const filterSql = visibleExperimentIds.length
    ? ` AND e.id IN (${visibleExperimentIds.map(() => "?").join(",")})`
    : "";

  const taskEvents = loadTaskEventsByWhere(
    db,
    `
    WHERE e.archived_at IS NULL
      AND t.due_at IS NOT NULL
      AND e.process_id = ?
      ${filterSql}
    `,
    [processId, ...visibleExperimentIds]
  );
  const runEvents = loadRunEventsByWhere(
    db,
    `
    WHERE e.archived_at IS NULL
      AND r.due_at IS NOT NULL
      AND e.process_id = ?
      ${filterSql}
    `,
    [processId, ...visibleExperimentIds]
  );
  const qualRunEvents = loadQualRunEventsByWhere(
    db,
    `
    WHERE e.archived_at IS NULL
      AND qr.due_at IS NOT NULL
      AND e.process_id = ?
      ${filterSql}
    `,
    [processId, ...visibleExperimentIds]
  );
  return [...taskEvents, ...runEvents, ...qualRunEvents];
}

export function decodeCalendarEventToken(token: string): { entityType: "task" | "run" | "qual-run"; entityId: number } | null {
  const value = String(token || "").trim();
  const match = value.match(/^(task|run|qual-run)-(\d+)$/);
  if (!match) return null;
  const entityId = Number(match[2]);
  if (!Number.isFinite(entityId) || entityId <= 0) return null;
  return { entityType: match[1] as "task" | "run" | "qual-run", entityId };
}

export function moveCalendarEventDate(
  db: Db,
  eventToken: string,
  nextDateRaw: unknown
): { entityType: "task" | "run" | "qual-run"; entityId: number; due_at: string } | null {
  const decoded = decodeCalendarEventToken(eventToken);
  if (!decoded) return null;
  const nextDate = normalizeDateOnly(nextDateRaw);
  if (!nextDate) return null;

  if (decoded.entityType === "task") {
    const task = getTask(db, decoded.entityId);
    if (!task) return null;
    updateTask(db, task.id, { due_at: nextDate });
    return { entityType: "task", entityId: task.id, due_at: nextDate };
  }

  const run = getRun(db, decoded.entityId);
  if (decoded.entityType === "run") {
    if (!run) return null;
    updateRunSchedule(db, run.id, nextDate);
    return { entityType: "run", entityId: run.id, due_at: nextDate };
  }

  const qualRun = getQualRun(db, decoded.entityId);
  if (!qualRun) return null;
  updateQualRunDueAt(db, qualRun.id, nextDate);
  return { entityType: "qual-run", entityId: qualRun.id, due_at: nextDate };
}
