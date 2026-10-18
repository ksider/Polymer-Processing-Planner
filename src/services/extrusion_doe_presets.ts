import type { Db } from "../db.js";
import { upsertCanonicalParamDefinition } from "../repos/params_repo.js";
import { listQualSteps, listQualSummaries } from "../repos/qual_repo.js";

export type ExtrusionDoePreset = {
  code: string;
  title: string;
  summary: string;
  designType: "SCREEN" | "BBD" | "CCD";
  centerPoints: number;
  maxRuns: number;
  factors: Array<{ code: string; mode: "RANGE" | "LIST"; min?: number; max?: number; list?: number[]; levels: number }>;
  fixedConditions: Array<{ code: string; value: number }>;
  responseCodes: string[];
  requiredSteps: number[];
  safetyGates: string[];
  followUp?: string;
};

export const extrusionDoePresets: ExtrusionDoePreset[] = [
  {
    code: "filled_mineral_dispersion_screening",
    title: "Filled mineral dispersion with coupling agent",
    summary: "Initial 11-run screening of shear, throughput, temperature and coupling-agent level before a reviewed BBD optimisation.",
    designType: "SCREEN",
    centerPoints: 3,
    maxRuns: 11,
    factors: [
      { code: "screw_speed_rpm", mode: "RANGE", min: 150, max: 400, levels: 2 },
      { code: "planned_throughput_kg_h", mode: "RANGE", min: 20, max: 60, levels: 2 },
      { code: "barrel_set_temp_c", mode: "RANGE", min: 160, max: 210, levels: 2 },
      { code: "coupling_agent_wt_pct", mode: "RANGE", min: 0.5, max: 2, levels: 2 }
    ],
    fixedConditions: [
      { code: "vacuum_target_pressure_mbar", value: 200 }
    ],
    responseCodes: [
      "motor_torque_nm", "melt_pressure_bar", "melt_temp_c", "sme_kwh_kg",
      "complex_viscosity_pa_s", "tensile_strength_mpa", "mfr_g_10min"
    ],
    requiredSteps: [1, 2, 3, 4],
    safetyGates: ["Motor load ≤ 85% of the qualified limit", "Melt pressure ≤ 120 bar", "Melt temperature ≤ 230 °C"],
    followUp: "After screening review, create a separate three-factor BBD using the retained factors."
  },
  {
    code: "pa_glass_fibre_ccd",
    title: "PA / chopped glass-fibre reinforcement",
    summary: "Face-centred CCD for fibre-preserving processing: screw speed, total throughput and fibre-feed-zone temperature.",
    designType: "CCD",
    centerPoints: 4,
    maxRuns: 18,
    factors: [
      { code: "screw_speed_rpm", mode: "RANGE", min: 100, max: 260, levels: 3 },
      { code: "throughput_kg_h", mode: "RANGE", min: 30, max: 80, levels: 3 },
      { code: "fibre_feed_zone_temp_c", mode: "RANGE", min: 250, max: 280, levels: 3 }
    ],
    fixedConditions: [
      { code: "glass_fibre_loading_wt_pct", value: 30 }
    ],
    responseCodes: [
      "motor_torque_nm", "melt_pressure_bar", "melt_temp_c", "fibre_number_average_length_um",
      "charpy_impact_strength_kj_m2", "flexural_modulus_gpa"
    ],
    requiredSteps: [1, 2, 3, 4, 5, 6],
    safetyGates: ["Side-feeder torque ≤ 70% of its qualified limit", "Melt temperature ≤ 295 °C", "Material moisture must meet the PA drying specification"]
  },
  {
    code: "pp_g_mah_reactive_bbd",
    title: "PP-g-MAH reactive extrusion and vacuum devolatilisation",
    summary: "Three-factor BBD for reaction-zone temperature, screw speed and DCP concentration with RTD and vacuum evidence.",
    designType: "BBD",
    centerPoints: 3,
    maxRuns: 15,
    factors: [
      { code: "reaction_temp_c", mode: "RANGE", min: 180, max: 220, levels: 3 },
      { code: "screw_speed_rpm", mode: "RANGE", min: 150, max: 350, levels: 3 },
      { code: "dcp_peroxide_wt_pct", mode: "RANGE", min: 0.05, max: 0.25, levels: 3 }
    ],
    fixedConditions: [
      { code: "throughput_kg_h", value: 30 },
      { code: "maleic_anhydride_wt_pct", value: 1.5 },
      { code: "vacuum_pressure_mbar", value: 50 }
    ],
    responseCodes: [
      "motor_torque_nm", "melt_temp_c", "conversion_pct", "product_mfr_g_10min", "residual_free_mah_ppm"
    ],
    requiredSteps: [1, 2, 3, 5, 8, 9],
    safetyGates: ["Damköhler number ≥ 3", "Mean residence time must be ≥ 3 × initiator half-life", "Melt seal before the vacuum port must remain intact"]
  }
];

