import crypto from "node:crypto";
import type { Db } from "../../db.js";
import type { DoeStudy } from "../../repos/doe_repo.js";
import type {
  BuildDoeAnalysisDatasetOptions,
  DoeAnalysisCellValue,
  DoeAnalysisColumn,
  DoeAnalysisDataType,
  DoeAnalysisDataset,
  DoeAnalysisDatasetRow,
  DoeAnalysisDatasetWarning,
  DoeLegacyResponseAudit,
  DoeLegacyResponseAuditEntry,
  DoeLegacyResponseAuditStatus,
  DoeResponseValueSource
} from "./types.js";
import { DOE_ANALYSIS_DATASET_CONTRACT_VERSION } from "./types.js";

type FactorRecord = {
  config_id: number;
  param_id: number;
  code: string;
  label: string;
  unit: string | null;
  field_type: string;
  group_label: string | null;
  allowed_values_json: string | null;
  mode: "FIXED" | "RANGE" | "LIST";
  fixed_value_real: number | null;
  range_min_real: number | null;
  range_max_real: number | null;
  list_json: string | null;
  level_count: number | null;
};

type ResponseFieldRecord = {
  id: number;
  code: string;
  label: string;
  field_type: string;
  unit: string | null;
  group_label: string | null;
  allowed_values_json: string | null;
  is_active: number;
};

type RunRecord = {
  id: number;
  run_order: number;
  run_code: string;
  recipe_id: number | null;
  recipe_name: string | null;
  replicate_key: string | null;
  replicate_index: number | null;
  due_at: string | null;
  done: number;
  exclude_from_analysis: number;
};

type RunValueRecord = {
  run_id: number;
  param_def_id: number;
  code: string;
  field_kind: "INPUT" | "OUTPUT";
  field_type: string;
  value_real: number | null;
  value_text: string | null;
  value_tags_json: string | null;
};

type MeasurementRecord = {
  run_id: number;
  field_id: number;
  value_real: number | null;
  value_text: string | null;
  value_tags_json: string | null;
};

type DesignFactorMetadata = {
  paramDefId?: number;
  code?: string;
  mode?: string;
  rangeMin?: number | null;
  rangeMax?: number | null;
  list?: number[] | null;
  levelCount?: number | null;
  fixedValue?: number | null;
};

type ResolvedResponse = {
  value: DoeAnalysisCellValue;
  source: DoeResponseValueSource;
  auditStatus: DoeLegacyResponseAuditStatus;
  measurementValue: DoeAnalysisCellValue;
  legacyValues: DoeAnalysisCellValue[];
};

const META_COLUMNS: DoeAnalysisColumn[] = [
  metaColumn("run:id", "run_id", "Run ID", "number", "id"),
  metaColumn("run:code", "run_code", "Run", "text", "run_code"),
  metaColumn("run:order", "run_order", "Run Order", "number", "run_order"),
  metaColumn("run:done", "done", "Done", "boolean", "done"),
  metaColumn("run:excluded", "excluded", "Excluded", "boolean", "exclude_from_analysis"),
  metaColumn("run:due_at", "due_at", "Due Date", "date", "due_at"),
  {
    key: "recipe:id",
    code: "recipe_id",
    label: "Recipe ID",
    unit: null,
    dataType: "number",
    role: "meta",
    source: { kind: "recipe" },
    active: true,
    groupLabel: "Run",
    allowedValues: []
  },
  {
    key: "recipe:name",
    code: "recipe",
    label: "Recipe",
    unit: null,
    dataType: "category",
    role: "meta",
    source: { kind: "recipe" },
    active: true,
    groupLabel: "Run",
    allowedValues: []
  },
  replicateColumn("replicate:key", "replicate_key", "Replicate Key", "text", "replicate_key"),
  replicateColumn("replicate:index", "replicate_index", "Replicate Index", "number", "replicate_index")
];

export class DoeAnalysisDatasetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoeAnalysisDatasetNotFoundError";
  }
}

