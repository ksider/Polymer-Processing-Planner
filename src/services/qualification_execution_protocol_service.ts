import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { getMachine } from "../repos/machines_repo.js";
import { getParamDefinition } from "../repos/params_repo.js";
import { getProcessById } from "../repos/processes_repo.js";
import {
  getQualStep,
  listQualFields,
  listQualRuns,
  listQualRunValues,
  type QualField,
  type QualRun,
  type QualRunValue
} from "../repos/qual_repo.js";
import { getQualificationStudyGuide } from "./qualification_guides.js";
import {
  ExecutionProtocolError,
  type ExecutionProtocol,
  type ExecutionProtocolField,
  type ExecutionProtocolLayout,
  type ExecutionProtocolRun,
  type ExecutionProtocolSection,
  type ExecutionProtocolValueMode
} from "./execution_protocol_types.js";
import { formatProtocolStoredValue } from "./execution_protocol_values.js";

export type QualificationProtocolOptions = {
  layout: ExecutionProtocolLayout;
  values: ExecutionProtocolValueMode;
  includeInstructions: boolean;
};

export function buildQualificationExecutionProtocol(
  db: Db,
  experimentId: number,
  stepNumber: number,
  options: QualificationProtocolOptions,
  generatedAt = new Date().toISOString()
): ExecutionProtocol {
  const experiment = getExperiment(db, experimentId);
  if (!experiment) throw new ExecutionProtocolError("Experiment not found", 404);
  const step = getQualStep(db, experimentId, stepNumber);
  if (!step || step.is_active !== 1) throw new ExecutionProtocolError("Qualification step not found", 404);
  const runs = listQualRuns(db, step.id);
  if (runs.length === 0) {
    throw new ExecutionProtocolError("Add or generate qualification runs before creating a protocol.", 409);
  }

  const process = experiment.process_id ? getProcessById(db, experiment.process_id) : null;
  const processTypeCode = String(process?.process_type_code || "injection").toLowerCase();
  const fields = listQualFields(db, step.id).filter((field) => field.is_enabled === 1);
  const fieldRoles = new Map(fields.map((field) => {
    const param = field.param_def_id ? getParamDefinition(db, field.param_def_id) : undefined;
    const role = field.is_derived === 1
      ? "calculated"
      : param?.field_kind === "INPUT" || param?.semantic_role === "controlled"
        ? "planned"
        : "recorded";
    return [field.id, role] as const;
  }));
  const plannedFields = fields.filter((field) => fieldRoles.get(field.id) === "planned");
  const recordedFields = fields.filter((field) => fieldRoles.get(field.id) === "recorded");
  const calculatedFields = fields.filter((field) => fieldRoles.get(field.id) === "calculated");
  const valuesByRun = new Map<number, Map<number, QualRunValue>>();
  for (const run of runs) {
    valuesByRun.set(run.id, new Map(listQualRunValues(db, run.id).map((value) => [value.field_id, value])));
  }

  const protocolRuns = runs.map((run) => {
    const values = valuesByRun.get(run.id) ?? new Map<number, QualRunValue>();
    return {
      runCode: run.run_code,
      runOrder: run.run_order,
      referenceValue: humanizeRunGroup(run.run_group),
      plannedValues: valuesForFields(plannedFields, values, true),
      recordedValues: valuesForFields(recordedFields, values, options.values === "current"),
      calculatedValues: valuesForFields(calculatedFields, values, options.values === "current")
    };
  });
  const sections = buildQualificationProtocolSections({
    processTypeCode,
    stepNumber,
    stepTitle: step.title,
    fields,
    fieldRoles,
    runs,
    protocolRuns
  });
  const fieldsByKey = new Map(fields.map((field) => [fieldKey(field), field]));
  const missingPlannedValueCount = sections.reduce((sectionCount, section) =>
    sectionCount + section.runs.reduce((runCount, run) =>
      runCount + section.plannedFields.filter((field) =>
        fieldsByKey.get(field.key)?.required === 1 && !run.plannedValues[field.key]
      ).length, 0), 0);
  const warnings: string[] = [];
  if (missingPlannedValueCount > 0) {
    warnings.push(
      `${missingPlannedValueCount} required planned value${missingPlannedValueCount === 1 ? " is" : "s are"} missing. Complete the run plan before execution.`
    );
  }
  const revisionFingerprint = createHash("sha256")
    .update(JSON.stringify({
      experiment: experiment.name,
      stage: { number: step.step_number, code: step.stage_code, title: step.title },
      plannedFields: plannedFields.map(fingerprintField),
      recordedFields: recordedFields.map(fingerprintField),
      calculatedFields: calculatedFields.map(fingerprintField),
      runs: protocolRuns.map((run) => ({
        runCode: run.runCode,
        runOrder: run.runOrder,
        referenceValue: run.referenceValue,
        plannedValues: run.plannedValues
      })),
      sections: sections.map((section) => ({
        key: section.key,
        fields: [...section.plannedFields, ...section.recordedFields, ...section.calculatedFields].map((field) => field.key),
        runs: section.runs.map((run) => run.runCode)
      }))
    }))
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  const guide = options.includeInstructions
    ? getQualificationStudyGuide(processTypeCode, stepNumber)
    : null;

  return {
    protocolTitle: "Qualification execution protocol",
    experimentName: experiment.name,
    entityName: `Step ${step.step_number}: ${step.title}`,
    descriptorLabel: "Stage",
    descriptorValue: step.stage_code,
    processName: process?.name ?? null,
    machineName: experiment.machine_id ? getMachine(db, experiment.machine_id)?.name ?? null : null,
    runReferenceLabel: "Run group",
    generatedAt,
    revisionFingerprint,
    plannedFields: plannedFields.map(protocolField),
    recordedFields: recordedFields.map(protocolField),
    calculatedFields: calculatedFields.map(protocolField),
    runs: protocolRuns,
    sections,
    recipes: [],
    referenceSections: guide
      ? [
          { title: "Goal", paragraphs: [guide.goal] },
          { title: "Procedure", items: guide.procedure },
          { title: "Handoff", paragraphs: [guide.handoff] },
          { title: "References", paragraphs: [guide.references] }
        ]
      : [],
    missingPlannedValueCount,
    isDraft: missingPlannedValueCount > 0,
    warnings
  };
}

