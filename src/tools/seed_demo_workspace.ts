import path from "path";
import { fileURLToPath } from "url";
import { openDb, type Db } from "../db.js";
import { listActiveAnalysisFields, upsertAnalysisRunValue } from "../repos/analysis_repo.js";
import { listDoeStudies } from "../repos/doe_repo.js";
import { upsertDesignMetadata } from "../repos/experiments_repo.js";
import { listParamDefinitionsByKindForProcess, upsertParamConfig } from "../repos/params_repo.js";
import {
  createReportConfig,
  listReportConfigs,
  updateReportConfig,
  updateReportNumber,
  updateReportSetup,
  upsertReportDocument
} from "../repos/reports_repo.js";
import { listRuns, listRunValues, updateRunStatus } from "../repos/runs_repo.js";
import { createDoeWithDefaults, generateRuns } from "../services/experiments_service.js";
import { captureExtrusionQualificationConstraints } from "../services/extrusion_doe_constraints.js";
import { seedExtrusionDemo } from "./seed_extrusion_demo.js";
import { seedSlaDlpDemo } from "./seed_sla_dlp_demo.js";

const DOE_NAME = "Demo DOE · PP mineral dispersion screening";
const DOE_SEED = 20261018;
const SLA_DOE_NAME = "Demo DOE · SLA/DLP print-window screening";
const SLA_DOE_SEED = 20261019;
const REPORT_NAME = "Demo report · extrusion qualification and DOE";
const REPORT_NUMBER = "DEMO-EXTR-001";

type DemoWorkspace = {
  extrusionExperimentId: number;
  slaDlpExperimentId: number;
  doeId: number;
  slaDlpDoeId: number;
  reportId: number;
};

function findOrCreateDoe(db: Db, experimentId: number) {
  const existing = listDoeStudies(db, experimentId).find((doe) =>
    doe.name === DOE_NAME && doe.seed === DOE_SEED && doe.design_type === "SCREEN"
  );
  const doeId = existing?.id ?? createDoeWithDefaults(db, {
      experimentId,
      name: DOE_NAME,
      design_type: "SCREEN",
      seed: DOE_SEED,
      center_points: 3,
      max_runs: 11,
      replicate_count: 1,
      recipe_as_block: 0,
      preset_code: "filled_mineral_dispersion_screening"
    });

  // The preset is narrowed to outputs confirmed by the seeded qualification.
  // It keeps the sample DOE inside the processing, feeder and vacuum limits.
  const byCode = new Map(
    listParamDefinitionsByKindForProcess(db, experimentId, "INPUT", "extrusion_v1")
      .map((param) => [param.code, param])
  );
  const setRange = (code: string, min: number, max: number) => {
    const param = byCode.get(code);
    if (!param) throw new Error(`Demo DOE parameter is missing: ${code}`);
    upsertParamConfig(db, {
      experiment_id: experimentId, doe_id: doeId, param_def_id: param.id, active: 1,
      mode: "RANGE", fixed_value_real: null, range_min_real: min, range_max_real: max,
      list_json: null, level_count: 2
    });
  };
  const setFixed = (code: string, value: number) => {
    const param = byCode.get(code);
    if (!param) throw new Error(`Demo DOE parameter is missing: ${code}`);
    upsertParamConfig(db, {
      experiment_id: experimentId, doe_id: doeId, param_def_id: param.id, active: 1,
      mode: "FIXED", fixed_value_real: value, range_min_real: null, range_max_real: null,
      list_json: null, level_count: null
    });
  };
  setRange("screw_speed_rpm", 150, 350);
  setRange("planned_throughput_kg_h", 12, 40);
  setRange("barrel_set_temp_c", 180, 210);
  setFixed("vacuum_target_pressure_mbar", 50);
  upsertDesignMetadata(db, experimentId, doeId, JSON.stringify({
    extrusion_qualification_constraints: captureExtrusionQualificationConstraints(db, experimentId)
  }));
  return doeId;
}

function valueFor(map: Map<string, number | null>, code: string) {
  return map.get(code) ?? 0;
}

