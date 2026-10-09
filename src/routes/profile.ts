import express from "express";
import bcrypt from "bcryptjs";
import type { Db } from "../db.js";
import { PASSWORD_CHANGE_LIMITER } from "../middleware/rate_limit.js";
import {
  findUserById,
  deleteOtherSessionsByUser,
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
import { listByFolder } from "../services/messages_service.js";
import {
  countUnreadNotifications,
  listUnreadNotificationsByUser,
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
import {
  getLlmUsageBreakdownForUser,
  getLlmUsageTotalsForUser
} from "../modules/llm/provider_profiles_repo.js";

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

  // Retained only for the backward-compatible legacy JSON endpoint. New UI
  // surfaces operational notifications from the Messenger mailbox instead.
  const enrichLegacyNotification = <T extends { payload_json: string | null }>(notice: T) => {
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
  };

  const buildProfilePayload = (userId: number, aiUsagePeriod: AiUsagePeriod = aiUsagePeriodFromQuery(undefined)) => {
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
          : item.entity_type === "report"
            ? item.report_name || `Report #${item.entity_id}`
            : item.doe_name || `DOE #${item.entity_id}`;
      const entityPath =
        item.entity_type === "qualification_step"
          ? `/experiments/${item.experiment_id}/qualification/${item.step_number ?? 1}`
          : item.entity_type === "report"
            ? `/reports/${item.entity_id}`
            : `/experiments/${item.experiment_id}/doe/${item.entity_id}?tab=design`;
      return { ...item, entityTitle, entityPath };
    });
    const notifications = listByFolder(db, userId, "inbox", 100)
      .filter((item) => ["system", "assignment", "task"].includes(item.kind))
      .slice(0, 12);
    return {
      experiments: enrich(experiments),
      tasks: tasksWithProgress,
      assignedEntities,
      notifications,
      llmUsageTotals: getLlmUsageTotalsForUser(db, userId, aiUsagePeriod.from),
      llmUsageBreakdown: getLlmUsageBreakdownForUser(db, userId, aiUsagePeriod.from),
      aiUsagePeriod
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

    const avatarUrl = hasPreviewOverride && Number(req.user.id) === userId
      ? buildAvatarRedirectUrl(
          {
            ...user,
            avatar_style_json: stringifyAvatarStyle(
              normalizeAvatarStyle(
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
              )
            )
          },
          normalizeAvatarStyle(
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
          )
        )
      : buildAvatarRedirectUrl(user);

    res.set("Cache-Control", "private, no-store");
    // Redirecting keeps third-party SVG markup on its original origin. Do not
    // proxy it into this application's origin where it could become active.
    return res.redirect(302, avatarUrl);
  });

  router.get("/me", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const data = buildProfilePayload(req.user.id, aiUsagePeriodFromQuery(req.query.ai_usage_period));
    res.render("profile", {
      title: "Profile",
      uiKit: true,
      ...data,
      currentAvatarStyle: getAvatarStyle(avatarUserFromRequest(req.user)),
      avatarStyleOptions: AVATAR_STYLE_OPTIONS,
      error: null,
      notice: null
    });
  });

  // Keep old bookmarks from opening a separate, legacy notifications screen.
  // Operational notifications live in the Messenger inbox and its right rail.
  router.get("/me/notifications", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    return res.redirect("/messages");
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

  router.post("/me/password", PASSWORD_CHANGE_LIMITER, (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const current = String(req.body?.current_password ?? "");
    const next = String(req.body?.new_password ?? "");
    const confirm = String(req.body?.confirm_password ?? "");

    const storedHash = getUserPasswordHash(db, req.user.id);
    if (!storedHash || !bcrypt.compareSync(current, storedHash)) {
      const data = buildProfilePayload(req.user.id);
      return res.render("profile", {
        title: "Profile",
        uiKit: true,
        ...data,
        currentAvatarStyle: getAvatarStyle(avatarUserFromRequest(req.user)),
        avatarStyleOptions: AVATAR_STYLE_OPTIONS,
        error: "Current password is incorrect.",
        notice: null
      });
    }
    if (next.length < 12 || next !== confirm) {
      const data = buildProfilePayload(req.user.id);
      return res.render("profile", {
        title: "Profile",
        uiKit: true,
        ...data,
        currentAvatarStyle: getAvatarStyle(avatarUserFromRequest(req.user)),
        avatarStyleOptions: AVATAR_STYLE_OPTIONS,
        error: "New password must be at least 12 characters and match confirmation.",
        notice: null
      });
    }
    const hash = bcrypt.hashSync(next, 12);
    updateUserPassword(db, req.user.id, hash);
    if (req.sessionID) deleteOtherSessionsByUser(db, req.user.id, req.sessionID);
    const data = buildProfilePayload(req.user.id);
    return res.render("profile", {
      title: "Profile",
      uiKit: true,
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

  router.get("/me/notifications/unread.json", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const limit = Number(req.query.limit);
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 12;
    return res.json({
      unread_count: countUnreadNotifications(db, req.user.id),
      items: listUnreadNotificationsByUser(db, req.user.id, safeLimit).map(enrichLegacyNotification)
    });
  });

  router.post("/me/notifications/:id/read.json", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const notificationId = Number(req.params.id);
    if (!Number.isFinite(notificationId)) return res.status(400).json({ error: "Invalid notification id" });
    markNotificationRead(db, notificationId, req.user.id);
    return res.json({ ok: true, unread_count: countUnreadNotifications(db, req.user.id) });
  });

  router.post("/me/notifications/read-all", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    markAllNotificationsRead(db, req.user.id);
    return res.redirect("/me#notifications");
  });

  router.post("/me/notifications/read-all.json", (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    markAllNotificationsRead(db, req.user.id);
    return res.json({ ok: true, unread_count: countUnreadNotifications(db, req.user.id) });
  });

  return router;
}

type AiUsagePeriod = {
  key: "7d" | "30d" | "90d" | "all";
  label: string;
  from?: string;
};

function aiUsagePeriodFromQuery(value: unknown): AiUsagePeriod {
  const key = typeof value === "string" ? value : "all";
  if (key === "7d") return aiUsagePeriodForDays("7d", 7);
  if (key === "30d") return aiUsagePeriodForDays("30d", 30);
  if (key === "90d") return aiUsagePeriodForDays("90d", 90);
  return { key: "all", label: "All time" };
}

function aiUsagePeriodForDays(key: "7d" | "30d" | "90d", days: number): AiUsagePeriod {
  return {
    key,
    label: `Last ${days} days`,
    from: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  };
}
