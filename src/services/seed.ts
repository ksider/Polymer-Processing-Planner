import type { Db } from "../db.js";
import { createParamDefinition } from "../repos/params_repo.js";

const DEFECT_TAGS = [
  "sticking",
  "flash",
  "short shot",
  "overheating",
  "bubbles",
  "warpage",
  "sink",
  "brittle",
  "poor surface",
  "demold damage"
];

type SeedParam = {
  code: string;
  label: string;
  unit: string | null;
  field_kind: "INPUT" | "OUTPUT";
  field_type: "number" | "text" | "tag";
  group_label: string;
  allowed_values_json?: string | null;
};

const SEED_PARAMS: SeedParam[] = [
  { code: "moisture_pct", label: "Moisture", unit: "%", field_kind: "INPUT", field_type: "number", group_label: "Material" },
  { code: "density_g_cm3", label: "Density", unit: "g/cm3", field_kind: "INPUT", field_type: "number", group_label: "Material" },
  { code: "mold_temp", label: "Mold Temp", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Mold" },
  { code: "cooling_time", label: "Cooling Time", unit: "s", field_kind: "INPUT", field_type: "number", group_label: "Mold" },
  { code: "nozzle_temp", label: "Nozzle Temp", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Barrel" },
  { code: "barrel_zone1", label: "Barrel Zone 1", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Barrel" },
  { code: "barrel_zone2", label: "Barrel Zone 2", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Barrel" },
  { code: "barrel_zone3", label: "Barrel Zone 3", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Barrel" },
  { code: "barrel_zone4", label: "Barrel Zone 4", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Barrel" },
  { code: "barrel_zone5", label: "Barrel Zone 5", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Barrel" },
  { code: "inj_speed", label: "Injection Speed", unit: "cm3/s", field_kind: "INPUT", field_type: "number", group_label: "Fill" },
  { code: "inj_press_limit", label: "Injection Pressure Limit", unit: "bar", field_kind: "INPUT", field_type: "number", group_label: "Fill" },
  { code: "v_to_p_transfer", label: "V-to-P Transfer", unit: "%", field_kind: "INPUT", field_type: "number", group_label: "Fill" },
  { code: "shot_size", label: "Shot Size", unit: "mm", field_kind: "INPUT", field_type: "number", group_label: "Fill" },
  { code: "cushion_target", label: "Cushion Target", unit: "mm", field_kind: "INPUT", field_type: "number", group_label: "Fill" },
  { code: "pack_press", label: "Pack Pressure", unit: "bar", field_kind: "INPUT", field_type: "number", group_label: "Pack/Hold" },
  { code: "pack_time", label: "Pack Time", unit: "s", field_kind: "INPUT", field_type: "number", group_label: "Pack/Hold" },
  { code: "hold_press", label: "Hold Pressure", unit: "bar", field_kind: "INPUT", field_type: "number", group_label: "Pack/Hold" },
  { code: "hold_time", label: "Hold Time", unit: "s", field_kind: "INPUT", field_type: "number", group_label: "Pack/Hold" },
  { code: "screw_rpm", label: "Screw RPM", unit: "rpm", field_kind: "INPUT", field_type: "number", group_label: "Screw" },
  { code: "back_pressure", label: "Back Pressure", unit: "bar", field_kind: "INPUT", field_type: "number", group_label: "Screw" },
  { code: "decompression", label: "Decompression", unit: "mm", field_kind: "INPUT", field_type: "number", group_label: "Screw" },
  { code: "recovery_time", label: "Recovery Time", unit: "s", field_kind: "INPUT", field_type: "number", group_label: "Screw" },
  { code: "clamp_tonnage", label: "Clamp Tonnage", unit: "t", field_kind: "INPUT", field_type: "number", group_label: "Clamp" },
  { code: "melt_temp", label: "Melt Temp", unit: "C", field_kind: "OUTPUT", field_type: "number", group_label: "Outputs" },
  { code: "fill_time", label: "Fill Time", unit: "s", field_kind: "OUTPUT", field_type: "number", group_label: "Outputs" },
  { code: "peak_inj_pressure", label: "Peak Injection Pressure", unit: "bar", field_kind: "OUTPUT", field_type: "number", group_label: "Outputs" },
  { code: "intensification_coeff", label: "Intensification Coefficient", unit: "ratio", field_kind: "INPUT", field_type: "number", group_label: "Machine" },
  { code: "part_weight", label: "Part Weight", unit: "g", field_kind: "OUTPUT", field_type: "number", group_label: "Outputs" },
  { code: "cycle_time", label: "Cycle Time", unit: "s", field_kind: "OUTPUT", field_type: "number", group_label: "Outputs" },
  {
    code: "defects",
    label: "Defects",
    unit: null,
    field_kind: "OUTPUT",
    field_type: "tag",
    group_label: "Defects",
    allowed_values_json: JSON.stringify(DEFECT_TAGS)
  },
  { code: "throughput_kg_h", label: "Throughput", unit: "kg/h", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "screw_rpm", label: "Screw RPM", unit: "rpm", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "head_temp_c", label: "Head Temp", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "mid_temp_c", label: "Mid Barrel Temp", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "feed_ratio_filler_pct", label: "Feed Ratio Filler", unit: "%", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "vacuum_mbar", label: "Vacuum", unit: "mbar", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "die_temp_c", label: "Die Temp", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "side_feeder_rpm", label: "Side Feeder RPM", unit: "rpm", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "water_injection_g_min", label: "Water Injection", unit: "g/min", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "moisture_target_pct", label: "Moisture Target", unit: "%", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "vent_on", label: "Vent On", unit: "0/1", field_kind: "INPUT", field_type: "number", group_label: "Compounding" },
  { code: "torque_pct", label: "Torque", unit: "%", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "motor_current_a", label: "Motor Current", unit: "A", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "melt_temp_c", label: "Melt Temp", unit: "C", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "die_pressure_bar", label: "Die Pressure", unit: "bar", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "SME_kJ_kg", label: "SME", unit: "kJ/kg", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "strand_stability_score", label: "Strand Stability Score", unit: "1-5", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  {
    code: "defect_tags",
    label: "Defect Tags",
    unit: null,
    field_kind: "OUTPUT",
    field_type: "tag",
    group_label: "Compounding Outputs",
    allowed_values_json: JSON.stringify([
      "surging",
      "die_drool",
      "strand_break",
      "agglomerates",
      "foaming",
      "odor",
      "streaks",
      "pinholes",
      "orange_peel",
      "cracking",
      "blocking",
      "delamination"
    ])
  },
  { code: "pellet_moisture_pct", label: "Pellet Moisture", unit: "%", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "MFR_g_10min", label: "MFR", unit: "g/10min", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "viscosity_proxy", label: "Viscosity Proxy", unit: "rel", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "bulk_density_g_cm3", label: "Bulk Density", unit: "g/cm3", field_kind: "OUTPUT", field_type: "number", group_label: "Compounding Outputs" },
  { code: "solids_pct", label: "Solids", unit: "%", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  { code: "coating_speed_m_min", label: "Coating Speed", unit: "m/min", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  { code: "wet_film_thickness_um", label: "Wet Film Thickness", unit: "um", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  { code: "flow_rate_ml_min", label: "Flow Rate", unit: "ml/min", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  { code: "drying_temp_C", label: "Drying Temp", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  { code: "drying_time_s", label: "Drying Time", unit: "s", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  { code: "oven_dwell_s", label: "Oven Dwell", unit: "s", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  { code: "coating_temp_C", label: "Coating Temp", unit: "C", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  { code: "humidity_pct", label: "Humidity", unit: "%RH", field_kind: "INPUT", field_type: "number", group_label: "Coating" },
  {
    code: "substrate_surface_treatment",
    label: "Surface Treatment",
    unit: null,
    field_kind: "INPUT",
    field_type: "tag",
    group_label: "Coating",
    allowed_values_json: JSON.stringify(["none", "corona", "plasma"])
  },
  { code: "coat_weight_g_m2", label: "Coat Weight", unit: "g/m2", field_kind: "OUTPUT", field_type: "number", group_label: "Coating Outputs" },
  { code: "dry_thickness_um", label: "Dry Thickness", unit: "um", field_kind: "OUTPUT", field_type: "number", group_label: "Coating Outputs" },
  { code: "adhesion_score", label: "Adhesion Score", unit: "N/25mm", field_kind: "OUTPUT", field_type: "number", group_label: "Coating Outputs" },
  {
    code: "defect_tags",
    label: "Defect Tags",
    unit: null,
    field_kind: "OUTPUT",
    field_type: "tag",
    group_label: "Coating Outputs",
    allowed_values_json: JSON.stringify(["streaks", "pinholes", "orange_peel", "cracking", "blocking", "delamination"])
  },
  { code: "water_contact_angle_deg", label: "Water Contact Angle", unit: "deg", field_kind: "OUTPUT", field_type: "number", group_label: "Coating Outputs" },
  { code: "WVTR_g_m2_day", label: "WVTR", unit: "g/m2/day", field_kind: "OUTPUT", field_type: "number", group_label: "Coating Outputs" },
  { code: "OTR_cc_m2_day", label: "OTR", unit: "cc/m2/day", field_kind: "OUTPUT", field_type: "number", group_label: "Coating Outputs" }
];

export function ensureSeedParams(db: Db) {
  const existingRows = db
    .prepare("SELECT code FROM param_definitions WHERE scope = 'GLOBAL'")
    .all() as Array<{ code: string }>;
  const existingSet = new Set(existingRows.map((row) => row.code));

  for (const param of SEED_PARAMS) {
    if (existingSet.has(param.code)) continue;
    createParamDefinition(db, {
      scope: "GLOBAL",
      experiment_id: null,
      code: param.code,
      label: param.label,
      unit: param.unit,
      field_kind: param.field_kind,
      field_type: param.field_type,
      group_label: param.group_label,
      allowed_values_json: param.allowed_values_json ?? null
    });
  }
}

export const DEFAULT_INPUT_VALUES: Record<string, number> = {
  moisture_pct: 0.1,
  density_g_cm3: 1.0,
  mold_temp: 60,
  cooling_time: 18,
  nozzle_temp: 220,
  barrel_zone1: 210,
  barrel_zone2: 220,
  barrel_zone3: 230,
  barrel_zone4: 235,
  barrel_zone5: 235,
  inj_speed: 60,
  inj_press_limit: 800,
  v_to_p_transfer: 95,
  shot_size: 50,
  cushion_target: 5,
  pack_press: 500,
  pack_time: 6,
  hold_press: 450,
  hold_time: 10,
  screw_rpm: 120,
  back_pressure: 20,
  decompression: 2,
  recovery_time: 8,
  clamp_tonnage: 80
};