function seedDoeResponses(db: Db, doeId: number) {
  const fields = new Map(listActiveAnalysisFields(db, doeId).map((field) => [field.code, field]));
  const inputRows = db.prepare(
      `SELECT p.id, p.code FROM param_definitions p
       WHERE p.field_kind = 'INPUT' AND p.scope = 'GLOBAL'`
    ).all() as Array<{ id: number; code: string }>;
  const inputs = new Map<number, string>(inputRows.map((row) => [row.id, row.code]));
  const response = (code: string, runId: number, value: number) => {
    const field = fields.get(code);
    if (field) upsertAnalysisRunValue(db, runId, field.id, Number(value.toFixed(3)), null, null);
  };

  listRuns(db, doeId).forEach((run, index) => {
    const factors = new Map<string, number | null>();
    listRunValues(db, run.id).forEach((item) => {
      const code = inputs.get(item.param_def_id);
      if (code) factors.set(code, item.value_real);
    });
    const speed = valueFor(factors, "screw_speed_rpm");
    const throughput = valueFor(factors, "planned_throughput_kg_h");
    const temperature = valueFor(factors, "barrel_set_temp_c");
    const coupling = valueFor(factors, "coupling_agent_wt_pct");
    const wobble = ((index % 3) - 1) * 0.6;
    const torque = 188 + 0.52 * speed + 4.7 * throughput + 0.55 * (temperature - 190) - 14 * coupling + wobble;

    response("motor_torque_nm", run.id, torque);
    response("melt_pressure_bar", run.id, 25 + 0.065 * speed + 0.74 * throughput + 0.18 * (temperature - 190) + wobble);
    response("melt_temp_c", run.id, temperature + 10 + 0.018 * speed + 0.08 * throughput + wobble);
    response("sme_kwh_kg", run.id, torque * speed / (9549 * Math.max(throughput, 1)));
    response("complex_viscosity_pa_s", run.id, 1230 - 2.1 * (temperature - 180) - 0.65 * speed + 32 * coupling + wobble * 8);
    response("tensile_strength_mpa", run.id, 31.5 + 1.65 * coupling + 0.025 * (temperature - 180) + 0.008 * (speed - 150) - 0.045 * (throughput - 12) + wobble * 0.2);
    response("mfr_g_10min", run.id, 4.8 + 0.035 * (temperature - 180) + 0.004 * (speed - 150) - 0.018 * (throughput - 12) - 0.2 * coupling + wobble * 0.04);
    updateRunStatus(db, run.id, 1, 0);
  });
}

function findOrCreateSlaDlpDoe(db: Db, experimentId: number) {
  const existing = listDoeStudies(db, experimentId).find((doe) =>
    doe.name === SLA_DOE_NAME && doe.seed === SLA_DOE_SEED && doe.design_type === "SCREEN"
  );
  const doeId = existing?.id ?? createDoeWithDefaults(db, {
    experimentId,
    name: SLA_DOE_NAME,
    design_type: "SCREEN",
    seed: SLA_DOE_SEED,
    center_points: 0,
    max_runs: 8,
    replicate_count: 1,
    recipe_as_block: 0
  });
  const byCode = new Map(
    listParamDefinitionsByKindForProcess(db, experimentId, "INPUT", "sla_dlp")
      .map((param) => [param.code, param])
  );
  const setRange = (code: string, min: number, max: number) => {
    const param = byCode.get(code);
    if (!param) throw new Error(`SLA/DLP demo DOE parameter is missing: ${code}`);
    upsertParamConfig(db, {
      experiment_id: experimentId, doe_id: doeId, param_def_id: param.id, active: 1,
      mode: "RANGE", fixed_value_real: null, range_min_real: min, range_max_real: max,
      list_json: null, level_count: 2
    });
  };
  const setFixed = (code: string, value: number) => {
    const param = byCode.get(code);
    if (!param) throw new Error(`SLA/DLP demo DOE parameter is missing: ${code}`);
    upsertParamConfig(db, {
      experiment_id: experimentId, doe_id: doeId, param_def_id: param.id, active: 1,
      mode: "FIXED", fixed_value_real: value, range_min_real: null, range_max_real: null,
      list_json: null, level_count: null
    });
  };
  // These limits are the handoff values seeded by steps 1–5. Layer height and
  // irradiance remain fixed conditions, not repeated DOE factors.
  setRange("resin_temp_c", 20, 30);
  setRange("exposure_time_s", 2.64, 3.16);
  setRange("lift_speed_mm_s", 0.8, 2.0);
  setFixed("layer_height_um", 50);
  setFixed("irradiance_mw_cm2", 5);
  setFixed("wait_before_exposure_s", 5);
  return doeId;
}

