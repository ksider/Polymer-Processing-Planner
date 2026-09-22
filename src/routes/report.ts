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
  buildReportWorkspaceSources
} from "../services/report_service.js";
import { htmlToMarkdown, markdownToSafeHtml } from "../services/markdown_service.js";
import {
  deleteReportConfig,
  getReportConfig,
  getReportDocument,
  signReportConfig,
  unsignReportConfig,
  upsertReportDocument
} from "../repos/reports_repo.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { findUserById } from "../repos/users_repo.js";
import { ensureExperimentAccess, ensureReportAccess } from "../middleware/experiment_access.js";

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
    const experiment = getExperiment(db, config.experiment_id);
    const canSignReport = Boolean(req.user?.id && experiment?.owner_user_id === req.user.id);
    res.render("report", { report: reportData, options, reportConfig: config, signer, canSignReport });
  });

  router.get("/reports/:reportId/editor", (req, res) => {
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
    const reportData = buildReport(db, config.experiment_id, { ...options, includeQualification: true });
    let existingDoc = getReportDocument(db, reportId);
    // Upgrade only the empty one-paragraph drafts created by the first
    // workspace shell. Documents containing author content are never changed.
    if (isEmptyWorkspaceDocument(existingDoc)) {
      upsertReportDocument(
        db,
        reportId,
        JSON.stringify(buildReportWorkspaceOutline()),
        null,
        buildReportWorkspaceOutlineMarkdown(),
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
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (config.signed_at) return res.status(403).send("Report is signed and cannot be edited.");
    const contentJson = typeof req.body.content_json === "string" ? req.body.content_json : "";
    const htmlSnapshot = typeof req.body.html_snapshot === "string" ? req.body.html_snapshot : null;
    const contentMdRaw = typeof req.body.content_md === "string" ? req.body.content_md : null;
    if (!contentJson) return res.status(400).send("Missing content");
    const contentMd = contentMdRaw ?? (htmlSnapshot ? htmlToMarkdown(htmlSnapshot) : null);
    upsertReportDocument(db, reportId, contentJson, htmlSnapshot, contentMd, "tiptap", 1);
    res.json({ ok: true });
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
    if (!experiment || experiment.owner_user_id !== req.user.id) {
      return res.status(403).send("Only experiment owner can sign this report.");
    }
    signReportConfig(db, reportId, req.user.id);
    res.redirect(`/reports/${reportId}`);
  });

  router.post("/reports/:reportId/unsign", (req, res) => {
    const reportId = Number(req.params.reportId);
    const config = getReportConfig(db, reportId);
    if (!config) return res.status(404).send("Report not found");
    if (!req.user?.id) return res.status(403).send("Forbidden");
    const experiment = getExperiment(db, config.experiment_id);
    if (!experiment || experiment.owner_user_id !== req.user.id) {
      return res.status(403).send("Only experiment owner can withdraw signature.");
    }
    unsignReportConfig(db, reportId);
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