export function buildDoeAnalysisDataset(
  db: Db,
  experimentId: number,
  doeId: number,
  options: BuildDoeAnalysisDatasetOptions = {}
): DoeAnalysisDataset {
  const doe = db
    .prepare("SELECT * FROM doe_studies WHERE id = ? AND experiment_id = ?")
    .get(doeId, experimentId) as DoeStudy | undefined;
  if (!doe) {
    throw new DoeAnalysisDatasetNotFoundError("DOE study not found for this experiment");
  }

  const warnings: DoeAnalysisDatasetWarning[] = [];
  const designMetadata = readDesignMetadata(db, experimentId, doeId, warnings);
  const factorRows = loadFactors(db, experimentId, doeId);
  const factors = dedupeFactors(factorRows, warnings);
  const responses = loadResponses(db, doeId, options.includeInactiveResponses === true);
  const runs = loadRuns(db, doeId);
  const runValues = loadRunValues(db, doeId);
  const measurements = loadMeasurements(db, doeId);

  const designFactors = readDesignFactors(designMetadata);
  const factorColumns = factors.map((factor) => buildFactorColumn(factor, designFactors));
  const responseColumns = responses.map(buildResponseColumn);
  const columns = applyDoeRoles(
    [...META_COLUMNS.map(cloneColumn), ...factorColumns, ...responseColumns],
    doe.recipe_as_block === 1
  );

  const factorValueMap = buildFactorValueMap(runValues);
  const legacyResponseMap = buildLegacyResponseMap(runValues);
  const measurementMap = new Map(
    measurements.map((row) => [`${row.run_id}:${row.field_id}`, row])
  );
  const auditEntries: DoeLegacyResponseAuditEntry[] = [];

  const rows = runs.map((run) => {
    const values: Record<string, DoeAnalysisCellValue> = buildRunMetaValues(run);
    const codedValues: Record<string, number | null> = {};
    const responseSources: Record<string, DoeResponseValueSource> = {};

    for (let index = 0; index < factors.length; index += 1) {
      const factor = factors[index];
      const column = factorColumns[index];
      const rawRecord = factorValueMap.get(`${run.id}:${factor.param_id}`);
      const value = rawRecord ? parseStoredValue(rawRecord, factor.field_type) : null;
      values[column.key] = value;
      codedValues[column.key] = typeof value === "number"
        ? codeFactorValue(value, column.factor?.levels ?? [])
        : null;
    }

    for (let index = 0; index < responses.length; index += 1) {
      const response = responses[index];
      const column = responseColumns[index];
      const measurement = measurementMap.get(`${run.id}:${response.id}`);
      const legacyRecords = legacyResponseMap.get(`${run.id}:${response.code}`) ?? [];
      const resolved = resolveResponse(response.field_type, measurement, legacyRecords);
      values[column.key] = resolved.value;
      responseSources[column.key] = resolved.source;
      auditEntries.push({
        runId: run.id,
        runCode: run.run_code,
        responseFieldId: response.id,
        responseCode: response.code,
        responseLabel: response.label,
        status: resolved.auditStatus,
        measurementValue: resolved.measurementValue,
        legacyValues: resolved.legacyValues
      });
      if (resolved.auditStatus === "conflict") {
        warnings.push({
          code: "RESPONSE_STORAGE_CONFLICT",
          message: `Run ${run.run_code}: response ${response.label} differs between measurement and legacy storage.`,
          runId: run.id,
          responseFieldId: response.id
        });
      } else if (resolved.auditStatus === "ambiguous_legacy") {
        warnings.push({
          code: "AMBIGUOUS_LEGACY_RESPONSE",
          message: `Run ${run.run_code}: response ${response.label} has multiple different legacy values.`,
          runId: run.id,
          responseFieldId: response.id
        });
      }
    }

    return {
      runId: run.id,
      runCode: run.run_code,
      runOrder: run.run_order,
      done: run.done === 1,
      excluded: run.exclude_from_analysis === 1,
      dueAt: run.due_at,
      recipeId: run.recipe_id,
      recipeName: run.recipe_name,
      replicateKey: run.replicate_key,
      replicateIndex: run.replicate_index,
      values,
      codedValues,
      responseSources
    } satisfies DoeAnalysisDatasetRow;
  });

  const responseAudit = buildAudit(auditEntries);
  const datasetWithoutRevision = {
    contractVersion: DOE_ANALYSIS_DATASET_CONTRACT_VERSION,
    experimentId,
    doe: {
      id: doe.id,
      name: doe.name,
      designType: doe.design_type,
      seed: doe.seed,
      centerPoints: doe.center_points,
      maxRuns: doe.max_runs,
      replicateCount: doe.replicate_count,
      recipeAsBlock: doe.recipe_as_block === 1
    },
    designMetadata,
    columns,
    rows,
    responseAudit,
    warnings
  };

  return {
    ...datasetWithoutRevision,
    datasetRevision: calculateDatasetRevision(datasetWithoutRevision)
  };
}

