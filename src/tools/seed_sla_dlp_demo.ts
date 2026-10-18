import { fileURLToPath } from "node:url";
import path from "node:path";
import { openDb, type Db } from "../db.js";
import {
  createQualRuns,
  deleteQualRunSeries,
  getQualStep,
  listQualFields,
  listQualRuns,
  replaceQualRunSeries,
  updateQualRunFlags,
  updateQualRunMetadata,
  updateQualStepStatus,
  upsertQualStepSettings,
  upsertQualStepOutput,
  type QualField,
  type QualRun
} from "../repos/qual_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import {
  ensureQualificationDefaults,
  normalizeSlaDlpPostCureRuns,
  getQualificationOutputDefinitionsForExperiment,
  recomputeDerivedAndSummary,
  saveQualRunValue,
  setOptionalQualificationStudyEnabled
} from "../services/qualification_service.js";
import { ensureSeedParams } from "../services/seed.js";

const DEMO_MARKER = "demo-seed:sla-dlp";
const DEMO_NAME = "Photopolymerization demo · 405 nm engineering resin";
const COMPLETED_AT = "2026-10-15";

type RunValues = Record<string, number | boolean | string | string[]>;
type OutputValues = Record<string, number | string>;

function getProcessId(db: Db) {
  const row = db.prepare(
    `SELECT process.id
     FROM processes process
     JOIN process_types type ON type.id = process.process_type_id
     WHERE lower(type.code) = 'sla_dlp' AND process.status = 'active'
     ORDER BY process.id LIMIT 1`
  ).get() as { id: number } | undefined;
  if (!row) throw new Error("The SLA/DLP process is not available in this database.");
  return row.id;
}

function getDemoOwnerId(db: Db) {
  const configured = String(process.env.DEMO_USER_EMAIL || "").trim().toLowerCase();
  const candidates = [configured, "demo@demo.com", "demo@demo.local"].filter(Boolean);
  for (const email of candidates) {
    const row = db.prepare(
      "SELECT id FROM users WHERE lower(email) = ? AND status = 'ACTIVE' LIMIT 1"
    ).get(email) as { id: number } | undefined;
    if (row) return row.id;
  }
  return null;
}

function getDemoExperimentId(db: Db, processId: number, ownerId: number | null) {
  const existing = db.prepare("SELECT id FROM experiments WHERE notes = ? ORDER BY id LIMIT 1")
    .get(DEMO_MARKER) as { id: number } | undefined;
  if (existing) return existing.id;
  return createExperimentWithDefaults(db, {
    name: DEMO_NAME,
    notes: DEMO_MARKER,
    process_id: processId,
    owner_user_id: ownerId
  });
}

function ensureRuns(db: Db, experimentId: number, stepId: number, count: number) {
  const current = listQualRuns(db, stepId);
  if (current.length < count) createQualRuns(db, experimentId, stepId, count - current.length);
  return listQualRuns(db, stepId);
}

function fillRun(db: Db, fields: QualField[], run: QualRun, values: RunValues, ownerId: number | null) {
  const byCode = new Map(fields.map((field) => [field.code, field]));
  for (const [code, value] of Object.entries(values)) {
    const field = byCode.get(code);
    if (!field) throw new Error(`Missing SLA/DLP demo field: ${code}`);
    saveQualRunValue(db, run.id, field.id, field.field_type, value);
  }
  updateQualRunMetadata(db, run.id, { performedAt: COMPLETED_AT, responsibleUserId: ownerId });
  updateQualRunFlags(db, run.id, 1, 0);
}

function putOutputs(db: Db, experimentId: number, stepId: number, stepNumber: number, values: OutputValues) {
  const definitions = new Map(
    getQualificationOutputDefinitionsForExperiment(db, experimentId, stepNumber)
      .map((definition) => [definition.code, definition])
  );
  for (const [code, value] of Object.entries(values)) {
    const definition = definitions.get(code);
    if (!definition) throw new Error(`Missing SLA/DLP demo output: ${code}`);
    if (definition.value_source === "summary") continue;
    upsertQualStepOutput(db, {
      experiment_id: experimentId,
      step_id: stepId,
      output_group: definition.group,
      output_code: code,
      value_real: typeof value === "number" ? value : null,
      value_text: typeof value === "string" ? value : null
    });
  }
}

