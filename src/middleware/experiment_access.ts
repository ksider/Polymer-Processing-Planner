import type { Db } from "../db.js";
import type { Request, Response, NextFunction } from "express";
import { getExperiment } from "../repos/experiments_repo.js";
import { getReportConfig } from "../repos/reports_repo.js";
import { getRun } from "../repos/runs_repo.js";
import { hasActiveAssignmentForExperiment } from "../repos/entity_assignments_repo.js";
import { isProcessOwner } from "../repos/processes_repo.js";

export function ensureExperimentAccess(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const experimentId = Number(req.params.id);
    if (!Number.isFinite(experimentId)) {
      return res.status(404).send("Experiment not found");
    }
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");

    if (canAccessExperiment(db, req.user, experimentId, experiment)) return next();
    return res.status(403).send("Forbidden");
  };
}

export function ensureReportAccess(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const reportId = Number(req.params.reportId);
    if (!Number.isFinite(reportId)) return res.status(404).send("Report not found");
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    const experiment = getExperiment(db, config.experiment_id);
    if (!experiment) return res.status(404).send("Experiment not found");
    if (canAccessExperiment(db, req.user, config.experiment_id, experiment)) return next();
    return res.status(403).send("Forbidden");
  };
}

export function ensureRunAccess(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const runId = Number(req.params.id);
    if (!Number.isFinite(runId)) return res.status(404).send("Run not found");
    const run = getRun(db, runId);
    if (!run) return res.status(404).send("Run not found");
    const experiment = getExperiment(db, run.experiment_id);
    if (!experiment) return res.status(404).send("Experiment not found");
    if (canAccessExperiment(db, req.user, run.experiment_id, experiment)) return next();
    return res.status(403).send("Forbidden");
  };
}

function canAccessExperiment(
  db: Db,
  user: Express.User | undefined,
  experimentId: number,
  experiment: { owner_user_id: number | null; process_id?: number | null }
) {
  if (user?.role === "admin") return true;
  if (user?.role === "manager") return true;
  if (experiment.owner_user_id == null) return true;
  if (user?.id === experiment.owner_user_id) return true;
  if (user?.id && Number.isFinite(Number(experiment.process_id || 0))) {
    if (isProcessOwner(db, Number(experiment.process_id), user.id)) return true;
  }
  if (!user?.id) return false;
  return hasActiveAssignmentForExperiment(db, experimentId, user.id);
}
