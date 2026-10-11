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
  listQualRunSeries,
  replaceQualRunSeries,
  upsertQualStepSettings,
  createQualRuns
} from "../repos/qual_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
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
      ["side_feeder_stable_speed_min_rpm", "side_feeder_stable_speed_max_rpm", "filler_mass_fraction_max_pct"]
    );
    [7, 8, 9].forEach((stepNumber) => {
      const optionalStep = setOptionalQualificationStudyEnabled(db, experimentId, stepNumber, true);
      assert.equal(optionalStep?.is_active, 1);
      assert.equal(listQualRuns(db, optionalStep!.id).length, 0);
      assert.ok(getQualificationOutputDefinitionsForExperiment(db, experimentId, stepNumber).length > 0);
    });
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