function finishStep(db: Db, experimentId: number, stepId: number, stepNumber: number, outputs: OutputValues) {
  recomputeDerivedAndSummary(db, experimentId, stepId, stepNumber);
  putOutputs(db, experimentId, stepId, stepNumber, outputs);
  updateQualStepStatus(db, stepId, "DONE");
}

function seedStepOne(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 1)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 6);
  const retiredFields = fields.filter((field) => [
    "shear_rate_s_inv",
    "rest_time_s",
    "viscosity_pa_s",
    "shear_stress_pa"
  ].includes(field.code));
  retiredFields.forEach((field) => {
    db.prepare(
      "DELETE FROM qual_run_values WHERE field_id = ? AND run_id IN (SELECT id FROM qual_runs WHERE step_id = ?)"
    ).run(field.id, step.id);
  });
  db.prepare("DELETE FROM qual_run_series WHERE step_id = ? AND series_code = 'resin_viscosity_curve'").run(step.id);
  db.prepare(
    `DELETE FROM qual_step_outputs
     WHERE step_id = ? AND output_code IN ('viscosity_operating_min_pa_s', 'viscosity_operating_max_pa_s')`
  ).run(step.id);
  const rows: RunValues[] = [
    { resin_batch: "ER405-B24-017", resin_temp_c: 20, layer_height_um: 50, wait_before_exposure_s: 4, recoat_delay_s: 6.4, layer_uniformity_ok: false, bubbles_present: false },
    { resin_batch: "ER405-B24-017", resin_temp_c: 20, layer_height_um: 50, wait_before_exposure_s: 6, recoat_delay_s: 5.8, layer_uniformity_ok: true, bubbles_present: false },
    { resin_batch: "ER405-B24-017", resin_temp_c: 25, layer_height_um: 50, wait_before_exposure_s: 3, recoat_delay_s: 4.9, layer_uniformity_ok: false, bubbles_present: false },
    { resin_batch: "ER405-B24-017", resin_temp_c: 25, layer_height_um: 50, wait_before_exposure_s: 5, recoat_delay_s: 4.5, layer_uniformity_ok: true, bubbles_present: false },
    { resin_batch: "ER405-B24-017", resin_temp_c: 30, layer_height_um: 50, wait_before_exposure_s: 2, recoat_delay_s: 3.7, layer_uniformity_ok: true, bubbles_present: true },
    { resin_batch: "ER405-B24-017", resin_temp_c: 30, layer_height_um: 50, wait_before_exposure_s: 4, recoat_delay_s: 3.4, layer_uniformity_ok: true, bubbles_present: false }
  ];
  rows.forEach((row, index) => fillRun(db, fields, runs[index], row, ownerId));
  finishStep(db, experimentId, step.id, 1, {
    resin_temp_window_min_c: 20,
    resin_temp_window_max_c: 30,
    resin_temp_target_c: 25,
    minimum_recoat_delay_s: 5
  });
}

