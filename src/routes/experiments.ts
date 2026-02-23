import express from "express";
import type { Db } from "../db.js";
import {
  createDoeWithDefaults,
  createExperimentWithDefaults,
  createCustomParam,
  generateRuns
} from "../services/experiments_service.js";
import { ensureQualificationDefaults, getQualificationSteps } from "../services/qualification_service.js";
import { listRecipes, getRecipeComponents } from "../repos/recipes_repo.js";
import {
  getExperiment,
  getExperimentRecipes,
  updateExperiment,
  getDesignMetadata,
  upsertDesignMetadata
} from "../repos/experiments_repo.js";
import { ensureExperimentAccess } from "../middleware/experiment_access.js";
import { getMachine, listMachines } from "../repos/machines_repo.js";
import {
  createDoeStudy,
  deleteDoeStudy,
  getDoeStudy,
  listDoeStudies,
  updateDoeStudyName
} from "../repos/doe_repo.js";
import { listQualSummaries } from "../repos/qual_repo.js";
import { listQualSteps } from "../repos/qual_repo.js";
import { createReportConfig, listReportConfigs, updateReportConfig, getReportConfig } from "../repos/reports_repo.js";
import {
  listParamDefinitions,
  listParamDefinitionsByKind,
  listParamConfigs,
  deleteParamConfig,
  upsertParamConfig,
  updateAllowedValues
} from "../repos/params_repo.js";
import {
  type AnalysisField,
  findExperimentAnalysisFieldByCode,
  insertAnalysisField,
  listActiveAnalysisFields,
  listExperimentAnalysisFields,
  listAnalysisRunValuesByRunIds,
  listStandardAnalysisFields,
  listTagValuesForExperimentField,
  updateAnalysisField,
  updateAnalysisFieldActive
} from "../repos/analysis_repo.js";
import { listRuns } from "../repos/runs_repo.js";
import {
  loadRuns,
  filterRuns,
  summarizeByFactorAnalysis,
  summarizeHeatmapAnalysis,
  buildRegressionAnalysis
} from "../services/analysis_service.js";
import { sd } from "../domain/stats.js";
import { toCsv } from "../lib/csv.js";
import {
  archiveExperiment,
  updateExperimentOwner,
  updateExperimentManualDone
} from "../repos/experiments_repo.js";
import { listUsers, findUserById } from "../repos/users_repo.js";
import { listEntityAssignmentsByExperiment } from "../repos/entity_assignments_repo.js";
import {
  assignEntityResponsibility,
  canAssignEntityResponsibility
} from "../services/entity_assignment_service.js";

// Local helper for role checks in this router.
function hasRole(req: express.Request, roles: string[]) {
  return roles.includes(req.user?.role ?? "");
}

function formatSummaryNumber(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  }
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

