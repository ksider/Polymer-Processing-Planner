import express from "express";
import type { Db } from "../db.js";
import { ADMIN_ACTION_LIMITER, FILE_UPLOAD_LIMITER, createRateLimiter } from "../middleware/rate_limit.js";
import { getAdminSettings, updateAllowedDomain, updateRequireHttps } from "../repos/admin_settings_repo.js";
import { insertAudit, listRecentAuditForUsers } from "../repos/audit_repo.js";
import {
  createUser,
  createPasswordSetupToken,
  deleteSessionsByUser,
  deleteUser,
  findUserById,
  listUsers,
  setUserStatus,
  updateUser
} from "../repos/users_repo.js";
import { isAuthSenderConfigured, isEmailConfigured, isPasswordSetupOriginConfigured, sendPasswordSetupEmail, sendTestEmail } from "../services/email.js";
import {
  EMAIL_PURPOSES,
  createEmailSenderProfile,
  createResendProviderProfile,
  deleteEmailProviderProfile,
  deleteEmailSenderProfile,
  listEmailProviderProfiles,
  listEmailSenderProfiles,
  type EmailPurpose
} from "../repos/email_profiles_repo.js";
import { AppSettingsEncryptionError, encryptAppSetting, hasAppSettingsEncryptionKey } from "../services/settings_crypto.js";
import {
  listExperimentsForAdmin,
  updateExperimentOwner,
  restoreExperiment,
  getExperiment,
  deleteExperiment,
  type AdminExperimentRow
} from "../repos/experiments_repo.js";
import {
  listProcessesWithStats,
  updateProcessHomeVisibility,
  updateProcessSettings,
  getProcessById,
  normalizeRouteCode
} from "../repos/processes_repo.js";
import {
  createLlmProviderProfile,
  deleteLlmProviderProfile,
  getLlmUsageBreakdownForAdmin,
  getLlmUsageTotalsForAdmin,
  getLlmProviderProfile,
  listLlmProviderProfiles,
  updateLlmProviderProfile,
  type LlmProviderKind,
  type LlmProviderProfile,
  type LlmUsageAdminBreakdownRow,
  type LlmUsageTotals,
  type SaveLlmProviderProfileInput
} from "../modules/llm/provider_profiles_repo.js";
import { hasLlmSettingsEncryptionKey, LlmSettingsEncryptionError } from "../modules/llm/settings_crypto.js";
import { listReportConfigsForAdmin } from "../repos/reports_repo.js";
import { getSystemHealthOverview } from "../services/system_health_service.js";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isSafeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

function wantsJson(req: express.Request) {
  return req.headers["x-requested-with"] === "fetch";
}

type AiUsageUserGroup = LlmUsageTotals & {
  userId: number;
  userName: string | null;
  userEmail: string;
  failedRequestCount: number;
  models: LlmUsageAdminBreakdownRow[];
};

function groupAiUsageByUser(rows: LlmUsageAdminBreakdownRow[]): AiUsageUserGroup[] {
  const users = new Map<number, AiUsageUserGroup>();
  rows.forEach((row) => {
    const existing = users.get(row.userId) ?? {
      userId: row.userId,
      userName: row.userName,
      userEmail: row.userEmail,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      failedRequestCount: 0,
      models: []
    };
    existing.inputTokens += Number(row.inputTokens || 0);
    existing.outputTokens += Number(row.outputTokens || 0);
    existing.totalTokens += Number(row.totalTokens || 0);
    existing.requestCount += Number(row.requestCount || 0);
    existing.failedRequestCount += Number(row.failedRequestCount || 0);
    existing.models.push(row);
    users.set(row.userId, existing);
  });
  return Array.from(users.values()).sort((left, right) => right.totalTokens - left.totalTokens);
}