function seedSlaDlpDoeResponses(db: Db, doeId: number) {
  const fields = new Map(listActiveAnalysisFields(db, doeId).map((field) => [field.code, field]));
  const inputRows = db.prepare(
    `SELECT p.id, p.code FROM param_definitions p
     WHERE p.field_kind = 'INPUT' AND p.scope = 'GLOBAL'`
  ).all() as Array<{ id: number; code: string }>;
  const inputCodes = new Map<number, string>(inputRows.map((row) => [row.id, row.code]));
  const response = (code: string, runId: number, value: number) => {
    const field = fields.get(code);
    if (field) upsertAnalysisRunValue(db, runId, field.id, Number(value.toFixed(3)), null, null);
  };

  listRuns(db, doeId).forEach((run, index) => {
    const factors = new Map<string, number | null>();
    listRunValues(db, run.id).forEach((item) => {
      const code = inputCodes.get(item.param_def_id);
      if (code) factors.set(code, item.value_real);
    });
    const temperature = valueFor(factors, "resin_temp_c");
    const exposure = valueFor(factors, "exposure_time_s");
    const lift = valueFor(factors, "lift_speed_mm_s");
    const exposureDelta = exposure - 2.87;
    const temperatureDelta = temperature - 25;
    const liftDelta = lift - 1.4;
    const wobble = ((index % 3) - 1) * 0.35;

    response("layer_uniformity_ok", run.id, Math.abs(exposureDelta) <= 0.22 && lift <= 1.8 ? 1 : 0);
    response("actual_layer_thickness_um", run.id, 50 + exposureDelta * 2.2 + wobble);
    response("xy_bleed_um", run.id, 24 + exposureDelta * 25 + temperatureDelta * 0.8 + wobble);
    response("minimum_open_channel_um", run.id, 240 - exposureDelta * 80 - liftDelta * 10 + wobble * 3);
    response("dimensional_error_um", run.id, 31 + Math.abs(exposureDelta) * 36 + Math.abs(temperatureDelta) * 1.2 + wobble);
    response("peel_force_n", run.id, 20 + lift * 10 + exposureDelta * 4 + wobble);
    response("green_tensile_strength_mpa", run.id, 3.6 + exposureDelta * 0.9 - liftDelta * 0.18 + wobble * 0.03);
    response("final_conversion_pct", run.id, 76 + exposureDelta * 7 + temperatureDelta * 0.15 + wobble);
    response("final_tg_c", run.id, 60 + exposureDelta * 4 + temperatureDelta * 0.1 + wobble);
    response("tensile_strength_mpa", run.id, 59 + exposureDelta * 5 - liftDelta * 0.4 + wobble);
    response("flexural_strength_mpa", run.id, 74 + exposureDelta * 3 + wobble);
    response("hdt_c", run.id, 74 + exposureDelta * 2 + temperatureDelta * 0.08 + wobble);
    updateRunStatus(db, run.id, 1, 0);
  });
}

function demoReportDocument() {
  const heading = (text: string, level: 2 | 3) => ({
    type: "heading", attrs: { level }, content: [{ type: "text", text }]
  });
  const paragraph = (text: string) => ({
    type: "paragraph", content: [{ type: "text", text }]
  });
  const markdown = [
    "## 1. Demo workspace",
    "This editable draft is generated with synthetic data for interface and workflow demonstrations. It is not an approved technical report.",
    "",
    "## 2. Material and equipment",
    "PP mineral-filled compound; the qualification workspace contains the material provenance and run records.",
    "",
    "## 3. Qualification",
    "The seeded extrusion qualification supplies the permitted thermal, feed-rate and operating-window constraints for the DOE.",
    "",
    "## 4. DOE screening",
    "Eleven synthetic screening runs vary screw speed, throughput, barrel temperature and coupling-agent content. Vacuum is fixed at 50 mbar.",
    "",
    "## 5. Demo conclusion",
    "Review the data and complete a real analysis before drawing process conclusions or submitting this report for signature."
  ].join("\n");
  return {
    json: JSON.stringify({
      type: "doc",
      content: [
        heading("1. Demo workspace", 2),
        paragraph("This editable draft is generated with synthetic data for interface and workflow demonstrations. It is not an approved technical report."),
        heading("2. Material and equipment", 2),
        paragraph("PP mineral-filled compound; the qualification workspace contains the material provenance and run records."),
        heading("3. Qualification", 2),
        paragraph("The seeded extrusion qualification supplies the permitted thermal, feed-rate and operating-window constraints for the DOE."),
        heading("4. DOE screening", 2),
        paragraph("Eleven synthetic screening runs vary screw speed, throughput, barrel temperature and coupling-agent content. Vacuum is fixed at 50 mbar."),
        heading("5. Demo conclusion", 2),
        paragraph("Review the data and complete a real analysis before drawing process conclusions or submitting this report for signature.")
      ]
    }),
    markdown
  };
}

