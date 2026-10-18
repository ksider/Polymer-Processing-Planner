import type { Db } from "../db.js";
import type { ParamConfig, ParamDefinition } from "../repos/params_repo.js";
import { listQualStepOutputs, listQualSteps } from "../repos/qual_repo.js";

type ConstraintKind = "minimum" | "maximum" | "quality_gate";

export type ExtrusionQualificationConstraint = {
  kind: ConstraintKind;
  source_step_number: number;
  source_step_title: string;
  source_output_code: string;
  source_label: string;
  unit: string | null;
  value: number;
  target_param_code: string | null;
  description: string;
};

export type ExtrusionQualificationConstraintSnapshot = {
  version: 1;
  captured_at: string;
  constraints: ExtrusionQualificationConstraint[];
};

type ConstraintMapping = Omit<ExtrusionQualificationConstraint, "source_step_number" | "source_step_title" | "value">;

/* Only explicit output-to-input links become range constraints. Contextual
 * results are preserved as quality gates instead of being guessed into a DOE factor. */
const mappingsByOutputCode: Record<string, ConstraintMapping[]> = {
  processing_temp_min_c: [{ kind: "minimum", source_output_code: "processing_temp_min_c", source_label: "Minimum processing temperature", unit: "°C", target_param_code: "barrel_set_temp_c", description: "DOE barrel set temperature must not be below the qualified processing minimum." }],
  processing_temp_max_c: [{ kind: "maximum", source_output_code: "processing_temp_max_c", source_label: "Maximum processing temperature", unit: "°C", target_param_code: "barrel_set_temp_c", description: "DOE barrel set temperature must not exceed the qualified processing maximum." }],
  feeder_stable_throughput_min_kg_h: [{ kind: "minimum", source_output_code: "feeder_stable_throughput_min_kg_h", source_label: "Minimum stable throughput", unit: "kg/h", target_param_code: "planned_throughput_kg_h", description: "DOE throughput must remain inside the qualified feeder range." }],
  feeder_stable_throughput_max_kg_h: [{ kind: "maximum", source_output_code: "feeder_stable_throughput_max_kg_h", source_label: "Maximum stable throughput", unit: "kg/h", target_param_code: "planned_throughput_kg_h", description: "DOE throughput must remain inside the qualified feeder range." }],
  operating_window_min_screw_rpm: [{ kind: "minimum", source_output_code: "operating_window_min_screw_rpm", source_label: "Minimum accepted screw speed", unit: "rpm", target_param_code: "screw_speed_rpm", description: "DOE screw speed must remain inside the qualified operating window." }],
  operating_window_max_screw_rpm: [{ kind: "maximum", source_output_code: "operating_window_max_screw_rpm", source_label: "Maximum accepted screw speed", unit: "rpm", target_param_code: "screw_speed_rpm", description: "DOE screw speed must remain inside the qualified operating window." }],
  operating_window_max_throughput_kg_h: [{ kind: "maximum", source_output_code: "operating_window_max_throughput_kg_h", source_label: "Maximum accepted throughput", unit: "kg/h", target_param_code: "planned_throughput_kg_h", description: "DOE throughput must not exceed the accepted pressure-and-torque operating window." }],
  max_thermal_hold_min: [{ kind: "quality_gate", source_output_code: "max_thermal_hold_min", source_label: "Maximum thermal hold", unit: "min", target_param_code: null, description: "Keep the planned thermal hold at or below this qualified limit." }],
  rtd_mean_residence_time_s: [{ kind: "quality_gate", source_output_code: "rtd_mean_residence_time_s", source_label: "Selected mean residence time", unit: "s", target_param_code: null, description: "Review residence time against this qualified RTD reference when planning the DOE." }],
  filler_mass_fraction_max_pct: [{ kind: "quality_gate", source_output_code: "filler_mass_fraction_max_pct", source_label: "Maximum accepted filler mass fraction", unit: "%", target_param_code: null, description: "Do not exceed this qualified filler fraction without a new side-feeding qualification." }],
  liquid_mass_fraction_max_pct: [{ kind: "quality_gate", source_output_code: "liquid_mass_fraction_max_pct", source_label: "Maximum stable liquid fraction", unit: "%", target_param_code: null, description: "Do not exceed this qualified liquid fraction without a new injection qualification." }],
  required_vacuum_pressure_mbar: [{ kind: "maximum", source_output_code: "required_vacuum_pressure_mbar", source_label: "Required vacuum pressure", unit: "mbar", target_param_code: "vacuum_target_pressure_mbar", description: "DOE vacuum pressure is absolute pressure and must not exceed this qualified maximum." }],
  max_throughput_without_vent_stuffing_kg_h: [{ kind: "quality_gate", source_output_code: "max_throughput_without_vent_stuffing_kg_h", source_label: "Maximum throughput without vent stuffing", unit: "kg/h", target_param_code: null, description: "Review vent-stuffing evidence before using throughput above this value." }],
  reactive_temp_min_c: [{ kind: "minimum", source_output_code: "reactive_temp_min_c", source_label: "Minimum accepted reaction temperature", unit: "°C", target_param_code: "reaction_temp_c", description: "DOE reaction-zone temperature must remain inside the qualified reaction window." }],
  reactive_temp_max_c: [{ kind: "maximum", source_output_code: "reactive_temp_max_c", source_label: "Maximum accepted reaction temperature", unit: "°C", target_param_code: "reaction_temp_c", description: "DOE reaction-zone temperature must remain inside the qualified reaction window." }],
  reactive_min_residence_time_s: [{ kind: "quality_gate", source_output_code: "reactive_min_residence_time_s", source_label: "Minimum REX residence time", unit: "s", target_param_code: null, description: "Confirm every DOE condition retains at least this reactive-extrusion residence time." }]
};

