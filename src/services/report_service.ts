import type { Db } from "../db.js";
import { getExperiment, getExperimentRecipes } from "../repos/experiments_repo.js";
import { listQualSummaries, listQualRuns, listQualRunValues, listQualFields, listQualSteps, getQualStep } from "../repos/qual_repo.js";
import { getDoeStudy, listDoeStudies } from "../repos/doe_repo.js";
import { listRuns, listRunValues } from "../repos/runs_repo.js";
import { listParamConfigs, listParamDefinitions, listParamDefinitionsByKind } from "../repos/params_repo.js";
import { getRecipe, getRecipeComponents } from "../repos/recipes_repo.js";
import { getMachine } from "../repos/machines_repo.js";
import { listActiveAnalysisFields, listAnalysisRunValuesByRunIds } from "../repos/analysis_repo.js";
import {
  buildRegressionAnalysis,
  filterRuns,
  loadRuns,
  summarizeByFactorAnalysis,
  summarizeHeatmapAnalysis,
  type AnalysisValueRow,
  type RunRow
} from "./analysis_service.js";
import { mean, sd } from "../domain/stats.js";
import { findUserById } from "../repos/users_repo.js";

type ReportOptions = {
  includeQualification: boolean;
  includeDoe: boolean;
  includeOutputs: boolean;
  includeDefects: boolean;
  includeRawRuns: boolean;
  executors?: string | null;
  doeIds?: number[];
};

type ReportRecipe = {
  id: number;
  name: string;
  description: string | null;
  components: Array<{ component_name: string; phr: number }>;
};

type ReportData = {
  experiment: {
    id: number;
    name: string;
    notes: string | null;
  };
  executors: string | null;
  machineName: string | null;
  recipes: ReportRecipe[];
  qualification?: {
    recommended_inj_speed: number | null;
    window: {
      low_temp: number | null;
      high_temp: number | null;
      low_pressure_min: number | null;
      low_pressure_max: number | null;
      high_pressure_min: number | null;
      high_pressure_max: number | null;
      center_temp: number | null;
      center_pressure: number | null;
    };
    gate_seal_time_s: number | null;
    min_cooling_time_s: number | null;
    charts: {
      rheology: Array<{ x: number; y: number } | null>;
      processWindow: {
        good: Array<[number, number]>;
        defect: Array<[number, number]>;
        window: Array<[number, number]> | null;
        center: [number, number] | null;
      };
    };
  };
  doe?: Array<{
    id: number;
    name: string;
    design_type: string;
    run_count: number;
    factors: Array<{
      code: string;
      label: string;
      mode: string;
      values: string;
    }>;
  }>;
  outputs?: Array<{
    code: string;
    label: string;
    unit: string | null;
  }>;
};

type ReportWorkspaceSourceRow = { label: string; value: string };

type ReportWorkspaceSource = {
  id: string;
  kind: "value" | "recipe" | "branch" | "results" | "run" | "chart" | "doe-analysis" | "doe-runs";
  label: string;
  value?: string | null;
  description?: string | null;
  components?: Array<{ component_name: string; phr: number }>;
  rows?: ReportWorkspaceSourceRow[];
  children?: ReportWorkspaceSource[];
  runUrl?: string;
  chartType?: "rheology" | "process-window" | "run-series";
  chartData?: { categories: string[]; values: Array<number | null>; unit: string | null };
  studyId?: number;
  runCount?: number;
};

type ReportWorkspaceSourceGroup = {
  id: string;
  label: string;
  icon: string;
  items: ReportWorkspaceSource[];
};