function findOrCreateReport(db: Db, experimentId: number, doeId: number, authorUserId: number | null) {
  const existing = listReportConfigs(db, experimentId).find((report) => report.report_number === REPORT_NUMBER);
  // A signed report is an immutable record even when it started as a demo.
  // Keep it intact rather than silently replacing its approved document.
  if (existing?.signed_at) return existing.id;
  const base = {
    name: REPORT_NAME,
    executors: "Demo workspace",
    include_json: JSON.stringify(["qualification", "doe"]),
    doe_ids_json: JSON.stringify([doeId])
  };
  const reportId = existing?.id ?? createReportConfig(db, {
    experiment_id: experimentId,
    ...base,
    description: "Synthetic demonstration data. Draft only; not approved for technical decisions.",
    author_user_id: authorUserId,
    responsible_user_id: authorUserId,
    report_type: "COMBINED",
    template_code: "standard-combined"
  });
  updateReportConfig(db, reportId, base);
  updateReportSetup(db, reportId, {
    name: REPORT_NAME,
    description: "Synthetic demonstration data. Draft only; not approved for technical decisions.",
    author_user_id: authorUserId,
    responsible_user_id: authorUserId,
    due_at: null,
    report_number: REPORT_NUMBER,
    report_type: "COMBINED",
    template_code: "standard-combined",
    signature_sla_days: 7
  });
  updateReportNumber(db, reportId, REPORT_NUMBER);
  const document = demoReportDocument();
  upsertReportDocument(db, reportId, document.json, null, document.markdown, "tiptap", 1);
  return reportId;
}

export function seedExtrusionDemoDeliverables(db: Db, experimentId: number) {
  const owner = db.prepare("SELECT owner_user_id FROM experiments WHERE id = ?").get(experimentId) as { owner_user_id: number | null } | undefined;
  const doeId = findOrCreateDoe(db, experimentId);
  generateRuns(db, experimentId, doeId);
  seedDoeResponses(db, doeId);
  const reportId = findOrCreateReport(db, experimentId, doeId, owner?.owner_user_id ?? null);
  return { doeId, reportId };
}

export function seedDemoWorkspace(db: Db): DemoWorkspace {
  const extrusionExperimentId = seedExtrusionDemo(db);
  const slaDlpExperimentId = seedSlaDlpDemo(db);
  const { doeId, reportId } = seedExtrusionDemoDeliverables(db, extrusionExperimentId);
  const slaDlpDoeId = findOrCreateSlaDlpDoe(db, slaDlpExperimentId);
  generateRuns(db, slaDlpExperimentId, slaDlpDoeId);
  seedSlaDlpDoeResponses(db, slaDlpDoeId);
  return { extrusionExperimentId, slaDlpExperimentId, doeId, slaDlpDoeId, reportId };
}

function printHelp() {
  console.log(`Seeds the complete reusable demonstration workspace.

Usage:
  node dist/tools/seed_demo_workspace.js --upsert

It creates or updates only marked demo experiments, the attached demo DOE and
the editable unsigned demo report. It does not delete ordinary user data.`);
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return printHelp();
  if (!process.argv.includes("--upsert")) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  try {
    const seed = seedDemoWorkspace(db);
    console.log(`Demo workspace is ready: extrusion /experiments/${seed.extrusionExperimentId}, extrusion DOE /experiments/${seed.extrusionExperimentId}/doe/${seed.doeId}, SLA/DLP /experiments/${seed.slaDlpExperimentId}/qualification/1, SLA/DLP DOE /experiments/${seed.slaDlpExperimentId}/doe/${seed.slaDlpDoeId}, report /reports/${seed.reportId}.`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
