import type { Db } from "../db.js";

export type AnalysisField = {
  id: number;
  scope_type: "GLOBAL" | "DOE";
  scope_id: number | null;
  code: string;
  label: string;
  field_type: "number" | "text" | "tag" | "boolean";
  unit: string | null;
  group_label: string | null;
  allowed_values_json: string | null;
  param_def_id?: number | null;
  is_standard: number;
  is_active: number;
};

export type AnalysisRunValue = {
  run_id: number;
  field_id: number;
  value_real: number | null;
  value_text: string | null;
  value_tags_json: string | null;
};

export function listStandardAnalysisFields(db: Db): AnalysisField[] {
  return db
    .prepare(
      `SELECT * FROM analysis_fields
       WHERE scope_type = 'GLOBAL' AND is_standard = 1
       ORDER BY COALESCE(group_label, ''), label, id`
    )
    .all() as AnalysisField[];
}

export function listExperimentAnalysisFields(db: Db, doeId: number): AnalysisField[] {
  return db
    .prepare(
      `SELECT * FROM analysis_fields
       WHERE scope_type = 'DOE' AND scope_id = ?
       ORDER BY COALESCE(group_label, ''), label, id`
    )
    .all(doeId) as AnalysisField[];
}

export function listActiveAnalysisFields(db: Db, doeId: number): AnalysisField[] {
  return db
    .prepare(
      `SELECT * FROM analysis_fields
       WHERE scope_type = 'DOE' AND scope_id = ? AND is_active = 1
       ORDER BY COALESCE(group_label, ''), label, id`
    )
    .all(doeId) as AnalysisField[];
}

export function findExperimentAnalysisFieldByCode(
  db: Db,
  doeId: number,
  code: string
): AnalysisField | undefined {
  return db
    .prepare(
      `SELECT * FROM analysis_fields
       WHERE scope_type = 'DOE' AND scope_id = ? AND code = ?`
    )
    .get(doeId, code) as AnalysisField | undefined;
}

export function insertAnalysisField(db: Db, field: Omit<AnalysisField, "id">) {
  return db
    .prepare(
      `INSERT INTO analysis_fields
       (scope_type, scope_id, doe_id, code, label, field_type, unit, group_label, allowed_values_json, param_def_id, is_standard, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      field.scope_type,
      field.scope_id,
      field.scope_type === "DOE" ? field.scope_id : null,
      field.code,
      field.label,
      field.field_type,
      field.unit,
      field.group_label,
      field.allowed_values_json,
      field.param_def_id ?? null,
      field.is_standard,
      field.is_active
    );
}

export function updateAnalysisFieldActive(db: Db, id: number, isActive: number) {
  db.prepare("UPDATE analysis_fields SET is_active = ? WHERE id = ?").run(isActive, id);
}

export function updateAnalysisField(
  db: Db,
  id: number,
  updates: {
    label: string;
    unit: string | null;
    group_label: string | null;
    allowed_values_json: string | null;
    is_active: number;
  }
) {
  db.prepare(
    `UPDATE analysis_fields
     SET label = ?, unit = ?, group_label = ?, allowed_values_json = ?, is_active = ?
     WHERE id = ?`
  ).run(
    updates.label,
    updates.unit,
    updates.group_label,
    updates.allowed_values_json,
    updates.is_active,
    id
  );
}

export function listAnalysisRunValuesByRunId(db: Db, runId: number): AnalysisRunValue[] {
  return db
    .prepare("SELECT * FROM analysis_run_values WHERE run_id = ?")
    .all(runId) as AnalysisRunValue[];
}

export function listTagValuesForExperimentField(
  db: Db,
  doeId: number,
  fieldId: number
): string[] {
  const rows = db
    .prepare(
      `SELECT v.value_tags_json
       FROM analysis_run_values v
       JOIN runs r ON r.id = v.run_id
       WHERE r.doe_id = ? AND v.field_id = ? AND v.value_tags_json IS NOT NULL`
    )
    .all(doeId, fieldId) as { value_tags_json: string }[];
  const tagSet = new Set<string>();
  rows.forEach((row) => {
    try {
      const parsed = JSON.parse(row.value_tags_json);
      if (Array.isArray(parsed)) {
        parsed.forEach((tag) => {
          const cleaned = String(tag || "").trim();
          if (cleaned) tagSet.add(cleaned);
        });
      }
    } catch {
      // Ignore invalid JSON rows.
    }
  });
  return Array.from(tagSet.values()).sort((a, b) => a.localeCompare(b));
}

export function listAnalysisRunValuesByRunIds(
  db: Db,
  runIds: number[]
): AnalysisRunValue[] {
  return db
    .prepare(
      `SELECT * FROM analysis_run_values
       WHERE run_id IN (${runIds.map(() => "?").join(",") || "NULL"})`
    )
    .all(...runIds) as AnalysisRunValue[];
}

export function upsertAnalysisRunValue(
  db: Db,
  runId: number,
  fieldId: number,
  valueReal: number | null,
  valueText: string | null,
  valueTagsJson: string | null
) {
  db.prepare(
    `INSERT INTO analysis_run_values
     (run_id, field_id, value_real, value_text, value_tags_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, field_id) DO UPDATE SET
       value_real = excluded.value_real,
       value_text = excluded.value_text,
       value_tags_json = excluded.value_tags_json`
  ).run(runId, fieldId, valueReal, valueText, valueTagsJson);
}