const parseSummary = (summaryJson: string | null) => {
  if (!summaryJson) return null;
  try {
    return JSON.parse(summaryJson) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export function buildReport(db: Db, experimentId: number, options: ReportOptions): ReportData {
  const experiment = getExperiment(db, experimentId);
  if (!experiment) throw new Error("Experiment not found");
  const machine = experiment.machine_id ? getMachine(db, experiment.machine_id) : null;

  const recipeIds = getExperimentRecipes(db, experimentId);
  const recipes: ReportRecipe[] = recipeIds.flatMap((id) => {
      const recipe = getRecipe(db, id);
      if (!recipe) return [];
      return [{
        id: recipe.id,
        name: recipe.name,
        description: recipe.description,
        components: getRecipeComponents(db, recipe.id)
      }];
    });

  const data: ReportData = {
    experiment: {
      id: experiment.id,
      name: experiment.name,
      notes: experiment.notes
    },
    executors: options.executors ?? null,
    machineName: machine?.name ?? null,
    recipes
  };

  if (options.includeQualification) {
    const summaries = listQualSummaries(db, experimentId);
    const step1Summary = parseSummary(summaries.find((s) => s.step_number === 1)?.summary_json ?? null);
    const step4Summary = parseSummary(summaries.find((s) => s.step_number === 4)?.summary_json ?? null);
    const step5Summary = parseSummary(summaries.find((s) => s.step_number === 5)?.summary_json ?? null);
    const step6Summary = parseSummary(summaries.find((s) => s.step_number === 6)?.summary_json ?? null);

    const recommendedInj = typeof step1Summary?.recommended_inj_speed === "number"
      ? step1Summary.recommended_inj_speed
      : null;

    const window = {
      low_temp: typeof step4Summary?.window_low_temp === "number" ? step4Summary.window_low_temp : null,
      high_temp: typeof step4Summary?.window_high_temp === "number" ? step4Summary.window_high_temp : null,
      low_pressure_min:
        typeof step4Summary?.window_low_pressure_min === "number" ? step4Summary.window_low_pressure_min : null,
      low_pressure_max:
        typeof step4Summary?.window_low_pressure_max === "number" ? step4Summary.window_low_pressure_max : null,
      high_pressure_min:
        typeof step4Summary?.window_high_pressure_min === "number" ? step4Summary.window_high_pressure_min : null,
      high_pressure_max:
        typeof step4Summary?.window_high_pressure_max === "number" ? step4Summary.window_high_pressure_max : null,
      center_temp:
        typeof step4Summary?.window_center_temp === "number" ? step4Summary.window_center_temp : null,
      center_pressure:
        typeof step4Summary?.window_center_pressure === "number" ? step4Summary.window_center_pressure : null
    };

    const gateSeal = typeof step5Summary?.gate_seal_time_s === "number" ? step5Summary.gate_seal_time_s : null;
    const minCooling = typeof step6Summary?.min_cooling_time_s === "number" ? step6Summary.min_cooling_time_s : null;

    const charts = {
      rheology: [] as Array<{ x: number; y: number } | null>,
      processWindow: {
        good: [] as Array<[number, number]>,
        defect: [] as Array<[number, number]>,
        window: null as Array<[number, number]> | null,
        center: null as [number, number] | null
      }
    };

    const step1 = getQualStep(db, experimentId, 1);
    if (step1) {
      const fields = listQualFields(db, step1.id);
      const fieldByCode = new Map(fields.map((f) => [f.code, f]));
      const injField = fieldByCode.get("inj_speed");
      const viscField = fieldByCode.get("rel_viscosity");
      if (injField && viscField) {
        const runs = listQualRuns(db, step1.id);
        runs.forEach((run) => {
          const values = listQualRunValues(db, run.id);
          const map = new Map(values.map((v) => [v.field_id, v]));
          const inj = map.get(injField.id)?.value_real ?? null;
          const visc = map.get(viscField.id)?.value_real ?? null;
          if (inj != null && visc != null) charts.rheology.push({ x: inj, y: visc });
        });
      }
    }

    const step4 = getQualStep(db, experimentId, 4);
    if (step4) {
      const fields = listQualFields(db, step4.id);
      const fieldByCode = new Map(fields.map((f) => [f.code, f]));
      const tempField = fieldByCode.get("melt_temp_c");
      const holdField = fieldByCode.get("hold_pressure_bar");
      const shortField = fieldByCode.get("defect_short_shot");
      const flashField = fieldByCode.get("defect_flash");
      if (tempField && holdField) {
        const runs = listQualRuns(db, step4.id);
        runs.forEach((run) => {
          const values = listQualRunValues(db, run.id);
          const map = new Map(values.map((v) => [v.field_id, v]));
          const temp = map.get(tempField.id)?.value_real ?? null;
          const hold = map.get(holdField.id)?.value_real ?? null;
          const short = shortField ? map.get(shortField.id)?.value_real === 1 : false;
          const flash = flashField ? map.get(flashField.id)?.value_real === 1 : false;
          if (temp != null && hold != null) {
            if (!short && !flash) charts.processWindow.good.push([temp, hold]);
            else charts.processWindow.defect.push([temp, hold]);
          }
        });
      }
      if (
        window.low_temp != null &&
        window.high_temp != null &&
        window.low_pressure_min != null &&
        window.low_pressure_max != null &&
        window.high_pressure_min != null &&
        window.high_pressure_max != null
      ) {
        charts.processWindow.window = [
          [window.low_temp, window.low_pressure_min],
          [window.low_temp, window.low_pressure_max],
          [window.high_temp, window.high_pressure_max],
          [window.high_temp, window.high_pressure_min],
          [window.low_temp, window.low_pressure_min]
        ];
      }
      if (window.center_temp != null && window.center_pressure != null) {
        charts.processWindow.center = [window.center_temp, window.center_pressure];
      }
    }

    data.qualification = {
      recommended_inj_speed: recommendedInj,
      window,
      gate_seal_time_s: gateSeal,
      min_cooling_time_s: minCooling,
      charts
    };
  }

  if (options.includeDoe) {
    const studies = listDoeStudies(db, experimentId).filter((study) => {
      if (!options.doeIds || options.doeIds.length === 0) return true;
      return options.doeIds.includes(study.id);
    });
    const params = listParamDefinitions(db, experimentId);
    const paramsById = new Map(params.map((p) => [p.id, p]));
    data.doe = studies.map((study) => {
      const configs = listParamConfigs(db, experimentId, study.id);
      const runs = listRuns(db, study.id);
      const factors = configs
        .filter((cfg) => cfg.active)
        .map((cfg) => {
          const def = paramsById.get(cfg.param_def_id);
          const values = cfg.mode === "FIXED"
            ? String(cfg.fixed_value_real ?? "")
            : cfg.mode === "RANGE"
              ? `${cfg.range_min_real ?? ""}..${cfg.range_max_real ?? ""}`
              : cfg.list_json ?? "";
          return {
            code: def?.code ?? String(cfg.param_def_id),
            label: def?.label ?? def?.code ?? String(cfg.param_def_id),
            mode: cfg.mode,
            values
          };
        });
      return {
        id: study.id,
        name: study.name,
        design_type: study.design_type,
        run_count: runs.length,
        factors
      };
    });
  }

  if (options.includeOutputs) {
    const outputs = listParamDefinitionsByKind(db, experimentId, "OUTPUT");
    data.outputs = outputs.map((out) => ({
      code: out.code,
      label: out.label,
      unit: out.unit
    }));
  }

  return data;
}

/**
 * The initial workspace catalogue deliberately stays compact. It exposes
 * stable, structured experiment data while the larger qualification and DOE
 * catalogues are moved behind access-scoped endpoints in later increments.
 */
export function buildReportWorkspaceSources(db: Db, report: ReportData): ReportWorkspaceSourceGroup[] {
  const experimentItems: ReportWorkspaceSource[] = [
    {
      id: "experiment-name",
      kind: "value",
      label: "Experiment name",
      value: report.experiment.name
    }
  ];
  if (report.experiment.notes?.trim()) {
    experimentItems.push({
      id: "experiment-description",
      kind: "value",
      label: "Description",
      value: report.experiment.notes
    });
  }

  const machineItems: ReportWorkspaceSource[] = report.machineName
    ? [{ id: "machine-name", kind: "value", label: "Machine", value: report.machineName }]
    : [];

  const recipeItems: ReportWorkspaceSource[] = report.recipes.map((recipe) => ({
    id: `recipe-${recipe.id}`,
    kind: "recipe",
    label: recipe.name,
    description: recipe.description,
    components: recipe.components
  }));

  const qualificationItems: ReportWorkspaceSource[] = listQualSteps(db, report.experiment.id).flatMap((step) => {
    const fields = listQualFields(db, step.id).filter((field) => field.is_enabled === 1);
    const summary = listQualSummaries(db, report.experiment.id).find((item) => item.step_number === step.step_number);
    const children: ReportWorkspaceSource[] = [];
    const parsedSummary = parseSummary(summary?.summary_json ?? null);
    if (parsedSummary) {
      const rows = Object.entries(parsedSummary)
        .filter(([key, value]) => !["experiment_id", "step_number"].includes(key) && value != null)
        .slice(0, 16)
        .map(([key, value]) => ({ label: key.replace(/_/g, " "), value: String(value) }));
      if (rows.length) children.push({
        id: `qualification-step-${step.step_number}-results`,
        kind: "results",
        label: "Results",
        rows
      });
    }

    const runs = listQualRuns(db, step.id)
      .filter((run) => run.done || listQualRunValues(db, run.id).length > 0)
      .slice(0, 30);
    if (runs.length) {
      children.push({
        id: `qualification-step-${step.step_number}-runs`,
        kind: "branch",
        label: `Runs (${runs.length})`,
        children: runs.map((run) => {
          const values = new Map(listQualRunValues(db, run.id).map((value) => [value.field_id, value]));
          const rows = fields.flatMap((field) => {
            const value = values.get(field.id);
            const raw = value?.value_text ?? value?.value_real ?? value?.value_tags_json;
            if (raw == null || raw === "") return [];
            return [{ label: field.label, value: `${raw}${field.unit ? ` ${field.unit}` : ""}` }];
          });
          return {
            id: `qualification-run-${run.id}`,
            kind: "run",
            label: run.run_code,
            rows,
            runUrl: `/qual-runs/${run.id}`
          };
        })
      });
    }

    // Every step can expose its measured numeric fields as a run-series chart.
    // This keeps the catalogue useful beyond the specialised rheology/window
    // figures without assuming that fields from different units are comparable.
    const numericFields = fields.filter((field) => field.field_type === "number").slice(0, 4);
    numericFields.forEach((field) => {
      const categories = runs.map((run) => run.run_code);
      const values = runs.map((run) => listQualRunValues(db, run.id)
        .find((value) => value.field_id === field.id)?.value_real ?? null);
      if (values.some((value) => value != null)) {
        children.push({
          id: `qualification-step-${step.step_number}-field-${field.id}-chart`,
          kind: "chart",
          label: `${field.label} by run`,
          chartType: "run-series",
          chartData: { categories, values, unit: field.unit }
        });
      }
    });

    if (step.step_number === 1 && report.qualification?.charts.rheology.some(Boolean)) {
      children.push({ id: "qualification-rheology-chart", kind: "chart", label: "Rheology curve", chartType: "rheology" });
    }
    const processWindow = report.qualification?.charts.processWindow;
    if (step.step_number === 4 && processWindow && (processWindow.good.length || processWindow.defect.length || processWindow.window?.length)) {
      children.push({ id: "qualification-process-window-chart", kind: "chart", label: "Process window", chartType: "process-window" });
    }

    return children.length ? [{
      id: `qualification-step-${step.step_number}`,
      kind: "branch",
      label: `Step ${step.step_number}`,
      children
    }] : [];
  });

  // DOE runs deliberately remain behind a paginated endpoint. The catalogue
  // only carries study metadata, so a large design cannot make the editor or
  // its right-hand source rail slow to render.
  const doeItems: ReportWorkspaceSource[] = listDoeStudies(db, report.experiment.id).map((study) => {
    const runCount = listRuns(db, study.id).length;
    return {
      id: `doe-study-${study.id}`,
      kind: "branch",
      label: study.name,
      children: [
        {
          id: `doe-study-${study.id}-analysis`,
          kind: "doe-analysis",
          label: "Analysis",
          studyId: study.id,
          runCount
        },
        {
          id: `doe-study-${study.id}-runs`,
          kind: "doe-runs",
          label: `Runs (${runCount})`,
          studyId: study.id,
          runCount
        }
      ]
    };
  });

  return [
    { id: "experiment", label: "Experiment", icon: "science", items: experimentItems },
    { id: "machine", label: "Machine", icon: "precision_manufacturing", items: machineItems },
    { id: "recipes", label: "Recipes", icon: "category", items: recipeItems },
    { id: "qualification", label: "Qualification", icon: "biotech", items: qualificationItems },
    { id: "doe", label: "DOE", icon: "query_stats", items: doeItems }
  ].filter((group) => group.items.length > 0);
}

type DoeAnalysisMode = "overall" | "factor" | "matrix" | "regression";

type DoeAnalysisField = { id: number; label: string; unit: string | null };
type DoeAnalysisFactor = { id: number; label: string; unit: string | null };

const formatDoeNumber = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return "–";
  return Number(value.toFixed(5)).toString();
};

const buildAnalysisValueMapWithFallback = (
  runs: RunRow[],
  analysisValues: AnalysisValueRow[],
  fields: Array<{ id: number; code: string }>,
  params: Array<{ id: number; code: string }>
) => {
  const map = new Map<string, AnalysisValueRow>();
  analysisValues.forEach((row) => map.set(`${row.run_id}:${row.field_id}`, row));
  const paramIdByCode = new Map(params.map((param) => [param.code, param.id]));
  fields.forEach((field) => {
    const paramId = paramIdByCode.get(field.code);
    if (!paramId) return;
    runs.forEach((run) => {
      const key = `${run.id}:${field.id}`;
      const value = run.values[paramId];
      if (!map.has(key) && value != null) {
        map.set(key, {
          run_id: run.id,
          field_id: field.id,
          value_real: value,
          value_text: null,
          value_tags_json: null
        });
      }
    });
  });
  return map;
};

const getDoeAnalysisContext = (db: Db, experimentId: number, doeId: number) => {
  const study = getDoeStudy(db, doeId);
  if (!study || study.experiment_id !== experimentId) return null;
  const params = listParamDefinitions(db, experimentId);
  const configs = listParamConfigs(db, experimentId, doeId);
  const activeParamIds = new Set(configs.filter((config) => config.active === 1).map((config) => config.param_def_id));
  const factors: DoeAnalysisFactor[] = params
    .filter((param) => param.field_kind === "INPUT" && param.field_type === "number" && activeParamIds.has(param.id))
    .map((param) => ({ id: param.id, label: param.label, unit: param.unit }));
  const outputFields = listActiveAnalysisFields(db, doeId)
    .filter((field) => field.field_type === "number")
    .map((field) => ({ id: field.id, label: field.label, unit: field.unit, code: field.code }));
  return { study, params, factors, outputFields };
};

export function buildDoeReportAnalysis(
  db: Db,
  experimentId: number,
  doeId: number,
  requestedMode: string | undefined,
  requestedOutputId: number,
  requestedFactorId: number,
  requestedSecondFactorId: number
) {
  const context = getDoeAnalysisContext(db, experimentId, doeId);
  if (!context) return null;
  const validModes: DoeAnalysisMode[] = ["overall", "factor", "matrix", "regression"];
  const mode = validModes.includes(requestedMode as DoeAnalysisMode)
    ? requestedMode as DoeAnalysisMode
    : "overall";
  const output = context.outputFields.find((field) => field.id === requestedOutputId) ?? context.outputFields[0] ?? null;
  const factor = context.factors.find((item) => item.id === requestedFactorId) ?? context.factors[0] ?? null;
  const secondFactor = context.factors.find((item) => item.id === requestedSecondFactorId && item.id !== factor?.id)
    ?? context.factors.find((item) => item.id !== factor?.id)
    ?? null;

  const options = {
    study: { id: context.study.id, name: context.study.name },
    outputs: context.outputFields.map(({ id, label, unit }) => ({ id, label, unit })),
    factors: context.factors,
    selected: {
      mode,
      outputId: output?.id ?? null,
      factorId: factor?.id ?? null,
      secondFactorId: secondFactor?.id ?? null
    }
  };

  if (!output) {
    return {
      ...options,
      analysis: { title: "Analysis", columns: [], rows: [], message: "No active numeric analysis fields in this DOE study.", chart: null }
    };
  }

  if (mode === "factor" && !factor) {
    return {
      ...options,
      analysis: { title: `${output.label}: by factor`, columns: [], rows: [], message: "Add an active numeric input factor to compare this output.", chart: null }
    };
  }

  if (mode === "matrix" && (!factor || !secondFactor)) {
    return {
      ...options,
      analysis: { title: `${output.label}: factor matrix`, columns: [], rows: [], message: "Add two active numeric input factors for a factor matrix.", chart: null }
    };
  }

  if (mode === "regression" && !factor) {
    return {
      ...options,
      analysis: { title: `${output.label}: linear model`, columns: [], rows: [], message: "Add an active numeric input factor for a linear model.", chart: null }
    };
  }

  const allRuns = loadRuns(db, doeId);
  const includedRuns = filterRuns(allRuns, {});
  const fields = listActiveAnalysisFields(db, doeId);
  const analysisValues = listAnalysisRunValuesByRunIds(db, allRuns.map((run) => run.id));
  const values = buildAnalysisValueMapWithFallback(allRuns, analysisValues, fields, context.params);
  const outputValues = includedRuns
    .map((run) => values.get(`${run.id}:${output.id}`)?.value_real ?? null)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const unitSuffix = output.unit ? ` (${output.unit})` : "";

  if (mode === "factor" && factor) {
    const summary = summarizeByFactorAnalysis(includedRuns, values, output.id, factor.id);
    return {
      ...options,
      analysis: {
        title: `${output.label} by ${factor.label}`,
        columns: [factor.label + (factor.unit ? ` (${factor.unit})` : ""), `Mean${unitSuffix}`, `SD${unitSuffix}`, "n"],
        rows: summary.map((row) => [formatDoeNumber(row.factor), formatDoeNumber(row.mean), formatDoeNumber(row.sd), String(row.n)]),
        message: summary.length ? null : "No completed values are available for this comparison.",
        chart: summary.length ? {
          type: "line",
          title: `${output.label} by ${factor.label}`,
          categories: summary.map((row) => formatDoeNumber(row.factor)),
          values: summary.map((row) => row.mean),
          unit: output.unit
        } : null
      }
    };
  }

  if (mode === "matrix" && factor && secondFactor) {
    const cells = summarizeHeatmapAnalysis(includedRuns, values, output.id, factor.id, secondFactor.id);
    const xValues = Array.from(new Set(cells.map((cell) => formatDoeNumber(cell.x))));
    const yValues = Array.from(new Set(cells.map((cell) => formatDoeNumber(cell.y))));
    return {
      ...options,
      analysis: {
        title: `${output.label}: ${factor.label} × ${secondFactor.label}`,
        columns: [factor.label + (factor.unit ? ` (${factor.unit})` : ""), secondFactor.label + (secondFactor.unit ? ` (${secondFactor.unit})` : ""), `Mean${unitSuffix}`, `SD${unitSuffix}`, "n"],
        rows: cells.map((cell) => [formatDoeNumber(cell.x), formatDoeNumber(cell.y), formatDoeNumber(cell.mean), formatDoeNumber(cell.sd), String(cell.n)]),
        message: cells.length ? null : "No completed values are available for this factor matrix.",
        chart: cells.length ? {
          type: "heatmap",
          title: `${output.label}: ${factor.label} × ${secondFactor.label}`,
          xLabel: factor.label,
          yLabel: secondFactor.label,
          xValues,
          yValues,
          values: cells.map((cell) => [xValues.indexOf(formatDoeNumber(cell.x)), yValues.indexOf(formatDoeNumber(cell.y)), cell.mean]),
          unit: output.unit
        } : null
      }
    };
  }

  if (mode === "regression" && factor) {
    const regressionFactors = [factor, ...(secondFactor ? [secondFactor] : [])]
      .map((selectedFactor) => context.params.find((param) => param.id === selectedFactor.id))
      .filter((param): param is NonNullable<typeof param> => Boolean(param));
    const regression = buildRegressionAnalysis(includedRuns, values, output.id, regressionFactors);
    const labels = ["Intercept", ...regressionFactors.map((item) => item.label)];
    const rows = regression.coefficients.map((coefficient, index) => [labels[index] ?? `β${index}`, formatDoeNumber(coefficient)]);
    return {
      ...options,
      analysis: {
        title: `${output.label}: linear model`,
        columns: ["Term", "Coefficient"],
        rows: [...rows, ["R²", formatDoeNumber(regression.r2)]],
        message: regression.coefficients.length ? null : `At least ${regressionFactors.length + 2} complete runs are required for this model.`,
        chart: regression.coefficients.length ? {
          type: "bar",
          title: `${output.label}: model coefficients`,
          categories: labels.slice(1),
          values: regression.coefficients.slice(1),
          unit: output.unit
        } : null
      }
    };
  }

  return {
    ...options,
    analysis: {
      title: `${output.label}: overall result`,
      columns: ["Metric", `Value${unitSuffix}`],
      rows: [
        ["Complete runs", String(outputValues.length)],
        ["Mean", formatDoeNumber(mean(outputValues))],
        ["Standard deviation", formatDoeNumber(sd(outputValues))],
        ["Minimum", formatDoeNumber(outputValues.length ? Math.min(...outputValues) : null)],
        ["Maximum", formatDoeNumber(outputValues.length ? Math.max(...outputValues) : null)]
      ],
      message: outputValues.length ? null : "No completed values are available for this output.",
      chart: null
    }
  };
}

const displayRunValue = (
  value: { value_real: number | null; value_text: string | null; value_tags_json: string | null } | undefined,
  unit: string | null
) => {
  if (!value) return "–";
  if (value.value_text?.trim()) return value.value_text.trim();
  if (value.value_tags_json) {
    try {
      const parsed = JSON.parse(value.value_tags_json);
      if (Array.isArray(parsed)) return parsed.map(String).join(", ") || "–";
    } catch {
      return value.value_tags_json;
    }
  }
  return value.value_real == null ? "–" : `${formatDoeNumber(value.value_real)}${unit ? ` ${unit}` : ""}`;
};

export function buildDoeReportRunsPage(
  db: Db,
  experimentId: number,
  doeId: number,
  requestedPage: number,
  requestedPageSize: number
) {
  const context = getDoeAnalysisContext(db, experimentId, doeId);
  if (!context) return null;
  const pageSize = Math.min(Math.max(Number.isFinite(requestedPageSize) ? Math.floor(requestedPageSize) : 25, 10), 50);
  const allRuns = listRuns(db, doeId);
  const total = allRuns.length;
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1, 1), pageCount);
  const runs = allRuns.slice((page - 1) * pageSize, page * pageSize);
  const analysisFields = listActiveAnalysisFields(db, doeId);
  const paramIdByCode = new Map(context.params.map((param) => [param.code, param.id]));
  const analysisFieldById = new Map(analysisFields.map((field) => [field.id, field]));
  const fields = [
    ...context.factors.map((field) => ({ key: `input-${field.id}`, label: field.label, unit: field.unit, type: "input" as const, id: field.id })),
    ...analysisFields.map((field) => ({ key: `analysis-${field.id}`, label: field.label, unit: field.unit, type: "analysis" as const, id: field.id }))
  ];
  const analysisValues = listAnalysisRunValuesByRunIds(db, runs.map((run) => run.id));
  const analysisMap = new Map(analysisValues.map((value) => [`${value.run_id}:${value.field_id}`, value]));

  return {
    study: { id: context.study.id, name: context.study.name },
    fields: fields.map(({ key, label, unit }) => ({ key, label, unit })),
    page,
    pageSize,
    pageCount,
    total,
    runs: runs.map((run) => {
      const owner = run.owner_user_id ? findUserById(db, run.owner_user_id) : null;
      const runValues = new Map(listRunValues(db, run.id).map((value) => [value.param_def_id, value]));
      return {
        id: run.id,
        code: run.run_code,
        done: run.done === 1,
        excluded: run.exclude_from_analysis === 1,
        responsible: owner?.name?.trim() || owner?.email || "Not assigned",
        url: `/experiments/${experimentId}/runs/${run.id}`,
        values: Object.fromEntries(fields.map((field) => [
          field.key,
          field.type === "input"
            ? displayRunValue(runValues.get(field.id), field.unit)
            : displayRunValue(
              analysisMap.get(`${run.id}:${field.id}`)
                ?? runValues.get(paramIdByCode.get(analysisFieldById.get(field.id)?.code ?? "") ?? -1),
              field.unit
            )
        ]))
      };
    })
  };
}

