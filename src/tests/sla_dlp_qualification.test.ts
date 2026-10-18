import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { openDb } from "../db.js";
import {
  listQualFields,
  listQualRunSeries,
  listQualRuns,
  listQualRunValues,
  listQualSummaries,
  listQualStepOutputs,
  listQualSteps,
  createQualRuns,
  getQualStepSettings,
  upsertQualStepSettings
} from "../repos/qual_repo.js";
import { listParamDefinitionsForProcess } from "../repos/params_repo.js";
import { createDoeWithDefaults, createExperimentWithDefaults, getDefaultActiveFactors } from "../services/experiments_service.js";
import { getQualificationStudyGuide } from "../services/qualification_guides.js";
import {
  calculateJacobsWorkingCurve,
  ensureQualificationDefaults,
  normalizeSlaDlpPostCureRuns,
  getStepDefinitionForExperiment,
  getQualificationOutputDefinitionsForExperiment,
  getQualificationSeriesDefinitionsForExperiment,
  getQualificationStepsForExperiment,
  getOptionalQualificationStudies,
  recomputeDerivedAndSummary,
  saveQualRunValue,
  setOptionalQualificationStudyEnabled
} from "../services/qualification_service.js";
import { ensureSeedParams } from "../services/seed.js";
import { seedSlaDlpDemo } from "../tools/seed_sla_dlp_demo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-sla-dlp-"));
  dbPath = path.join(tempDir, "test.sqlite");
  process.env.FILE_STORAGE_PATH = path.join(tempDir, "uploads");
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
});

