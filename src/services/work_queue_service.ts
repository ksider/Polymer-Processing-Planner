import type { Db } from "../db.js";
import { listWorkspaceExperimentScope, narrowWorkspaceScope } from "./workspace_scope_service.js";
import { isDemoUser } from "./demo_mode.js";

export type WorkItemType = "task" | "qualification" | "doe" | "report";

export type WorkItem = {
  id: string;
  sourceId: number;
  entityType: WorkItemType;
  title: string;
  experimentId: number;
  experimentName: string;
  processName: string | null;
  responsible: string;
  responsibleUserId: number | null;
  dueAt: string | null;
  execution: string;
  dataStatus: string | null;
  blocker: string | null;
  nextAction: string;
  attentionReason: string | null;
  scopeReason: string | null;
  href: string;
  isOverdue: boolean;
  urgency: "overdue" | "soon" | "normal";
  boardStatus: "init" | "in_progress" | "done" | "failed";
  actions: { view: boolean; changeStatus: boolean; moveCalendar: boolean };
};

export type WorkQueueFilters = {
  processId: number | null;
  experimentId: number | null;
  type: "all" | WorkItemType;
  scope: "mine" | "others" | "all";
  state: "all" | "open" | "blocked" | "overdue";
  responsibleUserId: number | null;
  query: string;
  page: number;
  pageSize: number;
};

function dateOnly(value: string | null | undefined): string | null {
  const date = String(value || "").slice(0, 10);
  return date || null;
}

function isOverdue(value: string | null | undefined, closed = false): boolean {
  const date = dateOnly(value);
  return Boolean(!closed && date && date < new Date().toISOString().slice(0, 10));
}

