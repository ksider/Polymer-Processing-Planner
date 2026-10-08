import type { TaskEntityRow, TaskStatus } from "../repos/tasks_repo.js";

const SIGNATURE_WEIGHT_MULTIPLIER = 2;

// Qualification stage effort is declared by the code-owned catalogue later.
// Never infer it from a visible stage number: stage row ids are not ordinals.
export function getDefaultEntityWeight(entityType: string, _entityId: number): number {
  if (entityType === "qualification_step") {
    return 1;
  }
  if (entityType === "doe") {
    return 4;
  }
  if (entityType === "report") {
    return 2;
  }
  return 1;
}

type ProgressSummary = {
  totalWeight: number;
  completedWeight: number;
  percent: number;
};

// Compute progress for a task based on its linked entities.
// This does not write to DB; callers decide how to persist status.
export function computeTaskProgress(entities: TaskEntityRow[]): ProgressSummary {
  const totalWeight = entities.reduce((acc, entity) => acc + effectiveWeight(entity), 0);
  const completedWeight = entities.reduce(
    (acc, entity) => acc + effectiveWeight(entity) * entityProgress(entity),
    0
  );
  const percent = totalWeight > 0 ? Math.min(1, completedWeight / totalWeight) : 0;
  return {
    totalWeight,
    completedWeight,
    percent
  };
}

// Suggested overall status given progress. Caller decides if overrides are needed.
export function suggestTaskStatus(progress: ProgressSummary): TaskStatus {
  if (progress.percent >= 1) return "done";
  if (progress.percent > 0) return "in_progress";
  return "init";
}

// Apply domain rules for Qualification/DOE tasks. Stage dependencies belong to
// the qualification catalogue; task closure must not reinterpret a stage row id
// as a globally meaningful step number.
export function canCloseTask(entities: TaskEntityRow[]): boolean {
  const hasReport = entities.some((e) => e.entity_type === "report");
  const reportSigned = entities.some(
    (e) => e.entity_type === "report" && e.signature_required && e.signature_at
  );

  const hasDoe = entities.some((e) => e.entity_type === "doe");
  if (hasDoe) {
    // DOE must have report + signature to close.
    if (!(hasReport && reportSigned)) return false;
  }

  return true;
}

// Suggested status considering domain rules.
export function suggestTaskStatusWithRules(
  entities: TaskEntityRow[],
  progress: ProgressSummary
): TaskStatus {
  const base = suggestTaskStatus(progress);
  if (base === "done" && !canCloseTask(entities)) {
    return "in_progress";
  }
  return base;
}

function effectiveWeight(entity: TaskEntityRow): number {
  // Signature increases weight for entities that require it.
  if (entity.signature_required && entity.signature_at) {
    return entity.weight * SIGNATURE_WEIGHT_MULTIPLIER;
  }
  return entity.weight;
}

function entityProgress(entity: TaskEntityRow): number {
  if (entity.progress_mode === "toggle") {
    return entity.status === "done" ? 1 : 0;
  }
  // milestone mode: init -> 0, in_progress -> 0.5, done -> 1, failed -> 0
  switch (entity.status) {
    case "done":
      return 1;
    case "in_progress":
      return 0.5;
    case "failed":
      return 0;
    case "init":
    default:
      return 0;
  }
}
