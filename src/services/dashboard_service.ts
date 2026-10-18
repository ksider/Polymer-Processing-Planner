import type { Db } from "../db.js";
import { type ExperimentListRow } from "../repos/experiments_repo.js";
import { listMyCalendarEvents, type CalendarEvent } from "./calendar_service.js";
import { isDemoUser } from "./demo_mode.js";
import { getSystemHealthOverview, type SystemHealthOverview } from "./system_health_service.js";
import { listProcessesForOwner } from "../repos/processes_repo.js";
import { listWorkspaceExperimentScope } from "./workspace_scope_service.js";

export type DashboardAction = {
  id: string;
  title: string;
  experimentName: string;
  processName: string | null;
  entityType: "Task" | "Qualification" | "DOE" | "Report";
  dueAt: string | null;
  urgency: "overdue" | "today" | "upcoming" | "attention";
  status: string;
  href: string;
};

export type DashboardQualification = {
  experimentId: number;
  experimentName: string;
  processName: string | null;
  active: number;
  done: number;
  running: number;
  blocked: number;
  pending: number;
  currentStep: number | null;
};

export type DashboardWorkload = { userLabel: string; openTasks: number };

export type DashboardData = {
  role: string;
  scopeLabel: string;
  selectedProcessId: number | null;
  processOptions: Array<{ id: number; name: string }>;
  canCreateExperiment: boolean;
  isReadOnly: boolean;
  metrics: Array<{ label: string; value: number; tone: "neutral" | "danger" | "warning" }>;
  actions: DashboardAction[];
  upcoming: CalendarEvent[];
  continueWorking: ExperimentListRow[];
  qualifications: DashboardQualification[];
  reports: Array<{ id: number; name: string; experimentName: string; dueAt: string | null; signatureDueAt: string | null; pendingSignature: boolean; href: string }>;
  workload: DashboardWorkload[];
  showWorkload: boolean;
  recentActivity: Array<{ label: string; detail: string; at: string; href: string }>;
  adminHealth: SystemHealthOverview | null;
  limits: { staleDoeAnalyses: boolean };
};

type Scope = { experiments: ExperimentListRow[]; ids: number[] };
type TaskActionRow = {
  id: number; title: string; status: string; due_at: string | null; experiment_id: number;
  experiment_name: string; process_name: string | null; process_route_code: string | null; process_type_code: string | null;
};

function hasPortfolioScope(user: Express.User): boolean {
  return user.role === "admin" || user.role === "manager" || isDemoUser(user);
}

function experimentHref(experiment: Pick<ExperimentListRow, "id" | "process_route_code" | "process_type_code">): string {
  const route = String(experiment.process_route_code || experiment.process_type_code || "").trim();
  return route ? `/${route}/${experiment.id}` : `/experiments/${experiment.id}`;
}

function sqlIn(ids: number[]): { placeholders: string; values: number[] } {
  return { placeholders: ids.map(() => "?").join(","), values: ids };
}

