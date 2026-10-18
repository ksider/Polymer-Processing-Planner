import { openDb, type Db } from "../db.js";
import path from "path";
import { fileURLToPath } from "url";
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
import { calculateExtrusionScaleUpRecommendation } from "../services/extrusion_scale_up_service.js";

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
  const rheologyRuns = ensureRuns(db, experimentId, step.id, 4, "rheology");
  const holdRuns = ensureRuns(db, experimentId, step.id, 3, "thermal_hold");
  const dsc = runs.find((run) => run.run_group === "dsc");
  const tga = runs.find((run) => run.run_group === "tga");
  if (!rheologyRuns.length || !holdRuns.length || !dsc || !tga) throw new Error("Step 1 default test groups are missing.");
  [[4, 3_600_000, 0.04], [8, 5_600_000, 0.08], [12, 7_300_000, 0.12], [16, 8_700_000, 0.16]].forEach((row, index) => {
    fillRun(db, fields, rheologyRuns[index], {
      test_temp_c: 210, pressure_drop_pa: row[1], capillary_diameter_mm: 1, capillary_length_mm: 20,
      volumetric_flow_mm3_s: row[0], extrudate_mass_g: row[2], collection_time_s: 60, rheology_pressure_stable: true
    }, ownerId);
    replaceQualRunSeries(db, {
      experimentId, stepId: step.id, runId: rheologyRuns[index].id, seriesCode: "pressure_stability", contractVersion: 1,
      sourceName: "demo-capillary-pressure.csv",
      points: [{ x: 0, y: row[1] * 0.997 }, { x: 15, y: row[1] * 1.003 }, { x: 30, y: row[1] }, { x: 45, y: row[1] * 1.001 }]
    });
  });
  [[0, 825], [15, 808], [30, 782]].forEach((row, index) => fillRun(db, fields, holdRuns[index], {
    thermal_hold_temp_c: 220, thermal_hold_time_min: row[0], thermal_hold_shear_rate_s: 100, thermal_hold_viscosity_pa_s: row[1]
  }, ownerId));
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
  recomputeDerivedAndSummary(db, experimentId, step.id, 1);
  updateQualStepStatus(db, step.id, "DONE");
}

function seedStepTwo(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 2)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 6, "default");
  upsertQualStepSettings(db, experimentId, 2, JSON.stringify({
    feeder_max_throughput_kg_h: 48, material_bulk_density_kg_m3: 520, feeder_temperature_c: 23, feeder_screw_geometry: "Twin screw, 20 mm"
  }));
  [[10, 8, 8.02, 0.06], [20, 16, 16.05, 0.09], [30, 24, 23.94, 0.12], [40, 32, 31.9, 0.18], [50, 40, 39.7, 0.3], [60, 48, 47.45, 0.95]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      feeder_speed_rpm: row[0], target_throughput_kg_h: row[1], mean_throughput_kg_h: row[2],
      throughput_sd_kg_h: row[3], sampling_window_min: 10
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 2);
  putOutputs(db, experimentId, step.id, 2, { feeder_stable_throughput_min_kg_h: 8, feeder_stable_throughput_max_kg_h: 40 });
  recomputeDerivedAndSummary(db, experimentId, step.id, 2);
  updateQualStepStatus(db, step.id, "DONE");
}

