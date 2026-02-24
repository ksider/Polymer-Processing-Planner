import type { Db } from "../db.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { getProcessById } from "../repos/processes_repo.js";
import {
  ensureQualSteps,
  listQualSteps,
  getQualStep,
  listQualRuns,
  createQualRuns,
  listQualFields,
  insertQualField,
  updateQualField,
  listQualRunValues,
  upsertQualRunValue,
  upsertQualSummary,
  getQualStepSettings,
  upsertQualStepSettings
} from "../repos/qual_repo.js";
import type { QualField } from "../repos/qual_repo.js";
import { listMachineParams } from "../repos/machine_params_repo.js";

type StepDefinition = {
  step_number: number;
  name: string;
  default_runs: number;
  fields: Array<{
    code: string;
    label: string;
    field_type: "number" | "text" | "tag" | "boolean";
    unit?: string | null;
    group_label?: string | null;
    required?: number;
    is_enabled?: number;
    is_derived?: number;
    allowed_values_json?: string | null;
    derived_formula_code?: string | null;
  }>;
};

const defectTags = JSON.stringify([
  "short_shot",
  "flash",
  "sticking",
  "warpage",
  "bubbles",
  "burn_marks",
  "sink_marks",
  "brittle",
  "poor_surface",
  "demold_damage"
]);

