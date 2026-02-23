import type { Db } from "../db.js";
import {
  createExperiment,
  getExperiment,
  getExperimentRecipes,
  getDesignMetadata,
  setExperimentRecipes,
  upsertDesignMetadata
} from "../repos/experiments_repo.js";
import { createDoeStudy, getDoeStudy } from "../repos/doe_repo.js";
import {
  createParamDefinition,
  listParamDefinitionsByKind,
  listParamConfigs,
  upsertParamConfig
} from "../repos/params_repo.js";
import { insertAnalysisField } from "../repos/analysis_repo.js";
import { deleteRunsForExperiment, insertRuns } from "../repos/runs_repo.js";
import type { ParamDefinition, ParamConfig } from "../repos/params_repo.js";
import { buildBbdDesign, buildFfaDesign, buildScreenDesign, buildSimDesign } from "../domain/designs.js";
import { stableHash } from "../lib/hash.js";

export type ExperimentCreateInput = {
  name: string;
  notes?: string | null;
  recipe_ids?: number[];
  machine_id?: number | null;
  owner_user_id?: number | null;
};

type DefaultFactorConfig = {
  code: string;
  mode: "RANGE" | "LIST";
  rangeMin?: number;
  rangeMax?: number;
  list?: number[];
  levelCount?: number | null;
};

export function getDefaultActiveFactors(designType: string): DefaultFactorConfig[] {
  if (designType === "BBD") {
    return [
      { code: "barrel_zone5", mode: "RANGE", rangeMin: 80, rangeMax: 120, levelCount: 3 },
      { code: "inj_speed", mode: "RANGE", rangeMin: 20, rangeMax: 50, levelCount: 3 },
      { code: "v_to_p_transfer", mode: "RANGE", rangeMin: 92, rangeMax: 98, levelCount: 3 }
    ];
  }
  if (designType === "FFA") {
    return [
      { code: "moisture_pct", mode: "LIST", list: [0, 1, 2], levelCount: 3 },
      { code: "inj_speed", mode: "LIST", list: [25, 40, 60], levelCount: 3 },
      { code: "hold_time", mode: "LIST", list: [2, 5, 8], levelCount: 3 }
    ];
  }
  if (designType === "SIM") {
    return [
      { code: "barrel_zone5", mode: "RANGE", rangeMin: 80, rangeMax: 120, levelCount: 2 },
      { code: "inj_speed", mode: "LIST", list: [25, 40, 60], levelCount: 3 }
    ];
  }
  return [
    { code: "mold_temp", mode: "RANGE", rangeMin: 40, rangeMax: 120, levelCount: 2 },
    { code: "inj_speed", mode: "RANGE", rangeMin: 25, rangeMax: 60, levelCount: 2 },
    { code: "hold_time", mode: "RANGE", rangeMin: 2, rangeMax: 8, levelCount: 2 },
    { code: "hold_press", mode: "RANGE", rangeMin: 200, rangeMax: 400, levelCount: 2 },
    { code: "v_to_p_transfer", mode: "RANGE", rangeMin: 92, rangeMax: 98, levelCount: 2 },
    { code: "cooling_time", mode: "RANGE", rangeMin: 10, rangeMax: 25, levelCount: 2 },
    { code: "back_pressure", mode: "RANGE", rangeMin: 20, rangeMax: 80, levelCount: 2 },
    { code: "nozzle_temp", mode: "RANGE", rangeMin: 150, rangeMax: 175, levelCount: 2 }
  ];
}

export function createExperimentWithDefaults(db: Db, input: ExperimentCreateInput): number {
  const experimentId = createExperiment(db, {
    name: input.name,
    design_type: "SIM",
    seed: 42,
    notes: input.notes ?? null,
    machine_id: input.machine_id ?? null,
    owner_user_id: input.owner_user_id ?? null,
    center_points: 3,
    max_runs: 200,
    replicate_count: 1,
    recipe_as_block: 0
  });
  setExperimentRecipes(db, experimentId, input.recipe_ids ?? []);
  return experimentId;
}