export function auditLegacyDoeResponses(
  db: Db,
  experimentId: number,
  doeId: number
): DoeLegacyResponseAudit {
  return buildDoeAnalysisDataset(db, experimentId, doeId, {
    includeInactiveResponses: true
  }).responseAudit;
}

function metaColumn(
  key: string,
  code: string,
  label: string,
  dataType: DoeAnalysisDataType,
  field: string
): DoeAnalysisColumn {
  return {
    key,
    code,
    label,
    unit: null,
    dataType,
    role: "meta",
    source: { kind: "run", field },
    active: true,
    groupLabel: "Run",
    allowedValues: []
  };
}

function replicateColumn(
  key: string,
  code: string,
  label: string,
  dataType: DoeAnalysisDataType,
  field: string
): DoeAnalysisColumn {
  return {
    key,
    code,
    label,
    unit: null,
    dataType,
    role: "replicate",
    source: { kind: "replicate", field },
    active: true,
    groupLabel: "Run",
    allowedValues: []
  };
}

function cloneColumn(column: DoeAnalysisColumn): DoeAnalysisColumn {
  return {
    ...column,
    source: { ...column.source },
    allowedValues: column.allowedValues.slice(),
    factor: column.factor
      ? { ...column.factor, levels: column.factor.levels.slice() }
      : undefined
  };
}

function applyDoeRoles(columns: DoeAnalysisColumn[], recipeAsBlock: boolean): DoeAnalysisColumn[] {
  return columns.map((column) => {
    if (recipeAsBlock && (column.key === "recipe:id" || column.key === "recipe:name")) {
      return { ...column, role: "block" };
    }
    return column;
  });
}

function loadFactors(db: Db, experimentId: number, doeId: number): FactorRecord[] {
  return db
    .prepare(
      `SELECT pc.id AS config_id,
              p.id AS param_id,
              p.code,
              p.label,
              p.unit,
              p.field_type,
              p.group_label,
              p.allowed_values_json,
              pc.mode,
              pc.fixed_value_real,
              pc.range_min_real,
              pc.range_max_real,
              pc.list_json,
              pc.level_count
       FROM param_configs pc
       JOIN param_definitions p ON p.id = pc.param_def_id
       WHERE pc.experiment_id = ?
         AND pc.doe_id = ?
         AND pc.active = 1
         AND p.field_kind = 'INPUT'
       ORDER BY pc.id`
    )
    .all(experimentId, doeId) as FactorRecord[];
}

function dedupeFactors(
  factors: FactorRecord[],
  warnings: DoeAnalysisDatasetWarning[]
): FactorRecord[] {
  const byParamId = new Map<number, FactorRecord>();
  for (const factor of factors) {
    if (byParamId.has(factor.param_id)) {
      warnings.push({
        code: "DUPLICATE_FACTOR_CONFIG",
        message: `Factor ${factor.label} has more than one active configuration; the latest configuration is used.`
      });
    }
    byParamId.set(factor.param_id, factor);
  }
  return Array.from(byParamId.values());
}

function loadResponses(db: Db, doeId: number, includeInactive: boolean): ResponseFieldRecord[] {
  const activeClause = includeInactive ? "" : "AND is_active = 1";
  return db
    .prepare(
      `SELECT id, code, label, field_type, unit, group_label, allowed_values_json, is_active
       FROM analysis_fields
       WHERE scope_type = 'DOE' AND scope_id = ? ${activeClause}
       ORDER BY COALESCE(group_label, ''), label, id`
    )
    .all(doeId) as ResponseFieldRecord[];
}

function loadRuns(db: Db, doeId: number): RunRecord[] {
  return db
    .prepare(
      `SELECT r.id,
              r.run_order,
              r.run_code,
              r.recipe_id,
              recipes.name AS recipe_name,
              r.replicate_key,
              r.replicate_index,
              r.due_at,
              r.done,
              r.exclude_from_analysis
       FROM runs r
       LEFT JOIN recipes ON recipes.id = r.recipe_id
       WHERE r.doe_id = ?
       ORDER BY r.run_order, r.id`
    )
    .all(doeId) as RunRecord[];
}