export function createAdminRouter(db: Db) {
  const router = express.Router();

  router.get("/ai-usage", (req, res) => {
    const aiUsagePeriod = aiUsagePeriodFromQuery(req.query.period);
    return res.json({
      period: aiUsagePeriod,
      totals: getLlmUsageTotalsForAdmin(db, aiUsagePeriod.from),
      breakdown: groupAiUsageByUser(getLlmUsageBreakdownForAdmin(db, aiUsagePeriod.from))
    });
  });

  router.get("/", (req, res) => {
    const settings = getAdminSettings(db);
    const users = listUsers(db);
    const llmProviderProfiles = listLlmProviderProfiles(db);
    const aiUsagePeriod = aiUsagePeriodFromQuery(req.query.ai_usage_period);
    const llmUsageTotals = getLlmUsageTotalsForAdmin(db, aiUsagePeriod.from);
    const llmUsageBreakdown = groupAiUsageByUser(getLlmUsageBreakdownForAdmin(db, aiUsagePeriod.from));
    const reports = listReportConfigsForAdmin(db);
    const systemHealth = getSystemHealthOverview(db);
    const emailProviderProfiles = listEmailProviderProfiles(db);
    const emailSenderProfiles = listEmailSenderProfiles(db);
    const userAudit = listRecentAuditForUsers(db);
    const userActivity = new Map<number, typeof userAudit>();
    userAudit.forEach((event) => {
      if (!event.actor_user_id) return;
      const events = userActivity.get(event.actor_user_id) ?? [];
      events.push(event);
      userActivity.set(event.actor_user_id, events);
    });
    const processes = listProcessesWithStats(db).map((process) => ({
      ...process,
      show_on_home: Number(process.show_on_home ?? 1) === 1 ? 1 : 0
    }));
    const experimentsRaw = listExperimentsForAdmin(db);
    const experiments = experimentsRaw.map((exp: AdminExperimentRow) => {
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
    const notice = typeof req.query.notice === "string" ? req.query.notice : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    res.render("admin", {
      title: "Admin",
      settings,
      emailProviderProfiles,
      emailSenderProfiles,
      emailSettingsEncryptionReady: hasAppSettingsEncryptionKey(),
      emailPasswordOriginReady: isPasswordSetupOriginConfigured(),
      emailAuthSenderReady: isAuthSenderConfigured(db),
      emailPasswordLinksReady: isEmailConfigured(db),
      llmProviderProfiles,
      llmSettingsEncryptionReady: hasLlmSettingsEncryptionKey(),
      llmUsageTotals,
      llmUsageBreakdown,
      aiUsagePeriod,
      users,
      processes,
      reports,
      systemHealth,
      userActivity,
      experiments,
      notice,
      error
    });
  });

  router.post("/processes/:id/settings", (req, res) => {
    const processId = Number(req.params.id);
    if (!Number.isFinite(processId)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid process" });
      }
      return res.redirect("/admin?error=Invalid process");
    }
    const process = getProcessById(db, processId);
    if (!process) {
      if (wantsJson(req)) {
        return res.status(404).json({ ok: false, message: "Process not found" });
      }
      return res.redirect("/admin?error=Process not found");
    }
    const rawOwner = String(req.body?.owner_user_id ?? "").trim();
    const ownerUserId = rawOwner ? Number(rawOwner) : null;
    if (rawOwner && !Number.isFinite(ownerUserId)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid owner" });
      }
      return res.redirect("/admin?error=Invalid owner");
    }
    const routeCode = normalizeRouteCode(String(req.body?.route_code ?? ""));
    const showOnHome = req.body?.show_on_home ? 1 : 0;
    try {
      updateProcessSettings(db, processId, Number.isFinite(ownerUserId) ? ownerUserId : null, routeCode);
    } catch {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Route code already in use" });
      }
      return res.redirect("/admin?error=Route code already in use");
    }
    updateProcessHomeVisibility(db, processId, showOnHome);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.process.settings.update",
      targetUserId: null,
      detailsJson: JSON.stringify({
        process_id: processId,
        owner_user_id: Number.isFinite(ownerUserId) ? ownerUserId : null,
        route_code: routeCode,
        show_on_home: showOnHome
      })
    });
    const message = "Process settings updated";
    if (wantsJson(req)) {
      return res.json({ ok: true, message });
    }
    return res.redirect(`/admin?notice=${encodeURIComponent(message)}`);
  });

  router.post("/domain", (req, res) => {
    const domain = String(req.body?.allowed_domain ?? "").trim().toLowerCase();
    const value = domain.length > 0 ? domain : null;
    updateAllowedDomain(db, value, req.user?.id ?? null);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.domain.update",
      targetUserId: null,
      detailsJson: JSON.stringify({ allowed_domain: value })
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "Domain updated" });
    }
    return res.redirect("/admin?notice=Domain updated");
  });

  router.post("/https", (req, res) => {
    const requireHttps = req.body?.require_https ? 1 : 0;
    updateRequireHttps(db, requireHttps, req.user?.id ?? null);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.https.update",
      targetUserId: null,
      detailsJson: JSON.stringify({ require_https: requireHttps })
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "HTTPS setting updated" });
    }
    return res.redirect("/admin?notice=HTTPS setting updated");
  });

  router.post("/email-providers", ADMIN_ACTION_LIMITER, (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const apiKey = String(req.body?.api_key ?? "").trim();
    if (!name || name.length > 120) return sendAdminInputError(req, res, "Connection name must contain 1 to 120 characters");
    if (!apiKey) return sendAdminInputError(req, res, "Resend API key is required");
    if (!hasAppSettingsEncryptionKey()) return sendAdminInputError(req, res, "Set APP_SETTINGS_ENCRYPTION_KEY before saving a Resend API key");
    try {
      const id = createResendProviderProfile(db, { name, apiKeyCiphertext: encryptAppSetting(apiKey), actorUserId: req.user?.id ?? null });
      insertAudit(db, { actorUserId: req.user?.id ?? null, action: "admin.email_provider.create", targetUserId: null, detailsJson: JSON.stringify({ provider_id: id, name, provider_kind: "resend", has_api_key: true }) });
      return sendAdminSuccess(req, res, "Resend connection saved");
    } catch (error) {
      return sendAdminInputError(req, res, error instanceof AppSettingsEncryptionError ? error.message : "Resend connection could not be saved");
    }
  });

  router.post("/email-providers/:id/delete", ADMIN_ACTION_LIMITER, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return sendAdminInputError(req, res, "Invalid email connection");
    deleteEmailProviderProfile(db, id);
    insertAudit(db, { actorUserId: req.user?.id ?? null, action: "admin.email_provider.delete", targetUserId: null, detailsJson: JSON.stringify({ provider_id: id }) });
    return sendAdminSuccess(req, res, "Resend connection deleted");
  });

  router.post("/email-senders", ADMIN_ACTION_LIMITER, (req, res) => {
    const providerProfileId = Number(req.body?.provider_profile_id);
    const purpose = String(req.body?.purpose ?? "").trim() as EmailPurpose;
    const name = String(req.body?.name ?? "").trim();
    const fromName = String(req.body?.from_name ?? "").trim();
    const fromEmail = normalizeEmail(String(req.body?.from_email ?? ""));
    const replyTo = normalizeEmail(String(req.body?.reply_to ?? ""));
    if (!Number.isFinite(providerProfileId)) return sendAdminInputError(req, res, "Choose a Resend connection");
    if (!listEmailProviderProfiles(db).some((profile) => profile.id === providerProfileId)) return sendAdminInputError(req, res, "Resend connection not found", 404);
    if (!EMAIL_PURPOSES.includes(purpose)) return sendAdminInputError(req, res, "Choose a valid sender purpose");
    if (!name || name.length > 120 || !isSafeEmail(fromEmail) || (replyTo && !isSafeEmail(replyTo))) return sendAdminInputError(req, res, "Enter a sender name, a valid From address, and an optional valid Reply-To address");
    const id = createEmailSenderProfile(db, { provider_profile_id: providerProfileId, purpose, name, from_name: fromName || null, from_email: fromEmail, reply_to: replyTo || null, makeDefault: Boolean(req.body?.is_default), actorUserId: req.user?.id ?? null });
    insertAudit(db, { actorUserId: req.user?.id ?? null, action: "admin.email_sender.create", targetUserId: null, detailsJson: JSON.stringify({ sender_id: id, provider_profile_id: providerProfileId, purpose, name, from_email: fromEmail, reply_to: replyTo || null }) });
    return sendAdminSuccess(req, res, "Sender profile saved");
  });

  router.post("/email-senders/:id/delete", ADMIN_ACTION_LIMITER, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return sendAdminInputError(req, res, "Invalid sender profile");
    deleteEmailSenderProfile(db, id);
    insertAudit(db, { actorUserId: req.user?.id ?? null, action: "admin.email_sender.delete", targetUserId: null, detailsJson: JSON.stringify({ sender_id: id }) });
    return sendAdminSuccess(req, res, "Sender profile deleted");
  });

  router.post("/email-senders/:id/test", ADMIN_ACTION_LIMITER, async (req, res) => {
    const id = Number(req.params.id);
    const recipient = normalizeEmail(String(req.body?.recipient ?? req.user?.email ?? ""));
    if (!Number.isFinite(id) || !isSafeEmail(recipient)) return sendAdminInputError(req, res, "Enter a valid test recipient");
    const delivered = await sendTestEmail(db, id, recipient);
    insertAudit(db, { actorUserId: req.user?.id ?? null, action: "admin.email_sender.test", targetUserId: null, detailsJson: JSON.stringify({ sender_id: id, recipient, delivered }) });
    return delivered ? sendAdminSuccess(req, res, "Test email accepted by Resend") : sendAdminInputError(req, res, "Test email could not be sent");
  });

  router.post("/ai-providers", ADMIN_ACTION_LIMITER, (req, res) => {
    const parsed = parseLlmProviderProfileInput(req.body, false);
    if ("error" in parsed) return sendAdminInputError(req, res, parsed.error);
    try {
      const profile = createLlmProviderProfile(db, {
        ...parsed.value,
        createdByUserId: req.user?.id ?? null
      });
      insertAudit(db, {
        actorUserId: req.user?.id ?? null,
        action: "admin.llm_provider.create",
        targetUserId: null,
        detailsJson: JSON.stringify(llmProviderAuditDetails(profile))
      });
      return sendAdminSuccess(req, res, "AI provider profile created", { profile });
    } catch (error) {
      return sendLlmProviderError(req, res, error);
    }
  });

  router.post("/ai-providers/:id", ADMIN_ACTION_LIMITER, (req, res) => {
    const profileId = Number(req.params.id);
    if (!Number.isFinite(profileId)) return sendAdminInputError(req, res, "Invalid AI provider profile");
    if (!getLlmProviderProfile(db, profileId)) return sendAdminInputError(req, res, "AI provider profile not found", 404);
    const parsed = parseLlmProviderProfileInput(req.body, true);
    if ("error" in parsed) return sendAdminInputError(req, res, parsed.error);
    try {
      const profile = updateLlmProviderProfile(db, profileId, parsed.value);
      if (!profile) return sendAdminInputError(req, res, "AI provider profile not found", 404);
      insertAudit(db, {
        actorUserId: req.user?.id ?? null,
        action: "admin.llm_provider.update",
        targetUserId: null,
        detailsJson: JSON.stringify(llmProviderAuditDetails(profile))
      });
      return sendAdminSuccess(req, res, "AI provider profile updated", { profile });
    } catch (error) {
      return sendLlmProviderError(req, res, error);
    }
  });

  router.post("/ai-providers/:id/delete", ADMIN_ACTION_LIMITER, (req, res) => {
    const profileId = Number(req.params.id);
    if (!Number.isFinite(profileId)) return sendAdminInputError(req, res, "Invalid AI provider profile");
    const profile = getLlmProviderProfile(db, profileId);
    if (!profile) return sendAdminInputError(req, res, "AI provider profile not found", 404);
    deleteLlmProviderProfile(db, profileId);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.llm_provider.delete",
      targetUserId: null,
      detailsJson: JSON.stringify(llmProviderAuditDetails(profile))
    });
    return sendAdminSuccess(req, res, "AI provider profile deleted");
  });

  router.post("/users", ADMIN_ACTION_LIMITER, async (req, res) => {
    const email = normalizeEmail(String(req.body?.email ?? ""));
    const name = String(req.body?.name ?? "").trim() || null;
    const role = String(req.body?.role ?? "").trim() || null;
    const status = String(req.body?.status ?? "ACTIVE").trim() || "ACTIVE";
    if (!email) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Email required" });
      }
      return res.redirect("/admin?error=Email required");
    }

    let userId: number | null = null;
    try {
      userId = createUser(db, {
        email,
        name,
        passwordHash: null,
        role,
        status,
        tempPassword: 0
      });
      const setup = createPasswordSetupToken(db, userId);
      const setupPath = `/auth/set-password/${encodeURIComponent(setup.token)}`;
      const emailConfigured = isEmailConfigured(db);
      const emailed = emailConfigured && await sendPasswordSetupEmail(db, email, setupPath);
      insertAudit(db, {
        actorUserId: req.user?.id ?? null,
        action: "admin.user.create",
        targetUserId: userId,
        detailsJson: JSON.stringify({ email, name, role, status })
      });
      const notice = emailed
        ? "User created; the password setup link was emailed and is also shown to you."
        : emailConfigured
          ? "User created; Resend did not accept the password setup email, so copy the one-time link."
          : "User created; configure APP_ORIGIN and a default auth sender before relying on email, then copy the one-time link.";
      if (wantsJson(req)) {
        return res.json({ ok: true, message: notice, setupPath, emailSent: emailed, emailConfigured, expiresAt: setup.expiresAt });
      }
      return res.redirect(`/admin?notice=${encodeURIComponent(notice)}`);
    } catch {
      if (userId) deleteUser(db, userId);
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Failed to create user (maybe duplicate email)" });
      }
      return res.redirect("/admin?error=Failed to create user (maybe duplicate email)");
    }
  });

  router.post("/users/:id", ADMIN_ACTION_LIMITER, (req, res) => {
    const id = Number(req.params.id);
    const email = normalizeEmail(String(req.body?.email ?? ""));
    const name = String(req.body?.name ?? "").trim() || null;
    const role = String(req.body?.role ?? "").trim() || null;
    const status = String(req.body?.status ?? "ACTIVE").trim() || "ACTIVE";
    if (!email || Number.isNaN(id)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid user" });
      }
      return res.redirect("/admin?error=Invalid user");
    }
    updateUser(db, id, { name, email, role, status });
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.user.update",
      targetUserId: id,
      detailsJson: JSON.stringify({ email, name, role, status })
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "User updated" });
    }
    return res.redirect("/admin?notice=User updated");
  });

  router.post("/users/:id/ban", ADMIN_ACTION_LIMITER, (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid user" });
      }
      return res.redirect("/admin?error=Invalid user");
    }
    setUserStatus(db, id, "DISABLED");
    deleteSessionsByUser(db, id);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.user.ban",
      targetUserId: id,
      detailsJson: null
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "User banned" });
    }
    return res.redirect("/admin?notice=User banned");
  });

  router.post("/users/:id/unban", ADMIN_ACTION_LIMITER, (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid user" });
      }
      return res.redirect("/admin?error=Invalid user");
    }
    setUserStatus(db, id, "ACTIVE");
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.user.unban",
      targetUserId: id,
      detailsJson: null
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "User unbanned" });
    }
    return res.redirect("/admin?notice=User unbanned");
  });

  router.post("/users/:id/force-logout", ADMIN_ACTION_LIMITER, (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid user" });
      }
      return res.redirect("/admin?error=Invalid user");
    }
    deleteSessionsByUser(db, id);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.user.force_logout",
      targetUserId: id,
      detailsJson: null
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "User logged out" });
    }
    return res.redirect("/admin?notice=User logged out");
  });

  router.post("/users/:id/delete", ADMIN_ACTION_LIMITER, (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid user" });
      }
      return res.redirect("/admin?error=Invalid user");
    }
    deleteSessionsByUser(db, id);
    deleteUser(db, id);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.user.delete",
      targetUserId: id,
      detailsJson: null
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "User deleted" });
    }
    return res.redirect("/admin?notice=User deleted");
  });

  router.post("/experiments/:id/owner", ADMIN_ACTION_LIMITER, (req, res) => {
    const experimentId = Number(req.params.id);
    const ownerUserId = req.body?.owner_user_id ? Number(req.body.owner_user_id) : null;
    if (!Number.isFinite(experimentId)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid experiment" });
      }
      return res.redirect("/admin?error=Invalid experiment");
    }
    if (req.body?.owner_user_id && !Number.isFinite(ownerUserId)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid owner" });
      }
      return res.redirect("/admin?error=Invalid owner");
    }
    updateExperimentOwner(db, experimentId, Number.isFinite(ownerUserId) ? ownerUserId : null);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.experiment.owner_update",
      targetUserId: Number.isFinite(ownerUserId) ? ownerUserId : null,
      detailsJson: JSON.stringify({ experiment_id: experimentId })
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "Experiment owner updated" });
    }
    return res.redirect("/admin?notice=Experiment owner updated");
  });

  router.post("/experiments/:id/restore", ADMIN_ACTION_LIMITER, (req, res) => {
    const experimentId = Number(req.params.id);
    const ownerUserId = req.body?.owner_user_id ? Number(req.body.owner_user_id) : null;
    if (!Number.isFinite(experimentId)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid experiment" });
      }
      return res.redirect("/admin?error=Invalid experiment");
    }
    restoreExperiment(db, experimentId, Number.isFinite(ownerUserId) ? ownerUserId : null);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.experiment.restore",
      targetUserId: Number.isFinite(ownerUserId) ? ownerUserId : null,
      detailsJson: JSON.stringify({ experiment_id: experimentId })
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "Experiment restored" });
    }
    return res.redirect("/admin?notice=Experiment restored");
  });

  router.post("/experiments/:id/delete", ADMIN_ACTION_LIMITER, (req, res) => {
    const experimentId = Number(req.params.id);
    if (!Number.isFinite(experimentId)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid experiment" });
      }
      return res.redirect("/admin?error=Invalid experiment");
    }
    const experiment = getExperiment(db, experimentId);
    if (!experiment) {
      if (wantsJson(req)) {
        return res.status(404).json({ ok: false, message: "Experiment not found" });
      }
      return res.redirect("/admin?error=Experiment not found");
    }
    if (!experiment.archived_at) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Experiment must be archived first" });
      }
      return res.redirect("/admin?error=Experiment must be archived first");
    }
    deleteExperiment(db, experimentId);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.experiment.delete",
      targetUserId: null,
      detailsJson: JSON.stringify({ experiment_id: experimentId })
    });
    if (wantsJson(req)) {
      return res.json({ ok: true, message: "Experiment deleted" });
    }
    return res.redirect("/admin?notice=Experiment deleted");
  });

  router.post("/users/:id/reset-password", ADMIN_ACTION_LIMITER, async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, message: "Invalid user" });
      }
      return res.redirect("/admin?error=Invalid user");
    }

    const user = findUserById(db, id);
    if (!user) {
      if (wantsJson(req)) return res.status(404).json({ ok: false, message: "User not found" });
      return res.redirect("/admin?error=User not found");
    }
    const setup = createPasswordSetupToken(db, id, true);
    const setupPath = `/auth/set-password/${encodeURIComponent(setup.token)}`;
    const emailConfigured = isEmailConfigured(db);
    const emailed = emailConfigured && await sendPasswordSetupEmail(db, user.email, setupPath);

    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "admin.user.reset_password",
      targetUserId: id,
      detailsJson: null
    });

    const message = emailed
      ? "Password reset link emailed and shown to you; existing sessions were revoked."
      : emailConfigured
        ? "Resend did not accept the password reset email; the link is shown to you. Existing sessions were revoked."
        : "Password reset email was not attempted: configure APP_ORIGIN and a default auth sender. The link is shown to you; existing sessions were revoked.";
    if (wantsJson(req)) return res.json({ ok: true, message, setupPath, emailSent: emailed, emailConfigured, expiresAt: setup.expiresAt });
    return res.redirect(`/admin?notice=${encodeURIComponent(message)}`);
  });

  return router;
}

