import { openDb, type Db } from "../db.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import { ensureSeedParams } from "../services/seed.js";
import {
  ensureQualificationDefaults,
  getQualificationOutputDefinitionsForExperiment,
  recomputeDerivedAndSummary,
  saveQualRunValue,
  setOptionalQualificationStudyEnabled,
  updateExtrusionRtdMetricsFromSeries
} from "../services/qualification_service.js";
import {
  createQualRuns,
  getQualStep,
  listQualFields,
  listQualRuns,
  replaceQualRunSeries,
  updateQualRunFlags,
  updateQualRunMetadata,
  updateQualStepStatus,
  upsertQualStepOutput,
  upsertQualStepSettings,
  type QualField,
  type QualRun
} from "../repos/qual_repo.js";

const DEMO_MARKER = "demo-seed:extrusion-v1";
const DEMO_NAME = "Extrusion demo · PP mineral-filled compound";
const COMPLETED_AT = "2026-10-10";

type RunValues = Record<string, number | boolean | string | null | undefined>;

function printHelp() {
  console.log(`Seeds or updates one marked extrusion demo experiment.

Usage:
  node dist/tools/seed_extrusion_demo.js --upsert

The command only creates or updates the experiment marked ${DEMO_MARKER}.
It does not remove user experiments or reset the database.`);
}

function getExtrusionProcessId(db: Db) {
  const row = db.prepare(
    `SELECT p.id
     FROM processes p
     JOIN process_types pt ON pt.id = p.process_type_id
     WHERE pt.code = 'extrusion_v1' AND p.status = 'active'
     ORDER BY p.id
     LIMIT 1`
  ).get() as { id: number } | undefined;
  if (!row) throw new Error("The extrusion_v1 process is not available in this database.");
  return row.id;
}

function getDemoExperimentId(db: Db, processId: number) {
  const existing = db.prepare("SELECT id FROM experiments WHERE notes = ? ORDER BY id LIMIT 1")
    .get(DEMO_MARKER) as { id: number } | undefined;
  if (existing) return existing.id;
  const owner = db.prepare(
    "SELECT id FROM users WHERE lower(email) = 'demo@demo.com' AND status = 'ACTIVE' LIMIT 1"
  ).get() as { id: number } | undefined;
  return createExperimentWithDefaults(db, {
    name: DEMO_NAME,
    notes: DEMO_MARKER,
    process_id: processId,
    owner_user_id: owner?.id ?? null
  });
}

function fillRun(db: Db, fields: QualField[], run: QualRun, values: RunValues, ownerId: number | null) {
  const fieldsByCode = new Map(fields.map((field) => [field.code, field]));
  for (const [code, value] of Object.entries(values)) {
    const field = fieldsByCode.get(code);
    if (!field || value === undefined) continue;
    saveQualRunValue(db, run.id, field.id, field.field_type, value);
  }
  updateQualRunMetadata(db, run.id, { performedAt: COMPLETED_AT, responsibleUserId: ownerId });
  updateQualRunFlags(db, run.id, 1, 0);
}

function ensureRuns(db: Db, experimentId: number, stepId: number, count: number, group: string) {
  const current = listQualRuns(db, stepId).filter((run) => run.run_group === group);
  if (current.length < count) createQualRuns(db, experimentId, stepId, count - current.length, group);
  return listQualRuns(db, stepId).filter((run) => run.run_group === group);
}

function putOutputs(db: Db, experimentId: number, stepId: number, stepNumber: number, values: Record<string, number>) {
  const definitions = new Map(
    getQualificationOutputDefinitionsForExperiment(db, experimentId, stepNumber).map((item) => [item.code, item])
  );
  for (const [code, value] of Object.entries(values)) {
    const definition = definitions.get(code);
    if (!definition) continue;
    upsertQualStepOutput(db, {
      experiment_id: experimentId,
      step_id: stepId,
      output_group: definition.group,
      output_code: code,
      value_real: value,
      value_text: null
    });
  }
}

