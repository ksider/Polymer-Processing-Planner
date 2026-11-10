import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { getDoeStudy } from "../repos/doe_repo.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { getMachine } from "../repos/machines_repo.js";
import { listActiveAnalysisFields, listAnalysisRunValuesByRunIds, type AnalysisField } from "../repos/analysis_repo.js";
import {
  listParamConfigs,
  listParamDefinitionsByKindForProcess,
  type ParamDefinition
} from "../repos/params_repo.js";
import { getProcessById } from "../repos/processes_repo.js";
import { getRecipe, getRecipeComponents } from "../repos/recipes_repo.js";
import { listRuns, listRunValues, type RunValue } from "../repos/runs_repo.js";
import { ExecutionProtocolError } from "./execution_protocol_types.js";
import type {
  ExecutionProtocol,
  ExecutionProtocolField,
  ExecutionProtocolLayout,
  ExecutionProtocolRecipe,
  ExecutionProtocolRun,
  ExecutionProtocolValueMode
} from "./execution_protocol_types.js";
import { formatProtocolStoredValue } from "./execution_protocol_values.js";

export type DoeProtocolLayout = ExecutionProtocolLayout;
export type DoeProtocolValueMode = ExecutionProtocolValueMode;

export type DoeProtocolOptions = {
  layout: DoeProtocolLayout;
  values: DoeProtocolValueMode;
  includeRecipes: boolean;
};

export type DoeProtocolField = ExecutionProtocolField;
export type DoeProtocolRecipe = ExecutionProtocolRecipe;
export type DoeProtocolRun = ExecutionProtocolRun;
export type DoeExecutionProtocol = ExecutionProtocol;

export { ExecutionProtocolError as DoeProtocolError };

