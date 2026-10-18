import express from "express";
import multer from "multer";
import type { Db } from "../db.js";
import {
  ensureQualificationDefaults,
  getStepDefinitionForExperiment,
  getQualificationSeriesDefinitionsForExperiment,
  getQualificationOutputDefinitionsForExperiment,
  getQualificationCompactLabelsForExperiment,
  recomputeDerivedAndSummary,
  updateExtrusionRtdMetricsFromSeries,
  saveQualRunValue,
  addCavityFields,
  getNextCavityIndex
} from "../services/qualification_service.js";
import { createCustomParam } from "../services/experiments_service.js";
import {
  getQualRun,
  getQualStep,
  getQualStepById,
  listQualFields,
  listQualRuns,
  listQualRunValues,
  listQualRunSeries,
  listQualSummaries,
  createQualRuns,
  getQualStepSettings,
  upsertQualStepSettings,
  insertQualField,
  updateQualField,
  updateQualRunFlags,
  updateQualRunDueAt,
  updateQualRunMetadata,
  setQualStepBlocked,
  replaceQualRunSeries,
  deleteQualRunSeries,
  listQualStepOutputs,
  upsertQualStepOutput
} from "../repos/qual_repo.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { getProcessById } from "../repos/processes_repo.js";
import {
  createParamDefinition,
  deleteParamDefinition,
  findGlobalParamByCode,
  getParamDefinition,
  listGlobalParamDefinitions,
  updateParamDefinition
} from "../repos/params_repo.js";
import { getMachine } from "../repos/machines_repo.js";
import { listMachineParams } from "../repos/machine_params_repo.js";
import { canAccessExperiment, ensureExperimentAccess } from "../middleware/experiment_access.js";
import { listUsers, findUserById } from "../repos/users_repo.js";
import { getEntityAssignment } from "../repos/entity_assignments_repo.js";
import { canAssignEntityResponsibility } from "../services/entity_assignment_service.js";
import { insertAudit } from "../repos/audit_repo.js";
import { buildExperimentWorkspace } from "../services/experiment_workspace_service.js";
import { getQualificationStudyGuide } from "../services/qualification_guides.js";
import { calculateExtrusionScaleUpRecommendation } from "../services/extrusion_scale_up_service.js";
import { getQualificationArtifactPreset } from "../services/qualification_artifacts.js";
import { getStoredFileForEntityPlacement, linkStoredFile, unlinkStoredFilesForEntityPlacement } from "../repos/files_repo.js";
import { MAX_UPLOAD_BYTES, storeUserFiles } from "../services/file_storage_service.js";

const qualificationSeriesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 }
});

const qualificationSeriesFilePlacement = (seriesCode: string) => `source_file:${seriesCode}`;