type QualificationSectionProfile = {
  key: string;
  title: string;
  description?: string;
  runGroups?: string[];
  excludeRunGroups?: string[];
  fieldCodes?: string[];
};

type QualificationSectionInput = {
  processTypeCode: string;
  stepNumber: number;
  stepTitle: string;
  fields: QualField[];
  fieldRoles: Map<number, "planned" | "recorded" | "calculated">;
  runs: QualRun[];
  protocolRuns: ExecutionProtocolRun[];
};

/** Mirrors the programme blocks shown on a qualification step. A step can
 * therefore print several independent execution tables instead of flattening
 * unrelated studies into one generated matrix. */
export function buildQualificationProtocolSections(input: QualificationSectionInput): ExecutionProtocolSection[] {
  const profiles = qualificationSectionProfiles(input.processTypeCode, input.stepNumber, input.stepTitle, input.runs);
  const coveredRunIds = new Set<number>();
  const sections = profiles.flatMap((profile): ExecutionProtocolSection[] => {
    const matchingRuns = input.runs.filter((run) =>
      (!profile.runGroups || profile.runGroups.includes(run.run_group)) &&
      (!profile.excludeRunGroups || !profile.excludeRunGroups.includes(run.run_group))
    );
    if (!matchingRuns.length) return [];
    matchingRuns.forEach((run) => coveredRunIds.add(run.id));
    const matchingCodes = profile.fieldCodes ? new Set(profile.fieldCodes) : null;
    const sectionFields = matchingCodes
      ? profile.fieldCodes!.flatMap((code) => input.fields.find((field) => field.code === code) ?? [])
      : input.fields;
    const protocolRunsByCode = new Map(input.protocolRuns.map((run) => [run.runCode, run]));
    return [{
      key: profile.key,
      title: profile.title,
      description: profile.description,
      runReferenceLabel: "",
      plannedFields: fieldsForRole(sectionFields, input.fieldRoles, "planned"),
      recordedFields: fieldsForRole(sectionFields, input.fieldRoles, "recorded"),
      calculatedFields: fieldsForRole(sectionFields, input.fieldRoles, "calculated"),
      runs: matchingRuns.flatMap((run) => protocolRunsByCode.get(run.run_code) ?? [])
    }];
  });

  const remainingGroups = new Map<string, QualRun[]>();
  input.runs.filter((run) => !coveredRunIds.has(run.id)).forEach((run) => {
    const groupRuns = remainingGroups.get(run.run_group) ?? [];
    groupRuns.push(run);
    remainingGroups.set(run.run_group, groupRuns);
  });
  const protocolRunsByCode = new Map(input.protocolRuns.map((run) => [run.runCode, run]));
  for (const [group, groupRuns] of remainingGroups) {
    sections.push({
      key: `qualification-${input.stepNumber}-${group}`,
      title: profiles.length || remainingGroups.size > 1 ? humanizeRunGroup(group) : input.stepTitle,
      runReferenceLabel: "",
      plannedFields: fieldsForRole(input.fields, input.fieldRoles, "planned"),
      recordedFields: fieldsForRole(input.fields, input.fieldRoles, "recorded"),
      calculatedFields: fieldsForRole(input.fields, input.fieldRoles, "calculated"),
      runs: groupRuns.flatMap((run) => protocolRunsByCode.get(run.run_code) ?? [])
    });
  }
  return sections;
}

