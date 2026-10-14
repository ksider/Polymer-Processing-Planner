import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { openDb } from "../db.js";
import {
  listQualFields,
  listQualRuns,
  listQualRunValues,
  listQualSteps,
  listQualStepOutputs,
  listQualRunSeries,
  replaceQualRunSeries,
  upsertQualStepOutput,
  upsertQualStepSettings,
  createQualRuns
} from "../repos/qual_repo.js";
import { createCustomParam, createExperimentWithDefaults } from "../services/experiments_service.js";
import { findGlobalParamByCode, getParamDefinition, listParamDefinitionsForProcess } from "../repos/params_repo.js";
import {
  ensureQualificationDefaults,
  getQualificationOutputDefinitionsForExperiment,
  getQualificationStepsForExperiment,
  getOptionalQualificationStudies,
  recomputeDerivedAndSummary,
  setOptionalQualificationStudyEnabled,
  updateExtrusionRtdMetricsFromSeries,
  saveQualRunValue
} from "../services/qualification_service.js";
import { ensureSeedParams } from "../services/seed.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-extrusion-"));
  dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
});

after(() => {
  if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

test("extrusion_v1 seeds the core qualification catalogue and deterministic SME calculation", () => {
  const db = openDb();
  try {
    ensureSeedParams(db);
    const extrusionProcess = db.prepare(
      `SELECT p.id FROM processes p JOIN process_types pt ON pt.id = p.process_type_id
       WHERE pt.code = 'extrusion_v1' LIMIT 1`
    ).get() as { id: number } | undefined;
    assert.ok(extrusionProcess?.id, "extrusion_v1 default process is seeded");

    const experimentId = createExperimentWithDefaults(db, {
      name: "Extrusion core smoke",
      process_id: extrusionProcess?.id
    });
    ensureQualificationDefaults(db, experimentId);
    const fieldLinkCounts = db.prepare(
      "SELECT COUNT(*) AS total, COUNT(param_def_id) AS linked FROM qual_fields WHERE experiment_id = ?"
    ).get(experimentId) as { total: number; linked: number };
    assert.equal(fieldLinkCounts.linked, fieldLinkCounts.total, "every instantiated extrusion field links to the catalogue");
    const extrusionParams = listParamDefinitionsForProcess(db, experimentId, "extrusion_v1");
    assert.ok(extrusionParams.some((param) => param.code === "screw_speed_rpm"));
    assert.ok(extrusionParams.some((param) => param.code === "rtd_mean_residence_time_s"));
    const feederCapacity = findGlobalParamByCode(db, "feeder_stable_throughput_max_kg_h");
    assert.ok(feederCapacity, "handoff output is registered in the same catalogue");
    const stages = getQualificationStepsForExperiment(db, experimentId);
    assert.deepEqual(stages.map((stage) => stage.name), [
      "Raw Material Rheological & Thermal Profiling",
      "Gravimetric Feeder Stability & Dosing Capacity",
      "Pumping Characterization & Motor Operating Window",
      "Thermal & Dissipative Energy Mapping",
      "Residence Time Distribution & Self-Wiping Assessment"
    ]);
    assert.deepEqual(stages.map((stage) => stage.stage_code), [
      "extrusion_v1.qualification.001",
      "extrusion_v1.qualification.002",
      "extrusion_v1.qualification.003",
      "extrusion_v1.qualification.004",
      "extrusion_v1.qualification.005"
    ]);

    const stepFour = listQualSteps(db, experimentId).find((stage) => stage.step_number === 4);
    assert.ok(stepFour, "energy mapping stage is present");
    const run = listQualRuns(db, stepFour!.id)[0];
    assert.ok(run, "energy mapping starts with declared runs");
    const fields = listQualFields(db, stepFour!.id);
    const fieldByCode = new Map(fields.map((field) => [field.code, field]));
    const put = (code: string, value: number) => {
      const field = fieldByCode.get(code);
      assert.ok(field, `field ${code} is present`);
      saveQualRunValue(db, run!.id, field!.id, "number", value);
    };
    put("screw_speed_rpm", 300);
    put("throughput_kg_h", 30);
    put("barrel_set_temp_c", 200);
    put("motor_torque_nm", 600);
    put("no_load_torque_nm", 100);
    put("melt_temp_c", 215);
    recomputeDerivedAndSummary(db, experimentId, stepFour!.id, 4);

    const valuesByFieldId = new Map(listQualRunValues(db, run!.id).map((value) => [value.field_id, value]));
    const valueOf = (code: string) => valuesByFieldId.get(fieldByCode.get(code)!.id)?.value_real;
    assert.ok(Math.abs((valueOf("mechanical_power_kw") ?? 0) - 18.8496) < 0.0001);
    assert.ok(Math.abs((valueOf("sme_kwh_kg") ?? 0) - (300 * 500) / (9549 * 30)) < 0.0000001);
    assert.equal(valueOf("dissipative_temp_rise_c"), 15);

    const stepTwo = listQualSteps(db, experimentId).find((stage) => stage.step_number === 2)!;
    upsertQualStepOutput(db, {
      experiment_id: experimentId,
      step_id: stepTwo.id,
      output_group: "Feeder limits",
      output_code: "feeder_stable_throughput_max_kg_h",
      value_real: 30,
      value_text: null
    });
    assert.equal(
      listQualStepOutputs(db, stepTwo.id).find((output) => output.output_code === "feeder_stable_throughput_max_kg_h")?.param_def_id,
      feederCapacity?.id,
      "saved qualification result keeps its canonical parameter identity"
    );
    const feederFields = new Map(listQualFields(db, stepTwo.id).map((field) => [field.code, field]));
    const feederRuns = listQualRuns(db, stepTwo.id);
    const putFeeder = (runIndex: number, code: string, value: number) => {
      const field = feederFields.get(code);
      assert.ok(field, `Feeder field ${code} is present`);
      saveQualRunValue(db, feederRuns[runIndex].id, field!.id, "number", value);
    };
    putFeeder(0, "feeder_speed_rpm", 10);
    putFeeder(0, "mean_throughput_kg_h", 15);
    putFeeder(0, "throughput_sd_kg_h", 0.1);
    putFeeder(1, "feeder_speed_rpm", 20);
    putFeeder(1, "mean_throughput_kg_h", 30);
    putFeeder(1, "throughput_sd_kg_h", 0.2);
    recomputeDerivedAndSummary(db, experimentId, stepTwo.id, 2);

    const stepFive = listQualSteps(db, experimentId).find((stage) => stage.step_number === 5);
    assert.ok(stepFive, "RTD stage is present");
    const rtdRun = listQualRuns(db, stepFive!.id)[0];
    const rtdFields = new Map(listQualFields(db, stepFive!.id).map((field) => [field.code, field]));
    const putRtd = (code: string, value: number) => {
      const field = rtdFields.get(code);
      assert.ok(field, `RTD field ${code} is present`);
      saveQualRunValue(db, rtdRun!.id, field!.id, "number", value);
    };
    putRtd("screw_speed_rpm", 200);
    putRtd("planned_throughput_kg_h", 30);
    putRtd("feeder_speed_rpm", 20);
    putRtd("throughput_kg_h", 30);
    putRtd("mean_residence_time_s", 120);
    upsertQualStepSettings(db, experimentId, 5, JSON.stringify({ rtd_free_volume_l: 2, rtd_melt_density_kg_l: 0.8 }));
    recomputeDerivedAndSummary(db, experimentId, stepFive!.id, 5);
    const rtdValues = new Map(listQualRunValues(db, rtdRun!.id).map((value) => [value.field_id, value]));
    const rtdValueOf = (code: string) => rtdValues.get(rtdFields.get(code)!.id)?.value_real;
    assert.equal(rtdValueOf("feeder_speed_rpm"), 20);
    assert.equal(rtdValueOf("theoretical_residence_time_s"), 192);
    assert.equal(rtdValueOf("degree_of_fill_pct"), 62.5);
    replaceQualRunSeries(db, {
      experimentId,
      stepId: stepFive!.id,
      runId: rtdRun!.id,
      seriesCode: "tracer_concentration_response",
      contractVersion: 1,
      sourceName: "manual-outlet-samples",
      points: [
        { x: 0, y: 0 },
        { x: 60, y: 1 },
        { x: 120, y: 2 },
        { x: 180, y: 1 },
        { x: 240, y: 0 }
      ]
    });
    const rtdMetrics = updateExtrusionRtdMetricsFromSeries(db, stepFive!.id, rtdRun!.id);
    assert.equal(rtdMetrics?.pointCount, 5);
    assert.equal(rtdMetrics?.meanResidenceTime, 120);
    assert.equal(rtdMetrics?.rtdWidth, 144);
    recomputeDerivedAndSummary(db, experimentId, stepFive!.id, 5);
    const rtdSeriesValues = new Map(listQualRunValues(db, rtdRun!.id).map((value) => [value.field_id, value]));
    assert.equal(rtdSeriesValues.get(rtdFields.get("mean_residence_time_s")!.id)?.value_real, 120);
    assert.equal(rtdSeriesValues.get(rtdFields.get("rtd_width_s")!.id)?.value_real, 144);
    assert.equal(rtdSeriesValues.get(rtdFields.get("degree_of_fill_pct")!.id)?.value_real, 62.5);
    assert.deepEqual(
      getQualificationOutputDefinitionsForExperiment(db, experimentId, 5).map((item) => item.code),
      ["rtd_mean_residence_time_s", "rtd_degree_of_fill_pct", "rtd_width_s"]
    );

    const customParamId = createCustomParam(db, experimentId, {
      code: "operator_screening_index",
      label: "Operator screening index",
      unit: null,
      field_kind: "OUTPUT",
      field_type: "number",
      group_label: "Custom",
      allowed_values_json: null
    });
    assert.equal(getParamDefinition(db, customParamId)?.scope, "GLOBAL");
    assert.ok(
      listParamDefinitionsForProcess(db, experimentId, "extrusion_v1")
        .some((param) => param.id === customParamId),
      "a custom parameter is reusable from the process catalogue"
    );

    const step = listQualSteps(db, experimentId).find((item) => item.step_number === 1)!;
    const stepOneRuns = listQualRuns(db, step.id);
    assert.deepEqual(
      new Set(stepOneRuns.map((item) => item.run_group)),
      new Set(["rheology", "thermal_hold", "dsc", "tga"])
    );
    assert.match(stepOneRuns.find((item) => item.run_group === "rheology")?.run_code || "", /-RH001$/);
    assert.deepEqual(
      getQualificationOutputDefinitionsForExperiment(db, experimentId, 1).map((item) => item.code),
      [
        "rheology_reference_viscosity_pa_s",
        "flow_behavior_index_n",
        "max_thermal_hold_min",
        "processing_temp_min_c",
        "dsc_melting_peak_c",
        "processing_temp_max_c",
        "tga_degradation_onset_c"
      ]
    );
    assert.deepEqual(
      getQualificationOutputDefinitionsForExperiment(db, experimentId, 2).map((item) => item.code),
      ["feeder_stable_throughput_min_kg_h", "feeder_stable_throughput_max_kg_h"]
    );
    const seriesRun = listQualRuns(db, step.id)[0];
    replaceQualRunSeries(db, {
      experimentId,
      stepId: step.id,
      runId: seriesRun.id,
      seriesCode: "pressure_stability",
      contractVersion: 1,
      sourceName: "pressure.csv",
      points: [
        { x: 0, y: 1_000_000 },
        { x: 15, y: 1_004_000 },
        { x: 30, y: 996_000 }
      ]
    });
    recomputeDerivedAndSummary(db, experimentId, step.id, 1);

    const series = listQualRunSeries(db, step.id);
    assert.equal(series.length, 1);
    assert.equal(series[0].contract_version, 1);
    assert.equal(series[0].source_name, "pressure.csv");
    assert.equal(series[0].points.length, 3);

    const stableField = listQualFields(db, step.id).find((field) => field.code === "point_stable")!;
    const stableValue = listQualRunValues(db, seriesRun.id).find((value) => value.field_id === stableField.id);
    assert.equal(stableValue?.value_real, 1);

    assert.deepEqual(getOptionalQualificationStudies(db, experimentId).map((study) => study.stepNumber), [6, 7, 8, 9, 10]);
    const sideFeeding = setOptionalQualificationStudyEnabled(db, experimentId, 6, true);
    assert.equal(sideFeeding?.is_active, 1);
    assert.equal(listQualSteps(db, experimentId).length, 6);
    assert.ok(listQualFields(db, sideFeeding!.id).some((field) => field.code === "filler_mass_fraction_pct"));
    const sideFeedingRunCount = listQualRuns(db, sideFeeding!.id).length;
    assert.equal(sideFeedingRunCount, 0, "optional studies wait for their explicit generator");

    const disabledSideFeeding = setOptionalQualificationStudyEnabled(db, experimentId, 6, false);
    assert.equal(disabledSideFeeding?.is_active, 0);
    assert.equal(listQualRuns(db, disabledSideFeeding!.id).length, sideFeedingRunCount, "disabling retains evidence");
    assert.deepEqual(
      getQualificationOutputDefinitionsForExperiment(db, experimentId, 6).map((item) => item.code),
      [
        "side_feeder_stable_speed_min_rpm",
        "side_feeder_stable_speed_max_rpm",
        "filler_mass_fraction_max_pct",
        "filler_volume_fraction_max_pct",
        "fiber_length_retention_min_pct"
      ]
    );
    [7, 8, 9].forEach((stepNumber) => {
      const optionalStep = setOptionalQualificationStudyEnabled(db, experimentId, stepNumber, true);
      assert.equal(optionalStep?.is_active, 1);
      assert.equal(listQualRuns(db, optionalStep!.id).length, 0);
      assert.ok(getQualificationOutputDefinitionsForExperiment(db, experimentId, stepNumber).length > 0);
    });
    const liquidStep = listQualSteps(db, experimentId).find((item) => item.step_number === 7)!;
    createQualRuns(db, experimentId, liquidStep.id, 1, "liquid_melt_injection");
    const liquidRun = listQualRuns(db, liquidStep.id).find((item) => item.run_group === "liquid_melt_injection")!;
    const liquidFields = new Map(listQualFields(db, liquidStep.id).map((field) => [field.code, field]));
    const putLiquid = (code: string, type: "number" | "boolean", value: number | boolean) =>
      saveQualRunValue(db, liquidRun.id, liquidFields.get(code)!.id, type, value);
    putLiquid("polymer_throughput_kg_h", "number", 30);
    putLiquid("liquid_target_throughput_kg_h", "number", 1.2);
    putLiquid("liquid_throughput_kg_h", "number", 1.2);
    putLiquid("injection_pressure_bar", "number", 96);
    putLiquid("barrel_pressure_bar", "number", 69);
    putLiquid("no_liquid_backflow", "boolean", true);
    putLiquid("no_liquid_leak", "boolean", true);
    recomputeDerivedAndSummary(db, experimentId, liquidStep.id, 7);
    const liquidValues = new Map(listQualRunValues(db, liquidRun.id).map((value) => [value.field_id, value.value_real]));
    assert.ok(Math.abs((liquidValues.get(liquidFields.get("liquid_mass_fraction_pct")!.id) ?? 0) - (1.2 / 31.2 * 100)) < 0.000001);
    assert.equal(liquidValues.get(liquidFields.get("injection_pressure_delta_bar")!.id), 27);
    assert.equal(liquidValues.get(liquidFields.get("liquid_throughput_error_pct")!.id), 0);
    assert.deepEqual(
      getQualificationOutputDefinitionsForExperiment(db, experimentId, 7).map((item) => item.code),
      [
        "calibrated_liquid_throughput_min_kg_h",
        "calibrated_liquid_throughput_max_kg_h",
        "liquid_mass_fraction_max_pct",
        "injection_pressure_delta_min_bar"
      ]
    );
    const vacuumStep = listQualSteps(db, experimentId).find((item) => item.step_number === 8)!;
    createQualRuns(db, experimentId, vacuumStep.id, 1, "vacuum_calibration");
    const vacuumRun = listQualRuns(db, vacuumStep.id).find((item) => item.run_group === "vacuum_calibration")!;
    const vacuumFields = new Map(listQualFields(db, vacuumStep.id).map((field) => [field.code, field]));
    const putVacuum = (code: string, type: "number" | "boolean", value: number | boolean) =>
      saveQualRunValue(db, vacuumRun.id, vacuumFields.get(code)!.id, type, value);
    putVacuum("initial_volatiles_pct", "number", 0.58);
    putVacuum("residual_volatiles_pct", "number", 0.1);
    putVacuum("vacuum_pressure_mbar", "number", 76);
    putVacuum("vacuum_stable", "boolean", true);
    putVacuum("no_vent_foam_or_stuffing", "boolean", true);
    recomputeDerivedAndSummary(db, experimentId, vacuumStep.id, 8);
    const vacuumValues = new Map(listQualRunValues(db, vacuumRun.id).map((value) => [value.field_id, value.value_real]));
    assert.ok(Math.abs((vacuumValues.get(vacuumFields.get("devolatilization_efficiency_pct")!.id) ?? 0) - ((0.58 - 0.1) / 0.58 * 100)) < 0.000001);
    assert.deepEqual(
      getQualificationOutputDefinitionsForExperiment(db, experimentId, 8).map((item) => item.code),
      ["required_vacuum_pressure_mbar", "max_throughput_without_vent_stuffing_kg_h"]
    );
    const reactiveStep = listQualSteps(db, experimentId).find((item) => item.step_number === 9)!;
    createQualRuns(db, experimentId, reactiveStep.id, 1, "reactive_extrusion");
    upsertQualStepSettings(db, experimentId, 9, JSON.stringify({ reaction_conversion_target_pct: 90, reaction_mfr_min_g_10min: 4, reaction_mfr_max_g_10min: 9, reaction_thermal_limit_c: 210 }));
    const reactiveRun = listQualRuns(db, reactiveStep.id).find((item) => item.run_group === "reactive_extrusion")!;
    const reactiveFields = new Map(listQualFields(db, reactiveStep.id).map((field) => [field.code, field]));
    assert.equal(reactiveFields.has("chemical_sample_id"), false);
    const putReactive = (code: string, type: "number" | "boolean", value: number | boolean) =>
      saveQualRunValue(db, reactiveRun.id, reactiveFields.get(code)!.id, type, value);
    putReactive("reaction_temp_c", "number", 200);
    putReactive("mean_residence_time_s", "number", 75);
    putReactive("conversion_pct", "number", 96);
    putReactive("product_mfr_g_10min", "number", 5.7);
    putReactive("reaction_stable", "boolean", true);
    recomputeDerivedAndSummary(db, experimentId, reactiveStep.id, 9);
    const reactiveValues = new Map(listQualRunValues(db, reactiveRun.id).map((value) => [value.field_id, value.value_real]));
    const expectedApparentRate = -Math.log(1 - 0.96) / 75;
    assert.ok(Math.abs((reactiveValues.get(reactiveFields.get("reaction_rate_constant_s_inv")!.id) ?? 0) - expectedApparentRate) < 0.000001);
    assert.ok(Math.abs((reactiveValues.get(reactiveFields.get("damkohler_number")!.id) ?? 0) - (-Math.log(0.04))) < 0.000001);
    assert.deepEqual(
      getQualificationOutputDefinitionsForExperiment(db, experimentId, 9).map((item) => item.code),
      ["reactive_temp_min_c", "reactive_temp_max_c", "reactive_min_residence_time_s"]
    );
    const scaleUp = setOptionalQualificationStudyEnabled(db, experimentId, 10, true)!;
    assert.equal(listQualRuns(db, scaleUp.id).length, 0);
    assert.ok(getQualificationOutputDefinitionsForExperiment(db, experimentId, 10).length > 0);
    createQualRuns(db, experimentId, scaleUp.id, 1);
    upsertQualStepSettings(db, experimentId, 10, JSON.stringify({
      scale_up_source_screw_diameter_mm: 25,
      scale_up_production_screw_diameter_mm: 50,
      scale_up_source_throughput_kg_h: 10,
      scale_up_source_sme_kwh_kg: 0.5
    }));
    const scaleUpRun = listQualRuns(db, scaleUp.id)[0]!;
    const scaleUpFields = new Map(listQualFields(db, scaleUp.id).map((field) => [field.code, field]));
    const putScaleUp = (code: string, value: number) => saveQualRunValue(db, scaleUpRun.id, scaleUpFields.get(code)!.id, "number", value);
    putScaleUp("production_screw_speed_rpm", 150);
    putScaleUp("production_throughput_kg_h", 80);
    putScaleUp("production_torque_nm", 350);
    putScaleUp("production_no_load_torque_nm", 95);
    recomputeDerivedAndSummary(db, experimentId, scaleUp.id, 10);
    const scaleUpValues = new Map(listQualRunValues(db, scaleUpRun.id).map((value) => [value.field_id, value.value_real]));
    assert.equal(scaleUpValues.get(scaleUpFields.get("scaled_throughput_target_kg_h")!.id), 80);
    assert.ok(Math.abs((scaleUpValues.get(scaleUpFields.get("tip_speed_m_s")!.id) ?? 0) - (Math.PI * 0.05 * 150 / 60)) < 0.000001);
    assert.ok(Math.abs((scaleUpValues.get(scaleUpFields.get("production_sme_kwh_kg")!.id) ?? 0) - (150 * 255) / (9549 * 80)) < 0.0000001);
  } finally {
    db.close();
  }
});
