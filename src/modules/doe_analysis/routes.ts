import express from "express";
import type { Db } from "../../db.js";
import { ensureExperimentAccess } from "../../middleware/experiment_access.js";
import { createRateLimiter } from "../../middleware/rate_limit.js";
import { getExperiment } from "../../repos/experiments_repo.js";
import { getProcessById } from "../../repos/processes_repo.js";
import { insertRuns, listRuns } from "../../repos/runs_repo.js";
import {
  buildDoeAnalysisDataset,
  DoeAnalysisDatasetNotFoundError
} from "./dataset_builder.js";
import {
  createDoeAnalyticsClient,
  DoeAnalyticsServiceError,
  type DoeAnalyticsClient
} from "./analytics_client.js";
import {
  createAnalyticsRequest,
  defaultAnalysisSpecification,
  DoeAnalyticsValidationError,
  normalizeAnalysisSpecification,
  type DoeAnalysisSpecification
} from "./analytics_contract.js";
import {
  archiveDoeAnalysis,
  createDoeAnalysis,
  getDoeAnalysis,
  getDoeAnalysisRevision,
  getLatestSuccessfulDoeAnalysisRevision,
  listDoeAnalyses,
  listDoeAnalysisEvents,
  listDoeAnalysisRevisions,
  recordDoeAnalysisEvent,
  resolveDoeAnalysisState,
  renameDoeAnalysis,
  restoreDoeAnalysis,
  updateDoeAnalysisSpecification
} from "./analysis_repo.js";
import {
  buildDoeInterpretationContext,
  createMockDoeInterpretation,
  DoeInterpretationContractError,
  type DoeInterpretationLocale
} from "../llm/doe_interpretation_contract.js";
import { isDoeAnalysisLlmEnabled } from "../llm/feature_flags.js";
import {
  estimatedInputTokensForInterpretation,
  LlmProviderError,
  requestDoeInterpretation
} from "../llm/provider_client.js";
import {
  getDefaultDoeLlmProviderProfileForUse,
  recordLlmUsage
} from "../llm/provider_profiles_repo.js";
import { optimizeSavedAnalyses, type MultiResponseGoalInput } from "./multi_response_service.js";
import { createDoeAnalysisView, deleteDoeAnalysisView, listDoeAnalysisViews } from "./views_repo.js";
import {
  createDoeAnalysisTemplate,
  deleteDoeAnalysisTemplate,
  listDoeAnalysisTemplates,
  specificationToTemplate,
  templateToSpecification
} from "./templates_repo.js";
import {
  DoeAnalysisCalculationQueue,
  getDoeAnalysisJob,
  getDoeAnalysisJobRevision,
  findActiveDoeAnalysisJob
} from "./calculation_queue.js";

