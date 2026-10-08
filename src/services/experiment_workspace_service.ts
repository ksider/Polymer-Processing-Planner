import type { Db } from "../db.js";
import { getExperiment, getExperimentRecipes } from "../repos/experiments_repo.js";
import { getRecipeComponents, listRecipes } from "../repos/recipes_repo.js";
import { getMachine } from "../repos/machines_repo.js";
import { listDoeStudies } from "../repos/doe_repo.js";
import { listQualFields, listQualSteps, listQualSummaries } from "../repos/qual_repo.js";
import { listReportConfigs } from "../repos/reports_repo.js";
import { listExperimentAnalysisFields } from "../repos/analysis_repo.js";
import { listTasksByExperiment } from "../repos/tasks_repo.js";

type WorkspaceStageStatus = "blocked" | "done" | "in_progress" | "not_started";

/**
 * The workspace tree is deliberately a read model. It represents project
 * entities, not every row of operational data; individual runs belong in the
 * schedule and their owning stage/DOE screens, not in the navigation tree.
 */
export function buildExperimentWorkspace(db: Db, experimentId: number) {
  const experiment = getExperiment(db, experimentId);
  if (!experiment) return null;

  const completedSteps = new Set(listQualSummaries(db, experimentId).map((row) => row.step_number));
  const qualificationCards = listQualSteps(db, experimentId).map((step) => {
    const rawStatus = step.status || "DRAFT";
    const status: WorkspaceStageStatus =
      step.is_blocked === 1 || rawStatus === "BLOCKED"
        ? "blocked"
        : completedSteps.has(step.step_number) || rawStatus === "DONE"
          ? "done"
          : rawStatus === "RUNNING"
            ? "in_progress"
            : "not_started";
    return {
      id: step.id,
      stepNumber: step.step_number,
      name: step.title || `Step ${step.step_number}`,
      status,
      fields: listQualFields(db, step.id)
        .filter((field) => field.is_enabled === 1)
        .map((field) => ({ id: field.id, label: field.label, unit: field.unit || null }))
    };
  });

  const recipeNameById = new Map(listRecipes(db).map((recipe) => [recipe.id, recipe.name]));
  const recipeLinks = getExperimentRecipes(db, experimentId)
    .map((id) => ({
      id,
      name: recipeNameById.get(id),
      components: getRecipeComponents(db, id).map((component) => ({
        label: component.component_name,
        phr: component.phr
      }))
    }))
    .filter((recipe): recipe is { id: number; name: string; components: Array<{ label: string; phr: number }> } => Boolean(recipe.name));

  const doeStudies = listDoeStudies(db, experimentId).map((doe) => ({
    ...doe,
    analysisFields: listExperimentAnalysisFields(db, doe.id)
      .filter((field) => field.is_active === 1)
      .map((field) => ({ id: field.id, label: field.label, unit: field.unit || null }))
  }));

  return {
    experiment,
    qualificationCards,
    doeStudies,
    reports: listReportConfigs(db, experimentId),
    tasks: listTasksByExperiment(db, experimentId).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status
    })),
    selectedMachine: experiment.machine_id ? getMachine(db, experiment.machine_id) : null,
    recipeLinks
  };
}