function seedStepThree(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 3)!;
  const fields = listQualFields(db, step.id);
  upsertQualStepSettings(db, experimentId, 3, JSON.stringify({
    screw_speed_levels_rpm: "150, 250, 350", throughput_levels_kg_h: "12, 24, 40",
    melt_pressure_limit_bar: 100, motor_torque_limit_nm: 620, die_geometry: "3 mm strand die", barrel_temperature_profile: "185 / 195 / 205 °C",
    pump_curve_speed_levels_rpm: "300", pump_curve_pressure_levels_bar: "50, 70, 90",
    melt_density_kg_m3: 900, reference_viscosity_pa_s: 820, die_outlet_pressure_bar: 0
  }));
  const windowRuns = ensureRuns(db, experimentId, step.id, 6, "operating_window");
  [[150, 12, 205, 42, 188], [150, 24, 280, 53, 193], [250, 20, 310, 55, 198], [250, 34, 390, 67, 203], [350, 28, 415, 70, 207], [350, 40, 500, 82, 213]].forEach((row, index) => {
    fillRun(db, fields, windowRuns[index], {
      screw_speed_rpm: row[0], throughput_kg_h: row[1], motor_torque_nm: row[2], motor_torque_limit_nm: 620,
      melt_pressure_bar: row[3], target_back_pressure_bar: 85, melt_temp_c: row[4], operating_point_stable: true
    }, ownerId);
  });
  const pumpRuns = ensureRuns(db, experimentId, step.id, 3, "pump_characteristic");
  [[40, 470, 50, 202], [30, 410, 70, 205], [20, 355, 90, 208]].forEach((row, index) => fillRun(db, fields, pumpRuns[index], {
    screw_speed_rpm: 300, throughput_kg_h: row[0], motor_torque_nm: row[1], motor_torque_limit_nm: 620,
    melt_pressure_bar: row[2], target_back_pressure_bar: row[2], melt_temp_c: row[3], operating_point_stable: true
  }, ownerId));
  recomputeDerivedAndSummary(db, experimentId, step.id, 3);
  putOutputs(db, experimentId, step.id, 3, {
    operating_window_min_screw_rpm: 150, operating_window_max_screw_rpm: 350, operating_window_max_throughput_kg_h: 40
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 3);
  updateQualStepStatus(db, step.id, "DONE");
}

