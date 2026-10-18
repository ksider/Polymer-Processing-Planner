import type { Db } from "../db.js";
import { listActiveAnalysisFields, upsertAnalysisRunValue } from "../repos/analysis_repo.js";
import { listDoeStudies } from "../repos/doe_repo.js";
import { listParamDefinitionsByKindForProcess, upsertParamConfig } from "../repos/params_repo.js";
import { listRuns, listRunValues, updateRunStatus } from "../repos/runs_repo.js";
import { createDoeWithDefaults, generateRuns } from "../services/experiments_service.js";

const DOE_NAME = "Demo DOE · SLA/DLP print-window screening";
const DOE_SEED = 20261019;

function valueFor(map: Map<string, number | null>, code: string) {
  return map.get(code) ?? 0;
}

function findOrCreateDoe(db: Db, experimentId: number) {
  const existing = listDoeStudies(db, experimentId).find((doe) =>
    doe.name === DOE_NAME && doe.seed === DOE_SEED && doe.design_type === "SCREEN"
  );
  const doeId = existing?.id ?? createDoeWithDefaults(db, {
    experimentId,
    name: DOE_NAME,
    design_type: "SCREEN",
    seed: DOE_SEED,
    center_points: 0,
    max_runs: 8,
    replicate_count: 1,
    recipe_as_block: 0
  });
  const byCode = new Map(
    listParamDefinitionsByKindForProcess(db, experimentId, "INPUT", "sla_dlp")
      .map((param) => [param.code, param])
  );
  const setRange = (code: string, min: number, max: number) => {
    const param = byCode.get(code);
    if (!param) throw new Error(`SLA/DLP demo DOE parameter is missing: ${code}`);
    upsertParamConfig(db, {
      experiment_id: experimentId, doe_id: doeId, param_def_id: param.id, active: 1,
      mode: "RANGE", fixed_value_real: null, range_min_real: min, range_max_real: max,
      list_json: null, level_count: 2
    });
  };
  const setFixed = (code: string, value: number) => {
    const param = byCode.get(code);
    if (!param) throw new Error(`SLA/DLP demo DOE parameter is missing: ${code}`);
    upsertParamConfig(db, {
      experiment_id: experimentId, doe_id: doeId, param_def_id: param.id, active: 1,
      mode: "FIXED", fixed_value_real: value, range_min_real: null, range_max_real: null,
      list_json: null, level_count: null
    });
  };
  // Derived from the qualification handoff rather than a database ID.
  setRange("resin_temp_c", 20, 30);
  setRange("exposure_time_s", 2.64, 3.16);
  setRange("lift_speed_mm_s", 0.8, 2.0);
  setFixed("layer_height_um", 50);
  setFixed("irradiance_mw_cm2", 5);
  setFixed("wait_before_exposure_s", 5);
  return doeId;
}

function seedResponses(db: Db, doeId: number) {
  const fields = new Map(listActiveAnalysisFields(db, doeId).map((field) => [field.code, field]));
  const inputRows = db.prepare(
    `SELECT p.id, p.code FROM param_definitions p
     WHERE p.field_kind = 'INPUT' AND p.scope = 'GLOBAL'`
  ).all() as Array<{ id: number; code: string }>;
  const inputCodes = new Map<number, string>(inputRows.map((row) => [row.id, row.code]));
  const response = (code: string, runId: number, value: number) => {
    const field = fields.get(code);
    if (field) upsertAnalysisRunValue(db, runId, field.id, Number(value.toFixed(3)), null, null);
  };

  listRuns(db, doeId).forEach((run, index) => {
    const factors = new Map<string, number | null>();
    listRunValues(db, run.id).forEach((item) => {
      const code = inputCodes.get(item.param_def_id);
      if (code) factors.set(code, item.value_real);
    });
    const temperature = valueFor(factors, "resin_temp_c");
    const exposure = valueFor(factors, "exposure_time_s");
    const lift = valueFor(factors, "lift_speed_mm_s");
    const exposureDelta = exposure - 2.87;
    const temperatureDelta = temperature - 25;
    const liftDelta = lift - 1.4;
    const wobble = ((index % 3) - 1) * 0.35;

    response("layer_uniformity_ok", run.id, Math.abs(exposureDelta) <= 0.22 && lift <= 1.8 ? 1 : 0);
    response("actual_layer_thickness_um", run.id, 50 + exposureDelta * 2.2 + wobble);
    response("xy_bleed_um", run.id, 24 + exposureDelta * 25 + temperatureDelta * 0.8 + wobble);
    response("minimum_open_channel_um", run.id, 240 - exposureDelta * 80 - liftDelta * 10 + wobble * 3);
    response("dimensional_error_um", run.id, 31 + Math.abs(exposureDelta) * 36 + Math.abs(temperatureDelta) * 1.2 + wobble);
    response("peel_force_n", run.id, 20 + lift * 10 + exposureDelta * 4 + wobble);
    response("green_tensile_strength_mpa", run.id, 3.6 + exposureDelta * 0.9 - liftDelta * 0.18 + wobble * 0.03);
    response("final_conversion_pct", run.id, 76 + exposureDelta * 7 + temperatureDelta * 0.15 + wobble);
    response("final_tg_c", run.id, 60 + exposureDelta * 4 + temperatureDelta * 0.1 + wobble);
    response("tensile_strength_mpa", run.id, 59 + exposureDelta * 5 - liftDelta * 0.4 + wobble);
    response("flexural_strength_mpa", run.id, 74 + exposureDelta * 3 + wobble);
    response("hdt_c", run.id, 74 + exposureDelta * 2 + temperatureDelta * 0.08 + wobble);
    updateRunStatus(db, run.id, 1, 0);
  });
}

/** Seeds a DOE inside the SLA/DLP demo found by the caller, never by fixed ID. */
export function seedSlaDlpDemoDoe(db: Db, experimentId: number) {
  const doeId = findOrCreateDoe(db, experimentId);
  generateRuns(db, experimentId, doeId);
  seedResponses(db, doeId);
  return doeId;
}