function seedStepOne(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 1)!;
  const fields = listQualFields(db, step.id);
  const runs = listQualRuns(db, step.id);
  const rheology = runs.find((run) => run.run_group === "rheology");
  const hold = runs.find((run) => run.run_group === "thermal_hold");
  const dsc = runs.find((run) => run.run_group === "dsc");
  const tga = runs.find((run) => run.run_group === "tga");
  if (!rheology || !hold || !dsc || !tga) throw new Error("Step 1 default test groups are missing.");
  fillRun(db, fields, rheology, {
    test_temp_c: 210, pressure_drop_pa: 1_280_000, capillary_diameter_mm: 1,
    capillary_length_mm: 20, volumetric_flow_mm3_s: 780, extrudate_mass_g: 2.45,
    collection_time_s: 60, rheology_pressure_stable: true
  }, ownerId);
  replaceQualRunSeries(db, {
    experimentId, stepId: step.id, runId: rheology.id, seriesCode: "pressure_stability", contractVersion: 1,
    sourceName: "demo-capillary-pressure.csv",
    points: [{ x: 0, y: 1_278_000 }, { x: 15, y: 1_285_000 }, { x: 30, y: 1_281_000 }, { x: 45, y: 1_282_000 }]
  });
  fillRun(db, fields, hold, {
    thermal_hold_temp_c: 220, thermal_hold_time_min: 30, thermal_hold_shear_rate_s: 100,
    thermal_hold_viscosity_pa_s: 760
  }, ownerId);
  fillRun(db, fields, dsc, { test_temp_c: 25 }, ownerId);
  replaceQualRunSeries(db, {
    experimentId, stepId: step.id, runId: dsc.id, seriesCode: "dsc_thermogram", contractVersion: 1,
    sourceName: "demo-dsc.csv",
    points: [{ x: 120, y: 0.1 }, { x: 145, y: 0.35 }, { x: 163, y: 1.8 }, { x: 175, y: 0.55 }, { x: 195, y: 0.08 }]
  });
  fillRun(db, fields, tga, { test_temp_c: 25 }, ownerId);
  replaceQualRunSeries(db, {
    experimentId, stepId: step.id, runId: tga.id, seriesCode: "tga_thermogram", contractVersion: 1,
    sourceName: "demo-tga.csv",
    points: [{ x: 50, y: 100 }, { x: 250, y: 99.8 }, { x: 300, y: 99.4 }, { x: 340, y: 97.2 }, { x: 390, y: 88 }]
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 1);
  putOutputs(db, experimentId, step.id, 1, {
    rheology_reference_viscosity_pa_s: 820, flow_behavior_index_n: 0.42, max_thermal_hold_min: 30,
    processing_temp_min_c: 175, dsc_melting_peak_c: 163, processing_temp_max_c: 300, tga_degradation_onset_c: 325
  });
  updateQualStepStatus(db, step.id, "DONE");
}

function seedStepTwo(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 2)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 6, "default");
  [[10, 8, 8.02, 0.06], [20, 16, 16.05, 0.09], [30, 24, 23.94, 0.12], [40, 32, 31.9, 0.18], [50, 40, 39.7, 0.3], [60, 48, 47.45, 0.56]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      feeder_speed_rpm: row[0], target_throughput_kg_h: row[1], mean_throughput_kg_h: row[2],
      throughput_sd_kg_h: row[3], sampling_window_min: 10
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 2);
  putOutputs(db, experimentId, step.id, 2, { feeder_stable_throughput_min_kg_h: 8, feeder_stable_throughput_max_kg_h: 40 });
  updateQualStepStatus(db, step.id, "DONE");
}

function seedStepThree(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 3)!;
  const fields = listQualFields(db, step.id);
  const windowRuns = ensureRuns(db, experimentId, step.id, 6, "operating_window");
  [[150, 12, 205, 42, 188], [150, 24, 280, 53, 193], [250, 20, 310, 55, 198], [250, 34, 390, 67, 203], [350, 28, 415, 70, 207], [350, 40, 500, 82, 213]].forEach((row, index) => {
    fillRun(db, fields, windowRuns[index], {
      screw_speed_rpm: row[0], throughput_kg_h: row[1], motor_torque_nm: row[2], motor_torque_limit_nm: 620,
      melt_pressure_bar: row[3], target_back_pressure_bar: 85, melt_temp_c: row[4], operating_point_stable: true
    }, ownerId);
  });
  const pumpRuns = ensureRuns(db, experimentId, step.id, 3, "pump_characteristic");
  [20, 30, 40].forEach((throughput, index) => fillRun(db, fields, pumpRuns[index], {
    screw_speed_rpm: 300, throughput_kg_h: throughput, motor_torque_nm: 355 + index * 55,
    motor_torque_limit_nm: 620, melt_pressure_bar: 56 + index * 13, target_back_pressure_bar: 85,
    melt_temp_c: 202 + index * 3, operating_point_stable: true
  }, ownerId));
  recomputeDerivedAndSummary(db, experimentId, step.id, 3);
  putOutputs(db, experimentId, step.id, 3, {
    operating_window_min_screw_rpm: 150, operating_window_max_screw_rpm: 350, operating_window_max_throughput_kg_h: 40
  });
  updateQualStepStatus(db, step.id, "DONE");
}

