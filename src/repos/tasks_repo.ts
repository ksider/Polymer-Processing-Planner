import type { Db } from "../db.js";

export type TaskStatus = "init" | "in_progress" | "done" | "failed";
export type EntityType = "qualification_step" | "doe" | "report";
export type ProgressMode = "toggle" | "milestone";

export type TaskRow = {
  id: number;
  experiment_id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  owner_user_id: number | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskEntityRow = {
  id: number;
  task_id: number;
  entity_type: EntityType;
  entity_id: number;
  label: string | null;
  weight: number;
  progress_mode: ProgressMode;
  status: TaskStatus;
  signature_required: number;
  signature_user_id: number | null;
  signature_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskAssignmentRow = {
  id: number;
  task_id: number;
  user_id: number;
  role: string;
  created_at: string;
};

// Core CRUD for tasks. These are intentionally small; business rules stay in services.
export function listTasksByExperiment(db: Db, experimentId: number): TaskRow[] {
  return db
    .prepare("SELECT * FROM tasks WHERE experiment_id = ? ORDER BY id DESC")
    .all(experimentId) as TaskRow[];
}

export function getTask(db: Db, taskId: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

export function createTask(
  db: Db,
  data: {
    experiment_id: number;
    title: string;
    description?: string | null;
    owner_user_id?: number | null;
    due_at?: string | null;
  }
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO tasks (experiment_id, title, description, status, owner_user_id, due_at, created_at, updated_at)
       VALUES (?, ?, ?, 'init', ?, ?, ?, ?)`
    )
    .run(
      data.experiment_id,
      data.title,
      data.description ?? null,
      data.owner_user_id ?? null,
      data.due_at ?? null,
      now,
      now
    );
  return Number(result.lastInsertRowid);
}

export function updateTask(
  db: Db,
  taskId: number,
  updates: Partial<Omit<TaskRow, "id" | "experiment_id" | "created_at">>
) {
  const current = getTask(db, taskId);
  if (!current) return;
  const next = { ...current, ...updates, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE tasks
     SET title = ?, description = ?, status = ?, owner_user_id = ?, due_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    next.title,
    next.description ?? null,
    next.status,
    next.owner_user_id ?? null,
    next.due_at ?? null,
    next.updated_at,
    taskId
  );
}

export function deleteTask(db: Db, taskId: number) {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
}

// Task entity links (qualification steps, DOE, reports).
export function listTaskEntities(db: Db, taskId: number): TaskEntityRow[] {
  return db
    .prepare("SELECT * FROM task_entities WHERE task_id = ? ORDER BY id")
    .all(taskId) as TaskEntityRow[];
}

export function getTaskEntity(db: Db, entityId: number): TaskEntityRow | undefined {
  return db.prepare("SELECT * FROM task_entities WHERE id = ?").get(entityId) as TaskEntityRow | undefined;
}

export function createTaskEntity(
  db: Db,
  data: {
    task_id: number;
    entity_type: EntityType;
    entity_id: number;
    label?: string | null;
    weight?: number;
    progress_mode?: ProgressMode;
    status?: TaskStatus;
    signature_required?: number;
  }
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO task_entities
       (task_id, entity_type, entity_id, label, weight, progress_mode, status, signature_required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.task_id,
      data.entity_type,
      data.entity_id,
      data.label ?? null,
      data.weight ?? 1,
      data.progress_mode ?? "toggle",
      data.status ?? "init",
      data.signature_required ?? 0,
      now,
      now
    );
  return Number(result.lastInsertRowid);
}

export function updateTaskEntity(
  db: Db,
  entityId: number,
  updates: Partial<Omit<TaskEntityRow, "id" | "task_id" | "entity_type" | "entity_id" | "created_at">>
) {
  const row = db.prepare("SELECT * FROM task_entities WHERE id = ?").get(entityId) as
    | TaskEntityRow
    | undefined;
  if (!row) return;
  const next = { ...row, ...updates, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE task_entities
     SET label = ?, weight = ?, progress_mode = ?, status = ?, signature_required = ?, signature_user_id = ?, signature_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    next.label ?? null,
    next.weight ?? 1,
    next.progress_mode,
    next.status,
    next.signature_required ?? 0,
    next.signature_user_id ?? null,
    next.signature_at ?? null,
    next.updated_at,
    entityId
  );
}

export function deleteTaskEntity(db: Db, entityId: number) {
  db.prepare("DELETE FROM task_entities WHERE id = ?").run(entityId);
}

// Task assignments (operators or other assignees).
export function listTaskAssignments(db: Db, taskId: number): TaskAssignmentRow[] {
  return db
    .prepare("SELECT * FROM task_assignments WHERE task_id = ? ORDER BY id")
    .all(taskId) as TaskAssignmentRow[];
}

export function getTaskAssignment(db: Db, assignmentId: number): TaskAssignmentRow | undefined {
  return db
    .prepare("SELECT * FROM task_assignments WHERE id = ?")
    .get(assignmentId) as TaskAssignmentRow | undefined;
}

export function createTaskAssignment(
  db: Db,
  data: { task_id: number; user_id: number; role?: string }
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO task_assignments (task_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(data.task_id, data.user_id, data.role ?? "operator", now);
  return Number(result.lastInsertRowid);
}

export function deleteTaskAssignment(db: Db, assignmentId: number) {
  db.prepare("DELETE FROM task_assignments WHERE id = ?").run(assignmentId);
}
