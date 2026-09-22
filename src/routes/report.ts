import express from "express";
import type { Db } from "../db.js";
import {
  buildReport,
  buildQualificationCsv,
  buildDoeCsv,
  buildOutputsCsv,
  buildReportEditorSeed,
  buildReportWorkspaceOutline,
  buildReportWorkspaceOutlineMarkdown,
  buildReportWorkspaceSources,
  buildDoeReportAnalysis,
  buildDoeReportRunsPage
} from "../services/report_service.js";
import type { ReportTemplateType } from "../services/report_service.js";
import { htmlToMarkdown, markdownToSafeHtml } from "../services/markdown_service.js";
import { buildReportDocx } from "../services/docx_report_service.js";
import {
  deleteReportConfig,
  clearReportSignatureSubmission,
  getReportConfig,
  getReportDocument,
  isReportNumberInUse,
  signReportConfig,
  submitReportForSignature,
  unsignReportConfig,
  updateReportSetup,
  upsertReportDocument
} from "../repos/reports_repo.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { findUserById, listUsers } from "../repos/users_repo.js";
import { ensureExperimentAccess, ensureReportAccess } from "../middleware/experiment_access.js";
import { assignEntityResponsibility, syncReportTaskSignature } from "../services/entity_assignment_service.js";

const parseInclude = (raw: unknown) => {
  if (!raw) return null;
  return String(raw)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
};

const parseIdList = (raw: unknown) => {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((item) => Number(item))
    .filter((val) => Number.isFinite(val));
};

const parseReportType = (raw: unknown): ReportTemplateType | null => {
  const value = String(raw ?? "").trim().toUpperCase();
  return value === "QUALIFICATION" || value === "DOE" || value === "COMBINED" ? value : null;
};

const signatureDueDate = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const isEmptyWorkspaceDocument = (document: { content_json: string; html_snapshot: string | null } | null) => {
  if (!document || document.html_snapshot?.trim() !== "<p></p>") return false;
  try {
    const content = JSON.parse(document.content_json) as {
      type?: string;
      content?: Array<{ type?: string; content?: unknown[] }>;
    };
    return content.type === "doc"
      && content.content?.length === 1
      && content.content[0]?.type === "paragraph"
      && !content.content[0]?.content?.length;
  } catch {
    return false;
  }
};

