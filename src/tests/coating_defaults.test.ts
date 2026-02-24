import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { openDb } from "../db.js";
import { listQualFields, listQualSteps } from "../repos/qual_repo.js";
import { listParamConfigs, listParamDefinitionsByKind } from "../repos/params_repo.js";
import { listExperimentAnalysisFields } from "../repos/analysis_repo.js";
import { createDoeWithDefaults, createExperimentWithDefaults } from "../services/experiments_service.js";
import { ensureQualificationDefaults, getQualificationStepsForExperiment } from "../services/qualification_service.js";
import { ensureSeedParams } from "../services/seed.js";

let dbPath = "";

before(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-coating-"));
  dbPath = path.join(tempDir, "test.sqlite");
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
});

after(() => {
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // ignore locked db on Windows
    }
  }
});

test("coating experiment gets process-specific qualification pack and DOE defaults", () => {
  const db = openDb();
  ensureSeedParams(db);
  const coatingProcess = db
    .prepare(
      `
      SELECT p.id
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      WHERE pt.code = 'coating'
      ORDER BY p.id
      LIMIT 1
      `
    )
    .get() as { id: number } | undefined;

  assert.ok(coatingProcess?.id, "coating process not seeded");

  const experimentId = createExperimentWithDefaults(db, {
    name: "Coating default smoke",
    process_id: coatingProcess?.id ?? null
  });

  ensureQualificationDefaults(db, experimentId);
  const steps = getQualificationStepsForExperiment(db, experimentId);
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "Rheology Window",
      "Wetting / Surface Energy Check",
      "Coat Weight Calibration",
      "Drying / Curing Window",
      "Adhesion Qualification",
      "Barrier / Functional Check"
    ]
  );

  const qualStepRows = listQualSteps(db, experimentId);
  const step1 = qualStepRows.find((row) => row.step_number === 1);
  assert.ok(step1, "qualification step 1 is missing");
  const step1FieldCodes = new Set(listQualFields(db, step1?.id ?? 0).map((field) => field.code));
  assert.ok(step1FieldCodes.has("solids_pct"));
  assert.ok(step1FieldCodes.has("viscosity_10s"));
  assert.equal(step1FieldCodes.has("inj_speed"), false, "injection-only fields should not be seeded");

  const doeId = createDoeWithDefaults(db, {
    experimentId,
    name: "Coating DOE",
    design_type: "SIM",
    seed: 42,
    center_points: 3,
    max_runs: 200,
    replicate_count: 1,
    recipe_as_block: 0
  });
  const inputDefs = listParamDefinitionsByKind(db, experimentId, "INPUT");
  const inputDefById = new Map(inputDefs.map((def) => [def.id, def.code]));
  const activeCodes = listParamConfigs(db, experimentId, doeId)
    .filter((cfg) => cfg.active === 1)
    .map((cfg) => inputDefById.get(cfg.param_def_id))
    .filter((code): code is string => Boolean(code));

  assert.deepEqual(activeCodes.sort(), ["coating_speed_m_min", "drying_temp_C", "solids_pct"]);

  const activeOutputCodes = listExperimentAnalysisFields(db, doeId)
    .filter((field) => field.is_active === 1)
    .map((field) => field.code)
    .sort();
  assert.deepEqual(activeOutputCodes, [
    "OTR_cc_m2_day",
    "WVTR_g_m2_day",
    "adhesion_score",
    "coat_weight_g_m2",
    "defect_tags",
    "dry_thickness_um",
    "water_contact_angle_deg"
  ]);
});