type AiUsagePeriod = {
  key: "7d" | "30d" | "90d" | "all";
  label: string;
  from?: string;
};

function aiUsagePeriodFromQuery(value: unknown): AiUsagePeriod {
  if (value === "7d") return aiUsagePeriodForDays("7d", 7);
  if (value === "30d") return aiUsagePeriodForDays("30d", 30);
  if (value === "90d") return aiUsagePeriodForDays("90d", 90);
  return { key: "all", label: "All time" };
}

function aiUsagePeriodForDays(key: "7d" | "30d" | "90d", days: number): AiUsagePeriod {
  return {
    key,
    label: `Last ${days} days`,
    from: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  };
}

function parseLlmProviderProfileInput(
  body: Record<string, unknown> | undefined,
  isUpdate: boolean
): { value: Omit<SaveLlmProviderProfileInput, "createdByUserId"> } | { error: string } {
  const name = String(body?.name ?? "").trim();
  if (!name || name.length > 120) return { error: "Profile name must contain 1 to 120 characters" };
  const providerKind = String(body?.provider_kind ?? "").trim();
  if (providerKind !== "openai_compatible" && providerKind !== "ollama") {
    return { error: "Choose OpenAI-compatible or Ollama" };
  }
  const baseUrl = normalizeLlmBaseUrl(String(body?.base_url ?? ""));
  if (!baseUrl) return { error: "Provider URL must be a valid HTTP or HTTPS URL without credentials" };
  const model = String(body?.model ?? "").trim();
  if (!model || model.length > 200) return { error: "Model name must contain 1 to 200 characters" };
  const maxOutputTokens = boundedInteger(body?.max_output_tokens, 64, 32768);
  if (maxOutputTokens === null) return { error: "Maximum output tokens must be between 64 and 32768" };
  const temperature = boundedNumber(body?.temperature, 0, 2);
  if (temperature === null) return { error: "Temperature must be between 0 and 2" };
  const timeoutMs = boundedInteger(body?.timeout_ms, 1000, 120000);
  if (timeoutMs === null) return { error: "Timeout must be between 1000 and 120000 ms" };
  const enabled = Boolean(body?.enabled);
  const defaultForDoe = Boolean(body?.default_for_doe);
  if (defaultForDoe && !enabled) return { error: "A default DOE provider must be enabled" };

  const typedApiKey = String(body?.api_key ?? "").trim();
  const clearApiKey = Boolean(body?.clear_api_key);
  if (typedApiKey && !hasLlmSettingsEncryptionKey()) {
    return { error: "Set LLM_SETTINGS_ENCRYPTION_KEY before saving an API key" };
  }
  if (typedApiKey && clearApiKey) return { error: "Enter a replacement API key or clear it, not both" };
  const apiKey = typedApiKey ? typedApiKey : clearApiKey ? null : isUpdate ? undefined : null;

  return {
    value: {
      name,
      providerKind: providerKind as LlmProviderKind,
      baseUrl,
      model,
      maxOutputTokens,
      temperature,
      timeoutMs,
      enabled,
      defaultForDoe,
      apiKey
    }
  };
}

function normalizeLlmBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function llmProviderAuditDetails(profile: LlmProviderProfile) {
  return {
    profile_id: profile.id,
    name: profile.name,
    provider_kind: profile.providerKind,
    base_url: profile.baseUrl,
    model: profile.model,
    enabled: profile.enabled,
    default_for_doe: profile.defaultForDoe,
    has_api_key: profile.hasApiKey
  };
}

function sendAdminInputError(req: express.Request, res: express.Response, message: string, status = 400) {
  if (wantsJson(req)) return res.status(status).json({ ok: false, message });
  return res.redirect(`/admin?error=${encodeURIComponent(message)}`);
}

function sendAdminSuccess(req: express.Request, res: express.Response, message: string, extra: Record<string, unknown> = {}) {
  if (wantsJson(req)) return res.json({ ok: true, message, ...extra });
  return res.redirect(`/admin?notice=${encodeURIComponent(message)}`);
}

function sendLlmProviderError(req: express.Request, res: express.Response, error: unknown) {
  const message = error instanceof LlmSettingsEncryptionError
    ? error.message
    : "AI provider profile could not be saved";
  return sendAdminInputError(req, res, message);
}
