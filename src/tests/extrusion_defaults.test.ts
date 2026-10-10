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
  replaceQualRunSeries
} from "../repos/qual_repo.js";
import { createExperimentWithDefaults } from "../services/experiments_service.js";
import {
  ensureQualificationDefaults,
  getQualificationOutputDefinitionsForExperiment,
  getQualificationStepsForExperiment,
  recomputeDerivedAndSummary,
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
  } finally {
    db.close();
  }
});
