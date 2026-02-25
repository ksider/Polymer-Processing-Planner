import type { Db } from "../db.js";
import { mean, sd, linearRegression } from "../domain/stats.js";
import type { ParamDefinition } from "../repos/params_repo.js";

export type AnalysisValueRow = {
  run_id: number;
  field_id: number;
  value_real: number | null;
  value_text: string | null;
  value_tags_json: string | null;
};

export type AnalysisFilter = {
  excludeDone?: boolean;
  recipeId?: number | null;
  defectTag?: string | null;
};

export type RunRow = {
  id: number;
  run_order: number;
  run_code: string;
  recipe_id: number | null;
  doe_id: number | null;
  due_at: string | null;
  exclude_from_analysis: number;
  done: number;
  values: Record<number, number | null>;
  tags: Record<number, string[]>;
};

export function loadRuns(db: Db, doeId: number): RunRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.run_order, r.run_code, r.recipe_id, r.due_at, r.exclude_from_analysis, r.done,
              r.doe_id,
              rv.param_def_id, rv.value_real, rv.value_tags_json
       FROM runs r
       LEFT JOIN run_values rv ON rv.run_id = r.id
       WHERE r.doe_id = ?
       ORDER BY r.run_order`
    )
    .all(doeId) as Array<{
    id: number;
    run_order: number;
    run_code: string;
    recipe_id: number | null;
    due_at: string | null;
    doe_id: number | null;
    exclude_from_analysis: number;
    done: number;
    param_def_id: number | null;
    value_real: number | null;
    value_tags_json: string | null;
  }>;

  const map = new Map<number, RunRow>();
  for (const row of rows) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id,
        run_order: row.run_order,
        run_code: row.run_code,
        recipe_id: row.recipe_id,
        due_at: row.due_at,
        doe_id: row.doe_id,
        exclude_from_analysis: row.exclude_from_analysis,
        done: row.done,
        values: {},
        tags: {}
      });
    }
    const run = map.get(row.id)!;
    if (row.param_def_id != null) {
      run.values[row.param_def_id] = row.value_real;
      if (row.value_tags_json) {
        run.tags[row.param_def_id] = JSON.parse(row.value_tags_json);
      }
    }
  }
  return Array.from(map.values());
}

export function filterRuns(runs: RunRow[], filter: AnalysisFilter, defectParamId?: number): RunRow[] {
  return runs.filter((run) => {
    if (run.exclude_from_analysis === 1) return false;
    if (filter.excludeDone && run.done === 0) return false;
    if (filter.recipeId && run.recipe_id !== filter.recipeId) return false;
    if (filter.defectTag && defectParamId) {
      const tags = run.tags[defectParamId] ?? [];
      if (!tags.includes(filter.defectTag)) return false;
    }
    return true;
  });
}

export function summarizeByFactor(
  runs: RunRow[],
  outputParamId: number,
  factorParamId: number
) {
  const groups = new Map<number, number[]>();
  for (const run of runs) {
    const factorValue = run.values[factorParamId];
    const outputValue = run.values[outputParamId];
    if (factorValue == null || outputValue == null) continue;
    if (!groups.has(factorValue)) groups.set(factorValue, []);
    groups.get(factorValue)!.push(outputValue);
  }
  const summary = Array.from(groups.entries())
    .map(([factor, values]) => ({
      factor,
      mean: mean(values),
      sd: sd(values),
      n: values.length
    }))
    .sort((a, b) => a.factor - b.factor);
  return summary;
}

export function summarizeByFactorAnalysis(
  runs: RunRow[],
  analysisValueMap: Map<string, AnalysisValueRow>,
  outputFieldId: number,
  factorParamId: number
) {
  const groups = new Map<number, number[]>();
  for (const run of runs) {
    const factorValue = run.values[factorParamId];
    const outputValue = analysisValueMap.get(`${run.id}:${outputFieldId}`)?.value_real;
    if (factorValue == null || outputValue == null) continue;
    if (!groups.has(factorValue)) groups.set(factorValue, []);
    groups.get(factorValue)!.push(outputValue);
  }
  const summary = Array.from(groups.entries())
    .map(([factor, values]) => ({
      factor,
      mean: mean(values),
      sd: sd(values),
      n: values.length
    }))
    .sort((a, b) => a.factor - b.factor);
  return summary;
}

export function summarizeHeatmap(
  runs: RunRow[],
  outputParamId: number,
  xParamId: number,
  yParamId: number
) {
  const cellMap = new Map<string, number[]>();
  for (const run of runs) {
    const x = run.values[xParamId];
    const y = run.values[yParamId];
    const output = run.values[outputParamId];
    if (x == null || y == null || output == null) continue;
    const key = `${x}||${y}`;
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key)!.push(output);
  }
  const cells = Array.from(cellMap.entries()).map(([key, values]) => {
    const [x, y] = key.split("||").map(Number);
    return { x, y, mean: mean(values), sd: sd(values), n: values.length };
  });
  return cells;
}

export function summarizeHeatmapAnalysis(
  runs: RunRow[],
  analysisValueMap: Map<string, AnalysisValueRow>,
  outputFieldId: number,
  xParamId: number,
  yParamId: number
) {
  const cellMap = new Map<string, number[]>();
  for (const run of runs) {
    const x = run.values[xParamId];
    const y = run.values[yParamId];
    const output = analysisValueMap.get(`${run.id}:${outputFieldId}`)?.value_real;
    if (x == null || y == null || output == null) continue;
    const key = `${x}||${y}`;
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key)!.push(output);
  }
  const cells = Array.from(cellMap.entries()).map(([key, values]) => {
    const [x, y] = key.split("||").map(Number);
    return { x, y, mean: mean(values), sd: sd(values), n: values.length };
  });
  return cells;
}

export function buildRegression(
  runs: RunRow[],
  outputParamId: number,
  factors: ParamDefinition[]
) {
  const y: number[] = [];
  const x: number[][] = [];
  for (const run of runs) {
    const output = run.values[outputParamId];
    if (output == null) continue;
    const row: number[] = [1];
    let hasMissing = false;
    for (const factor of factors) {
      const value = run.values[factor.id];
      if (value == null) {
        hasMissing = true;
        break;
      }
      row.push(value);
    }
    if (hasMissing) continue;
    y.push(output);
    x.push(row);
  }
  if (y.length < factors.length + 2) {
    return { coefficients: [], r2: NaN };
  }
  return linearRegression(y, x);
}

export function buildRegressionAnalysis(
  runs: RunRow[],
  analysisValueMap: Map<string, AnalysisValueRow>,
  outputFieldId: number,
  factors: ParamDefinition[]
) {
  const y: number[] = [];
  const x: number[][] = [];
  for (const run of runs) {
    const output = analysisValueMap.get(`${run.id}:${outputFieldId}`)?.value_real;
    if (output == null) continue;
    const row: number[] = [1];
    let hasMissing = false;
    for (const factor of factors) {
      const value = run.values[factor.id];
      if (value == null) {
        hasMissing = true;
        break;
      }
      row.push(value);
    }
    if (hasMissing) continue;
    y.push(output);
    x.push(row);
  }
  if (y.length < factors.length + 2) {
    return { coefficients: [], r2: NaN };
  }
  return linearRegression(y, x);
}
