import type { DoeAnalysisRevisionRecord } from "./analysis_repo.js";
import { scoreMultiResponseCandidate, type MultiResponseGoal } from "./multi_response_optimizer.js";
import type { DoeAnalysisDataset } from "./types.js";

export type MultiResponseGoalInput = {
  analysisId: number;
  objective: "minimize" | "maximize" | "target";
  target?: number;
  importance?: number;
};

export type MultiResponseOptimization = {
  datasetRevision: string;
  candidatesEvaluated: number;
  desirability: number;
  factorValues: Record<string, number>;
  responses: Array<{
    analysisId: number;
    responseKey: string;
    predicted: number;
    desirability: number;
    objective: MultiResponseGoalInput["objective"];
    target: number | null;
  }>;
};

type Model = {
  analysisId: number;
  revision: DoeAnalysisRevisionRecord;
  goal: MultiResponseGoalInput;
  observedMin: number;
  observedMax: number;
};

export function optimizeSavedAnalyses(
  revisions: Array<{ analysisId: number; revision: DoeAnalysisRevisionRecord }> ,
  inputs: MultiResponseGoalInput[],
  factorBounds: Record<string, { min: number; max: number }> = {}
): MultiResponseOptimization {
  if (inputs.length < 2) throw new Error("Select at least two saved analyses.");
  const byAnalysis = new Map(revisions.map((item) => [item.analysisId, item.revision]));
  const models = inputs.map((goal) => {
    const revision = byAnalysis.get(goal.analysisId);
    if (!revision?.result || !revision.dataset) throw new Error("Recalculate selected analyses to create reproducible dataset snapshots.");
    const responseKey = revision.specification.responseKey;
    const observed = revision.dataset.rows
      .map((row) => row.values[responseKey])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (observed.length < 2) throw new Error(`Response ${responseKey} needs at least two measured values.`);
    return {
      analysisId: goal.analysisId,
      revision,
      goal,
      observedMin: Math.min(...observed),
      observedMax: Math.max(...observed)
    } satisfies Model;
  });
  const dataset = models[0].revision.dataset!;
  const datasetRevision = models[0].revision.datasetRevision;
  const factorKeys = models[0].revision.specification.factorKeys;
  for (const model of models) {
    if (model.revision.datasetRevision !== datasetRevision || !sameKeys(model.revision.specification.factorKeys, factorKeys)) {
      throw new Error("Selected analyses must use the same dataset snapshot and factor set.");
    }
  }
  const ranges = factorKeys.map((key) => rangeForFactor(dataset, key, factorBounds[key]));
  const levels = Math.max(5, Math.min(31, Math.floor(50000 ** (1 / ranges.length))));
  const candidates = cartesian(ranges.map((range) => sequence(range.min, range.max, levels)));
  let best: MultiResponseOptimization | null = null;
  for (const values of candidates) {
    const factorValues = Object.fromEntries(factorKeys.map((key, index) => [key, values[index]]));
    const predictions = models.map((model) => ({
      responseKey: model.revision.specification.responseKey,
      predicted: predict(model.revision, factorValues)
    }));
    const goals: MultiResponseGoal[] = models.map((model) => ({
      responseKey: model.revision.specification.responseKey,
      objective: model.goal.objective,
      target: model.goal.target,
      importance: model.goal.importance,
      observedMin: model.observedMin,
      observedMax: model.observedMax
    }));
    const score = scoreMultiResponseCandidate(goals, predictions);
    if (!best || score.desirability > best.desirability) {
      best = {
        datasetRevision,
        candidatesEvaluated: candidates.length,
        desirability: score.desirability,
        factorValues,
        responses: models.map((model) => {
          const responseKey = model.revision.specification.responseKey;
          return {
            analysisId: model.analysisId,
            responseKey,
            predicted: predictions.find((item) => item.responseKey === responseKey)?.predicted ?? Number.NaN,
            desirability: score.components[responseKey] ?? 0,
            objective: model.goal.objective,
            target: model.goal.objective === "target" ? model.goal.target ?? null : null
          };
        })
      };
    }
  }
  if (!best) throw new Error("No valid candidate settings were available.");
  return best;
}

function predict(revision: DoeAnalysisRevisionRecord, raw: Record<string, number>): number {
  const result = revision.result!;
  const coordinates = Object.fromEntries(revision.specification.factorKeys.map((key) => [key, modelCoordinate(revision.dataset!, key, raw[key], revision.specification.useCodedFactors)]));
  return result.coefficients.reduce((total, coefficient) => {
    if (!Number.isFinite(coefficient.estimate)) return total;
    const term = coefficient.term;
    if (term === "(Intercept)") return total + coefficient.estimate!;
    const quadratic = /^I\((factor:\d+)\^2\)$/.exec(term);
    if (quadratic) return total + coefficient.estimate! * coordinates[quadratic[1]] ** 2;
    const parts = term.split(":").reduce<string[]>((items, part, index, all) => {
      if (part === "factor" && index + 1 < all.length) items.push(`factor:${all[index + 1]}`);
      return items;
    }, []);
    return parts.length ? total + coefficient.estimate! * parts.reduce((value, key) => value * coordinates[key], 1) : total;
  }, 0);
}

function modelCoordinate(dataset: DoeAnalysisDataset, key: string, value: number, coded: boolean): number {
  if (!coded) return value;
  const levels = dataset.columns.find((column) => column.key === key)?.factor?.levels ?? [];
  if (levels.length < 2) return value;
  if (levels.length === 3 && value <= levels[1]) return -1 + (value - levels[0]) / (levels[1] - levels[0]);
  const low = levels.length === 3 ? levels[1] : levels[0];
  const high = levels[levels.length - 1];
  return levels.length === 3 ? (value - low) / (high - low) : -1 + 2 * (value - low) / (high - low);
}

function rangeForFactor(dataset: DoeAnalysisDataset, key: string, requested?: { min: number; max: number }) {
  const values = dataset.rows.map((row) => row.values[key]).filter((value): value is number => typeof value === "number");
  const min = requested?.min ?? Math.min(...values);
  const max = requested?.max ?? Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) throw new Error(`Invalid bounds for ${key}.`);
  return { min, max };
}
function sequence(min: number, max: number, count: number) { return Array.from({ length: count }, (_, index) => min + (max - min) * index / (count - 1)); }
function cartesian(values: number[][]): number[][] { return values.reduce<number[][]>((rows, list) => rows.flatMap((row) => list.map((value) => [...row, value])), [[]]); }
function sameKeys(left: string[], right: string[]) { return left.length === right.length && left.every((key, index) => key === right[index]); }