after(() => {
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("SLA/DLP seeds seven shared qualification stages and materializes Jacobs outputs from evidence", () => {
  const db = openDb();
  try {
    ensureSeedParams(db);
    const process = db.prepare(
      `SELECT process.id, process.route_code
       FROM processes process
       JOIN process_types type ON type.id = process.process_type_id
       WHERE type.code = 'sla_dlp' LIMIT 1`
    ).get() as { id: number; route_code: string } | undefined;
    assert.ok(process?.id, "SLA/DLP default process is seeded");
    assert.equal(process?.route_code, "sla-dlp");

    const experimentId = createExperimentWithDefaults(db, {
      name: "Photopolymer qualification smoke",
      process_id: process?.id
    });
    ensureQualificationDefaults(db, experimentId);

    const stages = getQualificationStepsForExperiment(db, experimentId);
    assert.deepEqual(stages.map((stage) => stage.name), [
      "Resin Conditioning & Recoating Window",
      "Photocure Working Curve",
      "Exposure & Layer Window",
      "Resolution & Dimensional Accuracy",
      "Green Strength & Peel Force",
      "Wash, Post-Cure & Conversion",
      "Final Mechanical & Thermal Qualification"
    ]);
    assert.deepEqual(stages.map((stage) => stage.stage_code), [
      "sla_dlp.qualification.001",
      "sla_dlp.qualification.002",
      "sla_dlp.qualification.003",
      "sla_dlp.qualification.004",
      "sla_dlp.qualification.005",
      "sla_dlp.qualification.006",
      "sla_dlp.qualification.007"
    ]);

    const storedSteps = listQualSteps(db, experimentId);
    const allFields = storedSteps.flatMap((step) => listQualFields(db, step.id));
    assert.ok(allFields.length > 0);
    assert.ok(allFields.every((field) => field.param_def_id != null), "every SLA field uses the canonical repository");
    assert.ok(storedSteps.filter((step) => step.step_number !== 6).every((step) => listQualRuns(db, step.id).length > 0), "all non-generated stages start with declared runs");
    assert.equal(listQualRuns(db, storedSteps.find((step) => step.step_number === 6)!.id).length, 0, "Step 6 starts empty until its condition matrix is generated");

    const parameters = new Map(listParamDefinitionsForProcess(db, experimentId, "sla_dlp").map((param) => [param.code, param]));
    assert.equal(parameters.get("exposure_time_s")?.doe_role, "factor");
    assert.equal(parameters.get("wait_before_exposure_s")?.doe_role, "factor");
    assert.equal(parameters.get("layer_uniformity_ok")?.doe_role, "response");
    assert.equal(parameters.get("critical_exposure_ec_mj_cm2")?.doe_role, "constraint");
    assert.equal(parameters.get("working_curve_validity"), undefined, "a manual acceptance status is not a parameter");
    assert.equal(parameters.get("final_conversion_pct")?.doe_role, "response");
    assert.equal(parameters.get("post_cure_delta_tg_c")?.doe_role, "response");
    assert.deepEqual(getDefaultActiveFactors("SIM", "sla_dlp"), [], "SLA DOE starts without invented universal ranges");

    for (let stepNumber = 1; stepNumber <= 7; stepNumber += 1) {
      assert.ok(getQualificationStudyGuide("sla_dlp", stepNumber), `Step ${stepNumber} has a guide`);
      assert.ok(getQualificationOutputDefinitionsForExperiment(db, experimentId, stepNumber).length > 0, `Step ${stepNumber} has portable outputs`);
    }
    const jacobsDefinition = getQualificationSeriesDefinitionsForExperiment(db, experimentId, 2)[0];
    assert.equal(jacobsDefinition?.code, "jacobs_working_curve");
    assert.equal(jacobsDefinition?.source, "run_fields");
    const jacobsOutputs = getQualificationOutputDefinitionsForExperiment(db, experimentId, 2);
    assert.ok(jacobsOutputs.every((definition) => definition.value_source === "summary"));
    assert.deepEqual(jacobsOutputs.map((definition) => definition.summary_key), [
      "jacobs_working_curve.critical_exposure_ec_mj_cm2",
      "jacobs_working_curve.penetration_depth_dp_um",
      "jacobs_working_curve.r_squared"
    ]);
    assert.deepEqual(getQualificationSeriesDefinitionsForExperiment(db, experimentId, 1), [], "recoating-window runs do not collect rheometer curves");
    assert.deepEqual(getOptionalQualificationStudies(db, experimentId).map((study) => study.stepNumber), [8]);
    const optionalRheology = setOptionalQualificationStudyEnabled(db, experimentId, 8, true);
    assert.equal(optionalRheology?.is_active, 1);
    assert.equal(getQualificationSeriesDefinitionsForExperiment(db, experimentId, 8)[0]?.code, "resin_flow_curve");
    const optionalFields = listQualFields(db, optionalRheology!.id).filter((field) => field.is_enabled === 1);
    assert.equal(optionalFields.length, 3);
    assert.ok(optionalFields.every((field) => field.param_def_id != null), "optional rheology fields use the canonical repository");
    const stepOne = storedSteps.find((step) => step.step_number === 1)!;
    const stepOneCodes = new Set(listQualFields(db, stepOne.id).filter((field) => field.is_enabled === 1).map((field) => field.code));
    assert.ok(stepOneCodes.has("wait_before_exposure_s"));
    assert.ok(stepOneCodes.has("layer_uniformity_ok"));
    assert.ok(!stepOneCodes.has("shear_rate_s_inv"));
    assert.ok(!stepOneCodes.has("viscosity_pa_s"));

    const stepTwo = storedSteps.find((step) => step.step_number === 2)!;
    const stepTwoRuns = listQualRuns(db, stepTwo.id);
    assert.equal(stepTwoRuns.length, 7, "Jacobs study starts with separate exposure runs");
    const stepTwoFields = new Map(listQualFields(db, stepTwo.id).map((field) => [field.code, field]));
    assert.ok(!stepTwoFields.has("wavelength_nm"), "wavelength is a setup condition, not a run column");
    assert.ok(!stepTwoFields.has("resin_temp_c"), "resin temperature is a setup condition, not a run column");
    assert.equal(stepTwoFields.get("irradiance_mw_cm2")?.is_enabled, 0, "the fixed optical factor is hidden from the run table");
    assert.equal(stepTwoFields.get("exposure_time_s")?.is_enabled, 1, "the selected optical factor is shown in the run table");
    upsertQualStepSettings(db, experimentId, 2, JSON.stringify({
      jacobs_variable_code: "exposure_time_s",
      jacobs_wavelength_nm: 405,
      jacobs_resin_temp_c: 25,
      jacobs_fixed_irradiance_mw_cm2: 5,
      jacobs_fixed_exposure_time_s: null
    }));
    const ec = 8;
    const dp = 120;
    const doses = [10, 20, 40, 80];
    doses.forEach((dose, index) => {
      const run = stepTwoRuns[index];
      [
        ["exposure_time_s", dose / 5],
        ["cure_depth_um", dp * Math.log(dose / ec)]
      ].forEach(([code, value]) => {
        const field = stepTwoFields.get(code as string);
        assert.ok(field, `${code} field exists`);
        saveQualRunValue(db, run.id, field!.id, "number", value as number);
      });
    });
    recomputeDerivedAndSummary(db, experimentId, stepTwo.id, 2);
    const stepTwoValues = new Map(listQualRunValues(db, stepTwoRuns[0].id).map((value) => [value.field_id, value.value_real]));
    const value = (code: string) => stepTwoValues.get(stepTwoFields.get(code)!.id);
    assert.equal(value("exposure_dose_mj_cm2"), 10);
    assert.ok(!stepTwoFields.has("critical_exposure_ec_mj_cm2"), "fitted values are not repeated in every run");
    const stepTwoSummary = JSON.parse(
      listQualSummaries(db, experimentId).find((summary) => summary.step_number === 2)?.summary_json || "{}"
    ) as { jacobs_working_curve?: { point_count?: number; fit_valid?: boolean; critical_exposure_ec_mj_cm2?: number; penetration_depth_dp_um?: number; r_squared?: number } };
    const jacobsFit = stepTwoSummary.jacobs_working_curve;
    assert.equal(jacobsFit?.point_count, doses.length);
    assert.equal(jacobsFit?.fit_valid, true);
    assert.ok(Math.abs((jacobsFit?.critical_exposure_ec_mj_cm2 ?? 0) - ec) < 1e-9);
    assert.ok(Math.abs((jacobsFit?.penetration_depth_dp_um ?? 0) - dp) < 1e-9);
    assert.ok(Math.abs((jacobsFit?.r_squared ?? 0) - 1) < 1e-12);

    const fit = calculateJacobsWorkingCurve(doses.map((dose) => ({ x_value: dose, y_value: dp * Math.log(dose / ec) })));
    assert.ok(fit);
    assert.equal(calculateJacobsWorkingCurve([{ x_value: 0, y_value: 1 }, { x_value: 1, y_value: 2 }]), null);

    // Step 3 gets its fixed optical/material conditions from Step 2. They are
    // setup data, while only layer height and calculated layer exposure vary
    // in the matrix rows.
    ensureQualificationDefaults(db, experimentId);
    const stepThree = storedSteps.find((step) => step.step_number === 3)!;
    const stepThreeFields = new Map(listQualFields(db, stepThree.id).map((field) => [field.code, field]));
    assert.equal(stepThreeFields.get("exposure_dose_mj_cm2")?.is_derived, 1);
    assert.equal(stepThreeFields.get("target_overcure_pct")?.is_derived, 1);
    assert.ok(!stepThreeFields.has("irradiance_mw_cm2"));
    assert.ok(!stepThreeFields.has("bottom_exposure_s"));
    assert.deepEqual(JSON.parse(getQualStepSettings(db, experimentId, 3) || "{}"), {
      exposure_window_wavelength_nm: 405,
      exposure_window_resin_temp_c: 25,
      exposure_window_irradiance_mw_cm2: 5,
      exposure_window_bottom_exposure_s: null
    });
    const stepFour = storedSteps.find((step) => step.step_number === 4)!;
    const stepFourFields = new Map(listQualFields(db, stepFour.id).map((field) => [field.code, field]));
    assert.ok(!stepFourFields.has("layer_height_um") || stepFourFields.get("layer_height_um")?.is_enabled === 0, "layer height is Step 4 setup, not a repeated run factor");
    assert.ok(!stepFourFields.has("exposure_time_s") || stepFourFields.get("exposure_time_s")?.is_enabled === 0, "exposure is Step 4 setup, not a repeated run factor");
    assert.equal(stepFourFields.get("artifact_feature_code")?.is_enabled, 1, "each measurement identifies its fixed NIST model element");
    assert.ok(!stepFourFields.has("cad_feature_size_um") || stepFourFields.get("cad_feature_size_um")?.is_enabled === 0, "the fixed nominal is not an editable measurement-table column");
    assert.ok(!stepFourFields.has("xy_compensation_mm") || stepFourFields.get("xy_compensation_mm")?.is_enabled === 0, "XY compensation is calculated from the inspection, not entered per element");
    assert.equal(listQualRuns(db, stepFour.id).length, 16, "the fixed NIST plan creates one record per model element");
    assert.deepEqual(JSON.parse(getQualStepSettings(db, experimentId, 4) || "{}"), {
      dimensional_layer_height_um: null,
      dimensional_exposure_time_s: null,
      dimensional_artifact_preset: "nist_am_test_artifact",
      dimensional_artifact_name: "NIST AM Test Artifact",
      dimensional_artifact_reference_url: "https://www.nist.gov/el/intelligent-systems-division-73500/production-systems-group/nist-additive-manufacturing-test",
      dimensional_artifact_revision: "NIST public test artifact"
    });
    const stepFive = storedSteps.find((step) => step.step_number === 5)!;
    const stepFiveFields = new Map(listQualFields(db, stepFive.id).map((field) => [field.code, field]));
    assert.equal(stepFiveFields.get("vat_film_type")?.is_enabled, 0, "vat film is a Step 5 setup condition, not a repeated run value");
    assert.equal(stepFiveFields.get("support_neck_diameter_mm")?.is_enabled, 0, "support neck is a Step 5 setup condition, not a repeated run value");
    assert.equal(stepFiveFields.get("exposure_time_s")?.is_enabled, 1, "exposure is a Step 5 matrix factor");
    assert.equal(stepFiveFields.get("lift_speed_mm_s")?.is_enabled, 1);
    assert.equal(stepFiveFields.get("layer_area_mm2")?.is_enabled, 1);
    assert.equal(getStepDefinitionForExperiment(db, experimentId, 5)?.run_generator?.type, "peel_force_matrix");
    const stepSix = storedSteps.find((step) => step.step_number === 6)!;
    const stepSixFields = new Map(listQualFields(db, stepSix.id).map((field) => [field.code, field]));
    assert.equal(stepSixFields.get("wash_method")?.is_enabled, 0, "wash method is a Step 6 setup condition, not a repeated run value");
    assert.equal(stepSixFields.get("wash_time_min")?.is_enabled, 0, "wash duration is a Step 6 setup condition, not a repeated run value");
    assert.equal(stepSixFields.get("reaction_band_uncured")?.is_enabled, 0, "baseline FTIR reaction area is a Step 6 setup condition, not a repeated run value");
    assert.equal(stepSixFields.get("reference_band_uncured")?.is_enabled, 0, "baseline FTIR reference area is a Step 6 setup condition, not a repeated run value");
    assert.equal(stepSixFields.get("post_cure_time_min")?.is_enabled, 1);
    assert.equal(stepSixFields.get("post_cure_temp_c")?.is_enabled, 1);
    assert.equal(stepSixFields.get("post_cure_irradiance_mw_cm2")?.is_enabled, 1);
    assert.equal(getStepDefinitionForExperiment(db, experimentId, 6)?.run_generator?.type, "post_cure_matrix");
    const stepSeven = storedSteps.find((step) => step.step_number === 7)!;
    const stepSevenFields = new Map(listQualFields(db, stepSeven.id).map((field) => [field.code, field]));
    assert.equal(stepSevenFields.get("build_orientation")?.is_enabled, 1, "orientation is the Step 7 specimen-level factor");
    assert.notEqual(stepSevenFields.get("resin_batch")?.is_enabled, 1, "the constant resin batch belongs to Step 7 setup, not every specimen row");

    const checkFormula = (stepNumber: number, inputs: Record<string, number | string>, outputCode: string, expected: number, runGroup?: string) => {
      const step = storedSteps.find((item) => item.step_number === stepNumber)!;
      const run = listQualRuns(db, step.id).find((item) => !runGroup || item.run_group === runGroup);
      assert.ok(run, `a ${runGroup || 'default'} run exists in step ${stepNumber}`);
      const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
      for (const [code, inputValue] of Object.entries(inputs)) {
        const field = fields.get(code);
        assert.ok(field, `${code} field exists in step ${stepNumber}`);
        saveQualRunValue(db, run!.id, field!.id, field!.field_type, inputValue);
      }
      recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
      const values = new Map(listQualRunValues(db, run!.id).map((item) => [item.field_id, item.value_real]));
      const actual = values.get(fields.get(outputCode)!.id) ?? 0;
      assert.ok(Math.abs(actual - expected) < 1e-9, `${outputCode} is calculated (expected ${expected}, got ${actual})`);
    };
    checkFormula(3, { exposure_time_s: 2 }, "exposure_dose_mj_cm2", 10);
    checkFormula(3, { cure_depth_um: 75, layer_height_um: 50 }, "overcure_pct", 50);
    checkFormula(4, { artifact_feature_code: "positive_fine_050", measured_feature_size_um: 475 }, "dimensional_error_um", -25);
    checkFormula(4, { artifact_feature_code: "positive_fine_050", measured_feature_size_um: 475 }, "absolute_dimensional_error_um", 25);
    checkFormula(4, { artifact_feature_code: "positive_fine_050", measured_feature_size_um: 475 }, "relative_dimensional_error_pct", -5);
    checkFormula(5, { peel_force_n: 30, layer_area_mm2: 1000 }, "average_peel_stress_mpa", 0.03);
    const stepFiveRun = listQualRuns(db, stepFive.id)[0];
    saveQualRunValue(db, stepFiveRun.id, stepFiveFields.get("green_tensile_strength_mpa")!.id, "number", 4.2);
    saveQualRunValue(db, stepFiveRun.id, stepFiveFields.get("print_failure")!.id, "boolean", false);
    recomputeDerivedAndSummary(db, experimentId, stepFive.id, 5);
    const stepFiveSummary = JSON.parse(
      listQualSummaries(db, experimentId).find((summary) => summary.step_number === 5)?.summary_json || "{}"
    ) as { peel_force?: { maximum_average_peel_stress_mpa?: number; median_green_tensile_strength_mpa?: number } };
    assert.equal(stepFiveSummary.peel_force?.maximum_average_peel_stress_mpa, 0.03);
    assert.equal(stepFiveSummary.peel_force?.median_green_tensile_strength_mpa, 4.2);
    const stepFiveOutputs = new Map(listQualStepOutputs(db, stepFive.id).map((output) => [output.output_code, output]));
    assert.equal(stepFiveOutputs.get("maximum_average_peel_stress_mpa")?.value_real, 0.03);
    assert.equal(stepFiveOutputs.get("green_strength_mpa")?.value_real, 4.2);
    const stepSixSettings = JSON.parse(getQualStepSettings(db, experimentId, 6) || "{}") as Record<string, unknown>;
    upsertQualStepSettings(db, experimentId, 6, JSON.stringify({
      ...stepSixSettings,
      post_cure_baseline_tg_c: 42
    }));
    createQualRuns(db, experimentId, stepSix.id, 1, "post_cure_condition");
    normalizeSlaDlpPostCureRuns(db, experimentId, stepSix.id);
    checkFormula(6, { final_tg_c: 70 }, "post_cure_delta_tg_c", 28, "post_cure_condition");

    const storedOutputs = new Map(listQualStepOutputs(db, stepTwo.id).map((output) => [output.output_code, output]));
    assert.ok(Math.abs((storedOutputs.get("critical_exposure_ec_mj_cm2")?.value_real ?? 0) - ec) < 1e-9);
    assert.ok(Math.abs((storedOutputs.get("penetration_depth_dp_um")?.value_real ?? 0) - dp) < 1e-9);
    assert.ok(Math.abs((storedOutputs.get("working_curve_r_squared")?.value_real ?? 0) - 1) < 1e-12);
    assert.equal(
      storedOutputs.get("critical_exposure_ec_mj_cm2")?.param_def_id,
      parameters.get("critical_exposure_ec_mj_cm2")?.id,
      "the automatically materialized result keeps its canonical identity"
    );

    const doeId = createDoeWithDefaults(db, {
      experimentId,
      name: "SLA response study",
      design_type: "SIM",
      seed: 42,
      center_points: 1,
      max_runs: 32,
      replicate_count: 1,
      recipe_as_block: 0
    });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM param_configs WHERE doe_id = ?").get(doeId) as { count: number }).count,
      0,
      "a new SLA DOE has no invented factor ranges"
    );
    const activeDoeResponses = db.prepare(
      "SELECT code FROM analysis_fields WHERE scope_type = 'DOE' AND scope_id = ? AND is_active = 1 ORDER BY code"
    ).all(doeId) as Array<{ code: string }>;
    const activeCodes = new Set(activeDoeResponses.map((row) => row.code));
    assert.ok(activeCodes.has("final_conversion_pct"));
    assert.ok(activeCodes.has("dimensional_error_um"));
    assert.ok(!activeCodes.has("critical_exposure_ec_mj_cm2"), "qualification constraints are not DOE responses");
    assert.ok(!activeCodes.has("sla_rheology_reference_viscosity_pa_s"), "material rheology evidence is not a DOE response");
  } finally {
    db.close();
  }
});

test("unknown process types do not silently receive injection qualification", () => {
  const db = openDb();
  try {
    const createdAt = new Date().toISOString();
    const typeId = Number(db.prepare(
      "INSERT INTO process_types (code, name, created_at) VALUES (?, ?, ?)"
    ).run("unknown_template", "Unknown template", createdAt).lastInsertRowid);
    const processId = Number(db.prepare(
      `INSERT INTO processes (process_type_id, name, route_code, owner_user_id, status, meta_json, created_at)
       VALUES (?, ?, ?, NULL, 'active', NULL, ?)`
    ).run(typeId, "Unknown template process", "unknown-template", createdAt).lastInsertRowid);
    const experimentId = createExperimentWithDefaults(db, { name: "Unknown template", process_id: processId });
    ensureQualificationDefaults(db, experimentId);
    assert.deepEqual(getQualificationStepsForExperiment(db, experimentId), []);
    assert.deepEqual(listQualSteps(db, experimentId), []);
  } finally {
    db.close();
  }
});

test("SLA/DLP demo seed fills every run, chart series and portable output idempotently", () => {
  const db = openDb();
  try {
    const experimentId = seedSlaDlpDemo(db);
    assert.equal(seedSlaDlpDemo(db), experimentId, "the demo seed updates its marked experiment");
    const experiments = db.prepare("SELECT COUNT(*) AS count FROM experiments WHERE notes = 'demo-seed:sla-dlp'")
      .get() as { count: number };
    assert.equal(experiments.count, 1);

    const steps = listQualSteps(db, experimentId);
    assert.equal(steps.length, 8);
    for (const step of steps) {
      assert.equal(step.status, "DONE");
      const fields = listQualFields(db, step.id).filter((field) => field.is_enabled === 1);
      const runs = listQualRuns(db, step.id);
      assert.ok(runs.length > 0);
      for (const run of runs) {
        assert.equal(run.done, 1);
        if (step.step_number === 6) {
          const expectedCodes = ["post_cure_time_min", "post_cure_temp_c", "post_cure_irradiance_mw_cm2", "residual_enthalpy_j_g", "final_tg_c", "post_cure_delta_tg_c", "post_cure_shrinkage_pct", "tensile_strength_mpa"];
          const values = new Map(listQualRunValues(db, run.id).map((value) => [value.field_id, value]));
          assert.equal(values.size, expectedCodes.length, `Step 6 ${run.run_code} only stores values from its declared method`);
          expectedCodes.forEach((code) => assert.ok(values.has(fields.find((field) => field.code === code)!.id), `${run.run_code} records ${code}`));
        } else {
          assert.equal(listQualRunValues(db, run.id).length, fields.length, `step ${step.step_number} run ${run.run_code} is complete`);
        }
      }
      assert.equal(
        listQualStepOutputs(db, step.id).length,
        getQualificationOutputDefinitionsForExperiment(db, experimentId, step.step_number).length,
        `step ${step.step_number} has every portable output`
      );
    }
    const stepSix = steps.find((step) => step.step_number === 6)!;
    const postCureRuns = listQualRuns(db, stepSix.id);
    assert.equal(postCureRuns.filter((run) => run.run_group === "post_cure_condition").length, 6);
    assert.equal(postCureRuns.length, 6, "one post-cure programme has one row containing all its measurements");
    const stepSeven = steps.find((step) => step.step_number === 7)!;
    const finalMechanicalSummary = JSON.parse(
      listQualSummaries(db, experimentId).find((summary) => summary.step_number === 7)?.summary_json || "{}"
    ) as { final_mechanical?: { xy_tensile_median_mpa?: number; xy_modulus_median_mpa?: number; z_to_xy_tensile_ratio?: number } };
    assert.equal(finalMechanicalSummary.final_mechanical?.xy_tensile_median_mpa, 61.5);
    assert.equal(finalMechanicalSummary.final_mechanical?.xy_modulus_median_mpa, 2135);
    assert.ok(Math.abs((finalMechanicalSummary.final_mechanical?.z_to_xy_tensile_ratio ?? 0) - 47.5 / 61.5) < 1e-12);
    const finalMechanicalOutputs = new Map(listQualStepOutputs(db, stepSeven.id).map((output) => [output.output_code, output.value_real]));
    assert.equal(finalMechanicalOutputs.get("qualified_tensile_strength_mpa"), 61.5);
    assert.equal(finalMechanicalOutputs.get("qualified_elastic_modulus_mpa"), 2135);
    assert.ok(Math.abs((finalMechanicalOutputs.get("orientation_anisotropy_ratio") ?? 0) - 47.5 / 61.5) < 1e-12);
    assert.deepEqual(JSON.parse(getQualStepSettings(db, experimentId, 7) || "{}"), {
      mechanical_resin_batch: "ER405-B24-017",
      mechanical_conditioning_temp_c: 23,
      mechanical_conditioning_time_h: 40,
      mechanical_conditioning_rh_pct: 50,
      mechanical_tensile_method: "ISO 527-2, type 1BA, 1 mm/min",
      mechanical_additional_methods: "ISO 178; ISO 75"
    });
    assert.equal(steps.flatMap((step) => listQualRuns(db, step.id)).length, 64);
    assert.equal(
      listQualRunSeries(db, stepSeven.id).filter((series) => series.series_code === "stress_strain_curve").length,
      6,
      "the final mechanical demo overlays one measured trace for every specimen"
    );
    assert.equal(steps.flatMap((step) => listQualRunSeries(db, step.id)).length, 9);
    const stepFour = steps.find((step) => step.step_number === 4)!;
    const dimensionalOutputs = new Map(listQualStepOutputs(db, stepFour.id).map((output) => [output.output_code, output.value_real]));
    assert.equal(dimensionalOutputs.get("minimum_feature_size_um"), 500);
    assert.ok(Math.abs((dimensionalOutputs.get("xy_compensation_mm") ?? 0) + 0.0045) < 1e-12);
    assert.ok(Math.abs((dimensionalOutputs.get("shrinkage_compensation_pct") ?? 0) - (100000 / 99860 - 1) * 100) < 1e-12);
    assert.deepEqual(JSON.parse(getQualStepSettings(db, experimentId, 4) || "{}"), {
      dimensional_layer_height_um: 50,
      dimensional_exposure_time_s: 2.87,
      dimensional_artifact_preset: "nist_am_test_artifact",
      dimensional_artifact_name: "NIST AM Test Artifact",
      dimensional_artifact_reference_url: "https://www.nist.gov/el/intelligent-systems-division-73500/production-systems-group/nist-additive-manufacturing-test",
      dimensional_artifact_revision: "NIST public test artifact"
    });
  } finally {
    db.close();
  }
});

test("SLA/DLP qualification renders through the shared Flowbite workspace with series and portable outputs", async () => {
  const { createApp } = await import("../app.js");
  const app = createApp();
  const db = openDb();
  try {
    db.prepare("UPDATE users SET password_hash = ?, temp_password = 0 WHERE email = ?").run(
      bcrypt.hashSync("AdminPass123!", 12),
      "admin@example.com"
    );
    const process = db.prepare(
      `SELECT process.id FROM processes process
       JOIN process_types type ON type.id = process.process_type_id
       WHERE type.code = 'sla_dlp' LIMIT 1`
    ).get() as { id: number };
    const experimentId = createExperimentWithDefaults(db, {
      name: "SLA shared UI",
      process_id: process.id
    });
    ensureQualificationDefaults(db, experimentId);
    setOptionalQualificationStudyEnabled(db, experimentId, 8, true);

    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent, "/auth/login");
    await agent.post("/auth/login")
      .type("form")
      .send({ email: "admin@example.com", password: "AdminPass123!", _csrf: csrf })
      .expect(302);

    const qualificationCsrf = await getCsrfToken(agent, `/experiments/${experimentId}/qualification/2`);
    await agent.post(`/experiments/${experimentId}/qualification/2/single-factor-sweep/setup`)
      .type("form")
      .send({
        variable_code: "exposure_time_s",
        jacobs_wavelength_nm: 405,
        jacobs_resin_temp_c: 25,
        jacobs_fixed_irradiance_mw_cm2: 5,
        _csrf: qualificationCsrf
      })
      .expect(200);
    assert.deepEqual(JSON.parse(getQualStepSettings(db, experimentId, 3) || "{}"), {
      exposure_window_wavelength_nm: 405,
      exposure_window_resin_temp_c: 25,
      exposure_window_irradiance_mw_cm2: 5,
      exposure_window_bottom_exposure_s: null
    });
    const generated = await agent.post(`/experiments/${experimentId}/qualification/2/single-factor-sweep`)
      .type("form")
      .send({ variable_code: "exposure_time_s", levels: "1; 2; 4", _csrf: qualificationCsrf })
      .expect(200);
    assert.deepEqual(generated.body.levels, [1, 2, 4]);
    assert.equal(generated.body.generated_run_codes.length, 3);
    const stepTwo = listQualSteps(db, experimentId).find((step) => step.step_number === 2)!;
    const stepTwoFields = new Map(listQualFields(db, stepTwo.id).map((field) => [field.code, field]));
    const firstGeneratedValues = new Map(listQualRunValues(db, listQualRuns(db, stepTwo.id)[0].id).map((value) => [value.field_id, value.value_real]));
    assert.ok(!stepTwoFields.has("wavelength_nm"));
    assert.ok(!stepTwoFields.has("resin_temp_c"));
    assert.equal(stepTwoFields.get("irradiance_mw_cm2")?.is_enabled, 0);
    assert.equal(firstGeneratedValues.get(stepTwoFields.get("irradiance_mw_cm2")!.id), undefined);
    assert.equal(firstGeneratedValues.get(stepTwoFields.get("exposure_time_s")!.id), 1);
    assert.deepEqual(JSON.parse(getQualStepSettings(db, experimentId, 2) || "{}"), {
      jacobs_variable_code: "exposure_time_s",
      jacobs_wavelength_nm: 405,
      jacobs_resin_temp_c: 25,
      jacobs_fixed_irradiance_mw_cm2: 5,
      jacobs_fixed_exposure_time_s: null
    });
    const handoffEc = 2.5;
    const handoffDp = 100;
    listQualRuns(db, stepTwo.id).slice(0, 3).forEach((run) => {
      const exposureTime = listQualRunValues(db, run.id)
        .find((value) => value.field_id === stepTwoFields.get("exposure_time_s")?.id)?.value_real!;
      saveQualRunValue(db, run.id, stepTwoFields.get("cure_depth_um")!.id, "number", handoffDp * Math.log((exposureTime * 5) / handoffEc));
    });
    recomputeDerivedAndSummary(db, experimentId, stepTwo.id, 2);
    await agent.post(`/experiments/${experimentId}/qualification/2/outputs/critical_exposure_ec_mj_cm2`)
      .type("form")
      .send({ value: "999", _csrf: qualificationCsrf })
      .expect(409);

    await agent.post(`/experiments/${experimentId}/qualification/3/exposure-layer-matrix/setup`)
      .type("form")
      .send({
        exposure_window_wavelength_nm: 405,
        exposure_window_resin_temp_c: 25,
        exposure_window_irradiance_mw_cm2: 5,
        exposure_window_bottom_exposure_s: 25,
        _csrf: qualificationCsrf
      })
      .expect(200);
    const exposureMatrix = await agent.post(`/experiments/${experimentId}/qualification/3/exposure-layer-matrix`)
      .type("form")
      .send({ layer_height_levels: "25; 50", target_overcure_levels: "20; 60", _csrf: qualificationCsrf })
      .expect(200);
    assert.equal(exposureMatrix.body.matrix_cell_count, 4);
    assert.equal(exposureMatrix.body.generated_run_codes.length, 4);
    const stepThree = listQualSteps(db, experimentId).find((step) => step.step_number === 3)!;
    const stepThreeFields = new Map(listQualFields(db, stepThree.id).map((field) => [field.code, field]));
    assert.ok(!stepThreeFields.has("irradiance_mw_cm2"), "irradiance is a Step 3 setup condition, not a run value");
    const firstMatrixValues = new Map(listQualRunValues(db, listQualRuns(db, stepThree.id)[0].id).map((value) => [value.field_id, value.value_real]));
    assert.equal(firstMatrixValues.get(stepThreeFields.get("layer_height_um")!.id), 25);
    assert.equal(firstMatrixValues.get(stepThreeFields.get("target_overcure_pct")!.id), 20);
    assert.ok(Math.abs((firstMatrixValues.get(stepThreeFields.get("exposure_time_s")!.id) ?? 0) - (handoffEc * Math.exp(30 / handoffDp) / 5)) < 1e-12);

    await agent.post(`/experiments/${experimentId}/qualification/3/outputs/qualified_layer_height_um`)
      .type("form")
      .send({ value: "50", _csrf: qualificationCsrf })
      .expect(200);
    await agent.post(`/experiments/${experimentId}/qualification/3/outputs/nominal_exposure_s`)
      .type("form")
      .send({ value: "2.87", _csrf: qualificationCsrf })
      .expect(200);
    ensureQualificationDefaults(db, experimentId);
    assert.equal((JSON.parse(getQualStepSettings(db, experimentId, 4) || "{}") as Record<string, unknown>).dimensional_layer_height_um, 50);
    assert.equal((JSON.parse(getQualStepSettings(db, experimentId, 4) || "{}") as Record<string, unknown>).dimensional_exposure_time_s, 2.87);
    await agent.post(`/experiments/${experimentId}/qualification/4/dimensional-artifact/setup`)
      .type("form")
      .send({
        dimensional_artifact_preset: "nist_am_test_artifact",
        dimensional_layer_height_um: 50,
        dimensional_exposure_time_s: 2.87,
        _csrf: qualificationCsrf
      })
      .expect(200);

    await agent.post(`/experiments/${experimentId}/qualification/5/peel-force-matrix/setup`)
      .type("form")
      .send({
        peel_vat_film_type: "nFEP",
        peel_support_neck_diameter_mm: 0.6,
        peel_support_geometry_note: "0.6 mm cylindrical necks, 1.5 mm tips, 45° build orientation",
        peel_layer_height_um: 50,
        _csrf: qualificationCsrf
      })
      .expect(200);
    const peelMatrix = await agent.post(`/experiments/${experimentId}/qualification/5/peel-force-matrix`)
      .type("form")
      .send({ lift_speed_levels: "0.8; 1.6", layer_area_levels: "600; 1200", exposure_time_levels: "2.6; 2.87", _csrf: qualificationCsrf })
      .expect(200);
    assert.equal(peelMatrix.body.matrix_cell_count, 8);
    const stepFive = listQualSteps(db, experimentId).find((step) => step.step_number === 5)!;
    const stepFiveFields = new Map(listQualFields(db, stepFive.id).map((field) => [field.code, field]));
    assert.equal(stepFiveFields.get("vat_film_type")?.is_enabled, 0);
    assert.equal(stepFiveFields.get("support_neck_diameter_mm")?.is_enabled, 0);
    assert.equal(stepFiveFields.get("exposure_time_s")?.is_enabled, 1);
    const firstPeelValues = new Map(listQualRunValues(db, listQualRuns(db, stepFive.id)[0].id).map((value) => [value.field_id, value.value_real]));
    assert.equal(firstPeelValues.get(stepFiveFields.get("lift_speed_mm_s")!.id), 0.8);
    assert.equal(firstPeelValues.get(stepFiveFields.get("layer_area_mm2")!.id), 600);
    assert.equal(firstPeelValues.get(stepFiveFields.get("exposure_time_s")!.id), 2.6);

    await agent.post(`/experiments/${experimentId}/qualification/6/post-cure-matrix/setup`)
      .type("form")
      .send({
        post_cure_wash_method: "IPA",
        post_cure_wash_time_min: 5,
        post_cure_source_note: "405 nm LED chamber, air, samples centred on turntable",
        post_cure_layer_height_um: 50,
        post_cure_exposure_time_s: 2.87,
        post_cure_baseline_tg_c: 42,
        post_cure_reaction_band_uncured: 1,
        post_cure_reference_band_uncured: 2,
        _csrf: qualificationCsrf
      })
      .expect(200);
    const postCureMatrix = await agent.post(`/experiments/${experimentId}/qualification/6/post-cure-matrix`)
      .type("form")
      .send({ post_cure_time_levels: "0; 10", post_cure_temp_levels: "50; 60", post_cure_irradiance_levels: "8", _csrf: qualificationCsrf })
      .expect(200);
    assert.equal(postCureMatrix.body.matrix_cell_count, 4);
    const stepSix = listQualSteps(db, experimentId).find((step) => step.step_number === 6)!;
    const stepSixFields = new Map(listQualFields(db, stepSix.id).map((field) => [field.code, field]));
    assert.equal(stepSixFields.get("wash_method")?.is_enabled, 0);
    assert.equal(stepSixFields.get("wash_time_min")?.is_enabled, 0);
    assert.equal(stepSixFields.get("post_cure_delta_tg_c")?.is_derived, 1);
    const firstPostCureValues = new Map(listQualRunValues(db, listQualRuns(db, stepSix.id)[0].id).map((value) => [value.field_id, value.value_real]));
    assert.equal(firstPostCureValues.get(stepSixFields.get("post_cure_time_min")!.id), 0);
    assert.equal(firstPostCureValues.get(stepSixFields.get("post_cure_temp_c")!.id), 50);
    assert.equal(firstPostCureValues.get(stepSixFields.get("post_cure_irradiance_mw_cm2")!.id), 8);

    await agent.post(`/experiments/${experimentId}/qualification/7/mechanical-qualification/setup`)
      .type("form")
      .send({
        mechanical_resin_batch: "ER405-B24-017",
        mechanical_conditioning_temp_c: 23,
        mechanical_conditioning_time_h: 40,
        mechanical_conditioning_rh_pct: 50,
        mechanical_tensile_method: "ISO 527-2, type 1BA, 1 mm/min",
        mechanical_additional_methods: "ISO 178; ISO 75",
        _csrf: qualificationCsrf
      })
      .expect(200);
    const stepSeven = listQualSteps(db, experimentId).find((step) => step.step_number === 7)!;
    const stepSevenFields = new Map(listQualFields(db, stepSeven.id).map((field) => [field.code, field]));
    assert.notEqual(stepSevenFields.get("resin_batch")?.is_enabled, 1);
    assert.equal(JSON.parse(getQualStepSettings(db, experimentId, 7) || "{}").mechanical_resin_batch, "ER405-B24-017");
    const stressStrainRun = listQualRuns(db, stepSeven.id)[0];
    const stressStrainUpload = await agent.post(`/qual-runs/${stressStrainRun.id}/series/stress_strain_curve/file`)
      .set("X-CSRF-Token", qualificationCsrf)
      .attach("file", Buffer.from("strain_pct\tstress_mpa\n0\t0\n1\t25\n2\t47\n3\t61\n"), "E19-Q7-R001.txt")
      .expect(201);
    assert.equal(stressStrainUpload.body.point_count, 4);
    assert.equal(stressStrainUpload.body.file.name, "E19-Q7-R001.txt");
    const uploadedSourceId = Number(stressStrainUpload.body.file.id);
    assert.ok(uploadedSourceId > 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM file_links WHERE file_id = ? AND entity_type = 'qualification_run' AND entity_id = ? AND placement = 'source_file:stress_strain_curve'")
        .get(uploadedSourceId, stressStrainRun.id) as { count: number }).count,
      1,
      "the raw stress-strain export is linked to its qualification specimen"
    );
    await agent.get(`/files/${uploadedSourceId}/download`).expect(200).expect("Content-Type", /text\/plain/);
    const profileFiles = await agent.get("/me?tab=files").expect(200);
    assert.match(profileFiles.text, /E19-Q7-R001\.txt/);
    assert.match(profileFiles.text, new RegExp(`href="/experiments/${experimentId}/qualification/7#finalMechanicalCurves"`));
    const repositoryFiles = await agent.get("/admin/files?entity_type=qualification_run&placement=source_file%3Astress_strain_curve").expect(200);
    assert.match(repositoryFiles.text, /E19-Q7-R001\.txt/);
    assert.match(repositoryFiles.text, new RegExp(`href="/experiments/${experimentId}/qualification/7#finalMechanicalCurves"`));

    const page = await agent.get(`/experiments/${experimentId}/qualification/2`).expect(200);
    assert.match(page.text, /Photocure Working Curve/);
    assert.match(page.text, /Experiment setup/);
    assert.match(page.text, /Jacobs exposure-run generator/);
    assert.match(page.text, /Changing parameter/);
    assert.match(page.text, /Measurement series/);
    assert.match(page.text, /Jacobs working curve/);
    assert.match(page.text, /One row = one point/);
    assert.match(page.text, /What the Jacobs working curve shows/);
    assert.match(page.text, /C<sub>d<\/sub> = D<sub>p<\/sub> · ln\(E \/ E<sub>c<\/sub>\)/);
    assert.match(page.text, /h-80 w-full rounded-base border border-default/);
    assert.match(page.text, /Jacobs working-curve result/);
    assert.match(page.text, /Calculated from dose\/depth evidence/);
    assert.match(page.text, /data-copy-table="#compoundingRunsTable"/);
    assert.match(page.text, /data-copy-table="#qualificationOutputValues-\d+"/);
    assert.doesNotMatch(page.text, /Import CSV/);
    assert.doesNotMatch(page.text, /Confirmed summary outputs/);
    assert.doesNotMatch(page.text, /data-step-output="critical_exposure_ec_mj_cm2"/);
    assert.doesNotMatch(page.text, /working_curve_validity/);
    assert.match(page.text, /data-tooltip-target="qualification-field-tip-/);
    assert.match(page.text, /aria-label="Exposure time \(s\)"[\s\S]{0,160}t exp/);
    assert.match(page.text, /href="\/ui\.css"/);

    const exposureWindowPage = await agent.get(`/experiments/${experimentId}/qualification/3`).expect(200);
    assert.match(exposureWindowPage.text, /Reference from Step 2: Jacobs working curve/);
    assert.match(exposureWindowPage.text, /Use Ec and Dp to select a sensible initial range/);
    assert.match(exposureWindowPage.text, /2\.5 mJ\/cm²/);
    assert.match(exposureWindowPage.text, /100 µm/);
    assert.match(exposureWindowPage.text, /Exposure × layer run generator/);
    assert.match(exposureWindowPage.text, /Generate matrix runs/);
    assert.match(exposureWindowPage.text, /Exposure × layer-height map/);
    assert.match(exposureWindowPage.text, /data-copy-table="#jacobsReferenceValues"/);
    assert.match(exposureWindowPage.text, /data-copy-table="#compoundingRunsTable"/);
    assert.match(exposureWindowPage.text, /data-copy-table="#qualificationOutputValues-\d+"/);
    assert.doesNotMatch(exposureWindowPage.text, /id="addRunBtn"/);

    const dimensionalPage = await agent.get(`/experiments/${experimentId}/qualification/4`).expect(200);
    assert.match(dimensionalPage.text, /NIST AM Test Artifact/);
    assert.match(dimensionalPage.text, /Official NIST model files/);
    assert.match(dimensionalPage.text, /nist-test-artifact-stlzip/);
    assert.match(dimensionalPage.text, /nist-test-artifact-amfzip/);
    assert.match(dimensionalPage.text, /nisttestartifactver3bzip/);
    assert.match(dimensionalPage.text, /public domain under 17 U\.S\.C\. §105/);
    assert.match(dimensionalPage.text, /NIST model-element measurements/);
    assert.match(dimensionalPage.text, /1 · Fine features/);
    assert.match(dimensionalPage.text, /4 · H → opposite side/);
    assert.match(dimensionalPage.text, /Find it on the sketch/);
    assert.match(dimensionalPage.text, /Positive fine feature · 0\.25 mm/);
    assert.match(dimensionalPage.text, /Measured \(mm\)/);
    assert.match(dimensionalPage.text, /overflow-x-auto rounded-base border border-default md:overflow-visible/);
    assert.match(dimensionalPage.text, /\[&_th\]:sticky \[&_th\]:top-16 \[&_th\]:z-30/);
    assert.match(dimensionalPage.text, /Δdim \(mm\)/);
    assert.match(dimensionalPage.text, /\|Δ\| \(mm\)/);
    assert.match(dimensionalPage.text, /data-storage-multiplier="1000"/);
    assert.match(dimensionalPage.text, /Dimensional error by model element/);
    assert.match(dimensionalPage.text, /nist_artifact_render\.png/);
    assert.match(dimensionalPage.text, /nist_artifact_map\.svg/);
    assert.match(dimensionalPage.text, /data-copy-table="#compoundingRunsTable"/);
    assert.match(dimensionalPage.text, /data-copy-table="#qualificationOutputValues-\d+"/);
    assert.doesNotMatch(dimensionalPage.text, /Custom test artifact/);
    assert.doesNotMatch(dimensionalPage.text, /id="addRunBtn"/);

    const peelPage = await agent.get(`/experiments/${experimentId}/qualification/5`).expect(200);
    assert.match(peelPage.text, /Lift speed × layer-area × exposure run generator/);
    assert.match(peelPage.text, /Peel-force measurements/);
    assert.match(peelPage.text, /Peel force by layer area, lift speed and exposure/);
    assert.match(peelPage.text, /Calculated evidence &amp; reviewed handoff/);
    assert.match(peelPage.text, /data-peel-force-table/);
    assert.match(peelPage.text, /id="peelForceMeasurementsTable"/);
    assert.match(peelPage.text, /data-copy-table="#peelForceMeasurementsTable"/);
    assert.match(peelPage.text, /data-copy-table="#qualificationOutputValues-\d+"/);
    assert.doesNotMatch(peelPage.text, /id="addRunBtn"/);

    const postCurePage = await agent.get(`/experiments/${experimentId}/qualification/6`).expect(200);
    assert.match(postCurePage.text, /Post-cure time × temperature × irradiance run generator/);
    assert.match(postCurePage.text, /Post-cure programme and measurements/);
    assert.match(postCurePage.text, /One row = one post-cure programme/);
    assert.match(postCurePage.text, /Post-cure response curves/);
    assert.match(postCurePage.text, /data-post-cure-table/);
    assert.match(postCurePage.text, /id="postCureMeasurementsTable"/);
    assert.match(postCurePage.text, /data-copy-table="#postCureMeasurementsTable"/);
    assert.match(postCurePage.text, /data-tooltip-target="post-cure-tip-delta"/);
    assert.match(postCurePage.text, /FTIR conversion[\s\S]{0,300}Deferred until the spectrum workflow is connected/);
    assert.match(postCurePage.text, /data-copy-table="#qualificationOutputValues-\d+"/);
    assert.doesNotMatch(postCurePage.text, /id="addRunBtn"/);

    const finalMechanicalPage = await agent.get(`/experiments/${experimentId}/qualification/7`).expect(200);
    assert.match(finalMechanicalPage.text, /Specimen and method setup/);
    assert.match(finalMechanicalPage.text, /Material provenance from Step 1/);
    assert.match(finalMechanicalPage.text, /Step 7 does not create a second material code/);
    assert.match(finalMechanicalPage.text, /Final mechanical specimens/);
    assert.match(finalMechanicalPage.text, /Calculated orientation summary/);
    assert.match(finalMechanicalPage.text, /Tensile strength by build orientation/);
    assert.match(finalMechanicalPage.text, /data-final-mechanical-table/);
    assert.match(finalMechanicalPage.text, /id="finalMechanicalRunsTable"/);
    assert.match(finalMechanicalPage.text, /id="finalMechanicalSummaryTable"/);
    assert.match(finalMechanicalPage.text, /data-copy-table="#finalMechanicalRunsTable"/);
    assert.match(finalMechanicalPage.text, /data-copy-table="#finalMechanicalSummaryTable"/);
    assert.match(finalMechanicalPage.text, /data-tooltip-target="final-mechanical-tip-tensile"/);
    assert.match(finalMechanicalPage.text, /data-tooltip-target="final-mechanical-summary-mean"/);
    assert.match(finalMechanicalPage.text, /data-final-mechanical-setup/);
    assert.match(finalMechanicalPage.text, /Stress–strain source files and curves/);
    assert.match(finalMechanicalPage.text, /id="slaFinalMechanicalStressStrainChart"/);
    assert.match(finalMechanicalPage.text, /id="finalMechanicalCurveDialog"/);
    assert.match(finalMechanicalPage.text, /E19-Q7-R001\.txt/);
    assert.match(finalMechanicalPage.text, /data-copy-table="#finalMechanicalCurveFilesTable"/);
    assert.match(finalMechanicalPage.text, /data-copy-table="#qualificationOutputValues-\d+"/);
    assert.doesNotMatch(finalMechanicalPage.text, /id="compoundingRunsTable"/);
    await agent.delete(`/qual-runs/${stressStrainRun.id}/series/stress_strain_curve/source`)
      .set("X-CSRF-Token", qualificationCsrf)
      .expect(200);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM file_links WHERE file_id = ? AND entity_type = 'qualification_run' AND entity_id = ? AND placement = 'source_file:stress_strain_curve'")
        .get(uploadedSourceId, stressStrainRun.id) as { count: number }).count,
      0,
      "removing the source detaches it from the specimen for a replacement upload"
    );

    const recoatPage = await agent.get(`/experiments/${experimentId}/qualification/1`).expect(200);
    assert.match(recoatPage.text, /Resin Conditioning &amp; Recoating Window/);
    assert.match(recoatPage.text, /data-field-id=.*wait_before_exposure_s|Wait before exposure/);
    assert.match(recoatPage.text, /data-copy-table="#compoundingRunsTable"/);
    assert.match(recoatPage.text, /data-copy-table="#qualificationOutputValues-\d+"/);
    assert.match(recoatPage.text, /id="addRunBtn"[^>]*title="Add run"/);
    assert.doesNotMatch(recoatPage.text, /Resin viscosity curve/);

    const rheologyStep = listQualSteps(db, experimentId).find((step) => step.step_number === 8)!;
    const rheologyRun = listQualRuns(db, rheologyStep.id)[0];
    await agent.post(`/qual-runs/${rheologyRun.id}/series/resin_flow_curve/file`)
      .set("X-CSRF-Token", qualificationCsrf)
      .attach("file", Buffer.from("shear_rate_s_inv,viscosity_pa_s\n0.1,1.42\n1,1.40\n10,1.36\n100,1.28\n"), "E19-Q8-R001.csv")
      .expect(201);
    const rheologyPage = await agent.get(`/experiments/${experimentId}/qualification/8`).expect(200);
    assert.match(rheologyPage.text, /Additional: Resin Flow Characterisation/);
    assert.match(rheologyPage.text, /Material and measurement setup/);
    assert.match(rheologyPage.text, /Flow-curve comparison runs/);
    assert.match(rheologyPage.text, /Temperature is the only run-level factor/);
    assert.match(rheologyPage.text, /id="slaRheologyFlowChart"/);
    assert.match(rheologyPage.text, /id="rheologyCurveDialog"/);
    assert.match(rheologyPage.text, /E19-Q8-R001\.csv/);
    assert.match(rheologyPage.text, /data-copy-table="#rheologyRunsTable"/);
    assert.match(rheologyPage.text, /data-copy-table="#rheologySourcesTable"/);
    assert.match(rheologyPage.text, /data-copy-table="#qualificationOutputValues-\d+"/);
    assert.doesNotMatch(rheologyPage.text, /id="compoundingRunsTable"/);
  } finally {
    db.close();
  }
});
