import type { Db } from "../db.js";

export type QualStep = {
  id: number;
  experiment_id: number;
  step_number: number;
  status: "DRAFT" | "RUNNING" | "DONE";
};

export type QualRun = {
  id: number;
  experiment_id: number;
  step_id: number;
  run_order: number;
  run_code: string;
  due_at: string | null;
  done: number;
  exclude_from_analysis: number;
};

export type QualField = {
  id: number;
  experiment_id: number;
  step_id: number;
  code: string;
  label: string;
  field_type: "number" | "text" | "tag" | "boolean";
  unit: string | null;
  group_label: string | null;
  required: number;
  is_enabled: number;
  is_derived: number;
  allowed_values_json: string | null;
  derived_formula_code: string | null;
};

export type QualRunValue = {
  run_id: number;
  field_id: number;
  value_real: number | null;
  value_text: string | null;
  value_tags_json: string | null;
};

export function ensureQualSteps(db: Db, experimentId: number) {
  const existing = db
    .prepare("SELECT step_number FROM qual_steps WHERE experiment_id = ?")
    .all(experimentId) as Array<{ step_number: number }>;
  const existingSet = new Set(existing.map((row) => row.step_number));
  const insert = db.prepare(
    "INSERT INTO qual_steps (experiment_id, step_number, status) VALUES (?, ?, 'DRAFT')"
  );
  for (let step = 1; step <= 6; step += 1) {
    if (!existingSet.has(step)) insert.run(experimentId, step);
  }
}

export function listQualSteps(db: Db, experimentId: number): QualStep[] {
  return db
    .prepare(
      "SELECT id, experiment_id, step_number, status FROM qual_steps WHERE experiment_id = ? ORDER BY step_number"
    )
    .all(experimentId) as QualStep[];
}

export function getQualStep(db: Db, experimentId: number, stepNumber: number): QualStep | null {
  const row = db
    .prepare(
      "SELECT id, experiment_id, step_number, status FROM qual_steps WHERE experiment_id = ? AND step_number = ?"
    )
    .get(experimentId, stepNumber) as QualStep | undefined;
  return row ?? null;
}

export function getQualStepById(db: Db, stepId: number): QualStep | null {
  const row = db
    .prepare(
      "SELECT id, experiment_id, step_number, status FROM qual_steps WHERE id = ?"
    )
    .get(stepId) as QualStep | undefined;
  return row ?? null;
}

export function updateQualStepStatus(db: Db, stepId: number, status: QualStep["status"]) {
  db.prepare("UPDATE qual_steps SET status = ? WHERE id = ?").run(status, stepId);
}

export function listQualRuns(db: Db, stepId: number): QualRun[] {
  return db
    .prepare(
      "SELECT id, experiment_id, step_id, run_order, run_code, due_at, done, exclude_from_analysis FROM qual_runs WHERE step_id = ? ORDER BY run_order"
    )
    .all(stepId) as QualRun[];
}

export function getQualRun(db: Db, runId: number): QualRun | null {
  const row = db
    .prepare(
      "SELECT id, experiment_id, step_id, run_order, run_code, due_at, done, exclude_from_analysis FROM qual_runs WHERE id = ?"
    )
    .get(runId) as QualRun | undefined;
  return row ?? null;
}

export function createQualRuns(db: Db, experimentId: number, stepId: number, count: number) {
  const current = db
    .prepare("SELECT COALESCE(MAX(run_order), 0) as max_order FROM qual_runs WHERE step_id = ?")
    .get(stepId) as { max_order: number };
  const step = db
    .prepare("SELECT step_number FROM qual_steps WHERE id = ?")
    .get(stepId) as { step_number: number } | undefined;
  const stepNumber = step?.step_number ?? stepId;
  const insert = db.prepare(
    `INSERT INTO qual_runs (experiment_id, step_id, run_order, run_code, due_at, done, exclude_from_analysis)
     VALUES (?, ?, ?, ?, NULL, 0, 0)`
  );
  for (let i = 1; i <= count; i += 1) {
    const order = current.max_order + i;
    const runCode = `Q${stepNumber}-R${String(order).padStart(3, "0")}`;
    insert.run(experimentId, stepId, order, runCode);
  }
}

export function listQualFields(db: Db, stepId: number): QualField[] {
  return db
    .prepare(
      `SELECT id, experiment_id, step_id, code, label, field_type, unit, group_label,
              required, is_enabled, is_derived, allowed_values_json, derived_formula_code
       FROM qual_fields WHERE step_id = ? ORDER BY id`
    )
    .all(stepId) as QualField[];
}

