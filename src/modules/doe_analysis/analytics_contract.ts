import crypto from "node:crypto";
import type { DoeAnalysisDataset } from "./types.js";

export const DOE_ANALYTICS_CONTRACT_VERSION = "1.0" as const;

export type DoeAnalysisModelFamily = "factorial" | "response_surface" | "regression";

export type DoeAnalysisSpecification = {
  responseKey: string;
  factorKeys: string[];
  modelFamily: DoeAnalysisModelFamily;
  useCodedFactors: boolean;
  includeExcluded: boolean;
  includeIncomplete: boolean;
  confidenceLevel: number;
};

export type DoeAnalyticsRequest = {
  contractVersion: typeof DOE_ANALYTICS_CONTRACT_VERSION;
  requestId: string;
  dataset: DoeAnalysisDataset;
  specification: DoeAnalysisSpecification;
};

export type DoeAnalyticsWarning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type DoeAnalyticsEngine = {
  name: string;
  version: string;
  mode: "mock" | "r";
  packages: Record<string, string>;
};

export type DoeAnalyticsMetric = {
  key: string;
  label: string;
  value: number | null;
};

export type DoeAnalyticsCoefficient = {
  term: string;
  estimate: number | null;
  standardError: number | null;
  statistic: number | null;
  pValue: number | null;
  confidenceLow: number | null;
  confidenceHigh: number | null;
};

export type DoeAnalyticsAnovaRow = {
  term: string;
  degreesOfFreedom: number | null;
  sumOfSquares: number | null;
  meanSquare: number | null;
  statistic: number | null;
  pValue: number | null;
};

export type DoeAnalyticsDiagnosticRow = {
  runId: number;
  fitted: number | null;
  residual: number | null;
  standardizedResidual: number | null;
  leverage: number | null;
  cooksDistance: number | null;
};

export type DoeAnalyticsPlots = {
  mainEffects: Array<{
    factorKey: string;
    points: Array<{ value: number; predicted: number | null }>;
  }>;
  interactions: Array<{
    factorXKey: string;
    factorYKey: string;
    series: Array<{
      factorYValue: number;
      points: Array<{ factorXValue: number; predicted: number | null }>;
    }>;
  }>;
  qq: Array<{
    runId: number;
    theoretical: number;
    standardizedResidual: number | null;
  }>;
  residualOrder: Array<{
    runId: number;
    runOrder: number;
    residual: number | null;
  }>;
  surface: null | DoeAnalyticsSurface;
  surfaces?: DoeAnalyticsSurface[];
};

export type DoeAnalyticsSurface = {
    factorXKey: string;
    factorYKey: string;
    heldValues: Record<string, number>;
    points: Array<{ x: number; y: number; predicted: number | null }>;
    actualPoints?: Array<{
      runId: number;
      x: number;
      y: number;
      response: number | null;
      predicted: number | null;
    }>;
};

export type DoeAnalyticsSuccess = {
  ok: true;
  contractVersion: typeof DOE_ANALYTICS_CONTRACT_VERSION;
  requestId: string;
  datasetRevision: string;
  engine: DoeAnalyticsEngine;
  specification: DoeAnalysisSpecification;
  summary: {
    rowsAvailable: number;
    rowsUsed: number;
    rowsExcluded: number;
    rowsMissingResponse: number;
    metrics: DoeAnalyticsMetric[];
  };
  coefficients: DoeAnalyticsCoefficient[];
  anova: DoeAnalyticsAnovaRow[];
  diagnostics: DoeAnalyticsDiagnosticRow[];
  plots?: DoeAnalyticsPlots;
  warnings: DoeAnalyticsWarning[];
};

export type DoeAnalyticsFailure = {
  ok: false;
  contractVersion: typeof DOE_ANALYTICS_CONTRACT_VERSION;
  requestId: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};

export type DoeAnalyticsResponse = DoeAnalyticsSuccess | DoeAnalyticsFailure;

export type DoeAnalyticsHealth = {
  status: "ok";
  contractVersion: typeof DOE_ANALYTICS_CONTRACT_VERSION;
  engine: DoeAnalyticsEngine;
};

export class DoeAnalyticsValidationError extends Error {
  readonly code = "INVALID_ANALYSIS_REQUEST";
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join(" "));
    this.name = "DoeAnalyticsValidationError";
    this.issues = issues;
  }
}