const presetParameters = [
  { code: "coupling_agent_wt_pct", label: "Coupling agent concentration", unit: "wt.%", fieldKind: "INPUT" as const, role: "factor" as const, tags: ["extrusion", "filler", "coupling-agent"] },
  { code: "fibre_feed_zone_temp_c", label: "Fibre feed-zone temperature", unit: "°C", fieldKind: "INPUT" as const, role: "factor" as const, tags: ["extrusion", "fibre", "temperature"] },
  { code: "glass_fibre_loading_wt_pct", label: "Glass-fibre loading", unit: "wt.%", fieldKind: "INPUT" as const, role: "constraint" as const, tags: ["extrusion", "fibre", "formulation"] },
  { code: "dcp_peroxide_wt_pct", label: "DCP concentration", unit: "wt.%", fieldKind: "INPUT" as const, role: "factor" as const, tags: ["extrusion", "reactive", "initiator"] },
  { code: "maleic_anhydride_wt_pct", label: "Maleic anhydride concentration", unit: "wt.%", fieldKind: "INPUT" as const, role: "constraint" as const, tags: ["extrusion", "reactive", "formulation"] },
  { code: "complex_viscosity_pa_s", label: "Complex viscosity", unit: "Pa·s", fieldKind: "OUTPUT" as const, role: "response" as const, tags: ["extrusion", "rheology", "offline"] },
  { code: "tensile_strength_mpa", label: "Tensile strength", unit: "MPa", fieldKind: "OUTPUT" as const, role: "response" as const, tags: ["extrusion", "mechanical", "offline"] },
  { code: "fibre_number_average_length_um", label: "Number-average fibre length", unit: "µm", fieldKind: "OUTPUT" as const, role: "response" as const, tags: ["extrusion", "fibre", "offline"] },
  { code: "charpy_impact_strength_kj_m2", label: "Notched Charpy impact strength", unit: "kJ/m²", fieldKind: "OUTPUT" as const, role: "response" as const, tags: ["extrusion", "mechanical", "offline"] },
  { code: "flexural_modulus_gpa", label: "Flexural modulus", unit: "GPa", fieldKind: "OUTPUT" as const, role: "response" as const, tags: ["extrusion", "mechanical", "offline"] },
  { code: "residual_free_mah_ppm", label: "Residual free MAH", unit: "ppm", fieldKind: "OUTPUT" as const, role: "response" as const, tags: ["extrusion", "reactive", "offline"] }
];

export function ensureExtrusionDoePresetCatalogue(db: Db) {
  for (const param of presetParameters) {
    upsertCanonicalParamDefinition(db, {
      code: param.code,
      label: param.label,
      unit: param.unit,
      field_kind: param.fieldKind,
      field_type: "number",
      group_label: "Extrusion DOE",
      allowed_values_json: null,
      semantic_role: param.fieldKind === "INPUT" ? "controlled" : "response",
      doe_role: param.role,
      is_code_owned: 1,
      process_type_codes: ["extrusion_v1"],
      tags: [...param.tags, "doe-preset"]
    });
  }
}

export function getExtrusionDoePreset(code: string) {
  return extrusionDoePresets.find((preset) => preset.code === code);
}

export function getExtrusionPresetPrerequisiteWarnings(db: Db, experimentId: number, preset: ExtrusionDoePreset) {
  const steps = new Map(listQualSteps(db, experimentId).map((step) => [step.step_number, step]));
  const summarySteps = new Set(listQualSummaries(db, experimentId).map((summary) => summary.step_number));
  return preset.requiredSteps.flatMap((stepNumber) => {
    const step = steps.get(stepNumber);
    if (!step) return [`Step ${stepNumber} is not available in this experiment.`];
    if (step.is_active !== 1) return [`Step ${stepNumber} (${step.title}) is not enabled.`];
    if (step.is_blocked === 1 || step.status === "BLOCKED") return [`Step ${stepNumber} (${step.title}) is blocked.`];
    if (!summarySteps.has(stepNumber)) return [`Step ${stepNumber} (${step.title}) has no saved result yet.`];
    return [];
  });
}