export type ReportTemplateType = "QUALIFICATION" | "DOE" | "COMBINED";

export function buildReportWorkspaceOutline(reportType: ReportTemplateType = "COMBINED") {
  const paragraph = () => ({ type: "paragraph" });
  const heading = (text: string, level: 2 | 3) => ({
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }]
  });

  const qualification = [
    heading("3. Qualification", 2),
    heading("Test summary", 3),
    paragraph(),
    heading("Recommended process window", 3),
    paragraph()
  ];
  const doe = [
    heading(reportType === "DOE" ? "3. DOE studies" : "4. DOE studies", 2),
    heading("Study design", 3),
    paragraph(),
    heading("Results", 3),
    paragraph()
  ];
  return {
    type: "doc",
    content: [
      heading("1. Objective", 2),
      paragraph(),
      heading("2. Materials and equipment", 2),
      heading("Machine", 3),
      paragraph(),
      heading("Recipe", 3),
      paragraph(),
      ...(reportType === "DOE" ? [] : qualification),
      ...(reportType === "QUALIFICATION" ? [] : doe),
      heading(reportType === "COMBINED" ? "5. Conclusions" : "4. Conclusions", 2),
      paragraph()
    ]
  };
}

export function buildReportWorkspaceOutlineMarkdown(reportType: ReportTemplateType = "COMBINED") {
  return [
    "## 1. Objective",
    "",
    "## 2. Materials and equipment",
    "",
    "### Machine",
    "",
    "### Recipe",
    "",
    ...(reportType === "DOE" ? [] : ["## 3. Qualification", "", "### Test summary", "", "### Recommended process window", ""]),
    ...(reportType === "QUALIFICATION" ? [] : [`## ${reportType === "DOE" ? "3" : "4"}. DOE studies`, "", "### Study design", "", "### Results", ""]),
    `## ${reportType === "COMBINED" ? "5" : "4"}. Conclusions`
  ].join("\n");
}

