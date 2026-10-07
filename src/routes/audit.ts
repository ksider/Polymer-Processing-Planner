import express from "express";
import type { Db } from "../db.js";
import { listAudit } from "../repos/audit_repo.js";

export function createAuditRouter(db: Db) {
  const router = express.Router();
  const hasRole = (req: express.Request, roles: string[]) => roles.includes(req.user?.role ?? "");

  router.get("/export.jsonl", (req, res) => {
    if (!hasRole(req, ["admin", "manager"])) {
      return res.status(403).send("Forbidden");
    }
    const audit = listAudit(db, -1);
    const filename = `planner-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    return res.send(audit.map((row) => JSON.stringify(row)).join("\n") + (audit.length ? "\n" : ""));
  });

  router.get("/", (req, res) => {
    if (!hasRole(req, ["admin", "manager"])) {
      return res.status(403).send("Forbidden");
    }
    const audit = listAudit(db, 200);
    res.render("audit", { title: "Audit Log", audit, activeAdminPath: "/audit" });
  });

  return router;
}