function parseCavityIndex(code: string) {
  const match = /^cavity(\d+)_weight_g$/.exec(code);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

const injectionStepDefinitions: StepDefinition[] = [
  {
    step_number: 1,
    name: "Rheology / Viscosity Curve",
    default_runs: 6,
    fields: [
      { code: "inj_speed", label: "Injection speed", field_type: "number", unit: "cm3/s", group_label: "Inputs", required: 1 },
      { code: "fill_time_s", label: "Fill time", field_type: "number", unit: "s", group_label: "Measurements", required: 1 },
      { code: "peak_inj_pressure_bar", label: "Press pressure", field_type: "number", unit: "bar", group_label: "Measurements", required: 1 },
      { code: "shear_rate_proxy", label: "Shear rate", field_type: "number", unit: "1/s", group_label: "Derived", is_derived: 1, derived_formula_code: "shear_rate_proxy" },
      { code: "rel_viscosity", label: "Relative viscosity", field_type: "number", unit: "rel", group_label: "Derived", is_derived: 1, derived_formula_code: "rel_viscosity" }
    ]
  },
  {
    step_number: 2,
    name: "Cavity Balance",
    default_runs: 4,
    fields: [
      { code: "cavity1_weight_g", label: "Cavity 1 weight", field_type: "number", unit: "g", group_label: "Measurements", required: 1 },
      { code: "cavity2_weight_g", label: "Cavity 2 weight", field_type: "number", unit: "g", group_label: "Measurements", required: 1 },
      { code: "cavity3_weight_g", label: "Cavity 3 weight", field_type: "number", unit: "g", group_label: "Measurements" },
      { code: "cavity4_weight_g", label: "Cavity 4 weight", field_type: "number", unit: "g", group_label: "Measurements" },
      { code: "cavity1_defect_tags", label: "Cavity 1 defects", field_type: "tag", unit: null, group_label: "Measurements", allowed_values_json: defectTags },
      { code: "cavity2_defect_tags", label: "Cavity 2 defects", field_type: "tag", unit: null, group_label: "Measurements", allowed_values_json: defectTags },
      { code: "cavity3_defect_tags", label: "Cavity 3 defects", field_type: "tag", unit: null, group_label: "Measurements", allowed_values_json: defectTags },
      { code: "cavity4_defect_tags", label: "Cavity 4 defects", field_type: "tag", unit: null, group_label: "Measurements", allowed_values_json: defectTags },
      { code: "cavity_weight_variation_pct", label: "Cavity weight variation", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "cavity_variation_pct" }
    ]
  },
  {
    step_number: 3,
    name: "Pressure Drop",
    default_runs: 6,
    fields: [
      { code: "machine_max_pressure_bar", label: "Machine max pressure", field_type: "number", unit: "bar", group_label: "Inputs" },
      { code: "pressure_air_shot_bar", label: "Air shot pressure", field_type: "number", unit: "bar", group_label: "Measurements" },
      { code: "pressure_sprue_bar", label: "Sprue pressure", field_type: "number", unit: "bar", group_label: "Measurements" },
      { code: "pressure_runner_bar", label: "Runner pressure", field_type: "number", unit: "bar", group_label: "Measurements" },
      { code: "pressure_part_10_bar", label: "Part 10% pressure", field_type: "number", unit: "bar", group_label: "Measurements" },
      { code: "pressure_part_50_bar", label: "Part 50% pressure", field_type: "number", unit: "bar", group_label: "Measurements" },
      { code: "pressure_part_95_bar", label: "Part 95% pressure", field_type: "number", unit: "bar", group_label: "Measurements" },
      { code: "pressure_drop_profile", label: "Pressure drop profile", field_type: "text", unit: null, group_label: "Derived", is_derived: 1, derived_formula_code: "pressure_drop_profile" },
      { code: "max_pressure_pct", label: "Max pressure % of machine", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "max_pressure_pct" }
    ]
  },
  {
    step_number: 4,
    name: "Cosmetic Process Window",
    default_runs: 9,
    fields: [
      { code: "melt_temp_c", label: "Temperature", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "hold_pressure_bar", label: "Hold pressure", field_type: "number", unit: "bar", group_label: "Inputs", required: 1 },
      { code: "defect_short_shot", label: "Short shot", field_type: "boolean", unit: null, group_label: "Measurements" },
      { code: "defect_flash", label: "Flash", field_type: "boolean", unit: null, group_label: "Measurements" }
    ]
  },
  {
    step_number: 5,
    name: "Gate Seal Study",
    default_runs: 6,
    fields: [
      { code: "hold_time_s", label: "Hold time", field_type: "number", unit: "s", group_label: "Inputs", required: 1 },
      { code: "part_weight_g", label: "Part weight", field_type: "number", unit: "g", group_label: "Measurements", required: 1 }
    ]
  },
  {
    step_number: 6,
    name: "Cooling Time Optimization",
    default_runs: 6,
    fields: [
      { code: "cooling_time_s", label: "Cooling time", field_type: "number", unit: "s", group_label: "Inputs", required: 1 },
      { code: "cosmetic_ok", label: "Cosmetic OK", field_type: "boolean", unit: null, group_label: "Measurements" },
      { code: "critical_dim_mm", label: "Critical dimension", field_type: "number", unit: "mm", group_label: "Measurements" }
    ]
  }
];

export function getQualificationSteps() {
  return injectionStepDefinitions.map(({ step_number, name }) => ({ step_number, name }));
}

const compoundingDefectTags = JSON.stringify([
  "surging",
  "die_drool",
  "strand_break",
  "agglomerates",
  "foaming",
  "odor"
]);

const compoundingStepDefinitions: StepDefinition[] = [
  {
    step_number: 1,
    name: "RTD / Residence Time Stability",
    default_runs: 6,
    fields: [
      { code: "tracer_peak_time_s", label: "Tracer peak time", field_type: "number", unit: "s", group_label: "Measurements", required: 1 },
      { code: "tracer_tail_time_s", label: "Tracer tail time", field_type: "number", unit: "s", group_label: "Measurements", required: 1 },
      { code: "torque_stability_pct", label: "Torque stability", field_type: "number", unit: "%", group_label: "Measurements" },
      { code: "pressure_stability_pct", label: "Pressure stability", field_type: "number", unit: "%", group_label: "Measurements" },
      { code: "MFR_g_10min", label: "MFR", field_type: "number", unit: "g/10min", group_label: "Measurements" },
      { code: "stabilization_time_min", label: "Stabilization time", field_type: "number", unit: "min", group_label: "Summary" }
    ]
  },
  {
    step_number: 2,
    name: "SME Map / Energy Window",
    default_runs: 6,
    fields: [
      { code: "screw_rpm", label: "Screw RPM", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "throughput_kg_h", label: "Throughput", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "torque_pct", label: "Torque", field_type: "number", unit: "%", group_label: "Measurements", required: 1 },
      { code: "melt_temp_c", label: "Melt temp", field_type: "number", unit: "°C", group_label: "Measurements" },
      { code: "die_pressure_bar", label: "Die pressure", field_type: "number", unit: "bar", group_label: "Measurements" },
      { code: "SME_kJ_kg", label: "SME", field_type: "number", unit: "kJ/kg", group_label: "Derived" }
    ]
  },
  {
    step_number: 3,
    name: "Melt Temperature / Thermal History Map",
    default_runs: 6,
    fields: [
      { code: "mid_temp_c", label: "Mid barrel temp", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "head_temp_c", label: "Head temp", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "screw_rpm", label: "Screw RPM", field_type: "number", unit: "rpm", group_label: "Inputs" },
      { code: "throughput_kg_h", label: "Throughput", field_type: "number", unit: "kg/h", group_label: "Inputs" },
      { code: "melt_temp_c", label: "Melt temp", field_type: "number", unit: "°C", group_label: "Measurements", required: 1 },
      { code: "die_pressure_bar", label: "Die pressure", field_type: "number", unit: "bar", group_label: "Measurements" }
    ]
  },
  {
    step_number: 4,
    name: "Feeding / Side-Feeder Qualification",
    default_runs: 6,
    fields: [
      { code: "feed_ratio_filler_pct", label: "Feed ratio filler", field_type: "number", unit: "%", group_label: "Inputs", required: 1 },
      { code: "side_feeder_rpm", label: "Side feeder RPM", field_type: "number", unit: "rpm", group_label: "Inputs" },
      { code: "filler_pct_measured", label: "Measured filler fraction", field_type: "number", unit: "%", group_label: "Measurements" },
      { code: "filler_variation_pct", label: "Filler variation", field_type: "number", unit: "%", group_label: "Measurements" },
      { code: "agglomerates_count", label: "Agglomerates count", field_type: "number", unit: null, group_label: "Measurements" }
    ]
  },
  {
    step_number: 5,
    name: "Degassing / Moisture Control",
    default_runs: 6,
    fields: [
      { code: "vacuum_mbar", label: "Vacuum level", field_type: "number", unit: "mbar", group_label: "Inputs", required: 1 },
      { code: "throughput_kg_h", label: "Throughput", field_type: "number", unit: "kg/h", group_label: "Inputs" },
      { code: "moisture_target_pct", label: "Moisture target", field_type: "number", unit: "%", group_label: "Inputs" },
      { code: "pellet_moisture_pct", label: "Pellet moisture", field_type: "number", unit: "%", group_label: "Measurements", required: 1 },
      { code: "porosity_score", label: "Porosity score", field_type: "number", unit: "1-5", group_label: "Measurements" },
      { code: "volatiles_odor_score", label: "Odor / volatiles score", field_type: "number", unit: "1-5", group_label: "Measurements" }
    ]
  },
  {
    step_number: 6,
    name: "Dispersion / Mixing Quality Check",
    default_runs: 4,
    fields: [
      { code: "dispersion_ok", label: "Dispersion OK", field_type: "boolean", unit: null, group_label: "Measurements" },
      { code: "strand_stability_score", label: "Strand stability", field_type: "number", unit: "1-5", group_label: "Measurements" },
      { code: "defect_tags", label: "Defects", field_type: "tag", unit: null, group_label: "Measurements", allowed_values_json: compoundingDefectTags },
      { code: "MFR_g_10min", label: "MFR", field_type: "number", unit: "g/10min", group_label: "Measurements" },
      { code: "bulk_density_g_cm3", label: "Bulk density", field_type: "number", unit: "g/cm3", group_label: "Measurements" }
    ]
  }
];

const coatingDefectTags = JSON.stringify([
  "streaks",
  "pinholes",
  "orange_peel",
  "cracking",
  "blocking",
  "delamination"
]);

const surfaceTreatmentTags = JSON.stringify(["none", "corona", "plasma"]);

const coatingStepDefinitions: StepDefinition[] = [
  {
    step_number: 1,
    name: "Rheology Window",
    default_runs: 6,
    fields: [
      { code: "solids_pct", label: "Solids", field_type: "number", unit: "%", group_label: "Inputs", required: 1 },
      { code: "coating_temp_c", label: "Coating temp", field_type: "number", unit: "°C", group_label: "Inputs" },
      { code: "additive_pct", label: "Additive", field_type: "number", unit: "%", group_label: "Inputs" },
      { code: "viscosity_1s", label: "Viscosity @1 s⁻¹", field_type: "number", unit: "mPa·s", group_label: "Measurements", required: 1 },
      { code: "viscosity_10s", label: "Viscosity @10 s⁻¹", field_type: "number", unit: "mPa·s", group_label: "Measurements", required: 1 },
      { code: "viscosity_100s", label: "Viscosity @100 s⁻¹", field_type: "number", unit: "mPa·s", group_label: "Measurements", required: 1 }
    ]
  },
  {
    step_number: 2,
    name: "Wetting / Surface Energy Check",
    default_runs: 4,
    fields: [
      { code: "water_contact_angle_deg", label: "Contact angle", field_type: "number", unit: "°", group_label: "Measurements", required: 1 },
      { code: "surface_energy_dyn_cm", label: "Surface energy", field_type: "number", unit: "dyn/cm", group_label: "Measurements" },
      { code: "substrate_surface_treatment", label: "Surface treatment", field_type: "tag", unit: null, group_label: "Inputs", allowed_values_json: surfaceTreatmentTags },
      { code: "needs_primer", label: "Needs primer", field_type: "boolean", unit: null, group_label: "Summary" }
    ]
  },
  {
    step_number: 3,
    name: "Coat Weight Calibration",
    default_runs: 6,
    fields: [
      { code: "coating_speed_m_min", label: "Coating speed", field_type: "number", unit: "m/min", group_label: "Inputs", required: 1 },
      { code: "wet_film_thickness_um", label: "Wet film thickness", field_type: "number", unit: "µm", group_label: "Inputs" },
      { code: "flow_rate_ml_min", label: "Flow rate", field_type: "number", unit: "ml/min", group_label: "Inputs" },
      { code: "coat_weight_g_m2", label: "Coat weight", field_type: "number", unit: "g/m²", group_label: "Measurements", required: 1 },
      { code: "dry_thickness_um", label: "Dry thickness", field_type: "number", unit: "µm", group_label: "Measurements", required: 1 }
    ]
  },
  {
    step_number: 4,
    name: "Drying / Curing Window",
    default_runs: 6,
    fields: [
      { code: "drying_temp_C", label: "Drying temp", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "air_flow_m_s", label: "Air flow", field_type: "number", unit: "m/s", group_label: "Inputs" },
      { code: "drying_time_s", label: "Drying time", field_type: "number", unit: "s", group_label: "Inputs", required: 1 },
      { code: "residual_moisture_pct", label: "Residual moisture/solvent", field_type: "number", unit: "%", group_label: "Measurements" },
      { code: "tack_free_time_s", label: "Tack-free time", field_type: "number", unit: "s", group_label: "Measurements" },
      { code: "defect_tags", label: "Defects", field_type: "tag", unit: null, group_label: "Measurements", allowed_values_json: coatingDefectTags }
    ]
  },
  {
    step_number: 5,
    name: "Adhesion Qualification",
    default_runs: 4,
    fields: [
      { code: "adhesion_pass", label: "Adhesion pass", field_type: "boolean", unit: null, group_label: "Measurements" },
      { code: "adhesion_score", label: "Adhesion score", field_type: "number", unit: "N/25mm", group_label: "Measurements" }
    ]
  },
  {
    step_number: 6,
    name: "Barrier / Functional Check",
    default_runs: 4,
    fields: [
      { code: "WVTR_g_m2_day", label: "WVTR", field_type: "number", unit: "g/m²/day", group_label: "Measurements" },
      { code: "OTR_cc_m2_day", label: "OTR", field_type: "number", unit: "cc/m²/day", group_label: "Measurements" },
      { code: "barrier_pass", label: "Barrier pass", field_type: "boolean", unit: null, group_label: "Summary" }
    ]
  }
];

function getProcessTypeCodeForExperiment(db: Db, experimentId: number): string {
  const experiment = getExperiment(db, experimentId);
  if (!experiment || !experiment.process_id) return "injection";
  const process = getProcessById(db, experiment.process_id);
  return String(process?.process_type_code || "injection").toLowerCase();
}

function getStepDefinitionsForProcessType(processTypeCode: string): StepDefinition[] {
  if (processTypeCode === "compounding") return compoundingStepDefinitions;
  if (processTypeCode === "coating") return coatingStepDefinitions;
  return injectionStepDefinitions;
}

export function getQualificationStepsForExperiment(db: Db, experimentId: number) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  return getStepDefinitionsForProcessType(processTypeCode).map(({ step_number, name }) => ({ step_number, name }));
}

