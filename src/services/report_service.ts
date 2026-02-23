import type { Db } from "../db.js";
import { getExperiment, getExperimentRecipes } from "../repos/experiments_repo.js";
import { listQualSummaries, listQualRuns, listQualRunValues, listQualFields, getQualStep } from "../repos/qual_repo.js";
import { listDoeStudies } from "../repos/doe_repo.js";
import { listRuns, listRunValues } from "../repos/runs_repo.js";
import { listParamConfigs, listParamDefinitions, listParamDefinitionsByKind } from "../repos/params_repo.js";
import { getRecipe, getRecipeComponents } from "../repos/recipes_repo.js";
import { getMachine } from "../repos/machines_repo.js";

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

export type { ReportOptions, ReportData };