export function createDoeAnalysisRouter(
  db: Db,
  analyticsClient: DoeAnalyticsClient = createDoeAnalyticsClient()
) {
  const router = express.Router();
  const calculationQueue = new DoeAnalysisCalculationQueue(db, analyticsClient);
  const llmInterpretationLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many AI interpretation requests. Please try again later."
  });

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!isDoeAnalysisV2Enabled()) return res.status(404).send("Not found");
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      try {
        const experiment = getExperiment(db, experimentId);
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        if (!experiment) return res.status(404).send("Experiment not found");
        const responses = dataset.columns.filter(
          (column) => column.role === "response" && column.active && (column.dataType === "number" || column.dataType === "boolean" || column.dataType === "tags")
        );
        const factors = dataset.columns.filter(
          (column) => column.role === "factor" && column.active && column.dataType === "number"
        );
        const analyses = listDoeAnalyses(db, doeId);
        const requestedAnalysisId = Number(req.query.analysis_id);
        const selectedAnalysis = Number.isFinite(requestedAnalysisId)
          ? analyses.find((analysis) => analysis.id === requestedAnalysisId) ?? null
          : null;
        const analysisItems = analyses.map((analysis) => ({
          ...analysis,
          state: resolveDoeAnalysisState(db, analysis, dataset.datasetRevision)
        }));
        let defaultSpecification: DoeAnalysisSpecification | null = null;
        try {
          defaultSpecification = selectedAnalysis
            ? normalizeAnalysisSpecification(dataset, selectedAnalysis.specification)
            : defaultAnalysisSpecification(dataset);
        } catch (error) {
          if (!(error instanceof DoeAnalyticsValidationError)) throw error;
        }
        if (!selectedAnalysis && defaultSpecification && hasUsableUnfinishedRows(dataset, defaultSpecification)) {
          defaultSpecification = { ...defaultSpecification, includeIncomplete: true };
        }
        const overview = buildOverview(dataset, defaultSpecification?.includeIncomplete === true);
        const selectedAnalysisItem = selectedAnalysis
          ? analysisItems.find((analysis) => analysis.id === selectedAnalysis.id) ?? null
          : null;
        const latestSuccessfulRevision = selectedAnalysis
          ? getLatestSuccessfulDoeAnalysisRevision(db, selectedAnalysis)
          : null;
        const selectedRevisions = selectedAnalysis
          ? listDoeAnalysisRevisions(db, selectedAnalysis.id, 10)
          : [];
        const selectedEvents = selectedAnalysis
          ? listDoeAnalysisEvents(db, selectedAnalysis.id, 20)
          : [];
        const pendingCalculationJob = selectedAnalysis
          ? findActiveDoeAnalysisJob(db, selectedAnalysis.id)
          : null;
        return res.render("doe_analysis/workspace", {
          experiment,
          doe: dataset.doe,
          dataset,
          responses,
          factors,
          defaultSpecification,
          overview,
          analyses: analysisItems,
          selectedAnalysis: selectedAnalysisItem,
          latestSuccessfulRevision,
          selectedRevisions,
          selectedEvents,
          pendingCalculationJob,
          llmAssistantEnabled: isDoeAnalysisLlmEnabled()
        });
      } catch (error) {
        if (error instanceof DoeAnalysisDatasetNotFoundError) {
          return res.status(404).send(error.message);
        }
        throw error;
      }
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/templates",
    ensureExperimentAccess(db),
    (req, res) => {
      const experiment = getExperiment(db, Number(req.params.id));
      const processTypeId = processTypeIdForExperiment(db, experiment);
      if (!processTypeId) return res.status(409).json({ error: "This experiment has no process type for shared model templates." });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ templates: listDoeAnalysisTemplates(db, processTypeId) });
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/interpret",
    ensureExperimentAccess(db),
    llmInterpretationLimiter,
    async (req, res, next) => {
      if (!isDoeAnalysisLlmEnabled()) return res.status(404).json({ error: "AI interpretation is disabled." });
      const doeId = Number(req.params.doeId);
      const analysisId = Number(req.body?.analysisId);
      const revisionId = Number(req.body?.revisionId);
      if (!Number.isFinite(analysisId) || !Number.isFinite(revisionId)) {
        return res.status(400).json({ error: "A saved analysis and successful revision are required." });
      }
      try {
        const analysis = getDoeAnalysis(db, doeId, analysisId);
        if (!analysis) return res.status(404).json({ error: "Analysis not found for this DOE." });
        const revision = getDoeAnalysisRevision(db, analysisId, revisionId);
        if (!revision || revision.status !== "SUCCEEDED") {
          return res.status(409).json({ error: "A successful saved revision is required for interpretation." });
        }
        const rawQuestion = typeof req.body?.question === "string" ? req.body.question.trim() : "";
        if (rawQuestion.length > 2000) return res.status(400).json({ error: "Question must be at most 2000 characters." });
        const locale: DoeInterpretationLocale = String(req.body?.locale ?? "").toLowerCase().startsWith("ru") ? "ru" : "en";
        const context = buildDoeInterpretationContext(revision);
        const interpretationRequest = {
          context,
          locale,
          userQuestion: rawQuestion || undefined
        };
        const profile = getDefaultDoeLlmProviderProfileForUse(db);
        if (!profile) {
          const interpretation = createMockDoeInterpretation(interpretationRequest);
          console.info("[llm] mock interpretation completed", {
            analysisId,
            revisionId,
            userId: req.user?.id ?? null,
            reason: "no_enabled_default_profile"
          });
          res.setHeader("Cache-Control", "no-store");
          return res.json({ mode: "mock", interpretation, source: context.source, evidence: context.evidence });
        }
        console.info("[llm] interpretation requested", {
          analysisId,
          revisionId,
          userId: req.user?.id ?? null,
          providerProfileId: profile.id,
          providerKind: profile.providerKind,
          model: profile.model,
          contextEvidenceCount: context.evidence.length,
          hasQuestion: Boolean(rawQuestion)
        });
        try {
          const { interpretation, usage } = await requestDoeInterpretation(profile, interpretationRequest);
          recordLlmUsage(db, {
            userId: req.user?.id ?? null,
            providerProfileId: profile.id,
            providerName: profile.name,
            model: profile.model,
            analysisId,
            revisionId,
            purpose: rawQuestion ? "follow_up" : "initial_interpretation",
            status: "succeeded",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            inputTokenSource: usage.inputTokenSource,
            outputTokenSource: usage.outputTokenSource
          });
          res.setHeader("Cache-Control", "no-store");
          return res.json({
            mode: "provider",
            provider: { name: profile.name, model: profile.model },
            interpretation,
            source: context.source,
            evidence: context.evidence,
            usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
          });
        } catch (error) {
          recordLlmUsage(db, {
            userId: req.user?.id ?? null,
            providerProfileId: profile.id,
            providerName: profile.name,
            model: profile.model,
            analysisId,
            revisionId,
            purpose: rawQuestion ? "follow_up" : "initial_interpretation",
            status: "failed",
            inputTokens: estimatedInputTokensForInterpretation(interpretationRequest),
            outputTokens: null,
            inputTokenSource: "estimated",
            outputTokenSource: "unknown"
          });
          const message = error instanceof LlmProviderError ? error.message : "AI provider request failed.";
          const status = error instanceof LlmProviderError && error.code === "CONFIGURATION" ? 422 : 502;
          console.warn("[llm] interpretation failed", {
            analysisId,
            revisionId,
            userId: req.user?.id ?? null,
            providerProfileId: profile.id,
            code: error instanceof LlmProviderError ? error.code : "UNKNOWN"
          });
          return res.status(status).json({ error: message });
        }
      } catch (error) {
        if (error instanceof DoeInterpretationContractError) {
          return res.status(409).json({ error: error.message });
        }
        return sendAnalysisError(res, error, next);
      }
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/templates",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const experiment = getExperiment(db, Number(req.params.id));
      const processTypeId = processTypeIdForExperiment(db, experiment);
      if (!processTypeId) return res.status(409).json({ error: "This experiment has no process type for shared model templates." });
      const name = String(req.body?.name ?? "").trim();
      if (!name || name.length > 120) return res.status(400).json({ error: "Template name must contain 1 to 120 characters." });
      try {
        const dataset = buildDoeAnalysisDataset(db, Number(req.params.id), Number(req.params.doeId));
        const specification = normalizeAnalysisSpecification(dataset, req.body?.specification as Partial<DoeAnalysisSpecification> | undefined);
        const template = createDoeAnalysisTemplate(db, {
          processTypeId,
          name,
          specification: specificationToTemplate(dataset, specification),
          createdByUserId: req.user?.id ?? null
        });
        return res.status(201).json({ template });
      } catch (error) {
        if (error instanceof DoeAnalyticsValidationError) return sendAnalysisError(res, error, () => undefined);
        if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return res.status(409).json({ error: "A template with this name already exists for this process type." });
        throw error;
      }
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/templates/:templateId/apply",
    ensureExperimentAccess(db),
    (req, res) => {
      const experiment = getExperiment(db, Number(req.params.id));
      const processTypeId = processTypeIdForExperiment(db, experiment);
      if (!processTypeId) return res.status(409).json({ error: "This experiment has no process type for shared model templates." });
      const template = listDoeAnalysisTemplates(db, processTypeId).find((item) => item.id === Number(req.params.templateId));
      if (!template) return res.status(404).json({ error: "Model template not found for this process type." });
      try {
        const dataset = buildDoeAnalysisDataset(db, Number(req.params.id), Number(req.params.doeId));
        return res.json({ specification: templateToSpecification(dataset, template.specification) });
      } catch (error) {
        return res.status(409).json({ error: error instanceof Error ? error.message : "Template cannot be applied to this DOE." });
      }
    }
  );

  router.delete(
    "/experiments/:id/doe/:doeId/analysis-v2/templates/:templateId",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const experiment = getExperiment(db, Number(req.params.id));
      const processTypeId = processTypeIdForExperiment(db, experiment);
      if (!processTypeId) return res.status(409).json({ error: "This experiment has no process type for shared model templates." });
      if (!deleteDoeAnalysisTemplate(db, processTypeId, Number(req.params.templateId))) return res.status(404).json({ error: "Model template not found." });
      return res.status(204).end();
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/analyses",
    ensureExperimentAccess(db),
    (req, res) => {
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        const analyses = listDoeAnalyses(db, doeId).map((analysis) => ({
          ...analysis,
          state: resolveDoeAnalysisState(db, analysis, dataset.datasetRevision),
          revisions: listDoeAnalysisRevisions(db, analysis.id, 10)
        }));
        res.setHeader("Cache-Control", "no-store");
        return res.json({ analyses, datasetRevision: dataset.datasetRevision });
      } catch (error) {
        if (error instanceof DoeAnalysisDatasetNotFoundError) {
          return res.status(404).json({ error: error.message });
        }
        throw error;
      }
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/analyses",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        const name = String(req.body?.name ?? "").trim();
        if (!name || name.length > 120) {
          return res.status(400).json({ error: "Analysis name must contain 1 to 120 characters." });
        }
        const specification = normalizeAnalysisSpecification(
          dataset,
          req.body?.specification as Partial<DoeAnalysisSpecification> | undefined
        );
        const analysis = createDoeAnalysis(db, {
          doeId,
          name,
          description: typeof req.body?.description === "string" ? req.body.description : null,
          specification,
          createdByUserId: req.user?.id ?? null
        });
        recordDoeAnalysisEvent(db, {
          analysisId: analysis.id,
          action: "CREATED",
          actorUserId: req.user?.id ?? null,
          details: { name: analysis.name }
        });
        return res.status(201).json({
          analysis,
          state: resolveDoeAnalysisState(db, analysis, dataset.datasetRevision)
        });
      } catch (error) {
        if (error instanceof DoeAnalysisDatasetNotFoundError || error instanceof DoeAnalyticsValidationError) {
          return sendAnalysisError(res, error, () => undefined);
        }
        throw error;
      }
    }
  );

  router.patch(
    "/experiments/:id/doe/:doeId/analysis-v2/analyses/:analysisId",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const doeId = Number(req.params.doeId);
      const analysisId = Number(req.params.analysisId);
      const analysis = getDoeAnalysis(db, doeId, analysisId);
      if (!analysis) return res.status(404).json({ error: "Analysis not found" });
      if (analysis.archivedAt) return res.status(409).json({ error: "Restore the analysis before renaming it." });
      const name = String(req.body?.name ?? "").trim();
      if (!name || name.length > 120) {
        return res.status(400).json({ error: "Analysis name must contain 1 to 120 characters." });
      }
      renameDoeAnalysis(db, analysis.id, name);
      recordDoeAnalysisEvent(db, {
        analysisId: analysis.id,
        action: "RENAMED",
        actorUserId: req.user?.id ?? null,
        details: { previousName: analysis.name, name }
      });
      const refreshed = getDoeAnalysis(db, doeId, analysis.id);
      return res.json({ analysis: refreshed });
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/analyses/:analysisId/duplicate",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      const source = getDoeAnalysis(db, doeId, Number(req.params.analysisId));
      if (!source) return res.status(404).json({ error: "Analysis not found" });
      const name = String(req.body?.name ?? `${source.name} copy`).trim();
      if (!name || name.length > 120) {
        return res.status(400).json({ error: "Analysis name must contain 1 to 120 characters." });
      }
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        const analysis = createDoeAnalysis(db, {
          doeId,
          name,
          description: source.description,
          specification: normalizeAnalysisSpecification(dataset, source.specification),
          createdByUserId: req.user?.id ?? null
        });
        recordDoeAnalysisEvent(db, {
          analysisId: analysis.id,
          action: "CREATED",
          actorUserId: req.user?.id ?? null,
          details: { name: analysis.name, copiedFromAnalysisId: source.id }
        });
        return res.status(201).json({
          analysis,
          state: resolveDoeAnalysisState(db, analysis, dataset.datasetRevision)
        });
      } catch (error) {
        if (error instanceof DoeAnalysisDatasetNotFoundError || error instanceof DoeAnalyticsValidationError) {
          return sendAnalysisError(res, error, () => undefined);
        }
        throw error;
      }
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/analyses/:analysisId/archive",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const doeId = Number(req.params.doeId);
      const analysis = getDoeAnalysis(db, doeId, Number(req.params.analysisId));
      if (!analysis) return res.status(404).json({ error: "Analysis not found" });
      archiveDoeAnalysis(db, analysis.id);
      recordDoeAnalysisEvent(db, {
        analysisId: analysis.id,
        action: "ARCHIVED",
        actorUserId: req.user?.id ?? null
      });
      const refreshed = getDoeAnalysis(db, doeId, analysis.id);
      return res.json({ analysis: refreshed, state: "archived" });
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/analyses/:analysisId/restore",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const doeId = Number(req.params.doeId);
      const analysis = getDoeAnalysis(db, doeId, Number(req.params.analysisId));
      if (!analysis) return res.status(404).json({ error: "Analysis not found" });
      restoreDoeAnalysis(db, analysis.id);
      recordDoeAnalysisEvent(db, {
        analysisId: analysis.id,
        action: "RESTORED",
        actorUserId: req.user?.id ?? null
      });
      const refreshed = getDoeAnalysis(db, doeId, analysis.id);
      if (!refreshed) return res.status(404).json({ error: "Analysis not found" });
      const dataset = buildDoeAnalysisDataset(db, Number(req.params.id), doeId);
      return res.json({ analysis: refreshed, state: resolveDoeAnalysisState(db, refreshed, dataset.datasetRevision) });
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/analyses/:analysisId/calculate",
    ensureExperimentAccess(db),
    (req, res, next) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      const analysisId = Number(req.params.analysisId);
      const analysis = getDoeAnalysis(db, doeId, analysisId);
      if (!analysis) return res.status(404).json({ error: "Analysis not found" });
      if (analysis.archivedAt) return res.status(409).json({ error: "Restore the analysis before recalculating it." });
      const activeJob = findActiveDoeAnalysisJob(db, analysis.id);
      if (activeJob) {
        return res.status(409).json({
          error: "A calculation is already queued for this analysis.",
          job: activeJob
        });
      }
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        const specification = normalizeAnalysisSpecification(
          dataset,
          (req.body?.specification ?? analysis.specification) as Partial<DoeAnalysisSpecification>
        );
        updateDoeAnalysisSpecification(db, analysis.id, specification);
        const job = calculationQueue.enqueue({
          analysisId: analysis.id,
          doeId,
          dataset,
          specification,
          requestedByUserId: req.user?.id ?? null
        });
        return res.status(202).json({ job });
      } catch (error) {
        return sendAnalysisError(res, error, next);
      }
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/analyses/:analysisId/jobs/:jobId",
    ensureExperimentAccess(db),
    (req, res) => {
      const doeId = Number(req.params.doeId);
      const analysisId = Number(req.params.analysisId);
      const analysis = getDoeAnalysis(db, doeId, analysisId);
      if (!analysis) return res.status(404).json({ error: "Analysis not found" });
      const job = getDoeAnalysisJob(db, analysis.id, Number(req.params.jobId));
      if (!job) return res.status(404).json({ error: "Calculation job not found" });
      const revision = getDoeAnalysisJobRevision(db, job);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ job, revision, result: revision?.result ?? null });
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/dataset",
    ensureExperimentAccess(db),
    (req, res) => {
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      if (!Number.isFinite(doeId) || doeId <= 0) {
        return res.status(404).json({ error: "DOE study not found" });
      }
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        res.setHeader("Cache-Control", "no-store");
        return res.json(dataset);
      } catch (error) {
        if (error instanceof DoeAnalysisDatasetNotFoundError) {
          return res.status(404).json({ error: error.message });
        }
        throw error;
      }
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/multi-optimize",
    ensureExperimentAccess(db),
    (req, res) => {
      const doeId = Number(req.params.doeId);
      const candidates = listDoeAnalyses(db, doeId).flatMap((analysis) => {
        const revision = getLatestSuccessfulDoeAnalysisRevision(db, analysis);
        if (!revision?.dataset || !revision.result || revision.specification.derivedResponse || revision.specification.responseModel === "binary") return [];
        return [{
          analysisId: analysis.id,
          name: analysis.name,
          revisionId: revision.id,
          responseKey: revision.specification.responseKey,
          factorKeys: revision.specification.factorKeys,
          blockKeys: revision.specification.blockKeys ?? [],
          datasetRevision: revision.datasetRevision
        }];
      });
      return res.json({ candidates });
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/multi-optimize",
    ensureExperimentAccess(db),
    (req, res) => {
      const doeId = Number(req.params.doeId);
      const goals = Array.isArray(req.body?.goals) ? req.body.goals as MultiResponseGoalInput[] : [];
      try {
        const revisions = goals.map((goal) => {
          const analysis = getDoeAnalysis(db, doeId, Number(goal.analysisId));
          const revision = analysis ? getLatestSuccessfulDoeAnalysisRevision(db, analysis) : null;
          if (!analysis || !revision) throw new DoeAnalyticsValidationError(["One or more saved analyses are unavailable."]);
          return { analysisId: analysis.id, revision };
        });
        return res.json({ result: optimizeSavedAnalyses(revisions, goals, req.body?.factorBounds ?? {}) });
      } catch (error) {
        if (error instanceof DoeAnalyticsValidationError) return sendAnalysisError(res, error, () => undefined);
        return res.status(400).json({ error: error instanceof Error ? error.message : "Multi-response optimization failed." });
      }
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/comparison",
    ensureExperimentAccess(db),
    (req, res) => {
      const candidates = listDoeAnalyses(db, Number(req.params.doeId)).flatMap((analysis) => {
        const revision = getLatestSuccessfulDoeAnalysisRevision(db, analysis);
        if (!revision?.result) return [];
        return [{
          analysisName: analysis.name,
          revisionId: revision.id,
          datasetRevision: revision.datasetRevision,
          specification: revision.specification,
          summary: revision.result.summary
        }];
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ candidates });
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/views",
    ensureExperimentAccess(db),
    (req, res) => res.json({ views: listDoeAnalysisViews(db, Number(req.params.doeId)) })
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/views",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const chartType = req.body?.chartType;
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
      const config = req.body?.config;
      if ((chartType !== "interaction" && chartType !== "surface" && chartType !== "scatter") || !name || !config || typeof config !== "object" || Array.isArray(config)) {
        return res.status(400).json({ error: "A view name, supported chart type, and configuration are required." });
      }
      return res.status(201).json({ view: createDoeAnalysisView(db, {
        doeId: Number(req.params.doeId),
        analysisId: Number.isFinite(Number(req.body?.analysisId)) ? Number(req.body.analysisId) : null,
        analysisRevisionId: Number.isFinite(Number(req.body?.analysisRevisionId)) ? Number(req.body.analysisRevisionId) : null,
        name,
        chartType,
        config,
        createdByUserId: req.user?.id ?? null
      }) });
    }
  );

  router.delete(
    "/experiments/:id/doe/:doeId/analysis-v2/views/:viewId",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const deleted = deleteDoeAnalysisView(db, Number(req.params.doeId), Number(req.params.viewId));
      return deleted ? res.status(204).end() : res.status(404).json({ error: "Saved graph not found." });
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/confirmation-runs",
    ensureExperimentAccess(db),
    (req, res) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      const factorValues = req.body?.factorValues;
      if (!factorValues || typeof factorValues !== "object" || Array.isArray(factorValues)) {
        return res.status(400).json({ error: "Factor settings are required." });
      }
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        const factors = dataset.columns.filter((column) => column.role === "factor" && column.active && column.dataType === "number");
        if (!factors.length || factors.some((factor) => !Number.isFinite(Number(factorValues[factor.key])))) {
          return res.status(400).json({ error: "Every active numeric factor needs a finite setting." });
        }
        const existing = listRuns(db, doeId);
        const runOrder = existing.reduce((max, run) => Math.max(max, run.run_order), 0) + 1;
        const runCode = `CONF-${String(runOrder).padStart(3, "0")}`;
        insertRuns(db, experimentId, doeId, [{
          run_order: runOrder,
          run_code: runCode,
          recipe_id: null,
          replicate_key: "confirmation",
          replicate_index: 1,
          done: 0,
          exclude_from_analysis: 0,
          owner_user_id: req.user?.id ?? null
        }], factors.map((factor) => ({
          run_id: runOrder,
          param_def_id: (factor.source as { paramDefinitionId: number }).paramDefinitionId,
          value_real: Number(factorValues[factor.key]),
          value_text: null,
          value_tags_json: null
        })));
        const created = listRuns(db, doeId).find((run) => run.run_order === runOrder);
        return res.status(201).json({ run: created });
      } catch (error) {
        if (error instanceof DoeAnalysisDatasetNotFoundError) return res.status(404).json({ error: error.message });
        throw error;
      }
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/export.csv",
    ensureExperimentAccess(db),
    (req, res) => {
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        res.setHeader("Cache-Control", "no-store");
        res.attachment(`doe-${dataset.doe.id}-analysis-data-${dataset.datasetRevision.slice(0, 12)}.csv`);
        return res.type("text/csv; charset=utf-8").send(analysisReadyCsv(dataset));
      } catch (error) {
        if (error instanceof DoeAnalysisDatasetNotFoundError) {
          return res.status(404).send(error.message);
        }
        throw error;
      }
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/export.metadata.json",
    ensureExperimentAccess(db),
    (req, res) => {
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        res.setHeader("Cache-Control", "no-store");
        return res.json(canonicalWideMetadata(dataset));
      } catch (error) {
        if (error instanceof DoeAnalysisDatasetNotFoundError) {
          return res.status(404).json({ error: error.message });
        }
        throw error;
      }
    }
  );

  router.get(
    "/experiments/:id/doe/:doeId/analysis-v2/engine",
    ensureExperimentAccess(db),
    async (req, res, next) => {
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      try {
        buildDoeAnalysisDataset(db, experimentId, doeId);
        const health = await analyticsClient.health();
        res.setHeader("Cache-Control", "no-store");
        return res.json(health);
      } catch (error) {
        return sendAnalysisError(res, error, next);
      }
    }
  );

  router.post(
    "/experiments/:id/doe/:doeId/analysis-v2/calculate",
    ensureExperimentAccess(db),
    async (req, res, next) => {
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        const input = req.body?.specification as Partial<DoeAnalysisSpecification> | undefined;
        const calculationRequest = createAnalyticsRequest(dataset, input);
        const result = await analyticsClient.analyze(calculationRequest);
        res.setHeader("Cache-Control", "no-store");
        return res.status(result.ok ? 200 : result.error.retryable ? 503 : 422).json(result);
      } catch (error) {
        return sendAnalysisError(res, error, next);
      }
    }
  );

  return router;
}

