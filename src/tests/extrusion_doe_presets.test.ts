import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import { listExperimentAnalysisFields } from "../repos/analysis_repo.js";
import { getDoeStudy } from "../repos/doe_repo.js";
import { listParamConfigs, listParamDefinitionsByKindForProcess, listParamDefinitionsForProcess } from "../repos/params_repo.js";
import { listQualSteps, upsertQualSummary } from "../repos/qual_repo.js";
import { listRuns } from "../repos/runs_repo.js";
import { createCustomParam, createDoeWithDefaults, createExperimentWithDefaults, generateRuns } from "../services/experiments_service.js";
import { getExtrusionDoePreset, getExtrusionPresetPrerequisiteWarnings } from "../services/extrusion_doe_presets.js";
import { ensureQualificationDefaults, setOptionalQualificationStudyEnabled } from "../services/qualification_service.js";
import { ensureSeedParams } from "../services/seed.js";
import { buildDoeAnalysisDataset, createAnalyticsRequest, defaultAnalysisSpecification } from "../modules/doe_analysis/index.js";

test("extrusion DOE CCD preset uses catalogue parameters and produces its declared run count", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-extrusion-doe-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  const db = openDb();
  try {
    ensureSeedParams(db);
    const extrusionProcess = db.prepare(
      `SELECT process.id
       FROM processes process
       JOIN process_types type ON type.id = process.process_type_id
       WHERE type.code = 'extrusion_v1'
       LIMIT 1`
    ).get() as { id: number } | undefined;
    assert.ok(extrusionProcess, "extrusion process is seeded");

    const experimentId = createExperimentWithDefaults(db, {
      name: "Glass fibre DOE preset",
      process_id: extrusionProcess!.id
    });
    ensureQualificationDefaults(db, experimentId);
    setOptionalQualificationStudyEnabled(db, experimentId, 6, true);

    const preset = getExtrusionDoePreset("pa_glass_fibre_ccd");
    assert.ok(preset);
    const initialWarnings = getExtrusionPresetPrerequisiteWarnings(db, experimentId, preset!);
    assert.ok(initialWarnings.some((warning) => warning.includes("no saved result")));

    for (const step of listQualSteps(db, experimentId)) {
      if (preset!.requiredSteps.includes(step.step_number)) {
        upsertQualSummary(db, experimentId, step.step_number, JSON.stringify({ accepted: true }));
      }
    }
    assert.deepEqual(getExtrusionPresetPrerequisiteWarnings(db, experimentId, preset!), []);

    const doeId = createDoeWithDefaults(db, {
      experimentId,
      name: preset!.title,
      design_type: preset!.designType,
      seed: 42,
      center_points: preset!.centerPoints,
      max_runs: preset!.maxRuns,
      replicate_count: 1,
      recipe_as_block: 0,
      preset_code: preset!.code
    });
    assert.equal(getDoeStudy(db, doeId)?.design_type, "CCD");

    const inputById = new Map(
      listParamDefinitionsByKindForProcess(db, experimentId, "INPUT", "extrusion_v1")
        .map((param) => [param.id, param.code])
    );
    const configs = listParamConfigs(db, experimentId, doeId);
    const activeFactorCodes = configs
      .filter((config) => config.active === 1 && config.mode === "RANGE")
      .map((config) => inputById.get(config.param_def_id))
      .filter((code): code is string => Boolean(code));
    assert.deepEqual(activeFactorCodes.sort(), [
      "fibre_feed_zone_temp_c", "screw_speed_rpm", "throughput_kg_h"
    ]);
    const glassFibreConfig = configs.find((config) => inputById.get(config.param_def_id) === "glass_fibre_loading_wt_pct");
    assert.equal(glassFibreConfig?.mode, "FIXED");
    assert.equal(glassFibreConfig?.fixed_value_real, 30);

    const responseCodes = new Set(
      listExperimentAnalysisFields(db, doeId)
        .filter((field) => field.is_active === 1)
        .map((field) => field.code)
    );
    assert.deepEqual(responseCodes, new Set(preset!.responseCodes));

    generateRuns(db, experimentId, doeId);
    assert.equal(listRuns(db, doeId).length, 18);
    const ccdDataset = buildDoeAnalysisDataset(db, experimentId, doeId);
    const ccdFactorCodes = ccdDataset.columns
      .filter((column) => column.role === "factor")
      .map((column) => column.code)
      .sort();
    assert.deepEqual(ccdFactorCodes, ["fibre_feed_zone_temp_c", "screw_speed_rpm", "throughput_kg_h"]);
    assert.equal(ccdFactorCodes.includes("glass_fibre_loading_wt_pct"), false, "fixed conditions are not model factors");
    const defaultSpecification = defaultAnalysisSpecification(ccdDataset);
    const factorBounds = Object.fromEntries(defaultSpecification.factorKeys.map((key) => {
      const levels = ccdDataset.columns.find((column) => column.key === key)?.factor?.levels ?? [];
      return [key, { min: levels[0]!, max: levels[levels.length - 1]! }];
    }));
    assert.doesNotThrow(() => createAnalyticsRequest(ccdDataset, {
      ...defaultSpecification,
      optimization: { objective: "maximize", factorBounds }
    }));

    const injectionOnly = db.prepare(
      `SELECT parameter.*
       FROM param_definitions parameter
       JOIN param_process_types injection_link ON injection_link.param_def_id = parameter.id
       JOIN process_types injection_type ON injection_type.id = injection_link.process_type_id AND injection_type.code = 'injection'
       WHERE parameter.scope = 'GLOBAL'
         AND NOT EXISTS (
           SELECT 1 FROM param_process_types extrusion_link
           JOIN process_types extrusion_type ON extrusion_type.id = extrusion_link.process_type_id AND extrusion_type.code = 'extrusion_v1'
           WHERE extrusion_link.param_def_id = parameter.id
         )
       LIMIT 1`
    ).get() as { code: string; label: string; unit: string | null; field_kind: "INPUT" | "OUTPUT"; field_type: "number" | "text" | "tag" | "boolean"; group_label: string | null; allowed_values_json: string | null } | undefined;
    assert.ok(injectionOnly, "fixture includes a parameter initially attached to another process");
    createCustomParam(db, experimentId, injectionOnly!);
    assert.ok(
      listParamDefinitionsForProcess(db, experimentId, "extrusion_v1")
        .some((parameter) => parameter.code === injectionOnly!.code),
      "a selected repository parameter becomes applicable to the current process without a copied definition"
    );

    const screeningPreset = getExtrusionDoePreset("filled_mineral_dispersion_screening")!;
    const screeningDoeId = createDoeWithDefaults(db, {
      experimentId,
      name: screeningPreset.title,
      design_type: screeningPreset.designType,
      seed: 42,
      center_points: screeningPreset.centerPoints,
      max_runs: screeningPreset.maxRuns,
      replicate_count: 1,
      recipe_as_block: 0,
      preset_code: screeningPreset.code
    });
    generateRuns(db, experimentId, screeningDoeId);
    assert.equal(listRuns(db, screeningDoeId).length, 11, "screening retains its reviewed run cap");

    setOptionalQualificationStudyEnabled(db, experimentId, 8, true);
    setOptionalQualificationStudyEnabled(db, experimentId, 9, true);
    upsertQualSummary(db, experimentId, 8, JSON.stringify({ accepted: true }));
    upsertQualSummary(db, experimentId, 9, JSON.stringify({ accepted: true }));
    const reactivePreset = getExtrusionDoePreset("pp_g_mah_reactive_bbd")!;
    assert.deepEqual(getExtrusionPresetPrerequisiteWarnings(db, experimentId, reactivePreset), []);
    const reactiveDoeId = createDoeWithDefaults(db, {
      experimentId,
      name: reactivePreset.title,
      design_type: reactivePreset.designType,
      seed: 42,
      center_points: reactivePreset.centerPoints,
      max_runs: reactivePreset.maxRuns,
      replicate_count: 1,
      recipe_as_block: 0,
      preset_code: reactivePreset.code
    });
    generateRuns(db, experimentId, reactiveDoeId);
    assert.equal(listRuns(db, reactiveDoeId).length, 15, "BBD has twelve edge and three centre runs");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
