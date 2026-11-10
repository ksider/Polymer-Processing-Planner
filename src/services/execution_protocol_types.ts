export type ExecutionProtocolLayout = "matrix" | "run-sheets";
export type ExecutionProtocolValueMode = "blank" | "current";

export type ExecutionProtocolField = {
  key: string;
  label: string;
  unit: string | null;
  fieldType: "number" | "text" | "tag" | "boolean";
};

export type ExecutionProtocolRecipe = {
  name: string;
  description: string | null;
  components: Array<{ name: string; phr: number }>;
};

export type ExecutionProtocolRun = {
  runCode: string;
  runOrder: number;
  referenceValue: string | null;
  plannedValues: Record<string, string>;
  recordedValues: Record<string, string>;
  calculatedValues: Record<string, string>;
};

export type ExecutionProtocolReferenceSection = {
  title: string;
  paragraphs?: string[];
  items?: string[];
};

export type ExecutionProtocolSection = {
  key: string;
  title: string;
  description?: string;
  runReferenceLabel: string;
  plannedFields: ExecutionProtocolField[];
  recordedFields: ExecutionProtocolField[];
  calculatedFields: ExecutionProtocolField[];
  runs: ExecutionProtocolRun[];
};

export type ExecutionProtocol = {
  protocolTitle: string;
  experimentName: string;
  entityName: string;
  descriptorLabel: string;
  descriptorValue: string;
  processName: string | null;
  machineName: string | null;
  runReferenceLabel: string;
  generatedAt: string;
  revisionFingerprint: string;
  plannedFields: ExecutionProtocolField[];
  recordedFields: ExecutionProtocolField[];
  calculatedFields: ExecutionProtocolField[];
  runs: ExecutionProtocolRun[];
  sections: ExecutionProtocolSection[];
  recipes: ExecutionProtocolRecipe[];
  referenceSections: ExecutionProtocolReferenceSection[];
  missingPlannedValueCount: number;
  isDraft: boolean;
  warnings: string[];
};

export class ExecutionProtocolError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}
