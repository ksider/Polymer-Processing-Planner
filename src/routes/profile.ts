import express from "express";
import bcrypt from "bcryptjs";
import type { Db } from "../db.js";
import {
  findUserById,
  getUserPasswordHash,
  updateUserAvatarStyle,
  updateUserName,
  updateUserPassword
} from "../repos/users_repo.js";
import { listExperimentsForOwnerWithMeta, type ExperimentListRow } from "../repos/experiments_repo.js";
import { listTasksForUser } from "../repos/tasks_read_repo.js";
import { listTaskEntities, type TaskEntityRow } from "../repos/tasks_repo.js";
import { computeTaskProgress } from "../services/tasks_service.js";
import { listQualSummarySteps } from "../repos/qual_repo.js";
import { listAssignedEntitiesForUser } from "../repos/entity_assignments_repo.js";
import {
  listNotificationsByUser,
  markAllNotificationsRead,
  markNotificationRead
} from "../repos/notifications_repo.js";
import {
  AVATAR_STYLE_OPTIONS,
  buildAvatarRedirectUrl,
  getAvatarStyle,
  normalizeAvatarStyle,
  stringifyAvatarStyle
} from "../services/avatar_service.js";

export function createProfileRouter(db: Db) {
  const router = express.Router();

  const avatarUserFromRequest = (user: {
    id?: number;
    name?: string | null;
    email?: string;
    avatar_style_json?: string | null;
  }) => ({
    id: Number(user.id),
    name: user.name ?? null,
    email: String(user.email ?? ""),
    avatar_style_json: user.avatar_style_json ?? null
  });

  const enrich = (experiments: ExperimentListRow[]) =>
    experiments.map((exp) => {
      const summaryCount = Number(exp.qual_summary_count || 0);
      const valueCount = Number(exp.qual_run_value_count || 0);
      let status = "not_started";
      let statusLabel = "Not started";
      if (exp.status_done_manual === 1) {
        status = "done";
        statusLabel = "Done";
      } else if (summaryCount > 0 || valueCount > 0) {
        status = "in_progress";
        statusLabel = "In progress";
      }
      return { ...exp, status, statusLabel };
    });

  const buildProfilePayload = (userId: number) => {
    const experiments = listExperimentsForOwnerWithMeta(db, userId, false);
    const tasks = listTasksForUser(db, userId);
    const summaryByExperiment = new Map<number, Set<number>>();
    const tasksWithProgress = tasks.map((task) => {
      if (!summaryByExperiment.has(task.experiment_id)) {
        summaryByExperiment.set(
          task.experiment_id,
          new Set(listQualSummarySteps(db, task.experiment_id))
        );
      }
      const summarySteps = summaryByExperiment.get(task.experiment_id) ?? new Set<number>();
      const entities: TaskEntityRow[] = listTaskEntities(db, task.task_id).map((entity) => {
        if (entity.entity_type === "qualification_step") {
          if (summarySteps.has(entity.entity_id)) {
            return { ...entity, status: "done" as const };
          }
        }
        return entity;
      });
      const progress = computeTaskProgress(entities);
      return { ...task, progress_percent: Math.round((progress.percent || 0) * 100) };
    });
    const assignedEntities = listAssignedEntitiesForUser(db, userId).map((item) => {
      const entityTitle =
        item.entity_type === "qualification_step"
          ? `Qualification Step ${item.step_number ?? "?"}`
          : item.doe_name || `DOE #${item.entity_id}`;
      const entityPath =
        item.entity_type === "qualification_step"
          ? `/experiments/${item.experiment_id}/qualification/${item.step_number ?? 1}`
          : `/experiments/${item.experiment_id}/doe/${item.entity_id}?tab=design`;
      return { ...item, entityTitle, entityPath };
    });
    const notifications = listNotificationsByUser(db, userId, 30).map((notice) => {
      let path = null as string | null;
      if (notice.payload_json) {
        try {
          const payload = JSON.parse(notice.payload_json) as { path?: string };
          if (payload.path) path = payload.path;
        } catch {
          path = null;
        }
      }
      return { ...notice, path };
    });
    return {
      experiments: enrich(experiments),
      tasks: tasksWithProgress,
      assignedEntities,
      notifications
    };
  };

  router.get("/avatars/:id.svg", (req, res) => {
    if (!req.user?.id) return res.status(401).send("Unauthorized");
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).send("Invalid user id");
    const user = findUserById(db, userId);
    if (!user) return res.status(404).send("Not found");
    const hasPreviewOverride =
      req.query.palette != null ||
      req.query.presentation != null ||
      req.query.skin_tone != null ||
      req.query.hair != null ||
      req.query.accessory != null ||
      req.query.facial_hair != null ||
      req.query.eyes != null ||
      req.query.mouth != null;
    if (hasPreviewOverride && Number(req.user.id) === userId) {
      const previewStyle = normalizeAvatarStyle(
        {
          palette: String(req.query.palette ?? "").trim().toLowerCase() as never,
          presentation: String(req.query.presentation ?? "").trim().toLowerCase() as never,
          skinTone: String(req.query.skin_tone ?? "").trim().toLowerCase() as never,
          hair: String(req.query.hair ?? "").trim().toLowerCase() as never,
          accessory: String(req.query.accessory ?? "").trim().toLowerCase() as never,
          facialHair: String(req.query.facial_hair ?? "").trim().toLowerCase() as never,
          eyes: String(req.query.eyes ?? "").trim().toLowerCase() as never,
          mouth: String(req.query.mouth ?? "").trim().toLowerCase() as never
        },
        `${user.id}:${user.email}:${user.name ?? ""}`
      );
      res.set("Cache-Control", "private, no-store");
      return res.redirect(buildAvatarRedirectUrl(
        { ...user, avatar_style_json: stringifyAvatarStyle(previewStyle) },
        previewStyle
      ));
    }
    res.set("Cache-Control", "private, no-store");
    return res.redirect(buildAvatarRedirectUrl(user));
  });

  router.get("/me", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const data = buildProfilePayload(req.user.id);
    res.render("profile", {
      title: "Profile",
      ...data,
      currentAvatarStyle: getAvatarStyle(avatarUserFromRequest(req.user)),
      avatarStyleOptions: AVATAR_STYLE_OPTIONS,
      error: null,
      notice: null
    });
  });

  router.post("/me/name", (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!req.user?.id) return res.redirect("/auth/login");
    updateUserName(db, req.user.id, name || null);
    return res.redirect("/me");
  });

  router.post("/me/avatar-style", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const nextStyle = normalizeAvatarStyle(
      {
        palette: String(req.body?.palette ?? "amber").trim().toLowerCase() as never,
        presentation: String(req.body?.presentation ?? "neutral").trim().toLowerCase() as never,
        skinTone: String(req.body?.skin_tone ?? "warm").trim().toLowerCase() as never,
        hair: String(req.body?.hair ?? "short").trim().toLowerCase() as never,
        accessory: String(req.body?.accessory ?? "none").trim().toLowerCase() as never,
        facialHair: String(req.body?.facial_hair ?? "none").trim().toLowerCase() as never,
        eyes: String(req.body?.eyes ?? "calm").trim().toLowerCase() as never,
        mouth: String(req.body?.mouth ?? "default").trim().toLowerCase() as never
      },
      `${req.user.id}:${req.user.email}:${req.user.name ?? ""}`
    );
    updateUserAvatarStyle(db, req.user.id, stringifyAvatarStyle(nextStyle));
    return res.redirect("/me");
  });

  router.post("/me/avatar-style.json", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const nextStyle = normalizeAvatarStyle(
      {
        palette: String(req.body?.palette ?? "amber").trim().toLowerCase() as never,
        presentation: String(req.body?.presentation ?? "neutral").trim().toLowerCase() as never,
        skinTone: String(req.body?.skin_tone ?? "warm").trim().toLowerCase() as never,
        hair: String(req.body?.hair ?? "short").trim().toLowerCase() as never,
        accessory: String(req.body?.accessory ?? "none").trim().toLowerCase() as never,
        facialHair: String(req.body?.facial_hair ?? "none").trim().toLowerCase() as never,
        eyes: String(req.body?.eyes ?? "calm").trim().toLowerCase() as never,
        mouth: String(req.body?.mouth ?? "default").trim().toLowerCase() as never
      },
      `${req.user.id}:${req.user.email}:${req.user.name ?? ""}`
    );
    updateUserAvatarStyle(db, req.user.id, stringifyAvatarStyle(nextStyle));
    return res.json({ ok: true, avatar_url: `/avatars/${req.user.id}.svg?ts=${Date.now()}` });
  });

  router.post("/me/password", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const current = String(req.body?.current_password ?? "");
    const next = String(req.body?.new_password ?? "");
    const confirm = String(req.body?.confirm_password ?? "");

    const storedHash = getUserPasswordHash(db, req.user.id);
    if (!storedHash || !bcrypt.compareSync(current, storedHash)) {
      const data = buildProfilePayload(req.user.id);
      return res.render("profile", {
        title: "Profile",
        ...data,
        currentAvatarStyle: getAvatarStyle(avatarUserFromRequest(req.user)),
        avatarStyleOptions: AVATAR_STYLE_OPTIONS,
        error: "Current password is incorrect.",
        notice: null
      });
    }
    if (next.length < 8 || next !== confirm) {
      const data = buildProfilePayload(req.user.id);
      return res.render("profile", {
        title: "Profile",
        ...data,
        currentAvatarStyle: getAvatarStyle(avatarUserFromRequest(req.user)),
        avatarStyleOptions: AVATAR_STYLE_OPTIONS,
        error: "New password must be at least 8 characters and match confirmation.",
        notice: null
      });
    }
    const hash = bcrypt.hashSync(next, 12);
    updateUserPassword(db, req.user.id, hash);
    const data = buildProfilePayload(req.user.id);
    return res.render("profile", {
      title: "Profile",
      ...data,
      currentAvatarStyle: getAvatarStyle(avatarUserFromRequest(req.user)),
      avatarStyleOptions: AVATAR_STYLE_OPTIONS,
      error: null,
      notice: "Password updated."
    });
  });

  router.post("/me/notifications/:id/read", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const notificationId = Number(req.params.id);
    if (Number.isFinite(notificationId)) {
      markNotificationRead(db, notificationId, req.user.id);
    }
    return res.redirect("/me#notifications");
  });

  router.post("/me/notifications/read-all", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    markAllNotificationsRead(db, req.user.id);
    return res.redirect("/me#notifications");
  });

  return router;
}