function seedStepFour(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 4)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 9, "default");
  [[200, 20, 190, 310, 80, 198], [200, 30, 190, 365, 80, 204], [200, 40, 190, 425, 80, 211], [250, 25, 195, 385, 82, 207], [250, 35, 195, 445, 82, 214], [250, 45, 195, 510, 82, 222], [300, 30, 200, 470, 84, 218], [300, 40, 200, 535, 84, 225], [300, 50, 200, 605, 84, 235]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      screw_speed_rpm: row[0], throughput_kg_h: row[1], barrel_set_temp_c: row[2], motor_torque_nm: row[3],
      no_load_torque_nm: row[4], melt_temp_c: row[5], thermal_stable: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 4);
  updateQualStepStatus(db, step.id, "DONE");
}

function seedStepFive(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 5)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 6, "default");
  upsertQualStepSettings(db, experimentId, 5, JSON.stringify({ rtd_free_volume_l: 2, rtd_melt_density_kg_l: 0.8 }));
  [[180, 16, 12.8, 120], [200, 20, 16, 96], [225, 25, 20, 82], [250, 30, 24, 72], [275, 35, 28, 62], [300, 40, 32, 54]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      screw_speed_rpm: row[0], planned_throughput_kg_h: row[1], feeder_speed_rpm: row[2], throughput_kg_h: row[1],
      tracer_pulse_mass_g: 1, tracer_sampling_interval_s: 10, sampling_complete: true
    }, ownerId);
    const peak = row[3];
    replaceQualRunSeries(db, {
      experimentId, stepId: step.id, runId: runs[index].id, seriesCode: "tracer_concentration_response", contractVersion: 1,
      sourceName: "demo-outlet-samples.csv",
      points: [{ x: 0, y: 0 }, { x: peak - 30, y: 0.2 }, { x: peak, y: 1 }, { x: peak + 30, y: 0.35 }, { x: peak + 60, y: 0.04 }]
    });
    updateExtrusionRtdMetricsFromSeries(db, step.id, runs[index].id);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 5);
  putOutputs(db, experimentId, step.id, 5, { rtd_mean_residence_time_s: 72, rtd_degree_of_fill_pct: 75, rtd_width_s: 44 });
  updateQualStepStatus(db, step.id, "DONE");
}

/**
 * These studies remain disabled in the demo workspace.  We temporarily enable
 * each one only to initialise its code-owned fields, then persist completed
 * illustrative runs and turn it off again.  A user who enables a card later
 * therefore sees a credible, populated study without changing the default
 * process path.
 */