export function buildQualificationCsv(data: ReportData) {
  const q = data.qualification;
  if (!q) return "";
  const rows = [
    [
      "recommended_inj_speed",
      "window_low_temp",
      "window_high_temp",
      "window_low_pressure_min",
      "window_low_pressure_max",
      "window_high_pressure_min",
      "window_high_pressure_max",
      "window_center_temp",
      "window_center_pressure",
      "gate_seal_time_s",
      "min_cooling_time_s"
    ],
    [
      q.recommended_inj_speed,
      q.window.low_temp,
      q.window.high_temp,
      q.window.low_pressure_min,
      q.window.low_pressure_max,
      q.window.high_pressure_min,
      q.window.high_pressure_max,
      q.window.center_temp,
      q.window.center_pressure,
      q.gate_seal_time_s,
      q.min_cooling_time_s
    ]
  ];
  return rows.map((row) => row.map((cell) => (cell ?? "")).join(",")).join("\n");
}

export function buildDoeCsv(data: ReportData) {
  const doe = data.doe ?? [];
  const rows: Array<Array<string | number>> = [["doe_id", "name", "design_type", "run_count", "factors"]];
  doe.forEach((study) => {
    const factorText = study.factors
      .map((f) => `${f.code}:${f.mode}:${f.values}`)
      .join(" | ");
    rows.push([study.id, study.name, study.design_type, study.run_count, factorText]);
  });
  return rows.map((row) => row.map((cell) => (cell ?? "")).join(",")).join("\n");
}