export function getStepDefinitionForExperiment(db: Db, experimentId: number, stepNumber: number) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  return getStepDefinitionsForProcessType(processTypeCode).find((step) => step.step_number === stepNumber) ?? null;
}

export function getQualificationStepName(db: Db, experimentId: number, stepNumber: number): string {
  return getStepDefinitionForExperiment(db, experimentId, stepNumber)?.name ?? `Step ${stepNumber}`;
}

export function ensureQualificationDefaults(db: Db, experimentId: number) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  const stepDefinitions = getStepDefinitionsForProcessType(processTypeCode);
  ensureQualSteps(db, experimentId);
  const steps = listQualSteps(db, experimentId);
  for (const step of steps) {
    const def = stepDefinitions.find((d) => d.step_number === step.step_number);
    if (!def) continue;
    const fields = listQualFields(db, step.id);
    const fieldCodes = new Set(fields.map((field) => field.code));
    const hasCavityWeights =
      step.step_number === 2 &&
      fields.some((field) => /^cavity\d+_weight_g$/.test(field.code));
    for (const field of def.fields) {
      if (
        hasCavityWeights &&
        /^cavity\d+_(weight_g|defect_tags)$/.test(field.code)
      ) {
        continue;
      }
      if (fieldCodes.has(field.code)) continue;
      insertQualField(db, {
        experiment_id: experimentId,
        step_id: step.id,
        code: field.code,
        label: field.label,
        field_type: field.field_type,
        unit: field.unit ?? null,
        group_label: field.group_label ?? null,
        required: field.required ?? 0,
        is_enabled: field.is_enabled ?? 1,
        is_derived: field.is_derived ?? 0,
        allowed_values_json: field.allowed_values_json ?? null,
        derived_formula_code: field.derived_formula_code ?? null
      });
    }
    if (processTypeCode === "injection" && step.step_number === 1) {
      const existingSettings = getQualStepSettings(db, experimentId, step.step_number);
      if (!existingSettings) {
        upsertQualStepSettings(
          db,
          experimentId,
          step.step_number,
          JSON.stringify({
            intensification_coeff: 1,
            melt_temp_c: null,
            custom_fields: [],
            recommended_inj_speed: null
          })
        );
      }
    }
    if (processTypeCode === "injection" && step.step_number === 2) {
      const existingSettings = getQualStepSettings(db, experimentId, step.step_number);
      if (!existingSettings) {
        upsertQualStepSettings(
          db,
          experimentId,
          step.step_number,
          JSON.stringify({
            inj_speed: null,
            target_weight_g: null
          })
        );
      }
    }
    if (processTypeCode === "injection" && step.step_number === 3) {
      const existingSettings = getQualStepSettings(db, experimentId, step.step_number);
      if (!existingSettings) {
        upsertQualStepSettings(
          db,
          experimentId,
          step.step_number,
          JSON.stringify({
            inj_speed: null,
            machine_max_pressure_bar: null,
            intensification_coeff: 1
          })
        );
      }
    }
    if (processTypeCode === "injection" && step.step_number === 4) {
      const existingSettings = getQualStepSettings(db, experimentId, step.step_number);
      if (!existingSettings) {
        upsertQualStepSettings(
          db,
          experimentId,
          step.step_number,
          JSON.stringify({
            inj_speed: null
          })
        );
      }
    }
    if (processTypeCode === "injection" && step.step_number === 5) {
      const existingSettings = getQualStepSettings(db, experimentId, step.step_number);
      if (!existingSettings) {
        upsertQualStepSettings(
          db,
          experimentId,
          step.step_number,
          JSON.stringify({
            inj_speed: null,
            melt_temp_c: null,
            hold_pressure_bar: null
          })
        );
      }
    }
    if (processTypeCode === "injection" && step.step_number === 6) {
      const existingSettings = getQualStepSettings(db, experimentId, step.step_number);
      if (!existingSettings) {
        upsertQualStepSettings(
          db,
          experimentId,
          step.step_number,
          JSON.stringify({
            inj_speed: null,
            melt_temp_c: null,
            hold_pressure_bar: null,
            gate_seal_time_s: null
          })
        );
      }
    }
    if (processTypeCode === "injection" && step.step_number === 6) {
      const warpageField = fields.find((field) => field.code === "warpage_mm");
      if (warpageField && warpageField.is_enabled !== 0) {
        updateQualField(db, warpageField.id, { is_enabled: 0 });
      }
    }
    const runs = listQualRuns(db, step.id);
    if (runs.length === 0) {
      createQualRuns(db, experimentId, step.id, def.default_runs);
    }
  }
}