export function createExperimentsRouter(db: Db) {
  const router = express.Router();

  router.get("/experiments/new", (_req, res) => {
    if (!hasRole(_req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const recipes = listRecipes(db).map((recipe) => ({
      ...recipe,
      components: getRecipeComponents(db, recipe.id)
    }));
    const machines = listMachines(db);
    res.render("experiment_new", { recipes, machines });
  });

  router.post("/experiments", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const recipeIds = Array.isArray(req.body.recipe_ids)
      ? req.body.recipe_ids.map((id: string) => Number(id))
      : req.body.recipe_ids
        ? [Number(req.body.recipe_ids)]
        : [];

    const experimentId = createExperimentWithDefaults(db, {
      name: req.body.name,
      notes: req.body.notes || null,
      recipe_ids: recipeIds,
      machine_id: req.body.machine_id ? Number(req.body.machine_id) : null,
      owner_user_id: req.user?.id ?? null
    });
    ensureQualificationDefaults(db, experimentId);

    res.redirect(`/experiments/${experimentId}`);
  });

  router.use("/experiments/:id", ensureExperimentAccess(db));

  router.get("/experiments/:id", (req, res) => {
    const experimentId = Number(req.params.id);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const qualSummaries = listQualSummaries(db, experimentId);
    const qualSteps = listQualSteps(db, experimentId);
    const stepStatusByNumber = new Map(qualSteps.map((step) => [step.step_number, step.status]));
    const stepIdByNumber = new Map(qualSteps.map((step) => [step.step_number, step.id]));
    const summaryByStep = new Map(qualSummaries.map((summary) => [summary.step_number, summary.summary_json]));
    const qualificationCards = getQualificationSteps().map((stepDef) => {
      const stepNumber = stepDef.step_number;
      const summaryJson = summaryByStep.get(stepNumber) || null;
      let summaryData: Record<string, unknown> | null = null;
      if (summaryJson) {
        try {
          summaryData = JSON.parse(summaryJson) as Record<string, unknown>;
        } catch {
          summaryData = null;
        }
      }
      const rawStatus = stepStatusByNumber.get(stepNumber) || "DRAFT";
      const status =
        summaryJson || rawStatus === "DONE"
          ? "done"
          : rawStatus === "RUNNING"
            ? "in_progress"
            : "not_started";
      const statusLabel =
        status === "done" ? "Done" : status === "in_progress" ? "In progress" : "Not started";
      const summaryItems: Array<{ label: string; value: string }> = [];
      if (summaryData) {
        if (stepNumber === 4) {
          const centerTemp = summaryData.window_center_temp;
          const centerPressure = summaryData.window_center_pressure;
          summaryItems.push({
            label: "center temp",
            value: typeof centerTemp === "number" ? `${formatSummaryNumber(centerTemp)} °C` : "-"
          });
          summaryItems.push({
            label: "center pressure",
            value: typeof centerPressure === "number" ? `${formatSummaryNumber(centerPressure)} bar` : "-"
          });
        } else {
          Object.entries(summaryData)
            .filter(([key]) => !["experiment_id", "step_number"].includes(key))
            .slice(0, 2)
            .forEach(([key, value]) => {
              summaryItems.push({
                label: key.replace(/_/g, " "),
                value: typeof value === "number" ? formatSummaryNumber(value) : String(value ?? "-")
              });
            });
        }
      }
      return {
        stepId: stepIdByNumber.get(stepNumber) ?? null,
        stepNumber,
        name: stepDef.name,
        status,
        statusLabel,
        summaryItems
      };
    });
    const summaryCount = qualSummaries.length;
    const autoStatus = summaryCount > 0 ? "in_progress" : "not_started";
    const autoStatusLabel = autoStatus === "in_progress" ? "In progress" : "Not started";
    const manualDone = experiment.status_done_manual === 1;
    const status = manualDone ? "done" : autoStatus;
    const statusLabel = manualDone ? "Done" : autoStatusLabel;
    const doeStudies = listDoeStudies(db, experimentId);
    const machines = listMachines(db);
    const selectedMachine = experiment.machine_id ? getMachine(db, experiment.machine_id) : null;
    const recipeIds = getExperimentRecipes(db, experimentId);
    const recipeNameById = new Map(listRecipes(db).map((recipe) => [recipe.id, recipe.name]));
    const recipeNames = recipeIds.map((id) => recipeNameById.get(id)).filter(Boolean);
    const reports = listReportConfigs(db, experimentId);
    const entityAssignments = listEntityAssignmentsByExperiment(db, experimentId);
    const assignmentByStep = new Map<number, number | null>();
    const assignmentByDoe = new Map<number, number | null>();
    entityAssignments.forEach((row) => {
      if (row.entity_type === "qualification_step") {
        assignmentByStep.set(row.entity_id, row.assignee_user_id ?? null);
      } else if (row.entity_type === "doe") {
        assignmentByDoe.set(row.entity_id, row.assignee_user_id ?? null);
      }
    });
    // Owner selection is visible only to admin/manager.
    const canManageOwner = req.user?.role === "admin" || req.user?.role === "manager";
    const canAssignEntities = canAssignEntityResponsibility(req.user, experiment);
    const users = canManageOwner || canAssignEntities ? listUsers(db) : [];
    const assignableUsers = users.filter((user) => user.status === "ACTIVE");
    const userLabelById = new Map(
      assignableUsers.map((user) => [user.id, user.name?.trim() || user.email.trim()])
    );
    const ownerUser = experiment.owner_user_id
      ? findUserById(db, experiment.owner_user_id)
      : null;
    const ownerName = ownerUser?.name?.trim() || ownerUser?.email?.trim() || "";
    res.render("experiment_detail", {
      experiment,
      qualSummaries,
      qualificationCards,
      status,
      statusLabel,
      autoStatus,
      autoStatusLabel,
      doeStudies,
      machines,
      selectedMachine,
      recipeNames,
      reports,
      users,
      assignableUsers,
      userLabelById,
      canManageOwner,
      canAssignEntities,
      assignmentByStep,
      assignmentByDoe,
      ownerName
    });
  });

  router.get("/experiments/:id/doe-studies.json", (req, res) => {
    const experimentId = Number(req.params.id);
    const list = listDoeStudies(db, experimentId);
    res.json(list.map((study) => ({
      id: study.id,
      name: study.name,
      design_type: study.design_type
    })));
  });

  router.post("/experiments/:id/doe", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeName = String(req.body.name || "").trim();
    const existing = listDoeStudies(db, experimentId);
    const name = doeName || `DOE ${existing.length + 1}`;
    const designType = String(req.body.design_type || "SIM");
    const seed = Number(req.body.seed || 42);
    const centerPoints = Number(req.body.center_points || 3);
    const maxRuns = Number(req.body.max_runs || 200);
    const replicateCount = Number(req.body.replicate_count || 1);
    const recipeAsBlock = req.body.recipe_as_block ? 1 : 0;
    const doeId = createDoeWithDefaults(db, {
      experimentId,
      name,
      design_type: designType,
      seed,
      center_points: centerPoints,
      max_runs: maxRuns,
      replicate_count: replicateCount,
      recipe_as_block: recipeAsBlock
    });
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=design`);
  });

  router.post("/experiments/:id/reports", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const nameRaw = String(req.body.name || "").trim();
    const executors = String(req.body.executors || "").trim() || null;
    const include = Array.isArray(req.body.include)
      ? req.body.include.map((val: unknown) => String(val))
      : req.body.include
        ? [String(req.body.include)]
        : [];
    const doeIds = Array.isArray(req.body.doe_ids)
      ? req.body.doe_ids.map((val: unknown) => Number(val)).filter((val: number) => Number.isFinite(val))
      : req.body.doe_ids
        ? [Number(req.body.doe_ids)].filter((val) => Number.isFinite(val))
        : [];
    const existing = listReportConfigs(db, experimentId);
    const name = nameRaw || `Report ${existing.length + 1}`;
    const reportId = createReportConfig(db, {
      experiment_id: experimentId,
      name,
      executors,
      include_json: include.length ? JSON.stringify(include) : JSON.stringify([]),
      doe_ids_json: doeIds.length ? JSON.stringify(doeIds) : JSON.stringify([])
    });
    res.json({ id: reportId, url: `/reports/${reportId}` });
  });

  router.post("/experiments/:id/reports/:reportId", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const reportId = Number(req.params.reportId);
    const existing = getReportConfig(db, reportId);
    if (!existing || existing.experiment_id !== experimentId) {
      return res.status(404).send("Report not found");
    }
    if (existing.signed_at) {
      return res.status(403).json({ ok: false, message: "Signed report cannot be edited." });
    }
    const nameRaw = String(req.body.name || "").trim();
    const executors = String(req.body.executors || "").trim() || null;
    const include = Array.isArray(req.body.include)
      ? req.body.include.map((val: unknown) => String(val))
      : req.body.include
        ? [String(req.body.include)]
        : [];
    const doeIds = Array.isArray(req.body.doe_ids)
      ? req.body.doe_ids.map((val: unknown) => Number(val)).filter((val: number) => Number.isFinite(val))
      : req.body.doe_ids
        ? [Number(req.body.doe_ids)].filter((val) => Number.isFinite(val))
        : [];
    const name = nameRaw || existing.name;
    updateReportConfig(db, reportId, {
      name,
      executors,
      include_json: include.length ? JSON.stringify(include) : JSON.stringify([]),
      doe_ids_json: doeIds.length ? JSON.stringify(doeIds) : JSON.stringify([])
    });
    res.json({ id: reportId, url: `/reports/${reportId}` });
  });

  router.post("/experiments/:id/doe/:doeId/clone", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const doe = getDoeStudy(db, doeId);
    if (!doe || doe.experiment_id !== experimentId) {
      return res.status(404).send("DOE not found");
    }
    const clonedId = createDoeStudy(db, {
      experiment_id: experimentId,
      name: `${doe.name} (clone)`,
      design_type: doe.design_type,
      seed: doe.seed,
      center_points: doe.center_points,
      max_runs: doe.max_runs,
      replicate_count: doe.replicate_count,
      recipe_as_block: doe.recipe_as_block
    });
    const configs = listParamConfigs(db, experimentId, doeId);
    for (const cfg of configs) {
      upsertParamConfig(db, {
        experiment_id: experimentId,
        doe_id: clonedId,
        param_def_id: cfg.param_def_id,
        active: cfg.active,
        mode: cfg.mode,
        fixed_value_real: cfg.fixed_value_real,
        range_min_real: cfg.range_min_real,
        range_max_real: cfg.range_max_real,
        list_json: cfg.list_json,
        level_count: cfg.level_count
      });
    }
    const fields = listExperimentAnalysisFields(db, doeId);
    for (const field of fields) {
      insertAnalysisField(db, {
        scope_type: "DOE",
        scope_id: clonedId,
        code: field.code,
        label: field.label,
        field_type: field.field_type,
        unit: field.unit,
        group_label: field.group_label,
        allowed_values_json: field.allowed_values_json,
        is_standard: field.is_standard,
        is_active: field.is_active
      });
    }
    res.redirect(`/experiments/${experimentId}/doe/${clonedId}?tab=design`);
  });

  router.post("/experiments/:id/doe/:doeId/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const doe = getDoeStudy(db, doeId);
    if (!doe || doe.experiment_id !== experimentId) {
      return res.status(404).send("DOE not found");
    }
    deleteDoeStudy(db, doeId);
    res.redirect(`/experiments/${experimentId}`);
  });

  router.post("/experiments/:id/doe/:doeId/name", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const doe = getDoeStudy(db, doeId);
    if (!doe || doe.experiment_id !== experimentId) {
      return res.status(404).send("DOE not found");
    }
    const name = String(req.body?.name || "").trim();
    if (name) updateDoeStudyName(db, doeId, name);
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=design`);
  });

  router.post("/experiments/:id/qualification/:step/assignee", (req, res) => {
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    if (!canAssignEntityResponsibility(req.user, experiment)) {
      return res.status(403).send("Forbidden");
    }
    const step = listQualSteps(db, experimentId).find((item) => item.step_number === stepNumber);
    if (!step) return res.status(404).send("Step not found");
    const rawAssignee = String(req.body?.assignee_user_id ?? "").trim();
    const assigneeUserId = rawAssignee ? Number(rawAssignee) : null;
    if (rawAssignee && !Number.isFinite(assigneeUserId)) {
      return res.status(400).send("Invalid assignee");
    }
    assignEntityResponsibility(db, {
      experimentId,
      entityType: "qualification_step",
      entityId: step.id,
      assigneeUserId,
      assignedByUserId: req.user?.id ?? null,
      experimentName: experiment.name
    });
    res.redirect(`/experiments/${experimentId}#qualification`);
  });

  router.post("/experiments/:id/doe/:doeId/assignee", (req, res) => {
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    if (!canAssignEntityResponsibility(req.user, experiment)) {
      return res.status(403).send("Forbidden");
    }
    const doe = getDoeStudy(db, doeId);
    if (!doe || doe.experiment_id !== experimentId) {
      return res.status(404).send("DOE not found");
    }
    const rawAssignee = String(req.body?.assignee_user_id ?? "").trim();
    const assigneeUserId = rawAssignee ? Number(rawAssignee) : null;
    if (rawAssignee && !Number.isFinite(assigneeUserId)) {
      return res.status(400).send("Invalid assignee");
    }
    assignEntityResponsibility(db, {
      experimentId,
      entityType: "doe",
      entityId: doeId,
      assigneeUserId,
      assignedByUserId: req.user?.id ?? null,
      experimentName: experiment.name
    });
    res.redirect(`/experiments/${experimentId}`);
  });

  router.get("/experiments/:id/doe", (req, res) => {
    const experimentId = Number(req.params.id);
    const list = listDoeStudies(db, experimentId);
    if (list.length === 0) return res.redirect(`/experiments/${experimentId}`);
    res.redirect(`/experiments/${experimentId}/doe/${list[0].id}?tab=design`);
  });

  router.get("/experiments/:id/doe/:doeId", (req, res) => {
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const tab = (req.query.tab as string) || "design";
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const doe = getDoeStudy(db, doeId);
    if (!doe || doe.experiment_id !== experimentId) return res.status(404).send("DOE not found");
    const errorMessage = req.query.error ? String(req.query.error) : null;

    const recipes = listRecipes(db);
    const linkedRecipes = getExperimentRecipes(db, experimentId);
    const linkedRecipeOptions = recipes.filter((recipe) => linkedRecipes.includes(recipe.id));
    const params = listParamDefinitions(db, experimentId);
    const inputParams = listParamDefinitionsByKind(db, experimentId, "INPUT");
    const configs = listParamConfigs(db, experimentId, doeId);
    const designMeta = parseDesignMetadata(getDesignMetadata(db, experimentId, doeId));
    const nonRandomizedParamId =
      typeof designMeta.non_randomized_param_id === "number"
        ? designMeta.non_randomized_param_id
        : null;
    const runs = listRuns(db, doeId);
    const runRows = loadRuns(db, doeId);
    const qualSummaries = listQualSummaries(db, experimentId);
    const activeInputParams = inputParams.filter((param) => {
      const cfg = configs.find((c) => c.param_def_id === param.id);
      return cfg?.active === 1;
    });
    const activeAnalysisFields = listActiveAnalysisFields(db, doeId);
    const outputNumericParams = activeAnalysisFields.filter((field) => field.field_type === "number");
    const tagOutputFields = activeAnalysisFields.filter((field) => field.field_type === "tag");
    const booleanOutputFields = activeAnalysisFields.filter((field) => field.field_type === "boolean");
    const parseAllowed = (field: AnalysisField) => {
      let allowedValues: string[] = [];
      if (field.allowed_values_json) {
        try {
          const parsed = JSON.parse(field.allowed_values_json);
          if (Array.isArray(parsed)) allowedValues = parsed.map(String);
        } catch {
          allowedValues = [];
        }
      }
      return { ...field, allowedValues };
    };
    const standardAnalysisFieldsRaw = listStandardAnalysisFields(db).map(parseAllowed);
    const experimentAnalysisFields = listExperimentAnalysisFields(db, doeId).map(parseAllowed);
    const experimentByCode = new Map(experimentAnalysisFields.map((field) => [field.code, field]));
    const standardAnalysisFields = standardAnalysisFieldsRaw.map((field) => {
      const experimentField = experimentByCode.get(field.code);
      return {
        ...field,
        is_active: experimentField?.is_active ?? 0
      };
    });

    const runPreview = buildRunPreview(doe, inputParams, configs, linkedRecipes);

    let analysis = null;
    if (tab === "analysis") {
      const outputParamId = Number(req.query.output_param || outputNumericParams[0]?.id || 0);
      const xParamId = Number(req.query.x_param || activeInputParams[0]?.id || 0);
      const yParamId = Number(req.query.y_param || activeInputParams[1]?.id || 0);
      const recipeId = req.query.recipe_id ? Number(req.query.recipe_id) : null;
      const tagFieldId = req.query.tag_field ? Number(req.query.tag_field) : null;
      const tagValueRaw = req.query.tag_value;
      const tagValues = Array.isArray(tagValueRaw)
        ? tagValueRaw.map((v) => String(v)).filter(Boolean)
        : tagValueRaw
          ? [String(tagValueRaw)]
          : [];
      const tagSet = new Set(tagValues);
      const wantsNoTags = tagSet.has("__none__");
      const wantedTags = tagValues.filter((value) => value !== "__none__");
      const boolFieldId = req.query.bool_field ? Number(req.query.bool_field) : null;
      const boolValue = req.query.bool_value ? Number(req.query.bool_value) : null;

      const allRuns = loadRuns(db, doeId);
      const analysisValues = listAnalysisRunValuesByRunIds(db, allRuns.map((run) => run.id));
      const analysisValueMap = new Map(
        analysisValues.map((row) => [`${row.run_id}:${row.field_id}`, row])
      );
      const baseRuns = filterRuns(allRuns, { recipeId }, undefined);
      let filtered = baseRuns;
      let tagPenaltyRate: number | null = null;
      let boolPenaltyRate: number | null = null;
      if (tagFieldId) {
        const tagMatches = baseRuns.filter((run) => {
          const row = analysisValueMap.get(`${run.id}:${tagFieldId}`);
          if (!row?.value_tags_json) return wantsNoTags;
          try {
            const parsed = JSON.parse(row.value_tags_json);
            if (!Array.isArray(parsed) || parsed.length === 0) return false;
            if (wantedTags.length === 0) return !wantsNoTags;
            return wantedTags.some((value) => parsed.includes(value));
          } catch {
            return false;
          }
        });
        tagPenaltyRate = baseRuns.length ? tagMatches.length / baseRuns.length : null;
      }
      if (boolFieldId && (boolValue === 0 || boolValue === 1)) {
        const boolMatches = baseRuns.filter((run) => {
          const row = analysisValueMap.get(`${run.id}:${boolFieldId}`);
          return row?.value_real === boolValue;
        });
        boolPenaltyRate = baseRuns.length ? boolMatches.length / baseRuns.length : null;
      }
      if (tagFieldId) {
        filtered = filtered.filter((run) => {
          const row = analysisValueMap.get(`${run.id}:${tagFieldId}`);
          if (!row?.value_tags_json) return wantsNoTags;
          try {
            const parsed = JSON.parse(row.value_tags_json);
            if (!Array.isArray(parsed) || parsed.length === 0) return false;
            if (wantedTags.length === 0) return !wantsNoTags;
            return wantedTags.some((value) => parsed.includes(value));
          } catch {
            return false;
          }
        });
      }
      if (boolFieldId && (boolValue === 0 || boolValue === 1)) {
        filtered = filtered.filter((run) => {
          const row = analysisValueMap.get(`${run.id}:${boolFieldId}`);
          return row?.value_real === boolValue;
        });
      }

      const summary = outputParamId && xParamId
        ? summarizeByFactorAnalysis(filtered, analysisValueMap, outputParamId, xParamId)
        : [];
      const overallValues = filtered
        .map((run) => analysisValueMap.get(`${run.id}:${outputParamId}`)?.value_real)
        .filter((value) => value != null) as number[];
      const overall =
        overallValues.length > 0
          ? {
              mean: overallValues.reduce((a, b) => a + b, 0) / overallValues.length,
              sd: sd(overallValues),
              n: overallValues.length
            }
          : { mean: NaN, sd: NaN, n: 0 };
      const heatmap = outputParamId && xParamId && yParamId
        ? summarizeHeatmapAnalysis(filtered, analysisValueMap, outputParamId, xParamId, yParamId)
        : [];
      const scatter = filtered
        .map((run) => ({
          x: run.values[xParamId],
          y: analysisValueMap.get(`${run.id}:${outputParamId}`)?.value_real,
          recipe_id: run.recipe_id ?? 0
        }))
        .filter((point) => point.x != null && point.y != null);
      const scatter3d = filtered
        .map((run) => ({
          x: run.values[xParamId],
          y: run.values[yParamId],
          z: analysisValueMap.get(`${run.id}:${outputParamId}`)?.value_real
        }))
        .filter((point) => point.x != null && point.y != null && point.z != null);
      const regression = outputParamId
        ? buildRegressionAnalysis(filtered, analysisValueMap, outputParamId, activeInputParams.slice(0, 3))
        : { coefficients: [], r2: NaN };

      analysis = {
        outputParamId,
        xParamId,
        yParamId,
        recipeId,
        tagFieldId,
        tagValues,
        boolFieldId,
        boolValue,
        tagPenaltyRate,
        boolPenaltyRate,
        summary,
        overall,
        heatmap,
        scatter,
        scatter3d,
        regression
      };
    }

    res.render("doe_detail", {
      experiment,
      doe,
      doeId,
      recipes,
      linkedRecipes,
      linkedRecipeOptions,
      params,
      inputParams,
      activeInputParams,
      outputNumericParams,
      tagOutputFields,
      booleanOutputFields,
      standardAnalysisFields,
      customAnalysisFields: experimentAnalysisFields.filter((field) => field.is_standard === 0),
      configs,
      runs,
      runRows,
      tab,
      analysis,
      runPreview,
      errorMessage,
      nonRandomizedParamId,
      qualSummaries
    });
  });

  router.post("/experiments/:id/doe/:doeId/params", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const code = String(req.body.code || "").trim();
    if (!code) return res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=design`);

    createCustomParam(db, experimentId, {
      code,
      label: req.body.label || code,
      unit: req.body.unit || null,
      field_kind: req.body.field_kind,
      field_type: req.body.field_type,
      group_label: req.body.group_label || null,
      allowed_values_json: req.body.allowed_values
        ? JSON.stringify(String(req.body.allowed_values).split(",").map((tag: string) => tag.trim()).filter(Boolean))
        : null
    });
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=design`);
  });

  router.post("/experiments/:id/archive", (req, res) => {
    if (!hasRole(req, ["admin", "manager"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    if (!Number.isFinite(experimentId)) {
      if (req.get("X-Requested-With") === "fetch") {
        return res.status(400).json({ ok: false, message: "Invalid experiment" });
      }
      return res.redirect("/");
    }
    archiveExperiment(db, experimentId);
    if (req.get("X-Requested-With") === "fetch") {
      return res.json({ ok: true, message: "Experiment archived" });
    }
    res.redirect("/");
  });

  router.post("/experiments/:id/machine", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const raw = String(req.body.machine_id || "").trim();
    const machineId = raw ? Number(raw) : null;
    updateExperiment(db, experimentId, { machine_id: Number.isFinite(machineId) ? machineId : null });
    res.redirect(`/experiments/${experimentId}`);
  });

  router.post("/experiments/:id/update", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const name = String(req.body.name || "").trim();
    const notes = req.body.notes ? String(req.body.notes).trim() : null;
    const raw = String(req.body.machine_id || "").trim();
    const machineId = raw ? Number(raw) : null;
    updateExperiment(db, experimentId, {
      name: name || experiment.name || "Untitled experiment",
      notes: notes || null,
      machine_id: Number.isFinite(machineId) ? machineId : null
    });
    res.redirect(`/experiments/${experimentId}`);
  });

  // Owner can be changed only by admin/manager.
  router.post("/experiments/:id/owner", (req, res) => {
    if (!hasRole(req, ["admin", "manager"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const ownerUserId = req.body?.owner_user_id ? Number(req.body.owner_user_id) : null;
    if (!Number.isFinite(experimentId)) return res.status(400).send("Invalid experiment");
    updateExperimentOwner(db, experimentId, Number.isFinite(ownerUserId) ? ownerUserId : null);
    res.redirect(`/experiments/${experimentId}`);
  });

  // Status toggle (manual done) for admin/manager only.
  router.post("/experiments/:id/status", (req, res) => {
    if (!hasRole(req, ["admin", "manager"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    if (!Number.isFinite(experimentId)) return res.status(400).send("Invalid experiment");
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const done = String(req.body?.done ?? "") === "1";
    updateExperimentManualDone(db, experimentId, done ? 1 : 0);
    if (req.headers["x-requested-with"] === "fetch") {
      return res.json({ ok: true, done });
    }
    return res.redirect(`/experiments/${experimentId}`);
  });

  router.post("/experiments/:id/doe/:doeId/configs", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const doe = getDoeStudy(db, doeId);
    if (!doe || doe.experiment_id !== experimentId) return res.status(404).send("DOE not found");
    const configs = listParamConfigs(db, experimentId, doeId);
    const inputParams = listParamDefinitionsByKind(db, experimentId, "INPUT");
    const configMap = new Map(configs.map((config) => [config.param_def_id, config]));
    const labelMap = new Map(inputParams.map((param) => [param.id, param.label]));
    const updates: Array<{
      experiment_id: number;
      doe_id: number;
      param_def_id: number;
      active: number;
      mode: "FIXED" | "RANGE" | "LIST";
      fixed_value_real: number | null;
      range_min_real: number | null;
      range_max_real: number | null;
      list_json: string | null;
      level_count: number | null;
    }> = [];
    const errors: string[] = [];

    for (const param of inputParams) {
      const config = configMap.get(param.id);
      const prefix = `param_${param.id}`;
      const active = req.body[`${prefix}_active`] ? 1 : 0;
      const mode = req.body[`${prefix}_mode`] || config?.mode || "FIXED";
      let rangeMin = parseNumber(req.body[`${prefix}_min`]);
      let rangeMax = parseNumber(req.body[`${prefix}_max`]);
      const valuesRaw = String(req.body[`${prefix}_values`] || "");
      const values = valuesRaw
        .split(/[\s,;]+/)
        .map((val) => parseFloat(val))
        .filter((val) => Number.isFinite(val));
      const levelCount = Number(req.body[`${prefix}_levels`] || config?.level_count || 2);
      const fixed = mode === "FIXED" ? values[0] : NaN;
      const list = mode === "LIST" ? values : [];

      if (
        mode === "RANGE" &&
        (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax)) &&
        values.length >= 2
      ) {
        rangeMin = values[0];
        rangeMax = values[1];
      }

      if (doe.design_type === "BBD" && active === 1) {
        if (mode === "FIXED") {
          errors.push(
            `BBD: "${labelMap.get(param.id) || "Factor"}" must be RANGE or LIST (3 levels).`
          );
        }
        if (mode === "RANGE") {
          if (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax)) {
            errors.push(
              `BBD: "${labelMap.get(param.id) || "Factor"}" needs min and max.`
            );
          }
        }
        if (mode === "LIST" && list.length !== 3) {
          errors.push(
            `BBD: "${labelMap.get(param.id) || "Factor"}" needs exactly 3 values.`
          );
        }
      }

      if (active === 1) {
        updates.push({
          experiment_id: experimentId,
          doe_id: doeId,
          param_def_id: param.id,
          active,
          mode,
          fixed_value_real: Number.isFinite(fixed) ? fixed : null,
          range_min_real: mode === "RANGE" && Number.isFinite(rangeMin) ? rangeMin : null,
          range_max_real: mode === "RANGE" && Number.isFinite(rangeMax) ? rangeMax : null,
          list_json: list.length ? JSON.stringify(list) : null,
          level_count:
            doe.design_type === "BBD" && mode === "RANGE"
              ? 3
              : mode === "RANGE"
                ? levelCount
                : null
        });
      }
    }
    const wantsJson =
      req.get("X-Requested-With") === "XMLHttpRequest" || req.accepts("json") === "json";
    if (errors.length) {
      const message = errors[0];
      if (wantsJson) {
        return res.status(400).json({ error: message });
      }
      return res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=design&error=${encodeURIComponent(message)}`);
    }
    for (const param of inputParams) {
      const active = req.body[`param_${param.id}_active`] ? 1 : 0;
      if (active === 1) continue;
      if (configMap.has(param.id)) {
        deleteParamConfig(db, experimentId, doeId, param.id);
      }
    }
    for (const update of updates) {
      upsertParamConfig(db, update);
    }
    const selectedRaw = String(req.body.non_randomized_param_id || "").trim();
    const selectedId = selectedRaw ? Number(selectedRaw) : NaN;
    const activeSet = new Set(updates.map((update) => update.param_def_id));
    const nonRandomizedParamId =
      Number.isFinite(selectedId) && activeSet.has(selectedId) ? selectedId : null;
    const designMeta = parseDesignMetadata(getDesignMetadata(db, experimentId, doeId));
    upsertDesignMetadata(
      db,
      experimentId,
      doeId,
      JSON.stringify({ ...designMeta, non_randomized_param_id: nonRandomizedParamId })
    );
    if (wantsJson) {
      return res.status(204).send();
    }
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=design`);
  });

  router.post("/experiments/:id/doe/:doeId/tags", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const paramId = Number(req.body.param_id || 0);
    const allowed = String(req.body.allowed_values || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    updateAllowedValues(db, paramId, allowed.length ? JSON.stringify(allowed) : null);
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=design`);
  });

  router.post("/experiments/:id/doe/:doeId/analysis-fields/standard", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const wantsJson =
      req.get("X-Requested-With") === "XMLHttpRequest" || req.accepts("json") === "json";
    const selected = req.body.standard_codes || [];
    const selectedCodes = new Set(
      Array.isArray(selected) ? selected.map(String) : [String(selected)]
    );
    const standardFields = listStandardAnalysisFields(db);
    for (const field of standardFields) {
      const shouldEnable = selectedCodes.has(field.code);
      const existing = findExperimentAnalysisFieldByCode(db, doeId, field.code);
      if (shouldEnable) {
        if (!existing) {
          insertAnalysisField(db, {
            scope_type: "DOE",
            scope_id: doeId,
            code: field.code,
            label: field.label,
            field_type: field.field_type,
            unit: field.unit,
            group_label: field.group_label,
            allowed_values_json: field.allowed_values_json,
            is_standard: 1,
            is_active: 1
          });
        } else {
          updateAnalysisFieldActive(db, existing.id, 1);
        }
      } else if (existing && existing.is_standard === 1) {
        updateAnalysisFieldActive(db, existing.id, 0);
      }
    }
    if (wantsJson) return res.status(204).send();
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=analysis`);
  });

  router.get("/experiments/:id/doe/:doeId/analysis-fields/tag-values", (req, res) => {
    const doeId = Number(req.params.doeId);
    const fieldId = Number(req.query.field_id || 0);
    if (!Number.isFinite(fieldId) || fieldId <= 0) {
      return res.json({ values: [] });
    }
    const values = listTagValuesForExperimentField(db, doeId, fieldId);
    res.json({ values });
  });

  router.get("/experiments/:id/doe/:doeId/analysis-fields/active", (req, res) => {
    const doeId = Number(req.params.doeId);
    const fields = listActiveAnalysisFields(db, doeId);
    res.json({
      fields: fields.map((field) => ({
        id: field.id,
        label: field.label,
        field_type: field.field_type
      }))
    });
  });

  router.post("/experiments/:id/doe/:doeId/analysis-fields/custom", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const wantsJson =
      req.get("X-Requested-With") === "XMLHttpRequest" || req.accepts("json") === "json";
    const updates = req.body.custom || {};
    const ids = Object.keys(updates);
    const experimentFields = listExperimentAnalysisFields(db, doeId);
    for (const id of ids) {
      const fieldId = Number(id);
      if (!Number.isFinite(fieldId)) continue;
      const existing = experimentFields.find((field) => field.id === fieldId);
      if (!existing || existing.is_standard === 1) continue;
      const raw = updates[id] || {};
      const label = String(raw.label || "").trim() || existing.label;
      const unit = raw.unit !== undefined ? String(raw.unit).trim() : "";
      const groupLabel =
        raw.group_label !== undefined && String(raw.group_label).trim()
          ? String(raw.group_label).trim()
          : "Custom";
      const allowedRaw =
        raw.allowed_values !== undefined ? String(raw.allowed_values || "") : "";
      const allowedValues = allowedRaw
        .split(",")
        .map((v: string) => v.trim())
        .filter((v: string) => v);
      const allowedValuesJson =
        existing.field_type === "tag" && allowedValues.length > 0
          ? JSON.stringify(allowedValues)
          : null;
      const rawActive = raw.is_active;
      const isActive = Array.isArray(rawActive)
        ? rawActive.map(String).some((v) => v === "1" || v === "on" || v === "true") ? 1 : 0
        : rawActive === "1" || rawActive === "on" || rawActive === true || rawActive === "true"
          ? 1
          : 0;
      updateAnalysisField(db, fieldId, {
        label,
        unit: unit || null,
        group_label: groupLabel,
        allowed_values_json: allowedValuesJson,
        is_active: isActive
      });
    }
    if (wantsJson) return res.status(204).send();
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=analysis`);
  });

  router.post("/experiments/:id/doe/:doeId/analysis-fields/custom/active", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const wantsJson =
      req.get("X-Requested-With") === "XMLHttpRequest" || req.accepts("json") === "json";
    const fieldId = Number(req.body.field_id || 0);
    const isActiveRaw = String(req.body.is_active || "").trim();
    const isActive = isActiveRaw === "1" || isActiveRaw === "true" || isActiveRaw === "on" ? 1 : 0;
    if (!Number.isFinite(fieldId) || fieldId <= 0) {
      if (wantsJson) return res.status(400).json({ error: "Field id required." });
      return res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=analysis`);
    }
    const experimentFields = listExperimentAnalysisFields(db, doeId);
    const existing = experimentFields.find((field) => field.id === fieldId);
    if (!existing || existing.is_standard === 1) {
      if (wantsJson) return res.status(404).json({ error: "Field not found." });
      return res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=analysis`);
    }
    updateAnalysisFieldActive(db, fieldId, isActive);
    if (wantsJson) return res.status(204).send();
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=analysis`);
  });

  router.post("/experiments/:id/doe/:doeId/analysis-fields/new", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const wantsJson =
      req.get("X-Requested-With") === "XMLHttpRequest" || req.accepts("json") === "json";
    const label = String(req.body.label || "").trim();
    if (!label) {
      if (wantsJson) return res.status(400).json({ error: "Label is required." });
      return res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=analysis`);
    }

    const rawType = String(req.body.field_type || "number").trim();
    const fieldType = ["number", "text", "tag", "boolean"].includes(rawType)
      ? rawType
      : "number";
    const unit = req.body.unit !== undefined ? String(req.body.unit).trim() : "";
    const groupLabel =
      req.body.group_label !== undefined && String(req.body.group_label).trim()
        ? String(req.body.group_label).trim()
        : "Custom";
    const rawCode = req.body.code !== undefined ? String(req.body.code).trim() : "";
    const allowedRaw =
      req.body.allowed_values !== undefined ? String(req.body.allowed_values || "") : "";
    const allowedValues = allowedRaw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v);
    const allowedValuesJson =
      fieldType === "tag" && allowedValues.length > 0 ? JSON.stringify(allowedValues) : null;

    const baseCode = slugify(rawCode || label) || "measured_field";
    let code = baseCode;
    let i = 2;
    while (findExperimentAnalysisFieldByCode(db, doeId, code)) {
      code = `${baseCode}_${i}`;
      i += 1;
    }

    insertAnalysisField(db, {
      scope_type: "DOE",
      scope_id: doeId,
      code,
      label,
      field_type: fieldType as "number" | "text" | "tag" | "boolean",
      unit: unit || null,
      group_label: groupLabel,
      allowed_values_json: allowedValuesJson,
      is_standard: 0,
      is_active: 1
    });

    if (wantsJson) {
      const created = findExperimentAnalysisFieldByCode(db, doeId, code);
      if (!created) return res.status(500).json({ error: "Failed to create field." });
      const allowedValues = created.allowed_values_json
        ? (JSON.parse(created.allowed_values_json) as string[])
        : [];
      return res.json({
        field: {
          id: created.id,
          code: created.code,
          label: created.label,
          field_type: created.field_type,
          unit: created.unit,
          group_label: created.group_label,
          allowed_values: allowedValues,
          is_active: created.is_active
        }
      });
    }
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=analysis`);
  });

  router.post("/experiments/:id/doe/:doeId/generate", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const doe = getDoeStudy(db, doeId);
    if (!doe || doe.experiment_id !== experimentId) return res.status(404).send("DOE not found");
    const inputParams = listParamDefinitionsByKind(db, experimentId, "INPUT");
    const configs = listParamConfigs(db, experimentId, doeId);
    const recipeIds = getExperimentRecipes(db, experimentId);
    const runPreview = buildRunPreview(doe, inputParams, configs, recipeIds);
    if (doe.design_type === "BBD" && runPreview.k < 3) {
      const message =
        runPreview.warning ||
        `BBD needs at least 3 factors with 3 levels. Currently: ${runPreview.k}.`;
      return res.redirect(
        `/experiments/${experimentId}/doe/${doeId}?tab=design&error=${encodeURIComponent(message)}`
      );
    }
    generateRuns(db, experimentId, doeId);
    res.redirect(`/experiments/${experimentId}/doe/${doeId}?tab=runs`);
  });

  router.get("/experiments/:id/doe/:doeId/export/:type", (req, res) => {
    const experimentId = Number(req.params.id);
    const doeId = Number(req.params.doeId);
    const type = String(req.params.type);
    const runs = loadRuns(db, doeId);
    const params = listParamDefinitions(db, experimentId);
    const activeAnalysisFields = listActiveAnalysisFields(db, doeId);
    const analysisValues = listAnalysisRunValuesByRunIds(db, runs.map((run) => run.id));
    const analysisValueMap = new Map(
      analysisValues.map((row) => [`${row.run_id}:${row.field_id}`, row])
    );

    if (type === "runs") {
      const rows = runs.map((run) => {
        const row: Record<string, string | number | null> = {
          run_code: run.run_code,
          run_order: run.run_order,
          recipe_id: run.recipe_id ?? "",
          done: run.done,
          exclude_from_analysis: run.exclude_from_analysis
        };
        for (const param of params) {
          if (param.field_kind === "OUTPUT") continue;
          const value = run.values[param.id];
          row[param.code] = value ?? "";
        }
        for (const field of activeAnalysisFields) {
          const valueRow = analysisValueMap.get(`${run.id}:${field.id}`);
          if (field.field_type === "tag") {
            row[field.code] = valueRow?.value_tags_json ?? "";
          } else if (field.field_type === "text") {
            row[field.code] = valueRow?.value_text ?? "";
          } else {
            row[field.code] = valueRow?.value_real ?? "";
          }
        }
        return row;
      });
      const csv = toCsv(rows);
      res.setHeader("Content-Type", "text/csv");
      return res.send(csv);
    }

    if (type === "wide") {
      const inputCodes = params.filter((p) => p.field_kind !== "OUTPUT").map((p) => p.code);
      const headers = [
        "run_code",
        "run_order",
        "recipe_id",
        ...inputCodes,
        ...activeAnalysisFields.map((f) => f.code)
      ];
      const rows = runs.map((run) => {
        const row: Record<string, string | number | null> = {
          run_code: run.run_code,
          run_order: run.run_order,
          recipe_id: run.recipe_id ?? ""
        };
        for (const param of params) {
          if (param.field_kind === "OUTPUT") continue;
          const value = run.values[param.id];
          row[param.code] = value ?? "";
        }
        for (const field of activeAnalysisFields) {
          const valueRow = analysisValueMap.get(`${run.id}:${field.id}`);
          if (field.field_type === "tag") {
            row[field.code] = valueRow?.value_tags_json ?? "";
          } else if (field.field_type === "text") {
            row[field.code] = valueRow?.value_text ?? "";
          } else {
            row[field.code] = valueRow?.value_real ?? "";
          }
        }
        return row;
      });
      const csv = toCsv(rows);
      res.setHeader("Content-Type", "text/csv");
      return res.send(csv);
    }

    return res.status(400).send("Unknown export type");
  });

  return router;
}

