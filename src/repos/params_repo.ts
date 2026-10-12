import type { Db } from "../db.js";

export type ParamDefinition = {
  id: number;
  scope: "GLOBAL" | "EXPERIMENT";
  experiment_id: number | null;
  code: string;
  label: string;
  unit: string | null;
  field_kind: "INPUT" | "OUTPUT";
  field_type: "number" | "text" | "tag" | "boolean";
  group_label: string | null;
  allowed_values_json: string | null;
  semantic_role?: "controlled" | "measurement" | "derived" | "constraint" | "response";
  doe_role?: "factor" | "response" | "constraint" | "none";
  is_code_owned?: number;
};

export type CanonicalParamDefinition = Omit<ParamDefinition, "id" | "scope" | "experiment_id"> & {
  process_type_codes?: string[];
  tags?: string[];
};

export type ParamConfig = {
  id: number;
  experiment_id: number;
  doe_id: number | null;
  param_def_id: number;
  active: number;
  mode: "FIXED" | "RANGE" | "LIST";
  fixed_value_real: number | null;
  range_min_real: number | null;
  range_max_real: number | null;
  list_json: string | null;
  level_count: number | null;
};

export function listParamDefinitions(db: Db, experimentId: number): ParamDefinition[] {
  return db
    .prepare(
      `SELECT * FROM param_definitions
       WHERE scope = 'GLOBAL' OR (scope = 'EXPERIMENT' AND experiment_id = ?)
       ORDER BY group_label, id`
    )
    .all(experimentId) as ParamDefinition[];
}

/**
 * Returns the shared catalogue as applicable to a process. Parameters without
 * process links are intentionally universal: this is how user-defined
 * parameters remain reusable until an administrator narrows their scope.
 */
export function listParamDefinitionsForProcess(
  db: Db,
  experimentId: number,
  processTypeCode: string
): ParamDefinition[] {
  return db.prepare(
    `SELECT p.* FROM param_definitions p
     WHERE (p.scope = 'GLOBAL' OR (p.scope = 'EXPERIMENT' AND p.experiment_id = ?))
       AND (
         NOT EXISTS (SELECT 1 FROM param_process_types any_pt WHERE any_pt.param_def_id = p.id)
         OR EXISTS (
           SELECT 1
           FROM param_process_types pt
           JOIN process_types process_type ON process_type.id = pt.process_type_id
           WHERE pt.param_def_id = p.id AND lower(process_type.code) = lower(?)
         )
       )
     ORDER BY p.group_label, p.id`
  ).all(experimentId, processTypeCode) as ParamDefinition[];
}

export function listParamDefinitionsByKind(
  db: Db,
  experimentId: number,
  kind: "INPUT" | "OUTPUT"
): ParamDefinition[] {
  return db
    .prepare(
      `SELECT * FROM param_definitions
       WHERE field_kind = ? AND (scope = 'GLOBAL' OR (scope = 'EXPERIMENT' AND experiment_id = ?))
       ORDER BY group_label, id`
    )
    .all(kind, experimentId) as ParamDefinition[];
}

export function listParamDefinitionsByKindForProcess(
  db: Db,
  experimentId: number,
  kind: "INPUT" | "OUTPUT",
  processTypeCode: string
): ParamDefinition[] {
  return listParamDefinitionsForProcess(db, experimentId, processTypeCode)
    .filter((param) => param.field_kind === kind);
}

export function listGlobalParamDefinitions(db: Db): ParamDefinition[] {
  return db
    .prepare(
      `SELECT * FROM param_definitions
       WHERE scope = 'GLOBAL'
       ORDER BY group_label, id`
    )
    .all() as ParamDefinition[];
}

export function getParamDefinition(db: Db, id: number): ParamDefinition | undefined {
  return db.prepare("SELECT * FROM param_definitions WHERE id = ?").get(id) as
    | ParamDefinition
    | undefined;
}

export function findGlobalParamByCode(db: Db, code: string): ParamDefinition | undefined {
  return db.prepare("SELECT * FROM param_definitions WHERE scope = 'GLOBAL' AND code = ? LIMIT 1")
    .get(code) as ParamDefinition | undefined;
}

/** Makes one catalogue item available in a process without copying it. */
export function attachParamToProcess(db: Db, paramDefId: number, processTypeCode: string) {
  const processType = db.prepare(
    "SELECT id FROM process_types WHERE lower(code) = lower(?) LIMIT 1"
  ).get(processTypeCode) as { id: number } | undefined;
  if (!processType) return;
  db.prepare(
    "INSERT OR IGNORE INTO param_process_types (param_def_id, process_type_id) VALUES (?, ?)"
  ).run(paramDefId, processType.id);
}