export function listStepFields(db: Db, stepId: number) {
  return listQualFields(db, stepId);
}

export function updateField(db: Db, fieldId: number, updates: Partial<{ [key: string]: unknown }>) {
  updateQualField(db, fieldId, updates as never);
}

export function addCavityFields(
  db: Db,
  experimentId: number,
  stepId: number,
  index: number
) {
  const weightCode = `cavity${index}_weight_g`;
  const defectCode = `cavity${index}_defect_tags`;
  const existing = listQualFields(db, stepId);
  const existingCodes = new Set(existing.map((field) => field.code));
  const existingWeight = existing.find((field) => field.code === weightCode);
  const existingDefect = existing.find((field) => field.code === defectCode);
  const customSuffixes = new Map<string, { label: string; unit: string | null; field_type: QualField["field_type"] }>();
  existing.forEach((field) => {
    const match = /^cavity\d+_(.+)$/.exec(field.code);
    if (!match) return;
    const suffix = match[1];
    if (suffix === "weight_g" || suffix === "defect_tags") return;
    if (customSuffixes.has(suffix)) return;
    const baseLabel = field.label.replace(/^Cavity\s+\d+\s+/i, "");
    customSuffixes.set(suffix, {
      label: baseLabel || field.label,
      unit: field.unit,
      field_type: field.field_type
    });
  });
  let weightId: number | null = existingWeight?.id ?? null;
  let defectId: number | null = existingDefect?.id ?? null;
  if (!existingCodes.has(weightCode)) {
    weightId = insertQualField(db, {
      experiment_id: experimentId,
      step_id: stepId,
      code: weightCode,
      label: `Cavity ${index} weight`,
      field_type: "number",
      unit: "g",
      group_label: "Measurements",
      required: index <= 2 ? 1 : 0,
      is_enabled: 1,
      is_derived: 0,
      allowed_values_json: null,
      derived_formula_code: null
    });
  }
  if (!existingCodes.has(defectCode)) {
    defectId = insertQualField(db, {
      experiment_id: experimentId,
      step_id: stepId,
      code: defectCode,
      label: `Cavity ${index} defects`,
      field_type: "tag",
      unit: null,
      group_label: "Measurements",
      required: 0,
      is_enabled: 1,
      is_derived: 0,
      allowed_values_json: defectTags,
      derived_formula_code: null
    });
  }
  const customFields: Array<{ suffix: string; id: number }> = [];
  customSuffixes.forEach((def, suffix) => {
    const fieldCode = `cavity${index}_${suffix}`;
    if (existingCodes.has(fieldCode)) return;
    const id = insertQualField(db, {
      experiment_id: experimentId,
      step_id: stepId,
      code: fieldCode,
      label: `Cavity ${index} ${def.label}`,
      field_type: def.field_type,
      unit: def.unit,
      group_label: "Measurements",
      required: 0,
      is_enabled: 1,
      is_derived: 0,
      allowed_values_json: null,
      derived_formula_code: null
    });
    customFields.push({ suffix, id });
  });
  return { weightId, defectId, customFields };
}