function urgencyFor(value: string | null | undefined, closed = false): WorkItem["urgency"] {
  if (isOverdue(value, closed)) return "overdue";
  const date = dateOnly(value);
  if (!closed && date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${date}T00:00:00`);
    if (Number.isFinite(due.getTime()) && due.getTime() - today.getTime() <= 3 * 86400000) return "soon";
  }
  return "normal";
}

function belongsToScope(scope: WorkQueueFilters["scope"], userId: number, ownerId?: number | null, assignedId?: number | null): boolean {
  if (scope === "all") return true;
  const mine = ownerId === userId || assignedId === userId;
  return scope === "mine" ? mine : !mine;
}

function taskActions(user: Express.User) {
  const canChangeStatus = !isDemoUser(user) && ["admin", "manager", "engineer"].includes(user.role || "");
  return { view: true, changeStatus: canChangeStatus, moveCalendar: canChangeStatus };
}

function taskNextAction(status: string, dueAt: string | null, overdue: boolean): string {
  if (overdue) return `Complete overdue task (due ${dueAt})`;
  if (status === "init") return "Start task";
  if (status === "in_progress") return "Continue task";
  if (status === "failed") return "Review failed task";
  return "View completed task";
}

function taskScopeReason(userId: number, ownerId?: number | null, assignedId?: number | null): string | null {
  if (ownerId === userId) return "You own this task";
  if (assignedId === userId) return "Assigned to you";
  return null;
}

function attentionReason(blocker: string | null, dueAt: string | null, overdue: boolean): string | null {
  const parts = [blocker ? `Blocked: ${blocker}` : null, overdue && dueAt ? `Deadline passed: ${dueAt}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const readOnlyActions = { view: true, changeStatus: false, moveCalendar: false } as const;

function sourceBoardStatus(value: string | null | undefined, fallback: "init" | "in_progress" | "done" = "init"): WorkItem["boardStatus"] {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("fail")) return "failed";
  if (normalized.includes("done") || normalized.includes("complete") || normalized.includes("signed")) return "done";
  if (normalized.includes("progress") || normalized.includes("pending")) return "in_progress";
  return fallback;
}

/** Read-only projection: source entities retain their own lifecycle and URLs. */
export function buildWorkQueue(db: Db, user: Express.User, filters: WorkQueueFilters) {
  const visibleScope = narrowWorkspaceScope(listWorkspaceExperimentScope(db, user), {
    processId: filters.processId,
    experimentId: filters.experimentId
  });
  const ids = visibleScope.experimentIds;
  const marks = ids.map(() => "?").join(",");
  const items: WorkItem[] = [];

  // Assignment-generated tasks deliberately do not appear here. Their source
  // qualification or DOE item below is the single queue item for that work.
  const taskRows = ids.length ? db.prepare(`
    SELECT t.id, t.title, t.experiment_id, t.status, t.due_at,
           e.name AS experiment_name, p.name AS process_name,
           COALESCE(NULLIF(u.name, ''), u.email, 'Unassigned') AS owner_label,
           t.owner_user_id,
           (SELECT ta.user_id FROM task_assignments ta WHERE ta.task_id = t.id AND ta.user_id = ? LIMIT 1) AS assigned_user_id
    FROM tasks t
    JOIN experiments e ON e.id = t.experiment_id
    LEFT JOIN processes p ON p.id = e.process_id
    LEFT JOIN users u ON u.id = t.owner_user_id
    WHERE t.experiment_id IN (${marks})
      AND NOT EXISTS (SELECT 1 FROM assignment_tasks generated WHERE generated.task_id = t.id)
  `).all(user.id, ...ids) as Array<any> : [];
  const seenTaskIds = new Set<number>();
  for (const row of taskRows) {
    if (!belongsToScope(filters.scope, user.id, row.owner_user_id, row.assigned_user_id)) continue;
    seenTaskIds.add(row.id);
    const closed = ["done", "failed"].includes(row.status);
    const dueAt = dateOnly(row.due_at);
    const overdue = isOverdue(row.due_at, closed);
    items.push({
      id: `task-${row.id}`, sourceId: row.id, entityType: "task", title: row.title,
      experimentId: row.experiment_id, experimentName: row.experiment_name, processName: row.process_name,
      responsible: row.owner_label, responsibleUserId: row.owner_user_id, dueAt, execution: row.status.replace(/_/g, " "),
      dataStatus: "Manual task", blocker: null,
      nextAction: taskNextAction(row.status, dueAt, overdue), attentionReason: attentionReason(null, dueAt, overdue), scopeReason: taskScopeReason(user.id, row.owner_user_id, row.assigned_user_id),
      href: `/experiments/${row.experiment_id}#task-${row.id}`,
      isOverdue: overdue,
      urgency: urgencyFor(row.due_at, closed),
      boardStatus: sourceBoardStatus(row.status), actions: taskActions(user)
    });
  }

  // A direct task assignment can grant task access without granting access to
  // the rest of its experiment. Keep it in My/All, but expose its details only
  // through the already access-checked task endpoint (the page uses its drawer).
  if (filters.scope !== "others") {
    const directWhere = ["ta.user_id = ?", "e.archived_at IS NULL", "NOT EXISTS (SELECT 1 FROM assignment_tasks generated WHERE generated.task_id = t.id)"];
    const directValues: Array<number> = [user.id];
    if (filters.processId) { directWhere.push("e.process_id = ?"); directValues.push(filters.processId); }
    if (filters.experimentId) { directWhere.push("t.experiment_id = ?"); directValues.push(filters.experimentId); }
    const directRows = db.prepare(`
      SELECT t.id, t.title, t.experiment_id, t.status, t.due_at,
             e.name AS experiment_name, p.name AS process_name,
             COALESCE(NULLIF(u.name, ''), u.email, 'Unassigned') AS owner_label,
             t.owner_user_id, ta.user_id AS assigned_user_id
      FROM tasks t
      JOIN task_assignments ta ON ta.task_id = t.id
      JOIN experiments e ON e.id = t.experiment_id
      LEFT JOIN processes p ON p.id = e.process_id
      LEFT JOIN users u ON u.id = t.owner_user_id
      WHERE ${directWhere.join(" AND ")}
    `).all(...directValues) as Array<any>;
    for (const row of directRows) {
      if (seenTaskIds.has(row.id)) continue;
      const closed = ["done", "failed"].includes(row.status);
      const dueAt = dateOnly(row.due_at);
      const overdue = isOverdue(row.due_at, closed);
      items.push({
        id: `task-${row.id}`, sourceId: row.id, entityType: "task", title: row.title,
        experimentId: row.experiment_id, experimentName: row.experiment_name, processName: row.process_name,
        responsible: row.owner_label, responsibleUserId: row.owner_user_id, dueAt, execution: row.status.replace(/_/g, " "),
        dataStatus: "Direct task assignment", blocker: null,
        nextAction: taskNextAction(row.status, dueAt, overdue), attentionReason: attentionReason(null, dueAt, overdue), scopeReason: "Assigned to you",
        href: `/tasks/${row.id}`, isOverdue: overdue, urgency: urgencyFor(row.due_at, closed),
        boardStatus: sourceBoardStatus(row.status), actions: taskActions(user)
      });
    }
  }

  if (ids.length) {
    const qualificationRows = db.prepare(`
      SELECT qs.id, qs.experiment_id, qs.step_number, qs.title, qs.status, qs.is_blocked, qs.blocked_reason,
             e.name AS experiment_name, p.name AS process_name, ea.assignee_user_id,
             COALESCE(NULLIF(u.name, ''), u.email) AS assignee_label,
             (SELECT COUNT(*) FROM qual_runs qr WHERE qr.step_id = qs.id) AS runs_count,
             (SELECT COUNT(*) FROM qual_runs qr WHERE qr.step_id = qs.id AND qr.done = 1) AS done_runs,
             (SELECT COUNT(*) FROM qual_run_values qrv JOIN qual_fields qf ON qf.id = qrv.field_id
                JOIN qual_runs qr ON qr.id = qrv.run_id
               WHERE qr.step_id = qs.id AND qf.required = 1 AND qf.is_enabled = 1
                 AND qrv.value_real IS NULL AND NULLIF(qrv.value_text, '') IS NULL) AS missing_required
      FROM qual_steps qs
      JOIN experiments e ON e.id = qs.experiment_id
      LEFT JOIN processes p ON p.id = e.process_id
      LEFT JOIN entity_assignments ea ON ea.entity_type = 'qualification_step' AND ea.entity_id = qs.id AND ea.status = 'active'
      LEFT JOIN users u ON u.id = ea.assignee_user_id
      WHERE qs.experiment_id IN (${marks}) AND qs.is_active = 1
    `).all(...ids) as Array<any>;
    for (const row of qualificationRows) {
      if (!belongsToScope(filters.scope, user.id, null, row.assignee_user_id)) continue;
      const missing = Number(row.missing_required || 0);
      const runCount = Number(row.runs_count || 0);
      const doneRuns = Number(row.done_runs || 0);
      const execution = String(row.status || "draft").toLowerCase().replace(/_/g, " ");
      const confirmed = execution === "done";
      const blocker = row.is_blocked ? row.blocked_reason || "Stage is blocked" : null;
      const dataStatus = missing
        ? `Required data: ${missing} values missing`
        : runCount
          ? `Run execution: ${doneRuns}/${runCount} complete${doneRuns === runCount && !confirmed ? " · qualification confirmation pending" : ""}`
          : confirmed ? "Qualification confirmed" : "No qualification runs recorded";
      const nextAction = blocker
        ? `Resolve blocker: ${blocker}`
        : missing
          ? `Enter ${missing} missing required value${missing === 1 ? "" : "s"}`
          : !runCount
            ? "Plan qualification runs"
            : doneRuns < runCount
              ? `Complete ${runCount - doneRuns} remaining qualification run${runCount - doneRuns === 1 ? "" : "s"}`
              : !confirmed ? "Review results and confirm qualification stage" : "View confirmed qualification";
      items.push({
        id: `qualification-${row.id}`, sourceId: row.id, entityType: "qualification", title: row.title || `Qualification stage ${row.step_number}`,
        experimentId: row.experiment_id, experimentName: row.experiment_name, processName: row.process_name,
        responsible: row.assignee_label || "Unassigned", responsibleUserId: row.assignee_user_id || null, dueAt: null,
        execution, dataStatus, blocker, nextAction,
        attentionReason: attentionReason(blocker, null, false), scopeReason: row.assignee_user_id === user.id ? "Assigned to you" : null,
        href: `/experiments/${row.experiment_id}/qualification/${row.step_number}`,
        isOverdue: false, urgency: "normal", boardStatus: sourceBoardStatus(row.status), actions: readOnlyActions
      });
    }

    const doeRows = db.prepare(`
      SELECT ds.id, ds.experiment_id, ds.name, e.name AS experiment_name, p.name AS process_name,
             ea.assignee_user_id, COALESCE(NULLIF(u.name, ''), u.email) AS assignee_label,
             (SELECT COUNT(*) FROM runs r WHERE r.doe_id = ds.id) AS runs_count,
             (SELECT COUNT(*) FROM runs r WHERE r.doe_id = ds.id AND r.done = 1) AS done_runs,
             (SELECT COUNT(*) FROM doe_analyses da WHERE da.doe_id = ds.id AND da.archived_at IS NULL) AS analyses_count,
             (SELECT COUNT(*) FROM doe_analyses da JOIN doe_analysis_revisions dar ON dar.id = da.latest_successful_revision_id
               WHERE da.doe_id = ds.id AND da.archived_at IS NULL AND dar.dataset_revision IS NOT NULL) AS current_analyses
      FROM doe_studies ds
      JOIN experiments e ON e.id = ds.experiment_id
      LEFT JOIN processes p ON p.id = e.process_id
      LEFT JOIN entity_assignments ea ON ea.entity_type = 'doe' AND ea.entity_id = ds.id AND ea.status = 'active'
      LEFT JOIN users u ON u.id = ea.assignee_user_id
      WHERE ds.experiment_id IN (${marks})
    `).all(...ids) as Array<any>;
    for (const row of doeRows) {
      if (!belongsToScope(filters.scope, user.id, null, row.assignee_user_id)) continue;
      const runCount = Number(row.runs_count || 0);
      const doneRuns = Number(row.done_runs || 0);
      const stale = Number(row.analyses_count || 0) > Number(row.current_analyses || 0);
      const nextAction = stale ? "Refresh analysis for the current dataset"
        : !runCount ? "Generate DOE run list"
          : doneRuns < runCount ? `Perform ${runCount - doneRuns} remaining DOE run${runCount - doneRuns === 1 ? "" : "s"}`
            : "Review completed DOE run data";
      items.push({
        id: `doe-${row.id}`, sourceId: row.id, entityType: "doe", title: row.name,
        experimentId: row.experiment_id, experimentName: row.experiment_name, processName: row.process_name,
        responsible: row.assignee_label || "Unassigned", responsibleUserId: row.assignee_user_id || null, dueAt: null,
        execution: runCount ? `${doneRuns}/${runCount} runs performed` : "Run list not generated",
        dataStatus: stale ? "Analysis needs refresh" : runCount && doneRuns === runCount ? "Run execution complete" : "Runs pending",
        blocker: null, nextAction, attentionReason: null, scopeReason: row.assignee_user_id === user.id ? "Assigned to you" : null,
        href: `/experiments/${row.experiment_id}/doe/${row.id}?tab=runs`, isOverdue: false, urgency: "normal", boardStatus: runCount && doneRuns === runCount ? "done" : doneRuns > 0 ? "in_progress" : "init", actions: readOnlyActions
      });
    }

    const reportRows = db.prepare(`
      SELECT rc.*, e.name AS experiment_name, p.name AS process_name,
             COALESCE(NULLIF(u.name, ''), u.email, 'Unassigned') AS responsible_label
      FROM report_configs rc
      JOIN experiments e ON e.id = rc.experiment_id
      LEFT JOIN processes p ON p.id = e.process_id
      LEFT JOIN users u ON u.id = rc.responsible_user_id
      WHERE rc.experiment_id IN (${marks})
    `).all(...ids) as Array<any>;
    for (const row of reportRows) {
      if (!belongsToScope(filters.scope, user.id, row.responsible_user_id, row.author_user_id)) continue;
      const signed = Boolean(row.signed_at);
      const awaitingSignature = Boolean(row.submitted_for_signature_at && !signed);
      const dueAt = dateOnly(awaitingSignature ? row.signature_due_at : row.due_at);
      const overdue = isOverdue(dueAt, signed);
      const scopeReason = row.responsible_user_id === user.id ? "You are responsible for this report"
        : row.author_user_id === user.id ? "You are the report author" : null;
      const nextAction = signed ? "View signed report" : awaitingSignature ? "Review report for signature"
        : row.author_user_id === user.id && !row.responsible_user_id ? "Assign a responsible reviewer" : "Continue report draft";
      items.push({
        id: `report-${row.id}`, sourceId: row.id, entityType: "report", title: row.name,
        experimentId: row.experiment_id, experimentName: row.experiment_name, processName: row.process_name,
        responsible: row.responsible_label, responsibleUserId: row.responsible_user_id || null, dueAt,
        execution: signed ? "signed" : awaitingSignature ? "signature pending" : "draft",
        dataStatus: signed ? "Finalized" : awaitingSignature ? "Awaiting signature" : null,
        blocker: null, nextAction, attentionReason: attentionReason(null, dueAt, overdue), scopeReason,
        href: `/reports/${row.id}`, isOverdue: overdue, urgency: urgencyFor(dueAt, signed), boardStatus: signed ? "done" : awaitingSignature ? "in_progress" : "init", actions: readOnlyActions
      });
    }
  }

  const needle = filters.query.toLowerCase();
  const filtered = items.filter((item) => {
    if (filters.type !== "all" && item.entityType !== filters.type) return false;
    if (filters.state === "blocked" && !item.blocker) return false;
    if (filters.state === "overdue" && !item.isOverdue) return false;
    if (filters.state === "open" && (item.blocker || item.execution === "done" || item.execution === "signed")) return false;
    if (filters.responsibleUserId && item.responsibleUserId !== filters.responsibleUserId) return false;
    return !needle || `${item.title} ${item.experimentName} ${item.processName || ""} ${item.responsible}`.toLowerCase().includes(needle);
  }).sort((a, b) => Number(Boolean(b.blocker)) - Number(Boolean(a.blocker)) || Number(b.isOverdue) - Number(a.isOverdue) || String(a.dueAt || "9999-12-31").localeCompare(String(b.dueAt || "9999-12-31")) || a.title.localeCompare(b.title));
  const total = filtered.length;
  const attentionItems = filtered.filter((item) => Boolean(item.attentionReason));
  const routineItems = filtered.filter((item) => !item.attentionReason);
  const people = ids.length ? db.prepare(`
    SELECT DISTINCT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS label FROM users u WHERE u.id IN (
      SELECT t.owner_user_id FROM tasks t WHERE t.experiment_id IN (${marks}) AND t.owner_user_id IS NOT NULL
      UNION SELECT ea.assignee_user_id FROM entity_assignments ea WHERE ea.experiment_id IN (${marks}) AND ea.status = 'active' AND ea.assignee_user_id IS NOT NULL
      UNION SELECT rc.responsible_user_id FROM report_configs rc WHERE rc.experiment_id IN (${marks}) AND rc.responsible_user_id IS NOT NULL
    ) ORDER BY label COLLATE NOCASE
  `).all(...ids, ...ids, ...ids) as Array<{ id: number; label: string }> : [];
  return {
    items: filtered, attentionItems, routineItems, total, page: 1, pageCount: 1,
    processes: Array.from(new Map(visibleScope.experiments.map((experiment) => [Number(experiment.process_id), experiment.process_name || "Process"])).entries()).filter(([id]) => id > 0).map(([id, name]) => ({ id, name })),
    experiments: visibleScope.experiments,
    people
  };
}