export function isDoeAnalysisV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = String(env.DOE_ANALYSIS_V2_ENABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(configured)) return true;
  if (["0", "false", "no", "off"].includes(configured)) return false;
  return env.NODE_ENV !== "production";
}

function buildOverview(
  dataset: ReturnType<typeof buildDoeAnalysisDataset>,
  includeIncomplete: boolean
) {
  const responseColumns = dataset.columns.filter(
    (column) => column.role === "response" && column.active
  );
  const includedRows = dataset.rows.filter((row) => (includeIncomplete || row.done) && !row.excluded);
  const responseCells = includedRows.length * responseColumns.length;
  const populatedResponseCells = includedRows.reduce((count, row) =>
    count + responseColumns.filter((column) => row.values[column.key] !== null).length,
  0);
  return {
    totalRuns: dataset.rows.length,
    completeRuns: dataset.rows.filter((row) => row.done).length,
    includedRuns: includedRows.length,
    excludedRuns: dataset.rows.filter((row) => row.excluded).length,
    factorCount: dataset.columns.filter((column) => column.role === "factor" && column.active).length,
    responseCount: responseColumns.length,
    populatedResponseCells,
    responseCells,
    responseCompleteness: responseCells > 0
      ? populatedResponseCells / responseCells
      : null,
    includesIncomplete: includeIncomplete
  };
}