function loadRunValues(db: Db, doeId: number): RunValueRecord[] {
  return db
    .prepare(
      `SELECT rv.run_id,
              rv.param_def_id,
              p.code,
              p.field_kind,
              p.field_type,
              rv.value_real,
              rv.value_text,
              rv.value_tags_json
       FROM run_values rv
       JOIN runs r ON r.id = rv.run_id
       JOIN param_definitions p ON p.id = rv.param_def_id
       WHERE r.doe_id = ?
       ORDER BY rv.run_id, rv.param_def_id`
    )
    .all(doeId) as RunValueRecord[];
}

function loadMeasurements(db: Db, doeId: number): MeasurementRecord[] {
  return db
    .prepare(
      `SELECT arv.run_id, arv.field_id, arv.value_real, arv.value_text, arv.value_tags_json
       FROM analysis_run_values arv
       JOIN runs r ON r.id = arv.run_id
       WHERE r.doe_id = ?
       ORDER BY arv.run_id, arv.field_id`
    )
    .all(doeId) as MeasurementRecord[];
}

function readDesignMetadata(
  db: Db,
  experimentId: number,
  doeId: number,
  warnings: DoeAnalysisDatasetWarning[]
): Record<string, unknown> {
  const row = db
    .prepare("SELECT json_blob FROM design_metadata WHERE experiment_id = ? AND doe_id = ?")
    .get(experimentId, doeId) as { json_blob: string } | undefined;
  if (!row?.json_blob) return {};
  try {
    const parsed = JSON.parse(row.json_blob) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A warning below keeps dataset construction usable for legacy rows.
  }
  warnings.push({
    code: "INVALID_DESIGN_METADATA",
    message: "Design metadata is not valid JSON and was ignored."
  });
  return {};
}

function readDesignFactors(metadata: Record<string, unknown>): DesignFactorMetadata[] {
  const factors = metadata.factors;
  if (!Array.isArray(factors)) return [];
  return factors.filter((factor): factor is DesignFactorMetadata =>
    Boolean(factor) && typeof factor === "object" && !Array.isArray(factor)
  );
}

function buildFactorColumn(
  factor: FactorRecord,
  metadataFactors: DesignFactorMetadata[]
): DoeAnalysisColumn {
  const metadata = metadataFactors.find((item) =>
    item.paramDefId === factor.param_id || item.code === factor.code
  );
  const mode = normalizeFactorMode(metadata?.mode) ?? factor.mode;
  const levels = factorLevels(factor, metadata, mode);
  return {
    key: `factor:${factor.param_id}`,
    code: factor.code,
    label: factor.label,
    unit: factor.unit,
    dataType: mapDataType(factor.field_type),
    role: "factor",
    source: { kind: "factor", paramDefinitionId: factor.param_id },
    active: true,
    groupLabel: factor.group_label,
    allowedValues: parseStringArray(factor.allowed_values_json),
    factor: {
      mode,
      levels,
      coding: levels.length === 2
        ? "two-level"
        : levels.length === 3
          ? "three-level"
          : mode === "FIXED"
            ? "fixed"
            : "none"
    }
  };
}

function buildResponseColumn(response: ResponseFieldRecord): DoeAnalysisColumn {
  return {
    key: `response:${response.id}`,
    code: response.code,
    label: response.label,
    unit: response.unit,
    dataType: mapDataType(response.field_type),
    role: "response",
    source: { kind: "response", analysisFieldId: response.id },
    active: response.is_active === 1,
    groupLabel: response.group_label,
    allowedValues: parseStringArray(response.allowed_values_json)
  };
}

function normalizeFactorMode(value: string | undefined): FactorRecord["mode"] | null {
  return value === "FIXED" || value === "RANGE" || value === "LIST" ? value : null;
}