export function createDoeWithDefaults(
  db: Db,
  input: {
    experimentId: number;
    name: string;
    design_type: string;
    seed: number;
    center_points: number;
    max_runs: number;
    replicate_count: number;
    recipe_as_block: number;
  }
): number {
  const doeId = createDoeStudy(db, {
    experiment_id: input.experimentId,
    name: input.name,
    design_type: input.design_type,
    seed: input.seed,
    center_points: input.center_points,
    max_runs: input.max_runs,
    replicate_count: input.replicate_count,
    recipe_as_block: input.recipe_as_block
  });

  const inputParams = listParamDefinitionsByKind(db, input.experimentId, "INPUT");
  const defaultFactors = getDefaultActiveFactors(input.design_type);
  for (const factor of defaultFactors) {
    const param = inputParams.find((p) => p.code === factor.code);
    if (!param) continue;
    upsertParamConfig(db, {
      experiment_id: input.experimentId,
      doe_id: doeId,
      param_def_id: param.id,
      active: 1,
      mode: factor.mode,
      fixed_value_real: null,
      range_min_real: factor.mode === "RANGE" ? factor.rangeMin ?? null : null,
      range_max_real: factor.mode === "RANGE" ? factor.rangeMax ?? null : null,
      list_json: factor.mode === "LIST" ? JSON.stringify(factor.list ?? []) : null,
      level_count: factor.levelCount ?? null
    });
  }
  const outputParams = listParamDefinitionsByKind(db, input.experimentId, "OUTPUT");
  for (const output of outputParams) {
    insertAnalysisField(db, {
      scope_type: "DOE",
      scope_id: doeId,
      code: output.code,
      label: output.label,
      field_type: output.field_type,
      unit: output.unit,
      group_label: output.group_label,
      allowed_values_json: output.allowed_values_json,
      is_standard: 0,
      is_active: 1
    });
  }
  return doeId;
}

export function createCustomParam(
  db: Db,
  experimentId: number,
  data: Omit<ParamDefinition, "id" | "scope" | "experiment_id">
) {
  createParamDefinition(db, {
    scope: "EXPERIMENT",
    experiment_id: experimentId,
    code: data.code,
    label: data.label,
    unit: data.unit,
    field_kind: data.field_kind,
    field_type: data.field_type,
    group_label: data.group_label,
    allowed_values_json: data.allowed_values_json
  });
}

function configToFactor(config: ParamConfig, param: ParamDefinition) {
  const list = config.list_json ? (JSON.parse(config.list_json) as number[]) : null;
  return {
    paramDefId: param.id,
    code: param.code,
    label: param.label,
    mode: config.mode,
    rangeMin: config.range_min_real,
    rangeMax: config.range_max_real,
    list,
    levelCount: config.level_count,
    fixedValue: config.fixed_value_real
  };
}