function parseNumber(value: string | number | undefined) {
  if (value == null) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  const normalized = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw;
  return parseFloat(normalized);
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildRunPreview(
  experiment: {
    design_type: string;
    center_points: number;
    max_runs: number;
    replicate_count: number;
    recipe_as_block: number;
  },
  inputParams: Array<{ id: number }>,
  configs: Array<{
    param_def_id: number;
    active: number;
    mode: string;
    range_min_real: number | null;
    range_max_real: number | null;
    list_json: string | null;
    level_count: number | null;
  }>,
  recipeIds: number[]
) {
  const configMap = new Map(configs.map((config) => [config.param_def_id, config]));
  const activeConfigs = inputParams
    .map((param) => configMap.get(param.id))
    .filter((config) => config && config.active === 1) as typeof configs;

  const levelCounts = activeConfigs.map((config) => {
    if (config.mode === "LIST") {
      const list = config.list_json ? (JSON.parse(config.list_json) as number[]) : [];
      return list.length;
    }
    if (config.mode === "RANGE") {
      return config.level_count === 3 ? 3 : 2;
    }
    return 1;
  });
  const threeLevelFlags = activeConfigs.map((config) => {
    if (config.mode === "LIST") {
      const list = config.list_json ? (JSON.parse(config.list_json) as number[]) : [];
      return list.length === 3;
    }
    if (config.mode === "RANGE") {
      if (experiment.design_type === "BBD") {
        return Number.isFinite(config.range_min_real) && Number.isFinite(config.range_max_real);
      }
      return config.level_count === 3;
    }
    return false;
  });

  let baseRuns = 0;
  let formula = "";
  let warning = "";
  let k = 0;
  if (experiment.design_type === "SIM") {
    const simLevels = activeConfigs.map((config) => {
      if (config.mode === "LIST") {
        const list = config.list_json ? (JSON.parse(config.list_json) as number[]) : [];
        return list.length;
      }
      if (config.mode === "RANGE") {
        return config.level_count === 3 ? 3 : 2;
      }
      return 1;
    });
    baseRuns = simLevels.length
      ? simLevels.reduce((acc, val) => acc * Math.max(val, 1), 1)
      : 0;
    formula = `SIM: product(levels) = ${baseRuns}`;
  } else if (experiment.design_type === "FFA") {
    baseRuns = levelCounts.length
      ? levelCounts.reduce((acc, val) => acc * Math.max(val, 1), 1)
      : 0;
    formula = `FFA: product(levels) = ${baseRuns}`;
  } else if (experiment.design_type === "BBD") {
    k = threeLevelFlags.filter(Boolean).length;
    baseRuns = k >= 3 ? 4 * (k * (k - 1)) / 2 + (experiment.center_points || 0) : 0;
    formula = `BBD: 4*C(k,2)+center = ${baseRuns} (k=${k})`;
    if (k < 3) {
      warning = `BBD needs at least 3 factors with 3 levels. Currently: ${k}. Set Levels=3 or use LIST with 3 values.`;
    }
  } else {
    const k = levelCounts.length;
    const fullCombos = k > 0 ? Math.pow(2, k) : 0;
    baseRuns = Math.min(experiment.max_runs || fullCombos, fullCombos);
    formula = `SCREEN: min(max_runs, 2^k) = ${baseRuns} (k=${k})`;
  }

  const recipeMultiplier =
    experiment.recipe_as_block === 1 && recipeIds.length > 0 ? recipeIds.length : 1;
  const replicateMultiplier = Math.max(experiment.replicate_count || 1, 1);
  const totalRuns = baseRuns * recipeMultiplier * replicateMultiplier;

  return {
    totalRuns,
    baseRuns,
    recipeMultiplier,
    replicateMultiplier,
    formula,
    warning,
    k
  };
}

function parseDesignMetadata(jsonBlob: string | null): Record<string, unknown> {
  if (!jsonBlob) return {};
  try {
    return JSON.parse(jsonBlob) as Record<string, unknown>;
  } catch {
    return {};
  }
}