function parseTwoColumnInstrumentExport(buffer: Buffer) {
  const lines = buffer.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [] as Array<{ x: number; y: number }>;
  const sample = lines[0];
  const delimiter = sample.includes("\t") ? "\t" : sample.includes(";") ? ";" : sample.includes(",") ? "," : null;
  const numeric = (cell: string) => Number((delimiter === "," ? cell : cell.replace(",", ".")).trim().replace(/^"|"$/g, ""));
  return lines.flatMap((line) => {
    const cells = delimiter ? line.split(delimiter) : line.split(/\s+/);
    if (cells.length < 2) return [];
    const x = numeric(cells[0]);
    const y = numeric(cells[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
  });
}

function hasRole(req: express.Request, roles: string[]) {
  return roles.includes(req.user?.role ?? "");
}

function rejectBlockedStep(res: express.Response, step: { is_blocked: number; status: string }) {
  if (step.is_blocked !== 1 && step.status !== "BLOCKED") return false;
  res.status(423).json({ error: "Qualification step is blocked by an administrator" });
  return true;
}

export function createQualificationRouter(db: Db) {
  const router = express.Router();
  const registerCustomQualificationParam = (
    experimentId: number,
    field: {
      code: string;
      label: string;
      unit: string | null;
      field_type: "number" | "text" | "tag" | "boolean";
      group_label: string | null;
      allowed_values_json: string | null;
    }
  ) => createCustomParam(db, experimentId, {
    code: field.code,
    label: field.label,
    unit: field.unit,
    field_kind: "OUTPUT",
    field_type: field.field_type,
    group_label: field.group_label,
    allowed_values_json: field.allowed_values_json
  });

  // Legacy qualification-run URLs are not nested under /experiments/:id, so
  // apply the same experiment-level authorization explicitly.
  const ensureQualRunAccess = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const runId = Number(req.params.id);
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).send("Run not found");
    const experiment = getExperiment(db, run.experiment_id);
    if (!experiment) return res.status(404).send("Experiment not found");
    if (!canAccessExperiment(db, req.user, run.experiment_id, experiment)) {
      return res.status(403).send("Forbidden");
    }
    return next();
  };

  router.use("/experiments/:id", ensureExperimentAccess(db));

  // A stage may still be opened to inspect its evidence while blocked, but no
  // write endpoint under it may alter runs, fields, settings, or summaries.
  router.use("/experiments/:id/qualification/:step", (req, res, next) => {
    if (req.method === "GET" || req.path === "/block") return next();
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    return next();
  });

  router.get("/experiments/:id/qualification", (req, res) => {
    const experimentId = Number(req.params.id);
    return res.redirect(`/experiments/${experimentId}#qualification`);
  });

  router.get("/experiments/:id/qualification/:step", (req, res) => {
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const processTypeCode = (() => {
      if (!experiment.process_id) return "injection";
      const process = getProcessById(db, experiment.process_id);
      return String(process?.process_type_code || "injection").toLowerCase();
    })();
    ensureQualificationDefaults(db, experimentId);
    const workspace = buildExperimentWorkspace(db, experimentId);
    if (!workspace) return res.status(404).send("Experiment not found");
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).send("Step not found");
    if (step.is_active !== 1) return res.status(404).send("This optional qualification study is not enabled for the experiment");
    const fields = listQualFields(db, step.id);
    let runs = listQualRuns(db, step.id);
    if (step.is_blocked !== 1 && (stepNumber === 2 || (stepNumber === 3 && processTypeCode !== "extrusion_v1")) && runs.length === 0) {
      createQualRuns(db, experimentId, step.id, 1);
      runs = listQualRuns(db, step.id);
    }
    const globalParams = listGlobalParamDefinitions(db);
    const unitByCode = Object.fromEntries(
      globalParams.map((param) => [param.code, param.unit || ""])
    );
    const runValueMap: Record<string, Record<string, { value_real: number | null; value_text: string | null; value_tags_json: string | null }>> = {};
    for (const run of runs) {
      const values = listQualRunValues(db, run.id);
      const row: Record<string, { value_real: number | null; value_text: string | null; value_tags_json: string | null }> = {};
      values.forEach((value) => {
        row[String(value.field_id)] = value;
      });
      runValueMap[String(run.id)] = row;
    }
    const settingsJson = getQualStepSettings(db, experimentId, stepNumber);
    let stepSettings: Record<string, unknown> = {};
    if (settingsJson) {
      try {
        stepSettings = JSON.parse(settingsJson) as Record<string, unknown>;
      } catch {
        stepSettings = {};
      }
    }
    const dimensionalArtifact = processTypeCode === "sla_dlp" && stepNumber === 4
      ? getQualificationArtifactPreset(stepSettings.dimensional_artifact_preset)
      : null;
    const dimensionalReference = (() => {
      if (processTypeCode !== "sla_dlp" || stepNumber !== 4) return null;
      const sourceStep = getQualStep(db, experimentId, 3);
      const outputs = new Map((sourceStep ? listQualStepOutputs(db, sourceStep.id) : [])
        .map((output) => [output.output_code, output.value_real]));
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
      return {
        href: `/experiments/${experimentId}/qualification/3`,
        layerHeightUm: number(outputs.get("qualified_layer_height_um")),
        exposureTimeS: number(outputs.get("nominal_exposure_s"))
      };
    })();
    const peelForceReference = (() => {
      if (processTypeCode !== "sla_dlp" || stepNumber !== 5) return null;
      const sourceStep = getQualStep(db, experimentId, 3);
      const outputs = new Map((sourceStep ? listQualStepOutputs(db, sourceStep.id) : [])
        .map((output) => [output.output_code, output.value_real]));
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
      return {
        href: `/experiments/${experimentId}/qualification/3`,
        layerHeightUm: number(outputs.get("qualified_layer_height_um")),
        exposureTimeS: number(outputs.get("nominal_exposure_s"))
      };
    })();
    const postCureReference = (() => {
      if (processTypeCode !== "sla_dlp" || stepNumber !== 6) return null;
      const sourceStep = getQualStep(db, experimentId, 3);
      const outputs = new Map((sourceStep ? listQualStepOutputs(db, sourceStep.id) : [])
        .map((output) => [output.output_code, output.value_real]));
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
      return {
        href: `/experiments/${experimentId}/qualification/3`,
        layerHeightUm: number(outputs.get("qualified_layer_height_um")),
        exposureTimeS: number(outputs.get("nominal_exposure_s"))
      };
    })();
    const finalMechanicalReference = (() => {
      if (processTypeCode !== "sla_dlp" || stepNumber !== 7) return null;
      const sourceStep = getQualStep(db, experimentId, 6);
      const materialStep = getQualStep(db, experimentId, 1);
      const outputs = new Map((sourceStep ? listQualStepOutputs(db, sourceStep.id) : [])
        .map((output) => [output.output_code, output.value_real]));
      const materialId = (() => {
        if (!materialStep) return null;
        const batchField = listQualFields(db, materialStep.id).find((field) => field.code === "resin_batch");
        if (!batchField) return null;
        for (const sourceRun of listQualRuns(db, materialStep.id)) {
          const value = listQualRunValues(db, sourceRun.id).find((item) => item.field_id === batchField.id)?.value_text?.trim();
          if (value) return value;
        }
        return null;
      })();
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
      return {
        href: `/experiments/${experimentId}/qualification/6`,
        materialHref: `/experiments/${experimentId}/qualification/1`,
        materialId,
        postCureTimeMin: number(outputs.get("post_cure_time_min")),
        postCureTempC: number(outputs.get("post_cure_temp_c")),
        postCureIrradianceMwCm2: number(outputs.get("post_cure_irradiance_mw_cm2")),
        finalTgC: number(outputs.get("final_tg_c"))
      };
    })();
    const rheologyReference = (() => {
      if (processTypeCode !== "sla_dlp" || stepNumber !== 8) return null;
      const materialStep = getQualStep(db, experimentId, 1);
      if (!materialStep) return { materialHref: `/experiments/${experimentId}/qualification/1`, materialId: null };
      const batchField = listQualFields(db, materialStep.id).find((field) => field.code === "resin_batch");
      const materialId = batchField
        ? listQualRuns(db, materialStep.id)
          .map((run) => listQualRunValues(db, run.id).find((value) => value.field_id === batchField.id)?.value_text?.trim())
          .find(Boolean) || null
        : null;
      return { materialHref: `/experiments/${experimentId}/qualification/1`, materialId };
    })();
    const canAssignEntities = canAssignEntityResponsibility(req.user, experiment);
    const assignableUsers = canAssignEntities
      ? listUsers(db).filter((user) => user.status === "ACTIVE")
      : [];
    const assignment = getEntityAssignment(db, "qualification_step", step.id);
    const stepAssigneeId = assignment?.assignee_user_id ?? null;
    const stepAssignee = stepAssigneeId ? findUserById(db, stepAssigneeId) : null;
    const stepAssigneeLabel = stepAssignee?.name?.trim() || stepAssignee?.email?.trim() || null;
    // Keep summary synchronized with current run values and formulas on page open.
    // A blocked stage is deliberately read-only, including automatic writes.
    if (step.is_blocked !== 1) {
      recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    }
    const summaryRow = listQualSummaries(db, experimentId).find(
      (row) => row.step_number === stepNumber
    );
    let stepSummary: Record<string, unknown> = {};
    try {
      stepSummary = JSON.parse(summaryRow?.summary_json || "{}") as Record<string, unknown>;
    } catch {
      stepSummary = {};
    }
    const seriesDefinitions = getQualificationSeriesDefinitionsForExperiment(
      db,
      experimentId,
      stepNumber
    );
    const runSeries = seriesDefinitions.length ? listQualRunSeries(db, step.id) : [];
    const finalMechanicalCurveFiles = processTypeCode === "sla_dlp" && stepNumber === 7
      ? Object.fromEntries(runs.map((run) => {
          const file = getStoredFileForEntityPlacement(db, {
            entityType: "qualification_run",
            entityId: run.id,
            placement: qualificationSeriesFilePlacement("stress_strain_curve")
          });
          return [String(run.id), file ? {
            id: file.id,
            originalName: file.original_name,
            sizeBytes: file.size_bytes,
            downloadUrl: `/files/${file.id}/download`
          } : null];
        }))
      : {};
    const rheologyCurveFiles = processTypeCode === "sla_dlp" && stepNumber === 8
      ? Object.fromEntries(runs.map((run) => {
          const file = getStoredFileForEntityPlacement(db, {
            entityType: "qualification_run",
            entityId: run.id,
            placement: qualificationSeriesFilePlacement("resin_flow_curve")
          });
          return [String(run.id), file ? {
            id: file.id,
            originalName: file.original_name,
            sizeBytes: file.size_bytes,
            downloadUrl: `/files/${file.id}/download`
          } : null];
        }))
      : {};
    const outputDefinitions = getQualificationOutputDefinitionsForExperiment(db, experimentId, stepNumber);
    const stepOutputs = outputDefinitions.length ? listQualStepOutputs(db, step.id) : [];
    const jacobsReference = (() => {
      if (processTypeCode !== "sla_dlp" || stepNumber !== 3) return null;
      const sourceStep = getQualStep(db, experimentId, 2);
      if (!sourceStep) return null;
      const outputs = new Map(listQualStepOutputs(db, sourceStep.id).map((output) => [output.output_code, output.value_real]));
      const sourceSummaryRow = listQualSummaries(db, experimentId).find((row) => row.step_number === 2);
      let sourceSummary: Record<string, unknown> = {};
      let sourceSettings: Record<string, unknown> = {};
      try { sourceSummary = JSON.parse(sourceSummaryRow?.summary_json || "{}") as Record<string, unknown>; } catch {}
      try { sourceSettings = JSON.parse(getQualStepSettings(db, experimentId, 2) || "{}") as Record<string, unknown>; } catch {}
      const curve = sourceSummary.jacobs_working_curve as Record<string, unknown> | undefined;
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
      const variableCode = String(sourceSettings.jacobs_variable_code || "exposure_time_s");
      return {
        href: `/experiments/${experimentId}/qualification/2`,
        fitValid: curve?.fit_valid === true,
        pointCount: number(curve?.point_count) ?? 0,
        ec: number(outputs.get("critical_exposure_ec_mj_cm2")),
        dp: number(outputs.get("penetration_depth_dp_um")),
        rSquared: number(outputs.get("working_curve_r_squared")),
        wavelengthNm: number(sourceSettings.jacobs_wavelength_nm),
        resinTempC: number(sourceSettings.jacobs_resin_temp_c),
        variableLabel: variableCode === "irradiance_mw_cm2" ? "Measured irradiance" : "Exposure time",
        fixedLabel: variableCode === "irradiance_mw_cm2" ? "Fixed exposure time" : "Fixed measured irradiance",
        fixedValue: number(variableCode === "irradiance_mw_cm2"
          ? sourceSettings.jacobs_fixed_exposure_time_s
          : sourceSettings.jacobs_fixed_irradiance_mw_cm2),
        fixedUnit: variableCode === "irradiance_mw_cm2" ? "s" : "mW/cm²"
      };
    })();
    const feederStep = processTypeCode === "extrusion_v1" && stepNumber === 3
      ? getQualStep(db, experimentId, 2)
      : null;
    const feederOutputs = feederStep ? listQualStepOutputs(db, feederStep.id) : [];
    const feederOutputByCode = new Map(feederOutputs.map((output) => [output.output_code, output.value_real]));
    const feederMin = feederOutputByCode.get("feeder_stable_throughput_min_kg_h");
    const feederMax = feederOutputByCode.get("feeder_stable_throughput_max_kg_h");
    const feederThroughputLevels = Number.isFinite(feederMin) && Number.isFinite(feederMax) && (feederMax as number) >= (feederMin as number)
      ? [feederMin as number, ((feederMin as number) + (feederMax as number)) / 2, feederMax as number]
      : [];
    const rheologyStep = processTypeCode === "extrusion_v1" && (stepNumber === 3 || stepNumber === 4)
      ? getQualStep(db, experimentId, 1)
      : null;
    const rheologyReferenceViscosity = rheologyStep
      ? listQualStepOutputs(db, rheologyStep.id).find((output) => output.output_code === "rheology_reference_viscosity_pa_s")?.value_real ?? null
      : null;
    const thermalSuggestions = (() => {
      if (processTypeCode !== "extrusion_v1" || stepNumber !== 4) return { speeds: [] as number[], throughputs: [] as number[], temperatures: [] as number[] };
      const stepThreeSummary = listQualSummaries(db, experimentId).find((row) => row.step_number === 3);
      let stepThreeData: Record<string, unknown> = {};
      try { stepThreeData = JSON.parse(stepThreeSummary?.summary_json || "{}") as Record<string, unknown>; } catch {}
      const values = (key: string) => Array.isArray(stepThreeData[key]) ? stepThreeData[key] : [];
      const speeds = [...new Set(values("accepted_operating_points").map((point: any) => Number(point?.screw_speed_rpm)).filter(Number.isFinite))].sort((a, b) => a - b);
      const throughputs = [...new Set(values("accepted_operating_points").map((point: any) => Number(point?.throughput_kg_h)).filter(Number.isFinite))].sort((a, b) => a - b);
      const stepOne = getQualStep(db, experimentId, 1);
      const stepOneOutputs = stepOne ? listQualStepOutputs(db, stepOne.id) : [];
      const min = Number(stepOneOutputs.find((output) => output.output_code === "processing_temp_min_c")?.value_real);
      const max = Number(stepOneOutputs.find((output) => output.output_code === "processing_temp_max_c")?.value_real);
      const temperatures = Number.isFinite(min) && Number.isFinite(max) && max > min ? [min, (min + max) / 2, max] : [];
      return { speeds, throughputs, temperatures };
    })();
    const rtdAcceptedPointCount = (() => {
      if (processTypeCode !== "extrusion_v1" || stepNumber !== 5) return 0;
      const stepThreeSummary = listQualSummaries(db, experimentId).find((row) => row.step_number === 3);
      try {
        const parsed = JSON.parse(stepThreeSummary?.summary_json || "{}") as Record<string, unknown>;
        return Array.isArray(parsed.accepted_operating_points) ? parsed.accepted_operating_points.length : 0;
      } catch {
        return 0;
      }
    })();
    const rtdFeederCalibration = (() => {
      if (processTypeCode !== "extrusion_v1" || stepNumber !== 5) return null as null | { slope: number; intercept: number; rSquared: number | null; speeds: number[]; minThroughput: number; maxThroughput: number };
      const feederSummary = listQualSummaries(db, experimentId).find((row) => row.step_number === 2);
      try {
        const parsed = JSON.parse(feederSummary?.summary_json || "{}") as Record<string, unknown>;
        const slope = Number(parsed.feeder_calibration_slope_kg_h_per_rpm);
        const intercept = Number(parsed.feeder_calibration_intercept_kg_h);
        const rSquared = Number(parsed.feeder_calibration_r_squared);
        const points = Array.isArray(parsed.feeder_calibration_points) ? parsed.feeder_calibration_points : [];
        const speeds = [...new Set(points.map((point: any) => Number(point?.speed)).filter(Number.isFinite))].sort((a, b) => a - b);
        const throughputs = points.map((point: any) => Number(point?.throughput)).filter(Number.isFinite);
        return Number.isFinite(slope) && Number.isFinite(intercept) && speeds.length >= 2 && throughputs.length >= 2
          ? { slope, intercept, rSquared: Number.isFinite(rSquared) ? rSquared : null, speeds, minThroughput: Math.min(...throughputs), maxThroughput: Math.max(...throughputs) }
          : null;
      } catch {
        return null;
      }
    })();
    const rtdReferenceRuns = (() => {
      if (processTypeCode !== "extrusion_v1" || stepNumber !== 10) return [] as Array<{ id: number; runCode: string; meanResidenceTimeS: number; widthS: number | null; throughputKgH: number | null; screwSpeedRpm: number | null; href: string }>;
      const rtdStep = getQualStep(db, experimentId, 5);
      if (!rtdStep) return [];
      const rtdFields = new Map(listQualFields(db, rtdStep.id).map((field) => [field.code, field]));
      const read = (values: Map<number, { value_real: number | null }>, code: string) => {
        const field = rtdFields.get(code);
        const value = field ? values.get(field.id)?.value_real : null;
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      };
      return listQualRuns(db, rtdStep.id)
        .map((run) => {
          const values = new Map(listQualRunValues(db, run.id).map((value) => [value.field_id, value]));
          const meanResidenceTimeS = read(values, "mean_residence_time_s");
          if (meanResidenceTimeS == null || meanResidenceTimeS <= 0) return null;
          return {
            id: run.id,
            runCode: run.run_code,
            meanResidenceTimeS,
            widthS: read(values, "rtd_width_s"),
            throughputKgH: read(values, "throughput_kg_h"),
            screwSpeedRpm: read(values, "screw_speed_rpm"),
            href: `/experiments/${experimentId}/qualification/5#rtd-run-${run.id}`
          };
        })
        .filter((run): run is NonNullable<typeof run> => run != null);
    })();
    const reactiveDosingEvidence = (() => {
      if (processTypeCode !== "extrusion_v1" || stepNumber !== 9) return null;
      const rangeFor = (sourceStepNumber: number, minCode: string, maxCode: string) => {
        const sourceStep = getQualStep(db, experimentId, sourceStepNumber);
        if (!sourceStep) return null;
        const outputs = new Map(listQualStepOutputs(db, sourceStep.id).map((output) => [output.output_code, output.value_real]));
        const min = outputs.get(minCode);
        const max = outputs.get(maxCode);
        return Number.isFinite(min) && Number.isFinite(max) ? { min: min as number, max: max as number } : null;
      };
      const sideFeederStep = getQualStep(db, experimentId, 6);
      return {
        mainFeeder: rangeFor(2, "feeder_stable_throughput_min_kg_h", "feeder_stable_throughput_max_kg_h"),
        liquidPump: rangeFor(7, "calibrated_liquid_throughput_min_kg_h", "calibrated_liquid_throughput_max_kg_h"),
        sideFeederQualified: sideFeederStep ? listQualRuns(db, sideFeederStep.id).length > 0 : false
      };
    })();
    // The original IM panels are retained for their six established studies.
    // Every other catalogue stage uses the shared table/detail shell, so a new
    // code-owned stage never needs a new micro-application or a six-step fork.
    if (processTypeCode !== "injection" || stepNumber > 6) {
      return res.render("qualification_step_compounding", {
        experimentId,
        step,
        stepDef: getStepDefinitionForExperiment(db, experimentId, stepNumber),
        fields,
        runs,
        globalParams,
        runValueMap,
        stepSettings,
        summaryJson: summaryRow?.summary_json ?? null,
        stepSummary,
        processTypeCode,
        studyGuide: getQualificationStudyGuide(processTypeCode, stepNumber),
        seriesDefinitions,
        runSeries,
        outputDefinitions,
        stepOutputs,
        jacobsReference,
        dimensionalArtifact,
        dimensionalReference,
        peelForceReference,
        postCureReference,
        finalMechanicalReference,
        finalMechanicalCurveFiles,
        rheologyReference,
        rheologyCurveFiles,
        compactFieldLabels: getQualificationCompactLabelsForExperiment(db, experimentId),
        feederThroughputLevels,
        rheologyReferenceViscosity,
        thermalSuggestedSpeeds: thermalSuggestions.speeds,
        thermalSuggestedThroughputs: thermalSuggestions.throughputs,
        thermalSuggestedTemperatures: thermalSuggestions.temperatures,
        rtdAcceptedPointCount,
        rtdFeederSpeedLevels: rtdFeederCalibration?.speeds ?? [],
        rtdCalibrationLabel: rtdFeederCalibration
          ? `Q = ${rtdFeederCalibration.slope.toFixed(3)} · F ${rtdFeederCalibration.intercept >= 0 ? '+' : '−'} ${Math.abs(rtdFeederCalibration.intercept).toFixed(3)} kg/h${rtdFeederCalibration.rSquared != null ? `, R² ${rtdFeederCalibration.rSquared.toFixed(3)}` : ''}`
          : null,
        rtdCalibrationRange: rtdFeederCalibration ? `${rtdFeederCalibration.minThroughput.toFixed(2)}–${rtdFeederCalibration.maxThroughput.toFixed(2)} kg/h` : null,
        rtdReferenceRuns,
        reactiveDosingEvidence,
        canAssignEntities,
        assignableUsers,
        stepAssigneeId,
        stepAssigneeLabel,
        canBlockQualification: req.user?.role === "admin",
        workspace
      });
    }

    let settings = {
      intensification_coeff: 1 as number | string,
      melt_temp_c: null as number | string | null,
      recommended_inj_speed: null as number | string | null,
      inj_speed: null as number | string | null,
      target_weight_g: null as number | string | null,
      machine_max_pressure_bar: null as number | string | null,
      hold_pressure_bar: null as number | string | null,
      gate_seal_time_s: null as number | string | null,
      custom_fields: [] as Array<{ id: string; code?: string; label: string; unit?: string; value?: number | string | null }>
    };
    if (settingsJson) {
      try {
        settings = { ...settings, ...(JSON.parse(settingsJson) as typeof settings) };
      } catch {
        settings = {
          intensification_coeff: 1,
          melt_temp_c: null,
          recommended_inj_speed: null,
          inj_speed: null,
          target_weight_g: null,
          machine_max_pressure_bar: null,
          hold_pressure_bar: null,
          gate_seal_time_s: null,
          custom_fields: []
        };
      }
    }
    let step1Recommended = null as number | null;
    if (stepNumber >= 2) {
      const step1SettingsRaw = getQualStepSettings(db, experimentId, 1);
      if (step1SettingsRaw) {
        try {
          const parsed = JSON.parse(step1SettingsRaw);
          if (Number.isFinite(parsed?.recommended_inj_speed)) {
            step1Recommended = Number(parsed.recommended_inj_speed);
          }
        } catch {
          step1Recommended = null;
        }
      }
    }
    const summaries = listQualSummaries(db, experimentId);
    const step4Summary = summaries.find((row) => row.step_number === 4);
    let step4CenterTemp = null as number | null;
    let step4CenterPressure = null as number | null;
    if (step4Summary?.summary_json) {
      try {
        const parsed = JSON.parse(step4Summary.summary_json);
        if (Number.isFinite(parsed?.window_center_temp)) {
          step4CenterTemp = Number(parsed.window_center_temp);
        }
        if (Number.isFinite(parsed?.window_center_pressure)) {
          step4CenterPressure = Number(parsed.window_center_pressure);
        }
      } catch {
        step4CenterTemp = null;
        step4CenterPressure = null;
      }
    }
    const step5Summary = summaries.find((row) => row.step_number === 5);
    let step5GateSealTime = null as number | null;
    if (step5Summary?.summary_json) {
      try {
        const parsed = JSON.parse(step5Summary.summary_json);
        if (Number.isFinite(parsed?.gate_seal_time_s)) {
          step5GateSealTime = Number(parsed.gate_seal_time_s);
        }
      } catch {
        step5GateSealTime = null;
      }
    }

    let machineInjectionPressure = null as number | null;
    let machineParamMap: Record<string, string> = {};
    let machineIntensification = null as number | null;
    if (experiment.machine_id) {
      const machine = getMachine(db, experiment.machine_id);
      if (machine?.settings_json) {
        try {
          const parsed = JSON.parse(machine.settings_json);
          if (Number.isFinite(parsed?.injection_pressure_bar)) {
            machineInjectionPressure = Number(parsed.injection_pressure_bar);
          }
          if (Number.isFinite(parsed?.intensification_ratio)) {
            machineIntensification = Number(parsed.intensification_ratio);
          }
        } catch {
          machineInjectionPressure = null;
          machineIntensification = null;
        }
      }
      const params = listMachineParams(db, experiment.machine_id);
      machineParamMap = Object.fromEntries(
        params.map((param) => [`${experiment.machine_id}:${param.id}`, param.value_text ?? ""])
      );
    }

    res.render("qualification_step", {
      experimentId,
      step,
      stepDef: getStepDefinitionForExperiment(db, experimentId, stepNumber),
      fields,
      runs,
      globalParams,
      unitByCode,
      runValueMap,
      settings,
      step1Recommended,
      step4CenterTemp,
      step4CenterPressure,
      step5GateSealTime,
      machineInjectionPressure,
      machineIntensification,
      machineParamMap,
      summaryJson: summaryRow?.summary_json ?? null,
      studyGuide: getQualificationStudyGuide(processTypeCode, stepNumber),
      canAssignEntities,
      assignableUsers,
      stepAssigneeId,
      stepAssigneeLabel,
      canBlockQualification: req.user?.role === "admin",
      workspace
    });
  });

  router.post("/experiments/:id/qualification/:step/block", (req, res) => {
    if (req.user?.role !== "admin") return res.status(403).send("Forbidden");
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).send("Step not found");
    const action = String(req.body?.action ?? "block").trim().toLowerCase();
    if (action !== "block" && action !== "unblock") {
      return res.status(400).send("Invalid block action");
    }
    try {
      setQualStepBlocked(db, step.id, {
        blocked: action === "block",
        reason: req.body?.reason,
        actorUserId: req.user?.id ?? null
      });
    } catch (error) {
      return res.status(400).send(error instanceof Error ? error.message : "Unable to update step block");
    }
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: action === "block" ? "qualification.step.blocked" : "qualification.step.unblocked",
      targetUserId: null,
      detailsJson: JSON.stringify({
        experiment_id: experimentId,
        qualification_step_id: step.id,
        stage_code: step.stage_code,
        step_number: step.step_number,
        reason: action === "block" ? String(req.body?.reason ?? "").trim() : null
      })
    });
    const ajax = req.get("X-Requested-With");
    if (ajax === "XMLHttpRequest" || ajax === "fetch") {
      return res.json({ ok: true, blocked: action === "block" });
    }
    return res.redirect(`/experiments/${experimentId}/qualification/${stepNumber}`);
  });

  router.get("/qual-runs/:id", ensureQualRunAccess, (req, res) => {
    const runId = Number(req.params.id);
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).send("Run not found");
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).send("Step not found");
    const fields = listQualFields(db, run.step_id).filter((field) => field.is_enabled === 1);
    const values = listQualRunValues(db, run.id);
    const valueMap = new Map(values.map((value) => [value.field_id, value]));
    res.render("qualification_run", {
      run,
      step,
      fields,
      valueMap
    });
  });

  router.post("/qual-runs/:id/value", ensureQualRunAccess, (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const { field_id, value } = req.body as { field_id: number; value: unknown };
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const field = listQualFields(db, run.step_id).find((f) => f.id === Number(field_id));
    if (!field) return res.status(404).json({ error: "Field not found" });
    if (field.is_derived) return res.status(400).json({ error: "Derived field" });

    saveQualRunValue(db, runId, field.id, field.field_type, value);
    recomputeDerivedAndSummary(db, run.experiment_id, run.step_id, step.step_number);
    const summaryRow = listQualSummaries(db, run.experiment_id).find((item) => item.step_number === step.step_number);
    let summary: Record<string, unknown> = {};
    try { summary = JSON.parse(summaryRow?.summary_json || "{}"); } catch {}
    return res.json({ ok: true, summary });
  });

  router.post("/qual-runs/:id/series/:seriesCode", ensureQualRunAccess, (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const seriesCode = String(req.params.seriesCode || "").trim();
    const definition = getQualificationSeriesDefinitionsForExperiment(
      db,
      run.experiment_id,
      step.step_number
    ).find((item) => item.code === seriesCode);
    if (!definition) return res.status(404).json({ error: "Series is not declared for this stage" });
    if (definition.source === "run_fields") {
      return res.status(409).json({ error: "This chart is generated from the qualification runs and cannot accept an imported series" });
    }
    const rawPoints = Array.isArray(req.body?.points) ? req.body.points : [];
    if (rawPoints.length < definition.minimum_points) {
      return res.status(400).json({ error: `At least ${definition.minimum_points} points are required` });
    }
    if (rawPoints.length > 50_000) {
      return res.status(400).json({ error: "A series cannot contain more than 50000 points" });
    }
    const points = rawPoints.map((point: unknown) => {
      const value = point as { x?: unknown; y?: unknown };
      return { x: Number(value?.x), y: Number(value?.y) };
    });
    if (points.some((point: { x: number; y: number }) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return res.status(400).json({ error: "Every series point must contain finite x and y values" });
    }
    if (step.step_number === 5 && seriesCode === "tracer_concentration_response") {
      const invalidPoint = points.some((point: { x: number; y: number }) => point.x < 0 || point.y < 0);
      const outOfOrder = points.some((point: { x: number }, index: number) => index > 0 && point.x <= points[index - 1].x);
      if (invalidPoint || outOfOrder) {
        return res.status(400).json({ error: "RTD samples must have non-negative values and strictly increasing time" });
      }
    }
    const sourceName = String(req.body?.source_name || "").trim().slice(0, 255) || null;
    replaceQualRunSeries(db, {
      experimentId: run.experiment_id,
      stepId: step.id,
      runId,
      seriesCode,
      contractVersion: definition.contract_version,
      sourceName,
      points
    });
    const rtdMetrics = step.step_number === 5 && seriesCode === "tracer_concentration_response"
      ? updateExtrusionRtdMetricsFromSeries(db, step.id, runId)
      : null;
    recomputeDerivedAndSummary(db, run.experiment_id, step.id, step.step_number);
    return res.json({ ok: true, point_count: points.length, rtd_metrics: rtdMetrics });
  });

  // Instrument exports are both evidence and portable files. The parsed
  // points live in the series tables for plotting; the untouched TXT/CSV/TSV
  // source is linked into the shared file repository for traceability.
  router.post(
    "/qual-runs/:id/series/:seriesCode/file",
    ensureQualRunAccess,
    qualificationSeriesUpload.single("file"),
    async (req, res) => {
      if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const runId = Number(req.params.id);
      const run = getQualRun(db, runId);
      if (!run) return res.status(404).json({ error: "Run not found" });
      const step = getQualStepById(db, run.step_id);
      if (!step) return res.status(404).json({ error: "Step not found" });
      if (rejectBlockedStep(res, step)) return;
      const seriesCode = String(req.params.seriesCode || "").trim();
      const definition = getQualificationSeriesDefinitionsForExperiment(
        db,
        run.experiment_id,
        step.step_number
      ).find((item) => item.code === seriesCode);
      if (!definition || definition.source === "run_fields") {
        return res.status(404).json({ error: "An imported instrument series is not declared for this run" });
      }
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ error: "Choose a TXT, CSV or TSV instrument export" });
      if (!/\.(csv|tsv|txt)$/i.test(file.originalname)) {
        return res.status(400).json({ error: "Use a TXT, CSV or TSV instrument export" });
      }
      const points = parseTwoColumnInstrumentExport(file.buffer);
      if (points.length < definition.minimum_points) {
        return res.status(400).json({ error: `The file must contain at least ${definition.minimum_points} numeric strain/stress rows` });
      }
      if (points.length > 50_000) return res.status(400).json({ error: "A series cannot contain more than 50000 points" });
      if (!req.user?.id) return res.status(401).json({ error: "A signed-in uploader is required" });
      try {
        const [stored] = await storeUserFiles(db, req.user.id, [file]);
        const placement = qualificationSeriesFilePlacement(seriesCode);
        unlinkStoredFilesForEntityPlacement(db, { entityType: "qualification_run", entityId: runId, placement });
        linkStoredFile(db, { fileId: stored.id, entityType: "qualification_run", entityId: runId, placement });
        replaceQualRunSeries(db, {
          experimentId: run.experiment_id,
          stepId: step.id,
          runId,
          seriesCode,
          contractVersion: definition.contract_version,
          sourceName: stored.original_name,
          points
        });
        recomputeDerivedAndSummary(db, run.experiment_id, step.id, step.step_number);
        insertAudit(db, {
          actorUserId: req.user.id,
          action: "qualification.series_source.upload",
          targetUserId: req.user.id,
          detailsJson: JSON.stringify({ experiment_id: run.experiment_id, qualification_run_id: runId, series_code: seriesCode, file_id: stored.id, point_count: points.length })
        });
        return res.status(201).json({
          ok: true,
          point_count: points.length,
          file: { id: stored.id, name: stored.original_name, download_url: `/files/${stored.id}/download` }
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "Instrument export could not be stored" });
      }
    }
  );

  router.delete("/qual-runs/:id/series/:seriesCode/source", ensureQualRunAccess, (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const seriesCode = String(req.params.seriesCode || "").trim();
    const definition = getQualificationSeriesDefinitionsForExperiment(db, run.experiment_id, step.step_number)
      .find((item) => item.code === seriesCode);
    if (!definition || definition.source === "run_fields") {
      return res.status(404).json({ error: "An imported instrument series is not declared for this run" });
    }
    deleteQualRunSeries(db, runId, seriesCode);
    unlinkStoredFilesForEntityPlacement(db, {
      entityType: "qualification_run",
      entityId: runId,
      placement: qualificationSeriesFilePlacement(seriesCode)
    });
    recomputeDerivedAndSummary(db, run.experiment_id, step.id, step.step_number);
    insertAudit(db, {
      actorUserId: req.user?.id ?? null,
      action: "qualification.series_source.unlink",
      targetUserId: req.user?.id ?? null,
      detailsJson: JSON.stringify({ experiment_id: run.experiment_id, qualification_run_id: runId, series_code: seriesCode })
    });
    return res.json({ ok: true });
  });

  router.delete("/qual-runs/:id/series/:seriesCode", ensureQualRunAccess, (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const seriesCode = String(req.params.seriesCode || "").trim();
    const definition = getQualificationSeriesDefinitionsForExperiment(
      db,
      run.experiment_id,
      step.step_number
    ).find((item) => item.code === seriesCode);
    if (!definition) return res.status(404).json({ error: "Series is not declared for this stage" });
    if (definition.source === "run_fields") {
      return res.status(409).json({ error: "This chart is generated from the qualification runs and has no imported series to clear" });
    }
    deleteQualRunSeries(db, runId, seriesCode);
    unlinkStoredFilesForEntityPlacement(db, {
      entityType: "qualification_run",
      entityId: runId,
      placement: qualificationSeriesFilePlacement(seriesCode)
    });
    if (step.step_number === 5 && seriesCode === "tracer_concentration_response") {
      updateExtrusionRtdMetricsFromSeries(db, step.id, runId);
    }
    recomputeDerivedAndSummary(db, run.experiment_id, step.id, step.step_number);
    return res.json({ ok: true });
  });

  router.post("/qual-runs/:id/flags", ensureQualRunAccess, (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const done = Number(req.body.done ? 1 : 0);
    const exclude = Number(req.body.exclude ? 1 : 0);
    const dueAtRaw = String(req.body?.due_at ?? "").trim();
    const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(dueAtRaw) ? dueAtRaw : null;
    updateQualRunFlags(db, runId, done, exclude);
    updateQualRunDueAt(db, runId, dueAt);
    recomputeDerivedAndSummary(db, run.experiment_id, run.step_id, step.step_number);
    const summaryRow = listQualSummaries(db, run.experiment_id).find((item) => item.step_number === step.step_number);
    let summary: Record<string, unknown> = {};
    try { summary = JSON.parse(summaryRow?.summary_json || "{}"); } catch {}
    return res.json({ ok: true, summary });
  });

  router.post("/qual-runs/:id/due-at", ensureQualRunAccess, (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const dueAtRaw = String(req.body?.due_at ?? "").trim();
    const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(dueAtRaw) ? dueAtRaw : null;
    updateQualRunDueAt(db, runId, dueAt);
    return res.json({ ok: true, due_at: dueAt });
  });

  router.post("/qual-runs/:id/metadata", ensureQualRunAccess, (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const performedAtRaw = String(req.body?.performed_at ?? "").trim();
    const performedAt = /^\d{4}-\d{2}-\d{2}$/.test(performedAtRaw) ? performedAtRaw : null;
    const rawUserId = Number(req.body?.responsible_user_id);
    const responsibleUserId = Number.isInteger(rawUserId) && rawUserId > 0 ? rawUserId : null;
    if (responsibleUserId && !findUserById(db, responsibleUserId)) {
      return res.status(400).json({ error: "Responsible user not found" });
    }
    updateQualRunMetadata(db, runId, { performedAt, responsibleUserId });
    return res.json({ ok: true, performed_at: performedAt, responsible_user_id: responsibleUserId });
  });

  router.post("/experiments/:id/qualification/:step/outputs/:outputCode", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const outputCode = String(req.params.outputCode || "").trim();
    const definition = getQualificationOutputDefinitionsForExperiment(db, experimentId, stepNumber)
      .find((item) => item.code === outputCode);
    if (!definition) return res.status(404).json({ error: "Output is not declared for this stage" });
    if (definition.value_source === "summary") {
      return res.status(409).json({ error: "This output is calculated from the run evidence and cannot be edited manually" });
    }
    const rawValue = String(req.body?.value ?? "").trim();
    const valueReal = definition.field_type === "number" && rawValue !== "" ? Number(rawValue) : null;
    if (definition.field_type === "number" && rawValue !== "" && !Number.isFinite(valueReal)) {
      return res.status(400).json({ error: "A finite numeric value is required" });
    }
    if (rawValue && definition.allowed_values?.length && !definition.allowed_values.some((option) => option.value === rawValue)) {
      return res.status(400).json({ error: "Choose a declared output value" });
    }
    upsertQualStepOutput(db, {
      experiment_id: experimentId,
      step_id: step.id,
      output_group: definition.group,
      output_code: definition.code,
      param_def_id: findGlobalParamByCode(db, definition.code)?.id ?? null,
      value_real: valueReal,
      value_text: definition.field_type === "text" ? rawValue || null : null
    });
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/single-factor-sweep/setup", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    const generator = getStepDefinitionForExperiment(db, experimentId, stepNumber)?.run_generator;
    if (!step || !generator || generator.type !== "single_factor_sweep") {
      return res.status(404).json({ error: "A single-factor setup is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;

    const variableCode = String(req.body?.variable_code || "").trim();
    const variableField = generator.variable_fields.find((field) => field.code === variableCode);
    if (!variableField) return res.status(400).json({ error: "Choose a declared varying parameter" });
    const parseNumber = (value: unknown) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const values: Record<string, number> = {};
    for (const field of generator.setup_fields) {
      const value = parseNumber(req.body?.[field.code]);
      if (value == null || (field.minimum != null && value < field.minimum)) {
        return res.status(400).json({ error: `Enter a valid setup value for ${field.label}` });
      }
      values[field.code] = value;
    }
    const fixedValue = parseNumber(req.body?.[variableField.fixed_setup_code]);
    if (fixedValue == null || (variableField.minimum != null && fixedValue < variableField.minimum)) {
      return res.status(400).json({ error: `Enter a valid setup value for ${variableField.fixed_setup_label}` });
    }
    values[variableField.fixed_setup_code] = fixedValue;

    let existingSettings: Record<string, unknown> = {};
    const existingRaw = getQualStepSettings(db, experimentId, stepNumber);
    if (existingRaw) {
      try {
        existingSettings = JSON.parse(existingRaw) as Record<string, unknown>;
      } catch {
        existingSettings = {};
      }
    }
    const nextSettings = {
      ...existingSettings,
      ...values,
      jacobs_variable_code: variableCode
    };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(nextSettings));
    // A Jacobs setup is the source of the fixed optical/material conditions
    // for the following exposure/layer matrix. Hand off only empty Step 3
    // fields: a user may deliberately refine them there without Step 2 later
    // overwriting that decision.
    const followingGenerator = getStepDefinitionForExperiment(db, experimentId, stepNumber + 1)?.run_generator;
    const followingStep = getQualStep(db, experimentId, stepNumber + 1);
    if (followingStep && followingGenerator?.type === "exposure_layer_matrix") {
      let followingSettings: Record<string, unknown> = {};
      const followingRaw = getQualStepSettings(db, experimentId, stepNumber + 1);
      if (followingRaw) {
        try {
          followingSettings = JSON.parse(followingRaw) as Record<string, unknown>;
        } catch {
          followingSettings = {};
        }
      }
      const nextFollowingSettings = {
        ...followingSettings,
        exposure_window_wavelength_nm: followingSettings.exposure_window_wavelength_nm ?? values.jacobs_wavelength_nm ?? null,
        exposure_window_resin_temp_c: followingSettings.exposure_window_resin_temp_c ?? values.jacobs_resin_temp_c ?? null,
        exposure_window_irradiance_mw_cm2: followingSettings.exposure_window_irradiance_mw_cm2 ?? (
          variableCode === "exposure_time_s" ? fixedValue : null
        ),
        exposure_window_bottom_exposure_s: followingSettings.exposure_window_bottom_exposure_s ?? null
      };
      if (JSON.stringify(nextFollowingSettings) !== followingRaw) {
        upsertQualStepSettings(db, experimentId, stepNumber + 1, JSON.stringify(nextFollowingSettings));
      }
    }
    listQualFields(db, step.id).forEach((field) => {
      if (["irradiance_mw_cm2", "exposure_time_s"].includes(field.code)) {
        const isEnabled = field.code === variableCode ? 1 : 0;
        if (field.is_enabled !== isEnabled) updateQualField(db, field.id, { is_enabled: isEnabled });
      }
    });
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, settings: nextSettings, variable_code: variableCode });
  });

  router.post("/experiments/:id/qualification/:step/single-factor-sweep", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    const generator = getStepDefinitionForExperiment(db, experimentId, stepNumber)?.run_generator;
    if (!step || !generator || generator.type !== "single_factor_sweep") {
      return res.status(404).json({ error: "A single-factor run generator is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;

    const variableCode = String(req.body?.variable_code || "").trim();
    const variableField = generator.variable_fields.find((field) => field.code === variableCode);
    if (!variableField) return res.status(400).json({ error: "Choose a declared varying parameter" });
    const parseNumber = (value: unknown) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const levels = [...new Set(String(req.body?.levels || "").split(/[;,\s]+/)
      .map((value) => Number(value.replace(",", ".")))
      .filter((value) => Number.isFinite(value) && (variableField.minimum == null || value >= variableField.minimum)))]
      .sort((left, right) => left - right);
    if (!levels.length) {
      return res.status(400).json({ error: `Enter one or more valid ${variableField.label.toLowerCase()} levels` });
    }
    if (levels.length > 100) return res.status(400).json({ error: "A generator may create at most 100 runs at once" });

    let setup: Record<string, unknown> = {};
    const setupRaw = getQualStepSettings(db, experimentId, stepNumber);
    if (setupRaw) {
      try {
        setup = JSON.parse(setupRaw) as Record<string, unknown>;
      } catch {
        setup = {};
      }
    }
    if (String(setup.jacobs_variable_code || generator.default_variable_code) !== variableCode) {
      return res.status(400).json({ error: "Save the experiment setup before generating this run series" });
    }
    for (const field of generator.setup_fields) {
      const value = parseNumber(setup[field.code]);
      if (value == null || (field.minimum != null && value < field.minimum)) {
        return res.status(400).json({ error: `Complete Experiment setup: ${field.label}` });
      }
    }
    const configuredFixedValue = parseNumber(setup[variableField.fixed_setup_code]);
    if (configuredFixedValue == null || (variableField.minimum != null && configuredFixedValue < variableField.minimum)) {
      return res.status(400).json({ error: `Complete Experiment setup: ${variableField.fixed_setup_label}` });
    }

    const fieldsByCode = new Map(listQualFields(db, step.id)
      .filter((field) => field.is_enabled === 1)
      .map((field) => [field.code, field]));
    const missingField = !fieldsByCode.has(variableCode) ? variableCode : null;
    if (missingField) return res.status(400).json({ error: `Generator field is unavailable: ${missingField}` });

    const hasRecordedValue = (runId: number) => listQualRunValues(db, runId).some((value) => (
      value.value_real != null || value.value_text != null || value.value_tags_json != null
    ));
    let blankRuns = listQualRuns(db, step.id)
      .filter((run) => run.run_group === "default" && !hasRecordedValue(run.id));
    const created = Math.max(0, levels.length - blankRuns.length);
    if (created) {
      createQualRuns(db, experimentId, step.id, created);
      blankRuns = listQualRuns(db, step.id)
        .filter((run) => run.run_group === "default" && !hasRecordedValue(run.id));
    }
    const generatedRuns = blankRuns.slice(0, levels.length);
    generatedRuns.forEach((run, index) => {
      const field = fieldsByCode.get(variableCode)!;
      saveQualRunValue(db, run.id, field.id, field.field_type, levels[index]);
    });
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({
      ok: true,
      variable_code: variableCode,
      levels,
      generated_run_codes: generatedRuns.map((run) => run.run_code),
      created
    });
  });

  router.post("/experiments/:id/qualification/:step/exposure-layer-matrix/setup", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    const generator = getStepDefinitionForExperiment(db, experimentId, stepNumber)?.run_generator;
    if (!step || !generator || generator.type !== "exposure_layer_matrix") {
      return res.status(404).json({ error: "An exposure-layer matrix setup is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const parseNumber = (value: unknown) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const values: Record<string, number | null> = {};
    for (const field of generator.setup_fields) {
      const raw = String(req.body?.[field.code] ?? "").trim();
      const value = raw ? parseNumber(raw) : null;
      if (field.required && value == null) {
        return res.status(400).json({ error: `Enter a setup value for ${field.label}` });
      }
      if (value != null && field.minimum != null && value < field.minimum) {
        return res.status(400).json({ error: `Enter a valid setup value for ${field.label}` });
      }
      values[field.code] = value;
    }
    let existingSettings: Record<string, unknown> = {};
    const existingRaw = getQualStepSettings(db, experimentId, stepNumber);
    if (existingRaw) {
      try {
        existingSettings = JSON.parse(existingRaw) as Record<string, unknown>;
      } catch {
        existingSettings = {};
      }
    }
    const settings = { ...existingSettings, ...values };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, settings });
  });

  router.post("/experiments/:id/qualification/:step/exposure-layer-matrix", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    const generator = getStepDefinitionForExperiment(db, experimentId, stepNumber)?.run_generator;
    if (!step || !generator || generator.type !== "exposure_layer_matrix") {
      return res.status(404).json({ error: "An exposure-layer matrix generator is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const parseLevels = (value: unknown, minimum: number) => [...new Set(String(value ?? "").split(/[;,\s]+/)
      .map((item) => Number(item.replace(",", ".")))
      .filter((item) => Number.isFinite(item) && item >= minimum))]
      .sort((left, right) => left - right);
    const layerField = generator.variable_fields[0];
    const overcureField = generator.variable_fields[1];
    const layerHeights = parseLevels(req.body?.layer_height_levels, layerField.minimum ?? 0);
    const overcureTargets = parseLevels(req.body?.target_overcure_levels, overcureField.minimum ?? -99.999);
    if (!layerHeights.length || !overcureTargets.length) {
      return res.status(400).json({ error: "Enter at least one layer height and one target overcure level" });
    }
    const cellCount = layerHeights.length * overcureTargets.length;
    if (cellCount > 100) return res.status(400).json({ error: "A generator may create at most 100 runs at once" });

    let setup: Record<string, unknown> = {};
    const setupRaw = getQualStepSettings(db, experimentId, stepNumber);
    if (setupRaw) {
      try {
        setup = JSON.parse(setupRaw) as Record<string, unknown>;
      } catch {
        setup = {};
      }
    }
    const numericSetting = (value: unknown) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    for (const field of generator.setup_fields.filter((item) => item.required)) {
      const value = numericSetting(setup[field.code]);
      if (value == null || (field.minimum != null && value < field.minimum)) {
        return res.status(400).json({ error: `Complete Experiment setup: ${field.label}` });
      }
    }
    const irradiance = numericSetting(setup.exposure_window_irradiance_mw_cm2);
    if (irradiance == null || irradiance <= 0) {
      return res.status(400).json({ error: "Complete Experiment setup: Measured irradiance" });
    }
    const jacobsStep = getQualStep(db, experimentId, 2);
    const jacobsOutputs = new Map((jacobsStep ? listQualStepOutputs(db, jacobsStep.id) : [])
      .map((output) => [output.output_code, output.value_real]));
    const ec = jacobsOutputs.get("critical_exposure_ec_mj_cm2");
    const dp = jacobsOutputs.get("penetration_depth_dp_um");
    if (!Number.isFinite(ec) || (ec as number) <= 0 || !Number.isFinite(dp) || (dp as number) <= 0) {
      return res.status(400).json({ error: "A valid Step 2 Jacobs fit (Ec and Dp) is required before generating this matrix" });
    }

    const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
    const layerHeightField = fields.get("layer_height_um");
    const targetOvercureField = fields.get("target_overcure_pct");
    const exposureTimeField = fields.get("exposure_time_s");
    if (!layerHeightField || !targetOvercureField || !exposureTimeField || layerHeightField.is_enabled !== 1 || targetOvercureField.is_enabled !== 1 || exposureTimeField.is_enabled !== 1) {
      return res.status(400).json({ error: "The matrix run fields are unavailable" });
    }
    const matrix = layerHeights.flatMap((layerHeight) => overcureTargets.map((targetOvercure) => {
      const targetCureDepth = layerHeight * (1 + targetOvercure / 100);
      const dose = (ec as number) * Math.exp(targetCureDepth / (dp as number));
      return { layerHeight, targetOvercure, exposureTime: dose / irradiance };
    }));
    if (matrix.some((cell) => !Number.isFinite(cell.exposureTime) || cell.exposureTime <= 0)) {
      return res.status(400).json({ error: "The Step 2 curve cannot produce a finite positive exposure time for this matrix" });
    }
    const hasRecordedValue = (runId: number) => listQualRunValues(db, runId).some((value) => (
      value.value_real != null || value.value_text != null || value.value_tags_json != null
    ));
    let blankRuns = listQualRuns(db, step.id)
      .filter((run) => run.run_group === "default" && !hasRecordedValue(run.id));
    const created = Math.max(0, matrix.length - blankRuns.length);
    if (created) {
      createQualRuns(db, experimentId, step.id, created);
      blankRuns = listQualRuns(db, step.id)
        .filter((run) => run.run_group === "default" && !hasRecordedValue(run.id));
    }
    const generatedRuns = blankRuns.slice(0, matrix.length);
    generatedRuns.forEach((run, index) => {
      const cell = matrix[index];
      saveQualRunValue(db, run.id, layerHeightField.id, layerHeightField.field_type, cell.layerHeight);
      saveQualRunValue(db, run.id, targetOvercureField.id, targetOvercureField.field_type, cell.targetOvercure);
      saveQualRunValue(db, run.id, exposureTimeField.id, exposureTimeField.field_type, cell.exposureTime);
    });
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify({
      ...setup,
      exposure_window_layer_height_levels: layerHeights.join("; "),
      exposure_window_target_overcure_levels: overcureTargets.join("; ")
    }));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({
      ok: true,
      matrix_cell_count: matrix.length,
      generated_run_codes: generatedRuns.map((run) => run.run_code),
      created
    });
  });

  router.post("/experiments/:id/qualification/:step/peel-force-matrix/setup", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    const generator = getStepDefinitionForExperiment(db, experimentId, stepNumber)?.run_generator;
    if (!step || !generator || generator.type !== "peel_force_matrix") {
      return res.status(404).json({ error: "A peel-force matrix setup is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const positiveNumber = (value: unknown) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const vatFilm = String(req.body?.peel_vat_film_type ?? "").trim();
    const vatFilmField = listQualFields(db, step.id).find((field) => field.code === "vat_film_type");
    let allowedFilms: string[] = [];
    try { allowedFilms = JSON.parse(vatFilmField?.allowed_values_json || "[]") as string[]; } catch {}
    if (!vatFilm || (allowedFilms.length && !allowedFilms.includes(vatFilm))) {
      return res.status(400).json({ error: "Choose a declared vat-film type" });
    }
    const supportNeck = positiveNumber(req.body?.peel_support_neck_diameter_mm);
    const layerHeight = positiveNumber(req.body?.peel_layer_height_um);
    const supportGeometry = String(req.body?.peel_support_geometry_note ?? "").trim();
    if (supportNeck == null) return res.status(400).json({ error: "Enter a positive support-neck diameter" });
    if (layerHeight == null) return res.status(400).json({ error: "Enter a positive qualified layer height" });
    if (!supportGeometry) return res.status(400).json({ error: "Describe the fixed support geometry" });

    let existingSettings: Record<string, unknown> = {};
    const existingRaw = getQualStepSettings(db, experimentId, stepNumber);
    try { existingSettings = JSON.parse(existingRaw || "{}") as Record<string, unknown>; } catch {}
    const settings = {
      ...existingSettings,
      peel_vat_film_type: vatFilm,
      peel_support_neck_diameter_mm: supportNeck,
      peel_support_geometry_note: supportGeometry,
      peel_layer_height_um: layerHeight
    };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, settings });
  });

  router.post("/experiments/:id/qualification/:step/peel-force-matrix", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    const generator = getStepDefinitionForExperiment(db, experimentId, stepNumber)?.run_generator;
    if (!step || !generator || generator.type !== "peel_force_matrix") {
      return res.status(404).json({ error: "A peel-force matrix generator is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const parseLevels = (value: unknown, minimum: number) => [...new Set(String(value ?? "").split(/[;,\s]+/)
      .map((item) => Number(item.replace(",", ".")))
      .filter((item) => Number.isFinite(item) && item >= minimum))]
      .sort((left, right) => left - right);
    const liftField = generator.variable_fields[0];
    const areaField = generator.variable_fields[1];
    const exposureField = generator.variable_fields[2];
    const liftSpeeds = parseLevels(req.body?.lift_speed_levels, liftField.minimum ?? 0);
    const layerAreas = parseLevels(req.body?.layer_area_levels, areaField.minimum ?? 0);
    const exposureTimes = parseLevels(req.body?.exposure_time_levels, exposureField.minimum ?? 0);
    if (!liftSpeeds.length || !layerAreas.length || !exposureTimes.length) {
      return res.status(400).json({ error: "Enter at least one lift speed, representative layer area and exposure" });
    }
    const cellCount = liftSpeeds.length * layerAreas.length * exposureTimes.length;
    if (cellCount > 100) return res.status(400).json({ error: "A generator may create at most 100 runs at once" });

    let setup: Record<string, unknown> = {};
    const setupRaw = getQualStepSettings(db, experimentId, stepNumber);
    try { setup = JSON.parse(setupRaw || "{}") as Record<string, unknown>; } catch {}
    const numberSetting = (value: unknown) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      const parsed = Number(text.replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const setupComplete = (
      String(setup.peel_vat_film_type || "").trim() &&
      String(setup.peel_support_geometry_note || "").trim() &&
      ["peel_support_neck_diameter_mm", "peel_layer_height_um"]
        .every((code) => (numberSetting(setup[code]) ?? 0) > 0)
    );
    if (!setupComplete) return res.status(400).json({ error: "Complete the fixed experiment setup before generating runs" });

    const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
    const liftSpeedField = fields.get(liftField.code);
    const layerAreaField = fields.get(areaField.code);
    const exposureTimeField = fields.get(exposureField.code);
    if (!liftSpeedField || !layerAreaField || !exposureTimeField || liftSpeedField.is_enabled !== 1 || layerAreaField.is_enabled !== 1 || exposureTimeField.is_enabled !== 1) {
      return res.status(400).json({ error: "The matrix run fields are unavailable" });
    }
    const matrix = liftSpeeds.flatMap((liftSpeed) => layerAreas.flatMap((layerArea) => exposureTimes.map((exposureTime) => ({ liftSpeed, layerArea, exposureTime }))));
    const hasRecordedValue = (runId: number) => listQualRunValues(db, runId).some((value) => (
      value.value_real != null || value.value_text != null || value.value_tags_json != null
    ));
    let blankRuns = listQualRuns(db, step.id)
      .filter((run) => run.run_group === "default" && !hasRecordedValue(run.id));
    const created = Math.max(0, matrix.length - blankRuns.length);
    if (created) {
      createQualRuns(db, experimentId, step.id, created);
      blankRuns = listQualRuns(db, step.id)
        .filter((run) => run.run_group === "default" && !hasRecordedValue(run.id));
    }
    const generatedRuns = blankRuns.slice(0, matrix.length);
    generatedRuns.forEach((run, index) => {
      const cell = matrix[index];
      saveQualRunValue(db, run.id, liftSpeedField.id, liftSpeedField.field_type, cell.liftSpeed);
      saveQualRunValue(db, run.id, layerAreaField.id, layerAreaField.field_type, cell.layerArea);
      saveQualRunValue(db, run.id, exposureTimeField.id, exposureTimeField.field_type, cell.exposureTime);
    });
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify({
      ...setup,
      peel_lift_speed_levels: liftSpeeds.join("; "),
      peel_layer_area_levels: layerAreas.join("; "),
      peel_exposure_time_levels: exposureTimes.join("; ")
    }));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({
      ok: true,
      matrix_cell_count: matrix.length,
      generated_run_codes: generatedRuns.map((run) => run.run_code),
      created
    });
  });

  router.post("/experiments/:id/qualification/:step/post-cure-matrix/setup", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    const generator = getStepDefinitionForExperiment(db, experimentId, stepNumber)?.run_generator;
    if (!step || !generator || generator.type !== "post_cure_matrix") {
      return res.status(404).json({ error: "A post-cure matrix setup is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const numberAtLeast = (value: unknown, minimum: number) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) && parsed >= minimum ? parsed : null;
    };
    const positiveNumber = (value: unknown) => numberAtLeast(value, Number.EPSILON);
    const washMethod = String(req.body?.post_cure_wash_method ?? "").trim();
    const washMethodField = listQualFields(db, step.id).find((field) => field.code === "wash_method");
    let allowedWashMethods: string[] = [];
    try { allowedWashMethods = JSON.parse(washMethodField?.allowed_values_json || "[]") as string[]; } catch {}
    if (!washMethod || (allowedWashMethods.length && !allowedWashMethods.includes(washMethod))) {
      return res.status(400).json({ error: "Choose a declared wash method" });
    }
    const washTime = numberAtLeast(req.body?.post_cure_wash_time_min, 0);
    const layerHeight = positiveNumber(req.body?.post_cure_layer_height_um);
    const exposureTime = positiveNumber(req.body?.post_cure_exposure_time_s);
    const baselineTgRaw = String(req.body?.post_cure_baseline_tg_c ?? "").trim();
    const baselineTg = baselineTgRaw ? Number(baselineTgRaw.replace(",", ".")) : NaN;
    const sourceNote = String(req.body?.post_cure_source_note ?? "").trim();
    if (washTime == null) return res.status(400).json({ error: "Enter a non-negative wash time" });
    if (layerHeight == null) return res.status(400).json({ error: "Enter a positive baseline layer height" });
    if (exposureTime == null) return res.status(400).json({ error: "Enter a positive baseline layer exposure" });
    if (!Number.isFinite(baselineTg)) return res.status(400).json({ error: "Enter the baseline Tg used to calculate ΔTg" });
    if (!sourceNote) return res.status(400).json({ error: "Describe the fixed post-cure source" });

    let existingSettings: Record<string, unknown> = {};
    const existingRaw = getQualStepSettings(db, experimentId, stepNumber);
    try { existingSettings = JSON.parse(existingRaw || "{}") as Record<string, unknown>; } catch {}
    const settings = {
      ...existingSettings,
      post_cure_wash_method: washMethod,
      post_cure_wash_time_min: washTime,
      post_cure_source_note: sourceNote,
      post_cure_layer_height_um: layerHeight,
      post_cure_exposure_time_s: exposureTime,
      post_cure_baseline_tg_c: baselineTg
    };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, settings });
  });

  router.post("/experiments/:id/qualification/:step/post-cure-matrix", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    const generator = getStepDefinitionForExperiment(db, experimentId, stepNumber)?.run_generator;
    if (!step || !generator || generator.type !== "post_cure_matrix") {
      return res.status(404).json({ error: "A post-cure matrix generator is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const parseLevels = (value: unknown, minimum: number) => [...new Set(String(value ?? "").split(/[;,\s]+/)
      .map((item) => Number(item.replace(",", ".")))
      .filter((item) => Number.isFinite(item) && item >= minimum))]
      .sort((left, right) => left - right);
    const timeField = generator.variable_fields[0];
    const temperatureField = generator.variable_fields[1];
    const irradianceField = generator.variable_fields[2];
    const times = parseLevels(req.body?.post_cure_time_levels, timeField.minimum ?? 0);
    const temperatures = parseLevels(req.body?.post_cure_temp_levels, temperatureField.minimum ?? 0);
    const irradiances = parseLevels(req.body?.post_cure_irradiance_levels, irradianceField.minimum ?? 0);
    if (!times.length || !temperatures.length || !irradiances.length) {
      return res.status(400).json({ error: "Enter at least one post-cure time, temperature and irradiance" });
    }
    const cellCount = times.length * temperatures.length * irradiances.length;
    if (cellCount > 100) return res.status(400).json({ error: "A generator may create at most 100 runs at once" });

    let setup: Record<string, unknown> = {};
    const setupRaw = getQualStepSettings(db, experimentId, stepNumber);
    try { setup = JSON.parse(setupRaw || "{}") as Record<string, unknown>; } catch {}
    const numberSetting = (value: unknown) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      const parsed = Number(text.replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const setupComplete = (
      String(setup.post_cure_wash_method || "").trim() &&
      String(setup.post_cure_source_note || "").trim() &&
      (numberSetting(setup.post_cure_wash_time_min) ?? -1) >= 0 &&
      ["post_cure_layer_height_um", "post_cure_exposure_time_s"].every((code) => (numberSetting(setup[code]) ?? 0) > 0) &&
      numberSetting(setup.post_cure_baseline_tg_c) != null
    );
    if (!setupComplete) return res.status(400).json({ error: "Complete the fixed experiment setup before generating runs" });

    const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
    const timeRunField = fields.get(timeField.code);
    const temperatureRunField = fields.get(temperatureField.code);
    const irradianceRunField = fields.get(irradianceField.code);
    if (!timeRunField || !temperatureRunField || !irradianceRunField || timeRunField.is_enabled !== 1 || temperatureRunField.is_enabled !== 1 || irradianceRunField.is_enabled !== 1) {
      return res.status(400).json({ error: "The matrix run fields are unavailable" });
    }
    const matrix = times.flatMap((time) => temperatures.flatMap((temperature) => irradiances.map((irradiance) => ({ time, temperature, irradiance }))));
    const hasRecordedValue = (runId: number) => listQualRunValues(db, runId).some((value) => (
      value.value_real != null || value.value_text != null || value.value_tags_json != null
    ));
    let blankRuns = listQualRuns(db, step.id)
      .filter((run) => run.run_group === "post_cure_condition" && !hasRecordedValue(run.id));
    const created = Math.max(0, matrix.length - blankRuns.length);
    if (created) {
      createQualRuns(db, experimentId, step.id, created, "post_cure_condition");
      blankRuns = listQualRuns(db, step.id)
        .filter((run) => run.run_group === "post_cure_condition" && !hasRecordedValue(run.id));
    }
    const generatedRuns = blankRuns.slice(0, matrix.length);
    generatedRuns.forEach((run, index) => {
      const cell = matrix[index];
      saveQualRunValue(db, run.id, timeRunField.id, timeRunField.field_type, cell.time);
      saveQualRunValue(db, run.id, temperatureRunField.id, temperatureRunField.field_type, cell.temperature);
      saveQualRunValue(db, run.id, irradianceRunField.id, irradianceRunField.field_type, cell.irradiance);
    });
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify({
      ...setup,
      post_cure_time_levels: times.join("; "),
      post_cure_temp_levels: temperatures.join("; "),
      post_cure_irradiance_levels: irradiances.join("; ")
    }));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({
      ok: true,
      matrix_cell_count: matrix.length,
      generated_run_codes: generatedRuns.map((run) => run.run_code),
      created
    });
  });

  router.post("/experiments/:id/qualification/:step/mechanical-qualification/setup", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const experiment = getExperiment(db, experimentId);
    const process = experiment?.process_id ? getProcessById(db, experiment.process_id) : null;
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || stepNumber !== 7 || String(process?.process_type_code || "").toLowerCase() !== "sla_dlp") {
      return res.status(404).json({ error: "A final mechanical qualification setup is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const numberAtLeast = (value: unknown, minimum: number) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) && parsed >= minimum ? parsed : null;
    };
    const conditioningTemperature = numberAtLeast(req.body?.mechanical_conditioning_temp_c, -273.15);
    const conditioningTime = numberAtLeast(req.body?.mechanical_conditioning_time_h, 0);
    const conditioningRhRaw = String(req.body?.mechanical_conditioning_rh_pct ?? "").trim();
    const conditioningRh = conditioningRhRaw ? numberAtLeast(conditioningRhRaw, 0) : null;
    const tensileMethod = String(req.body?.mechanical_tensile_method ?? "").trim();
    const additionalMethods = String(req.body?.mechanical_additional_methods ?? "").trim();
    // The material identifier originates in Step 1. Retaining a submitted
    // value as a legacy fallback keeps older API clients usable, but the UI
    // always shows the Step 1 provenance rather than creating a new batch ID.
    const sourceMaterialStep = getQualStep(db, experimentId, 1);
    const sourceBatchField = sourceMaterialStep
      ? listQualFields(db, sourceMaterialStep.id).find((field) => field.code === "resin_batch")
      : null;
    const sourceBatch = sourceMaterialStep && sourceBatchField
      ? listQualRuns(db, sourceMaterialStep.id)
        .map((run) => listQualRunValues(db, run.id).find((value) => value.field_id === sourceBatchField.id)?.value_text?.trim())
        .find(Boolean)
      : null;
    const resinBatch = String(sourceBatch || req.body?.mechanical_resin_batch || "").trim();
    if (conditioningTemperature == null) return res.status(400).json({ error: "Enter the conditioning temperature" });
    if (conditioningTime == null) return res.status(400).json({ error: "Enter a non-negative conditioning duration" });
    if (conditioningRhRaw && (conditioningRh == null || conditioningRh > 100)) return res.status(400).json({ error: "Relative humidity must be between 0 and 100" });
    if (!tensileMethod) return res.status(400).json({ error: "Declare the tensile test method" });
    if (!resinBatch) return res.status(400).json({ error: "Record the material ID in Step 1 before saving the mechanical setup" });
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(getQualStepSettings(db, experimentId, stepNumber) || "{}") as Record<string, unknown>; } catch {}
    const settings = {
      ...existing,
      mechanical_conditioning_temp_c: conditioningTemperature,
      mechanical_conditioning_time_h: conditioningTime,
      mechanical_conditioning_rh_pct: conditioningRh,
      mechanical_tensile_method: tensileMethod,
      mechanical_additional_methods: additionalMethods || null,
      mechanical_resin_batch: resinBatch
    };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, settings });
  });

  router.post("/experiments/:id/qualification/:step/rheology/setup", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const experiment = getExperiment(db, experimentId);
    const process = experiment?.process_id ? getProcessById(db, experiment.process_id) : null;
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || stepNumber !== 8 || String(process?.process_type_code || "").toLowerCase() !== "sla_dlp") {
      return res.status(404).json({ error: "A resin-flow setup is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const program = String(req.body?.rheology_program || "").trim();
    if (!["steady_shear", "three_interval_thixotropy", "other"].includes(program)) {
      return res.status(400).json({ error: "Choose a declared rheology programme" });
    }
    const referenceShearRate = Number(String(req.body?.rheology_reference_shear_rate_s_inv ?? "").trim().replace(",", "."));
    if (!Number.isFinite(referenceShearRate) || referenceShearRate <= 0) {
      return res.status(400).json({ error: "Enter a positive reference shear rate" });
    }
    const materialStep = getQualStep(db, experimentId, 1);
    const batchField = materialStep ? listQualFields(db, materialStep.id).find((field) => field.code === "resin_batch") : null;
    const materialId = materialStep && batchField
      ? listQualRuns(db, materialStep.id)
        .map((run) => listQualRunValues(db, run.id).find((value) => value.field_id === batchField.id)?.value_text?.trim())
        .find(Boolean)
      : null;
    if (!materialId) return res.status(400).json({ error: "Record the material ID in Step 1 before saving the rheology setup" });
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(getQualStepSettings(db, experimentId, stepNumber) || "{}") as Record<string, unknown>; } catch {}
    const settings = {
      ...existing,
      rheology_material_batch: materialId,
      rheology_program: program,
      rheology_reference_shear_rate_s_inv: referenceShearRate
    };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, settings });
  });

  router.post("/experiments/:id/qualification/:step/dimensional-artifact/setup", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const experiment = getExperiment(db, experimentId);
    const process = experiment?.process_id ? getProcessById(db, experiment.process_id) : null;
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || stepNumber !== 4 || String(process?.process_type_code || "").toLowerCase() !== "sla_dlp") {
      return res.status(404).json({ error: "A dimensional-artifact setup is not declared for this stage" });
    }
    if (rejectBlockedStep(res, step)) return;
    const parsePositiveNumber = (value: unknown) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const layerHeightUm = parsePositiveNumber(req.body?.dimensional_layer_height_um);
    const exposureTimeS = parsePositiveNumber(req.body?.dimensional_exposure_time_s);
    if (layerHeightUm == null) return res.status(400).json({ error: "Enter a positive qualified layer height" });
    if (exposureTimeS == null) return res.status(400).json({ error: "Enter a positive qualified layer exposure" });

    const preset = getQualificationArtifactPreset("nist_am_test_artifact");
    if (!preset) return res.status(500).json({ error: "NIST dimensional artifact preset is unavailable" });

    let existingSettings: Record<string, unknown> = {};
    const existingRaw = getQualStepSettings(db, experimentId, stepNumber);
    if (existingRaw) {
      try {
        existingSettings = JSON.parse(existingRaw) as Record<string, unknown>;
      } catch {
        existingSettings = {};
      }
    }
    const settings = {
      ...existingSettings,
      dimensional_layer_height_um: layerHeightUm,
      dimensional_exposure_time_s: exposureTimeS,
      dimensional_artifact_preset: preset.code,
      dimensional_artifact_name: preset.name,
      dimensional_artifact_reference_url: preset.source_url,
      dimensional_artifact_revision: "NIST public test artifact"
    };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, settings });
  });

  router.post("/experiments/:id/qualification/:step/runs", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const runGroup = String(req.body?.run_group ?? "default").trim().toLowerCase();
    const allowedGroups = new Set(["default", "rheology", "thermal_hold", "pump_characteristic"]);
    if (!allowedGroups.has(runGroup)) return res.status(400).json({ error: "Invalid run group" });
    createQualRuns(db, experimentId, step.id, 1, runGroup);
    const runs = listQualRuns(db, step.id);
    const run = runs[runs.length - 1];
    if (getQualificationOutputDefinitionsForExperiment(db, experimentId, stepNumber).length > 0 && runGroup === "rheology" && run) {
      const referenceRun = runs.find((item) => item.id !== run.id && item.run_group === "rheology");
      if (referenceRun) {
        const geometryFields = listQualFields(db, step.id).filter((field) =>
          ["capillary_diameter_mm", "capillary_length_mm"].includes(field.code)
        );
        const sourceValues = new Map(listQualRunValues(db, referenceRun.id).map((value) => [value.field_id, value]));
        geometryFields.forEach((field) => {
          const value = sourceValues.get(field.id);
          if (value?.value_real != null) saveQualRunValue(db, run.id, field.id, "number", value.value_real);
        });
      }
    }
    return res.json({ run });
  });

  router.post("/experiments/:id/qualification/:step/matrix", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) return res.status(403).json({ error: "Forbidden" });
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || stepNumber !== 3) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const parseLevels = (value: unknown) => [...new Set(String(value || "").split(/[;,\s]+/).map(Number).filter((item) => Number.isFinite(item) && item > 0))].sort((a, b) => a - b);
    const speeds = parseLevels(req.body?.screw_speed_levels_rpm);
    const feederStep = getQualStep(db, experimentId, 2);
    const feederOutputs = feederStep ? new Map(listQualStepOutputs(db, feederStep.id).map((output) => [output.output_code, output.value_real])) : new Map<string, number | null>();
    const feederMin = feederOutputs.get("feeder_stable_throughput_min_kg_h");
    const feederMax = feederOutputs.get("feeder_stable_throughput_max_kg_h");
    const inheritedThroughputs = Number.isFinite(feederMin) && Number.isFinite(feederMax) && (feederMax as number) >= (feederMin as number)
      ? [feederMin as number, ((feederMin as number) + (feederMax as number)) / 2, feederMax as number]
      : [];
    const requestedThroughputs = parseLevels(req.body?.throughput_levels_kg_h);
    const throughputs = requestedThroughputs.length ? requestedThroughputs : inheritedThroughputs;
    if (!speeds.length || !throughputs.length) return res.status(400).json({ error: "Enter feed-rate levels, or confirm the stable feeder range in Step 2" });
    const cells = speeds.flatMap((speed) => throughputs.map((throughput) => ({ speed, throughput })));
    let runs = listQualRuns(db, step.id).filter((run) => run.run_group === "default");
    while (runs.length < cells.length) { createQualRuns(db, experimentId, step.id, 1); runs = listQualRuns(db, step.id).filter((run) => run.run_group === "default"); }
    const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
    const rpm = fields.get("screw_speed_rpm"); const throughput = fields.get("throughput_kg_h");
    if (!rpm || !throughput) return res.status(400).json({ error: "Matrix fields unavailable" });
    cells.forEach((cell, index) => { saveQualRunValue(db, runs[index].id, rpm.id, "number", cell.speed); saveQualRunValue(db, runs[index].id, throughput.id, "number", cell.throughput); });
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, run_count: cells.length });
  });

  router.post("/experiments/:id/qualification/:step/pump-curve-matrix", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) return res.status(403).json({ error: "Forbidden" });
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || stepNumber !== 3) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const parseLevels = (value: unknown) => [...new Set(String(value || "").split(/[;,\s]+/).map(Number).filter((item) => Number.isFinite(item) && item > 0))].sort((a, b) => a - b);
    const speeds = parseLevels(req.body?.screw_speed_levels_rpm);
    const pressures = parseLevels(req.body?.back_pressure_levels_bar);
    if (!speeds.length || !pressures.length) return res.status(400).json({ error: "Enter screw-speed and back-pressure levels" });
    const cells = speeds.flatMap((speed) => pressures.map((pressure) => ({ speed, pressure })));
    let runs = listQualRuns(db, step.id).filter((run) => run.run_group === "pump_characteristic");
    while (runs.length < cells.length) {
      createQualRuns(db, experimentId, step.id, 1, "pump_characteristic");
      runs = listQualRuns(db, step.id).filter((run) => run.run_group === "pump_characteristic");
    }
    const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
    const rpm = fields.get("screw_speed_rpm");
    const targetPressure = fields.get("target_back_pressure_bar");
    if (!rpm || !targetPressure) return res.status(400).json({ error: "Pump-curve fields unavailable" });
    cells.forEach((cell, index) => {
      saveQualRunValue(db, runs[index].id, rpm.id, "number", cell.speed);
      saveQualRunValue(db, runs[index].id, targetPressure.id, "number", cell.pressure);
    });
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, run_count: cells.length });
  });

  router.post("/experiments/:id/qualification/:step/thermal-matrix", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) return res.status(403).json({ error: "Forbidden" });
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || stepNumber !== 4) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const parseLevels = (value: unknown) => [...new Set(String(value || "").split(/[;,\s]+/).map(Number).filter((item) => Number.isFinite(item) && item > 0))].sort((a, b) => a - b);
    const speeds = parseLevels(req.body?.screw_speed_levels_rpm);
    const throughputs = parseLevels(req.body?.throughput_levels_kg_h);
    const temperatures = parseLevels(req.body?.barrel_temperature_levels_c);
    if (!speeds.length || !throughputs.length || !temperatures.length) {
      return res.status(400).json({ error: "Enter screw-speed, throughput and barrel-temperature levels" });
    }
    const cells = speeds.flatMap((speed) => throughputs.flatMap((throughput) => temperatures.map((temperature) => ({ speed, throughput, temperature }))));
    let runs = listQualRuns(db, step.id).filter((run) => run.run_group === "default");
    while (runs.length < cells.length) {
      createQualRuns(db, experimentId, step.id, 1);
      runs = listQualRuns(db, step.id).filter((run) => run.run_group === "default");
    }
    const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
    const rpm = fields.get("screw_speed_rpm");
    const throughput = fields.get("throughput_kg_h");
    const barrelTemp = fields.get("barrel_set_temp_c");
    if (!rpm || !throughput || !barrelTemp) return res.status(400).json({ error: "Thermal-matrix fields unavailable" });
    cells.forEach((cell, index) => {
      saveQualRunValue(db, runs[index].id, rpm.id, "number", cell.speed);
      saveQualRunValue(db, runs[index].id, throughput.id, "number", cell.throughput);
      saveQualRunValue(db, runs[index].id, barrelTemp.id, "number", cell.temperature);
    });
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, run_count: cells.length });
  });

  router.post("/experiments/:id/qualification/:step/rtd-matrix", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) return res.status(403).json({ error: "Forbidden" });
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || stepNumber !== 5) return res.status(404).json({ error: "Step not found" });
    if (rejectBlockedStep(res, step)) return;
    const parseLevels = (value: unknown) => [...new Set(String(value || "").split(/[;,\s]+/).map(Number).filter((item) => Number.isFinite(item) && item > 0))].sort((a, b) => a - b);
    const screwSpeeds = parseLevels(req.body?.screw_speed_levels_rpm);
    const throughputs = parseLevels(req.body?.throughput_levels_kg_h);
    if (!screwSpeeds.length || !throughputs.length) return res.status(400).json({ error: "Enter screw-speed and planned-throughput levels" });
    const feederStep = getQualStep(db, experimentId, 2);
    if (!feederStep) return res.status(400).json({ error: "Feeder calibration step is unavailable" });
    recomputeDerivedAndSummary(db, experimentId, feederStep.id, 2);
    const feederSummary = listQualSummaries(db, experimentId).find((row) => row.step_number === 2);
    let slope = NaN;
    let intercept = NaN;
    let calibrationRange: { min: number; max: number } | null = null;
    try {
      const parsed = JSON.parse(feederSummary?.summary_json || "{}") as Record<string, unknown>;
      slope = Number(parsed.feeder_calibration_slope_kg_h_per_rpm);
      intercept = Number(parsed.feeder_calibration_intercept_kg_h);
      const calibrationPoints = (Array.isArray(parsed.feeder_calibration_points) ? parsed.feeder_calibration_points : [])
        .map((point: any) => Number(point?.throughput))
        .filter(Number.isFinite);
      if (calibrationPoints.length) calibrationRange = { min: Math.min(...calibrationPoints), max: Math.max(...calibrationPoints) };
    } catch {}
    if (!Number.isFinite(slope) || !Number.isFinite(intercept) || !calibrationRange) return res.status(400).json({ error: "Complete at least two stable feeder-speed calibration points in Step 2 first" });
    const operatingSummary = listQualSummaries(db, experimentId).find((row) => row.step_number === 3);
    let operatingPoints: Array<{ screwSpeed: number; throughput: number }> = [];
    try {
      const parsed = JSON.parse(operatingSummary?.summary_json || "{}") as Record<string, unknown>;
      operatingPoints = (Array.isArray(parsed.accepted_operating_points) ? parsed.accepted_operating_points : [])
        .map((point: any) => ({ screwSpeed: Number(point?.screw_speed_rpm), throughput: Number(point?.throughput_kg_h) }))
        .filter((point) => Number.isFinite(point.screwSpeed) && Number.isFinite(point.throughput));
    } catch {}
    if (!operatingPoints.length) return res.status(400).json({ error: "Confirm accepted operating points in Step 3 before generating RTD runs" });
    const invalidCalibrationQ = throughputs.find((throughput) => throughput < calibrationRange!.min || throughput > calibrationRange!.max);
    if (invalidCalibrationQ != null) return res.status(400).json({ error: `Planned throughput ${invalidCalibrationQ} kg/h is outside the stable Step 2 calibration range ${calibrationRange.min.toFixed(2)}–${calibrationRange.max.toFixed(2)} kg/h` });
    for (const screwSpeed of screwSpeeds) {
      const atSpeed = operatingPoints.filter((point) => Math.abs(point.screwSpeed - screwSpeed) < 1e-6);
      if (!atSpeed.length) return res.status(400).json({ error: `Screw speed ${screwSpeed} rpm is not an accepted Step 3 operating point` });
      const minQ = Math.min(...atSpeed.map((point) => point.throughput));
      const maxQ = Math.max(...atSpeed.map((point) => point.throughput));
      const invalidQ = throughputs.find((throughput) => throughput < minQ || throughput > maxQ);
      if (invalidQ != null) return res.status(400).json({ error: `At ${screwSpeed} rpm, planned throughput ${invalidQ} kg/h is outside the Step 3 operating window ${minQ.toFixed(2)}–${maxQ.toFixed(2)} kg/h` });
    }
    const cells = screwSpeeds.flatMap((screwSpeed) => throughputs.map((throughput) => ({ screwSpeed, throughput })));
    let runs = listQualRuns(db, step.id).filter((run) => run.run_group === "default");
    while (runs.length < cells.length) {
      createQualRuns(db, experimentId, step.id, 1);
      runs = listQualRuns(db, step.id).filter((run) => run.run_group === "default");
    }
    const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
    const rpm = fields.get("screw_speed_rpm");
    const plannedThroughput = fields.get("planned_throughput_kg_h");
    const feederSpeed = fields.get("feeder_speed_rpm");
    if (!rpm || !plannedThroughput || !feederSpeed) return res.status(400).json({ error: "RTD matrix fields unavailable" });
    cells.forEach((cell, index) => {
      saveQualRunValue(db, runs[index].id, rpm.id, "number", cell.screwSpeed);
      saveQualRunValue(db, runs[index].id, plannedThroughput.id, "number", cell.throughput);
      saveQualRunValue(db, runs[index].id, feederSpeed.id, "number", Math.round(((cell.throughput - intercept) / slope) * 100) / 100);
    });
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, run_count: cells.length, feeder_calibration: { slope, intercept } });
  });

  router.post("/experiments/:id/qualification/:step/scale-up-recommendation", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) return res.status(403).json({ error: "Forbidden" });
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || stepNumber !== 10) return res.status(404).json({ error: "Scale-up study not found" });
    if (step.is_active !== 1) return res.status(409).json({ error: "Enable the scale-up study before calculating a recommendation" });
    if (rejectBlockedStep(res, step)) return;
    const number = (value: unknown) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    try {
      const recommendation = calculateExtrusionScaleUpRecommendation({
        sourceScrewDiameterMm: number(req.body?.source_screw_diameter_mm) ?? 0,
        targetScrewDiameterMm: number(req.body?.production_screw_diameter_mm) ?? 0,
        sourceThroughputKgH: number(req.body?.source_throughput_kg_h) ?? 0,
        sourceScrewSpeedRpm: number(req.body?.source_screw_speed_rpm) ?? 0,
        sourceBarrelTemperatureProfileC: req.body?.source_barrel_temperature_profile_c ? String(req.body.source_barrel_temperature_profile_c) : null,
        sourceMeltTemperatureC: number(req.body?.source_melt_temperature_c),
        sourceFreeVolumeL: number(req.body?.source_free_volume_l),
        targetFreeVolumeL: number(req.body?.production_free_volume_l),
        sourceMeltDensityKgL: number(req.body?.source_melt_density_kg_l),
        targetMeltDensityKgL: number(req.body?.production_melt_density_kg_l),
        sourceLengthToDiameter: number(req.body?.source_l_d),
        targetLengthToDiameter: number(req.body?.production_l_d),
        sourceScrewConfiguration: req.body?.source_screw_configuration ? String(req.body.source_screw_configuration) : null,
        targetScrewConfiguration: req.body?.production_screw_configuration ? String(req.body.production_screw_configuration) : null,
        sourceSmeKwhKg: number(req.body?.source_sme_kwh_kg),
        sourceTorqueNm: number(req.body?.source_torque_nm),
        sourceNoLoadTorqueNm: number(req.body?.source_no_load_torque_nm),
        targetNominalPowerKw: number(req.body?.production_nominal_power_kw),
        targetMaxTorqueNm: number(req.body?.production_max_torque_nm),
        targetNoLoadTorqueNm: number(req.body?.production_no_load_torque_nm),
        targetMechanicalEfficiency: number(req.body?.production_mechanical_efficiency),
        targetCenterDistanceCm: number(req.body?.production_center_distance_cm),
        targetTorqueDensityLimitNmCm3: number(req.body?.production_torque_density_limit_nm_cm3),
        materialHeatCapacityKjKgC: number(req.body?.material_heat_capacity_kj_kg_c),
        mechanicalToHeatFraction: number(req.body?.mechanical_to_heat_fraction),
        capacityExponent: number(req.body?.capacity_exponent),
        targetMaxScrewSpeedRpm: number(req.body?.production_max_screw_speed_rpm),
        targetMaxTipSpeedMs: number(req.body?.production_max_tip_speed_m_s),
        temperatureOffsetC: number(req.body?.temperature_offset_c),
        materialTemperatureMinC: number(req.body?.material_temp_min_c),
        materialTemperatureMaxC: number(req.body?.material_temp_max_c)
      });
      const settingsJson = getQualStepSettings(db, experimentId, stepNumber);
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(settingsJson || "{}") as Record<string, unknown>; } catch {}
      const savedRecommendation = { ...recommendation, savedAt: new Date().toISOString() };
      settings.scale_up_recommendation = savedRecommendation;
      upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
      return res.json({ ok: true, recommendation: savedRecommendation });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Could not calculate scale-up recommendation" });
    }
  });

  router.post("/experiments/:id/qualification/:step/optional-matrix", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) return res.status(403).json({ error: "Forbidden" });
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step || ![6, 7, 8, 9, 10].includes(stepNumber)) return res.status(404).json({ error: "Optional study not found" });
    if (step.is_active !== 1) return res.status(409).json({ error: "Enable this optional study before generating runs" });
    if (rejectBlockedStep(res, step)) return;
    const number = (value: unknown) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const levels = (value: unknown) => [...new Set(String(value || "").split(/[;,\s]+/).map((item) => Number(item.replace(",", "."))).filter((item) => Number.isFinite(item) && item > 0))].sort((a, b) => a - b);
    const orderedLevels = (value: unknown) => String(value || "").split(/[;,\s]+/)
      .map((item) => Number(item.replace(",", ".")))
      .filter((item) => Number.isFinite(item) && item > 0);
    const fields = new Map(listQualFields(db, step.id).map((field) => [field.code, field]));
    const write = (runId: number, values: Record<string, number>) => {
      Object.entries(values).forEach(([code, value]) => {
        const field = fields.get(code);
        if (field) saveQualRunValue(db, runId, field.id, "number", value);
      });
    };
    let cells: Array<Record<string, number>> = [];
    let runGroup = "default";
    if (stepNumber === 6) {
      const screw = number(req.body?.main_screw_speed_rpm);
      const matrix = number(req.body?.matrix_throughput_kg_h);
      const program = String(req.body?.side_feeding_program || "feeder_stability");
      const materialMode = req.body?.side_feeding_material_mode === "fiber" ? "fiber" : "particulate";
      if (!["feeder_stability", "material_incorporation"].includes(program)) return res.status(400).json({ error: "Choose the feeder-stability or material-incorporation program" });
      if (!screw || !matrix) return res.status(400).json({ error: "Enter main screw speed and matrix throughput" });
      runGroup = program === "feeder_stability" ? "feeder_stability" : materialMode === "fiber" ? "fiber_retention" : "particulate_filler";
      if (program === "feeder_stability") {
        const sideSpeeds = levels(req.body?.side_feeder_speed_levels_rpm);
        if (!sideSpeeds.length) return res.status(400).json({ error: "Enter at least one side-feeder speed for the stability sweep" });
        cells = sideSpeeds.map((side) => ({ main_screw_speed_rpm: screw, matrix_throughput_kg_h: matrix, side_feeder_speed_rpm: side }));
      } else {
        const fillerRates = orderedLevels(req.body?.filler_throughput_levels_kg_h);
        const incorporationSpeeds = orderedLevels(req.body?.incorporation_side_feeder_speed_levels_rpm);
        if (!fillerRates.length || !incorporationSpeeds.length || fillerRates.length !== incorporationSpeeds.length) {
          return res.status(400).json({ error: "Enter equal-length filler/fibre throughput and matching side-feeder speed lists" });
        }
        const initialFibreLength = materialMode === "fiber" ? number(req.body?.fiber_initial_length_mm) : null;
        if (materialMode === "fiber" && !initialFibreLength) return res.status(400).json({ error: "Enter the reference initial fibre length L0" });
        cells = fillerRates.map((filler, index) => ({
          main_screw_speed_rpm: screw,
          matrix_throughput_kg_h: matrix,
          side_feeder_speed_rpm: incorporationSpeeds[index],
          filler_throughput_kg_h: filler,
          ...(initialFibreLength ? { fiber_initial_length_mm: initialFibreLength } : {})
        }));
      }
    } else if (stepNumber === 7) {
      const program = String(req.body?.liquid_program || "liquid_pump_calibration");
      if (!["liquid_pump_calibration", "liquid_melt_injection"].includes(program)) {
        return res.status(400).json({ error: "Choose the pump-calibration or melt-injection program" });
      }
      runGroup = program;
      const liquidRates = levels(req.body?.liquid_target_throughput_levels_kg_h);
      if (!liquidRates.length) return res.status(400).json({ error: "Enter at least one target liquid throughput" });
      if (program === "liquid_pump_calibration") {
        cells = liquidRates.map((liquid) => ({ liquid_target_throughput_kg_h: liquid }));
      } else {
        const screw = number(req.body?.screw_speed_rpm);
        const polymer = number(req.body?.polymer_throughput_kg_h);
        const injectionZoneTemp = number(req.body?.injection_zone_temp_c);
        if (!screw || !polymer || !injectionZoneTemp) {
          return res.status(400).json({ error: "Enter screw speed, polymer throughput and injection-zone temperature" });
        }
        cells = liquidRates.map((liquid) => ({
          screw_speed_rpm: screw,
          polymer_throughput_kg_h: polymer,
          liquid_target_throughput_kg_h: liquid,
          liquid_throughput_kg_h: liquid
        }));
      }
    } else if (stepNumber === 8) {
      const program = String(req.body?.vacuum_program || "vacuum_calibration");
      if (!["vacuum_calibration", "vacuum_capacity"].includes(program)) {
        return res.status(400).json({ error: "Choose the vacuum-calibration or capacity-verification program" });
      }
      const initialVolatiles = number(req.body?.initial_volatiles_pct);
      const ventTemperature = number(req.body?.vent_zone_temp_c);
      if (!initialVolatiles || !ventTemperature) {
        return res.status(400).json({ error: "Enter the measured incoming volatile content and vent-zone temperature" });
      }
      runGroup = program;
      if (program === "vacuum_calibration") {
        const screw = number(req.body?.screw_speed_rpm);
        const throughput = number(req.body?.throughput_kg_h);
        const vacuumLevels = levels(req.body?.vacuum_target_pressure_levels_mbar);
        if (!screw || !throughput || !vacuumLevels.length) {
          return res.status(400).json({ error: "Enter screw speed, melt throughput and at least one target vacuum pressure" });
        }
        cells = vacuumLevels.map((vacuum) => ({
          screw_speed_rpm: screw,
          devol_target_throughput_kg_h: throughput,
          throughput_kg_h: throughput,
          vacuum_target_pressure_mbar: vacuum,
          initial_volatiles_pct: initialVolatiles
        }));
      } else {
        const selectedVacuum = number(req.body?.selected_vacuum_pressure_mbar);
        const throughputs = orderedLevels(req.body?.capacity_throughput_levels_kg_h);
        const screwSpeeds = orderedLevels(req.body?.capacity_screw_speed_levels_rpm);
        if (!selectedVacuum || !throughputs.length || throughputs.length !== screwSpeeds.length) {
          return res.status(400).json({ error: "Enter the selected vacuum and equal-length throughput and screw-speed lists" });
        }
        cells = throughputs.map((throughput, index) => ({
          screw_speed_rpm: screwSpeeds[index],
          devol_target_throughput_kg_h: throughput,
          throughput_kg_h: throughput,
          vacuum_target_pressure_mbar: selectedVacuum,
          initial_volatiles_pct: initialVolatiles
        }));
      }
    } else if (stepNumber === 9) {
      const temperatures = levels(req.body?.reaction_temp_levels_c);
      const screwSpeeds = orderedLevels(req.body?.reaction_screw_speed_levels_rpm);
      const throughputs = orderedLevels(req.body?.reaction_throughput_levels_kg_h);
      if (!temperatures.length || !screwSpeeds.length || screwSpeeds.length !== throughputs.length) {
        return res.status(400).json({ error: "Enter reaction temperatures and equal-length screw-speed/throughput pairs" });
      }
      runGroup = "reactive_extrusion";
      cells = temperatures.flatMap((temperature) => screwSpeeds.map((screwSpeed, index) => ({
        reaction_temp_c: temperature,
        screw_speed_rpm: screwSpeed,
        reaction_target_throughput_kg_h: throughputs[index],
        throughput_kg_h: throughputs[index]
      })));
    } else {
      const speeds = levels(req.body?.production_screw_speed_levels_rpm);
      const multipliers = levels(req.body?.production_throughput_multipliers);
      const sourceDiameter = number(req.body?.source_screw_diameter_mm);
      const productionDiameter = number(req.body?.production_screw_diameter_mm);
      const sourceThroughput = number(req.body?.source_throughput_kg_h);
      if (!speeds.length || !multipliers.length || !sourceDiameter || !productionDiameter || !sourceThroughput) {
        return res.status(400).json({ error: "Enter both screw diameters, source throughput, production screw speeds and throughput multipliers" });
      }
      const scaledTarget = sourceThroughput * Math.pow(productionDiameter / sourceDiameter, 3);
      cells = speeds.flatMap((speed) => multipliers.map((multiplier) => ({
        production_screw_speed_rpm: speed,
        production_throughput_kg_h: Math.round(scaledTarget * multiplier * 100) / 100
      })));
    }
    let runs = listQualRuns(db, step.id).filter((run) => run.run_group === runGroup);
    while (runs.length < cells.length) {
      createQualRuns(db, experimentId, step.id, 1, runGroup);
      runs = listQualRuns(db, step.id).filter((run) => run.run_group === runGroup);
    }
    cells.forEach((cell, index) => write(runs[index].id, cell));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true, run_count: cells.length });
  });

  router.post("/experiments/:id/qualification/:step/runs/:runId/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const runId = Number(req.params.runId);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const run = getQualRun(db, runId);
    if (!run || run.step_id !== step.id) return res.status(404).json({ error: "Run not found" });
    db.prepare("DELETE FROM qual_run_values WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM qual_runs WHERE id = ?").run(runId);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/cavities", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    if (stepNumber !== 2) return res.status(400).json({ error: "Not cavity step" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const fields = listQualFields(db, step.id);
    const nextIndex = getNextCavityIndex(fields);
    const created = addCavityFields(db, experimentId, step.id, nextIndex);
    const updatedFields = listQualFields(db, step.id);
    const weightField =
      updatedFields.find((field) => field.id === created.weightId) ||
      updatedFields.find((field) => field.code === `cavity${nextIndex}_weight_g`);
    const defectField =
      updatedFields.find((field) => field.id === created.defectId) ||
      updatedFields.find((field) => field.code === `cavity${nextIndex}_defect_tags`);
    const customFields = updatedFields
      .filter((field) => {
        const match = /^cavity\d+_(.+)$/.exec(field.code);
        if (!match) return false;
        const suffix = match[1];
        return suffix !== "weight_g" && suffix !== "defect_tags" && field.code.startsWith(`cavity${nextIndex}_`);
      })
      .map((field) => {
        const suffix = field.code.replace(`cavity${nextIndex}_`, "");
        const label = field.label.replace(/^Cavity\s+\d+\s+/i, "");
        return {
          suffix,
          id: field.id,
          label,
          unit: field.unit,
          field_type: field.field_type
        };
      });
    let tags: string[] = [];
    if (defectField?.allowed_values_json) {
      try {
        const parsed = JSON.parse(defectField.allowed_values_json);
        if (Array.isArray(parsed)) tags = parsed.map(String);
      } catch {
        tags = [];
      }
    }
    return res.json({
      index: nextIndex,
      weightFieldId: weightField?.id ?? created.weightId ?? null,
      defectFieldId: defectField?.id ?? created.defectId ?? null,
      tags,
      customFields
    });
  });

  router.post("/experiments/:id/qualification/:step/cavities/:index/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const index = Number(req.params.index);
    if (stepNumber !== 2) return res.status(400).json({ error: "Not cavity step" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const weightCode = `cavity${index}_weight_g`;
    const defectCode = `cavity${index}_defect_tags`;
    const fields = listQualFields(db, step.id).filter((field) => field.code === weightCode || field.code === defectCode);
    if (!fields.length) return res.json({ ok: true });
    const ids = fields.map((field) => field.id);
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(`DELETE FROM qual_run_values WHERE field_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM qual_fields WHERE id IN (${placeholders})`).run(...ids);
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/cavity-fields", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    if (stepNumber !== 2) return res.status(400).json({ error: "Not cavity step" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const rawCode = String(req.body.code || "").trim();
    const code = rawCode
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
    if (!code) return res.status(400).json({ error: "Code required" });
    const label = String(req.body.label || "").trim() || code;
    const unit = req.body.unit ? String(req.body.unit) : null;
    const rawType = String(req.body.field_type || "number");
    const fieldType = rawType === "text" || rawType === "boolean" ? rawType : "number";
    const fields = listQualFields(db, step.id);
    const cavityIndices = Array.from(
      new Set(
        fields
          .map((field) => {
            const match = /^cavity(\d+)_weight_g$/.exec(field.code);
            return match ? Number(match[1]) : null;
          })
          .filter((val): val is number => Number.isFinite(val))
      )
    ).sort((a, b) => a - b);
    const created: Array<{ index: number; id: number }> = [];
    cavityIndices.forEach((index) => {
      const fieldCode = `cavity${index}_${code}`;
      if (fields.some((field) => field.code === fieldCode)) return;
      const id = insertQualField(db, {
        experiment_id: experimentId,
        step_id: step.id,
        code: fieldCode,
        label: `Cavity ${index} ${label}`,
        field_type: fieldType,
        unit,
        group_label: "Measurements",
        required: 0,
        is_enabled: 1,
        is_derived: 0,
        allowed_values_json: null,
        derived_formula_code: null,
        param_def_id: registerCustomQualificationParam(experimentId, {
          code: fieldCode, label: `Cavity ${index} ${label}`, unit, field_type: fieldType,
          group_label: "Measurements", allowed_values_json: null
        })
      });
      created.push({ index, id });
    });
    const updatedFields = listQualFields(db, step.id);
    const fieldsForAll = cavityIndices
      .map((index) => {
        const fieldCode = `cavity${index}_${code}`;
        const field = updatedFields.find((item) => item.code === fieldCode);
        return field ? { index, id: field.id } : null;
      })
      .filter((item): item is { index: number; id: number } => item != null);
    return res.json({
      suffix: code,
      label,
      unit,
      field_type: fieldType,
      fields: fieldsForAll.length ? fieldsForAll : created
    });
  });

  router.post("/experiments/:id/qualification/:step/pressure-points", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    if (stepNumber !== 3) return res.status(400).json({ error: "Not pressure step" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const label = String(req.body.label || "").trim();
    if (!label) return res.status(400).json({ error: "Label required" });
    const fields = listQualFields(db, step.id);
    const indices = fields
      .map((field) => {
        const match = /^pressure_custom_(\d+)_bar$/.exec(field.code);
        return match ? Number(match[1]) : null;
      })
      .filter((val): val is number => Number.isFinite(val));
    const nextIndex = indices.length ? Math.max(...indices) + 1 : 1;
    const sectionCode = `custom_${nextIndex}`;
    const code = `pressure_${sectionCode}_bar`;
    const id = insertQualField(db, {
      experiment_id: experimentId,
      step_id: step.id,
      code,
      label,
      field_type: "number",
      unit: "bar",
      group_label: "Measurements",
      required: 0,
      is_enabled: 1,
      is_derived: 0,
      allowed_values_json: null,
      derived_formula_code: null,
      param_def_id: registerCustomQualificationParam(experimentId, {
        code, label, unit: "bar", field_type: "number", group_label: "Measurements", allowed_values_json: null
      })
    });
    const suffixes = Array.from(
      new Set(
        fields
          .map((field) => {
            const match = /^pressure_([^_]+)_(.+)$/.exec(field.code);
            if (!match) return null;
            const suffix = match[2];
            return suffix === "bar" ? null : suffix;
          })
          .filter((val): val is string => Boolean(val))
      )
    );
    const customFields: Array<{ suffix: string; id: number }> = [];
    suffixes.forEach((suffix) => {
      const fieldCode = `pressure_${sectionCode}_${suffix}`;
      if (fields.some((field) => field.code === fieldCode)) return;
      const customId = insertQualField(db, {
        experiment_id: experimentId,
        step_id: step.id,
        code: fieldCode,
        label: `${label} ${suffix.replace(/_/g, " ")}`,
        field_type: "number",
        unit: null,
        group_label: "Measurements",
        required: 0,
        is_enabled: 1,
        is_derived: 0,
        allowed_values_json: null,
        derived_formula_code: null,
        param_def_id: registerCustomQualificationParam(experimentId, {
          code: fieldCode, label: `${label} ${suffix.replace(/_/g, " ")}`, unit: null,
          field_type: "number", group_label: "Measurements", allowed_values_json: null
        })
      });
      customFields.push({ suffix, id: customId });
    });
    return res.json({ id, code, label, sectionCode, customFields });
  });

  router.post("/experiments/:id/qualification/:step/pressure-points/:fieldId/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const fieldId = Number(req.params.fieldId);
    if (stepNumber !== 3) return res.status(400).json({ error: "Not pressure step" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const field = listQualFields(db, step.id).find((f) => f.id === fieldId);
    if (!field || !/^pressure_custom_\d+_bar$/.test(field.code)) {
      return res.status(404).json({ error: "Point not found" });
    }
    const sectionMatch = /^pressure_(.+)_bar$/.exec(field.code);
    const sectionCode = sectionMatch ? sectionMatch[1] : null;
    if (sectionCode) {
      const sectionFields = listQualFields(db, step.id).filter((f) =>
        new RegExp(`^pressure_${sectionCode}_.+$`).test(f.code)
      );
      const ids = sectionFields.map((f) => f.id);
      const placeholders = ids.map(() => "?").join(", ");
      if (ids.length) {
        db.prepare(`DELETE FROM qual_run_values WHERE field_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM qual_fields WHERE id IN (${placeholders})`).run(...ids);
      }
    } else {
      db.prepare("DELETE FROM qual_run_values WHERE field_id = ?").run(fieldId);
      db.prepare("DELETE FROM qual_fields WHERE id = ?").run(fieldId);
    }
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/pressure-fields", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    if (stepNumber !== 3) return res.status(400).json({ error: "Not pressure step" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const rawCode = String(req.body.code || "").trim();
    const code = rawCode
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
    if (!code) return res.status(400).json({ error: "Code required" });
    const label = String(req.body.label || "").trim() || code;
    const unit = req.body.unit ? String(req.body.unit) : null;
    const rawType = String(req.body.field_type || "number");
    const fieldType = rawType === "text" || rawType === "boolean" ? rawType : "number";
    const fields = listQualFields(db, step.id);
    const sections = fields
      .filter((field) => /^pressure_.+_bar$/.test(field.code))
      .map((field) => {
        const match = /^pressure_(.+)_bar$/.exec(field.code);
        return match ? { code: match[1], label: field.label } : null;
      })
      .filter((val): val is { code: string; label: string } => Boolean(val));
    const created: Array<{ section: string; id: number }> = [];
    sections.forEach((section) => {
      const fieldCode = `pressure_${section.code}_${code}`;
      if (fields.some((field) => field.code === fieldCode)) return;
      const id = insertQualField(db, {
        experiment_id: experimentId,
        step_id: step.id,
        code: fieldCode,
        label: `${section.label} ${label}`,
        field_type: fieldType,
        unit,
        group_label: "Measurements",
        required: 0,
        is_enabled: 1,
        is_derived: 0,
        allowed_values_json: null,
        derived_formula_code: null,
        param_def_id: registerCustomQualificationParam(experimentId, {
          code: fieldCode, label: `${section.label} ${label}`, unit, field_type: fieldType,
          group_label: "Measurements", allowed_values_json: null
        })
      });
      created.push({ section: section.code, id });
    });
    return res.json({
      suffix: code,
      label,
      unit,
      field_type: fieldType,
      fields: created
    });
  });

  router.post("/experiments/:id/qualification/:step/pressure-fields/:suffix/update", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const suffix = String(req.params.suffix || "").trim();
    if (stepNumber !== 3 || !suffix) return res.status(400).json({ error: "Invalid request" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const label = String(req.body.label || "").trim();
    const unit = req.body.unit ? String(req.body.unit) : null;
    const rawType = String(req.body.field_type || "number");
    const fieldType = rawType === "text" || rawType === "boolean" ? rawType : "number";
    const fields = listQualFields(db, step.id).filter((field) =>
      new RegExp(`^pressure_.+_${suffix}$`).test(field.code)
    );
    fields.forEach((field) => {
      const match = /^pressure_([^_]+)_/.exec(field.code);
      const sectionCode = match ? match[1] : "";
      const sectionLabel =
        listQualFields(db, step.id).find((f) => f.code === `pressure_${sectionCode}_bar`)?.label ||
        sectionCode;
      updateQualField(db, field.id, {
        label: label ? `${sectionLabel} ${label}` : field.label,
        unit,
        field_type: fieldType
      });
    });
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/pressure-fields/:suffix/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const suffix = String(req.params.suffix || "").trim();
    if (stepNumber !== 3 || !suffix) return res.status(400).json({ error: "Invalid request" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const fields = listQualFields(db, step.id).filter((field) =>
      new RegExp(`^pressure_.+_${suffix}$`).test(field.code)
    );
    const ids = fields.map((field) => field.id);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      db.prepare(`DELETE FROM qual_run_values WHERE field_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM qual_fields WHERE id IN (${placeholders})`).run(...ids);
    }
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/fields", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const code = String(req.body.code || "").trim();
    const label = String(req.body.label || "").trim() || code;
    const fieldType = (req.body.field_type || "number") as
      | "number"
      | "text"
      | "tag"
      | "boolean";
    if (!code) return res.status(400).json({ error: "Code required" });
    const unit = req.body.unit ? String(req.body.unit) : null;
    const groupLabel = req.body.group_label ? String(req.body.group_label) : null;
    const allowedValuesJson = req.body.allowed_values_json
      ? String(req.body.allowed_values_json)
      : null;
    const paramDefId = registerCustomQualificationParam(experimentId, {
      code, label, unit, field_type: fieldType, group_label: groupLabel,
      allowed_values_json: allowedValuesJson
    });
    const id = insertQualField(db, {
      experiment_id: experimentId,
      step_id: step.id,
      code,
      label,
      field_type: fieldType,
      unit,
      group_label: groupLabel,
      required: req.body.required ? 1 : 0,
      is_enabled: 1,
      is_derived: 0,
      allowed_values_json: allowedValuesJson,
      derived_formula_code: null,
      param_def_id: paramDefId
    });
    return res.json({
      id,
      code,
      label,
      field_type: fieldType,
      unit: req.body.unit ? String(req.body.unit) : null,
      group_label: req.body.group_label ? String(req.body.group_label) : null,
      required: req.body.required ? 1 : 0,
      is_enabled: 1
    });
  });

  router.post("/experiments/:id/qualification/:step/fields/import", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const paramId = Number(req.body.param_id || 0);
    if (!Number.isFinite(paramId) || paramId <= 0) {
      return res.status(400).json({ error: "Param id required" });
    }
    const param = getParamDefinition(db, paramId);
    if (!param || param.scope !== "GLOBAL") {
      return res.status(404).json({ error: "Param not found" });
    }
    const existing = listQualFields(db, step.id).find((field) => field.code === param.code);
    if (existing) {
      return res.status(409).json({ error: "Field already exists in this step" });
    }
    const id = insertQualField(db, {
      experiment_id: experimentId,
      step_id: step.id,
      code: param.code,
      label: param.label,
      field_type: param.field_type,
      unit: param.unit,
      group_label: param.group_label,
      required: 0,
      is_enabled: 1,
      is_derived: 0,
      allowed_values_json: param.allowed_values_json,
      derived_formula_code: null,
      param_def_id: param.id
    });
    return res.json({
      id,
      code: param.code,
      label: param.label,
      field_type: param.field_type,
      unit: param.unit,
      group_label: param.group_label,
      required: 0,
      is_enabled: 1,
      allowed_values_json: param.allowed_values_json
    });
  });

  router.post("/experiments/:id/qualification/fields/:fieldId", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const fieldId = Number(req.params.fieldId);
    const updates: Record<string, unknown> = {
      code: String(req.body.code || "").trim(),
      label: String(req.body.label || "").trim(),
      unit: req.body.unit ? String(req.body.unit) : null,
      group_label: req.body.group_label ? String(req.body.group_label) : null,
      required: req.body.required ? 1 : 0,
      is_enabled: req.body.is_enabled ? 1 : 0,
      allowed_values_json: req.body.allowed_values_json
        ? String(req.body.allowed_values_json)
        : null
    };
    if (req.body.field_type) updates.field_type = req.body.field_type;
    updateQualField(db, fieldId, updates);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/fields/:fieldId/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(fieldId)) return res.status(400).json({ error: "Invalid field id" });
    const field = db
      .prepare(
        "SELECT id, experiment_id, step_id, code, is_derived FROM qual_fields WHERE id = ?"
      )
      .get(fieldId) as
      | { id: number; experiment_id: number; step_id: number; code: string; is_derived: number }
      | undefined;
    if (!field || field.experiment_id !== experimentId) {
      return res.status(404).json({ error: "Field not found" });
    }
    const protectedCodes = new Set([
      "inj_speed",
      "fill_time_s",
      "peak_inj_pressure_bar",
      "shear_rate_proxy",
      "rel_viscosity"
    ]);
    if (field.is_derived || protectedCodes.has(field.code)) {
      return res.status(400).json({ error: "Protected field" });
    }
    db.prepare("DELETE FROM qual_run_values WHERE field_id = ?").run(fieldId);
    db.prepare("DELETE FROM qual_fields WHERE id = ?").run(fieldId);
    const step = getQualStepById(db, field.step_id);
    if (step) {
      recomputeDerivedAndSummary(db, experimentId, field.step_id, step.step_number);
    }
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/cavity-fields/:suffix/update", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const suffix = String(req.params.suffix || "").trim();
    if (stepNumber !== 2 || !suffix) return res.status(400).json({ error: "Invalid request" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const label = String(req.body.label || "").trim();
    const unit = req.body.unit ? String(req.body.unit) : null;
    const rawType = String(req.body.field_type || "number");
    const fieldType = rawType === "text" || rawType === "boolean" ? rawType : "number";
    const fields = listQualFields(db, step.id).filter((field) =>
      new RegExp(`^cavity\\d+_${suffix}$`).test(field.code)
    );
    fields.forEach((field) => {
      const match = /^cavity(\d+)_/.exec(field.code);
      const idx = match ? match[1] : "";
      updateQualField(db, field.id, {
        label: label ? `Cavity ${idx} ${label}` : field.label,
        unit,
        field_type: fieldType
      });
    });
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/cavity-fields/:suffix/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const suffix = String(req.params.suffix || "").trim();
    if (stepNumber !== 2 || !suffix) return res.status(400).json({ error: "Invalid request" });
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const fields = listQualFields(db, step.id).filter((field) =>
      new RegExp(`^cavity\\d+_${suffix}$`).test(field.code)
    );
    const ids = fields.map((field) => field.id);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      db.prepare(`DELETE FROM qual_run_values WHERE field_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM qual_fields WHERE id IN (${placeholders})`).run(...ids);
    }
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/settings", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    let customFields: Array<{ id: string; code?: string; label: string; unit?: string; value?: number | string | null }> = [];
    if (req.body.custom_fields_json) {
      try {
        const parsed = JSON.parse(String(req.body.custom_fields_json));
        if (Array.isArray(parsed)) {
          customFields = parsed
            .map((item) => ({
              id: String(item.id || ""),
              code: item.code ? String(item.code) : undefined,
              label: String(item.label || ""),
              unit: item.unit ? String(item.unit) : undefined,
              value: (() => {
                if (item.value == null || item.value === "") return null;
                const raw = String(item.value).trim();
                if (!raw) return null;
                if (/%\d+:\d+%/.test(raw)) return raw;
                const num = Number(raw);
                return Number.isFinite(num) ? num : raw;
              })()
            }))
            .filter((item) => item.id && item.label);
        }
      } catch {
        customFields = [];
      }
    }
    const parseSettingValue = (value: unknown) => {
      if (value == null || value === "") return null;
      const raw = String(value).trim();
      if (!raw) return null;
      if (/%\d+:\d+%/.test(raw)) return raw;
      const normalized = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw;
      const num = Number(normalized);
      return Number.isFinite(num) ? num : raw;
    };
    const intensificationValue = parseSettingValue(req.body.intensification_coeff);
    const existingSettingsJson = getQualStepSettings(db, experimentId, stepNumber);
    let existingSettings: Record<string, unknown> = {};
    try { existingSettings = JSON.parse(existingSettingsJson || "{}") as Record<string, unknown>; } catch {}
    const wasSubmitted = (key: string) => Object.prototype.hasOwnProperty.call(req.body || {}, key);
    const submittedNumberOrSaved = (key: string) => wasSubmitted(key)
      ? parseSettingValue(req.body[key])
      : (existingSettings[key] ?? null);
    const submittedTextOrSaved = (key: string) => wasSubmitted(key)
      ? (req.body[key] ? String(req.body[key]).trim() : null)
      : (existingSettings[key] ?? null);
    const settings = {
      ...existingSettings,
      intensification_coeff: intensificationValue == null ? 1 : intensificationValue,
      melt_temp_c: parseSettingValue(req.body.melt_temp_c),
      recommended_inj_speed: parseSettingValue(req.body.recommended_inj_speed),
      inj_speed: parseSettingValue(req.body.inj_speed),
      target_weight_g: parseSettingValue(req.body.target_weight_g),
      machine_max_pressure_bar: parseSettingValue(req.body.machine_max_pressure_bar),
      hold_pressure_bar: parseSettingValue(req.body.hold_pressure_bar),
      gate_seal_time_s: parseSettingValue(req.body.gate_seal_time_s),
      cpw_temp_low_c: parseSettingValue(req.body.cpw_temp_low_c),
      cpw_temp_high_c: parseSettingValue(req.body.cpw_temp_high_c),
      cpw_hold_low_bar: parseSettingValue(req.body.cpw_hold_low_bar),
      cpw_hold_high_bar: parseSettingValue(req.body.cpw_hold_high_bar),
      cpw_gen_mode: req.body.cpw_gen_mode ? String(req.body.cpw_gen_mode) : null,
      cpw_temp_step_c: parseSettingValue(req.body.cpw_temp_step_c),
      cpw_hold_step_bar: parseSettingValue(req.body.cpw_hold_step_bar),
      target_screw_rpm: parseSettingValue(req.body.target_screw_rpm),
      feeder_max_throughput_kg_h: parseSettingValue(req.body.feeder_max_throughput_kg_h),
      material_bulk_density_kg_m3: parseSettingValue(req.body.material_bulk_density_kg_m3),
      feeder_temperature_c: parseSettingValue(req.body.feeder_temperature_c),
      feeder_screw_geometry: req.body.feeder_screw_geometry ? String(req.body.feeder_screw_geometry).trim() : null,
      screw_speed_levels_rpm: req.body.screw_speed_levels_rpm ? String(req.body.screw_speed_levels_rpm).trim() : null,
      throughput_levels_kg_h: req.body.throughput_levels_kg_h ? String(req.body.throughput_levels_kg_h).trim() : null,
      melt_pressure_limit_bar: parseSettingValue(req.body.melt_pressure_limit_bar),
      motor_torque_limit_nm: parseSettingValue(req.body.motor_torque_limit_nm),
      melt_density_kg_m3: parseSettingValue(req.body.melt_density_kg_m3),
      reference_viscosity_pa_s: parseSettingValue(req.body.reference_viscosity_pa_s),
      die_outlet_pressure_bar: parseSettingValue(req.body.die_outlet_pressure_bar),
      barrel_temperature_profile: req.body.barrel_temperature_profile ? String(req.body.barrel_temperature_profile).trim() : null,
      die_geometry: req.body.die_geometry ? String(req.body.die_geometry).trim() : null,
      rtd_screw_configuration: req.body.rtd_screw_configuration ? String(req.body.rtd_screw_configuration).trim() : null,
      rtd_barrel_temperature_profile: req.body.rtd_barrel_temperature_profile ? String(req.body.rtd_barrel_temperature_profile).trim() : null,
      rtd_free_volume_l: parseSettingValue(req.body.rtd_free_volume_l),
      rtd_melt_density_kg_l: parseSettingValue(req.body.rtd_melt_density_kg_l),
      rtd_tracer_type: req.body.rtd_tracer_type ? String(req.body.rtd_tracer_type).trim() : null,
      rtd_tracer_pulse_mass_g: parseSettingValue(req.body.rtd_tracer_pulse_mass_g),
      rtd_sampling_interval_s: parseSettingValue(req.body.rtd_sampling_interval_s),
      rtd_measurement_method: req.body.rtd_measurement_method ? String(req.body.rtd_measurement_method) : null,
      rtd_screw_speed_levels_rpm: req.body.rtd_screw_speed_levels_rpm ? String(req.body.rtd_screw_speed_levels_rpm).trim() : null,
      rtd_throughput_levels_kg_h: req.body.rtd_throughput_levels_kg_h ? String(req.body.rtd_throughput_levels_kg_h).trim() : null,
      side_feeding_main_screw_speed_rpm: submittedNumberOrSaved("side_feeding_main_screw_speed_rpm"),
      side_feeding_matrix_throughput_kg_h: submittedNumberOrSaved("side_feeding_matrix_throughput_kg_h"),
      side_feeding_injection_zone_temp_c: submittedNumberOrSaved("side_feeding_injection_zone_temp_c"),
      side_feeding_speed_levels_rpm: submittedTextOrSaved("side_feeding_speed_levels_rpm"),
      side_feeding_material_mode: wasSubmitted("side_feeding_material_mode") ? (req.body.side_feeding_material_mode === "fiber" ? "fiber" : "particulate") : (existingSettings.side_feeding_material_mode ?? "particulate"),
      side_feeding_filler_density_kg_m3: submittedNumberOrSaved("side_feeding_filler_density_kg_m3"),
      side_feeding_matrix_density_kg_m3: submittedNumberOrSaved("side_feeding_matrix_density_kg_m3"),
      side_feeding_max_packing_fraction: submittedNumberOrSaved("side_feeding_max_packing_fraction"),
      side_feeding_filler_throughput_levels_kg_h: submittedTextOrSaved("side_feeding_filler_throughput_levels_kg_h"),
      side_feeding_incorporation_speed_levels_rpm: submittedTextOrSaved("side_feeding_incorporation_speed_levels_rpm"),
      side_feeding_fiber_initial_length_mm: submittedNumberOrSaved("side_feeding_fiber_initial_length_mm"),
      liquid_calibration_target_throughput_levels_kg_h: submittedTextOrSaved("liquid_calibration_target_throughput_levels_kg_h"),
      liquid_injection_screw_speed_rpm: submittedNumberOrSaved("liquid_injection_screw_speed_rpm"),
      liquid_injection_polymer_throughput_kg_h: submittedNumberOrSaved("liquid_injection_polymer_throughput_kg_h"),
      liquid_injection_zone_temp_c: submittedNumberOrSaved("liquid_injection_zone_temp_c"),
      liquid_injection_baseline_torque_nm: submittedNumberOrSaved("liquid_injection_baseline_torque_nm"),
      liquid_injection_target_throughput_levels_kg_h: submittedTextOrSaved("liquid_injection_target_throughput_levels_kg_h"),
      devol_calibration_screw_speed_rpm: submittedNumberOrSaved("devol_calibration_screw_speed_rpm"),
      devol_calibration_throughput_kg_h: submittedNumberOrSaved("devol_calibration_throughput_kg_h"),
      devol_vent_zone_temp_c: submittedNumberOrSaved("devol_vent_zone_temp_c"),
      devol_initial_volatiles_pct: submittedNumberOrSaved("devol_initial_volatiles_pct"),
      devol_residual_volatiles_target_pct: submittedNumberOrSaved("devol_residual_volatiles_target_pct"),
      devol_vacuum_target_levels_mbar: submittedTextOrSaved("devol_vacuum_target_levels_mbar"),
      devol_selected_vacuum_pressure_mbar: submittedNumberOrSaved("devol_selected_vacuum_pressure_mbar"),
      devol_capacity_throughput_levels_kg_h: submittedTextOrSaved("devol_capacity_throughput_levels_kg_h"),
      devol_capacity_screw_speed_levels_rpm: submittedTextOrSaved("devol_capacity_screw_speed_levels_rpm"),
      reaction_temp_levels_c: submittedTextOrSaved("reaction_temp_levels_c"),
      reaction_screw_speed_levels_rpm: submittedTextOrSaved("reaction_screw_speed_levels_rpm"),
      reaction_throughput_levels_kg_h: submittedTextOrSaved("reaction_throughput_levels_kg_h"),
      reaction_dosing_route: wasSubmitted("reaction_dosing_route") ? String(req.body.reaction_dosing_route || "main_feeder") : (existingSettings.reaction_dosing_route ?? "main_feeder"),
      reaction_reagent_name: submittedTextOrSaved("reaction_reagent_name"),
      reaction_reagent_concentration_pct: submittedNumberOrSaved("reaction_reagent_concentration_pct"),
      reaction_chemical_analysis_method: wasSubmitted("reaction_chemical_analysis_method") ? String(req.body.reaction_chemical_analysis_method || "ftir") : (existingSettings.reaction_chemical_analysis_method ?? "ftir"),
      reaction_chemical_marker: submittedTextOrSaved("reaction_chemical_marker"),
      reaction_conversion_target_pct: submittedNumberOrSaved("reaction_conversion_target_pct"),
      reaction_mfr_min_g_10min: submittedNumberOrSaved("reaction_mfr_min_g_10min"),
      reaction_mfr_max_g_10min: submittedNumberOrSaved("reaction_mfr_max_g_10min"),
      reaction_thermal_limit_c: submittedNumberOrSaved("reaction_thermal_limit_c"),
      scale_up_source_screw_diameter_mm: parseSettingValue(req.body.scale_up_source_screw_diameter_mm),
      scale_up_production_screw_diameter_mm: parseSettingValue(req.body.scale_up_production_screw_diameter_mm),
      scale_up_source_throughput_kg_h: parseSettingValue(req.body.scale_up_source_throughput_kg_h),
      scale_up_source_sme_kwh_kg: parseSettingValue(req.body.scale_up_source_sme_kwh_kg),
      scale_up_source_screw_speed_rpm: parseSettingValue(req.body.scale_up_source_screw_speed_rpm),
      scale_up_source_residence_time_s: parseSettingValue(req.body.scale_up_source_residence_time_s),
      scale_up_target_residence_time_s: parseSettingValue(req.body.scale_up_target_residence_time_s),
      scale_up_source_barrel_temperature_profile_c: req.body.scale_up_source_barrel_temperature_profile_c ? String(req.body.scale_up_source_barrel_temperature_profile_c).trim() : null,
      scale_up_source_melt_temperature_c: parseSettingValue(req.body.scale_up_source_melt_temperature_c),
      scale_up_source_free_volume_l: parseSettingValue(req.body.scale_up_source_free_volume_l),
      scale_up_production_free_volume_l: parseSettingValue(req.body.scale_up_production_free_volume_l),
      scale_up_source_melt_density_kg_l: parseSettingValue(req.body.scale_up_source_melt_density_kg_l),
      scale_up_production_melt_density_kg_l: parseSettingValue(req.body.scale_up_production_melt_density_kg_l),
      scale_up_source_l_d: parseSettingValue(req.body.scale_up_source_l_d),
      scale_up_production_l_d: parseSettingValue(req.body.scale_up_production_l_d),
      scale_up_source_screw_configuration: req.body.scale_up_source_screw_configuration ? String(req.body.scale_up_source_screw_configuration).trim() : null,
      scale_up_production_screw_configuration: req.body.scale_up_production_screw_configuration ? String(req.body.scale_up_production_screw_configuration).trim() : null,
      scale_up_source_particle_size_d50_um: parseSettingValue(req.body.scale_up_source_particle_size_d50_um),
      scale_up_morphology_tolerance_pct: parseSettingValue(req.body.scale_up_morphology_tolerance_pct),
      scale_up_source_rtd_run_id: parseSettingValue(req.body.scale_up_source_rtd_run_id),
      scale_up_source_torque_nm: parseSettingValue(req.body.scale_up_source_torque_nm),
      scale_up_source_no_load_torque_nm: parseSettingValue(req.body.scale_up_source_no_load_torque_nm),
      scale_up_production_nominal_power_kw: parseSettingValue(req.body.scale_up_production_nominal_power_kw),
      scale_up_production_max_torque_nm: parseSettingValue(req.body.scale_up_production_max_torque_nm),
      scale_up_production_no_load_torque_nm: parseSettingValue(req.body.scale_up_production_no_load_torque_nm),
      scale_up_production_mechanical_efficiency: parseSettingValue(req.body.scale_up_production_mechanical_efficiency),
      scale_up_production_center_distance_cm: parseSettingValue(req.body.scale_up_production_center_distance_cm),
      scale_up_production_torque_density_limit_nm_cm3: parseSettingValue(req.body.scale_up_production_torque_density_limit_nm_cm3),
      scale_up_material_heat_capacity_kj_kg_c: parseSettingValue(req.body.scale_up_material_heat_capacity_kj_kg_c),
      scale_up_mechanical_to_heat_fraction: parseSettingValue(req.body.scale_up_mechanical_to_heat_fraction),
      scale_up_capacity_exponent: parseSettingValue(req.body.scale_up_capacity_exponent),
      scale_up_production_max_screw_speed_rpm: parseSettingValue(req.body.scale_up_production_max_screw_speed_rpm),
      scale_up_production_max_tip_speed_m_s: parseSettingValue(req.body.scale_up_production_max_tip_speed_m_s),
      scale_up_temperature_offset_c: parseSettingValue(req.body.scale_up_temperature_offset_c),
      scale_up_material_temp_min_c: parseSettingValue(req.body.scale_up_material_temp_min_c),
      scale_up_material_temp_max_c: parseSettingValue(req.body.scale_up_material_temp_max_c),
      scale_up_sme_parity_tolerance_pct: parseSettingValue(req.body.scale_up_sme_parity_tolerance_pct),
      scale_up_melt_temperature_tolerance_c: parseSettingValue(req.body.scale_up_melt_temperature_tolerance_c),
      scale_up_production_max_melt_pressure_bar: parseSettingValue(req.body.scale_up_production_max_melt_pressure_bar),
      scale_up_production_screw_speed_levels_rpm: req.body.scale_up_production_screw_speed_levels_rpm ? String(req.body.scale_up_production_screw_speed_levels_rpm).trim() : null,
      scale_up_production_throughput_multipliers: req.body.scale_up_production_throughput_multipliers ? String(req.body.scale_up_production_throughput_multipliers).trim() : null,
      custom_fields: customFields
    };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    const summaryRow = listQualSummaries(db, experimentId).find((item) => item.step_number === stepNumber);
    let summary: Record<string, unknown> = {};
    try { summary = JSON.parse(summaryRow?.summary_json || "{}"); } catch {}
    const wantsJson =
      req.xhr ||
      String(req.get("X-Requested-With") || "").toLowerCase() === "xmlhttprequest" ||
      String(req.get("Accept") || "").toLowerCase().includes("application/json");
    if (wantsJson) return res.json({ ok: true, summary });
    return res.redirect(`/experiments/${experimentId}/qualification/${stepNumber}`);
  });

  router.post("/param-library", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const code = String(req.body.code || "").trim();
    if (!code) return res.status(400).json({ error: "Code required" });
    const id = createParamDefinition(db, {
      scope: "GLOBAL",
      experiment_id: null,
      code,
      label: String(req.body.label || "").trim() || code,
      unit: req.body.unit ? String(req.body.unit) : null,
      field_kind: (req.body.field_kind || "INPUT") as "INPUT" | "OUTPUT",
      field_type: (req.body.field_type || "number") as "number" | "text" | "tag",
      group_label: req.body.group_label ? String(req.body.group_label) : null,
      allowed_values_json: req.body.allowed_values_json
        ? String(req.body.allowed_values_json)
        : null
    });
    return res.json({ id });
  });

  router.post("/param-library/:id", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    updateParamDefinition(db, id, {
      code: String(req.body.code || "").trim(),
      label: String(req.body.label || "").trim(),
      unit: req.body.unit ? String(req.body.unit) : null,
      field_kind: (req.body.field_kind || "INPUT") as "INPUT" | "OUTPUT",
      field_type: (req.body.field_type || "number") as "number" | "text" | "tag",
      group_label: req.body.group_label ? String(req.body.group_label) : null,
      allowed_values_json: req.body.allowed_values_json
        ? String(req.body.allowed_values_json)
        : null
    });
    return res.json({ ok: true });
  });

  router.post("/param-library/:id/delete", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    deleteParamDefinition(db, id);
    return res.json({ ok: true });
  });

  router.get("/param-library", (_req, res) => {
    if (!hasRole(_req, ["admin", "manager", "engineer"])) {
      return res.status(403).send("Forbidden");
    }
    const params = listGlobalParamDefinitions(db);
    res.render("param_library", { params, activeAdminPath: "/param-library" });
  });

  return router;
}