export function insertQualField(
  db: Db,
  field: Omit<QualField, "id">
) {
  const result = db
    .prepare(
      `INSERT INTO qual_fields
       (experiment_id, step_id, code, label, field_type, unit, group_label, required, is_enabled, is_derived, allowed_values_json, derived_formula_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      field.experiment_id,
      field.step_id,
      field.code,
      field.label,
      field.field_type,
      field.unit,
      field.group_label,
      field.required,
      field.is_enabled,
      field.is_derived,
      field.allowed_values_json,
      field.derived_formula_code
    );
  return Number(result.lastInsertRowid);
}

export function updateQualField(
  db: Db,
  fieldId: number,
  updates: Partial<Omit<QualField, "id" | "experiment_id" | "step_id">>
) {
  const current = db
    .prepare(
      `SELECT id, code, label, field_type, unit, group_label, required, is_enabled, is_derived, allowed_values_json, derived_formula_code
       FROM qual_fields WHERE id = ?`
    )
    .get(fieldId) as QualField | undefined;
  if (!current) return;
  const next = { ...current, ...updates };
  db.prepare(
    `UPDATE qual_fields
     SET code = ?, label = ?, field_type = ?, unit = ?, group_label = ?, required = ?, is_enabled = ?, is_derived = ?, allowed_values_json = ?, derived_formula_code = ?
     WHERE id = ?`
  ).run(
    next.code,
    next.label,
    next.field_type,
    next.unit,
    next.group_label,
    next.required,
    next.is_enabled,
    next.is_derived,
    next.allowed_values_json,
    next.derived_formula_code,
    fieldId
  );
}

export function listQualRunValues(db: Db, runId: number): QualRunValue[] {
  return db
    .prepare(
      "SELECT run_id, field_id, value_real, value_text, value_tags_json FROM qual_run_values WHERE run_id = ?"
    )
    .all(runId) as QualRunValue[];
}

export function upsertQualRunValue(db: Db, value: QualRunValue) {
  db.prepare(
    `INSERT OR REPLACE INTO qual_run_values (run_id, field_id, value_real, value_text, value_tags_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(value.run_id, value.field_id, value.value_real, value.value_text, value.value_tags_json);
}

export function updateQualRunFlags(db: Db, runId: number, done: number, exclude: number) {
  db.prepare("UPDATE qual_runs SET done = ?, exclude_from_analysis = ? WHERE id = ?").run(
    done,
    exclude,
    runId
  );
}

export function updateQualRunDueAt(db: Db, runId: number, dueAt: string | null) {
  db.prepare("UPDATE qual_runs SET due_at = ? WHERE id = ?").run(dueAt, runId);
}

export function upsertQualSummary(
  db: Db,
  experimentId: number,
  stepNumber: number,
  summaryJson: string
) {
  db.prepare(
    `INSERT INTO qual_step_summary (experiment_id, step_number, summary_json, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(experiment_id, step_number)
     DO UPDATE SET summary_json = excluded.summary_json, created_at = datetime('now')`
  ).run(experimentId, stepNumber, summaryJson);
}

export function listQualSummaries(db: Db, experimentId: number) {
  return db
    .prepare(
      "SELECT experiment_id, step_number, summary_json, created_at FROM qual_step_summary WHERE experiment_id = ? ORDER BY step_number"
    )
    .all(experimentId) as Array<{
    experiment_id: number;
    step_number: number;
    summary_json: string;
    created_at: string;
  }>;
}

export function listQualSummarySteps(db: Db, experimentId: number): number[] {
  return db
    .prepare(
      "SELECT step_number FROM qual_step_summary WHERE experiment_id = ? ORDER BY step_number"
    )
    .all(experimentId)
    .map((row: { step_number: number }) => row.step_number);
}

export function getQualStepSettings(db: Db, experimentId: number, stepNumber: number) {
  const row = db
    .prepare(
      "SELECT settings_json FROM qual_step_settings WHERE experiment_id = ? AND step_number = ?"
    )
    .get(experimentId, stepNumber) as { settings_json: string } | undefined;
  return row?.settings_json ?? null;
}

export function upsertQualStepSettings(
  db: Db,
  experimentId: number,
  stepNumber: number,
  settingsJson: string
) {
  db.prepare(
    `INSERT INTO qual_step_settings (experiment_id, step_number, settings_json, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(experiment_id, step_number)
     DO UPDATE SET settings_json = excluded.settings_json, created_at = datetime('now')`
  ).run(experimentId, stepNumber, settingsJson);
}