export function generateRuns(db: Db, experimentId: number, doeId: number) {
  const experiment = getExperiment(db, experimentId);
  if (!experiment) throw new Error("Experiment not found");
  const doe = getDoeStudy(db, doeId);
  if (!doe) throw new Error("DOE not found");

  const inputParams = listParamDefinitionsByKind(db, experimentId, "INPUT");
  const outputParams = listParamDefinitionsByKind(db, experimentId, "OUTPUT");
  const configs = listParamConfigs(db, experimentId, doeId);
  const existingMeta = parseDesignMetadata(getDesignMetadata(db, experimentId, doeId));
  const nonRandomizedParamId =
    typeof existingMeta.non_randomized_param_id === "number"
      ? existingMeta.non_randomized_param_id
      : null;

  const activeFactors = configs
    .filter((config) => config.active === 1)
    .map((config) => ({
      config,
      param: inputParams.find((p) => p.id === config.param_def_id)
    }))
    .filter((entry) => entry.param != null) as Array<{ config: ParamConfig; param: ParamDefinition }>;

  const factorConfigs = activeFactors.map((entry) => {
    if (doe.design_type === "BBD" && entry.config.mode === "RANGE") {
      return configToFactor({ ...entry.config, level_count: 3 }, entry.param);
    }
    return configToFactor(entry.config, entry.param);
  });

  let designRuns: { values: Record<number, number>; coded?: Record<number, number> }[] = [];
  let metadata: Record<string, unknown> = {};

  if (doe.design_type === "SIM") {
    designRuns = buildSimDesign(factorConfigs, doe.seed, doe.max_runs);
    metadata = { design: "SIM", factors: factorConfigs };
  } else if (doe.design_type === "FFA") {
    designRuns = buildFfaDesign(factorConfigs, doe.seed, doe.max_runs);
    metadata = { design: "FFA", factors: factorConfigs };
  } else if (doe.design_type === "BBD") {
    const { runs, codedLevels } = buildBbdDesign(
      factorConfigs,
      doe.seed,
      doe.center_points
    );
    designRuns = runs;
    metadata = { design: "BBD", factors: factorConfigs, codedLevels };
  } else {
    designRuns = buildScreenDesign(factorConfigs, doe.seed, doe.max_runs);
    metadata = { design: "SCREEN_SAMPLE", factors: factorConfigs };
  }
  if (nonRandomizedParamId) {
    designRuns = applyNonRandomizedParamOrder(designRuns, nonRandomizedParamId);
  }

  const recipeIds = getExperimentRecipes(db, experimentId);
  const recipeBlock = doe.recipe_as_block === 1 && recipeIds.length > 0;
  const recipeList = recipeBlock
    ? recipeIds
    : recipeIds.length === 1
      ? [recipeIds[0]]
      : [null];

  const runsToInsert: Array<{
    run_order: number;
    run_code: string;
    recipe_id: number | null;
    replicate_key: string | null;
    replicate_index: number | null;
    done: number;
    exclude_from_analysis: number;
  }> = [];
  const valuesToInsert: Array<{
    run_id: number;
    param_def_id: number;
    value_real: number | null;
    value_text: string | null;
    value_tags_json: string | null;
  }> = [];

  let runOrder = 1;
  const inputMap = new Map<number, ParamDefinition>();
  inputParams.forEach((param) => inputMap.set(param.id, param));

  for (const recipeId of recipeList) {
    for (const baseRun of designRuns) {
      for (let r = 0; r < doe.replicate_count; r += 1) {
        const runCode = `E${experimentId}-R${String(runOrder).padStart(3, "0")}`;
        const replicateKey = buildReplicateKey(baseRun.values, recipeId, recipeBlock);
        runsToInsert.push({
          run_order: runOrder,
          run_code: runCode,
          recipe_id: recipeId,
          replicate_key: replicateKey,
          replicate_index: r + 1,
          done: 0,
          exclude_from_analysis: 0
        });

        for (const input of inputParams) {
          const config = configs.find((cfg) => cfg.param_def_id === input.id);
          const value = baseRun.values[input.id];
          const fallback = deriveFallbackValue(config);
          const finalValue = value ?? fallback ?? null;
          valuesToInsert.push({
            run_id: runOrder,
            param_def_id: input.id,
            value_real: finalValue,
            value_text: null,
            value_tags_json: null
          });
        }

        for (const output of outputParams) {
          valuesToInsert.push({
            run_id: runOrder,
            param_def_id: output.id,
            value_real: null,
            value_text: null,
            value_tags_json: null
          });
        }

        runOrder += 1;
      }
    }
  }

  deleteRunsForExperiment(db, doeId);
  insertRuns(db, experimentId, doeId, runsToInsert, valuesToInsert);
  upsertDesignMetadata(
    db,
    experimentId,
    doeId,
    JSON.stringify({ ...existingMeta, ...metadata, non_randomized_param_id: nonRandomizedParamId })
  );
}

function deriveFallbackValue(config: ParamConfig | undefined): number | null {
  if (!config) return null;
  if (config.mode === "FIXED") {
    return config.fixed_value_real ?? null;
  }
  if (config.mode === "RANGE") {
    const min = config.range_min_real;
    const max = config.range_max_real;
    if (min == null || max == null) return null;
    return (min + max) / 2;
  }
  if (config.mode === "LIST") {
    if (!config.list_json) return null;
    const list = JSON.parse(config.list_json) as number[];
    return list.length ? list[0] : null;
  }
  return null;
}

function applyNonRandomizedParamOrder(
  runs: Array<{ values: Record<number, number>; coded?: Record<number, number> }>,
  paramDefId: number
) {
  const indexed = runs.map((run, idx) => ({ run, idx }));
  indexed.sort((a, b) => {
    const aRaw = a.run.values[paramDefId];
    const bRaw = b.run.values[paramDefId];
    const aVal = Number.isFinite(aRaw) ? aRaw : Number.POSITIVE_INFINITY;
    const bVal = Number.isFinite(bRaw) ? bRaw : Number.POSITIVE_INFINITY;
    if (aVal !== bVal) return aVal < bVal ? -1 : 1;
    return a.idx - b.idx;
  });
  return indexed.map((item) => item.run);
}

function parseDesignMetadata(jsonBlob: string | null): Record<string, unknown> {
  if (!jsonBlob) return {};
  try {
    return JSON.parse(jsonBlob) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildReplicateKey(
  values: Record<number, number>,
  recipeId: number | null,
  includeRecipe: boolean
): string {
  const entries = Object.entries(values).sort((a, b) => Number(a[0]) - Number(b[0]));
  const payload = {
    values: entries,
    recipe_id: includeRecipe ? recipeId : null
  };
  return stableHash(JSON.stringify(payload));
}