export function captureExtrusionQualificationConstraints(db: Db, experimentId: number): ExtrusionQualificationConstraintSnapshot {
  const constraints: ExtrusionQualificationConstraint[] = [];
  for (const step of listQualSteps(db, experimentId)) {
    if (step.is_active !== 1 || step.is_blocked === 1) continue;
    for (const output of listQualStepOutputs(db, step.id)) {
      if (!Number.isFinite(output.value_real)) continue;
      for (const mapping of mappingsByOutputCode[output.output_code] ?? []) {
        constraints.push({ ...mapping, source_step_number: step.step_number, source_step_title: step.title, value: output.value_real! });
      }
    }
  }
  return { version: 1, captured_at: new Date().toISOString(), constraints };
}

export function getExtrusionQualificationConstraintSnapshot(metadata: Record<string, unknown>): ExtrusionQualificationConstraintSnapshot | null {
  const value = metadata.extrusion_qualification_constraints;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<ExtrusionQualificationConstraintSnapshot>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.constraints)) return null;
  return snapshot as ExtrusionQualificationConstraintSnapshot;
}

export function validateExtrusionDoeConstraints(configs: ParamConfig[], inputParams: ParamDefinition[], snapshot: ExtrusionQualificationConstraintSnapshot | null): string[] {
  if (!snapshot) return [];
  const parameterById = new Map(inputParams.map((param) => [param.id, param]));
  const errors: string[] = [];
  for (const constraint of snapshot.constraints) {
    if (!constraint.target_param_code || constraint.kind === "quality_gate") continue;
    const config = configs.find((item) => item.active === 1 && parameterById.get(item.param_def_id)?.code === constraint.target_param_code);
    if (!config) continue;
    const levels = configLevels(config);
    if (!levels.length) continue;
    const offending = constraint.kind === "minimum" ? Math.min(...levels) < constraint.value : Math.max(...levels) > constraint.value;
    if (!offending) continue;
    const parameter = parameterById.get(config.param_def_id);
    const comparison = constraint.kind === "minimum" ? "below" : "above";
    const boundary = constraint.kind === "minimum" ? "minimum" : "maximum";
    errors.push(`${parameter?.label ?? constraint.target_param_code} has a level ${comparison} the qualification ${boundary} of ${constraint.value}${constraint.unit ? ` ${constraint.unit}` : ""} (Step ${constraint.source_step_number}: ${constraint.source_label}).`);
  }
  return errors;
}

function configLevels(config: ParamConfig): number[] {
  if (config.mode === "FIXED") return Number.isFinite(config.fixed_value_real) ? [config.fixed_value_real!] : [];
  if (config.mode === "RANGE") return [config.range_min_real, config.range_max_real].filter((value): value is number => Number.isFinite(value));
  if (!config.list_json) return [];
  try {
    const values = JSON.parse(config.list_json);
    return Array.isArray(values) ? values.filter((value): value is number => Number.isFinite(value)) : [];
  } catch {
    return [];
  }
}
