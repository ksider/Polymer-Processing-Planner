import type { Db } from "../db.js";
import {
  listExperimentsForUserWithMeta,
  listExperimentsWithMeta,
  type ExperimentListRow
} from "../repos/experiments_repo.js";
import { isDemoUser } from "./demo_mode.js";

export type WorkspaceExperimentScope = {
  experiments: ExperimentListRow[];
  experimentIds: number[];
  processIds: number[];
};

/**
 * The single read boundary for upcoming global workspaces. Callers may narrow
 * this list, but must never query a user-supplied experiment id outside it.
 */
export function listWorkspaceExperimentScope(db: Db, user: Express.User): WorkspaceExperimentScope {
  const experiments = user.role === "admin" || user.role === "manager" || isDemoUser(user)
    ? listExperimentsWithMeta(db, false)
    : listExperimentsForUserWithMeta(db, user.id, false);
  return {
    experiments,
    experimentIds: experiments.map((experiment) => experiment.id),
    processIds: Array.from(new Set(experiments.map((experiment) => Number(experiment.process_id)).filter((id) => Number.isFinite(id) && id > 0)))
  };
}

export function narrowWorkspaceScope(scope: WorkspaceExperimentScope, filter: { processId?: number | null; experimentId?: number | null }): WorkspaceExperimentScope {
  const experiments = scope.experiments.filter((experiment) => {
    if (filter.processId && Number(experiment.process_id) !== filter.processId) return false;
    if (filter.experimentId && experiment.id !== filter.experimentId) return false;
    return true;
  });
  return {
    experiments,
    experimentIds: experiments.map((experiment) => experiment.id),
    processIds: Array.from(new Set(experiments.map((experiment) => Number(experiment.process_id)).filter((id) => Number.isFinite(id) && id > 0)))
  };
}
