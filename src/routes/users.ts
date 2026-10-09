import express from "express";
import type { Db } from "../db.js";
import { findUserById } from "../repos/users_repo.js";
import { listExperimentsForOwnerWithMeta, type ExperimentListRow } from "../repos/experiments_repo.js";

export function createUsersRouter(db: Db) {
  const router = express.Router();

  const enrich = (experiments: ExperimentListRow[]) =>
    experiments.map((exp) => {
      const ownerLabel = exp.owner_name?.trim() || exp.owner_email?.trim() || "Unassigned";
      const summaryCount = Number(exp.qual_summary_count || 0);
      const valueCount = Number(exp.qual_run_value_count || 0);
      let status = "not_started";
      let statusLabel = "Not started";
      if (summaryCount > 0 || valueCount > 0) {
        status = "in_progress";
        statusLabel = "In progress";
      }
      return { ...exp, owner_label: ownerLabel, status, statusLabel };
    });

  router.get("/users/:id", (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) return res.status(404).send("Not found");

    const currentUser = req.user as { id?: number; role?: string } | undefined;
    const user = findUserById(db, userId);
    if (!user) return res.status(404).send("User not found");
    if (currentUser?.id === userId) return res.redirect("/me");

    // The profile card is a directory record, not another person's private
    // workspace. Active colleagues can identify and contact one another;
    // inactive accounts remain visible only to directory moderators.
    const canModerateDirectory = currentUser?.role === "admin" || currentUser?.role === "manager";
    if (user.status !== "ACTIVE" && !canModerateDirectory) return res.status(404).send("User not found");

    // Ownership by itself is not an experiment visibility grant. Retain the
    // supporting list only for directory moderators until experiment ACLs
    // expose an explicit shareable scope.
    const canViewExperiments = Boolean(canModerateDirectory);
    const experiments = canViewExperiments ? listExperimentsForOwnerWithMeta(db, userId, false) : [];
    res.render("user_profile", {
      title: `${user.name || user.email} · Profile`,
      uiKit: true,
      user,
      experiments: enrich(experiments),
      canViewExperiments
    });
  });

  return router;
}
