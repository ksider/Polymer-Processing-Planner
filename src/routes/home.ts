import express from "express";
import type { Db } from "../db.js";
import {
  listExperimentsByProcessForUserWithMeta,
  listExperimentsByProcessWithMeta,
  listExperimentsForUserWithMeta,
  listExperimentsWithMeta,
  type ExperimentListRow
} from "../repos/experiments_repo.js";
import {
  getProcessById,
  getProcessByRouteCode,
  getProcessRouteCode,
  listProcessesWithStats,
  normalizeRouteCode,
  updateProcessSettings
} from "../repos/processes_repo.js";
import { findUserById, listUsers } from "../repos/users_repo.js";

export function createHomeRouter(db: Db) {
  const router = express.Router();
  const reservedRootRoutes = new Set([
    "admin",
    "audit",
    "auth",
    "me",
    "users",
    "recipes",
    "machines",
    "runs",
    "reports",
    "tasks",
    "notes",
    "experiments",
    "processes",
    "my-experiments",
    "param-library",
    "qualification"
  ]);

  const enrich = (experiments: ExperimentListRow[]) =>
    experiments.map((exp) => {
      const ownerLabel = exp.owner_name?.trim() || exp.owner_email?.trim() || "Unassigned";
      const summaryCount = Number(exp.qual_summary_count || 0);
      const valueCount = Number(exp.qual_run_value_count || 0);
      let status = "not_started";
      let statusLabel = "Not started";
      const processLabel = exp.process_name?.trim() || "Injection Default Process";
      const processTypeLabel = exp.process_type_name?.trim() || "Injection";
      if (exp.status_done_manual === 1) {
        status = "done";
        statusLabel = "Done";
      } else if (summaryCount > 0 || valueCount > 0) {
        status = "in_progress";
        statusLabel = "In progress";
      }
      return { ...exp, owner_label: ownerLabel, process_label: processLabel, process_type_label: processTypeLabel, status, statusLabel };
    });

  const renderProcesses = (req: express.Request, res: express.Response) => {
    const isPrivileged = req.user?.role === "admin" || req.user?.role === "manager";
    const allProcesses = listProcessesWithStats(db);
    const visibleProcessIds = new Set(
      allProcesses
        .filter((process) => Number(process.show_on_home ?? 1) === 1)
        .map((process) => Number(process.id))
    );
    const allExperiments = isPrivileged
      ? listExperimentsWithMeta(db, false)
      : req.user?.id
        ? listExperimentsForUserWithMeta(db, req.user.id, false)
        : [];
    const visibleExperiments = allExperiments.filter((exp) => {
      const processId = Number(exp.process_id || 0);
      return Number.isFinite(processId) && visibleProcessIds.has(processId);
    });
    const ownerLabelByProcessId = new Map<number, string>();
    const getOwnerLabel = (processId: number, ownerUserId: number | null | undefined) => {
      if (!Number.isFinite(processId) || processId <= 0) return "Unassigned";
      const existing = ownerLabelByProcessId.get(processId);
      if (existing) return existing;
      const user = ownerUserId ? findUserById(db, ownerUserId) : null;
      const label = user?.name?.trim() || user?.email?.trim() || "Unassigned";
      ownerLabelByProcessId.set(processId, label);
      return label;
    };
    const processCards = isPrivileged
      ? allProcesses
        .filter((process) => visibleProcessIds.has(Number(process.id)))
        .map((process) => ({
          id: process.id,
          name: process.name,
          route_code: getProcessRouteCode(process),
          owner_user_id: process.owner_user_id ?? null,
          owner_label: getOwnerLabel(process.id, process.owner_user_id),
          process_type_name: String(process.process_type_name || "Process"),
          experiment_count: Number(process.experiment_count || 0)
        }))
      : (() => {
          const cardsById = new Map<number, {
            id: number;
            name: string;
            route_code: string | null;
            owner_user_id: number | null;
            owner_label: string;
            process_type_name: string;
            experiment_count: number;
          }>();
          visibleExperiments.forEach((exp) => {
            const processId = Number(exp.process_id || 0);
            if (!Number.isFinite(processId) || processId <= 0) return;
            if (!visibleProcessIds.has(processId)) return;
            const existing = cardsById.get(processId);
            if (existing) {
              existing.experiment_count += 1;
              return;
            }
            cardsById.set(processId, {
              id: processId,
              name: exp.process_name || "Process",
              route_code: normalizeRouteCode(exp.process_route_code || exp.process_type_code),
              owner_user_id: null,
              owner_label: (() => {
                const process = getProcessById(db, processId);
                return getOwnerLabel(processId, process?.owner_user_id ?? null);
              })(),
              process_type_name: exp.process_type_name || "Process",
              experiment_count: 1
            });
          });
          return Array.from(cardsById.values());
        })();
    const selectedProcessIdFromQuery = Number(req.query.process_id || 0);
    const selectedProcessId = Number.isFinite(selectedProcessIdFromQuery) && selectedProcessIdFromQuery > 0
      ? selectedProcessIdFromQuery
      : null;
    const selectedProcess = selectedProcessId
      ? processCards.find((process) => process.id === selectedProcessId) || null
      : null;
    const experiments = selectedProcess
      ? visibleExperiments.filter((exp) => Number(exp.process_id || 0) === selectedProcess.id)
      : visibleExperiments;
    const isAdmin = req.user?.role === "admin";
    const assignableUsers = isAdmin ? listUsers(db).filter((user) => user.status === "ACTIVE") : [];
    processCards.sort((a, b) => a.name.localeCompare(b.name));
    res.render("home", {
      experiments: enrich(experiments),
      processCards,
      selectedProcess,
      isAdmin,
      assignableUsers
    });
  };

  const renderProcessPage = (req: express.Request, res: express.Response, processId: number) => {
    const process = getProcessById(db, processId);
    if (!process) return res.status(404).send("Process not found");
    const isPrivileged = req.user?.role === "admin" || req.user?.role === "manager";
    const canManage = isPrivileged || (req.user?.id != null && process.owner_user_id === req.user.id);
    const isAdmin = req.user?.role === "admin";
    const experiments = isPrivileged
      ? listExperimentsByProcessWithMeta(db, processId, false)
      : req.user?.id
        ? listExperimentsByProcessForUserWithMeta(db, processId, req.user.id, false)
        : [];
    if (!isPrivileged && process.owner_user_id !== req.user?.id && experiments.length === 0) {
      return res.status(403).send("Forbidden");
    }
    const ownerUser = process.owner_user_id ? findUserById(db, process.owner_user_id) : null;
    const ownerLabel = ownerUser?.name?.trim() || ownerUser?.email?.trim() || "Unassigned";
    const assignableUsers = isAdmin ? listUsers(db).filter((user) => user.status === "ACTIVE") : [];
    return res.render("process_detail", {
      process,
      experiments: enrich(experiments),
      canManage,
      isAdmin,
      ownerLabel,
      assignableUsers
    });
  };

  router.get("/", renderProcesses);

  router.get("/:processCode", (req, res, next) => {
    const rawProcessCode = String(req.params.processCode || "");
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(rawProcessCode)) return next();
    const processCode = normalizeRouteCode(rawProcessCode);
    if (!processCode || reservedRootRoutes.has(processCode)) return next();
    const process = getProcessByRouteCode(db, processCode);
    if (!process) return next();
    return renderProcessPage(req, res, process.id);
  });

  router.get("/processes", (_req, res) => {
    res.redirect("/");
  });

  router.get("/processes/:id", (req, res) => {
    const processId = Number(req.params.id);
    if (!Number.isFinite(processId)) return res.status(404).send("Process not found");
    const process = getProcessById(db, processId);
    if (!process) return res.status(404).send("Process not found");
    const processCode = getProcessRouteCode(process);
    return res.redirect(processCode ? `/${processCode}` : `/?process_id=${processId}`);
  });

  router.post("/processes/:id/settings", (req, res) => {
    if (req.user?.role !== "admin") return res.status(403).send("Forbidden");
    const processId = Number(req.params.id);
    if (!Number.isFinite(processId)) return res.status(400).send("Invalid process");
    const process = getProcessById(db, processId);
    if (!process) return res.status(404).send("Process not found");
    const rawOwner = String(req.body?.owner_user_id ?? "").trim();
    const ownerUserId = rawOwner ? Number(rawOwner) : null;
    if (rawOwner && !Number.isFinite(ownerUserId)) return res.status(400).send("Invalid owner");
    const routeCode = normalizeRouteCode(String(req.body?.route_code ?? ""));
    if (routeCode && reservedRootRoutes.has(routeCode)) return res.status(400).send("Reserved route code");
    try {
      updateProcessSettings(db, processId, ownerUserId, routeCode);
    } catch {
      return res.status(400).send("Route code already in use");
    }
    const updatedProcess = getProcessById(db, processId);
    const processCode = getProcessRouteCode(updatedProcess);
    return res.redirect(processCode ? `/${processCode}` : `/?process_id=${processId}`);
  });

  router.get("/my-experiments", (req, res) => {
    // Personal list for the current user.
    const experiments = req.user?.id
      ? listExperimentsForUserWithMeta(db, req.user.id, false)
      : [];
    res.render("my_experiments", { experiments: enrich(experiments) });
  });

  return router;
}