function hasUsableUnfinishedRows(
  dataset: ReturnType<typeof buildDoeAnalysisDataset>,
  specification: DoeAnalysisSpecification
): boolean {
  const hasCompleteUsableRow = dataset.rows.some((row) =>
    row.done && !row.excluded && rowIsUsable(row, specification)
  );
  if (hasCompleteUsableRow) return false;
  return dataset.rows.some((row) =>
    !row.done && !row.excluded && rowIsUsable(row, specification)
  );
}

function rowIsUsable(
  row: ReturnType<typeof buildDoeAnalysisDataset>["rows"][number],
  specification: DoeAnalysisSpecification
): boolean {
  if (!Number.isFinite(responseValue(row.values, specification))) return false;
  return specification.factorKeys.every((key) => {
    const value = specification.useCodedFactors ? row.codedValues[key] : row.values[key];
    return typeof value === "number" && Number.isFinite(value);
  });
}

function responseValue(values: Record<string, unknown>, specification: DoeAnalysisSpecification): number {
  const derived = specification.derivedResponse;
  if (!derived) {
    const direct = values[specification.responseKey];
    if (specification.tagResponse) {
      return Array.isArray(direct) ? Number(direct.includes(specification.tagResponse.tag)) : Number.NaN;
    }
    return typeof direct === "number" ? direct : typeof direct === "boolean" ? Number(direct) : Number.NaN;
  }
  const left = values[derived.leftKey];
  const right = values[derived.rightKey];
  if (typeof left !== "number" || typeof right !== "number") return Number.NaN;
  if (derived.operation === "difference") return left - right;
  if (derived.operation === "sum") return left + right;
  return right === 0 ? Number.NaN : left / right;
}

