import express from "express";
import type { Db } from "../db.js";
import { ADMIN_ACTION_LIMITER } from "../middleware/rate_limit.js";
import { getSystemHealthOverview, runSystemHealthChecks } from "../services/system_health_service.js";

export function createSystemHealthRouter(db: Db) {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.render("system_health", {
      title: "System Health",
      activeAdminPath: "/system-health",
      health: getSystemHealthOverview(db)
    });
  });

  router.post("/check", ADMIN_ACTION_LIMITER, async (_req, res) => {
    const checks = await runSystemHealthChecks(db);
    res.json({ ok: true, checks });
  });

  return router;
}
