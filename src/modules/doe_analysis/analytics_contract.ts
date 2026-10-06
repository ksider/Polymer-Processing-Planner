import crypto from "node:crypto";
import type { DoeAnalysisDataset } from "./types.js";

export const DOE_ANALYTICS_CONTRACT_VERSION = "1.0" as const;

export type DoeAnalysisModelFamily = "factorial" | "response_surface" | "regression";
export type DoeAnalysisModelFamilyOption = {
  value: DoeAnalysisModelFamily;
  label: string;
  description: string;
};
export type DoeAnalysisResponseTransform = "none" | "log" | "sqrt";
export type DoeAnalysisResponseModel = "continuous" | "binary";
export type DoeAnalysisDerivedResponseOperation = "difference" | "sum" | "ratio";
export type DoeAnalysisDerivedResponse = {
  operation: DoeAnalysisDerivedResponseOperation;
  leftKey: string;
  rightKey: string;
};
export type DoeAnalysisTagResponse = {
  tag: string;
};
export type DoeAnalysisModelTerm = `main:${string}` | `interaction:${string}|${string}` | `quadratic:${string}`;
export type DoeAnalysisOptimizationObjective = "minimize" | "maximize" | "target";
export type DoeAnalysisOptimization = {
  objective: DoeAnalysisOptimizationObjective;
  target?: number;
  factorBounds?: Record<string, { min: number; max: number }>;
};