export function buildDoeExecutionProtocol(
  db: Db,
  experimentId: number,
  doeId: number,
  options: DoeProtocolOptions,
  generatedAt = new Date().toISOString()
): DoeExecutionProtocol {
  const experiment = getExperiment(db, experimentId);
  if (!experiment) throw new ExecutionProtocolError("Experiment not found", 404);
  const doe = getDoeStudy(db, doeId);
  if (!doe || doe.experiment_id !== experimentId) {
    throw new ExecutionProtocolError("DOE not found", 404);
  }

  const runs = listRuns(db, doeId);
  if (runs.length === 0) {
    throw new ExecutionProtocolError("Generate DOE runs before creating a protocol.", 409);
  }

  const process = experiment.process_id ? getProcessById(db, experiment.process_id) : null;
  const processTypeCode = String(process?.process_type_code || "injection").toLowerCase();
  const configs = listParamConfigs(db, experimentId, doeId);
  const activeParamIds = new Set(
    configs.filter((config) => config.active === 1).map((config) => config.param_def_id)
  );
  const plannedParams = listParamDefinitionsByKindForProcess(
    db,
    experimentId,
    "INPUT",
    processTypeCode
  ).filter((param) =>
    activeParamIds.has(param.id) && (processTypeCode !== "sla_dlp" || param.doe_role === "factor")
  );
  const recordedFields = listActiveAnalysisFields(db, doeId);
  const runValues = new Map<number, Map<number, RunValue>>();
  for (const run of runs) {
    runValues.set(run.id, new Map(listRunValues(db, run.id).map((value) => [value.param_def_id, value])));
  }
  const analysisValues = listAnalysisRunValuesByRunIds(db, runs.map((run) => run.id));
  const analysisValueMap = new Map(
    analysisValues.map((value) => [`${value.run_id}:${value.field_id}`, value])
  );

  const recipeIds = [...new Set(runs.map((run) => run.recipe_id).filter((id): id is number => id != null))];
  const recipesById = new Map(recipeIds.map((id) => [id, getRecipe(db, id)]));
  const protocolRuns: DoeProtocolRun[] = runs.map((run) => {
    const valuesForRun = runValues.get(run.id) ?? new Map<number, RunValue>();
    const plannedValues: Record<string, string> = {};
    for (const param of plannedParams) {
      plannedValues[paramKey(param)] = formatProtocolStoredValue(valuesForRun.get(param.id), param.field_type);
    }
    const currentValues: Record<string, string> = {};
    for (const field of recordedFields) {
      const direct = analysisValueMap.get(`${run.id}:${field.id}`);
      const fallback = field.param_def_id ? valuesForRun.get(field.param_def_id) : undefined;
      currentValues[fieldKey(field)] = options.values === "current"
        ? formatProtocolStoredValue(direct ?? fallback, field.field_type)
        : "";
    }
    return {
      runCode: run.run_code,
      runOrder: run.run_order,
      referenceValue: run.recipe_id ? recipesById.get(run.recipe_id)?.name ?? null : null,
      plannedValues,
      recordedValues: currentValues,
      calculatedValues: {}
    };
  });

  const missingPlannedValueCount = protocolRuns.reduce(
    (count, run) => count + plannedParams.filter((param) => !run.plannedValues[paramKey(param)]).length,
    0
  );
  const warnings: string[] = [];
  if (missingPlannedValueCount > 0) {
    warnings.push(
      `${missingPlannedValueCount} planned value${missingPlannedValueCount === 1 ? " is" : "s are"} missing. Complete the run plan before execution.`
    );
  }

  const revisionFingerprint = createHash("sha256")
    .update(JSON.stringify({
      experiment: experiment.name,
      doe: { name: doe.name, designType: doe.design_type },
      plannedFields: plannedParams.map((param) => ({
        key: paramKey(param), label: param.label, unit: param.unit, type: param.field_type
      })),
      recordedFields: recordedFields.map((field) => ({
        key: fieldKey(field), label: field.label, unit: field.unit, type: field.field_type
      })),
      runs: protocolRuns.map((run) => ({
        runCode: run.runCode,
        runOrder: run.runOrder,
        referenceValue: run.referenceValue,
        plannedValues: run.plannedValues
      }))
    }))
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();

  const protocolFields = {
    plannedFields: plannedParams.map(protocolParamField),
    recordedFields: recordedFields.map(protocolAnalysisField),
    calculatedFields: [] as ExecutionProtocolField[]
  };
  return {
    protocolTitle: "DOE execution protocol",
    experimentName: experiment.name,
    entityName: doe.name,
    descriptorLabel: "Design",
    descriptorValue: doe.design_type,
    processName: process?.name ?? null,
    machineName: experiment.machine_id ? getMachine(db, experiment.machine_id)?.name ?? null : null,
    runReferenceLabel: "Recipe",
    generatedAt,
    revisionFingerprint,
    ...protocolFields,
    runs: protocolRuns,
    sections: [{
      key: "doe-runs",
      title: "Run matrix",
      runReferenceLabel: "Recipe",
      ...protocolFields,
      runs: protocolRuns
    }],
    recipes: options.includeRecipes
      ? recipeIds.flatMap((id) => {
          const recipe = recipesById.get(id);
          if (!recipe) return [];
          return [{
            name: recipe.name,
            description: recipe.description,
            components: getRecipeComponents(db, id).map((component) => ({
              name: component.component_name,
              phr: component.phr
            }))
          }];
        })
      : [],
    referenceSections: [],
    missingPlannedValueCount,
    isDraft: missingPlannedValueCount > 0,
    warnings
  };
}

function paramKey(param: ParamDefinition) {
  return `input:${param.code}`;
}

function fieldKey(field: AnalysisField) {
  return `response:${field.code}`;
}

function protocolParamField(param: ParamDefinition): DoeProtocolField {
  return {
    key: paramKey(param),
    label: param.label,
    unit: param.unit,
    fieldType: param.field_type
  };
}

function protocolAnalysisField(field: AnalysisField): DoeProtocolField {
  return {
    key: fieldKey(field),
    label: field.label,
    unit: field.unit,
    fieldType: field.field_type
  };
}