function analysisReadyCsv(dataset: ReturnType<typeof buildDoeAnalysisDataset>): string {
  const factorColumns = dataset.columns.filter(
    (column) => column.role === "factor" && column.active && column.dataType === "number"
  );
  const responseColumns = dataset.columns.filter(
    (column) => column.role === "response" && column.active && column.dataType === "number"
  );
  const headers = [
    "Run",
    ...factorColumns.map((column) => column.code),
    ...responseColumns.map((column) => column.code)
  ];
  const rows = dataset.rows
    .filter((row) => !row.excluded && responseColumns.some((column) => typeof row.values[column.key] === "number"))
    .map((row) => csvRow([
    row.runCode,
    ...factorColumns.map((column) => csvValue(row.values[column.key])),
    ...responseColumns.map((column) => csvValue(row.values[column.key]))
    ]));
  // Excel commonly ignores a declared UTF-8 charset for downloaded CSV files;
  // the BOM keeps units such as cm³/s intact without adding non-data rows.
  return `\uFEFF${[csvRow(headers), ...rows].join("\n")}`;
}

function canonicalWideMetadata(dataset: ReturnType<typeof buildDoeAnalysisDataset>) {
  return {
    contractVersion: dataset.contractVersion,
    datasetRevision: dataset.datasetRevision,
    experimentId: dataset.experimentId,
    doe: dataset.doe,
    columns: dataset.columns.map((column) => ({
      key: column.key,
      exportLabel: exportColumnLabel(column),
      role: column.role,
      dataType: column.dataType,
      code: column.code,
      label: column.label,
      unit: column.unit,
      coding: column.factor?.coding ?? null
    }))
  };
}