function fieldsForRole(
  fields: QualField[],
  roles: Map<number, "planned" | "recorded" | "calculated">,
  role: "planned" | "recorded" | "calculated"
) {
  return fields.filter((field) => roles.get(field.id) === role).map(protocolField);
}

function qualificationSectionProfiles(
  processTypeCode: string,
  stepNumber: number,
  stepTitle: string,
  runs: QualRun[]
): QualificationSectionProfile[] {
  if (processTypeCode !== "extrusion_v1") {
    const groups = [...new Set(runs.map((run) => run.run_group))];
    return groups.length > 1
      ? groups.map((group) => ({ key: `${processTypeCode}-${stepNumber}-${group}`, title: humanizeRunGroup(group), runGroups: [group] }))
      : [{ key: `${processTypeCode}-${stepNumber}`, title: stepTitle }];
  }
  if (stepNumber === 1) return [
    {
      key: "extrusion-rheology", title: "Capillary rheometry", runGroups: ["rheology"],
      description: "One row is one steady-state rheometer point.",
      fieldCodes: ["test_temp_c", "pressure_drop_pa", "capillary_diameter_mm", "capillary_length_mm", "volumetric_flow_mm3_s", "extrudate_mass_g", "collection_time_s", "rheology_pressure_stable", "apparent_shear_rate_s", "apparent_viscosity_pa_s", "mfr_g_10min"]
    },
    {
      key: "extrusion-thermal-hold", title: "Thermal-hold stability", runGroups: ["thermal_hold"],
      description: "Repeat at fixed temperature and shear rate for each hold duration.",
      fieldCodes: ["thermal_hold_temp_c", "thermal_hold_time_min", "thermal_hold_shear_rate_s", "thermal_hold_viscosity_pa_s"]
    },
    { key: "extrusion-dsc", title: "DSC heating / cooling", runGroups: ["dsc"], fieldCodes: [], description: "Record the instrument file and any execution deviation for this test." },
    { key: "extrusion-tga", title: "TGA thermogram", runGroups: ["tga"], fieldCodes: [], description: "Record the instrument file and any execution deviation for this test." }
  ];
  if (stepNumber === 3) return [
    {
      key: "extrusion-operating-window", title: "Operating-point matrix", excludeRunGroups: ["pump_characteristic"],
      fieldCodes: ["screw_speed_rpm", "throughput_kg_h", "motor_torque_nm", "motor_torque_limit_nm", "melt_pressure_bar", "melt_temp_c", "operating_point_stable", "specific_throughput_kg_h_rpm", "motor_load_pct"]
    },
    {
      key: "extrusion-pump-characteristic", title: "Screw pumping characteristic", runGroups: ["pump_characteristic"],
      fieldCodes: ["screw_speed_rpm", "throughput_kg_h", "motor_torque_nm", "melt_pressure_bar", "target_back_pressure_bar", "melt_temp_c", "operating_point_stable", "specific_throughput_kg_h_rpm", "motor_load_pct"]
    }
  ];
  if (stepNumber === 6) return [
    {
      key: "extrusion-feeder-stability", title: "Feeder-stability programme", runGroups: ["feeder_stability", "side_feeding"],
      fieldCodes: ["main_screw_speed_rpm", "matrix_throughput_kg_h", "side_feeder_speed_rpm", "filler_throughput_kg_h", "side_feeder_torque_nm", "side_feeder_throughput_cv_pct", "injection_port_pressure_bar", "no_powder_accumulation", "filler_mass_fraction_pct"]
    },
    { key: "extrusion-material-incorporation", title: "Material-incorporation programme", runGroups: ["particulate_filler", "fiber_retention"] }
  ];
  if (stepNumber === 7) return [
    {
      key: "extrusion-liquid-calibration", title: "Liquid-pump calibration", runGroups: ["liquid_pump_calibration"],
      fieldCodes: ["liquid_target_throughput_kg_h", "liquid_throughput_kg_h", "liquid_throughput_cv_pct", "liquid_throughput_error_pct"]
    },
    {
      key: "extrusion-liquid-injection", title: "Liquid melt-injection verification", runGroups: ["liquid_melt_injection", "liquid_dosing"],
      fieldCodes: ["screw_speed_rpm", "polymer_throughput_kg_h", "liquid_target_throughput_kg_h", "liquid_throughput_kg_h", "liquid_throughput_cv_pct", "injection_pressure_bar", "barrel_pressure_bar", "motor_torque_nm", "no_liquid_backflow", "no_liquid_leak", "liquid_mass_fraction_pct", "injection_pressure_delta_bar", "liquid_throughput_error_pct"]
    }
  ];
  if (stepNumber === 8) return [
    {
      key: "extrusion-vacuum-calibration", title: "Vacuum calibration", runGroups: ["vacuum_calibration", "devolatilization"],
      fieldCodes: ["vacuum_target_pressure_mbar", "vacuum_pressure_mbar", "residual_volatiles_pct", "trap_carryover_g", "vacuum_stable", "no_vent_foam_or_stuffing", "devolatilization_efficiency_pct"]
    },
    {
      key: "extrusion-vacuum-capacity", title: "Throughput verification at selected vacuum", runGroups: ["vacuum_capacity"],
      fieldCodes: ["devol_target_throughput_kg_h", "screw_speed_rpm", "throughput_kg_h", "vacuum_pressure_mbar", "residual_volatiles_pct", "trap_carryover_g", "vacuum_stable", "no_vent_foam_or_stuffing", "devolatilization_efficiency_pct"]
    }
  ];
  const groups = [...new Set(runs.map((run) => run.run_group))];
  return groups.length > 1
    ? groups.map((group) => ({ key: `extrusion-${stepNumber}-${group}`, title: humanizeRunGroup(group), runGroups: [group] }))
    : [{ key: `extrusion-${stepNumber}`, title: stepTitle }];
}

function fieldKey(field: QualField) {
  return `qualification:${field.code}`;
}

function protocolField(field: QualField): ExecutionProtocolField {
  return {
    key: fieldKey(field),
    label: field.label,
    unit: field.unit,
    fieldType: field.field_type
  };
}

function fingerprintField(field: QualField) {
  return {
    key: fieldKey(field),
    label: field.label,
    unit: field.unit,
    type: field.field_type,
    required: field.required === 1
  };
}

function valuesForFields(
  fields: QualField[],
  values: Map<number, QualRunValue>,
  includeValues: boolean
) {
  const result: Record<string, string> = {};
  for (const field of fields) {
    result[fieldKey(field)] = includeValues
      ? formatProtocolStoredValue(values.get(field.id), field.field_type)
      : "";
  }
  return result;
}

function humanizeRunGroup(value: string) {
  const normalized = String(value || "default").replace(/[_-]+/g, " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Default";
}