export function getNextCavityIndex(fields: QualField[]) {
  const indices = fields
    .map((field) => parseCavityIndex(field.code))
    .filter((val): val is number => Number.isFinite(val));
  if (!indices.length) return 1;
  return Math.max(...indices) + 1;
}

export function saveQualRunValue(
  db: Db,
  runId: number,
  fieldId: number,
  fieldType: "number" | "text" | "tag" | "boolean",
  rawValue: unknown
) {
  const value = normalizeValue(fieldType, rawValue);
  upsertQualRunValue(db, {
    run_id: runId,
    field_id: fieldId,
    value_real: value.value_real,
    value_text: value.value_text,
    value_tags_json: value.value_tags_json
  });
}

function normalizeValue(fieldType: "number" | "text" | "tag" | "boolean", raw: unknown) {
  if (fieldType === "number") {
    const num = parseNumber(raw);
    return {
      value_real: Number.isFinite(num) ? num : null,
      value_text: null,
      value_tags_json: null
    };
  }
  if (fieldType === "boolean") {
    const bool = raw === true || raw === "1" || raw === 1 || raw === "true";
    return { value_real: bool ? 1 : 0, value_text: null, value_tags_json: null };
  }
  if (fieldType === "tag") {
    const tags = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
    return { value_real: null, value_text: null, value_tags_json: JSON.stringify(tags) };
  }
  return { value_real: null, value_text: raw ? String(raw) : "", value_tags_json: null };
}