function seedDisabledOptionalStudies(db: Db, experimentId: number, ownerId: number | null) {
  setOptionalQualificationStudyEnabled(db, experimentId, 6, true);
  let step = getQualStep(db, experimentId, 6)!;
  let fields = listQualFields(db, step.id);
  let runs = ensureRuns(db, experimentId, step.id, 3, "side_feeding");
  [[250, 30, 18, 4.8, 26], [250, 30, 27, 7.5, 38], [300, 36, 36, 10.8, 51]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      main_screw_speed_rpm: row[0], matrix_throughput_kg_h: row[1], side_feeder_speed_rpm: row[2],
      filler_throughput_kg_h: row[3], side_feeder_torque_nm: row[4], no_powder_accumulation: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 6);
  putOutputs(db, experimentId, step.id, 6, {
    side_feeder_stable_speed_min_rpm: 18, side_feeder_stable_speed_max_rpm: 36, filler_mass_fraction_max_pct: 23.1
  });
  updateQualStepStatus(db, step.id, "DONE");
  setOptionalQualificationStudyEnabled(db, experimentId, 6, false);

  setOptionalQualificationStudyEnabled(db, experimentId, 7, true);
  step = getQualStep(db, experimentId, 7)!;
  fields = listQualFields(db, step.id);
  runs = ensureRuns(db, experimentId, step.id, 3, "liquid_dosing");
  [[250, 30, 0.6, 92, 68], [250, 30, 1.2, 96, 69], [300, 36, 2.0, 104, 73]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      screw_speed_rpm: row[0], polymer_throughput_kg_h: row[1], liquid_throughput_kg_h: row[2],
      injection_pressure_bar: row[3], barrel_pressure_bar: row[4], no_liquid_backflow: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 7);
  putOutputs(db, experimentId, step.id, 7, {
    liquid_mass_fraction_min_pct: 1.96, liquid_mass_fraction_max_pct: 5.26, injection_pressure_delta_min_bar: 24
  });
  updateQualStepStatus(db, step.id, "DONE");
  setOptionalQualificationStudyEnabled(db, experimentId, 7, false);

  setOptionalQualificationStudyEnabled(db, experimentId, 8, true);
  step = getQualStep(db, experimentId, 8)!;
  fields = listQualFields(db, step.id);
  runs = ensureRuns(db, experimentId, step.id, 3, "devolatilization");
  [[250, 30, 80, 0.58, 0.14, 2.1], [300, 36, 65, 0.58, 0.1, 2.8], [300, 42, 50, 0.58, 0.08, 3.2]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      screw_speed_rpm: row[0], throughput_kg_h: row[1], vacuum_pressure_mbar: row[2], initial_volatiles_pct: row[3],
      residual_volatiles_pct: row[4], trap_carryover_g: row[5], vacuum_stable: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 8);
  putOutputs(db, experimentId, step.id, 8, { residual_volatiles_min_pct: 0.08, devolatilization_efficiency_max_pct: 86.2 });
  updateQualStepStatus(db, step.id, "DONE");
  setOptionalQualificationStudyEnabled(db, experimentId, 8, false);

  setOptionalQualificationStudyEnabled(db, experimentId, 9, true);
  step = getQualStep(db, experimentId, 9)!;
  fields = listQualFields(db, step.id);
  runs = ensureRuns(db, experimentId, step.id, 3, "reactive_extrusion");
  [[205, 72, 0.006, 74, 6.5], [215, 64, 0.009, 84, 8.1], [225, 56, 0.012, 91, 10.4]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      reaction_temp_c: row[0], mean_residence_time_s: row[1], reaction_rate_constant_s_inv: row[2], conversion_pct: row[3],
      product_mfr_g_10min: row[4], reaction_stable: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 9);
  putOutputs(db, experimentId, step.id, 9, { conversion_max_pct: 91, product_mfr_min_g_10min: 6.5, product_mfr_max_g_10min: 10.4 });
  updateQualStepStatus(db, step.id, "DONE");
  setOptionalQualificationStudyEnabled(db, experimentId, 9, false);
}

function seedStepTen(db: Db, experimentId: number, ownerId: number | null) {
  setOptionalQualificationStudyEnabled(db, experimentId, 10, true);
  const step = getQualStep(db, experimentId, 10)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 3, "scale_up");
  upsertQualStepSettings(db, experimentId, 10, JSON.stringify({
    scale_up_source_screw_diameter_mm: 27,
    scale_up_production_screw_diameter_mm: 50,
    scale_up_source_throughput_kg_h: 30,
    scale_up_source_sme_kwh_kg: 0.46
  }));
  [[65, 180, 690, 120, 211, 66], [75, 216, 760, 120, 214, 74], [85, 250, 835, 120, 218, 83]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      production_screw_speed_rpm: row[0], production_throughput_kg_h: row[1], production_torque_nm: row[2],
      production_no_load_torque_nm: row[3], production_melt_temp_c: row[4], production_melt_pressure_bar: row[5],
      particle_size_d50_um: 820, scale_up_stable: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 10);
  putOutputs(db, experimentId, step.id, 10, {
    scaled_throughput_target_kg_h: 190.5, production_screw_speed_min_rpm: 65, production_screw_speed_max_rpm: 85
  });
  updateQualStepStatus(db, step.id, "DONE");
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
    ensureSeedParams(db);
    const processId = getExtrusionProcessId(db);
    const experimentId = getDemoExperimentId(db, processId);
    ensureQualificationDefaults(db, experimentId);
    const owner = db.prepare("SELECT id FROM users WHERE lower(email) = 'demo@demo.com' AND status = 'ACTIVE' LIMIT 1")
      .get() as { id: number } | undefined;
    const ownerId = owner?.id ?? null;
    db.transaction(() => {
      seedStepOne(db, experimentId, ownerId);
      seedStepTwo(db, experimentId, ownerId);
      seedStepThree(db, experimentId, ownerId);
      seedStepFour(db, experimentId, ownerId);
      seedStepFive(db, experimentId, ownerId);
      seedDisabledOptionalStudies(db, experimentId, ownerId);
      seedStepTen(db, experimentId, ownerId);
    })();
    console.log(`Extrusion demo is ready: experiment ${experimentId} (${DEMO_MARKER}).`);
  } finally {
    db.close();
  }
}

main();
