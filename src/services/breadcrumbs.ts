import type { Request } from "express";
import type { Db } from "../db.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { getDoeStudy } from "../repos/doe_repo.js";
import { getReportConfig } from "../repos/reports_repo.js";
import { getMachine } from "../repos/machines_repo.js";
import { getRecipe } from "../repos/recipes_repo.js";
import { findUserById } from "../repos/users_repo.js";
import { getRun } from "../repos/runs_repo.js";
import { getProcessById, getProcessByRouteCode, getProcessRouteCode } from "../repos/processes_repo.js";

export type Breadcrumb = {
  label: string;
  href?: string;
};

export function buildBreadcrumbs(db: Db, req: Request): Breadcrumb[] {
  const path = req.path;
  if (!path || path.startsWith("/auth")) return [];
  const segments = path.split("/").filter(Boolean);
  const crumbs: Breadcrumb[] = [];
  if (segments.length === 0) return crumbs;

  const push = (label: string, href?: string) => {
    crumbs.push(href ? { label, href } : { label });
  };
  const experimentHref = (experiment: { id: number; process_id?: number | null } | null | undefined) => {
    if (!experiment?.id) return "/experiments/new";
    const process = experiment.process_id ? getProcessById(db, experiment.process_id) : null;
    const processCode = getProcessRouteCode(process);
    return processCode ? `/${processCode}/${experiment.id}` : `/experiments/${experiment.id}`;
  };
  const pushProcessPath = (processId: number | null | undefined) => {
    push("Processes", "/");
    if (!processId || !Number.isFinite(processId)) return;
    const process = getProcessById(db, processId);
    const processCode = getProcessRouteCode(process);
    push(process?.name ?? `Process ${processId}`, processCode ? `/${processCode}` : `/?process_id=${processId}`);
  };
  const pushExperimentTrail = (experimentId: number, suffixSegments: string[]) => {
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return false;
    pushProcessPath(experiment.process_id);
    const expLabel = experiment?.name ?? `Experiment ${experimentId}`;
    push(expLabel, experimentHref(experiment));
    const second = suffixSegments[0];
    if (second === "qualification") {
      // Qualification overview page is removed: keep title without link.
      push("Qualification");
      const step = Number(suffixSegments[1]);
      if (Number.isFinite(step)) {
        push(`Step ${step}`, `${experimentHref(experiment)}/qualification/${step}`);
      }
      return true;
    }
    if (second === "journal") {
      push("Lab Journal", `${experimentHref(experiment)}/journal`);
      return true;
    }
    if (second === "doe") {
      const doeId = Number(suffixSegments[1]);
      if (Number.isFinite(doeId)) {
        const doe = getDoeStudy(db, doeId);
        const doeLabel = doe?.name ?? `DOE ${doeId}`;
        push(doeLabel, `${experimentHref(experiment)}/doe/${doeId}`);
        const tab = typeof req.query.tab === "string" ? req.query.tab : "";
        if (tab === "design") push("Design", req.originalUrl);
        if (tab === "runs") push("Runs", req.originalUrl);
        if (tab === "analysis") push("Analysis", req.originalUrl);
      }
      return true;
    }
    if (second === "runs") {
      const runId = Number(suffixSegments[1]);
      if (Number.isFinite(runId)) {
        const run = getRun(db, runId);
        if (run) {
          if (run.doe_id) {
            const doe = getDoeStudy(db, run.doe_id);
            const doeLabel = doe?.name ?? `DOE ${run.doe_id}`;
            push(doeLabel, `${experimentHref(experiment)}/doe/${run.doe_id}`);
          }
          push(run.run_code || `Run ${run.id}`, `${experimentHref(experiment)}/runs/${run.id}`);
        } else {
          push(`Run ${runId}`, `${experimentHref(experiment)}/runs/${runId}`);
        }
      }
      return true;
    }
    return true;
  };

  const first = segments[0];
  if (segments.length === 1) {
    const process = getProcessByRouteCode(db, first);
    if (process) {
      push("Processes", "/");
      const processCode = getProcessRouteCode(process);
      push(process.name, processCode ? `/${processCode}` : "/");
      return crumbs;
    }
  }
  if (segments.length >= 2) {
    const process = getProcessByRouteCode(db, first);
    const experimentId = Number(segments[1]);
    if (process && Number.isFinite(experimentId)) {
      const experiment = getExperiment(db, experimentId);
      if (experiment && Number(experiment.process_id || 0) === process.id) {
        pushExperimentTrail(experimentId, segments.slice(2));
        return crumbs;
      }
    }
  }
  if (first === "my-experiments") {
    push("My Experiments", "/my-experiments");
    return crumbs;
  }
  if (first === "recipes") {
    push("Recipes", "/recipes");
    return crumbs;
  }
  if (first === "processes") {
    push("Processes", "/");
    const processId = Number(segments[1]);
    if (Number.isFinite(processId)) {
      const process = getProcessById(db, processId);
      const processCode = getProcessRouteCode(process);
      push(process?.name ?? `Process ${processId}`, processCode ? `/${processCode}` : `/?process_id=${processId}`);
    }
    return crumbs;
  }
  if (first === "machines") {
    push("Machines", "/machines");
    const machineId = Number(segments[1]);
    if (Number.isFinite(machineId)) {
      const machine = getMachine(db, machineId);
      push(machine?.name ?? `Machine ${machineId}`, `/machines/${machineId}`);
    }
    return crumbs;
  }
  if (first === "param-library") {
    push("Parameters", "/param-library");
    return crumbs;
  }
  if (first === "admin") {
    push("Admin", "/admin");
    return crumbs;
  }
  if (first === "audit") {
    push("Audit", "/audit");
    return crumbs;
  }
  if (first === "me") {
    push("Profile", "/me");
    return crumbs;
  }
  if (first === "users") {
    push("Users", "/admin");
    const userId = Number(segments[1]);
    if (Number.isFinite(userId)) {
      const user = findUserById(db, userId);
      const label = user?.name?.trim() || user?.email?.trim() || `User ${userId}`;
      push(label, `/users/${userId}`);
    }
    return crumbs;
  }
  if (first === "reports") {
    const reportId = Number(segments[1]);
    if (!Number.isFinite(reportId)) return crumbs;
    const report = getReportConfig(db, reportId);
    if (report) {
      const experiment = getExperiment(db, report.experiment_id);
      pushProcessPath(experiment?.process_id);
      const expLabel = experiment?.name ?? `Experiment ${report.experiment_id}`;
      push(expLabel, experimentHref(experiment));
      push(report.name, `/reports/${report.id}`);
      if (segments[2] === "editor") {
        push("Editor", `/reports/${report.id}/editor`);
      }
    } else {
      push(`Report ${reportId}`, `/reports/${reportId}`);
    }
    return crumbs;
  }
  if (first === "runs") {
    const runId = Number(segments[1]);
    if (!Number.isFinite(runId)) return crumbs;
    const run = getRun(db, runId);
    if (run) {
      const experiment = getExperiment(db, run.experiment_id);
      pushProcessPath(experiment?.process_id);
      const expLabel = experiment?.name ?? `Experiment ${run.experiment_id}`;
      push(expLabel, experimentHref(experiment));
      if (run.doe_id) {
        const doe = getDoeStudy(db, run.doe_id);
        const doeLabel = doe?.name ?? `DOE ${run.doe_id}`;
        push(doeLabel, `${experimentHref(experiment)}/doe/${run.doe_id}`);
      }
      push(run.run_code || `Run ${run.id}`, `${experimentHref(experiment)}/runs/${run.id}`);
    }
    return crumbs;
  }
  if (first === "experiments") {
    if (segments[1] === "new") {
      const processId = Number(req.query.process_id);
      if (Number.isFinite(processId) && processId > 0) pushProcessPath(processId);
      push("New Experiment", "/experiments/new");
      return crumbs;
    }
    const experimentId = Number(segments[1]);
    if (!Number.isFinite(experimentId)) return crumbs;
    pushExperimentTrail(experimentId, segments.slice(2));
    return crumbs;
  }

  return crumbs;
}
