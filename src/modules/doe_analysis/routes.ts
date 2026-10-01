import crypto from "node:crypto";
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
  DOE_ANALYTICS_CONTRACT_VERSION,
  defaultAnalysisSpecification,
  DoeAnalyticsValidationError,
  normalizeAnalysisSpecification,
  type DoeAnalysisSpecification
} from "./analytics_contract.js";
import {
  createDoeAnalysis,
  getDoeAnalysis,
  getLatestSuccessfulDoeAnalysisRevision,
  listDoeAnalyses,
  listDoeAnalysisRevisions,
  resolveDoeAnalysisState,
  saveFailedDoeAnalysisRevision,
  saveSuccessfulDoeAnalysisRevision,
  updateDoeAnalysisSpecification
} from "./analysis_repo.js";

export function createDoeAnalysisRouter(
  db: Db,
  analyticsClient: DoeAnalyticsClient = createDoeAnalyticsClient()
) {
  const router = express.Router();

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
          selectedRevisions
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
    "/experiments/:id/doe/:doeId/analysis-v2/analyses/:analysisId/calculate",
    ensureExperimentAccess(db),
    async (req, res, next) => {
      if (!canEditAnalysis(req.user)) return res.status(403).json({ error: "Forbidden" });
      const experimentId = Number(req.params.id);
      const doeId = Number(req.params.doeId);
      const analysisId = Number(req.params.analysisId);
      let analysis = getDoeAnalysis(db, doeId, analysisId);
      if (!analysis) return res.status(404).json({ error: "Analysis not found" });
      try {
        const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
        const specification = normalizeAnalysisSpecification(
          dataset,
          (req.body?.specification ?? analysis.specification) as Partial<DoeAnalysisSpecification>
        );
        updateDoeAnalysisSpecification(db, analysis.id, specification);
        analysis = getDoeAnalysis(db, doeId, analysisId) ?? analysis;
        const calculationRequest = createAnalyticsRequest(dataset, specification);
        const result = await analyticsClient.analyze(calculationRequest);
        const revision = result.ok
          ? saveSuccessfulDoeAnalysisRevision(db, analysis, result, req.user?.id ?? null)
          : saveFailedDoeAnalysisRevision(db, analysis, {
              datasetRevision: dataset.datasetRevision,
              contractVersion: result.contractVersion,
              requestId: result.requestId,
              specification,
              error: result.error,
              calculatedByUserId: req.user?.id ?? null
            });
        const refreshed = getDoeAnalysis(db, doeId, analysisId) ?? analysis;
        return res.status(result.ok ? 200 : result.error.retryable ? 503 : 422).json({
          analysis: refreshed,
          revision,
          state: resolveDoeAnalysisState(db, refreshed, dataset.datasetRevision),
          result
        });
      } catch (error) {
        if (error instanceof DoeAnalyticsServiceError) {
          const dataset = buildDoeAnalysisDataset(db, experimentId, doeId);
          const specification = normalizeAnalysisSpecification(dataset, analysis.specification);
          saveFailedDoeAnalysisRevision(db, analysis, {
            datasetRevision: dataset.datasetRevision,
            contractVersion: DOE_ANALYTICS_CONTRACT_VERSION,
            requestId: crypto.randomUUID(),
            specification,
            error: {
              code: error.code,
              message: error.message,
              retryable: error.retryable
            },
            calculatedByUserId: req.user?.id ?? null
          });
        }
        return sendAnalysisError(res, error, next);
      }
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
