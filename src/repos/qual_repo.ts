import type { Db } from "../db.js";

export type QualStep = {
  id: number;
  experiment_id: number;
  step_number: number;
  stage_code: string;
  display_order: number;
  title: string;
  status: "DRAFT" | "RUNNING" | "DONE" | "BLOCKED";
  is_blocked: number;
  blocked_reason: string | null;
  blocked_by_user_id: number | null;
  blocked_by_label: string | null;
  blocked_at: string | null;
  status_before_block: "DRAFT" | "RUNNING" | "DONE" | null;
};

export type QualStageSeed = {
  step_number: number;
  stage_code: string;
  display_order: number;
  title: string;
};

export type QualRun = {
  id: number;
  experiment_id: number;
  step_id: number;
  run_order: number;
  run_code: string;
  run_group: string;
  due_at: string | null;
  performed_at: string | null;
  responsible_user_id: number | null;
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

export type QualRunSeries = {
  id: number;
  experiment_id: number;
  step_id: number;
  run_id: number;
  series_code: string;
  contract_version: number;
  source_name: string | null;
  created_at: string;
  updated_at: string;
};

export type QualRunSeriesPoint = {
  id: number;
  series_id: number;
  point_order: number;
  x_value: number;
  y_value: number;
  extra_json: string | null;
};

export type QualStepOutput = {
  id: number;
  experiment_id: number;
  step_id: number;
  output_group: string;
  output_code: string;
  value_real: number | null;
  value_text: string | null;
  updated_at: string;
};

const qualStepSelect = `
  SELECT qs.id, qs.experiment_id, qs.step_number, qs.stage_code,
         qs.display_order, qs.title, qs.status, qs.is_blocked,
         qs.blocked_reason, qs.blocked_by_user_id, qs.blocked_at,
         qs.status_before_block,
         COALESCE(NULLIF(u.name, ''), u.email) AS blocked_by_label
  FROM qual_steps qs
  LEFT JOIN users u ON u.id = qs.blocked_by_user_id
`;

export function ensureQualSteps(db: Db, experimentId: number, seeds: readonly QualStageSeed[]) {
  const existing = db
    .prepare("SELECT id, step_number FROM qual_steps WHERE experiment_id = ?")
    .all(experimentId) as Array<{ id: number; step_number: number }>;
  const existingByNumber = new Map(existing.map((row) => [row.step_number, row]));
  const insert = db.prepare(
    `INSERT INTO qual_steps
     (experiment_id, step_number, stage_code, display_order, title, status)
     VALUES (?, ?, ?, ?, ?, 'DRAFT')`
  );
  const update = db.prepare(
    "UPDATE qual_steps SET stage_code = ?, display_order = ?, title = ? WHERE id = ?"
  );
  const seenNumbers = new Set<number>();
  const seenCodes = new Set<string>();
  for (const seed of seeds) {
    if (!Number.isInteger(seed.step_number) || seed.step_number <= 0) {
      throw new Error("Qualification stage number must be a positive integer");
    }
    if (!seed.stage_code.trim() || !seed.title.trim()) {
      throw new Error("Qualification stage code and title are required");
    }
    if (seenNumbers.has(seed.step_number) || seenCodes.has(seed.stage_code)) {
      throw new Error("Qualification stage catalogue contains duplicate identifiers");
    }
    seenNumbers.add(seed.step_number);
    seenCodes.add(seed.stage_code);
    const current = existingByNumber.get(seed.step_number);
    if (current) {
      update.run(seed.stage_code, seed.display_order, seed.title, current.id);
    } else {
      insert.run(experimentId, seed.step_number, seed.stage_code, seed.display_order, seed.title);
    }
  }
}

export function listQualSteps(db: Db, experimentId: number): QualStep[] {
  return db
    .prepare(
      `${qualStepSelect}
       WHERE qs.experiment_id = ?
       ORDER BY qs.display_order, qs.id`
    )
    .all(experimentId) as QualStep[];
}

export function getQualStep(db: Db, experimentId: number, stepNumber: number): QualStep | null {
  const row = db
    .prepare(
      `${qualStepSelect}
       WHERE qs.experiment_id = ? AND qs.step_number = ?`
    )
    .get(experimentId, stepNumber) as QualStep | undefined;
  return row ?? null;
}

export function getQualStepById(db: Db, stepId: number): QualStep | null {
  const row = db
    .prepare(
      `${qualStepSelect}
       WHERE qs.id = ?`
    )
    .get(stepId) as QualStep | undefined;
  return row ?? null;
}

export function updateQualStepStatus(db: Db, stepId: number, status: QualStep["status"]) {
  if (status === "BLOCKED") {
    throw new Error("Use setQualStepBlocked to block a qualification stage");
  }
  db.prepare("UPDATE qual_steps SET status = ? WHERE id = ?").run(status, stepId);
}

export function setQualStepBlocked(
  db: Db,
  stepId: number,
  input: { blocked: boolean; reason?: string | null; actorUserId: number | null }
) {
  if (input.blocked) {
    const reason = String(input.reason ?? "").trim();
    if (!reason) throw new Error("A block reason is required");
    db.prepare(
      `UPDATE qual_steps
       SET status_before_block = CASE WHEN status = 'BLOCKED' THEN status_before_block ELSE status END,
           status = 'BLOCKED',
           is_blocked = 1,
           blocked_reason = ?,
           blocked_by_user_id = ?,
           blocked_at = datetime('now')
       WHERE id = ?`
    ).run(reason, input.actorUserId, stepId);
    return;
  }
  db.prepare(
    `UPDATE qual_steps
     SET status = COALESCE(status_before_block, 'DRAFT'),
         is_blocked = 0,
         blocked_reason = NULL,
         blocked_by_user_id = NULL,
         blocked_at = NULL,
         status_before_block = NULL
     WHERE id = ?`
  ).run(stepId);
}

export function listQualRuns(db: Db, stepId: number): QualRun[] {
  return db
    .prepare(
      "SELECT id, experiment_id, step_id, run_order, run_code, run_group, due_at, performed_at, responsible_user_id, done, exclude_from_analysis FROM qual_runs WHERE step_id = ? ORDER BY run_order"
    )
    .all(stepId) as QualRun[];
}

export function getQualRun(db: Db, runId: number): QualRun | null {
  const row = db
    .prepare(
      "SELECT id, experiment_id, step_id, run_order, run_code, run_group, due_at, performed_at, responsible_user_id, done, exclude_from_analysis FROM qual_runs WHERE id = ?"
    )
    .get(runId) as QualRun | undefined;
  return row ?? null;
}

export function createQualRuns(
  db: Db,
  experimentId: number,
  stepId: number,
  count: number,
  runGroup = "default"
) {
  const current = db
    .prepare("SELECT COALESCE(MAX(run_order), 0) as max_order FROM qual_runs WHERE step_id = ?")
    .get(stepId) as { max_order: number };
  const step = db
    .prepare("SELECT step_number FROM qual_steps WHERE id = ?")
    .get(stepId) as { step_number: number } | undefined;
  const stepNumber = step?.step_number ?? stepId;
  const groupCount = db
    .prepare("SELECT COUNT(*) AS count FROM qual_runs WHERE step_id = ? AND run_group = ?")
    .get(stepId, runGroup) as { count: number };
  const groupPrefix: Record<string, string> = {
    rheology: "RH",
    thermal_hold: "TH",
    dsc: "DSC",
    tga: "TGA",
    moisture: "M"
  };
  const prefix = groupPrefix[runGroup] ?? "R";
  const insert = db.prepare(
    `INSERT INTO qual_runs (experiment_id, step_id, run_order, run_code, run_group, due_at, done, exclude_from_analysis)
     VALUES (?, ?, ?, ?, ?, NULL, 0, 0)`
  );
  for (let i = 1; i <= count; i += 1) {
    const order = current.max_order + i;
    const runCode = `E${experimentId}-Q${stepNumber}-${prefix}${String(groupCount.count + i).padStart(3, "0")}`;
    insert.run(experimentId, stepId, order, runCode, runGroup);
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

export function listQualRunSeries(db: Db, stepId: number) {
  const series = db.prepare(
    `SELECT id, experiment_id, step_id, run_id, series_code, contract_version,
            source_name, created_at, updated_at
     FROM qual_run_series WHERE step_id = ? ORDER BY run_id, series_code`
  ).all(stepId) as QualRunSeries[];
  const pointStmt = db.prepare(
    `SELECT id, series_id, point_order, x_value, y_value, extra_json
     FROM qual_run_series_points WHERE series_id = ? ORDER BY point_order`
  );
  return series.map((item) => ({
    ...item,
    points: pointStmt.all(item.id) as QualRunSeriesPoint[]
  }));
}

export function getQualRunSeries(db: Db, runId: number, seriesCode: string) {
  const series = db.prepare(
    `SELECT id, experiment_id, step_id, run_id, series_code, contract_version,
            source_name, created_at, updated_at
     FROM qual_run_series WHERE run_id = ? AND series_code = ?`
  ).get(runId, seriesCode) as QualRunSeries | undefined;
  if (!series) return null;
  const points = db.prepare(
    `SELECT id, series_id, point_order, x_value, y_value, extra_json
     FROM qual_run_series_points WHERE series_id = ? ORDER BY point_order`
  ).all(series.id) as QualRunSeriesPoint[];
  return { ...series, points };
}

export function replaceQualRunSeries(
  db: Db,
  input: {
    experimentId: number;
    stepId: number;
    runId: number;
    seriesCode: string;
    contractVersion: number;
    sourceName: string | null;
    points: Array<{ x: number; y: number; extraJson?: string | null }>;
  }
) {
  const replace = db.transaction(() => {
    db.prepare(
      `INSERT INTO qual_run_series
       (experiment_id, step_id, run_id, series_code, contract_version, source_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(run_id, series_code) DO UPDATE SET
         contract_version = excluded.contract_version,
         source_name = excluded.source_name,
         updated_at = datetime('now')`
    ).run(
      input.experimentId,
      input.stepId,
      input.runId,
      input.seriesCode,
      input.contractVersion,
      input.sourceName
    );
    const series = db.prepare(
      "SELECT id FROM qual_run_series WHERE run_id = ? AND series_code = ?"
    ).get(input.runId, input.seriesCode) as { id: number };
    db.prepare("DELETE FROM qual_run_series_points WHERE series_id = ?").run(series.id);
    const insertPoint = db.prepare(
      `INSERT INTO qual_run_series_points
       (series_id, point_order, x_value, y_value, extra_json) VALUES (?, ?, ?, ?, ?)`
    );
    input.points.forEach((point, index) => {
      insertPoint.run(series.id, index + 1, point.x, point.y, point.extraJson ?? null);
    });
    return series.id;
  });
  return replace();
}

export function deleteQualRunSeries(db: Db, runId: number, seriesCode: string) {
  db.prepare("DELETE FROM qual_run_series WHERE run_id = ? AND series_code = ?").run(runId, seriesCode);
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

export function updateQualRunMetadata(
  db: Db,
  runId: number,
  input: { performedAt: string | null; responsibleUserId: number | null }
) {
  db.prepare("UPDATE qual_runs SET performed_at = ?, responsible_user_id = ? WHERE id = ?").run(
    input.performedAt,
    input.responsibleUserId,
    runId
  );
}

export function listQualStepOutputs(db: Db, stepId: number): QualStepOutput[] {
  return db
    .prepare(
      `SELECT id, experiment_id, step_id, output_group, output_code, value_real, value_text, updated_at
       FROM qual_step_outputs WHERE step_id = ? ORDER BY output_group, output_code`
    )
    .all(stepId) as QualStepOutput[];
}

export function upsertQualStepOutput(
  db: Db,
  input: Omit<QualStepOutput, "id" | "updated_at">
) {
  db.prepare(
    `INSERT INTO qual_step_outputs
     (experiment_id, step_id, output_group, output_code, value_real, value_text, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(step_id, output_code) DO UPDATE SET
       output_group = excluded.output_group,
       value_real = excluded.value_real,
       value_text = excluded.value_text,
       updated_at = datetime('now')`
  ).run(
    input.experiment_id,
    input.step_id,
    input.output_group,
    input.output_code,
    input.value_real,
    input.value_text
  );
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