function parseNumber(raw: unknown) {
  if (raw == null) return NaN;
  const text = String(raw).trim();
  if (!text) return NaN;
  const normalized = text.includes(",") && !text.includes(".") ? text.replace(",", ".") : text;
  return parseFloat(normalized);
}

export function recomputeDerivedAndSummary(
  db: Db,
  experimentId: number,
  stepId: number,
  stepNumber: number
) {
  const machineParamMap = (() => {
    const row = db
      .prepare("SELECT machine_id FROM experiments WHERE id = ?")
      .get(experimentId) as { machine_id?: number | null } | undefined;
    if (!row?.machine_id) return new Map<string, string>();
    const params = listMachineParams(db, row.machine_id);
    return new Map(
      params.map((param) => [`${row.machine_id}:${param.id}`, param.value_text ?? ""])
    );
  })();
  const resolveSettingNumber = (raw: unknown) => {
    if (raw == null) return NaN;
    const text = String(raw).trim();
    if (!text) return NaN;
    // Allow settings to be stored as %machineId:paramId% tokens.
    const resolved = text.replace(/%(\d+:\d+)%/g, (match, token) => {
      if (machineParamMap.has(token)) {
        return String(machineParamMap.get(token) ?? "");
      }
      return match;
    });
    if (/%\d+:\d+%/.test(resolved)) return NaN;
    return parseNumber(resolved);
  };
  const fields = listQualFields(db, stepId);
  const runs = listQualRuns(db, stepId);
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const fieldByCode = new Map(fields.map((field) => [field.code, field]));
  const settings = getQualStepSettings(db, experimentId, stepNumber);
  let intensificationCoeff = 1;
  if (settings) {
    try {
      const parsed = JSON.parse(settings);
      const resolved = resolveSettingNumber(parsed?.intensification_coeff);
      if (Number.isFinite(resolved)) {
        intensificationCoeff = resolved;
      }
    } catch {
      intensificationCoeff = 1;
    }
  }

  for (const run of runs) {
    const values = listQualRunValues(db, run.id);
    const valueMap = new Map(values.map((value) => [value.field_id, value]));
    const getNumber = (code: string) => {
      const field = fieldByCode.get(code);
      if (!field) return null;
      const value = valueMap.get(field.id);
      return value?.value_real ?? null;
    };
    const setDerived = (code: string, value: number | string | null) => {
      const field = fieldByCode.get(code);
      if (!field || !field.is_derived) return;
      if (field.field_type === "number") {
        upsertQualRunValue(db, {
          run_id: run.id,
          field_id: field.id,
          value_real: Number.isFinite(value as number) ? (value as number) : null,
          value_text: null,
          value_tags_json: null
        });
      } else {
        upsertQualRunValue(db, {
          run_id: run.id,
          field_id: field.id,
          value_real: null,
          value_text: value ? String(value) : "",
          value_tags_json: null
        });
      }
    };

    if (stepNumber === 1) {
      const fill = getNumber("fill_time_s");
      const peak = getNumber("peak_inj_pressure_bar");
      const shearRate = fill != null && fill !== 0 ? 1 / fill : null;
      if (shearRate != null) {
        setDerived("shear_rate_proxy", shearRate);
      }
      if (peak != null) {
        if (shearRate != null && fill != null) {
          setDerived("rel_viscosity", peak * fill * intensificationCoeff);
        }
      }
    }
    if (stepNumber === 2) {
      const cavityWeightFields = fields
        .filter((field) => parseCavityIndex(field.code) != null)
        .sort((a, b) => (parseCavityIndex(a.code) || 0) - (parseCavityIndex(b.code) || 0));
      const weights = cavityWeightFields
        .map((field) => {
          const value = valueMap.get(field.id);
          return value?.value_real ?? null;
        })
        .filter((val): val is number => Number.isFinite(val));
      let targetWeight: number | null = null;
      const settingsRaw = getQualStepSettings(db, experimentId, stepNumber);
      if (settingsRaw) {
        try {
          const parsed = JSON.parse(settingsRaw);
          const resolved = resolveSettingNumber(parsed?.target_weight_g);
          if (Number.isFinite(resolved)) targetWeight = resolved;
        } catch {
          targetWeight = null;
        }
      }
      if (weights.length >= 1) {
        const avg = weights.reduce((a, b) => a + b, 0) / weights.length;
        const ref = targetWeight && weights.length < 3 ? targetWeight : avg;
        const variation = ref
          ? Math.max(...weights.map((w) => Math.abs((ref - w) / ref) * 100))
          : null;
        setDerived("cavity_weight_variation_pct", variation);
      }
    }
    if (stepNumber === 3) {
      let intensificationCoeffLocal = intensificationCoeff;
      let machineMaxOverride: number | null = null;
      const settingsRaw = getQualStepSettings(db, experimentId, stepNumber);
      if (settingsRaw) {
        try {
          const parsed = JSON.parse(settingsRaw);
          const resolvedCoeff = resolveSettingNumber(parsed?.intensification_coeff);
          if (Number.isFinite(resolvedCoeff)) {
            intensificationCoeffLocal = resolvedCoeff;
          }
          const resolvedMax = resolveSettingNumber(parsed?.machine_max_pressure_bar);
          if (Number.isFinite(resolvedMax)) {
            machineMaxOverride = resolvedMax;
          }
        } catch {
          intensificationCoeffLocal = intensificationCoeff;
          machineMaxOverride = null;
        }
      }
      const pressureRaw = [
        getNumber("pressure_air_shot_bar"),
        getNumber("pressure_sprue_bar"),
        getNumber("pressure_runner_bar"),
        getNumber("pressure_part_10_bar"),
        getNumber("pressure_part_50_bar"),
        getNumber("pressure_part_95_bar")
      ];
      const pressures = pressureRaw
        .filter((val): val is number => Number.isFinite(val))
        .map((val) => val * intensificationCoeffLocal);
      const maxPressure = pressures.length ? Math.max(...pressures) : null;
      const machineMax = machineMaxOverride ?? getNumber("machine_max_pressure_bar");
      if (maxPressure != null && machineMax != null && machineMax !== 0) {
        setDerived("max_pressure_pct", (maxPressure / machineMax) * 100);
      }
      if (pressureRaw.length) {
        const labels = [
          "air_shot",
          "sprue",
          "runner",
          "part_10",
          "part_50",
          "part_95"
        ];
        const profile = labels
          .map((label, idx) => {
            const value = pressureRaw[idx];
            const peak = Number.isFinite(value as number)
              ? (value as number) * intensificationCoeffLocal
              : null;
            return `${label}: ${peak ?? "-"}`;
          })
          .join(", ");
        setDerived("pressure_drop_profile", profile);
      }
    }
  }

  const summary = buildStepSummary(db, experimentId, stepId, stepNumber, fieldByCode);
  if (stepNumber === 1 && settings) {
    try {
      const parsed = JSON.parse(settings);
      const resolved = resolveSettingNumber(parsed?.recommended_inj_speed);
      if (Number.isFinite(resolved)) {
        summary.recommended_inj_speed = resolved;
      }
    } catch {
      // ignore
    }
  }
  upsertQualSummary(db, experimentId, stepNumber, JSON.stringify(summary));
}

