import type { Db } from "../../db.js";
import {
  normalizeAnalysisSpecification,
  type DoeAnalysisSpecification,
  type DoeAnalysisDerivedResponseOperation
} from "./analytics_contract.js";
import type { DoeAnalysisDataset } from "./types.js";

export type DoeAnalysisTemplateSpecification = {
  responseCode: string;
  factorCodes: string[];
  blockCodes: string[];
  modelFamily: DoeAnalysisSpecification["modelFamily"];
  modelTerms: Array<`main:${string}` | `interaction:${string}|${string}` | `quadratic:${string}`>;
  useCodedFactors: boolean;
  includeExcluded: boolean;
  includeIncomplete: boolean;
  confidenceLevel: number;
  responseTransform: DoeAnalysisSpecification["responseTransform"];
  derivedResponse?: { operation: DoeAnalysisDerivedResponseOperation; leftCode: string; rightCode: string };
  tagResponse?: { tag: string };
  optimization?: {
    objective: "minimize" | "maximize" | "target";
    target?: number;
    factorBounds?: Record<string, { min: number; max: number }>;
  };
};

export type DoeAnalysisTemplateRecord = {
  id: number;
  processTypeId: number;
  name: string;
  specification: DoeAnalysisTemplateSpecification;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

type TemplateRow = {
  id: number;
  process_type_id: number;
  name: string;
  specification_json: string;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export function listDoeAnalysisTemplates(db: Db, processTypeId: number): DoeAnalysisTemplateRecord[] {
  return (db.prepare(
    "SELECT * FROM doe_analysis_templates WHERE process_type_id = ? ORDER BY name COLLATE NOCASE, id"
  ).all(processTypeId) as TemplateRow[]).map(mapTemplate);
}

export function createDoeAnalysisTemplate(
  db: Db,
  input: { processTypeId: number; name: string; specification: DoeAnalysisTemplateSpecification; createdByUserId?: number | null }
): DoeAnalysisTemplateRecord {
  const timestamp = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO doe_analysis_templates
     (process_type_id, name, specification_json, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    input.processTypeId,
    input.name.trim(),
    JSON.stringify(input.specification),
    input.createdByUserId ?? null,
    timestamp,
    timestamp
  );
  const row = db.prepare("SELECT * FROM doe_analysis_templates WHERE id = ?").get(Number(result.lastInsertRowid)) as TemplateRow;
  return mapTemplate(row);
}

export function deleteDoeAnalysisTemplate(db: Db, processTypeId: number, templateId: number): boolean {
  return db.prepare("DELETE FROM doe_analysis_templates WHERE id = ? AND process_type_id = ?").run(templateId, processTypeId).changes > 0;
}

export function specificationToTemplate(
  dataset: DoeAnalysisDataset,
  specification: DoeAnalysisSpecification
): DoeAnalysisTemplateSpecification {
  const codeFor = (key: string) => {
    const column = dataset.columns.find((item) => item.key === key);
    if (!column) throw new Error(`Cannot save a template because column ${key} is unavailable.`);
    return column.code;
  };
  const factorCodes = specification.factorKeys.map(codeFor);
  const factorCodeForKey = new Map(specification.factorKeys.map((key, index) => [key, factorCodes[index]]));
  const convertTerm = (term: string) => {
    if (term.startsWith("main:")) return `main:${factorCodeForKey.get(term.slice(5)) ?? term.slice(5)}` as const;
    if (term.startsWith("quadratic:")) return `quadratic:${factorCodeForKey.get(term.slice(10)) ?? term.slice(10)}` as const;
    const [left, right] = term.slice("interaction:".length).split("|");
    return `interaction:${factorCodeForKey.get(left) ?? left}|${factorCodeForKey.get(right) ?? right}` as const;
  };
  const factorBounds = Object.fromEntries(Object.entries(specification.optimization?.factorBounds ?? {}).map(([key, bounds]) => [codeFor(key), bounds]));
  return {
    responseCode: codeFor(specification.responseKey),
    factorCodes,
    blockCodes: specification.blockKeys.map(codeFor),
    modelFamily: specification.modelFamily,
    modelTerms: specification.modelTerms.map(convertTerm),
    useCodedFactors: specification.useCodedFactors,
    includeExcluded: specification.includeExcluded,
    includeIncomplete: specification.includeIncomplete,
    confidenceLevel: specification.confidenceLevel,
    responseTransform: specification.responseTransform,
    derivedResponse: specification.derivedResponse ? {
      operation: specification.derivedResponse.operation,
      leftCode: codeFor(specification.derivedResponse.leftKey),
      rightCode: codeFor(specification.derivedResponse.rightKey)
    } : undefined,
    tagResponse: specification.tagResponse,
    optimization: specification.optimization ? {
      ...specification.optimization,
      factorBounds
    } : undefined
  };
}

export function templateToSpecification(
  dataset: DoeAnalysisDataset,
  template: DoeAnalysisTemplateSpecification
): DoeAnalysisSpecification {
  const keyFor = (code: string, role?: "factor" | "response" | "block") => {
    const matches = dataset.columns.filter((column) => column.active && column.code === code && (!role || column.role === role));
    if (matches.length !== 1) throw new Error(`Template field ${code} is not available uniquely in this DOE.`);
    return matches[0].key;
  };
  const factorKeys = template.factorCodes.map((code) => keyFor(code, "factor"));
  const keyForFactorCode = new Map(template.factorCodes.map((code, index) => [code, factorKeys[index]]));
  const convertTerm = (term: string) => {
    if (term.startsWith("main:")) return `main:${keyForFactorCode.get(term.slice(5)) ?? term.slice(5)}`;
    if (term.startsWith("quadratic:")) return `quadratic:${keyForFactorCode.get(term.slice(10)) ?? term.slice(10)}`;
    const [left, right] = term.slice("interaction:".length).split("|");
    return `interaction:${keyForFactorCode.get(left) ?? left}|${keyForFactorCode.get(right) ?? right}`;
  };
  const factorBounds = Object.fromEntries(Object.entries(template.optimization?.factorBounds ?? {}).map(([code, bounds]) => [keyFor(code, "factor"), bounds]));
  return normalizeAnalysisSpecification(dataset, {
    responseKey: keyFor(template.responseCode, "response"),
    factorKeys,
    blockKeys: template.blockCodes.map((code) => keyFor(code, "block")),
    modelFamily: template.modelFamily,
    modelTerms: template.modelTerms.map(convertTerm) as DoeAnalysisSpecification["modelTerms"],
    useCodedFactors: template.useCodedFactors,
    includeExcluded: template.includeExcluded,
    includeIncomplete: template.includeIncomplete,
    confidenceLevel: template.confidenceLevel,
    responseTransform: template.responseTransform,
    derivedResponse: template.derivedResponse ? {
      operation: template.derivedResponse.operation,
      leftKey: keyFor(template.derivedResponse.leftCode, "response"),
      rightKey: keyFor(template.derivedResponse.rightCode, "response")
    } : undefined,
    tagResponse: template.tagResponse,
    optimization: template.optimization ? { ...template.optimization, factorBounds } : undefined
  }, { enforceModelFamilyCompatibility: true });
}

function mapTemplate(row: TemplateRow): DoeAnalysisTemplateRecord {
  return {
    id: row.id,
    processTypeId: row.process_type_id,
    name: row.name,
    specification: JSON.parse(row.specification_json) as DoeAnalysisTemplateSpecification,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