export function defaultAnalysisSpecification(dataset: DoeAnalysisDataset): DoeAnalysisSpecification {
  const numericResponses = dataset.columns.filter(
    (column) => column.role === "response" && column.active && column.dataType === "number"
  );
  const response = numericResponses.reduce<(typeof numericResponses)[number] | undefined>(
    (best, column) => {
      if (!best) return column;
      return populatedNumericCount(dataset, column.key) > populatedNumericCount(dataset, best.key)
        ? column
        : best;
    },
    undefined
  );
  const factors = dataset.columns.filter(
    (column) => column.role === "factor" && column.active && column.dataType === "number"
  );
  if (!response) {
    throw new DoeAnalyticsValidationError(["The DOE has no active numeric response."]);
  }
  const modelFamily: DoeAnalysisModelFamily = dataset.doe.designType === "BBD"
    ? "response_surface"
    : dataset.doe.designType === "FFA" || dataset.doe.designType === "SCREEN"
      ? "factorial"
      : "regression";
  return {
    responseKey: response.key,
    factorKeys: factors.map((column) => column.key),
    modelFamily,
    useCodedFactors: modelFamily !== "regression",
    includeExcluded: false,
    includeIncomplete: false,
    confidenceLevel: 0.95
  };
}

function populatedNumericCount(dataset: DoeAnalysisDataset, columnKey: string): number {
  return dataset.rows.reduce(
    (count, row) => count + (typeof row.values[columnKey] === "number" ? 1 : 0),
    0
  );
}

export function normalizeAnalysisSpecification(
  dataset: DoeAnalysisDataset,
  input: Partial<DoeAnalysisSpecification> | null | undefined
): DoeAnalysisSpecification {
  const defaults = defaultAnalysisSpecification(dataset);
  const specification: DoeAnalysisSpecification = {
    responseKey: typeof input?.responseKey === "string" ? input.responseKey : defaults.responseKey,
    factorKeys: Array.isArray(input?.factorKeys)
      ? input.factorKeys.filter((key): key is string => typeof key === "string")
      : defaults.factorKeys,
    modelFamily: input?.modelFamily ?? defaults.modelFamily,
    useCodedFactors: typeof input?.useCodedFactors === "boolean"
      ? input.useCodedFactors
      : defaults.useCodedFactors,
    includeExcluded: input?.includeExcluded === true,
    includeIncomplete: input?.includeIncomplete === true,
    confidenceLevel: typeof input?.confidenceLevel === "number"
      ? input.confidenceLevel
      : defaults.confidenceLevel
  };
  validateAnalysisSpecification(dataset, specification);
  return specification;
}

export function validateAnalysisSpecification(
  dataset: DoeAnalysisDataset,
  specification: DoeAnalysisSpecification
): void {
  const issues: string[] = [];
  const response = dataset.columns.find((column) => column.key === specification.responseKey);
  if (!response || response.role !== "response" || !response.active) {
    issues.push(`Unknown or inactive response column: ${specification.responseKey}.`);
  } else if (response.dataType !== "number") {
    issues.push(`Response ${specification.responseKey} is not numeric.`);
  }

  if (!Array.isArray(specification.factorKeys) || specification.factorKeys.length === 0) {
    issues.push("At least one factor is required.");
  } else {
    const uniqueKeys = new Set(specification.factorKeys);
    if (uniqueKeys.size !== specification.factorKeys.length) {
      issues.push("Factor keys must be unique.");
    }
    for (const key of uniqueKeys) {
      const factor = dataset.columns.find((column) => column.key === key);
      if (!factor || factor.role !== "factor" || !factor.active) {
        issues.push(`Unknown or inactive factor column: ${key}.`);
      } else if (factor.dataType !== "number") {
        issues.push(`Factor ${key} is not numeric.`);
      }
    }
  }

  if (!["factorial", "response_surface", "regression"].includes(specification.modelFamily)) {
    issues.push(`Unsupported model family: ${String(specification.modelFamily)}.`);
  }
  if (!(specification.confidenceLevel > 0.5 && specification.confidenceLevel < 1)) {
    issues.push("Confidence level must be greater than 0.5 and less than 1.");
  }
  if (specification.modelFamily === "response_surface" && specification.factorKeys.length < 2) {
    issues.push("A response-surface model requires at least two factors.");
  }
  if (issues.length) throw new DoeAnalyticsValidationError(issues);
}

export function createAnalyticsRequest(
  dataset: DoeAnalysisDataset,
  input?: Partial<DoeAnalysisSpecification> | null,
  requestId: string = crypto.randomUUID()
): DoeAnalyticsRequest {
  return {
    contractVersion: DOE_ANALYTICS_CONTRACT_VERSION,
    requestId,
    dataset,
    specification: normalizeAnalysisSpecification(dataset, input)
  };
}

export function isDoeAnalyticsResponse(value: unknown): value is DoeAnalyticsResponse {
  if (!isRecord(value)) return false;
  if (value.contractVersion !== DOE_ANALYTICS_CONTRACT_VERSION) return false;
  if (typeof value.requestId !== "string" || typeof value.ok !== "boolean") return false;
  if (value.ok === false) {
    return isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string" &&
      typeof value.error.retryable === "boolean";
  }
  return typeof value.datasetRevision === "string" &&
    isRecord(value.engine) &&
    isRecord(value.summary) &&
    Array.isArray(value.coefficients) &&
    Array.isArray(value.anova) &&
    Array.isArray(value.diagnostics) &&
    Array.isArray(value.warnings);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