function seedStepFour(db: Db, experimentId: number, ownerId: number | null) {
  const step = getQualStep(db, experimentId, 4)!;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 9, "default");
  upsertQualStepSettings(db, experimentId, 4, JSON.stringify({
    thermal_speed_levels_rpm: "200, 250, 300", thermal_throughput_levels_kg_h: "20, 30, 40", thermal_temperature_levels_c: "190, 195, 200"
  }));
  [[200, 20, 190, 310, 80, 198], [200, 30, 190, 365, 80, 204], [200, 40, 190, 425, 80, 211], [250, 25, 195, 385, 82, 207], [250, 35, 195, 445, 82, 214], [250, 45, 195, 510, 82, 222], [300, 30, 200, 470, 84, 218], [300, 40, 200, 535, 84, 225], [300, 50, 200, 605, 84, 235]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      screw_speed_rpm: row[0], throughput_kg_h: row[1], barrel_set_temp_c: row[2], motor_torque_nm: row[3],
      no_load_torque_nm: row[4], melt_temp_c: row[5], heater_power_kw: 2.8, thermal_point_stable: true
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
      steady_state_confirmed: true
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
  putOutputs(db, experimentId, step.id, 5, { rtd_mean_residence_time_s: 74.8, rtd_degree_of_fill_pct: 39, rtd_width_s: 64.2 });
  recomputeDerivedAndSummary(db, experimentId, step.id, 5);
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
  // Preserve previously seeded Step 6 data, but move the legacy undifferentiated
  // sweep into the first, feeder-stability program.
  db.prepare("UPDATE qual_runs SET run_group = 'feeder_stability' WHERE step_id = ? AND run_group = 'side_feeding'").run(step.id);
  let runs = ensureRuns(db, experimentId, step.id, 3, "feeder_stability");
  const particulateRuns = ensureRuns(db, experimentId, step.id, 3, "particulate_filler");
  upsertQualStepSettings(db, experimentId, 6, JSON.stringify({
    side_feeding_main_screw_speed_rpm: 250,
    side_feeding_matrix_throughput_kg_h: 30,
    side_feeding_injection_zone_temp_c: 190,
    side_feeding_speed_levels_rpm: "18, 27, 36",
    side_feeding_material_mode: "particulate",
    side_feeding_filler_density_kg_m3: 2600,
    side_feeding_matrix_density_kg_m3: 900,
    side_feeding_max_packing_fraction: 0.64,
    side_feeding_filler_throughput_levels_kg_h: "7.5, 10.8, 14.4",
    side_feeding_incorporation_speed_levels_rpm: "27, 36, 45"
  }));
  [[250, 30, 18, 4.8, 26, 0.8, 18], [250, 30, 27, 7.5, 38, 1.0, 22], [250, 30, 36, 10.8, 51, 1.4, 28]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      main_screw_speed_rpm: row[0], matrix_throughput_kg_h: row[1], side_feeder_speed_rpm: row[2],
      filler_throughput_kg_h: row[3], side_feeder_torque_nm: row[4], side_feeder_throughput_cv_pct: row[5],
      injection_port_pressure_bar: row[6], no_powder_accumulation: true
    }, ownerId);
  });
  [[250, 30, 27, 7.5, 38, 1.0, 22, 850], [250, 30, 36, 10.8, 51, 1.3, 28, 1030], [250, 30, 45, 14.4, 68, 1.5, 35, 1320]].forEach((row, index) => {
    fillRun(db, fields, particulateRuns[index], {
      main_screw_speed_rpm: row[0], matrix_throughput_kg_h: row[1], side_feeder_speed_rpm: row[2],
      filler_throughput_kg_h: row[3], side_feeder_torque_nm: row[4], side_feeder_throughput_cv_pct: row[5],
      injection_port_pressure_bar: row[6], composite_viscosity_pa_s: row[7], no_powder_accumulation: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 6);
  putOutputs(db, experimentId, step.id, 6, {
    side_feeder_stable_speed_min_rpm: 18,
    side_feeder_stable_speed_max_rpm: 45,
    filler_mass_fraction_max_pct: 32.43,
    filler_volume_fraction_max_pct: 14.25
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 6);
  updateQualStepStatus(db, step.id, "DONE");
  setOptionalQualificationStudyEnabled(db, experimentId, 6, false);

  setOptionalQualificationStudyEnabled(db, experimentId, 7, true);
  step = getQualStep(db, experimentId, 7)!;
  fields = listQualFields(db, step.id);
  // Preserve the original liquid-dose demo measurements as melt-injection
  // evidence when refreshing an existing demo database.
  db.prepare("UPDATE qual_runs SET run_group = 'liquid_melt_injection' WHERE step_id = ? AND run_group = 'liquid_dosing'").run(step.id);
  const calibrationRuns = ensureRuns(db, experimentId, step.id, 3, "liquid_pump_calibration");
  const injectionRuns = ensureRuns(db, experimentId, step.id, 3, "liquid_melt_injection");
  upsertQualStepSettings(db, experimentId, 7, JSON.stringify({
    liquid_calibration_target_throughput_levels_kg_h: "0.6, 1.2, 2",
    liquid_injection_screw_speed_rpm: 250,
    liquid_injection_polymer_throughput_kg_h: 30,
    liquid_injection_zone_temp_c: 190,
    liquid_injection_baseline_torque_nm: 184,
    liquid_injection_target_throughput_levels_kg_h: "0.6, 1.2, 2"
  }));
  [[0.6, 0.59, 0.8], [1.2, 1.19, 1.0], [2, 1.98, 1.2]].forEach((row, index) => {
    fillRun(db, fields, calibrationRuns[index], {
      liquid_target_throughput_kg_h: row[0], liquid_throughput_kg_h: row[1], liquid_throughput_cv_pct: row[2]
    }, ownerId);
  });
  [[0.6, 0.59, 92, 68, 181], [1.2, 1.19, 96, 69, 178], [2, 1.98, 104, 73, 174]].forEach((row, index) => {
    fillRun(db, fields, injectionRuns[index], {
      screw_speed_rpm: 250, polymer_throughput_kg_h: 30,
      liquid_target_throughput_kg_h: row[0], liquid_throughput_kg_h: row[1], liquid_throughput_cv_pct: 1.2,
      injection_pressure_bar: row[2], barrel_pressure_bar: row[3], motor_torque_nm: row[4],
      no_liquid_backflow: true, no_liquid_leak: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 7);
  putOutputs(db, experimentId, step.id, 7, {
    calibrated_liquid_throughput_min_kg_h: 0.59, calibrated_liquid_throughput_max_kg_h: 1.98,
    liquid_mass_fraction_max_pct: 6.19, injection_pressure_delta_min_bar: 24
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 7);
  updateQualStepStatus(db, step.id, "DONE");
  setOptionalQualificationStudyEnabled(db, experimentId, 7, false);

  setOptionalQualificationStudyEnabled(db, experimentId, 8, true);
  step = getQualStep(db, experimentId, 8)!;
  fields = listQualFields(db, step.id);
  db.prepare("UPDATE qual_runs SET run_group = 'vacuum_calibration' WHERE step_id = ? AND run_group = 'devolatilization'").run(step.id);
  const vacuumCalibrationRuns = ensureRuns(db, experimentId, step.id, 3, "vacuum_calibration");
  const vacuumCapacityRuns = ensureRuns(db, experimentId, step.id, 3, "vacuum_capacity");
  upsertQualStepSettings(db, experimentId, 8, JSON.stringify({
    devol_calibration_screw_speed_rpm: 300,
    devol_calibration_throughput_kg_h: 36,
    devol_vent_zone_temp_c: 185,
    devol_initial_volatiles_pct: 0.58,
    devol_residual_volatiles_target_pct: 0.12,
    devol_vacuum_target_levels_mbar: "100, 75, 50",
    devol_selected_vacuum_pressure_mbar: 75,
    devol_capacity_throughput_levels_kg_h: "24, 36, 42",
    devol_capacity_screw_speed_levels_rpm: "220, 300, 350"
  }));
  [[100, 102, 0.14, 0.1], [75, 76, 0.1, 0.12], [50, 51, 0.08, 0.18]].forEach((row, index) => {
    fillRun(db, fields, vacuumCalibrationRuns[index], {
      screw_speed_rpm: 300, devol_target_throughput_kg_h: 36, throughput_kg_h: 36,
      vacuum_target_pressure_mbar: row[0], vacuum_pressure_mbar: row[1], initial_volatiles_pct: 0.58,
      residual_volatiles_pct: row[2], trap_carryover_g: row[3], vacuum_stable: true, no_vent_foam_or_stuffing: true
    }, ownerId);
  });
  [[220, 24, 23.8, 0.11, 0.08, true], [300, 36, 35.9, 0.1, 0.12, true], [350, 42, 41.7, 0.14, 0.7, false]].forEach((row, index) => {
    fillRun(db, fields, vacuumCapacityRuns[index], {
      screw_speed_rpm: row[0], devol_target_throughput_kg_h: row[1], throughput_kg_h: row[2],
      vacuum_target_pressure_mbar: 75, vacuum_pressure_mbar: 76, initial_volatiles_pct: 0.58,
      residual_volatiles_pct: row[3], trap_carryover_g: row[4], vacuum_stable: true, no_vent_foam_or_stuffing: row[5]
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 8);
  db.prepare("DELETE FROM qual_step_outputs WHERE step_id = ? AND output_code IN ('residual_volatiles_min_pct', 'devolatilization_efficiency_max_pct')").run(step.id);
  putOutputs(db, experimentId, step.id, 8, { required_vacuum_pressure_mbar: 75, max_throughput_without_vent_stuffing_kg_h: 35.9 });
  recomputeDerivedAndSummary(db, experimentId, step.id, 8);
  updateQualStepStatus(db, step.id, "DONE");
  setOptionalQualificationStudyEnabled(db, experimentId, 8, false);

  setOptionalQualificationStudyEnabled(db, experimentId, 9, true);
  step = getQualStep(db, experimentId, 9)!;
  fields = listQualFields(db, step.id);
  db.prepare("DELETE FROM qual_run_values WHERE run_id IN (SELECT id FROM qual_runs WHERE step_id = ?)").run(step.id);
  db.prepare("DELETE FROM qual_runs WHERE step_id = ?").run(step.id);
  runs = ensureRuns(db, experimentId, step.id, 9, "reactive_extrusion");
  upsertQualStepSettings(db, experimentId, 9, JSON.stringify({
    reaction_temp_levels_c: "185, 200, 215",
    reaction_screw_speed_levels_rpm: "180, 250, 320",
    reaction_throughput_levels_kg_h: "20, 30, 38",
    reaction_dosing_route: "liquid_injection",
    reaction_reagent_name: "DCP / MAH",
    reaction_reagent_concentration_pct: 0.15,
    reaction_chemical_analysis_method: "ftir",
    reaction_chemical_marker: "C=O 1780 / CH₂ 1456 cm⁻¹",
    reaction_conversion_target_pct: 90,
    reaction_mfr_min_g_10min: 4,
    reaction_mfr_max_g_10min: 9,
    reaction_thermal_limit_c: 210
  }));
  [
    [185, 180, 20, 19.8, 75, 0.31, 91, 4.8, 198, true], [185, 250, 30, 29.8, 62, 0.28, 88, 5.1, 199, true], [185, 320, 38, 37.7, 52, 0.24, 84, 5.4, 200, true],
    [200, 180, 20, 19.9, 75, 0.46, 96, 5.7, 214, true], [200, 250, 30, 29.9, 62, 0.42, 93, 6.2, 216, true], [200, 320, 38, 37.8, 52, 0.37, 89, 6.7, 218, true],
    [215, 180, 20, 19.8, 75, 0.55, 97, 8.4, 230, true], [215, 250, 30, 29.7, 62, 0.51, 95, 9.6, 234, true], [215, 320, 38, 37.6, 52, 0.45, 91, 10.3, 238, false]
  ].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      reaction_temp_c: row[0], screw_speed_rpm: row[1], reaction_target_throughput_kg_h: row[2], throughput_kg_h: row[3], mean_residence_time_s: row[4],
      chemical_signal_ratio: row[5], conversion_pct: row[6],
      product_mfr_g_10min: row[7], reaction_exotherm_peak_c: row[8], reaction_stable: row[9]
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 9);
  db.prepare("DELETE FROM qual_step_outputs WHERE step_id = ? AND output_code IN ('conversion_max_pct', 'product_mfr_min_g_10min', 'product_mfr_max_g_10min')").run(step.id);
  putOutputs(db, experimentId, step.id, 9, { reactive_temp_min_c: 185, reactive_temp_max_c: 200, reactive_min_residence_time_s: 75 });
  recomputeDerivedAndSummary(db, experimentId, step.id, 9);
  updateQualStepStatus(db, step.id, "DONE");
  setOptionalQualificationStudyEnabled(db, experimentId, 9, false);
}

function seedStepTen(db: Db, experimentId: number, ownerId: number | null) {
  setOptionalQualificationStudyEnabled(db, experimentId, 10, true);
  const step = getQualStep(db, experimentId, 10)!;
  const rtdStep = getQualStep(db, experimentId, 5);
  const laboratoryRtdBaseline = rtdStep ? listQualRuns(db, rtdStep.id).find((run) => run.done === 1) : null;
  const fields = listQualFields(db, step.id);
  const runs = ensureRuns(db, experimentId, step.id, 3, "scale_up");
  const verificationRuns = ensureRuns(db, experimentId, step.id, 9, "default");
  const sourceSme = 0.27;
  const savedRecommendation = {
    ...calculateExtrusionScaleUpRecommendation({
      sourceScrewDiameterMm: 27,
      targetScrewDiameterMm: 50,
      sourceThroughputKgH: 30,
      sourceScrewSpeedRpm: 250,
      sourceFreeVolumeL: 2,
      targetFreeVolumeL: 12.7,
      sourceMeltDensityKgL: 0.8,
      targetMeltDensityKgL: 0.8,
      sourceBarrelTemperatureProfileC: "185, 195, 205, 210",
      sourceMeltTemperatureC: 210,
      capacityExponent: 2.9,
      targetMaxScrewSpeedRpm: 300,
      targetMaxTipSpeedMs: 1.5,
      sourceSmeKwhKg: sourceSme,
      sourceTorqueNm: 380,
      sourceNoLoadTorqueNm: 70,
      targetNominalPowerKw: 110,
      targetMaxTorqueNm: 9000,
      targetNoLoadTorqueNm: 450,
      targetMechanicalEfficiency: 0.95,
      targetCenterDistanceCm: 4.1,
      targetTorqueDensityLimitNmCm3: 50
    }),
    savedAt: `${COMPLETED_AT}T12:00:00.000Z`
  };
  upsertQualStepSettings(db, experimentId, 10, JSON.stringify({
    scale_up_source_screw_diameter_mm: 27,
    scale_up_production_screw_diameter_mm: 50,
    scale_up_source_throughput_kg_h: 30,
    scale_up_source_screw_speed_rpm: 250,
    scale_up_source_free_volume_l: 2,
    scale_up_source_melt_density_kg_l: 0.8,
    scale_up_source_barrel_temperature_profile_c: "185, 195, 205, 210",
    scale_up_source_melt_temperature_c: 210,
    scale_up_source_particle_size_d50_um: 820,
    scale_up_morphology_tolerance_pct: 5,
    scale_up_production_free_volume_l: 12.7,
    scale_up_production_melt_density_kg_l: 0.8,
    scale_up_capacity_exponent: 2.9,
    scale_up_production_max_screw_speed_rpm: 300,
    scale_up_production_max_tip_speed_m_s: 1.5,
    scale_up_source_sme_kwh_kg: sourceSme,
    scale_up_source_torque_nm: 380,
    scale_up_source_no_load_torque_nm: 70,
    scale_up_production_nominal_power_kw: 110,
    scale_up_production_max_torque_nm: 9000,
    scale_up_production_no_load_torque_nm: 450,
    scale_up_production_mechanical_efficiency: 0.95,
    scale_up_production_center_distance_cm: 4.1,
    scale_up_production_torque_density_limit_nm_cm3: 50,
    scale_up_source_rtd_run_id: laboratoryRtdBaseline?.id ?? null,
    scale_up_recommendation: savedRecommendation,
    scale_up_production_screw_speed_levels_rpm: "210, 235, 260",
    scale_up_production_throughput_multipliers: "0.85, 0.94, 1.03"
  }));
  [[65, 171, 6900, 120, 211, 66], [75, 191, 6685, 120, 214, 74], [85, 210, 6470, 120, 218, 83]].forEach((row, index) => {
    fillRun(db, fields, runs[index], {
      production_screw_speed_rpm: row[0], production_throughput_kg_h: row[1], production_torque_nm: row[2],
      production_no_load_torque_nm: row[3], production_melt_temp_c: row[4], production_melt_pressure_bar: row[5],
      particle_size_d50_um: 820, scale_up_stable: true
    }, ownerId);
  });
  const d3Target = 30 * Math.pow(50 / 27, 3);
  const verificationSpeeds = [210, 235, 260];
  const verificationMultipliers = [0.85, 0.94, 1.03];
  verificationRuns.forEach((run, index) => {
    const speed = verificationSpeeds[Math.floor(index / verificationMultipliers.length) % verificationSpeeds.length];
    const throughput = Number((d3Target * verificationMultipliers[index % verificationMultipliers.length]).toFixed(2));
    const torque = Math.round(sourceSme * 9549 * throughput / speed + 450);
    fillRun(db, fields, run, {
      production_screw_speed_rpm: speed,
      production_throughput_kg_h: throughput,
      production_torque_nm: torque,
      production_no_load_torque_nm: 450,
      production_melt_temp_c: 210 + (index % 3),
      production_melt_pressure_bar: 82 + index * 2,
      particle_size_d50_um: 820 + ((index % 3) - 1) * 8,
      scale_up_stable: true
    }, ownerId);
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 10);
  putOutputs(db, experimentId, step.id, 10, {
    scaled_throughput_target_kg_h: 190.5, production_screw_speed_min_rpm: 65, production_screw_speed_max_rpm: 85
  });
  recomputeDerivedAndSummary(db, experimentId, step.id, 10);
  updateQualStepStatus(db, step.id, "DONE");
}

export function seedExtrusionDemo(db: Db) {
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
  return experimentId;
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
    const experimentId = seedExtrusionDemo(db);
    console.log(`Extrusion demo is ready: experiment ${experimentId} (${DEMO_MARKER}).`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