/** Upsert the shared catalogue record and its process/tag metadata. */
export function upsertCanonicalParamDefinition(db: Db, def: CanonicalParamDefinition): number {
  const existing = findGlobalParamByCode(db, def.code);
  let id: number;
  if (existing) {
    id = existing.id;
    // Never replace a legacy/shared parameter's presentation with an
    // extrusion-only label. Its identity may be shared with compounding (for
    // example screw speed or throughput). Code-owned records can be refreshed
    // from the template; existing user and legacy records retain their label,
    // unit, kind and group.
    const presentation = existing.is_code_owned === 1 ? def : existing;
    db.prepare(
      `UPDATE param_definitions
       SET label = ?, unit = ?, field_kind = ?, field_type = ?, group_label = ?, allowed_values_json = ?,
           semantic_role = ?, doe_role = ?, is_code_owned = ?
       WHERE id = ?`
    ).run(
      presentation.label, presentation.unit ?? null, presentation.field_kind, presentation.field_type,
      presentation.group_label ?? null, presentation.allowed_values_json ?? null,
      def.semantic_role ?? existing.semantic_role ?? "measurement", def.doe_role ?? existing.doe_role ?? "none",
      existing.is_code_owned === 1 ? (def.is_code_owned ?? 1) : 0, id
    );
  } else {
    id = createParamDefinition(db, {
      scope: "GLOBAL", experiment_id: null, code: def.code, label: def.label, unit: def.unit ?? null,
      field_kind: def.field_kind, field_type: def.field_type, group_label: def.group_label ?? null,
      allowed_values_json: def.allowed_values_json ?? null, semantic_role: def.semantic_role ?? "measurement",
      doe_role: def.doe_role ?? "none", is_code_owned: def.is_code_owned ?? 1
    });
  }
  const insertTag = db.prepare("INSERT OR IGNORE INTO param_tags (param_def_id, tag) VALUES (?, ?)");
  [...new Set((def.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
    .forEach((tag) => insertTag.run(id, tag));
  const processTypes = db.prepare("SELECT id, code FROM process_types").all() as Array<{ id: number; code: string }>;
  const wanted = new Set((def.process_type_codes ?? []).map((code) => code.toLowerCase()));
  const insertProcess = db.prepare("INSERT OR IGNORE INTO param_process_types (param_def_id, process_type_id) VALUES (?, ?)");
  processTypes.filter((type) => wanted.has(type.code.toLowerCase())).forEach((type) => insertProcess.run(id, type.id));
  return id;
}

export function listParamConfigs(db: Db, experimentId: number, doeId: number): ParamConfig[] {
  return db
    .prepare("SELECT * FROM param_configs WHERE experiment_id = ? AND doe_id = ? ORDER BY id")
    .all(experimentId, doeId) as ParamConfig[];
}

export function getParamConfig(
  db: Db,
  experimentId: number,
  doeId: number,
  paramDefId: number
): ParamConfig | undefined {
  return db
    .prepare(
      "SELECT * FROM param_configs WHERE experiment_id = ? AND doe_id = ? AND param_def_id = ?"
    )
    .get(experimentId, doeId, paramDefId) as ParamConfig | undefined;
}

export function upsertParamConfig(db: Db, config: Omit<ParamConfig, "id">) {
  const existing = getParamConfig(db, config.experiment_id, config.doe_id ?? 0, config.param_def_id);
  if (existing) {
    db.prepare(
      `UPDATE param_configs
       SET active = ?, mode = ?, fixed_value_real = ?, range_min_real = ?, range_max_real = ?, list_json = ?, level_count = ?
       WHERE id = ?`
    ).run(
      config.active,
      config.mode,
      config.fixed_value_real,
      config.range_min_real,
      config.range_max_real,
      config.list_json,
      config.level_count,
      existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO param_configs
       (experiment_id, doe_id, param_def_id, active, mode, fixed_value_real, range_min_real, range_max_real, list_json, level_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      config.experiment_id,
      config.doe_id,
      config.param_def_id,
      config.active,
      config.mode,
      config.fixed_value_real,
      config.range_min_real,
      config.range_max_real,
      config.list_json,
      config.level_count
    );
  }
}

export function deleteParamConfig(db: Db, experimentId: number, doeId: number, paramDefId: number) {
  db.prepare(
    "DELETE FROM param_configs WHERE experiment_id = ? AND doe_id = ? AND param_def_id = ?"
  ).run(experimentId, doeId, paramDefId);
}

export function createParamDefinition(db: Db, def: Omit<ParamDefinition, "id">): number {
  const result = db
    .prepare(
      `INSERT INTO param_definitions
       (scope, experiment_id, code, label, unit, field_kind, field_type, group_label, allowed_values_json, semantic_role, doe_role, is_code_owned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      def.scope,
      def.experiment_id,
      def.code,
      def.label,
      def.unit ?? null,
      def.field_kind,
      def.field_type,
      def.group_label ?? null,
      def.allowed_values_json ?? null,
      def.semantic_role ?? "measurement",
      def.doe_role ?? "none",
      def.is_code_owned ?? 0
    );
  return Number(result.lastInsertRowid);
}

export function updateAllowedValues(db: Db, paramDefId: number, allowedValuesJson: string | null) {
  db.prepare("UPDATE param_definitions SET allowed_values_json = ? WHERE id = ?").run(
    allowedValuesJson,
    paramDefId
  );
}

export function updateParamDefinition(
  db: Db,
  id: number,
  updates: Partial<Omit<ParamDefinition, "id" | "scope" | "experiment_id">>
) {
  const current = getParamDefinition(db, id);
  if (!current || current.scope !== "GLOBAL") return;
  const next = { ...current, ...updates };
  db.prepare(
    `UPDATE param_definitions
     SET code = ?, label = ?, unit = ?, field_kind = ?, field_type = ?, group_label = ?, allowed_values_json = ?, semantic_role = ?, doe_role = ?, is_code_owned = ?
     WHERE id = ?`
  ).run(
    next.code,
    next.label,
    next.unit ?? null,
    next.field_kind,
    next.field_type,
    next.group_label ?? null,
    next.allowed_values_json ?? null,
    next.semantic_role ?? "measurement",
    next.doe_role ?? "none",
    next.is_code_owned ?? 0,
    id
  );
}

export function deleteParamDefinition(db: Db, id: number) {
  const current = getParamDefinition(db, id);
  if (!current || current.scope !== "GLOBAL") return;
  db.prepare("DELETE FROM param_definitions WHERE id = ?").run(id);
}
