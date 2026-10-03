import express from "express";
import type { Db } from "../../db.js";
import { ensureExperimentAccess } from "../../middleware/experiment_access.js";
import { getExperiment } from "../../repos/experiments_repo.js";
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
import { optimizeSavedAnalyses, type MultiResponseGoalInput } from "./multi_response_service.js";
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
          (column) => column.role === "response" && column.active && column.dataType === "number"
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
          pendingCalculationJob
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
        if (!revision?.dataset || !revision.result) return [];
        return [{
          analysisId: analysis.id,
          name: analysis.name,
          revisionId: revision.id,
          responseKey: revision.specification.responseKey,
          factorKeys: revision.specification.factorKeys,
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
  if (typeof row.values[specification.responseKey] !== "number") return false;
  return specification.factorKeys.every((key) => {
    const value = specification.useCodedFactors ? row.codedValues[key] : row.values[key];
    return typeof value === "number" && Number.isFinite(value);
  });
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