export type DoeAnalysisSpecification = {
  responseKey: string;
  factorKeys: string[];
  blockKeys: string[];
  modelFamily: DoeAnalysisModelFamily;
  modelTerms: DoeAnalysisModelTerm[];
  useCodedFactors: boolean;
  includeExcluded: boolean;
  includeIncomplete: boolean;
  confidenceLevel: number;
  responseTransform: DoeAnalysisResponseTransform;
  responseModel: DoeAnalysisResponseModel;
  derivedResponse?: DoeAnalysisDerivedResponse;
  tagResponse?: DoeAnalysisTagResponse;
  optimization?: DoeAnalysisOptimization;
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
  meanByFactor: Array<{
    factorKey: string;
    points: Array<{
      value: number;
      mean: number | null;
      confidenceLow: number | null;
      confidenceHigh: number | null;
      n: number;
    }>;
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
  optimizer?: null | {
    objective: DoeAnalysisOptimizationObjective;
    target: number | null;
    predicted: number | null;
    factorValues: Record<string, number>;
    blockValues: Record<string, string>;
    modelFactorValues: Record<string, number>;
    factorBounds: Record<string, { min: number; max: number }>;
    candidatesEvaluated: number;
  };
  recommendations?: {
    minimum: NonNullable<DoeAnalyticsSuccess["optimizer"]>;
    maximum: NonNullable<DoeAnalyticsSuccess["optimizer"]>;
  };
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

/**
 * The model picker is intentionally driven by the DOE design, rather than by
 * the capabilities of the R service. R can fit all three formula families to
 * arbitrary numeric data, but that does not make each one a sound DOE method.
 */
export function modelFamilyOptionsForDataset(dataset: DoeAnalysisDataset): DoeAnalysisModelFamilyOption[] {
  switch (dataset.doe.designType) {
    case "FFA":
      return [
        {
          value: "factorial",
          label: "Factorial",
          description: "Main effects and two-factor interactions for a full-factorial design."
        },
        {
          value: "regression",
          label: "Main-effects regression",
          description: "A reduced model containing only the main effects."
        }
      ];
    case "BBD":
      return [
        {
          value: "response_surface",
          label: "Response surface",
          description: "Quadratic response-surface model for a Box–Behnken design."
        },
        {
          value: "regression",
          label: "Main-effects regression",
          description: "A reduced first-order model without curvature or interactions."
        }
      ];
    case "SCREEN":
      return [{
        value: "regression",
        label: "Screening (main effects)",
        description: "Screening designs estimate main effects; interactions may be aliased and are not offered."
      }];
    case "SIM":
    default:
      return [{
        value: "regression",
        label: "Regression",
        description: "Exploratory main-effects model for this simulated or custom design."
      }];
  }
}

export function isModelFamilySupportedByDataset(
  dataset: DoeAnalysisDataset,
  modelFamily: DoeAnalysisModelFamily
): boolean {
  return modelFamilyOptionsForDataset(dataset).some((option) => option.value === modelFamily);
}

type NormalizeAnalysisSpecificationOptions = {
  enforceModelFamilyCompatibility?: boolean;
};

export function defaultAnalysisSpecification(dataset: DoeAnalysisDataset): DoeAnalysisSpecification {
  const supportedResponses = dataset.columns.filter(
    (column) => column.role === "response" && column.active && (
      column.dataType === "number" ||
      column.dataType === "boolean" ||
      (column.dataType === "tags" && column.allowedValues.length > 0)
    )
  );
  const response = supportedResponses.reduce<(typeof supportedResponses)[number] | undefined>(
    (best, column) => {
      if (!best) return column;
      if (best.dataType === "boolean" && column.dataType === "number") return column;
      if (best.dataType === "number" && column.dataType === "boolean") return best;
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
    throw new DoeAnalyticsValidationError(["The DOE has no active numeric, boolean, or configured tag response."]);
  }
  const modelFamily = modelFamilyOptionsForDataset(dataset)[0].value;
  return {
    responseKey: response.key,
    factorKeys: factors.map((column) => column.key),
    blockKeys: dataset.columns
      .filter((column) => column.role === "block" && column.active && (column.dataType === "category" || column.dataType === "text"))
      .map((column) => column.key),
    modelFamily,
    modelTerms: defaultModelTerms(modelFamily, factors.map((column) => column.key)),
    useCodedFactors: modelFamily !== "regression",
    includeExcluded: false,
    includeIncomplete: false,
    confidenceLevel: 0.95,
    responseTransform: "none",
    responseModel: response.dataType === "boolean" || response.dataType === "tags" ? "binary" : "continuous",
    tagResponse: response.dataType === "tags" ? { tag: response.allowedValues[0] } : undefined
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
  input: Partial<DoeAnalysisSpecification> | null | undefined,
  options: NormalizeAnalysisSpecificationOptions = {}
): DoeAnalysisSpecification {
  const defaults = defaultAnalysisSpecification(dataset);
  const responseKey = typeof input?.responseKey === "string" ? input.responseKey : defaults.responseKey;
  const selectedResponse = dataset.columns.find((column) => column.key === responseKey);
  const specification: DoeAnalysisSpecification = {
    responseKey,
    factorKeys: Array.isArray(input?.factorKeys)
      ? input.factorKeys.filter((key): key is string => typeof key === "string")
      : defaults.factorKeys,
    blockKeys: Array.isArray(input?.blockKeys)
      ? input.blockKeys.filter((key): key is string => typeof key === "string")
      : defaults.blockKeys,
    modelFamily: input?.modelFamily ?? defaults.modelFamily,
    modelTerms: Array.isArray(input?.modelTerms)
      ? input.modelTerms.filter((term): term is DoeAnalysisModelTerm => typeof term === "string")
      : defaultModelTerms(
          input?.modelFamily ?? defaults.modelFamily,
          Array.isArray(input?.factorKeys)
            ? input.factorKeys.filter((key): key is string => typeof key === "string")
            : defaults.factorKeys
        ),
    useCodedFactors: typeof input?.useCodedFactors === "boolean"
      ? input.useCodedFactors
      : defaults.useCodedFactors,
    includeExcluded: input?.includeExcluded === true,
    includeIncomplete: input?.includeIncomplete === true,
    confidenceLevel: typeof input?.confidenceLevel === "number"
      ? input.confidenceLevel
      : defaults.confidenceLevel,
    responseTransform: input?.responseTransform === "log" || input?.responseTransform === "sqrt"
      ? input.responseTransform
      : "none",
    responseModel: responseModelFor(dataset, responseKey),
    derivedResponse: normalizeDerivedResponse(input?.derivedResponse),
    tagResponse: normalizeTagResponse(input?.tagResponse) ?? (
      selectedResponse?.dataType === "tags" && selectedResponse.allowedValues.length
        ? { tag: selectedResponse.allowedValues[0] }
        : undefined
    ),
    optimization: normalizeOptimization(input?.optimization)
  };
  validateAnalysisSpecification(dataset, specification, options);
  return specification;
}

export function validateAnalysisSpecification(
  dataset: DoeAnalysisDataset,
  specification: DoeAnalysisSpecification,
  options: NormalizeAnalysisSpecificationOptions = {}
): void {
  const issues: string[] = [];
  const response = dataset.columns.find((column) => column.key === specification.responseKey);
  if (!response || response.role !== "response" || !response.active) {
    issues.push(`Unknown or inactive response column: ${specification.responseKey}.`);
  } else if (response.dataType !== "number" && response.dataType !== "boolean" && response.dataType !== "tags") {
    issues.push(`Response ${specification.responseKey} must be numeric, boolean, or tags.`);
  } else if (specification.responseModel !== responseModelFor(dataset, specification.responseKey)) {
    issues.push(`Response model does not match the data type of ${specification.responseKey}.`);
  }
  if (specification.derivedResponse) {
    const { operation, leftKey, rightKey } = specification.derivedResponse;
    if (!["difference", "sum", "ratio"].includes(operation)) {
      issues.push("Unsupported derived response operation.");
    }
    if (leftKey === rightKey) {
      issues.push("A derived response must use two different measured responses.");
    }
    for (const key of [leftKey, rightKey]) {
      const source = dataset.columns.find((column) => column.key === key);
      if (!source || source.role !== "response" || !source.active || source.dataType !== "number") {
        issues.push(`Derived response source ${key} must be an active numeric response.`);
      }
    }
    if (specification.responseKey !== leftKey) {
      issues.push("The primary response must match the first derived response source.");
    }
  }
  if (specification.tagResponse) {
    if (response?.dataType !== "tags") {
      issues.push("A tag response must use a tags measurement field.");
    } else if (!response.allowedValues.includes(specification.tagResponse.tag)) {
      issues.push(`Tag ${specification.tagResponse.tag} is not available for ${specification.responseKey}.`);
    }
  } else if (response?.dataType === "tags") {
    issues.push("Select a tag to analyse its presence or absence.");
  }
  if (specification.derivedResponse && specification.tagResponse) {
    issues.push("A derived numeric response cannot also be a tag response.");
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

  if (!Array.isArray(specification.blockKeys)) {
    issues.push("Blocks must be an array.");
  } else {
    const uniqueBlockKeys = new Set(specification.blockKeys);
    if (uniqueBlockKeys.size !== specification.blockKeys.length) {
      issues.push("Blocks must be unique.");
    }
    for (const key of uniqueBlockKeys) {
      const block = dataset.columns.find((column) => column.key === key);
      if (!block || block.role !== "block" || !block.active) {
        issues.push(`Unknown or inactive block column: ${key}.`);
      } else if (block.dataType !== "category" && block.dataType !== "text") {
        issues.push(`Block ${key} must be categorical or text.`);
      }
    }
  }

  if (!["factorial", "response_surface", "regression"].includes(specification.modelFamily)) {
    issues.push(`Unsupported model family: ${String(specification.modelFamily)}.`);
  } else if (options.enforceModelFamilyCompatibility && !isModelFamilySupportedByDataset(dataset, specification.modelFamily)) {
    const supported = modelFamilyOptionsForDataset(dataset).map((option) => option.label).join(", ");
    issues.push(`${specification.modelFamily} is not applicable to a ${dataset.doe.designType} design. Choose: ${supported}.`);
  }
  if (!(specification.confidenceLevel > 0.5 && specification.confidenceLevel < 1)) {
    issues.push("Confidence level must be greater than 0.5 and less than 1.");
  }
  if (!["none", "log", "sqrt"].includes(specification.responseTransform)) {
    issues.push("Unsupported response transformation.");
  }
  if (specification.responseModel === "binary" && specification.responseTransform !== "none") {
    issues.push("A boolean response cannot use a numeric response transformation.");
  }
  if (specification.optimization) {
    if (specification.optimization.objective === "target" && !Number.isFinite(specification.optimization.target)) {
      issues.push("A numeric target is required for target optimization.");
    }
    for (const [key, bounds] of Object.entries(specification.optimization.factorBounds ?? {})) {
      if (!specification.factorKeys.includes(key)) issues.push(`Optimization bounds include unknown factor ${key}.`);
      if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max) || bounds.min >= bounds.max) {
        issues.push(`Optimization bounds for ${key} must have min below max.`);
      }
    }
  }
  if (specification.modelFamily === "response_surface" && specification.factorKeys.length < 2) {
    issues.push("A response-surface model requires at least two factors.");
  }
  const allowedTerms = new Set(defaultModelTerms(specification.modelFamily, specification.factorKeys));
  if (!specification.modelTerms.length) {
    issues.push("Select at least one model term.");
  }
  if (new Set(specification.modelTerms).size !== specification.modelTerms.length) {
    issues.push("Model terms must be unique.");
  }
  for (const term of specification.modelTerms) {
    if (!allowedTerms.has(term)) issues.push(`Unsupported model term: ${term}.`);
    if (term.startsWith("interaction:")) {
      const [left, right] = term.slice("interaction:".length).split("|");
      if (!specification.modelTerms.includes(`main:${left}`) || !specification.modelTerms.includes(`main:${right}`)) {
        issues.push(`Interaction ${term} requires both corresponding main effects.`);
      }
    }
    if (term.startsWith("quadratic:")) {
      const factorKey = term.slice("quadratic:".length);
      if (!specification.modelTerms.includes(`main:${factorKey}`)) {
        issues.push(`Quadratic term ${term} requires its main effect.`);
      }
    }
  }
  if (issues.length) throw new DoeAnalyticsValidationError(issues);
}

function normalizeDerivedResponse(input: unknown): DoeAnalysisDerivedResponse | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as Partial<DoeAnalysisDerivedResponse>;
  if (
    (candidate.operation !== "difference" && candidate.operation !== "sum" && candidate.operation !== "ratio") ||
    typeof candidate.leftKey !== "string" ||
    typeof candidate.rightKey !== "string"
  ) return undefined;
  return {
    operation: candidate.operation,
    leftKey: candidate.leftKey,
    rightKey: candidate.rightKey
  };
}

function normalizeTagResponse(input: unknown): DoeAnalysisTagResponse | undefined {
  if (!input || typeof input !== "object") return undefined;
  const tag = (input as Partial<DoeAnalysisTagResponse>).tag;
  return typeof tag === "string" && tag.trim() ? { tag: tag.trim() } : undefined;
}

function responseModelFor(dataset: DoeAnalysisDataset, responseKey: string): DoeAnalysisResponseModel {
  return ["boolean", "tags"].includes(dataset.columns.find((column) => column.key === responseKey)?.dataType ?? "")
    ? "binary"
    : "continuous";
}

export function defaultModelTerms(
  modelFamily: DoeAnalysisModelFamily,
  factorKeys: string[]
): DoeAnalysisModelTerm[] {
  const mainEffects = factorKeys.map((key) => `main:${key}` as DoeAnalysisModelTerm);
  if (modelFamily === "regression") return mainEffects;
  const interactions = factorKeys.flatMap((left, index) => factorKeys.slice(index + 1).map(
    (right) => `interaction:${left}|${right}` as DoeAnalysisModelTerm
  ));
  if (modelFamily === "factorial") return [...mainEffects, ...interactions];
  return [
    ...mainEffects,
    ...interactions,
    ...factorKeys.map((key) => `quadratic:${key}` as DoeAnalysisModelTerm)
  ];
}

function normalizeOptimization(value: unknown): DoeAnalysisOptimization | undefined {
  if (!isRecord(value)) return undefined;
  const objective = value.objective;
  if (objective !== "minimize" && objective !== "maximize" && objective !== "target") return undefined;
  const factorBounds: Record<string, { min: number; max: number }> = {};
  if (isRecord(value.factorBounds)) {
    for (const [key, bounds] of Object.entries(value.factorBounds)) {
      if (!isRecord(bounds) || typeof bounds.min !== "number" || typeof bounds.max !== "number") continue;
      factorBounds[key] = { min: bounds.min, max: bounds.max };
    }
  }
  return {
    objective,
    ...(typeof value.target === "number" ? { target: value.target } : {}),
    ...(Object.keys(factorBounds).length ? { factorBounds } : {})
  };
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
    specification: normalizeAnalysisSpecification(dataset, input, { enforceModelFamilyCompatibility: true })
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