function dateOnly(value: string | null | undefined): string | null {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function dayRelation(value: string | null | undefined, today: string): DashboardAction["urgency"] {
  const date = dateOnly(value);
  if (!date) return "attention";
  if (date < today) return "overdue";
  if (date === today) return "today";
  return "upcoming";
}

function actionRank(item: DashboardAction): number {
  return ({ overdue: 0, attention: 1, today: 2, upcoming: 3 })[item.urgency];
}

function selectedScope(db: Db, user: Express.User, selectedProcessId: number | null): Scope {
  const all = listWorkspaceExperimentScope(db, user).experiments;
  const experiments = selectedProcessId
    ? all.filter((experiment) => Number(experiment.process_id) === selectedProcessId)
    : all;
  return { experiments, ids: experiments.map((experiment) => experiment.id) };
}

function assignedTaskActions(db: Db, ids: number[], userId: number, today: string): { actions: DashboardAction[]; ids: Set<number> } {
  if (!ids.length) return { actions: [], ids: new Set() };
  const scoped = sqlIn(ids);
  const rows = db.prepare(
    `SELECT DISTINCT t.id, t.title, t.status, t.due_at, e.id AS experiment_id, e.name AS experiment_name,
            p.name AS process_name, p.route_code AS process_route_code, pt.code AS process_type_code
     FROM tasks t
     JOIN experiments e ON e.id = t.experiment_id
     LEFT JOIN processes p ON p.id = e.process_id
     LEFT JOIN process_types pt ON pt.id = p.process_type_id
     LEFT JOIN task_assignments ta ON ta.task_id = t.id AND ta.user_id = ?
     WHERE t.experiment_id IN (${scoped.placeholders})
       AND t.status NOT IN ('done', 'failed')
       AND (t.owner_user_id = ? OR ta.user_id = ?)
     ORDER BY t.due_at IS NULL, t.due_at, t.id DESC
     LIMIT 16`
  ).all(userId, ...scoped.values, userId, userId) as TaskActionRow[];
  const taskIds = new Set(rows.map((row) => row.id));
  return {
    ids: taskIds,
    actions: rows.map((row) => ({
      id: `task-${row.id}`,
      title: row.title,
      experimentName: row.experiment_name,
      processName: row.process_name,
      entityType: "Task",
      dueAt: dateOnly(row.due_at),
      urgency: dayRelation(row.due_at, today),
      status: row.status.replace(/_/g, " "),
      href: experimentHref({ id: row.experiment_id, process_route_code: row.process_route_code, process_type_code: row.process_type_code }) + `#task-${row.id}`
    }))
  };
}

function assignedEntityActions(db: Db, ids: number[], userId: number, taskIds: Set<number>, today: string): DashboardAction[] {
  if (!ids.length) return [];
  const scoped = sqlIn(ids);
  const rows = db.prepare(
    `SELECT ea.id AS assignment_id, ea.entity_type, ea.entity_id, e.id AS experiment_id, e.name AS experiment_name,
            p.name AS process_name, p.route_code AS process_route_code, pt.code AS process_type_code,
            qs.step_number, qs.title AS step_title, qs.status AS step_status, qs.is_blocked,
            ds.name AS doe_name, at.task_id
     FROM entity_assignments ea
     JOIN experiments e ON e.id = ea.experiment_id
     LEFT JOIN processes p ON p.id = e.process_id
     LEFT JOIN process_types pt ON pt.id = p.process_type_id
     LEFT JOIN qual_steps qs ON ea.entity_type = 'qualification_step' AND qs.id = ea.entity_id
     LEFT JOIN doe_studies ds ON ea.entity_type = 'doe' AND ds.id = ea.entity_id
     LEFT JOIN assignment_tasks at ON at.assignment_id = ea.id
     WHERE ea.experiment_id IN (${scoped.placeholders})
       AND ea.assignee_user_id = ? AND ea.status = 'active'
       AND ((ea.entity_type = 'qualification_step' AND qs.is_active = 1 AND qs.status <> 'DONE')
         OR ea.entity_type = 'doe')
     ORDER BY datetime(ea.updated_at) DESC, ea.id DESC
     LIMIT 12`
  ).all(...scoped.values, userId) as Array<{
    assignment_id: number; entity_type: "qualification_step" | "doe"; entity_id: number; experiment_id: number;
    experiment_name: string; process_name: string | null; process_route_code: string | null; process_type_code: string | null;
    step_number: number | null; step_title: string | null; step_status: string | null; is_blocked: number | null; doe_name: string | null; task_id: number | null;
  }>;
  return rows.filter((row) => !row.task_id || !taskIds.has(row.task_id)).map((row) => {
    const base = experimentHref({ id: row.experiment_id, process_route_code: row.process_route_code, process_type_code: row.process_type_code });
    const qualification = row.entity_type === "qualification_step";
    return {
      id: `assignment-${row.assignment_id}`,
      title: qualification ? (row.step_title || `Qualification stage ${row.step_number}`) : (row.doe_name || "DOE study"),
      experimentName: row.experiment_name,
      processName: row.process_name,
      entityType: qualification ? "Qualification" : "DOE",
      dueAt: null,
      urgency: qualification && (row.is_blocked === 1 || row.step_status === "BLOCKED") ? "attention" : "upcoming",
      status: qualification ? String(row.step_status || "DRAFT").toLowerCase() : "assigned",
      href: qualification ? `${base}/qualification/${row.step_number}` : `${base}/doe/${row.entity_id}?tab=runs`
    };
  });
}

function reportRows(db: Db, ids: number[], user: Express.User, today: string) {
  if (!ids.length) return { actions: [] as DashboardAction[], reports: [] as DashboardData["reports"] };
  const scoped = sqlIn(ids);
  const rows = db.prepare(
    `SELECT rc.id, rc.name, rc.experiment_id, rc.due_at, rc.signature_due_at, rc.submitted_for_signature_at,
            rc.signed_at, rc.author_user_id, rc.responsible_user_id, e.name AS experiment_name, p.name AS process_name
     FROM report_configs rc
     JOIN experiments e ON e.id = rc.experiment_id
     LEFT JOIN processes p ON p.id = e.process_id
     WHERE rc.experiment_id IN (${scoped.placeholders})
     ORDER BY COALESCE(rc.signature_due_at, rc.due_at, '9999-12-31'), rc.id DESC
     LIMIT 24`
  ).all(...scoped.values) as Array<{
    id: number; name: string; experiment_id: number; due_at: string | null; signature_due_at: string | null;
    submitted_for_signature_at: string | null; signed_at: string | null; author_user_id: number | null; responsible_user_id: number | null;
    experiment_name: string; process_name: string | null;
  }>;
  const pending = rows.filter((row) => !row.signed_at && (row.submitted_for_signature_at || row.due_at));
  const reports = pending.slice(0, 8).map((row) => ({
    id: row.id, name: row.name, experimentName: row.experiment_name, dueAt: dateOnly(row.due_at),
    signatureDueAt: dateOnly(row.signature_due_at), pendingSignature: Boolean(row.submitted_for_signature_at), href: `/reports/${row.id}`
  }));
  const actions = rows.filter((row) => !row.signed_at && (
    (row.submitted_for_signature_at && row.responsible_user_id === user.id) ||
    (!row.submitted_for_signature_at && row.author_user_id === user.id)
  )).map((row) => {
    const signing = Boolean(row.submitted_for_signature_at && row.responsible_user_id === user.id);
    const deadline = signing ? row.signature_due_at : row.due_at;
    return {
      id: `report-${row.id}`, title: signing ? `Sign: ${row.name}` : `Continue report: ${row.name}`,
      experimentName: row.experiment_name, processName: row.process_name, entityType: "Report" as const,
      dueAt: dateOnly(deadline), urgency: dayRelation(deadline, today),
      status: signing ? "signature pending" : "draft", href: signing ? `/reports/${row.id}` : `/reports/${row.id}/editor`
    };
  });
  return { actions, reports };
}

function qualificationSummary(db: Db, ids: number[]): DashboardQualification[] {
  if (!ids.length) return [];
  const scoped = sqlIn(ids);
  const rows = db.prepare(
    `SELECT e.id AS experiment_id, e.name AS experiment_name, p.name AS process_name,
            COUNT(qs.id) AS active,
            SUM(CASE WHEN qs.status = 'DONE' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN qs.status = 'RUNNING' THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN qs.is_blocked = 1 OR qs.status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
            MIN(CASE WHEN qs.status NOT IN ('DONE', 'BLOCKED') THEN qs.step_number END) AS current_step
     FROM experiments e
     LEFT JOIN processes p ON p.id = e.process_id
     LEFT JOIN qual_steps qs ON qs.experiment_id = e.id AND qs.is_active = 1
     WHERE e.id IN (${scoped.placeholders})
     GROUP BY e.id
     HAVING COUNT(qs.id) > 0
     ORDER BY blocked DESC, running DESC, e.id DESC
     LIMIT 8`
  ).all(...scoped.values) as Array<{ experiment_id: number; experiment_name: string; process_name: string | null; active: number; done: number; running: number; blocked: number; current_step: number | null }>;
  return rows.map((row) => {
    const active = Number(row.active);
    const done = Number(row.done);
    const running = Number(row.running);
    const blocked = Number(row.blocked);
    return {
      experimentId: row.experiment_id,
      experimentName: row.experiment_name,
      processName: row.process_name,
      active,
      done,
      running,
      blocked,
      pending: Math.max(0, active - done - running - blocked),
      currentStep: row.current_step
    };
  });
}

function workloadSummary(db: Db, ids: number[]): DashboardWorkload[] {
  if (!ids.length) return [];
  const scoped = sqlIn(ids);
  return db.prepare(
    `SELECT COALESCE(NULLIF(u.name, ''), u.email, 'Unassigned') AS user_label, COUNT(DISTINCT t.id) AS open_tasks
     FROM tasks t
     JOIN task_assignments ta ON ta.task_id = t.id
     JOIN users u ON u.id = ta.user_id
     WHERE t.experiment_id IN (${scoped.placeholders}) AND t.status NOT IN ('done', 'failed')
     GROUP BY ta.user_id
     ORDER BY open_tasks DESC, user_label
     LIMIT 8`
  ).all(...scoped.values).map((row: { user_label: string; open_tasks: number }) => ({ userLabel: row.user_label, openTasks: Number(row.open_tasks) }));
}

function recentActivity(db: Db, ids: number[]): DashboardData["recentActivity"] {
  if (!ids.length) return [];
  const scoped = sqlIn(ids);
  return db.prepare(
    `SELECT dae.action, dae.created_at, da.name AS analysis_name, ds.id AS doe_id, e.id AS experiment_id
     FROM doe_analysis_events dae
     JOIN doe_analyses da ON da.id = dae.analysis_id
     JOIN doe_studies ds ON ds.id = da.doe_id
     JOIN experiments e ON e.id = ds.experiment_id
     WHERE e.id IN (${scoped.placeholders})
     ORDER BY dae.id DESC
     LIMIT 8`
  ).all(...scoped.values).map((row: { action: string; created_at: string; analysis_name: string; doe_id: number; experiment_id: number }) => ({
    label: row.action.replace(/_/g, " ").toLowerCase(), detail: row.analysis_name, at: row.created_at,
    href: `/experiments/${row.experiment_id}/doe/${row.doe_id}?tab=analysis`
  }));
}

export function buildDashboard(db: Db, user: Express.User, selectedProcessId: number | null): DashboardData {
  const scope = selectedScope(db, user, selectedProcessId);
  const today = new Date().toISOString().slice(0, 10);
  const upcomingEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const taskResult = assignedTaskActions(db, scope.ids, user.id, today);
  const entityActions = assignedEntityActions(db, scope.ids, user.id, taskResult.ids, today);
  const reportResult = reportRows(db, scope.ids, user, today);
  const actions = [...taskResult.actions, ...entityActions, ...reportResult.actions]
    .sort((left, right) => actionRank(left) - actionRank(right) || String(left.dueAt || "9999-12-31").localeCompare(String(right.dueAt || "9999-12-31")))
    .slice(0, 16);
  const processOptions = Array.from(new Map(scope.experiments.filter((exp) => exp.process_id).map((exp) => [Number(exp.process_id), exp.process_name || "Process"])).entries())
    .map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const allOpenTasks = scope.ids.length ? Number((db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE experiment_id IN (${sqlIn(scope.ids).placeholders}) AND status NOT IN ('done', 'failed')`).get(...scope.ids) as { count: number }).count) : 0;
  const overdue = actions.filter((action) => action.urgency === "overdue").length;
  const pendingApprovals = reportResult.reports.filter((report) => report.pendingSignature).length;
  const isPortfolio = hasPortfolioScope(user);
  const ownsProcess = listProcessesForOwner(db, user.id).length > 0;
  return {
    role: user.role || "member",
    scopeLabel: selectedProcessId ? (processOptions.find((process) => process.id === selectedProcessId)?.name || "Selected process") : (isPortfolio ? "All accessible processes" : "My assigned and owned work"),
    selectedProcessId,
    processOptions,
    canCreateExperiment: ["admin", "manager", "engineer"].includes(user.role || "") || ownsProcess,
    isReadOnly: user.role === "viewer" || isDemoUser(user),
    metrics: [
      { label: "Active experiments", value: scope.experiments.length, tone: "neutral" },
      { label: "Open tasks", value: allOpenTasks, tone: "neutral" },
      { label: "Overdue items", value: overdue, tone: overdue ? "danger" : "neutral" },
      { label: "Pending approvals", value: pendingApprovals, tone: pendingApprovals ? "warning" : "neutral" }
    ],
    actions,
    upcoming: listMyCalendarEvents(db, user.id).filter((event) => event.start >= today && event.start <= upcomingEnd).slice(0, 8),
    continueWorking: scope.experiments.slice(0, 8),
    qualifications: qualificationSummary(db, scope.ids),
    reports: reportResult.reports,
    workload: (user.role === "admin" || user.role === "manager" || ownsProcess) ? workloadSummary(db, scope.ids) : [],
    showWorkload: user.role === "admin" || user.role === "manager" || ownsProcess,
    recentActivity: recentActivity(db, scope.ids),
    adminHealth: user.role === "admin" ? getSystemHealthOverview(db) : null,
    limits: { staleDoeAnalyses: false }
  };
}