function buildStepSummary(
  db: Db,
  experimentId: number,
  stepId: number,
  stepNumber: number,
  fieldByCode: Map<string, { id: number }>
) {
  const runs = listQualRuns(db, stepId);
  const summaries: Record<string, unknown> = {
    experiment_id: experimentId,
    step_number: stepNumber
  };

  const runValues = runs.map((run) => ({
    run,
    values: new Map(
      listQualRunValues(db, run.id).map((value) => [value.field_id, value])
    )
  }));

  const numberFor = (values: Map<number, { value_real: number | null }>, code: string) => {
    const field = fieldByCode.get(code);
    if (!field) return null;
    return values.get(field.id)?.value_real ?? null;
  };
  const boolFor = (values: Map<number, { value_real: number | null }>, code: string) => {
    const value = numberFor(values, code);
    return value === 1;
  };

  if (stepNumber === 1) {
    let best: { inj: number; viscosity: number } | null = null;
    for (const row of runValues) {
      const inj = numberFor(row.values, "inj_speed");
      const visc = numberFor(row.values, "rel_viscosity");
      if (inj == null || visc == null) continue;
      if (!best || visc < best.viscosity) best = { inj, viscosity: visc };
    }
    summaries.recommended_inj_speed = best?.inj ?? null;
  }
  if (stepNumber === 2) {
    let maxVar: number | null = null;
    for (const row of runValues) {
      const v = numberFor(row.values, "cavity_weight_variation_pct");
      if (v == null) continue;
      if (maxVar == null || v > maxVar) maxVar = v;
    }
    summaries.max_cavity_imbalance_pct = maxVar;
  }
  if (stepNumber === 3) {
    let maxPct: number | null = null;
    for (const row of runValues) {
      const v = numberFor(row.values, "max_pressure_pct");
      if (v == null) continue;
      if (maxPct == null || v > maxPct) maxPct = v;
    }
    summaries.max_pressure_pct = maxPct;
    summaries.pressure_margin_ok = maxPct != null ? maxPct <= 90 : null;
  }
  if (stepNumber === 4) {
    const goodPoints = runValues
      .map((row) => ({
        temp: numberFor(row.values, "melt_temp_c"),
        hold: numberFor(row.values, "hold_pressure_bar"),
        shortShot: boolFor(row.values, "defect_short_shot"),
        flash: boolFor(row.values, "defect_flash")
      }))
      .filter(
        (row) =>
          row.temp != null &&
          row.hold != null &&
          !row.shortShot &&
          !row.flash
      ) as Array<{ temp: number; hold: number }>;

    if (goodPoints.length >= 2) {
      const temps = goodPoints.map((p) => p.temp);
      const lowTemp = Math.min(...temps);
      const highTemp = Math.max(...temps);
      const lowPoints = goodPoints.filter((p) => p.temp === lowTemp);
      const highPoints = goodPoints.filter((p) => p.temp === highTemp);
      if (lowPoints.length && highPoints.length) {
        const lowPressures = lowPoints.map((p) => p.hold);
        const highPressures = highPoints.map((p) => p.hold);
        const lowMin = Math.min(...lowPressures);
        const lowMax = Math.max(...lowPressures);
        const highMin = Math.min(...highPressures);
        const highMax = Math.max(...highPressures);
        summaries.window_low_temp = lowTemp;
        summaries.window_high_temp = highTemp;
        summaries.window_low_pressure_min = lowMin;
        summaries.window_low_pressure_max = lowMax;
        summaries.window_high_pressure_min = highMin;
        summaries.window_high_pressure_max = highMax;
        summaries.window_center_temp = (lowTemp + highTemp) / 2;
        summaries.window_center_pressure =
          ((lowMin + lowMax) / 2 + (highMin + highMax) / 2) / 2;
      }
    }
  }
  if (stepNumber === 5) {
    const points = runValues
      .map((row) => ({
        hold: numberFor(row.values, "hold_time_s"),
        weight: numberFor(row.values, "part_weight_g")
      }))
      .filter((row) => row.hold != null && row.weight != null) as Array<{
      hold: number;
      weight: number;
    }>;
    points.sort((a, b) => a.hold - b.hold);
    let gateSeal: number | null = null;
    const plateauTolerance = 0.05;
    const maxWeight = points.length ? Math.max(...points.map((p) => p.weight)) : null;
    if (maxWeight != null && maxWeight > 0) {
      const lowerBound = maxWeight * (1 - plateauTolerance);
      for (let i = 0; i < points.length; i += 1) {
        const tail = points.slice(i);
        const allWithin = tail.every(
          (p) => p.weight >= lowerBound && p.weight <= maxWeight * (1 + plateauTolerance)
        );
        if (allWithin) {
          gateSeal = points[i].hold;
          break;
        }
      }
    }
    summaries.gate_seal_time_s = gateSeal;
  }
  if (stepNumber === 6) {
    const points = runValues
      .map((row) => ({
        cooling: numberFor(row.values, "cooling_time_s"),
        ok: boolFor(row.values, "cosmetic_ok")
      }))
      .filter((row) => row.cooling != null) as Array<{ cooling: number; ok: boolean }>;
    const okPoints = points.filter((row) => row.ok);
    if (okPoints.length) {
      summaries.min_cooling_time_s = Math.min(...okPoints.map((row) => row.cooling));
    }
  }

  return summaries;
}

export function getStepDefinition(stepNumber: number) {
  return injectionStepDefinitions.find((step) => step.step_number === stepNumber) ?? null;
}
