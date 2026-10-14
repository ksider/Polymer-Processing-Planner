import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import { getDesignMetadata } from "../repos/experiments_repo.js";
import { listParamDefinitionsByKindForProcess, upsertParamConfig } from "../repos/params_repo.js";
import { listQualSteps, upsertQualStepOutput } from "../repos/qual_repo.js";
import { createDoeWithDefaults, createExperimentWithDefaults, generateRuns } from "../services/experiments_service.js";
import { getExtrusionQualificationConstraintSnapshot } from "../services/extrusion_doe_constraints.js";
import { ensureExtrusionParameterCatalogue, ensureQualificationDefaults, setOptionalQualificationStudyEnabled } from "../services/qualification_service.js";
import { ensureSeedParams } from "../services/seed.js";

test("extrusion DOE keeps a qualification snapshot and checks all supported design levels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-extrusion-constraints-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  const db = openDb();
  try {
    ensureSeedParams(db);
    ensureExtrusionParameterCatalogue(db);
    const extrusionProcess = db.prepare(
      `SELECT process.id FROM processes process
       JOIN process_types type ON type.id = process.process_type_id
       WHERE type.code = 'extrusion_v1' LIMIT 1`
    ).get() as { id: number } | undefined;
    assert.ok(extrusionProcess);
    const experimentId = createExperimentWithDefaults(db, { name: "Constraint handoff", process_id: extrusionProcess.id });
    ensureQualificationDefaults(db, experimentId);
    setOptionalQualificationStudyEnabled(db, experimentId, 8, true);
    setOptionalQualificationStudyEnabled(db, experimentId, 9, true);

    const steps = new Map(listQualSteps(db, experimentId).map((step) => [step.step_number, step]));
    const setOutput = (stepNumber: number, outputCode: string, value: number) => {
      const step = steps.get(stepNumber);
      assert.ok(step, `step ${stepNumber} exists`);
      upsertQualStepOutput(db, {
        experiment_id: experimentId,
        step_id: step!.id,
        output_group: "handoff",
        output_code: outputCode,
        param_def_id: null,
        value_real: value,
        value_text: null
      });
    };
    setOutput(1, "processing_temp_min_c", 170);
    setOutput(1, "processing_temp_max_c", 230);
    setOutput(1, "max_thermal_hold_min", 8);
    setOutput(2, "feeder_stable_throughput_min_kg_h", 20);
    setOutput(2, "feeder_stable_throughput_max_kg_h", 60);
    setOutput(3, "operating_window_min_screw_rpm", 100);
    setOutput(3, "operating_window_max_screw_rpm", 300);
    setOutput(8, "required_vacuum_pressure_mbar", 100);
    setOutput(9, "reactive_temp_min_c", 185);
    setOutput(9, "reactive_temp_max_c", 225);

    const inputParams = listParamDefinitionsByKindForProcess(db, experimentId, "INPUT", "extrusion_v1");
    const configure = (doeId: number, code: string, min: number, max: number, mode: "RANGE" | "LIST" = "RANGE") => {
      const parameter = inputParams.find((item) => item.code === code);
      assert.ok(parameter, `${code} is a catalogue input`);
      upsertParamConfig(db, {
        experiment_id: experimentId,
        doe_id: doeId,
        param_def_id: parameter!.id,
        active: 1,
        mode,
        fixed_value_real: null,
        range_min_real: mode === "RANGE" ? min : null,
        range_max_real: mode === "RANGE" ? max : null,
        list_json: mode === "LIST" ? JSON.stringify([min, (min + max) / 2, max]) : null,
        level_count: mode === "RANGE" ? 3 : null
      });
    };
    const create = (designType: string) => createDoeWithDefaults(db, {
      experimentId,
      name: `${designType} handoff`,
      design_type: designType,
      seed: 42,
      center_points: 3,
      max_runs: 12,
      replicate_count: 1,
      recipe_as_block: 0
    });

    const simId = create("SIM");
    configure(simId, "barrel_set_temp_c", 180, 220);
    configure(simId, "throughput_kg_h", 25, 50);
    generateRuns(db, experimentId, simId);

    const ffaId = create("FFA");
    configure(ffaId, "barrel_set_temp_c", 180, 220, "LIST");
    configure(ffaId, "throughput_kg_h", 25, 50, "LIST");
    generateRuns(db, experimentId, ffaId);

    const screeningId = create("SCREEN");
    configure(screeningId, "screw_speed_rpm", 120, 280);
    configure(screeningId, "throughput_kg_h", 25, 50);
    generateRuns(db, experimentId, screeningId);

    const bbdId = create("BBD");
    configure(bbdId, "reaction_temp_c", 190, 220);
    configure(bbdId, "screw_speed_rpm", 120, 280);
    configure(bbdId, "throughput_kg_h", 25, 50);
    generateRuns(db, experimentId, bbdId);

    const snapshot = getExtrusionQualificationConstraintSnapshot(
      JSON.parse(getDesignMetadata(db, experimentId, bbdId)!) as Record<string, unknown>
    );
    assert.ok(snapshot);
    assert.equal(snapshot!.constraints.some((item) => item.target_param_code === "reaction_temp_c"), true);
    assert.equal(snapshot!.constraints.some((item) => item.kind === "quality_gate"), true);

    setOutput(1, "processing_temp_min_c", 200);
    const storedSnapshot = getExtrusionQualificationConstraintSnapshot(
      JSON.parse(getDesignMetadata(db, experimentId, simId)!) as Record<string, unknown>
    );
    assert.equal(
      storedSnapshot!.constraints.find((item) => item.source_output_code === "processing_temp_min_c")?.value,
      170,
      "a DOE retains the reviewed qualification values present at its creation"
    );

    const invalidId = create("SIM");
    configure(invalidId, "barrel_set_temp_c", 160, 220);
    assert.throws(() => generateRuns(db, experimentId, invalidId), /below the qualification minimum/);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
