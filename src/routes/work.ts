import express from "express";
import type { Db } from "../db.js";
import { buildWorkQueue, type WorkQueueFilters } from "../services/work_queue_service.js";
import { getWorkspacePreferences, updateWorkspacePreferences } from "../services/workspace_preferences_service.js";

function positiveInteger(value: unknown, fallback: number | null = null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createWorkRouter(db: Db) {
  const router = express.Router();
  const renderWork = (req: express.Request, res: express.Response, forcedView?: "table" | "board" | "calendar") => {
    if (!req.user) return res.status(401).send("Unauthorized");
    const preferences = getWorkspacePreferences(db, req.user.id);
    const type = String(req.query.type || "all");
    const requestedScope = String(req.query.scope || preferences.lastScope);
    const scope = requestedScope === "my" ? "mine" : requestedScope;
    const state = String(req.query.state || "all");
    const filters: WorkQueueFilters = {
      processId: positiveInteger(req.query.process_id),
      experimentId: positiveInteger(req.query.experiment_id),
      type: ["task", "qualification", "doe", "report"].includes(type) ? type as WorkQueueFilters["type"] : "all",
      scope: ["mine", "others", "all"].includes(scope) ? scope as WorkQueueFilters["scope"] : "mine",
      state: ["open", "blocked", "overdue"].includes(state) ? state as WorkQueueFilters["state"] : "all",
      responsibleUserId: positiveInteger(req.query.responsible_user_id),
      query: String(req.query.q || "").trim().slice(0, 200),
      page: positiveInteger(req.query.page, 1) || 1,
      pageSize: 10000
    };
    return res.render("work", { queue: buildWorkQueue(db, req.user, filters), filters, preferences, initialView: forcedView ?? (req.query.view === "board" || req.query.view === "calendar" ? req.query.view : preferences.defaultView) });
  };
  router.post("/work/preferences", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const defaultView = ["table", "board", "calendar"].includes(String(req.body?.default_view)) ? String(req.body.default_view) as "table" | "board" | "calendar" : undefined;
    const lastScope = ["mine", "others", "all"].includes(String(req.body?.last_scope)) ? String(req.body.last_scope) as "mine" | "others" | "all" : undefined;
    const density = ["comfortable", "compact"].includes(String(req.body?.density)) ? String(req.body.density) as "comfortable" | "compact" : undefined;
    return res.json({ preferences: updateWorkspacePreferences(db, req.user.id, { ...(defaultView ? { defaultView } : {}), ...(lastScope ? { lastScope } : {}), ...(density ? { density } : {}) }) });
  });
  router.get("/work", (req, res) => renderWork(req, res));
  router.get("/work/table", (req, res) => renderWork(req, res, "table"));
  router.get("/work/board", (req, res) => renderWork(req, res, "board"));
  router.get("/work/calendar", (req, res) => renderWork(req, res, "calendar"));
  return router;
}
