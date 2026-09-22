import type { Db } from "../db.js";

export type EntityAssignmentType = "qualification_step" | "doe" | "report";

export type EntityAssignmentRow = {
  id: number;
  experiment_id: number;
  entity_type: EntityAssignmentType;
  entity_id: number;
  assignee_user_id: number | null;
  assigned_by_user_id: number | null;
  status: "active" | "revoked";
  created_at: string;
  updated_at: string;
};

export type UserAssignedEntityRow = {
  assignment_id: number;
  experiment_id: number;
  experiment_name: string;
  entity_type: EntityAssignmentType;
  entity_id: number;
  step_number: number | null;
  doe_name: string | null;
  report_name: string | null;
  assigned_by_user_id: number | null;
  assigned_by_name: string | null;
  assigned_by_email: string | null;
  assigned_at: string;
  updated_at: string;
};

export function getEntityAssignment(
  db: Db,
  entityType: EntityAssignmentType,
  entityId: number
): EntityAssignmentRow | null {
  const row = db
    .prepare("SELECT * FROM entity_assignments WHERE entity_type = ? AND entity_id = ?")
    .get(entityType, entityId) as EntityAssignmentRow | undefined;
  return row ?? null;
}

export function listEntityAssignmentsByExperiment(db: Db, experimentId: number): EntityAssignmentRow[] {
  return db
    .prepare("SELECT * FROM entity_assignments WHERE experiment_id = ? AND status = 'active' ORDER BY id")
    .all(experimentId) as EntityAssignmentRow[];
}

export function upsertEntityAssignment(
  db: Db,
  data: {
    experiment_id: number;
    entity_type: EntityAssignmentType;
    entity_id: number;
    assignee_user_id: number | null;
    assigned_by_user_id: number | null;
  }
): number {
  const now = new Date().toISOString();
  const existing = getEntityAssignment(db, data.entity_type, data.entity_id);
  if (existing) {
    db.prepare(
      `UPDATE entity_assignments
       SET experiment_id = ?, assignee_user_id = ?, assigned_by_user_id = ?, status = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      data.experiment_id,
      data.assignee_user_id,
      data.assigned_by_user_id,
      data.assignee_user_id ? "active" : "revoked",
      now,
      existing.id
    );
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO entity_assignments
       (experiment_id, entity_type, entity_id, assignee_user_id, assigned_by_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.experiment_id,
      data.entity_type,
      data.entity_id,
      data.assignee_user_id,
      data.assigned_by_user_id,
      data.assignee_user_id ? "active" : "revoked",
      now,
      now
    );

  return Number(result.lastInsertRowid);
}

export function listAssignedEntitiesForUser(db: Db, userId: number): UserAssignedEntityRow[] {
  return db
    .prepare(
      `SELECT
         ea.id as assignment_id,
         ea.experiment_id,
         e.name as experiment_name,
         ea.entity_type,
         ea.entity_id,
         qs.step_number as step_number,
         ds.name as doe_name,
         rc.name as report_name,
         ea.assigned_by_user_id,
         ab.name as assigned_by_name,
         ab.email as assigned_by_email,
         ea.created_at as assigned_at,
         ea.updated_at
       FROM entity_assignments ea
       JOIN experiments e ON e.id = ea.experiment_id
       LEFT JOIN qual_steps qs ON ea.entity_type = 'qualification_step' AND qs.id = ea.entity_id
       LEFT JOIN doe_studies ds ON ea.entity_type = 'doe' AND ds.id = ea.entity_id
       LEFT JOIN report_configs rc ON ea.entity_type = 'report' AND rc.id = ea.entity_id
       LEFT JOIN users ab ON ab.id = ea.assigned_by_user_id
       WHERE ea.assignee_user_id = ?
         AND ea.status = 'active'
       ORDER BY datetime(ea.updated_at) DESC, ea.id DESC`
    )
    .all(userId) as UserAssignedEntityRow[];
}

export function hasActiveAssignmentForExperiment(db: Db, experimentId: number, userId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 as ok
       FROM entity_assignments
       WHERE experiment_id = ?
         AND assignee_user_id = ?
         AND status = 'active'
       LIMIT 1`
    )
    .get(experimentId, userId) as { ok: number } | undefined;
  return Boolean(row?.ok);
}
