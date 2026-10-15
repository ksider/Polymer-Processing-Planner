import express from "express";
import type { Db } from "../db.js";
import { buildDashboard } from "../services/dashboard_service.js";

export function createDashboardRouter(db: Db) {
  const router = express.Router();

  router.get("/", (req, res) => {
    if (!req.user) return res.status(401).send("Unauthorized");
    const requestedProcessId = Number(req.query.process_id || 0);
    const dashboard = buildDashboard(
      db,
      req.user,
      Number.isInteger(requestedProcessId) && requestedProcessId > 0 ? requestedProcessId : null
    );
    // A process selector must not disclose a process that has no visible experiment.
    if (dashboard.selectedProcessId && !dashboard.processOptions.some((process) => process.id === dashboard.selectedProcessId)) {
      return res.redirect("/");
    }
    return res.render("dashboard", { dashboard });
  });

  return router;
}