export function createReportRouter(db: Db) {
  const router = express.Router();
  const hasRole = (req: express.Request, roles: string[]) => roles.includes(req.user?.role ?? "");
  const canEditReportDocument = (req: express.Request, config: ReturnType<typeof getReportConfig>) => {
    if (!config) return false;
    if (req.user?.role === "admin") return true;
    const experiment = getExperiment(db, config.experiment_id);
    const currentEditorId = config.submitted_for_signature_at
      ? config.responsible_user_id
      : (config.author_user_id ?? experiment?.owner_user_id ?? null);
    return Boolean(req.user?.id && currentEditorId === req.user.id && !config.signed_at);
  };

  router.use("/experiments/:id", ensureExperimentAccess(db));
  router.use("/reports/:reportId", ensureReportAccess(db));

  router.get("/experiments/:id/report", (req, res) => {
    const experimentId = Number(req.params.id);
    const include = parseInclude(req.query.include);
    const doeIds = parseIdList(req.query.doe);
    const executors = req.query.executors ? String(req.query.executors) : null;
    const options = {
      includeQualification: include === null ? true : include.includes("qualification"),
      includeDoe: include === null ? false : include.includes("doe"),
      includeOutputs: include === null ? false : include.includes("outputs"),
      includeDefects: include === null ? false : include.includes("defects"),
      includeRawRuns: include === null ? false : include.includes("raw"),
      executors,
      doeIds
    };
    const reportData = buildReport(db, experimentId, options);
    res.render("report", { report: reportData, options });
  });

  router.get("/reports/:reportId", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    let include: string[] = [];
    let doeIds: number[] = [];
    if (config.include_json) {
      try {
        const parsed = JSON.parse(config.include_json);
        if (Array.isArray(parsed)) include = parsed.map((item) => String(item).toLowerCase());
      } catch {
        include = [];
      }
    }
    if (config.doe_ids_json) {
      try {
        const parsed = JSON.parse(config.doe_ids_json);
        if (Array.isArray(parsed)) doeIds = parsed.map((item) => Number(item)).filter(Number.isFinite);
      } catch {
        doeIds = [];
      }
    }
    const options = {
      includeQualification: include.includes("qualification"),
      includeDoe: include.includes("doe"),
      includeOutputs: include.includes("outputs"),
      includeDefects: include.includes("defects"),
      includeRawRuns: include.includes("raw"),
      executors: config.executors,
      doeIds
    };
    const reportData = buildReport(db, config.experiment_id, options);
    const signer = config.signed_by_user_id ? findUserById(db, config.signed_by_user_id) : null;
    const author = config.author_user_id ? findUserById(db, config.author_user_id) : null;
    const responsible = config.responsible_user_id ? findUserById(db, config.responsible_user_id) : null;
    const experiment = getExperiment(db, config.experiment_id);
    // Existing reports created before report-specific descriptions get the
    // experiment text as a one-time editable starting value in the setup UI.
    const reportDescription = config.description ?? reportData.experiment.notes ?? "";
    const isResponsible = Boolean(req.user?.id && config.responsible_user_id === req.user.id);
    const isLegacyOwnerSigner = !config.responsible_user_id && Boolean(req.user?.id && experiment?.owner_user_id === req.user.id);
    const canSignReport = Boolean(
      !config.signed_at && ((config.submitted_for_signature_at && isResponsible) || isLegacyOwnerSigner)
    ) || Boolean(config.signed_at && (isResponsible || isLegacyOwnerSigner));
    const canManageReportSetup = req.user?.role === "admin" || req.user?.role === "manager";
    const canEditReportSetup = (canManageReportSetup || req.user?.id === config.author_user_id)
      && !config.signed_at
      && !config.submitted_for_signature_at;
    const canSubmitForSignature = Boolean(
      !config.signed_at
        && !config.submitted_for_signature_at
        && config.author_user_id
        && config.responsible_user_id
        && (req.user?.id === config.author_user_id || req.user?.role === "admin" || req.user?.role === "manager")
    );
    const canRecallSignatureSubmission = Boolean(
      !config.signed_at
        && config.submitted_for_signature_at
        && (req.user?.id === config.author_user_id || req.user?.role === "admin" || req.user?.role === "manager")
    );
    res.render("report", {
      report: reportData,
      options,
      reportConfig: config,
      signer,
      author,
      responsible,
      reportDescription,
      assignableUsers: canManageReportSetup ? listUsers(db).filter((user) => user.status === "ACTIVE") : [],
      canSignReport,
      canEditReportSetup,
      canManageReportSetup,
      canOpenTextEditor: canEditReportDocument(req, config),
      canSubmitForSignature,
      canRecallSignatureSubmission
    });
  });

  router.post("/reports/:reportId/setup", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (config.signed_at) return res.status(403).send("Signed report cannot be edited.");
    if (config.submitted_for_signature_at) {
      return res.status(403).send("Recall the report from signature before editing it.");
    }
    const canManageSetup = req.user?.role === "admin" || req.user?.role === "manager";
    const isAuthor = req.user?.id === config.author_user_id;
    if (!canManageSetup && !isAuthor) {
      return res.status(403).send("Only the report author can edit this setup.");
    }
    const name = String(req.body?.name ?? "").trim();
    const description = String(req.body?.description ?? "").trim();
    const parseUserId = (raw: unknown) => {
      const value = String(raw ?? "").trim();
      if (!value) return null;
      const id = Number(value);
      const user = Number.isFinite(id) ? findUserById(db, id) : null;
      return user?.status === "ACTIVE" ? id : undefined;
    };
    const authorUserId = canManageSetup ? parseUserId(req.body?.author_user_id) : config.author_user_id;
    const responsibleUserId = canManageSetup ? parseUserId(req.body?.responsible_user_id) : config.responsible_user_id;
    const dueAtRaw = canManageSetup ? String(req.body?.due_at ?? "").trim() : (config.due_at ?? "");
    const reportNumber = canManageSetup ? String(req.body?.report_number ?? "").trim() : (config.report_number ?? `RPT-${reportId}`);
    const reportType = canManageSetup ? parseReportType(req.body?.report_type) : config.report_type;
    const templateCode = reportType ? `standard-${reportType.toLowerCase()}` : "";
    const signatureSlaDays = canManageSetup ? Number(req.body?.signature_sla_days) : config.signature_sla_days;
    if (!name || name.length > 160) return res.status(400).send("Report name must be between 1 and 160 characters.");
    if (description.length > 4000) return res.status(400).send("Description is too long.");
    if (authorUserId === undefined || responsibleUserId === undefined) return res.status(400).send("Selected user is not active.");
    if (dueAtRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueAtRaw)) return res.status(400).send("Invalid due date.");
    if (!reportNumber || reportNumber.length > 64) return res.status(400).send("Report number must be between 1 and 64 characters.");
    if (isReportNumberInUse(db, reportNumber, reportId)) return res.status(400).send("Report number is already in use.");
    if (!reportType) return res.status(400).send("Invalid report template.");
    if (!Number.isInteger(signatureSlaDays) || signatureSlaDays < 0 || signatureSlaDays > 30) return res.status(400).send("Signature SLA must be between 0 and 30 days.");
    updateReportSetup(db, reportId, {
      name,
      // An empty string means the report author intentionally cleared this
      // copy; null is reserved for legacy reports that still need a fallback.
      description,
      author_user_id: authorUserId,
      responsible_user_id: responsibleUserId,
      due_at: dueAtRaw || null,
      report_number: reportNumber,
      report_type: reportType,
      template_code: templateCode,
      signature_sla_days: signatureSlaDays
    });
    const experiment = getExperiment(db, config.experiment_id);
    if (experiment) {
      assignEntityResponsibility(db, {
        experimentId: config.experiment_id,
        entityType: "report",
        entityId: reportId,
        assigneeUserId: authorUserId,
        assignedByUserId: req.user?.id ?? null,
        experimentName: experiment.name,
        dueAt: dueAtRaw || null,
        taskTitle: `Write report: ${name}`,
        taskDescription: description || null
      });
    }
    return res.redirect(`/reports/${reportId}`);
  });

  router.post("/reports/:reportId/submit-for-signature", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (config.signed_at) return res.status(403).send("Signed report cannot be submitted.");
    if (!config.author_user_id || !config.responsible_user_id) {
      return res.status(400).send("Assign both an author and a responsible signer before submitting.");
    }
    const canSubmit = req.user?.id === config.author_user_id || req.user?.role === "admin" || req.user?.role === "manager";
    if (!canSubmit) return res.status(403).send("Only the report author can submit it for signature.");
    const experiment = getExperiment(db, config.experiment_id);
    if (!experiment) return res.status(404).send("Experiment not found");
    const signatureDueAt = signatureDueDate(config.signature_sla_days);
    submitReportForSignature(db, reportId, req.user!.id, signatureDueAt);
    assignEntityResponsibility(db, {
      experimentId: config.experiment_id,
      entityType: "report",
      entityId: reportId,
      assigneeUserId: config.responsible_user_id,
      assignedByUserId: req.user!.id,
      experimentName: experiment.name,
      dueAt: signatureDueAt,
      taskTitle: `Sign report: ${config.name}`,
      taskDescription: config.description || "Awaiting review and signature."
    });
    return res.redirect(`/reports/${reportId}`);
  });

  router.post("/reports/:reportId/recall-from-signature", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (!config.submitted_for_signature_at || config.signed_at) {
      return res.status(403).send("This report cannot be recalled.");
    }
    const canRecall = req.user?.id === config.author_user_id || req.user?.role === "admin" || req.user?.role === "manager";
    if (!canRecall) return res.status(403).send("Only the report author can recall it.");
    const experiment = getExperiment(db, config.experiment_id);
    if (!experiment) return res.status(404).send("Experiment not found");
    clearReportSignatureSubmission(db, reportId);
    assignEntityResponsibility(db, {
      experimentId: config.experiment_id,
      entityType: "report",
      entityId: reportId,
      assigneeUserId: config.author_user_id,
      assignedByUserId: req.user!.id,
      experimentName: experiment.name,
      dueAt: config.due_at,
      taskTitle: `Write report: ${config.name}`,
      taskDescription: config.description || null
    });
    return res.redirect(`/reports/${reportId}`);
  });

  router.get("/reports/:reportId/editor", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (!canEditReportDocument(req, config)) return res.status(403).send("Only the current report task owner can edit the document.");
    let include: string[] = [];
    let doeIds: number[] = [];
    if (config.include_json) {
      try {
        const parsed = JSON.parse(config.include_json);
        if (Array.isArray(parsed)) include = parsed.map((item) => String(item).toLowerCase());
      } catch {
        include = [];
      }
    }
    if (config.doe_ids_json) {
      try {
        const parsed = JSON.parse(config.doe_ids_json);
        if (Array.isArray(parsed)) doeIds = parsed.map((item) => Number(item)).filter(Number.isFinite);
      } catch {
        doeIds = [];
      }
    }
    const options = {
      includeQualification: include.includes("qualification"),
      includeDoe: include.includes("doe"),
      includeOutputs: include.includes("outputs"),
      includeDefects: include.includes("defects"),
      includeRawRuns: include.includes("raw"),
      executors: config.executors,
      doeIds
    };
    const reportData = buildReport(db, config.experiment_id, { ...options, includeQualification: true });
    let existingDoc = getReportDocument(db, reportId);
    // Upgrade only the empty one-paragraph drafts created by the first
    // workspace shell. Documents containing author content are never changed.
    if (isEmptyWorkspaceDocument(existingDoc)) {
      upsertReportDocument(
        db,
        reportId,
        JSON.stringify(buildReportWorkspaceOutline(config.report_type)),
        null,
        buildReportWorkspaceOutlineMarkdown(config.report_type),
        "tiptap",
        1
      );
      existingDoc = getReportDocument(db, reportId);
    }
    const generatedAt = new Date().toLocaleString();
    let seedData: unknown;
    if (existingDoc) {
      try {
        seedData = JSON.parse(existingDoc.content_json);
      } catch {
        seedData = buildReportEditorSeed(reportData, generatedAt, config.name);
      }
    } else {
      seedData = buildReportEditorSeed(reportData, generatedAt, config.name);
    }
    res.render("report_editor", {
      report: reportData,
      reportConfig: config,
      editorData: seedData,
      sourceCatalog: buildReportWorkspaceSources(db, reportData),
      hasSavedDoc: Boolean(existingDoc),
      htmlSnapshot: existingDoc?.html_snapshot ?? ""
    });
  });

  router.post("/reports/:reportId/editor", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (!canEditReportDocument(req, config)) return res.status(403).send("Only the current report task owner can edit the document.");
    const contentJson = typeof req.body.content_json === "string" ? req.body.content_json : "";
    const htmlSnapshot = typeof req.body.html_snapshot === "string" ? req.body.html_snapshot : null;
    const contentMdRaw = typeof req.body.content_md === "string" ? req.body.content_md : null;
    if (!contentJson) return res.status(400).send("Missing content");
    const contentMd = contentMdRaw ?? (htmlSnapshot ? htmlToMarkdown(htmlSnapshot) : null);
    upsertReportDocument(db, reportId, contentJson, htmlSnapshot, contentMd, "tiptap", 1);
    res.json({ ok: true });
  });

  // These endpoints are intentionally scoped through the report access
  // middleware above. The editor asks for the selected study only when its
  // dialog opens, rather than serialising potentially hundreds of DOE runs
  // into the report page.
  router.get("/reports/:reportId/sources/doe/:doeId/analysis", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).json({ error: "Report not found" });
    const data = buildDoeReportAnalysis(
      db,
      config.experiment_id,
      Number(req.params.doeId),
      typeof req.query.mode === "string" ? req.query.mode : undefined,
      Number(req.query.output),
      Number(req.query.factor),
      Number(req.query.second_factor)
    );
    if (!data) return res.status(404).json({ error: "DOE study not found" });
    return res.json(data);
  });

  router.get("/reports/:reportId/sources/doe/:doeId/runs", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).json({ error: "Report not found" });
    const data = buildDoeReportRunsPage(
      db,
      config.experiment_id,
      Number(req.params.doeId),
      Number(req.query.page),
      Number(req.query.page_size)
    );
    if (!data) return res.status(404).json({ error: "DOE study not found" });
    return res.json(data);
  });

  router.get("/reports/:reportId/export.docx", async (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    const experiment = getExperiment(db, config.experiment_id);
    if (!experiment) return res.status(404).send("Experiment not found");
    const savedDocument = getReportDocument(db, reportId);
    let document = buildReportWorkspaceOutline();
    if (savedDocument?.content_json) {
      try {
        const parsed = JSON.parse(savedDocument.content_json) as { type?: string; content?: unknown[] };
        if (parsed.type === "doc" && Array.isArray(parsed.content)) {
          document = { type: "doc", content: parsed.content as Array<{ type: string }> };
        }
      } catch {
        // A malformed draft must not make export unavailable; export the
        // standard report outline instead.
      }
    }
    const signer = config.signed_by_user_id ? findUserById(db, config.signed_by_user_id) : null;
    const signerName = signer?.name?.trim() || signer?.email || null;
    const author = config.author_user_id ? findUserById(db, config.author_user_id) : null;
    const authorName = author?.name?.trim() || author?.email || config.executors;
    const host = req.get("host") || "localhost";
    try {
      const file = await buildReportDocx({
        reportId,
        reportNumber: config.report_number,
        reportType: config.report_type,
        reportName: config.name || `Experiment report #${reportId}`,
        experimentName: experiment.name,
        description: config.description ?? experiment.notes,
        executors: authorName,
        signedAt: config.signed_at,
        signerName,
        submittedForSignatureAt: config.submitted_for_signature_at,
        signatureDueAt: config.signature_due_at,
        generatedAt: new Date(),
        document,
        baseUrl: `${req.protocol}://${host}`
      });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.attachment(`report-${reportId}.docx`);
      return res.send(file);
    } catch (error) {
      console.error("DOCX export failed", error);
      return res.status(500).send("DOCX export failed");
    }
  });

  router.get("/reports/:reportId/editor/print", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    const existingDoc = getReportDocument(db, reportId);
    // Never inject a saved editor HTML snapshot into the print document. The
    // Markdown renderer only emits an explicit safe HTML subset.
    const markdown = existingDoc?.content_md?.trim() || htmlToMarkdown(existingDoc?.html_snapshot ?? "");
    const htmlContent = markdownToSafeHtml(markdown) || "<p>Report content is empty.</p>";
    res.render("report_editor_print", {
      reportConfig: config,
      htmlContent,
      exportedAt: new Date().toLocaleString()
    });
  });

  router.post("/reports/:reportId/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager"])) {
      return res.status(403).send("Forbidden");
    }
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (config.signed_at) return res.status(403).send("Signed report cannot be deleted.");
    deleteReportConfig(db, reportId);
    res.redirect(`/experiments/${config.experiment_id}`);
  });

  router.post("/reports/:reportId/sign", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (!req.user?.id) return res.status(403).send("Forbidden");
    const experiment = getExperiment(db, config.experiment_id);
    const isLegacyOwnerSigner = !config.responsible_user_id && experiment?.owner_user_id === req.user.id;
    const isResponsibleSigner = config.responsible_user_id === req.user.id && Boolean(config.submitted_for_signature_at);
    if (!experiment || (!isResponsibleSigner && !isLegacyOwnerSigner)) {
      return res.status(403).send("Only the responsible signer can sign this report after it is submitted.");
    }
    signReportConfig(db, reportId, req.user.id);
    syncReportTaskSignature(db, {
      reportId,
      signerUserId: req.user.id,
      signedAt: new Date().toISOString()
    });
    res.redirect(`/reports/${reportId}`);
  });

  router.post("/reports/:reportId/unsign", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (!req.user?.id) return res.status(403).send("Forbidden");
    const experiment = getExperiment(db, config.experiment_id);
    const isLegacyOwnerSigner = !config.responsible_user_id && experiment?.owner_user_id === req.user.id;
    const isResponsibleSigner = config.responsible_user_id === req.user.id;
    if (!experiment || (!isResponsibleSigner && !isLegacyOwnerSigner)) {
      return res.status(403).send("Only the responsible signer can withdraw signature.");
    }
    unsignReportConfig(db, reportId);
    syncReportTaskSignature(db, { reportId, signerUserId: null, signedAt: null });
    res.redirect(`/reports/${reportId}`);
  });

  router.get("/experiments/:id/report.csv", (req, res) => {
    const experimentId = Number(req.params.id);
    const section = String(req.query.section || "qualification").toLowerCase();
    const options = {
      includeQualification: section === "qualification",
      includeDoe: section === "doe",
      includeOutputs: section === "outputs",
      includeDefects: false,
      includeRawRuns: false,
      executors: null,
      doeIds: []
    };
    const reportData = buildReport(db, experimentId, options);
    let csv = "";
    let filename = "qualification.csv";
    if (section === "doe") {
      csv = buildDoeCsv(reportData);
      filename = "doe.csv";
    } else if (section === "outputs") {
      csv = buildOutputsCsv(reportData);
      filename = "outputs.csv";
    } else {
      csv = buildQualificationCsv(reportData);
      filename = "qualification.csv";
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    res.send(csv);
  });

  return router;
}
