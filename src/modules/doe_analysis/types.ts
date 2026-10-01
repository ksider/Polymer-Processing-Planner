export const DOE_ANALYSIS_DATASET_CONTRACT_VERSION = "1.0" as const;

export type DoeAnalysisDataType = "number" | "text" | "boolean" | "tags" | "category" | "date";

export type DoeAnalysisColumnRole =
  | "meta"
  | "factor"
  | "response"
  | "block"
  | "replicate";

export type DoeAnalysisCellValue = number | string | boolean | string[] | null;

export type DoeResponseValueSource =
  | "measurement"
  | "measurement_conflict"
  | "legacy_run_value"
  | "missing"
  | "ambiguous_legacy";

export type DoeLegacyResponseAuditStatus =
  | "measurement_only"
  | "legacy_only"
  | "equal"
  | "conflict"
  | "ambiguous_legacy"
  | "missing";

export type DoeAnalysisColumn = {
  key: string;
  code: string;
  label: string;
  unit: string | null;
  dataType: DoeAnalysisDataType;
  role: DoeAnalysisColumnRole;
  source:
    | { kind: "run"; field: string }
    | { kind: "factor"; paramDefinitionId: number }
    | { kind: "response"; analysisFieldId: number }
    | { kind: "recipe" }
    | { kind: "replicate"; field: string };
  active: boolean;
  groupLabel: string | null;
  allowedValues: string[];
  factor?: {
    mode: "FIXED" | "RANGE" | "LIST";
    levels: number[];
    coding: "two-level" | "three-level" | "fixed" | "none";
  };
};

export type DoeAnalysisDatasetRow = {
  runId: number;
  runCode: string;
  runOrder: number;
  done: boolean;
  excluded: boolean;
  dueAt: string | null;
  recipeId: number | null;
  recipeName: string | null;
  replicateKey: string | null;
  replicateIndex: number | null;
  values: Record<string, DoeAnalysisCellValue>;
  codedValues: Record<string, number | null>;
  responseSources: Record<string, DoeResponseValueSource>;
};

export type DoeLegacyResponseAuditEntry = {
  runId: number;
  runCode: string;
  responseFieldId: number;
  responseCode: string;
  responseLabel: string;
  status: DoeLegacyResponseAuditStatus;
  measurementValue: DoeAnalysisCellValue;
  legacyValues: DoeAnalysisCellValue[];
};

export type DoeLegacyResponseAudit = {
  counts: Record<DoeLegacyResponseAuditStatus, number>;
  entries: DoeLegacyResponseAuditEntry[];
  hasConflicts: boolean;
  hasLegacyOnlyValues: boolean;
};

export type DoeAnalysisDatasetWarning = {
  code:
    | "INVALID_DESIGN_METADATA"
    | "DUPLICATE_FACTOR_CONFIG"
    | "RESPONSE_STORAGE_CONFLICT"
    | "AMBIGUOUS_LEGACY_RESPONSE";
  message: string;
  runId?: number;
  responseFieldId?: number;
};

export type DoeAnalysisDataset = {
  contractVersion: typeof DOE_ANALYSIS_DATASET_CONTRACT_VERSION;
  datasetRevision: string;
  experimentId: number;
  doe: {
    id: number;
    name: string;
    designType: string;
    seed: number;
    centerPoints: number;
    maxRuns: number;
    replicateCount: number;
    recipeAsBlock: boolean;
  };
  designMetadata: Record<string, unknown>;
  columns: DoeAnalysisColumn[];
  rows: DoeAnalysisDatasetRow[];
  responseAudit: DoeLegacyResponseAudit;
  warnings: DoeAnalysisDatasetWarning[];
};

export type BuildDoeAnalysisDatasetOptions = {
  includeInactiveResponses?: boolean;
};