function seedStepTwo(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 2)!;
  const fields = listQualFields(db, step.id);
  const ec = 8;
  const dp = 120;
  const runs = ensureRuns(db, experimentId, step.id, 7);
  upsertQualStepSettings(db, experimentId, 2, JSON.stringify({
    jacobs_variable_code: "exposure_time_s",
    jacobs_wavelength_nm: 405,
    jacobs_resin_temp_c: 25,
    jacobs_fixed_irradiance_mw_cm2: 5,
    jacobs_fixed_exposure_time_s: null
  }));
  // The marked demo is maintained by this script. Remove obsolete per-run
  // copies of the shared setup so its exported table is portable as well.
  const obsoleteConditionFieldIds = fields
    .filter((field) => ["wavelength_nm", "resin_temp_c", "irradiance_mw_cm2"].includes(field.code))
    .map((field) => field.id);
  if (obsoleteConditionFieldIds.length) {
    const placeholders = obsoleteConditionFieldIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM qual_run_values WHERE field_id IN (${placeholders})`)
      .run(...obsoleteConditionFieldIds);
  }
  // Earlier demo versions stored all points as a CSV on one run. This marked
  // demo may safely be migrated to one physical exposure per run.
  runs.forEach((run) => deleteQualRunSeries(db, run.id, "jacobs_working_curve"));
  // This was a UI-only status with no decision workflow. The marked demo is
  // safe to clean up as the curve is now the sole calculated result.
  db.prepare("DELETE FROM qual_step_outputs WHERE step_id = ? AND output_code = 'working_curve_validity'")
    .run(step.id);
  [10, 15, 20, 30, 40, 60, 80].forEach((dose, index) => {
    fillRun(db, fields, runs[index], {
      exposure_time_s: dose / 5,
      cure_depth_um: dp * Math.log(dose / ec)
    }, ownerId);
  });
  finishStep(db, experimentId, step.id, 2, {
    // Jacobs results are materialized automatically from the dose/depth run evidence.
  });
}

function seedStepThree(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 3)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 15);
  const ec = 8;
  const dp = 120;
  const irradiance = 5;
  const layerHeights = [25, 50, 75];
  const targetOvercures = [20, 40, 60, 80, 100];
  const observations = [
    [31, 25, 10, 350, false], [35, 25, 15, 310, false], [41, 26, 22, 280, false], [47, 26, 32, 230, false], [52, 27, 45, 180, false],
    [61, 50, 14, 320, false], [69, 50, 20, 280, false], [77, 50, 28, 240, false], [86, 51, 40, 190, false], [94, 52, 55, 150, false],
    [91, 74, 18, 300, false], [104, 75, 28, 250, false], [117, 76, 40, 200, false], [131, 77, 55, 150, false], [142, 79, 75, 100, true]
  ];
  upsertQualStepSettings(db, experimentId, 3, JSON.stringify({
    exposure_window_wavelength_nm: 405,
    exposure_window_resin_temp_c: 25,
    exposure_window_irradiance_mw_cm2: irradiance,
    exposure_window_bottom_exposure_s: 25,
    exposure_window_layer_height_levels: layerHeights.join("; "),
    exposure_window_target_overcure_levels: targetOvercures.join("; ")
  }));
  const obsoleteConditionFieldIds = fields
    .filter((field) => ["irradiance_mw_cm2", "bottom_exposure_s"].includes(field.code))
    .map((field) => field.id);
  if (obsoleteConditionFieldIds.length) {
    const placeholders = obsoleteConditionFieldIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM qual_run_values WHERE field_id IN (${placeholders})`).run(...obsoleteConditionFieldIds);
  }
  const matrix = layerHeights.flatMap((layerHeight) => targetOvercures.map((targetOvercure) => ({ layerHeight, targetOvercure })));
  matrix.forEach(({ layerHeight, targetOvercure }, index) => {
    const targetCureDepth = layerHeight * (1 + targetOvercure / 100);
    const exposureTime = ec * Math.exp(targetCureDepth / dp) / irradiance;
    const observation = observations[index];
    fillRun(db, fields, runs[index], {
      layer_height_um: layerHeight,
      target_overcure_pct: targetOvercure,
      exposure_time_s: exposureTime,
      cure_depth_um: observation[0],
      actual_layer_thickness_um: observation[1],
      xy_bleed_um: observation[2],
      minimum_open_channel_um: observation[3],
      delamination_present: observation[4]
    }, ownerId);
  });
  finishStep(db, experimentId, step.id, 3, {
    qualified_layer_height_um: 50,
    exposure_window_min_s: 2.64,
    exposure_window_max_s: 3.16,
    nominal_exposure_s: 2.87
  });
}

function seedStepFour(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 4)!;
  const fields = listQualFields(db, step.id);
  // Earlier versions presented this inspection as a DOE. Retain old data for
  // traceability, but seed only the fixed NIST element plan and its actual
  // measurements; neither CAD nominals nor compensation estimates are entered
  // into a row.
  fields.filter((field) => [
    "layer_height_um", "exposure_time_s", "xy_compensation_mm",
    "shrinkage_compensation_pct", "cad_feature_size_um",
    "x_deviation_um", "y_deviation_um", "z_deviation_um"
  ].includes(field.code)).forEach((field) => {
    db.prepare(
      "DELETE FROM qual_run_values WHERE field_id = ? AND run_id IN (SELECT id FROM qual_runs WHERE step_id = ?)"
    ).run(field.id, step.id);
  });
  const rows: Array<[string, number, boolean]> = [
    ["positive_fine_025", 282, false],
    ["positive_fine_050", 514, true],
    ["positive_fine_100", 1007, true],
    ["positive_fine_150", 1509, true],
    ["positive_fine_200", 2011, true],
    ["negative_fine_025", 120, false],
    ["negative_fine_050", 468, true],
    ["negative_fine_100", 980, true],
    ["negative_fine_150", 1482, true],
    ["negative_fine_200", 1980, true],
    ["xy_pin_or_hole_400", 4009, true],
    ["lateral_hole_300", 2978, true],
    ["lateral_hole_600", 5993, true],
    ["lateral_square_300", 3014, true],
    ["lateral_square_600", 6008, true],
    ["h_to_opposite_side_100", 99860, true]
  ];
  const runs = ensureRuns(db, experimentId, step.id, rows.length);
  upsertQualStepSettings(db, experimentId, 4, JSON.stringify({
    dimensional_layer_height_um: 50,
    dimensional_exposure_time_s: 2.87,
    dimensional_artifact_preset: "nist_am_test_artifact",
    dimensional_artifact_name: "NIST AM Test Artifact",
    dimensional_artifact_reference_url: "https://www.nist.gov/el/intelligent-systems-division-73500/production-systems-group/nist-additive-manufacturing-test",
    dimensional_artifact_revision: "NIST public test artifact"
  }));
  rows.forEach((row, index) => fillRun(db, fields, runs[index], {
    artifact_feature_code: row[0],
    measured_feature_size_um: row[1],
    feature_reproduced: row[2]
  }, ownerId));
  finishStep(db, experimentId, step.id, 4, {});
}