function factorLevels(
  factor: FactorRecord,
  metadata: DesignFactorMetadata | undefined,
  mode: FactorRecord["mode"]
): number[] {
  if (mode === "LIST") {
    const metadataList = Array.isArray(metadata?.list)
      ? metadata.list.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
    if (metadataList.length) return uniqueNumbers(metadataList);
    return uniqueNumbers(parseNumberArray(factor.list_json));
  }
  if (mode === "RANGE") {
    const min = finiteNumber(metadata?.rangeMin) ?? finiteNumber(factor.range_min_real);
    const max = finiteNumber(metadata?.rangeMax) ?? finiteNumber(factor.range_max_real);
    if (min == null || max == null) return [];
    const levelCount = finiteNumber(metadata?.levelCount) ?? finiteNumber(factor.level_count);
    return levelCount === 3 ? uniqueNumbers([min, (min + max) / 2, max]) : uniqueNumbers([min, max]);
  }
  const fixed = finiteNumber(metadata?.fixedValue) ?? finiteNumber(factor.fixed_value_real);
  return fixed == null ? [] : [fixed];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function parseNumberArray(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  } catch {
    return [];
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function mapDataType(fieldType: string): DoeAnalysisDataType {
  if (fieldType === "number") return "number";
  if (fieldType === "boolean") return "boolean";
  if (fieldType === "tag") return "tags";
  return "text";
}

function buildFactorValueMap(runValues: RunValueRecord[]): Map<string, RunValueRecord> {
  const map = new Map<string, RunValueRecord>();
  for (const row of runValues) {
    if (row.field_kind === "INPUT") map.set(`${row.run_id}:${row.param_def_id}`, row);
  }
  return map;
}

function buildLegacyResponseMap(runValues: RunValueRecord[]): Map<string, RunValueRecord[]> {
  const map = new Map<string, RunValueRecord[]>();
  for (const row of runValues) {
    if (row.field_kind !== "OUTPUT") continue;
    const key = `${row.run_id}:${row.code}`;
    const rows = map.get(key) ?? [];
    rows.push(row);
    map.set(key, rows);
  }
  return map;
}

function buildRunMetaValues(run: RunRecord): Record<string, DoeAnalysisCellValue> {
  return {
    "run:id": run.id,
    "run:code": run.run_code,
    "run:order": run.run_order,
    "run:done": run.done === 1,
    "run:excluded": run.exclude_from_analysis === 1,
    "run:due_at": run.due_at,
    "recipe:id": run.recipe_id,
    "recipe:name": run.recipe_name,
    "replicate:key": run.replicate_key,
    "replicate:index": run.replicate_index
  };
}

function parseStoredValue(
  row: Pick<RunValueRecord | MeasurementRecord, "value_real" | "value_text" | "value_tags_json">,
  fieldType: string
): DoeAnalysisCellValue {
  if (fieldType === "tag") {
    if (row.value_tags_json == null) return null;
    try {
      const parsed = JSON.parse(row.value_tags_json) as unknown;
      if (!Array.isArray(parsed)) return null;
      return normalizeTags(parsed.map(String));
    } catch {
      return null;
    }
  }
  if (fieldType === "text") return row.value_text;
  if (fieldType === "boolean") {
    return row.value_real == null ? null : row.value_real !== 0;
  }
  return row.value_real != null && Number.isFinite(row.value_real) ? row.value_real : null;
}

function resolveResponse(
  fieldType: string,
  measurement: MeasurementRecord | undefined,
  legacyRecords: RunValueRecord[]
): ResolvedResponse {
  const measurementValue = measurement ? parseStoredValue(measurement, fieldType) : null;
  const legacyValues = legacyRecords
    .map((row) => parseStoredValue(row, row.field_type))
    .filter((value): value is Exclude<DoeAnalysisCellValue, null> => value !== null);
  const uniqueLegacyValues = uniqueCellValues(legacyValues);

  if (measurementValue !== null) {
    if (uniqueLegacyValues.length === 0) {
      return {
        value: measurementValue,
        source: "measurement",
        auditStatus: "measurement_only",
        measurementValue,
        legacyValues
      };
    }
    if (uniqueLegacyValues.length === 1 && cellValuesEqual(measurementValue, uniqueLegacyValues[0])) {
      return {
        value: measurementValue,
        source: "measurement",
        auditStatus: "equal",
        measurementValue,
        legacyValues
      };
    }
    return {
      value: measurementValue,
      source: "measurement_conflict",
      auditStatus: "conflict",
      measurementValue,
      legacyValues
    };
  }

  if (uniqueLegacyValues.length === 1) {
    return {
      value: uniqueLegacyValues[0],
      source: "legacy_run_value",
      auditStatus: "legacy_only",
      measurementValue,
      legacyValues
    };
  }
  if (uniqueLegacyValues.length > 1) {
    return {
      value: null,
      source: "ambiguous_legacy",
      auditStatus: "ambiguous_legacy",
      measurementValue,
      legacyValues
    };
  }
  return {
    value: null,
    source: "missing",
    auditStatus: "missing",
    measurementValue,
    legacyValues
  };
}

function uniqueCellValues(values: DoeAnalysisCellValue[]): DoeAnalysisCellValue[] {
  const unique: DoeAnalysisCellValue[] = [];
  for (const value of values) {
    if (!unique.some((existing) => cellValuesEqual(existing, value))) unique.push(value);
  }
  return unique;
}

function cellValuesEqual(left: DoeAnalysisCellValue, right: DoeAnalysisCellValue): boolean {
  if (typeof left === "number" && typeof right === "number") {
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    return Math.abs(left - right) <= Number.EPSILON * scale * 8;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const normalizedLeft = normalizeTags(left);
    const normalizedRight = normalizeTags(right);
    return normalizedLeft.length === normalizedRight.length &&
      normalizedLeft.every((item, index) => item === normalizedRight[index]);
  }
  return left === right;
}

function normalizeTags(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

function codeFactorValue(value: number, levels: number[]): number | null {
  if (levels.length === 1 && numbersClose(value, levels[0])) return 0;
  if (levels.length === 2) {
    if (numbersClose(value, levels[0])) return -1;
    if (numbersClose(value, levels[1])) return 1;
  }
  if (levels.length === 3) {
    if (numbersClose(value, levels[0])) return -1;
    if (numbersClose(value, levels[1])) return 0;
    if (numbersClose(value, levels[2])) return 1;
  }
  return null;
}

function numbersClose(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 8;
}

function buildAudit(entries: DoeLegacyResponseAuditEntry[]): DoeLegacyResponseAudit {
  const counts: Record<DoeLegacyResponseAuditStatus, number> = {
    measurement_only: 0,
    legacy_only: 0,
    equal: 0,
    conflict: 0,
    ambiguous_legacy: 0,
    missing: 0
  };
  for (const entry of entries) counts[entry.status] += 1;
  return {
    counts,
    entries,
    hasConflicts: counts.conflict > 0 || counts.ambiguous_legacy > 0,
    hasLegacyOnlyValues: counts.legacy_only > 0
  };
}

function calculateDatasetRevision(
  dataset: Omit<DoeAnalysisDataset, "datasetRevision">
): string {
  const statisticalValueKeys = new Set(
    dataset.columns
      .filter((column) => column.role === "factor" || column.role === "response")
      .map((column) => column.key)
  );
  const statisticalColumns = dataset.columns.map((column) => ({
    key: column.key,
    code: column.code,
    unit: column.unit,
    dataType: column.dataType,
    role: column.role,
    source: column.source,
    active: column.active,
    allowedValues: column.allowedValues,
    factor: column.factor
  }));
  const statisticalRows = dataset.rows.map((row) => ({
    runId: row.runId,
    runOrder: row.runOrder,
    done: row.done,
    excluded: row.excluded,
    recipeId: row.recipeId,
    replicateKey: row.replicateKey,
    replicateIndex: row.replicateIndex,
    values: Object.fromEntries(
      Object.entries(row.values).filter(([key]) => statisticalValueKeys.has(key))
    ),
    codedValues: row.codedValues
  }));
  const payload = stableStringify({
    contractVersion: dataset.contractVersion,
    experimentId: dataset.experimentId,
    doe: {
      id: dataset.doe.id,
      designType: dataset.doe.designType,
      seed: dataset.doe.seed,
      centerPoints: dataset.doe.centerPoints,
      replicateCount: dataset.doe.replicateCount,
      recipeAsBlock: dataset.doe.recipeAsBlock
    },
    designMetadata: dataset.designMetadata,
    columns: statisticalColumns,
    rows: statisticalRows
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) sorted[key] = sortForStableJson(object[key]);
  return sorted;
}