export function buildOutputsCsv(data: ReportData) {
  const outputs = data.outputs ?? [];
  const rows = [["code", "label", "unit"]];
  outputs.forEach((out) => rows.push([out.code, out.label, out.unit ?? ""]));
  return rows.map((row) => row.map((cell) => (cell ?? "")).join(",")).join("\n");
}

export function buildReportEditorSeed(
  report: ReportData,
  generatedAt: string,
  reportName: string | null
) {
  const blocks: Array<Record<string, unknown>> = [];
  blocks.push({
    type: "header",
    data: { text: reportName || `Experiment Report #${report.experiment.id}`, level: 1 }
  });
  blocks.push({
    type: "paragraph",
    data: { text: `Generated: ${generatedAt}` }
  });
  blocks.push({
    type: "paragraph",
    data: { text: `Author: ${report.executors || "-"}` }
  });
  blocks.push({ type: "delimiter", data: {} });

  blocks.push({ type: "header", data: { text: "1. Objective", level: 2 } });
  blocks.push({
    type: "paragraph",
    data: { text: report.experiment.notes || "-" }
  });

  blocks.push({ type: "header", data: { text: "2. Materials & Method", level: 2 } });
  blocks.push({
    type: "paragraph",
    data: { text: `Machine: ${report.machineName || "-"}` }
  });
  report.recipes.forEach((recipe) => {
    blocks.push({
      type: "paragraph",
      data: { text: `Recipe: ${recipe.name}` }
    });
    const compRows = recipe.components.map((comp) => [comp.component_name, String(comp.phr)]);
    blocks.push({
      type: "table",
      data: {
        withHeadings: true,
        content: [["Component", "PHR"], ...(compRows.length ? compRows : [["-", "-"]])]
      }
    });
  });

  blocks.push({ type: "header", data: { text: "3. Final Procedure", level: 2 } });
  if (report.qualification) {
    const q = report.qualification;
    blocks.push({
      type: "table",
      data: {
        withHeadings: true,
        content: [
          ["Parameter", "Value"],
          ["Injection speed (cm3/s)", q.recommended_inj_speed ?? "-"],
          ["Process window center temp (°C)", q.window.center_temp ?? "-"],
          ["Process window center pressure (bar)", q.window.center_pressure ?? "-"],
          ["Gate seal time (s)", q.gate_seal_time_s ?? "-"],
          ["Min cooling time (s)", q.min_cooling_time_s ?? "-"]
        ]
      }
    });
  } else {
    blocks.push({ type: "paragraph", data: { text: "-" } });
  }

  blocks.push({ type: "header", data: { text: "4. Rheology", level: 2 } });
  blocks.push({ type: "paragraph", data: { text: "Rheology curve with selected point/band." } });
  blocks.push({
    type: "image",
    data: { url: "", caption: "Rheology curve" }
  });

  blocks.push({ type: "header", data: { text: "5. Process Window", level: 2 } });
  blocks.push({ type: "paragraph", data: { text: "Process window with accepted points." } });
  blocks.push({
    type: "image",
    data: { url: "", caption: "Process window" }
  });

  if (report.doe && report.doe.length) {
    blocks.push({ type: "header", data: { text: "6. DOE Results", level: 2 } });
    const doeRows = report.doe.map((study) => [
      study.name,
      study.design_type,
      String(study.run_count)
    ]);
    blocks.push({
      type: "table",
      data: { withHeadings: true, content: [["Study", "Type", "Runs"], ...doeRows] }
    });
  }

  return {
    time: Date.now(),
    version: "2.28.2",
    blocks
  };
}

export type { ReportOptions, ReportData, ReportWorkspaceSourceGroup };