function seedStepFive(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 5)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 5);
  upsertQualStepSettings(db, experimentId, 5, JSON.stringify({
    peel_vat_film_type: "nFEP",
    peel_support_neck_diameter_mm: 0.6,
    peel_support_geometry_note: "0.6 mm cylindrical necks, 1.5 mm tips, 45° build orientation",
    peel_layer_height_um: 50,
    peel_lift_speed_levels: "0.8; 1.2; 1.6; 2.0; 2.4",
    peel_layer_area_levels: "600; 800; 1000; 1200; 1400",
    peel_exposure_time_levels: "1.8; 2.1; 2.4"
  }));
  // The marked demo may safely discard legacy per-run copies of the
  // fixed conditions; exposure remains a Step 5 matrix factor.
  const staticConditionFieldIds = fields
    .filter((field) => ["vat_film_type", "support_neck_diameter_mm"].includes(field.code))
    .map((field) => field.id);
  if (staticConditionFieldIds.length) {
    const placeholders = staticConditionFieldIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM qual_run_values WHERE field_id IN (${placeholders})`)
      .run(...staticConditionFieldIds);
  }
  const rows = [
    [0.8, 600, 1.8, 11.5, 3.7, false],
    [1.2, 800, 2.1, 18.2, 3.8, false],
    [1.6, 1000, 2.1, 27.8, 3.9, false],
    [2.0, 1200, 2.4, 39.6, 4.0, false],
    [2.4, 1400, 2.4, 55.3, 4.0, true]
  ];
  rows.forEach((row, index) => fillRun(db, fields, runs[index], {
    lift_speed_mm_s: row[0],
    layer_area_mm2: row[1],
    exposure_time_s: row[2],
    peel_force_n: row[3],
    green_tensile_strength_mpa: row[4],
    print_failure: row[5]
  }, ownerId));
  finishStep(db, experimentId, step.id, 5, {
    validated_lift_speed_mm_s: 2,
    support_geometry_constraints: "nFEP vat; 50 µm layers; 2.0 mm/s at 1200 mm² and 2.4 s exposure; support neck Ø ≥ 0.6 mm"
  });
}

function seedStepSix(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 6)!;
  const fields = listQualFields(db, step.id);
  upsertQualStepSettings(db, experimentId, 6, JSON.stringify({
    post_cure_wash_method: "IPA",
    post_cure_wash_time_min: 5,
    post_cure_source_note: "405 nm LED chamber, air, samples centred on turntable",
    post_cure_layer_height_um: 50,
    post_cure_exposure_time_s: 2.1,
    post_cure_baseline_tg_c: 42,
    post_cure_time_levels: "0; 5; 10; 20; 30; 45",
    post_cure_temp_levels: "60",
    post_cure_irradiance_levels: "8"
  }));
  let conditionRuns = listQualRuns(db, step.id).filter((run) => run.run_group === "post_cure_condition");
  if (conditionRuns.length < 6) {
    createQualRuns(db, experimentId, step.id, 6 - conditionRuns.length, "post_cure_condition");
  }
  normalizeSlaDlpPostCureRuns(db, experimentId, step.id);
  conditionRuns = listQualRuns(db, step.id).filter((run) => run.run_group === "post_cure_condition").slice(0, 6);
  const staleFieldIds = fields
    .filter((field) => [
      "wash_method", "wash_time_min", "reaction_band_uncured", "reference_band_uncured",
      "reaction_band_cured", "reference_band_cured", "final_conversion_pct",
      "residual_enthalpy_j_g", "final_tg_c", "post_cure_delta_tg_c",
      "post_cure_shrinkage_pct", "tensile_strength_mpa"
    ].includes(field.code))
    .map((field) => field.id);
  if (staleFieldIds.length && conditionRuns.length) {
    const fieldPlaceholders = staleFieldIds.map(() => "?").join(", ");
    const runPlaceholders = conditionRuns.map(() => "?").join(", ");
    db.prepare(`DELETE FROM qual_run_values WHERE field_id IN (${fieldPlaceholders}) AND run_id IN (${runPlaceholders})`)
      .run(...staleFieldIds, ...conditionRuns.map((run) => run.id));
  }
  db.prepare("DELETE FROM qual_run_series WHERE step_id = ? AND series_code IN ('post_cure_conversion_curve', 'post_cure_tg_curve', 'post_cure_strength_curve')")
    .run(step.id);
  db.prepare("DELETE FROM qual_step_outputs WHERE step_id = ? AND output_code = 'final_conversion_pct'").run(step.id);
  const rows = [
    [0, 62, 1.8, 0.35, 41],
    [5, 67, 1.5, 0.43, 47],
    [10, 71, 1.2, 0.51, 52],
    [20, 76, 0.9, 0.59, 58],
    [30, 79, 0.7, 0.67, 61],
    [45, 81, 0.6, 0.75, 63]
  ];
  rows.forEach((row, index) => {
    const condition = conditionRuns[index];
    if (!condition) return;
    fillRun(db, fields, condition, {
      post_cure_time_min: row[0],
      post_cure_temp_c: 60,
      post_cure_irradiance_mw_cm2: 8,
      residual_enthalpy_j_g: row[2],
      final_tg_c: row[1],
      post_cure_shrinkage_pct: row[3],
      tensile_strength_mpa: row[4]
    }, ownerId);
  });
  finishStep(db, experimentId, step.id, 6, {
    post_cure_time_min: 30,
    post_cure_temp_c: 60,
    post_cure_irradiance_mw_cm2: 8,
    final_tg_c: 79
  });
}

function seedStepSeven(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 7)!;
  const fields = listQualFields(db, step.id);
  upsertQualStepSettings(db, experimentId, 7, JSON.stringify({
    mechanical_resin_batch: "ER405-B24-017",
    mechanical_conditioning_temp_c: 23,
    mechanical_conditioning_time_h: 40,
    mechanical_conditioning_rh_pct: 50,
    mechanical_tensile_method: "ISO 527-2, type 1BA, 1 mm/min",
    mechanical_additional_methods: "ISO 178; ISO 75"
  }));
  const runs = ensureRuns(db, experimentId, step.id, 6);
  const rows = [
    ["XY", 62, 2150, 5.8, 94, 76, 79, 28],
    ["XY", 61, 2120, 5.6, 93, 75, 79, 31],
    ["45deg", 56, 1980, 4.7, 86, 73, 78, 36],
    ["45deg", 55, 1960, 4.5, 84, 72, 78, 39],
    ["Z", 48, 1830, 3.4, 76, 69, 77, 45],
    ["Z", 47, 1800, 3.2, 74, 68, 77, 49]
  ];
  rows.forEach((row, index) => fillRun(db, fields, runs[index], {
    build_orientation: [String(row[0])],
    tensile_strength_mpa: row[1],
    elastic_modulus_mpa: row[2],
    elongation_break_pct: row[3],
    flexural_strength_mpa: row[4],
    hdt_c: row[5],
    final_tg_c: row[6],
    dimensional_error_um: row[7]
  }, ownerId));
  // One trace per specimen makes the demo overlay meaningful. These are
  // parsed-series demo values only, deliberately not synthetic repository
  // downloads: real evidence must arrive through the upload dialog.
  const stressStrainTraces = [
    [[0, 0], [0.5, 10.8], [1, 21.5], [2, 39.5], [3, 51], [4, 58], [5, 61], [5.8, 62]],
    [[0, 0], [0.5, 10.5], [1, 21.0], [2, 38.7], [3, 49.9], [4, 57.1], [5, 60.4], [5.6, 61]],
    [[0, 0], [0.5, 9.8], [1, 19.6], [2, 35.4], [3, 46.1], [4, 52.8], [4.7, 56]],
    [[0, 0], [0.5, 9.6], [1, 19.1], [2, 34.8], [3, 45.2], [4, 51.7], [4.5, 55]],
    [[0, 0], [0.5, 8.9], [1, 17.8], [1.5, 26.7], [2, 35.0], [2.5, 42.0], [3.4, 48]],
    [[0, 0], [0.5, 8.7], [1, 17.3], [1.5, 25.8], [2, 34.0], [2.5, 41.0], [3.2, 47]]
  ];
  stressStrainTraces.forEach((trace, index) => {
    replaceQualRunSeries(db, {
      experimentId,
      stepId: step.id,
      runId: runs[index].id,
      seriesCode: "stress_strain_curve",
      contractVersion: 1,
      sourceName: `demo-${runs[index].run_code.toLowerCase()}-stress-strain.csv`,
      points: trace.map(([x, y]) => ({ x, y }))
    });
  });
  finishStep(db, experimentId, step.id, 7, {
    sla_print_profile: "ER405-B24-017 / 50 µm / 2.1 s / post-cure 30 min at 60 °C"
  });
}

function seedStepEight(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 8)!;
  const fields = listQualFields(db, step.id);
  upsertQualStepSettings(db, experimentId, 8, JSON.stringify({
    rheology_material_batch: "ER405-B24-017",
    rheology_program: "steady_shear",
    rheology_reference_shear_rate_s_inv: 10
  }));
  const runs = ensureRuns(db, experimentId, step.id, 3);
  const rows = [
    { resin_temp_c: 20, reference_viscosity: 1.36, flow_class: "Newtonian", curve: [[0.1, 1.42], [1, 1.40], [10, 1.36], [50, 1.31], [100, 1.28]] },
    { resin_temp_c: 25, reference_viscosity: 1.08, flow_class: "Newtonian", curve: [[0.1, 1.13], [1, 1.11], [10, 1.08], [50, 1.04], [100, 1.01]] },
    { resin_temp_c: 30, reference_viscosity: 0.87, flow_class: "Newtonian", curve: [[0.1, 0.92], [1, 0.90], [10, 0.87], [50, 0.84], [100, 0.82]] }
  ];
  rows.forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      resin_temp_c: row.resin_temp_c,
      sla_reference_viscosity_pa_s: row.reference_viscosity,
      sla_flow_behaviour_class: [row.flow_class]
    }, ownerId);
    replaceQualRunSeries(db, {
      experimentId,
      stepId: step.id,
      runId: runs[index].id,
      seriesCode: "resin_flow_curve",
      contractVersion: 1,
      sourceName: `demo-resin-flow-${row.resin_temp_c}c.csv`,
      points: row.curve.map(([x, y]) => ({ x, y }))
    });
  });
  finishStep(db, experimentId, step.id, 8, {
    sla_rheology_reference_viscosity_pa_s: 1.08,
    sla_flow_behavior_index_n: 0.96,
    sla_rheology_assessment: "Near-Newtonian flow over 20–30 °C; retain for batch and vat-heating comparison only."
  });
}

export function seedSlaDlpDemo(db: Db) {
  ensureSeedParams(db);
  const ownerId = getDemoOwnerId(db);
  const experimentId = getDemoExperimentId(db, getProcessId(db), ownerId);
  ensureQualificationDefaults(db, experimentId);
  setOptionalQualificationStudyEnabled(db, experimentId, 8, true);
  db.transaction(() => {
    seedStepOne(db, experimentId, ownerId);
    seedStepTwo(db, experimentId, ownerId);
    seedStepThree(db, experimentId, ownerId);
    seedStepFour(db, experimentId, ownerId);
    seedStepFive(db, experimentId, ownerId);
    seedStepSix(db, experimentId, ownerId);
    seedStepSeven(db, experimentId, ownerId);
    seedStepEight(db, experimentId, ownerId);
  })();
  return experimentId;
}

function printHelp() {
  console.log(`Seeds or updates one marked SLA/DLP demo experiment.

Usage:
  npm run seed:sla-dlp-demo -- --upsert

The command only creates or updates the experiment marked ${DEMO_MARKER}.`);
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  if (!process.argv.includes("--upsert")) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  try {
    const experimentId = seedSlaDlpDemo(db);
    console.log(`SLA/DLP demo is ready: experiment ${experimentId} (${DEMO_MARKER}).`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
