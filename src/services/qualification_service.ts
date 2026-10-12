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
  getQualRunSeries,
  upsertQualRunValue,
  upsertQualSummary,
  getQualStepSettings,
  upsertQualStepSettings,
  listQualStepOutputs,
  setQualStepActive
} from "../repos/qual_repo.js";
import type { QualField } from "../repos/qual_repo.js";
import { listMachineParams } from "../repos/machine_params_repo.js";
import { findGlobalParamByCode, upsertCanonicalParamDefinition } from "../repos/params_repo.js";

type StepDefinition = {
  step_number: number;
  name: string;
  default_runs: number;
  is_optional?: boolean;
  activation_description?: string;
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

export type QualificationSeriesDefinition = {
  code: string;
  label: string;
  description: string;
  contract_version: number;
  x: { code: string; label: string; unit: string };
  y: { code: string; label: string; unit: string };
  minimum_points: number;
};

const extrusionStep1SeriesDefinitions: QualificationSeriesDefinition[] = [
  {
    code: "dsc_thermogram",
    label: "DSC thermogram",
    description: "Temperature-programmed DSC heat-flow series.",
    contract_version: 1,
    x: { code: "temperature_c", label: "Temperature", unit: "°C" },
    y: { code: "heat_flow_w_g", label: "Heat flow", unit: "W/g" },
    minimum_points: 2
  },
  {
    code: "tga_thermogram",
    label: "TGA thermogram",
    description: "Temperature-programmed remaining-mass series.",
    contract_version: 1,
    x: { code: "temperature_c", label: "Temperature", unit: "°C" },
    y: { code: "remaining_mass_pct", label: "Remaining mass", unit: "%" },
    minimum_points: 2
  }
];

const extrusionStep5SeriesDefinitions: QualificationSeriesDefinition[] = [
  {
    code: "tracer_concentration_response",
    label: "Tracer concentration response",
    description: "Manual time-series response of a known tracer pulse measured at the extruder outlet.",
    contract_version: 1,
    x: { code: "time_s", label: "Time after tracer pulse", unit: "s" },
    y: { code: "tracer_concentration", label: "Tracer concentration", unit: "relative" },
    minimum_points: 5
  }
];

export type QualificationOutputDefinition = {
  group: string;
  code: string;
  label: string;
  unit: string | null;
  field_type: "number" | "text";
  description: string;
};

export const extrusionStep1OutputDefinitions: QualificationOutputDefinition[] = [
  { group: "rheology", code: "rheology_reference_viscosity_pa_s", label: "Reference viscosity", unit: "Pa·s", field_type: "number", description: "Manual baseline selected from the flow curve." },
  { group: "rheology", code: "flow_behavior_index_n", label: "Flow behavior index n", unit: null, field_type: "number", description: "Manual fit today; R fit will replace it later." },
  { group: "thermal_hold", code: "max_thermal_hold_min", label: "Maximum thermal hold", unit: "min", field_type: "number", description: "Longest hold without unacceptable viscosity change." },
  { group: "dsc", code: "processing_temp_min_c", label: "Minimum processing temperature", unit: "°C", field_type: "number", description: "Manual value derived from the DSC heating/cooling curve." },
  { group: "dsc", code: "dsc_melting_peak_c", label: "Melting peak", unit: "°C", field_type: "number", description: "Manual peak temperature from DSC." },
  { group: "tga", code: "processing_temp_max_c", label: "Maximum processing temperature", unit: "°C", field_type: "number", description: "Manual value below the onset of degradation." },
  { group: "tga", code: "tga_degradation_onset_c", label: "Degradation onset", unit: "°C", field_type: "number", description: "Manual onset temperature from TGA." }
];

const extrusionStep2OutputDefinitions: QualificationOutputDefinition[] = [
  { group: "feeder", code: "feeder_stable_throughput_min_kg_h", label: "Minimum stable throughput", unit: "kg/h", field_type: "number", description: "Lowest accepted feeder setpoint to pass to the process window." },
  { group: "feeder", code: "feeder_stable_throughput_max_kg_h", label: "Maximum stable throughput", unit: "kg/h", field_type: "number", description: "Highest accepted feeder setpoint to pass to the process window." }
];

const extrusionStep3OutputDefinitions: QualificationOutputDefinition[] = [
  { group: "operating_window", code: "operating_window_min_screw_rpm", label: "Minimum accepted screw speed", unit: "rpm", field_type: "number", description: "Lowest screw-speed level represented by accepted operating points." },
  { group: "operating_window", code: "operating_window_max_screw_rpm", label: "Maximum accepted screw speed", unit: "rpm", field_type: "number", description: "Highest screw-speed level represented by accepted operating points." },
  { group: "operating_window", code: "operating_window_max_throughput_kg_h", label: "Maximum accepted throughput", unit: "kg/h", field_type: "number", description: "Highest accepted throughput at the pressure and torque limits." }
];

const extrusionStep5OutputDefinitions: QualificationOutputDefinition[] = [
  { group: "rtd", code: "rtd_mean_residence_time_s", label: "Selected mean residence time", unit: "s", field_type: "number", description: "Representative mean residence time for downstream mixing and kinetics work." },
  { group: "rtd", code: "rtd_degree_of_fill_pct", label: "Selected degree of fill", unit: "%", field_type: "number", description: "Representative channel fill at the selected RTD operating point." },
  { group: "rtd", code: "rtd_width_s", label: "Selected RTD width (10–90%)", unit: "s", field_type: "number", description: "Representative axial-mixing and self-wiping indicator." }
];

const extrusionOptionalOutputDefinitions: Record<number, QualificationOutputDefinition[]> = {
  6: [
    { group: "side_feeding", code: "side_feeder_stable_speed_min_rpm", label: "Minimum stable side-feeder speed", unit: "rpm", field_type: "number", description: "Lowest side-feeder setting without accumulation or bridging." },
    { group: "side_feeding", code: "side_feeder_stable_speed_max_rpm", label: "Maximum stable side-feeder speed", unit: "rpm", field_type: "number", description: "Highest side-feeder setting without accumulation or bridging." },
    { group: "side_feeding", code: "filler_mass_fraction_max_pct", label: "Maximum accepted filler fraction", unit: "%", field_type: "number", description: "Highest stable filler mass fraction for downstream formulation work." }
  ],
  7: [
    { group: "liquid_dosing", code: "liquid_mass_fraction_min_pct", label: "Minimum stable liquid fraction", unit: "%", field_type: "number", description: "Lowest accepted liquid mass fraction." },
    { group: "liquid_dosing", code: "liquid_mass_fraction_max_pct", label: "Maximum stable liquid fraction", unit: "%", field_type: "number", description: "Highest accepted liquid fraction without backflow." },
    { group: "liquid_dosing", code: "injection_pressure_delta_min_bar", label: "Minimum injection pressure differential", unit: "bar", field_type: "number", description: "Minimum stable injection-pressure margin over barrel pressure." }
  ],
  8: [
    { group: "devolatilization", code: "residual_volatiles_min_pct", label: "Lowest residual volatiles", unit: "%", field_type: "number", description: "Lowest measured residual volatile content at stable vacuum." },
    { group: "devolatilization", code: "devolatilization_efficiency_max_pct", label: "Maximum devolatilization efficiency", unit: "%", field_type: "number", description: "Best stable removal efficiency for downstream quality limits." }
  ],
  9: [
    { group: "reaction", code: "conversion_max_pct", label: "Maximum stable conversion", unit: "%", field_type: "number", description: "Highest conversion at stable product properties." },
    { group: "reaction", code: "product_mfr_min_g_10min", label: "Minimum product MFR", unit: "g/10 min", field_type: "number", description: "Lower boundary of product melt-flow response in the accepted reaction range." },
    { group: "reaction", code: "product_mfr_max_g_10min", label: "Maximum product MFR", unit: "g/10 min", field_type: "number", description: "Upper boundary of product melt-flow response in the accepted reaction range." }
  ],
  10: [
    { group: "scale_up", code: "scaled_throughput_target_kg_h", label: "Scaled throughput target", unit: "kg/h", field_type: "number", description: "Volumetric D³ scale-up estimate before production verification." },
    { group: "scale_up", code: "production_screw_speed_min_rpm", label: "Minimum accepted production screw speed", unit: "rpm", field_type: "number", description: "Lower production screw-speed boundary with SME and melt-temperature parity." },
    { group: "scale_up", code: "production_screw_speed_max_rpm", label: "Maximum accepted production screw speed", unit: "rpm", field_type: "number", description: "Upper production screw-speed boundary with SME and melt-temperature parity." }
  ]
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
      { code: "screw_rpm", label: "Screw RPM", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "mid_temp_c", label: "Mid barrel temp", field_type: "number", unit: "°C", group_label: "Inputs" },
      { code: "head_temp_c", label: "Head temp", field_type: "number", unit: "°C", group_label: "Inputs" },
      { code: "stabilization_time_min", label: "Stabilization time", field_type: "number", unit: "min", group_label: "Measurements", required: 1 },
      { code: "MFR_g_10min", label: "MFR", field_type: "number", unit: "g/10min", group_label: "Measurements" },
      { code: "qualification_note", label: "Qualification note", field_type: "text", unit: null, group_label: "Summary" }
    ]
  },
  {
    step_number: 2,
    name: "SME Map / Energy Window",
    default_runs: 6,
    fields: [
      { code: "screw_rpm", label: "Screw RPM", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "throughput_kg_h", label: "Throughput", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "torque_pct", label: "Torque", field_type: "number", unit: "%", group_label: "Measurements" },
      { code: "motor_current_a", label: "Motor current", field_type: "number", unit: "A", group_label: "Measurements", required: 1 },
      { code: "melt_temp_c", label: "Melt temp", field_type: "number", unit: "°C", group_label: "Measurements" },
      {
        code: "SME_kJ_kg",
        label: "SME",
        field_type: "number",
        unit: "kJ/kg",
        group_label: "Derived",
        is_derived: 1,
        derived_formula_code: "sme_proxy"
      }
    ]
  },
  {
    step_number: 3,
    name: "Melt Temperature / Thermal History Map",
    default_runs: 6,
    fields: [
      { code: "mid_temp_c", label: "Mid barrel temp", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "head_temp_c", label: "Head temp", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "throughput_kg_h", label: "Throughput", field_type: "number", unit: "kg/h", group_label: "Inputs" },
      { code: "melt_temp_c", label: "Melt temp", field_type: "number", unit: "°C", group_label: "Measurements", required: 1 },
      { code: "MFR_g_10min", label: "MFR", field_type: "number", unit: "g/10min", group_label: "Measurements" }
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
const coatingMethodTags = JSON.stringify(["knife", "slot_die", "spray", "gravure"]);

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
      { code: "coating_method", label: "Coating method", field_type: "tag", unit: null, group_label: "Inputs", allowed_values_json: coatingMethodTags },
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

// This is a process catalogue, not a configurable workflow.  The fields and
// formula codes below are versioned with the application so an extrusion
// result always has a reproducible engineering meaning.
const extrusionStepDefinitions: StepDefinition[] = [
  {
    step_number: 1,
    name: "Raw Material Rheological & Thermal Profiling",
    default_runs: 1,
    fields: [
      { code: "test_temp_c", label: "Test temperature", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "pressure_drop_pa", label: "Capillary pressure drop", field_type: "number", unit: "Pa", group_label: "Measurements", required: 1 },
      { code: "capillary_diameter_mm", label: "Capillary diameter", field_type: "number", unit: "mm", group_label: "Inputs", required: 1 },
      { code: "capillary_length_mm", label: "Capillary length", field_type: "number", unit: "mm", group_label: "Inputs", required: 1 },
      { code: "volumetric_flow_mm3_s", label: "Volumetric flow", field_type: "number", unit: "mm³/s", group_label: "Measurements", required: 1 },
      { code: "extrudate_mass_g", label: "Extrudate mass", field_type: "number", unit: "g", group_label: "Measurements" },
      { code: "collection_time_s", label: "Collection time", field_type: "number", unit: "s", group_label: "Measurements" },
      { code: "point_stable", label: "Pressure stable (±1% / 30 s)", field_type: "boolean", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_pressure_stability" },
      { code: "apparent_shear_stress_pa", label: "Apparent shear stress", field_type: "number", unit: "Pa", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_apparent_shear_stress" },
      { code: "apparent_shear_rate_s", label: "Apparent shear rate", field_type: "number", unit: "s⁻¹", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_apparent_shear_rate" },
      { code: "apparent_viscosity_pa_s", label: "Apparent viscosity", field_type: "number", unit: "Pa·s", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_apparent_viscosity" },
      { code: "mfr_g_10min", label: "MFR", field_type: "number", unit: "g/10 min", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_mfr" }
      ,{ code: "rheology_pressure_stable", label: "Pressure stable (±1% / 30 s)", field_type: "boolean", group_label: "Measurements" }
      ,{ code: "thermal_hold_temp_c", label: "Hold temperature", field_type: "number", unit: "°C", group_label: "Thermal hold inputs", required: 1 }
      ,{ code: "thermal_hold_time_min", label: "Hold time", field_type: "number", unit: "min", group_label: "Thermal hold inputs", required: 1 }
      ,{ code: "thermal_hold_shear_rate_s", label: "Shear rate", field_type: "number", unit: "s⁻¹", group_label: "Thermal hold inputs", required: 1 }
      ,{ code: "thermal_hold_viscosity_pa_s", label: "Measured viscosity", field_type: "number", unit: "Pa·s", group_label: "Thermal hold measurements", required: 1 }
    ]
  },
  {
    step_number: 2,
    name: "Gravimetric Feeder Stability & Dosing Capacity",
    default_runs: 6,
    fields: [
      { code: "feeder_speed_rpm", label: "Feeder speed", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "target_throughput_kg_h", label: "Feed-rate setpoint", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "mean_throughput_kg_h", label: "Mean measured throughput", field_type: "number", unit: "kg/h", group_label: "Measurements", required: 1 },
      { code: "throughput_sd_kg_h", label: "Throughput standard deviation", field_type: "number", unit: "kg/h", group_label: "Measurements", required: 1 },
      { code: "sampling_window_min", label: "Sampling window", field_type: "number", unit: "min", group_label: "Measurements", required: 1 },
      { code: "feed_cv_pct", label: "Feed CV", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_feed_cv" },
      { code: "feed_error_pct", label: "Feed error", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_feed_error" }
    ]
  },
  {
    step_number: 3,
    name: "Pumping Characterization & Motor Operating Window",
    default_runs: 9,
    fields: [
      { code: "screw_speed_rpm", label: "Screw speed", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "throughput_kg_h", label: "Feeder throughput", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "motor_torque_nm", label: "Motor torque", field_type: "number", unit: "N·m", group_label: "Measurements", required: 1 },
      { code: "motor_torque_limit_nm", label: "Motor torque limit", field_type: "number", unit: "N·m", group_label: "Inputs", required: 1 },
      { code: "melt_pressure_bar", label: "Melt pressure before die", field_type: "number", unit: "bar", group_label: "Measurements", required: 1 },
      { code: "target_back_pressure_bar", label: "Back-pressure target", field_type: "number", unit: "bar", group_label: "Inputs" },
      { code: "melt_temp_c", label: "Melt temperature", field_type: "number", unit: "°C", group_label: "Measurements" },
      { code: "operating_point_stable", label: "Pressure and torque stable", field_type: "boolean", group_label: "Measurements", required: 1 },
      { code: "specific_throughput_kg_h_rpm", label: "Specific throughput", field_type: "number", unit: "kg/h/rpm", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_specific_throughput" },
      { code: "motor_load_pct", label: "Motor load", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_motor_load" }
    ]
  },
  {
    step_number: 4,
    name: "Thermal & Dissipative Energy Mapping",
    default_runs: 9,
    fields: [
      { code: "screw_speed_rpm", label: "Screw speed", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "throughput_kg_h", label: "Throughput", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "barrel_set_temp_c", label: "Barrel set temperature", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "motor_torque_nm", label: "Motor torque", field_type: "number", unit: "N·m", group_label: "Measurements", required: 1 },
      { code: "no_load_torque_nm", label: "No-load torque", field_type: "number", unit: "N·m", group_label: "Measurements", required: 1 },
      { code: "melt_temp_c", label: "Melt temperature", field_type: "number", unit: "°C", group_label: "Measurements", required: 1 },
      { code: "heater_power_kw", label: "Heater power", field_type: "number", unit: "kW", group_label: "Measurements" },
      { code: "thermal_point_stable", label: "Melt temperature and torque stable", field_type: "boolean", group_label: "Measurements", required: 1 },
      { code: "mechanical_power_kw", label: "Mechanical power", field_type: "number", unit: "kW", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_mechanical_power" },
      { code: "sme_kwh_kg", label: "Specific mechanical energy", field_type: "number", unit: "kWh/kg", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_sme" },
      { code: "dissipative_temp_rise_c", label: "Dissipative temperature rise", field_type: "number", unit: "°C", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_dissipative_temp_rise" }
    ]
  },
  {
    step_number: 5,
    name: "Residence Time Distribution & Self-Wiping Assessment",
    default_runs: 6,
    fields: [
      { code: "screw_speed_rpm", label: "Screw speed", field_type: "number", unit: "rpm", group_label: "Varied conditions", required: 1 },
      { code: "planned_throughput_kg_h", label: "Planned throughput", field_type: "number", unit: "kg/h", group_label: "Generator values", required: 1 },
      { code: "feeder_speed_rpm", label: "Calculated feeder speed", field_type: "number", unit: "rpm", group_label: "Varied conditions" },
      { code: "throughput_kg_h", label: "Actual throughput", field_type: "number", unit: "kg/h", group_label: "Measurements", required: 1 },
      { code: "steady_state_confirmed", label: "Pressure and torque stable", field_type: "boolean", group_label: "Measurements", required: 1 },
      { code: "mean_residence_time_s", label: "Mean residence time", field_type: "number", unit: "s", group_label: "Measurements", required: 1 },
      { code: "rtd_width_s", label: "RTD width (10–90%)", field_type: "number", unit: "s", group_label: "Measurements" },
      { code: "specific_throughput_kg_h_rpm", label: "Specific throughput", field_type: "number", unit: "kg/h/rpm", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_specific_throughput" },
      { code: "theoretical_residence_time_s", label: "Theoretical residence time", field_type: "number", unit: "s", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_theoretical_residence_time" },
      { code: "degree_of_fill_pct", label: "Degree of fill", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_degree_of_fill" }
    ]
  },
  {
    step_number: 6,
    name: "Side-Feeding & Solid Filler Incorporation",
    default_runs: 0,
    is_optional: true,
    activation_description: "Use when a side feeder introduces solid filler or fibre.",
    fields: [
      { code: "main_screw_speed_rpm", label: "Main screw speed", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "matrix_throughput_kg_h", label: "Matrix throughput", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "side_feeder_speed_rpm", label: "Side-feeder speed", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "filler_throughput_kg_h", label: "Filler throughput", field_type: "number", unit: "kg/h", group_label: "Measurements", required: 1 },
      { code: "side_feeder_torque_nm", label: "Side-feeder torque", field_type: "number", unit: "N·m", group_label: "Measurements" },
      { code: "no_powder_accumulation", label: "No powder accumulation for 10 min", field_type: "boolean", group_label: "Measurements", required: 1 },
      { code: "filler_mass_fraction_pct", label: "Filler mass fraction", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_filler_mass_fraction" }
    ]
  },
  {
    step_number: 7,
    name: "Liquid Additive Dosing & Injection Pressure",
    default_runs: 0,
    is_optional: true,
    activation_description: "Use when liquid additive is injected into the melt.",
    fields: [
      { code: "screw_speed_rpm", label: "Screw speed", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "polymer_throughput_kg_h", label: "Polymer throughput", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "liquid_throughput_kg_h", label: "Liquid dosing rate", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "injection_pressure_bar", label: "Injection pressure", field_type: "number", unit: "bar", group_label: "Measurements", required: 1 },
      { code: "barrel_pressure_bar", label: "Barrel pressure at injection", field_type: "number", unit: "bar", group_label: "Measurements", required: 1 },
      { code: "no_liquid_backflow", label: "No liquid backflow", field_type: "boolean", group_label: "Measurements", required: 1 },
      { code: "liquid_mass_fraction_pct", label: "Liquid mass fraction", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_liquid_mass_fraction" },
      { code: "injection_pressure_delta_bar", label: "Injection pressure differential", field_type: "number", unit: "bar", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_injection_pressure_delta" }
    ]
  },
  {
    step_number: 8,
    name: "Devolatilization & Vacuum Degassing",
    default_runs: 0,
    is_optional: true,
    activation_description: "Use when the line has a vacuum vent for moisture, solvent or volatile removal.",
    fields: [
      { code: "screw_speed_rpm", label: "Screw speed", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "throughput_kg_h", label: "Throughput", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "vacuum_pressure_mbar", label: "Vacuum pressure", field_type: "number", unit: "mbar", group_label: "Inputs", required: 1 },
      { code: "initial_volatiles_pct", label: "Initial volatile content", field_type: "number", unit: "%", group_label: "Measurements", required: 1 },
      { code: "residual_volatiles_pct", label: "Residual volatile content", field_type: "number", unit: "%", group_label: "Measurements", required: 1 },
      { code: "trap_carryover_g", label: "Carryover in vacuum trap", field_type: "number", unit: "g", group_label: "Measurements" },
      { code: "vacuum_stable", label: "Vacuum stable (±5 mbar)", field_type: "boolean", group_label: "Measurements", required: 1 },
      { code: "devolatilization_efficiency_pct", label: "Devolatilization efficiency", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_devolatilization_efficiency" }
    ]
  },
  {
    step_number: 9,
    name: "Reactive Extrusion & Conversion Kinetics",
    default_runs: 0,
    is_optional: true,
    activation_description: "Use for grafting, reaction, crosslinking or deliberate MFR modification.",
    fields: [
      { code: "reaction_temp_c", label: "Reaction-zone temperature", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
      { code: "mean_residence_time_s", label: "Mean residence time", field_type: "number", unit: "s", group_label: "Inputs", required: 1 },
      { code: "conversion_pct", label: "Conversion", field_type: "number", unit: "%", group_label: "Measurements", required: 1 },
      { code: "product_mfr_g_10min", label: "Product MFR", field_type: "number", unit: "g/10 min", group_label: "Measurements" },
      { code: "reaction_stable", label: "Conversion and MFR stable for 15 min", field_type: "boolean", group_label: "Measurements", required: 1 },
      { code: "reaction_rate_constant_s_inv", label: "Reaction-rate constant k", field_type: "number", unit: "s⁻¹", group_label: "Inputs" },
      { code: "damkohler_number", label: "Damköhler number", field_type: "number", unit: null, group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_damkohler" }
    ]
  },
  {
    step_number: 10,
    name: "Scale-Up Lab → Pilot → Production Study",
    default_runs: 0,
    is_optional: true,
    activation_description: "Use when transferring a validated formulation between extruders of different screw diameter.",
    fields: [
      { code: "production_screw_speed_rpm", label: "Production screw speed", field_type: "number", unit: "rpm", group_label: "Inputs", required: 1 },
      { code: "production_throughput_kg_h", label: "Production throughput", field_type: "number", unit: "kg/h", group_label: "Inputs", required: 1 },
      { code: "production_torque_nm", label: "Production motor torque", field_type: "number", unit: "N·m", group_label: "Measurements", required: 1 },
      { code: "production_no_load_torque_nm", label: "Production no-load torque", field_type: "number", unit: "N·m", group_label: "Measurements" },
      { code: "production_melt_temp_c", label: "Production melt temperature", field_type: "number", unit: "°C", group_label: "Measurements", required: 1 },
      { code: "production_melt_pressure_bar", label: "Production melt pressure", field_type: "number", unit: "bar", group_label: "Measurements" },
      { code: "particle_size_d50_um", label: "Particle size d50", field_type: "number", unit: "µm", group_label: "Measurements" },
      { code: "scale_up_stable", label: "SME and melt-temperature parity stable", field_type: "boolean", group_label: "Measurements", required: 1 },
      { code: "scaled_throughput_target_kg_h", label: "D³ scaled throughput target", field_type: "number", unit: "kg/h", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_scale_up_throughput" },
      { code: "tip_speed_m_s", label: "Screw tip speed", field_type: "number", unit: "m/s", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_tip_speed" },
      { code: "production_sme_kwh_kg", label: "Production SME", field_type: "number", unit: "kWh/kg", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_scale_up_sme" },
      { code: "sme_parity_delta_pct", label: "SME parity deviation", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "extrusion_sme_parity" }
    ]
  }
];

/**
 * The qualification catalogue describes how a parameter is measured; this
 * routine registers the same parameter identity in the shared catalogue used
 * by DOE, reports and custom fields. It is safe to run on every startup.
 */
export function ensureExtrusionParameterCatalogue(db: Db) {
  const tagsFor = (stepNumber: number, group: string | null | undefined) => {
    const normalized = String(group || "").toLowerCase();
    const tags = ["extrusion", `step-${stepNumber}`];
    const purposeByStep: Record<number, string> = {
      1: "rheology",
      2: "feeder",
      3: "operating-window",
      4: "energy",
      5: "rtd",
      6: "side-feeding",
      7: "liquid-injection",
      8: "devolatilization",
      9: "reactive-extrusion",
      10: "scale-up"
    };
    if (purposeByStep[stepNumber]) tags.push(purposeByStep[stepNumber]);
    if (/rheolog|capillary/.test(normalized)) tags.push("rheology", "capillary");
    if (/thermal|temperature|dsc|tga/.test(normalized)) tags.push("thermal");
    if (/feeder|feed/.test(normalized)) tags.push("feeder");
    if (/rtd|residence/.test(normalized)) tags.push("rtd");
    if (/side/.test(normalized)) tags.push("side-feeding");
    return tags;
  };
  for (const step of extrusionStepDefinitions) {
    for (const field of step.fields) {
      const derived = field.is_derived === 1;
      const controlled = /input|varied|generator/i.test(String(field.group_label || ""));
      upsertCanonicalParamDefinition(db, {
        code: field.code,
        label: field.label,
        unit: field.unit ?? null,
        field_kind: controlled ? "INPUT" : "OUTPUT",
        field_type: field.field_type,
        group_label: "Extrusion",
        allowed_values_json: field.allowed_values_json ?? null,
        semantic_role: derived ? "derived" : controlled ? "controlled" : "measurement",
        doe_role: controlled && !derived ? "factor" : derived ? "response" : "none",
        is_code_owned: 1,
        process_type_codes: ["extrusion_v1"],
        tags: tagsFor(step.step_number, field.group_label)
      });
    }
    for (const output of getExtrusionOutputDefinitions(step.step_number)) {
      upsertCanonicalParamDefinition(db, {
        code: output.code,
        label: output.label,
        unit: output.unit,
        field_kind: "OUTPUT",
        field_type: output.field_type,
        group_label: "Extrusion handoff",
        allowed_values_json: null,
        semantic_role: "constraint",
        doe_role: "constraint",
        is_code_owned: 1,
        process_type_codes: ["extrusion_v1"],
        tags: [...tagsFor(step.step_number, output.group), "handoff"]
      });
    }
  }

  // Existing extrusion experiments predate the catalogue link. Backfill the
  // foreign key by code once, without changing measured values or fields.
  db.exec(`
    UPDATE qual_fields AS field
    SET param_def_id = (
      SELECT parameter.id FROM param_definitions parameter
      WHERE parameter.scope = 'GLOBAL' AND parameter.code = field.code
      LIMIT 1
    )
    WHERE field.param_def_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM experiments experiment
        JOIN processes process ON process.id = experiment.process_id
        JOIN process_types process_type ON process_type.id = process.process_type_id
        WHERE experiment.id = field.experiment_id AND lower(process_type.code) = 'extrusion_v1'
      )
      AND EXISTS (
        SELECT 1 FROM param_definitions parameter
        WHERE parameter.scope = 'GLOBAL' AND parameter.code = field.code
      );

    UPDATE qual_step_outputs AS output
    SET param_def_id = (
      SELECT parameter.id FROM param_definitions parameter
      WHERE parameter.scope = 'GLOBAL' AND parameter.code = output.output_code
      LIMIT 1
    )
    WHERE output.param_def_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM experiments experiment
        JOIN processes process ON process.id = experiment.process_id
        JOIN process_types process_type ON process_type.id = process.process_type_id
        WHERE experiment.id = output.experiment_id AND lower(process_type.code) = 'extrusion_v1'
      )
      AND EXISTS (
        SELECT 1 FROM param_definitions parameter
        WHERE parameter.scope = 'GLOBAL' AND parameter.code = output.output_code
      );
  `);
}

function getExtrusionOutputDefinitions(stepNumber: number) {
  if (stepNumber === 1) return extrusionStep1OutputDefinitions;
  if (stepNumber === 2) return extrusionStep2OutputDefinitions;
  if (stepNumber === 3) return extrusionStep3OutputDefinitions;
  if (stepNumber === 5) return extrusionStep5OutputDefinitions;
  return extrusionOptionalOutputDefinitions[stepNumber] ?? [];
}

function getProcessTypeCodeForExperiment(db: Db, experimentId: number): string {
  const experiment = getExperiment(db, experimentId);
  if (!experiment || !experiment.process_id) return "injection";
  const process = getProcessById(db, experiment.process_id);
  return String(process?.process_type_code || "injection").toLowerCase();
}

function getStepDefinitionsForProcessType(processTypeCode: string): StepDefinition[] {
  if (processTypeCode === "compounding") return compoundingStepDefinitions;
  if (processTypeCode === "coating") return coatingStepDefinitions;
  if (processTypeCode === "extrusion_v1") return extrusionStepDefinitions;
  return injectionStepDefinitions;
}

function getCatalogueStageCode(processTypeCode: string, stepNumber: number) {
  const normalizedProcess = processTypeCode.replace(/[^a-z0-9_-]+/g, "") || "injection";
  return `${normalizedProcess}.qualification.${String(stepNumber).padStart(3, "0")}`;
}

export function getQualificationStepsForExperiment(db: Db, experimentId: number) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  const existingStepNumbers = new Set(listQualSteps(db, experimentId).map((step) => step.step_number));
  return getStepDefinitionsForProcessType(processTypeCode)
    .filter((step) => !step.is_optional || existingStepNumbers.has(step.step_number))
    .map(({ step_number, name }) => ({
    step_number,
    name,
    stage_code: getCatalogueStageCode(processTypeCode, step_number),
    display_order: step_number
  }));
}

export function getOptionalQualificationStudies(db: Db, experimentId: number) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  return getStepDefinitionsForProcessType(processTypeCode)
    .filter((step) => step.is_optional)
    .map((step) => ({ stepNumber: step.step_number, name: step.name, description: step.activation_description || "Optional study" }));
}

export function setOptionalQualificationStudyEnabled(db: Db, experimentId: number, stepNumber: number, enabled: boolean) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  const definition = getStepDefinitionsForProcessType(processTypeCode).find((step) => step.step_number === stepNumber && step.is_optional);
  if (!definition) throw new Error("This qualification study is not an optional stage for the experiment process");
  let step = getQualStep(db, experimentId, stepNumber);
  if (!step && enabled) {
    ensureQualSteps(db, experimentId, [{
      step_number: definition.step_number,
      stage_code: getCatalogueStageCode(processTypeCode, definition.step_number),
      display_order: definition.step_number,
      title: definition.name
    }]);
    step = getQualStep(db, experimentId, stepNumber);
  }
  if (!step) return null;
  setQualStepActive(db, step.id, enabled);
  if (enabled) ensureQualificationDefaults(db, experimentId);
  return getQualStep(db, experimentId, stepNumber);
}

export function getStepDefinitionForExperiment(db: Db, experimentId: number, stepNumber: number) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  return getStepDefinitionsForProcessType(processTypeCode).find((step) => step.step_number === stepNumber) ?? null;
}

export function getQualificationSeriesDefinitionsForExperiment(
  db: Db,
  experimentId: number,
  stepNumber: number
) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  if (processTypeCode === "extrusion_v1" && stepNumber === 1) {
    return extrusionStep1SeriesDefinitions;
  }
  if (processTypeCode === "extrusion_v1" && stepNumber === 5) {
    return extrusionStep5SeriesDefinitions;
  }
  return [];
}

export function getQualificationOutputDefinitionsForExperiment(
  db: Db,
  experimentId: number,
  stepNumber: number
) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  if (processTypeCode === "extrusion_v1" && stepNumber === 1) {
    return extrusionStep1OutputDefinitions;
  }
  if (processTypeCode === "extrusion_v1" && stepNumber === 2) {
    return extrusionStep2OutputDefinitions;
  }
  if (processTypeCode === "extrusion_v1" && stepNumber === 3) {
    return extrusionStep3OutputDefinitions;
  }
  if (processTypeCode === "extrusion_v1" && stepNumber === 5) {
    return extrusionStep5OutputDefinitions;
  }
  if (processTypeCode === "extrusion_v1" && extrusionOptionalOutputDefinitions[stepNumber]) {
    return extrusionOptionalOutputDefinitions[stepNumber];
  }
  return [];
}

export function getQualificationStepName(db: Db, experimentId: number, stepNumber: number): string {
  return getStepDefinitionForExperiment(db, experimentId, stepNumber)?.name ?? `Step ${stepNumber}`;
}

export function ensureQualificationDefaults(db: Db, experimentId: number) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
  const stepDefinitions = getStepDefinitionsForProcessType(processTypeCode);
  ensureQualSteps(
    db,
    experimentId,
    stepDefinitions.filter((step) => !step.is_optional).map((step) => ({
      step_number: step.step_number,
      stage_code: getCatalogueStageCode(processTypeCode, step.step_number),
      display_order: step.step_number,
      title: step.name
    }))
  );
  const steps = listQualSteps(db, experimentId);
  for (const step of steps) {
    const def = stepDefinitions.find((d) => d.step_number === step.step_number);
    if (!def) continue;
    if (def.is_optional && step.is_active === 0) continue;
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
      const canonical = processTypeCode === "extrusion_v1"
        ? findGlobalParamByCode(db, field.code)
        : undefined;
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
        derived_formula_code: field.derived_formula_code ?? null,
        param_def_id: canonical?.id ?? null
      });
    }
    for (const field of def.fields) {
      const existingField = fields.find((item) => item.code === field.code);
      if (!existingField) continue;
      const updatePatch: Partial<{
        label: string;
        unit: string | null;
        group_label: string | null;
        required: number;
        is_derived: 0 | 1;
        derived_formula_code: string | null;
        allowed_values_json: string | null;
        param_def_id: number | null;
      }> = {};
      const shouldRefreshLabel =
        processTypeCode === "extrusion_v1" &&
        ((step.step_number === 2 && field.code === "target_throughput_kg_h" && existingField.label === "Target throughput") ||
          (step.step_number === 3 && field.code === "throughput_kg_h" && ["Throughput", "Feeder throughput (from Step 2)"].includes(existingField.label)) ||
          step.step_number === 5);
      if (shouldRefreshLabel) {
        updatePatch.label = field.label;
        updatePatch.unit = field.unit ?? null;
        updatePatch.group_label = field.group_label ?? null;
        updatePatch.required = field.required ?? 0;
      }
      if ((existingField.is_derived ?? 0) !== (field.is_derived ?? 0)) {
        updatePatch.is_derived = (field.is_derived ?? 0) as 0 | 1;
      }
      if ((existingField.derived_formula_code ?? null) !== (field.derived_formula_code ?? null)) {
        updatePatch.derived_formula_code = field.derived_formula_code ?? null;
      }
      if ((existingField.allowed_values_json ?? null) !== (field.allowed_values_json ?? null)) {
        updatePatch.allowed_values_json = field.allowed_values_json ?? null;
      }
      if (processTypeCode === "extrusion_v1" && !existingField.param_def_id) {
        const canonical = findGlobalParamByCode(db, field.code);
        if (canonical) updatePatch.param_def_id = canonical.id;
      }
      if (Object.keys(updatePatch).length) {
        updateQualField(db, existingField.id, updatePatch);
      }
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
    if (processTypeCode === "compounding" && step.step_number === 1) {
      const legacyCodes = new Set([
        "throughput_kg_h",
        "tracer_peak_time_s",
        "tracer_tail_time_s",
        "torque_stability_pct",
        "pressure_stability_pct"
      ]);
      fields.forEach((field) => {
        if (legacyCodes.has(field.code) && field.is_enabled !== 0) {
          updateQualField(db, field.id, { is_enabled: 0 });
        }
      });
    }
    if (processTypeCode === "compounding" && step.step_number === 2) {
      const torqueField = fields.find((field) => field.code === "torque_pct");
      if (torqueField && torqueField.is_enabled !== 1) {
        updateQualField(db, torqueField.id, { is_enabled: 1 });
      }
      const currentField = fields.find((field) => field.code === "motor_current_a");
      if (currentField && currentField.is_enabled !== 1) {
        updateQualField(db, currentField.id, { is_enabled: 1 });
      }
      const pressureField = fields.find((field) => field.code === "die_pressure_bar");
      if (pressureField && pressureField.is_enabled !== 0) {
        updateQualField(db, pressureField.id, { is_enabled: 0 });
      }
    }
    if (processTypeCode === "compounding" && step.step_number === 3) {
      const rpmField = fields.find((field) => field.code === "screw_rpm");
      if (rpmField && rpmField.is_enabled !== 0) {
        updateQualField(db, rpmField.id, { is_enabled: 0 });
      }
      const pressureField = fields.find((field) => field.code === "die_pressure_bar");
      if (pressureField && pressureField.is_enabled !== 0) {
        updateQualField(db, pressureField.id, { is_enabled: 0 });
      }
    }
    const runs = listQualRuns(db, step.id);
    if (processTypeCode === "extrusion_v1" && step.step_number === 1) {
      // Step 1 is a material-characterisation programme, not one nine-row
      // table: two sweep groups plus three single-test records.
      db.prepare("UPDATE qual_runs SET run_group = 'rheology' WHERE step_id = ? AND run_group = 'default'")
        .run(step.id);
      const grouped = new Set(listQualRuns(db, step.id).map((run) => run.run_group));
      if (!grouped.has("rheology")) createQualRuns(db, experimentId, step.id, 1, "rheology");
      if (!grouped.has("thermal_hold")) createQualRuns(db, experimentId, step.id, 1, "thermal_hold");
      if (!grouped.has("dsc")) createQualRuns(db, experimentId, step.id, 1, "dsc");
      if (!grouped.has("tga")) createQualRuns(db, experimentId, step.id, 1, "tga");
    } else if (!(processTypeCode === "extrusion_v1" && step.step_number === 3) && runs.length === 0) {
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

/**
 * A Step 5 RTD run is one pulse-response experiment.  The investigator enters
 * the outlet samples (time and baseline-corrected tracer signal); the two
 * scalar RTD characteristics in the run table are then evidence-derived,
 * rather than independently typed estimates.
 */
export function updateExtrusionRtdMetricsFromSeries(db: Db, stepId: number, runId: number) {
  const fields = new Map(listQualFields(db, stepId).map((field) => [field.code, field]));
  const meanField = fields.get("mean_residence_time_s");
  const widthField = fields.get("rtd_width_s");
  if (!meanField || !widthField) return null;
  const series = getQualRunSeries(db, runId, "tracer_concentration_response");
  const clear = () => {
    saveQualRunValue(db, runId, meanField.id, "number", null);
    saveQualRunValue(db, runId, widthField.id, "number", null);
  };
  if (!series || series.points.length < 2) {
    clear();
    return null;
  }
  const points = series.points
    .map((point) => ({ time: Number(point.x_value), signal: Number(point.y_value) }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.signal) && point.time >= 0 && point.signal >= 0)
    .sort((a, b) => a.time - b.time);
  if (points.length < 2 || points.some((point, index) => index > 0 && point.time <= points[index - 1].time)) {
    clear();
    return null;
  }
  let area = 0;
  let firstMoment = 0;
  const cumulativeAreas = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const width = current.time - previous.time;
    const segmentArea = width * (previous.signal + current.signal) / 2;
    const segmentFirstMoment = width * ((previous.time * previous.signal) + (current.time * current.signal)) / 2;
    area += segmentArea;
    firstMoment += segmentFirstMoment;
    cumulativeAreas.push(area);
  }
  if (!(area > 0)) {
    clear();
    return null;
  }
  const timeAtCumulativeFraction = (fraction: number) => {
    const targetArea = area * fraction;
    for (let index = 1; index < points.length; index += 1) {
      const before = cumulativeAreas[index - 1];
      const segmentArea = cumulativeAreas[index] - before;
      if (targetArea <= cumulativeAreas[index] && segmentArea > 0) {
        const segmentFraction = (targetArea - before) / segmentArea;
        return points[index - 1].time + segmentFraction * (points[index].time - points[index - 1].time);
      }
    }
    return points[points.length - 1].time;
  };
  const meanResidenceTime = firstMoment / area;
  const rtdWidth = timeAtCumulativeFraction(0.9) - timeAtCumulativeFraction(0.1);
  saveQualRunValue(db, runId, meanField.id, "number", meanResidenceTime);
  saveQualRunValue(db, runId, widthField.id, "number", rtdWidth);
  return { meanResidenceTime, rtdWidth, pointCount: points.length };
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

function getExtrusionFeederCalibration(db: Db, experimentId: number) {
  const feederStep = getQualStep(db, experimentId, 2);
  if (!feederStep) return null;
  const fields = new Map(listQualFields(db, feederStep.id).map((field) => [field.code, field]));
  const feederSpeed = fields.get("feeder_speed_rpm");
  const throughput = fields.get("mean_throughput_kg_h");
  const cv = fields.get("feed_cv_pct");
  if (!feederSpeed || !throughput) return null;
  const points = listQualRuns(db, feederStep.id)
    .filter((run) => run.exclude_from_analysis !== 1)
    .map((run) => {
      const values = new Map(listQualRunValues(db, run.id).map((value) => [value.field_id, value.value_real]));
      return { speed: values.get(feederSpeed.id), throughput: values.get(throughput.id), cv: cv ? values.get(cv.id) : null };
    })
    .filter((point): point is { speed: number; throughput: number; cv: number | null } => Number.isFinite(point.speed) && Number.isFinite(point.throughput) && point.cv != null && point.cv <= 1.5)
    .map(({ speed, throughput }) => ({ speed, throughput }));
  if (points.length < 2) return null;
  const meanSpeed = points.reduce((sum, point) => sum + point.speed, 0) / points.length;
  const meanThroughput = points.reduce((sum, point) => sum + point.throughput, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.speed - meanSpeed) ** 2, 0);
  if (denominator <= 0) return null;
  const slope = points.reduce((sum, point) => sum + (point.speed - meanSpeed) * (point.throughput - meanThroughput), 0) / denominator;
  const intercept = meanThroughput - slope * meanSpeed;
  const total = points.reduce((sum, point) => sum + (point.throughput - meanThroughput) ** 2, 0);
  const residual = points.reduce((sum, point) => sum + (point.throughput - (slope * point.speed + intercept)) ** 2, 0);
  return {
    points,
    slope,
    intercept,
    rSquared: total > 0 ? 1 - residual / total : null
  };
}

export function recomputeDerivedAndSummary(
  db: Db,
  experimentId: number,
  stepId: number,
  stepNumber: number
) {
  const processTypeCode = getProcessTypeCodeForExperiment(db, experimentId);
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
  const feederCalibration = processTypeCode === "extrusion_v1" && stepNumber === 2
    ? getExtrusionFeederCalibration(db, experimentId)
    : null;
  let intensificationCoeff = 1;
  let stepSettings: Record<string, unknown> = {};
  if (settings) {
    try {
      const parsed = JSON.parse(settings) as Record<string, unknown>;
      stepSettings = parsed;
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
    const setDerived = (code: string, value: number | string | boolean | null) => {
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
      } else if (field.field_type === "boolean") {
        upsertQualRunValue(db, {
          run_id: run.id,
          field_id: field.id,
          value_real: value == null ? null : (value === true || value === 1 ? 1 : 0),
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

    if (processTypeCode === "injection") {
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
    if (processTypeCode === "compounding" && stepNumber === 2) {
      const rpm = getNumber("screw_rpm");
      const throughput = getNumber("throughput_kg_h");
      const torquePct = getNumber("torque_pct");
      const motorCurrentA = getNumber("motor_current_a");
      const driveSignal =
        Number.isFinite(torquePct as number) && Number(torquePct) !== 0
          ? torquePct
          : motorCurrentA;
      if (
        rpm != null &&
        throughput != null &&
        throughput > 0 &&
        driveSignal != null
      ) {
        // SME proxy supports either torque% or motor current, whichever is available.
        const smeProxy = (driveSignal * rpm) / throughput * 0.01;
        setDerived("SME_kJ_kg", smeProxy);
      }
    }
    if (processTypeCode === "extrusion_v1") {
      const screwSpeed = getNumber("screw_speed_rpm");
      const throughput = getNumber("throughput_kg_h");
      const setSpecificThroughput = () => {
        if (screwSpeed != null && screwSpeed > 0 && throughput != null) {
          setDerived("specific_throughput_kg_h_rpm", throughput / screwSpeed);
        }
      };
      if (stepNumber === 1) {
        const pressure = getNumber("pressure_drop_pa");
        const diameterMm = getNumber("capillary_diameter_mm");
        const lengthMm = getNumber("capillary_length_mm");
        const flowMm3S = getNumber("volumetric_flow_mm3_s");
        const diameterM = diameterMm != null ? diameterMm / 1000 : null;
        const lengthM = lengthMm != null ? lengthMm / 1000 : null;
        const shearStress =
          pressure != null && diameterM != null && lengthM != null && lengthM > 0
            ? (pressure * diameterM) / (4 * lengthM)
            : null;
        const shearRate =
          flowMm3S != null && diameterM != null && diameterM > 0
            ? (32 * (flowMm3S / 1_000_000_000)) / (Math.PI * Math.pow(diameterM, 3))
            : null;
        if (shearStress != null) setDerived("apparent_shear_stress_pa", shearStress);
        if (shearRate != null) setDerived("apparent_shear_rate_s", shearRate);
        if (shearStress != null && shearRate != null && shearRate > 0) {
          setDerived("apparent_viscosity_pa_s", shearStress / shearRate);
        }
        const mass = getNumber("extrudate_mass_g");
        const time = getNumber("collection_time_s");
        if (mass != null && time != null && time > 0) {
          setDerived("mfr_g_10min", (600 * mass) / time);
        }
        const pressureSeries = getQualRunSeries(db, run.id, "pressure_stability");
        if (pressureSeries && pressureSeries.points.length >= 2) {
          const sorted = [...pressureSeries.points].sort((a, b) => a.x_value - b.x_value);
          const endTime = sorted[sorted.length - 1].x_value;
          const windowPoints = sorted.filter((point) => point.x_value >= endTime - 30);
          const windowSpan = windowPoints.length >= 2
            ? windowPoints[windowPoints.length - 1].x_value - windowPoints[0].x_value
            : 0;
          const meanPressure = windowPoints.length
            ? windowPoints.reduce((sum, point) => sum + point.y_value, 0) / windowPoints.length
            : 0;
          const maxDeviationPct = meanPressure !== 0
            ? Math.max(...windowPoints.map((point) => Math.abs((point.y_value - meanPressure) / meanPressure) * 100))
            : Number.POSITIVE_INFINITY;
          setDerived("point_stable", windowSpan >= 30 && maxDeviationPct <= 1);
        } else {
          setDerived("point_stable", null);
        }
      }
      if (stepNumber === 2) {
        const target = getNumber("target_throughput_kg_h");
        const mean = getNumber("mean_throughput_kg_h");
        const standardDeviation = getNumber("throughput_sd_kg_h");
        if (mean != null && mean > 0 && standardDeviation != null) {
          setDerived("feed_cv_pct", (standardDeviation / mean) * 100);
        }
        if (target != null && target > 0 && mean != null) {
          setDerived("feed_error_pct", (Math.abs(mean - target) / target) * 100);
        }
      }
      if (stepNumber === 3) {
        setSpecificThroughput();
        const torque = getNumber("motor_torque_nm");
        const limit = getNumber("motor_torque_limit_nm");
        if (torque != null && limit != null && limit > 0) {
          setDerived("motor_load_pct", (torque / limit) * 100);
        }
      }
      if (stepNumber === 4) {
        const torque = getNumber("motor_torque_nm");
        const noLoadTorque = getNumber("no_load_torque_nm");
        const meltTemp = getNumber("melt_temp_c");
        const barrelTemp = getNumber("barrel_set_temp_c");
        if (screwSpeed != null && torque != null) {
          setDerived("mechanical_power_kw", (2 * Math.PI * screwSpeed * torque) / 60_000);
        }
        if (
          screwSpeed != null &&
          throughput != null &&
          throughput > 0 &&
          torque != null &&
          noLoadTorque != null
        ) {
          setDerived("sme_kwh_kg", (screwSpeed * (torque - noLoadTorque)) / (9549 * throughput));
        }
        if (meltTemp != null && barrelTemp != null) {
          setDerived("dissipative_temp_rise_c", meltTemp - barrelTemp);
        }
      }
      if (stepNumber === 5) {
        setSpecificThroughput();
        const residenceTime = getNumber("mean_residence_time_s");
        const configuredFreeVolumeL = resolveSettingNumber(stepSettings.rtd_free_volume_l);
        const configuredMeltDensity = resolveSettingNumber(stepSettings.rtd_melt_density_kg_l);
        const freeVolumeL = Number.isFinite(configuredFreeVolumeL) && configuredFreeVolumeL > 0
          ? configuredFreeVolumeL
          : getNumber("free_volume_l");
        const meltDensity = Number.isFinite(configuredMeltDensity) && configuredMeltDensity > 0
          ? configuredMeltDensity
          : getNumber("melt_density_kg_l");
        if (throughput != null && throughput > 0 && freeVolumeL != null && freeVolumeL > 0 && meltDensity != null && meltDensity > 0) {
          setDerived("theoretical_residence_time_s", (freeVolumeL * meltDensity * 3600) / throughput);
        }
        if (
          throughput != null &&
          residenceTime != null &&
          freeVolumeL != null &&
          freeVolumeL > 0 &&
          meltDensity != null &&
          meltDensity > 0
        ) {
          const throughputKgS = throughput / 3600;
          setDerived(
            "degree_of_fill_pct",
            (throughputKgS * residenceTime) / (freeVolumeL * meltDensity) * 100
          );
        }
      }
      if (stepNumber === 6) {
        const matrixThroughput = getNumber("matrix_throughput_kg_h");
        const fillerThroughput = getNumber("filler_throughput_kg_h");
        if (matrixThroughput != null && fillerThroughput != null && matrixThroughput + fillerThroughput > 0) {
          setDerived("filler_mass_fraction_pct", fillerThroughput / (matrixThroughput + fillerThroughput) * 100);
        }
      }
      if (stepNumber === 7) {
        const polymerThroughput = getNumber("polymer_throughput_kg_h");
        const liquidThroughput = getNumber("liquid_throughput_kg_h");
        const injectionPressure = getNumber("injection_pressure_bar");
        const barrelPressure = getNumber("barrel_pressure_bar");
        if (polymerThroughput != null && liquidThroughput != null && polymerThroughput + liquidThroughput > 0) {
          setDerived("liquid_mass_fraction_pct", liquidThroughput / (polymerThroughput + liquidThroughput) * 100);
        }
        if (injectionPressure != null && barrelPressure != null) {
          setDerived("injection_pressure_delta_bar", injectionPressure - barrelPressure);
        }
      }
      if (stepNumber === 8) {
        const initial = getNumber("initial_volatiles_pct");
        const residual = getNumber("residual_volatiles_pct");
        if (initial != null && initial > 0 && residual != null) {
          setDerived("devolatilization_efficiency_pct", (initial - residual) / initial * 100);
        }
      }
      if (stepNumber === 9) {
        const rateConstant = getNumber("reaction_rate_constant_s_inv");
        const residenceTime = getNumber("mean_residence_time_s");
        if (rateConstant != null && residenceTime != null) {
          setDerived("damkohler_number", rateConstant * residenceTime);
        }
      }
      if (stepNumber === 10) {
        const sourceDiameter = resolveSettingNumber(stepSettings.scale_up_source_screw_diameter_mm);
        const productionDiameter = resolveSettingNumber(stepSettings.scale_up_production_screw_diameter_mm);
        const sourceThroughput = resolveSettingNumber(stepSettings.scale_up_source_throughput_kg_h);
        const sourceSme = resolveSettingNumber(stepSettings.scale_up_source_sme_kwh_kg);
        const speed = getNumber("production_screw_speed_rpm");
        const throughput = getNumber("production_throughput_kg_h");
        const torque = getNumber("production_torque_nm");
        const noLoadTorque = getNumber("production_no_load_torque_nm");
        if (sourceDiameter != null && sourceDiameter > 0 && productionDiameter != null && productionDiameter > 0 && sourceThroughput != null) {
          setDerived("scaled_throughput_target_kg_h", sourceThroughput * Math.pow(productionDiameter / sourceDiameter, 3));
        }
        if (speed != null && productionDiameter != null && productionDiameter > 0) {
          setDerived("tip_speed_m_s", Math.PI * (productionDiameter / 1000) * speed / 60);
        }
        if (speed != null && throughput != null && throughput > 0 && torque != null && noLoadTorque != null) {
          const sme = speed * (torque - noLoadTorque) / (9549 * throughput);
          setDerived("production_sme_kwh_kg", sme);
          if (sourceSme != null && sourceSme > 0) {
            setDerived("sme_parity_delta_pct", Math.abs(sme - sourceSme) / sourceSme * 100);
          }
        }
      }
    }
  }

  const summary = buildStepSummary(db, experimentId, stepId, stepNumber, fieldByCode, processTypeCode);
  if (processTypeCode === "injection" && stepNumber === 1 && settings) {
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
  fieldByCode: Map<string, { id: number }>,
  processTypeCode: string
) {
  const runs = listQualRuns(db, stepId);
  const feederCalibration = processTypeCode === "extrusion_v1" && stepNumber === 2
    ? getExtrusionFeederCalibration(db, experimentId)
    : null;
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
  const boolOrNullFor = (values: Map<number, { value_real: number | null }>, code: string) => {
    const value = numberFor(values, code);
    if (value == null) return null;
    return value === 1;
  };

  if (processTypeCode === "injection" && stepNumber === 1) {
    let best: { inj: number; viscosity: number } | null = null;
    for (const row of runValues) {
      const inj = numberFor(row.values, "inj_speed");
      const visc = numberFor(row.values, "rel_viscosity");
      if (inj == null || visc == null) continue;
      if (!best || visc < best.viscosity) best = { inj, viscosity: visc };
    }
    summaries.recommended_inj_speed = best?.inj ?? null;
  }
  if (processTypeCode === "injection" && stepNumber === 2) {
    let maxVar: number | null = null;
    for (const row of runValues) {
      const v = numberFor(row.values, "cavity_weight_variation_pct");
      if (v == null) continue;
      if (maxVar == null || v > maxVar) maxVar = v;
    }
    summaries.max_cavity_imbalance_pct = maxVar;
  }
  if (processTypeCode === "injection" && stepNumber === 3) {
    let maxPct: number | null = null;
    for (const row of runValues) {
      const v = numberFor(row.values, "max_pressure_pct");
      if (v == null) continue;
      if (maxPct == null || v > maxPct) maxPct = v;
    }
    summaries.max_pressure_pct = maxPct;
    summaries.pressure_margin_ok = maxPct != null ? maxPct <= 90 : null;
  }
  if (processTypeCode === "injection" && stepNumber === 4) {
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
  if (processTypeCode === "injection" && stepNumber === 5) {
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
  if (processTypeCode === "injection" && stepNumber === 6) {
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

  if (processTypeCode === "compounding") {
    if (stepNumber === 1) {
      const activeRows = runValues.filter((row) => row.run.exclude_from_analysis !== 1);
      const stabilization = activeRows
        .map((row) => numberFor(row.values, "stabilization_time_min"))
        .filter((v): v is number => Number.isFinite(v));
      if (stabilization.length) {
        summaries.stabilization_time_min = Math.min(...stabilization);
      }
      const mfrValues = activeRows
        .map((row) => numberFor(row.values, "MFR_g_10min"))
        .filter((v): v is number => Number.isFinite(v))
        .sort((a, b) => a - b);
      const mfrMedian = mfrValues.length
        ? mfrValues[Math.floor(mfrValues.length / 2)]
        : null;
      const candidates = activeRows
        .map((row) => {
          const screw = numberFor(row.values, "screw_rpm");
          const midTemp = numberFor(row.values, "mid_temp_c");
          const headTemp = numberFor(row.values, "head_temp_c");
          const stabilizationTime = numberFor(row.values, "stabilization_time_min");
          const mfr = numberFor(row.values, "MFR_g_10min");
          if (screw == null || stabilizationTime == null) return null;
          const stabilizationTerm = stabilizationTime;
          const mfrTerm =
            mfr != null && mfrMedian != null && mfrMedian !== 0
              ? Math.abs((mfr - mfrMedian) / mfrMedian) * 10
              : 0;
          const score = stabilizationTerm + mfrTerm;
          return {
            runCode: row.run.run_code,
            screw,
            midTemp,
            headTemp,
            stabilizationTime,
            mfr,
            score
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (candidates.length) {
        const best = candidates.reduce((acc, item) => (item.score < acc.score ? item : acc));
        const scoreLimit = best.score * 1.25;
        const windowPoints = candidates.filter((item) => item.score <= scoreLimit);
        const minBy = (arr: typeof windowPoints, key: keyof (typeof windowPoints)[number]) =>
          Math.min(...arr.map((item) => item[key] as number));
        const maxBy = (arr: typeof windowPoints, key: keyof (typeof windowPoints)[number]) =>
          Math.max(...arr.map((item) => item[key] as number));
        summaries.recommended_run = best.runCode;
        summaries.recommended_screw_rpm = best.screw;
        summaries.recommended_mid_temp_c = best.midTemp;
        summaries.recommended_head_temp_c = best.headTemp;
        summaries.recommended_stabilization_time_min = best.stabilizationTime;
        summaries.recommended_mfr_g_10min = best.mfr;
        if (windowPoints.length) {
          summaries.window_screw_rpm_min = minBy(windowPoints, "screw");
          summaries.window_screw_rpm_max = maxBy(windowPoints, "screw");
          const validMid = windowPoints.filter((item) => Number.isFinite(item.midTemp as number));
          const validHead = windowPoints.filter((item) => Number.isFinite(item.headTemp as number));
          if (validMid.length) {
            summaries.window_mid_temp_c_min = minBy(validMid, "midTemp");
            summaries.window_mid_temp_c_max = maxBy(validMid, "midTemp");
          }
          if (validHead.length) {
            summaries.window_head_temp_c_min = minBy(validHead, "headTemp");
            summaries.window_head_temp_c_max = maxBy(validHead, "headTemp");
          }
        }
      }
    }
    if (stepNumber === 2) {
      const activeRows = runValues.filter((row) => row.run.exclude_from_analysis !== 1);
      const smeValues = activeRows
        .map((row) => numberFor(row.values, "SME_kJ_kg"))
        .filter((v): v is number => Number.isFinite(v));
      if (smeValues.length) {
        summaries.sme_min_kj_kg = Math.min(...smeValues);
        summaries.sme_max_kj_kg = Math.max(...smeValues);
        const sorted = [...smeValues].sort((a, b) => a - b);
        const quantile = (p: number) => {
          if (sorted.length === 1) return sorted[0];
          const idx = (sorted.length - 1) * p;
          const lo = Math.floor(idx);
          const hi = Math.ceil(idx);
          if (lo === hi) return sorted[lo];
          const frac = idx - lo;
          return sorted[lo] * (1 - frac) + sorted[hi] * frac;
        };
        const q1 = quantile(0.25);
        const q3 = quantile(0.75);
        const median = quantile(0.5);
        summaries.sme_median_kj_kg = median;

        const candidates = activeRows
          .map((row) => {
            const rpm = numberFor(row.values, "screw_rpm");
            const throughput = numberFor(row.values, "throughput_kg_h");
            const sme = numberFor(row.values, "SME_kJ_kg");
            const melt = numberFor(row.values, "melt_temp_c");
            if (rpm == null || throughput == null || sme == null) return null;
            return {
              runCode: row.run.run_code,
              rpm,
              throughput,
              sme,
              melt
            };
          })
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
        const windowCandidatesBase =
          sorted.length >= 4
            ? candidates.filter((item) => item.sme >= q1 && item.sme <= q3)
            : candidates;
        const windowCandidates = windowCandidatesBase.length ? windowCandidatesBase : candidates;
        const score = (item: (typeof candidates)[number]) => {
          const smeDrift = median !== 0 ? Math.abs((item.sme - median) / median) * 100 : Math.abs(item.sme - median);
          const meltPenalty = item.melt != null ? Math.max(item.melt, 0) * 0.001 : 0;
          return smeDrift + meltPenalty;
        };
        if (windowCandidates.length) {
          const best = windowCandidates.reduce((acc, item) => (score(item) < score(acc) ? item : acc));
          const minBy = (arr: typeof windowCandidates, key: keyof (typeof windowCandidates)[number]) =>
            Math.min(...arr.map((item) => item[key] as number));
          const maxBy = (arr: typeof windowCandidates, key: keyof (typeof windowCandidates)[number]) =>
            Math.max(...arr.map((item) => item[key] as number));

          summaries.recommended_run = best.runCode;
          summaries.recommended_screw_rpm = best.rpm;
          summaries.recommended_throughput_kg_h = best.throughput;
          summaries.recommended_sme_kj_kg = best.sme;
          summaries.recommended_melt_temp_c = best.melt;

          summaries.window_sme_min_kj_kg = minBy(windowCandidates, "sme");
          summaries.window_sme_max_kj_kg = maxBy(windowCandidates, "sme");
          summaries.window_screw_rpm_min = minBy(windowCandidates, "rpm");
          summaries.window_screw_rpm_max = maxBy(windowCandidates, "rpm");
          summaries.window_throughput_kg_h_min = minBy(windowCandidates, "throughput");
          summaries.window_throughput_kg_h_max = maxBy(windowCandidates, "throughput");
        }
      }
    }
    if (stepNumber === 3) {
      const activeRows = runValues.filter((row) => row.run.exclude_from_analysis !== 1);
      const points = activeRows
        .map((row) => {
          const melt = numberFor(row.values, "melt_temp_c");
          const mfr = numberFor(row.values, "MFR_g_10min");
          if (!Number.isFinite(melt as number) || !Number.isFinite(mfr as number)) return null;
          return {
            runCode: row.run.run_code,
            melt: melt as number,
            mfr: mfr as number
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (!points.length) return summaries;

      const mfrValues = points.map((item) => item.mfr).sort((a, b) => a - b);
      const mfrMedian = mfrValues[Math.floor(mfrValues.length / 2)];
      const mfrDeviationLimitPct = 20;
      const stable = points.filter((item) => {
        if (!Number.isFinite(mfrMedian) || mfrMedian === 0) return true;
        const driftPct = ((item.mfr - mfrMedian) / mfrMedian) * 100;
        return Math.abs(driftPct) <= mfrDeviationLimitPct;
      });
      const rising = points.filter((item) => {
        if (!Number.isFinite(mfrMedian) || mfrMedian === 0) return false;
        const driftPct = ((item.mfr - mfrMedian) / mfrMedian) * 100;
        return driftPct > mfrDeviationLimitPct;
      });
      const falling = points.filter((item) => {
        if (!Number.isFinite(mfrMedian) || mfrMedian === 0) return false;
        const driftPct = ((item.mfr - mfrMedian) / mfrMedian) * 100;
        return driftPct < -mfrDeviationLimitPct;
      });
      const windowPoints = stable.length ? stable : points;
      const recommended = windowPoints.reduce((acc, item) => {
        const scoreAcc = Math.abs(acc.mfr - mfrMedian);
        const scoreItem = Math.abs(item.mfr - mfrMedian);
        return scoreItem < scoreAcc ? item : acc;
      });

      const meltWindow = windowPoints.map((item) => item.melt);
      const mfrWindow = windowPoints.map((item) => item.mfr);
      summaries.recommended_run = recommended.runCode;
      summaries.recommended_melt_temp_c = recommended.melt;
      summaries.recommended_mfr_g_10min = recommended.mfr;
      summaries.melt_temp_min_c = Math.min(...meltWindow);
      summaries.melt_temp_max_c = Math.max(...meltWindow);
      summaries.mfr_avg_g_10min = mfrWindow.reduce((acc, value) => acc + value, 0) / mfrWindow.length;
      summaries.mfr_min_g_10min = Math.min(...mfrWindow);
      summaries.mfr_max_g_10min = Math.max(...mfrWindow);
      summaries.mfr_median_g_10min = mfrMedian;
      summaries.mfr_deviation_limit_pct = mfrDeviationLimitPct;
      summaries.mfr_rising_outlier_count = rising.length;
      summaries.mfr_falling_outlier_count = falling.length;
      summaries.mfr_stable_run_count = stable.length;
      summaries.mfr_unstable_flag = rising.length > 0 || falling.length > 0;
      summaries.mfr_interpretation =
        rising.length > 0
          ? "MFR spikes detected: possible degradation risk."
          : falling.length > 0
            ? "MFR drops detected: possible crosslinking/instability risk."
            : "MFR stable within deviation limit.";
    }
    if (stepNumber === 4) {
      const fillerVar = runValues
        .map((row) => numberFor(row.values, "filler_variation_pct"))
        .filter((v): v is number => Number.isFinite(v));
      if (fillerVar.length) {
        summaries.filler_variation_avg_pct =
          fillerVar.reduce((acc, value) => acc + value, 0) / fillerVar.length;
      }
    }
    if (stepNumber === 5) {
      const moisture = runValues
        .map((row) => numberFor(row.values, "pellet_moisture_pct"))
        .filter((v): v is number => Number.isFinite(v));
      if (moisture.length) {
        summaries.pellet_moisture_avg_pct =
          moisture.reduce((acc, value) => acc + value, 0) / moisture.length;
      }
    }
    if (stepNumber === 6) {
      const dispersionOk = runValues
        .map((row) => boolFor(row.values, "dispersion_ok"))
        .filter((v) => v === true || v === false);
      if (dispersionOk.length) {
        summaries.dispersion_pass_rate_pct =
          (dispersionOk.filter((v) => v).length / dispersionOk.length) * 100;
      }
    }
  }

  if (processTypeCode === "extrusion_v1") {
    const activeRows = runValues.filter((row) => row.run.exclude_from_analysis !== 1);
    const valuesFor = (code: string) => activeRows
      .map((row) => numberFor(row.values, code))
      .filter((value): value is number => Number.isFinite(value));
    const minMax = (prefix: string, values: number[]) => {
      if (!values.length) return;
      summaries[`${prefix}_min`] = Math.min(...values);
      summaries[`${prefix}_max`] = Math.max(...values);
    };
    if (stepNumber === 1) {
      const stableRows = activeRows.filter((row) =>
        boolFor(row.values, "rheology_pressure_stable") === true || boolFor(row.values, "point_stable") === true
      );
      const windowRows = stableRows.length ? stableRows : activeRows;
      const windowTemperatures = windowRows
        .map((row) => numberFor(row.values, "test_temp_c"))
        .filter((value): value is number => Number.isFinite(value));
      minMax("processing_temp_c", windowTemperatures);
      summaries.stable_point_count = stableRows.length;
      minMax("apparent_shear_rate_s", valuesFor("apparent_shear_rate_s"));
      minMax("apparent_viscosity_pa_s", valuesFor("apparent_viscosity_pa_s"));
      listQualStepOutputs(db, stepId).forEach((output) => {
        summaries[output.output_code] = output.value_real ?? output.value_text ?? null;
      });
    }
    if (stepNumber === 2) {
      const stableRows = activeRows.filter((row) => {
        const cv = numberFor(row.values, "feed_cv_pct");
        return cv != null && cv <= 1.5;
      });
      const stableThroughputs = stableRows
        .map((row) => numberFor(row.values, "mean_throughput_kg_h"))
        .filter((value): value is number => Number.isFinite(value));
      minMax("stable_throughput_kg_h", stableThroughputs);
      summaries.feed_cv_acceptance_pct = 1.5;
      summaries.stable_feeder_point_count = stableRows.length;
      if (feederCalibration) {
        summaries.feeder_calibration_formula = "Q = a·F + b";
        summaries.feeder_calibration_slope_kg_h_per_rpm = feederCalibration.slope;
        summaries.feeder_calibration_intercept_kg_h = feederCalibration.intercept;
        summaries.feeder_calibration_r_squared = feederCalibration.rSquared;
        summaries.feeder_calibration_point_count = feederCalibration.points.length;
        summaries.feeder_calibration_points = feederCalibration.points;
      }
      listQualStepOutputs(db, stepId).forEach((output) => {
        summaries[output.output_code] = output.value_real ?? output.value_text ?? null;
      });
    }
    if (stepNumber === 3) {
      const matrixRows = activeRows.filter((row) => row.run.run_group !== "pump_characteristic");
      const matrixValuesFor = (code: string) => matrixRows
        .map((row) => numberFor(row.values, code))
        .filter((value): value is number => Number.isFinite(value));
      minMax("specific_throughput_kg_h_rpm", matrixValuesFor("specific_throughput_kg_h_rpm"));
      minMax("motor_load_pct", matrixValuesFor("motor_load_pct"));
      minMax("melt_pressure_bar", matrixValuesFor("melt_pressure_bar"));
      minMax("throughput_kg_h", matrixValuesFor("throughput_kg_h"));
      let pressureLimit: number | null = null;
      let torqueLimit: number | null = null;
      let meltDensity: number | null = null;
      let referenceViscosity: number | null = null;
      let outletPressureBar = 0;
      try {
        const settings = JSON.parse(getQualStepSettings(db, experimentId, stepNumber) || "{}");
        pressureLimit = Number(settings.melt_pressure_limit_bar);
        torqueLimit = Number(settings.motor_torque_limit_nm);
        meltDensity = Number(settings.melt_density_kg_m3);
        referenceViscosity = Number(settings.reference_viscosity_pa_s);
        outletPressureBar = Number(settings.die_outlet_pressure_bar ?? 0);
        if (!Number.isFinite(pressureLimit) || pressureLimit! <= 0) pressureLimit = null;
        if (!Number.isFinite(torqueLimit) || torqueLimit! <= 0) torqueLimit = null;
        if (!Number.isFinite(meltDensity) || meltDensity! <= 0) meltDensity = null;
        if (!Number.isFinite(referenceViscosity) || referenceViscosity! <= 0) referenceViscosity = null;
        if (!Number.isFinite(outletPressureBar)) outletPressureBar = 0;
      } catch {}
      const accepted = matrixRows.filter((row) => {
        const stable = boolFor(row.values, "operating_point_stable");
        const pressure = numberFor(row.values, "melt_pressure_bar");
        const torque = numberFor(row.values, "motor_torque_nm");
        return stable === true && pressure != null && torque != null &&
          (pressureLimit == null || pressure <= pressureLimit) &&
          (torqueLimit == null || torque <= torqueLimit);
      });
      const acceptedSpeeds = accepted.map((row) => numberFor(row.values, "screw_speed_rpm")).filter((value): value is number => Number.isFinite(value));
      const acceptedThroughputs = accepted.map((row) => numberFor(row.values, "throughput_kg_h")).filter((value): value is number => Number.isFinite(value));
      minMax("operating_window_screw_rpm", acceptedSpeeds);
      minMax("operating_window_throughput_kg_h", acceptedThroughputs);
      summaries.accepted_operating_point_count = accepted.length;
      summaries.melt_pressure_limit_bar = pressureLimit;
      summaries.motor_torque_limit_nm = torqueLimit;
      summaries.accepted_operating_points = accepted.map((row) => ({
        run_code: row.run.run_code,
        screw_speed_rpm: numberFor(row.values, "screw_speed_rpm"),
        throughput_kg_h: numberFor(row.values, "throughput_kg_h")
      }));
      listQualStepOutputs(db, stepId).forEach((output) => {
        summaries[output.output_code] = output.value_real ?? output.value_text ?? null;
      });
      const pumpRows = activeRows.filter((row) => row.run.run_group === "pump_characteristic" && boolFor(row.values, "operating_point_stable") === true);
      const fitRows = pumpRows.map((row) => {
        const screwSpeed = numberFor(row.values, "screw_speed_rpm");
        const massThroughput = numberFor(row.values, "throughput_kg_h");
        const meltPressure = numberFor(row.values, "melt_pressure_bar");
        if (screwSpeed == null || massThroughput == null || meltPressure == null || !meltDensity || !referenceViscosity) return null;
        const volumeThroughput = massThroughput / (3600 * meltDensity);
        const pressureTerm = -((meltPressure - outletPressureBar) * 100000) / referenceViscosity;
        return { screwSpeed, massThroughput, meltPressure, volumeThroughput, pressureTerm };
      }).filter((row): row is { screwSpeed: number; massThroughput: number; meltPressure: number; volumeThroughput: number; pressureTerm: number } => row !== null);
      summaries.pump_characteristic_point_count = fitRows.length;
      summaries.pump_characteristic_formula = "Qv = A·N − B·ΔP/η";
      summaries.pump_characteristic_melt_density_kg_m3 = meltDensity;
      summaries.pump_characteristic_reference_viscosity_pa_s = referenceViscosity;
      summaries.pump_characteristic_outlet_pressure_bar = outletPressureBar;
      if (fitRows.length >= 3) {
        const s11 = fitRows.reduce((sum, row) => sum + row.screwSpeed ** 2, 0);
        const s22 = fitRows.reduce((sum, row) => sum + row.pressureTerm ** 2, 0);
        const s12 = fitRows.reduce((sum, row) => sum + row.screwSpeed * row.pressureTerm, 0);
        const t1 = fitRows.reduce((sum, row) => sum + row.screwSpeed * row.volumeThroughput, 0);
        const t2 = fitRows.reduce((sum, row) => sum + row.pressureTerm * row.volumeThroughput, 0);
        const determinant = s11 * s22 - s12 ** 2;
        if (Math.abs(determinant) > 1e-18) {
          const a = (t1 * s22 - t2 * s12) / determinant;
          const b = (s11 * t2 - s12 * t1) / determinant;
          const mean = fitRows.reduce((sum, row) => sum + row.volumeThroughput, 0) / fitRows.length;
          const residual = fitRows.reduce((sum, row) => sum + (row.volumeThroughput - (a * row.screwSpeed + b * row.pressureTerm)) ** 2, 0);
          const total = fitRows.reduce((sum, row) => sum + (row.volumeThroughput - mean) ** 2, 0);
          const rSquared = total > 0 ? 1 - residual / total : null;
          summaries.screw_pumping_a_m3_s_rpm = a;
          summaries.screw_pumping_b_m3 = b;
          summaries.screw_pumping_r_squared = rSquared;
          summaries.pump_characteristic_fit_valid = a > 0 && b > 0 && (rSquared == null || rSquared >= 0.8);
        }
      }
    }
    if (stepNumber === 4) {
      minMax("sme_kwh_kg", valuesFor("sme_kwh_kg"));
      minMax("melt_temp_c", valuesFor("melt_temp_c"));
      minMax("dissipative_temp_rise_c", valuesFor("dissipative_temp_rise_c"));
    }
    if (stepNumber === 5) {
      minMax("mean_residence_time_s", valuesFor("mean_residence_time_s"));
      minMax("degree_of_fill_pct", valuesFor("degree_of_fill_pct"));
      minMax("rtd_width_s", valuesFor("rtd_width_s"));
    }
    if (stepNumber === 6) {
      const stableRows = activeRows.filter((row) => boolFor(row.values, "no_powder_accumulation") === true);
      const stableSpeeds = stableRows.map((row) => numberFor(row.values, "side_feeder_speed_rpm")).filter((value): value is number => Number.isFinite(value));
      const stableFractions = stableRows.map((row) => numberFor(row.values, "filler_mass_fraction_pct")).filter((value): value is number => Number.isFinite(value));
      minMax("stable_side_feeder_speed_rpm", stableSpeeds);
      minMax("stable_filler_mass_fraction_pct", stableFractions);
      summaries.stable_side_feeder_point_count = stableRows.length;
    }
    if (stepNumber === 7) {
      const stableRows = activeRows.filter((row) => boolFor(row.values, "no_liquid_backflow") === true);
      const stableFractions = stableRows.map((row) => numberFor(row.values, "liquid_mass_fraction_pct")).filter((value): value is number => Number.isFinite(value));
      const stableMargins = stableRows.map((row) => numberFor(row.values, "injection_pressure_delta_bar")).filter((value): value is number => Number.isFinite(value));
      minMax("stable_liquid_mass_fraction_pct", stableFractions);
      minMax("stable_injection_pressure_delta_bar", stableMargins);
      summaries.stable_liquid_dosing_point_count = stableRows.length;
    }
    if (stepNumber === 8) {
      const stableRows = activeRows.filter((row) => boolFor(row.values, "vacuum_stable") === true);
      const residual = stableRows.map((row) => numberFor(row.values, "residual_volatiles_pct")).filter((value): value is number => Number.isFinite(value));
      const efficiencies = stableRows.map((row) => numberFor(row.values, "devolatilization_efficiency_pct")).filter((value): value is number => Number.isFinite(value));
      minMax("stable_residual_volatiles_pct", residual);
      minMax("stable_devolatilization_efficiency_pct", efficiencies);
      summaries.stable_vacuum_point_count = stableRows.length;
    }
    if (stepNumber === 9) {
      const stableRows = activeRows.filter((row) => boolFor(row.values, "reaction_stable") === true);
      const conversion = stableRows.map((row) => numberFor(row.values, "conversion_pct")).filter((value): value is number => Number.isFinite(value));
      const mfr = stableRows.map((row) => numberFor(row.values, "product_mfr_g_10min")).filter((value): value is number => Number.isFinite(value));
      minMax("stable_conversion_pct", conversion);
      minMax("stable_product_mfr_g_10min", mfr);
      summaries.stable_reaction_point_count = stableRows.length;
    }
    if (stepNumber === 10) {
      const stableRows = activeRows.filter((row) => boolFor(row.values, "scale_up_stable") === true);
      const speeds = stableRows.map((row) => numberFor(row.values, "production_screw_speed_rpm")).filter((value): value is number => Number.isFinite(value));
      const throughputs = stableRows.map((row) => numberFor(row.values, "production_throughput_kg_h")).filter((value): value is number => Number.isFinite(value));
      const parity = stableRows.map((row) => numberFor(row.values, "sme_parity_delta_pct")).filter((value): value is number => Number.isFinite(value));
      minMax("production_screw_speed_rpm", speeds);
      minMax("production_throughput_kg_h", throughputs);
      minMax("sme_parity_delta_pct", parity);
      summaries.stable_scale_up_point_count = stableRows.length;
    }
    if (stepNumber >= 6 && stepNumber <= 10) {
      listQualStepOutputs(db, stepId).forEach((output) => {
        summaries[output.output_code] = output.value_real ?? output.value_text ?? null;
      });
    }
  }

  if (processTypeCode === "coating") {
    if (stepNumber === 1) {
      const visc100 = runValues
        .map((row) => numberFor(row.values, "viscosity_100s"))
        .filter((v): v is number => Number.isFinite(v));
      if (visc100.length) {
        summaries.viscosity_100s_avg_mpas =
          visc100.reduce((acc, value) => acc + value, 0) / visc100.length;
      }
    }
    if (stepNumber === 2) {
      const angle = runValues
        .map((row) => numberFor(row.values, "water_contact_angle_deg"))
        .filter((v): v is number => Number.isFinite(v));
      if (angle.length) {
        summaries.contact_angle_avg_deg =
          angle.reduce((acc, value) => acc + value, 0) / angle.length;
      }
    }
    if (stepNumber === 3) {
      const coatWeight = runValues
        .map((row) => numberFor(row.values, "coat_weight_g_m2"))
        .filter((v): v is number => Number.isFinite(v));
      if (coatWeight.length) {
        summaries.coat_weight_avg_g_m2 =
          coatWeight.reduce((acc, value) => acc + value, 0) / coatWeight.length;
      }
    }
    if (stepNumber === 4) {
      const defectFree = runValues
        .map((row) => {
          const field = fieldByCode.get("defect_tags");
          if (!field) return null;
          const raw = row.values.get(field.id)?.value_tags_json;
          if (!raw) return true;
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.length === 0 : true;
          } catch {
            return null;
          }
        })
        .filter((v): v is boolean => v === true || v === false);
      if (defectFree.length) {
        summaries.defect_free_rate_pct =
          (defectFree.filter((v) => v).length / defectFree.length) * 100;
      }
    }
    if (stepNumber === 5) {
      const adhesionPass = runValues
        .map((row) => boolOrNullFor(row.values, "adhesion_pass"))
        .filter((v): v is boolean => v === true || v === false);
      if (adhesionPass.length) {
        summaries.adhesion_pass_rate_pct =
          (adhesionPass.filter((v) => v).length / adhesionPass.length) * 100;
      }
    }
    if (stepNumber === 6) {
      const barrierPass = runValues
        .map((row) => boolOrNullFor(row.values, "barrier_pass"))
        .filter((v): v is boolean => v === true || v === false);
      if (barrierPass.length) {
        summaries.barrier_pass_rate_pct =
          (barrierPass.filter((v) => v).length / barrierPass.length) * 100;
      }
    }
  }

  return summaries;
}

export function getStepDefinition(stepNumber: number) {
  return injectionStepDefinitions.find((step) => step.step_number === stepNumber) ?? null;
}