function exportColumnLabel(column: ReturnType<typeof buildDoeAnalysisDataset>["columns"][number]): string {
  return `${column.label}${column.unit ? ` (${column.unit})` : ""}`;
}

function csvValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  return Array.isArray(value) ? value.join("; ") : typeof value === "object" ? JSON.stringify(value) : String(value);
}

function csvRow(values: unknown[]): string {
  return values.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",");
}

function sendAnalysisError(
  res: express.Response,
  error: unknown,
  next: express.NextFunction
) {
  if (error instanceof DoeAnalysisDatasetNotFoundError) {
    return res.status(404).json({ error: error.message });
  }
  if (error instanceof DoeAnalyticsValidationError) {
    return res.status(400).json({
      error: error.code,
      message: error.message,
      issues: error.issues
    });
  }
  if (error instanceof DoeAnalyticsServiceError) {
    return res.status(error.retryable ? 503 : 502).json({
      error: error.code,
      message: error.message,
      retryable: error.retryable
    });
  }
  return next(error);
}

function canEditAnalysis(user: Express.User | undefined): boolean {
  return user?.role === "admin" || user?.role === "manager" || user?.role === "engineer";
}

function processTypeIdForExperiment(
  db: Db,
  experiment: ReturnType<typeof getExperiment> | null
): number | null {
  if (!experiment?.process_id) return null;
  return getProcessById(db, experiment.process_id)?.process_type_id ?? null;
}
