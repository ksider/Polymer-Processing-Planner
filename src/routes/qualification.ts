import express from "express";
import type { Db } from "../db.js";
import {
  ensureQualificationDefaults,
  getStepDefinitionForExperiment,
  recomputeDerivedAndSummary,
  saveQualRunValue,
  addCavityFields,
  getNextCavityIndex
} from "../services/qualification_service.js";
import {
  getQualRun,
  getQualStep,
  getQualStepById,
  listQualFields,
  listQualRuns,
  listQualRunValues,
  listQualSummaries,
  createQualRuns,
  getQualStepSettings,
  upsertQualStepSettings,
  insertQualField,
  updateQualField,
  updateQualRunFlags
} from "../repos/qual_repo.js";
import { getExperiment } from "../repos/experiments_repo.js";
import { getProcessById } from "../repos/processes_repo.js";
import {
  createParamDefinition,
  deleteParamDefinition,
  getParamDefinition,
  listGlobalParamDefinitions,
  updateParamDefinition
} from "../repos/params_repo.js";
import { getMachine } from "../repos/machines_repo.js";
import { listMachineParams } from "../repos/machine_params_repo.js";
import { ensureExperimentAccess } from "../middleware/experiment_access.js";
import { listUsers, findUserById } from "../repos/users_repo.js";
import { getEntityAssignment } from "../repos/entity_assignments_repo.js";
import { canAssignEntityResponsibility } from "../services/entity_assignment_service.js";

function hasRole(req: express.Request, roles: string[]) {
  return roles.includes(req.user?.role ?? "");
}

export function createQualificationRouter(db: Db) {
  const router = express.Router();

  router.use("/experiments/:id", ensureExperimentAccess(db));

  router.get("/experiments/:id/qualification", (req, res) => {
    const experimentId = Number(req.params.id);
    return res.redirect(`/experiments/${experimentId}#qualification`);
  });

  router.get("/experiments/:id/qualification/:step", (req, res) => {
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    ensureQualificationDefaults(db, experimentId);
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return res.status(404).send("Experiment not found");
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).send("Step not found");
    const fields = listQualFields(db, step.id);
    let runs = listQualRuns(db, step.id);
    if ((stepNumber === 2 || stepNumber === 3) && runs.length === 0) {
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
    const processTypeCode = (() => {
      if (!experiment.process_id) return "injection";
      const process = getProcessById(db, experiment.process_id);
      return String(process?.process_type_code || "injection").toLowerCase();
    })();
    const canAssignEntities = canAssignEntityResponsibility(req.user, experiment);
    const assignableUsers = canAssignEntities
      ? listUsers(db).filter((user) => user.status === "ACTIVE")
      : [];
    const assignment = getEntityAssignment(db, "qualification_step", step.id);
    const stepAssigneeId = assignment?.assignee_user_id ?? null;
    const stepAssignee = stepAssigneeId ? findUserById(db, stepAssigneeId) : null;
    const stepAssigneeLabel = stepAssignee?.name?.trim() || stepAssignee?.email?.trim() || null;
    const summaryRow = listQualSummaries(db, experimentId).find(
      (row) => row.step_number === stepNumber
    );
    if (processTypeCode === "compounding" || processTypeCode === "coating") {
      return res.render("qualification_step_compounding", {
        experimentId,
        step,
        stepDef: getStepDefinitionForExperiment(db, experimentId, stepNumber),
        fields,
        runs,
        globalParams,
        runValueMap,
        summaryJson: summaryRow?.summary_json ?? null,
        canAssignEntities,
        assignableUsers,
        stepAssigneeId,
        stepAssigneeLabel
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
      canAssignEntities,
      assignableUsers,
      stepAssigneeId,
      stepAssigneeLabel
    });
  });

  router.get("/qual-runs/:id", (req, res) => {
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

  router.post("/qual-runs/:id/value", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const { field_id, value } = req.body as { field_id: number; value: unknown };
    const run = getQualRun(db, runId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const step = getQualStepById(db, run.step_id);
    if (!step) return res.status(404).json({ error: "Step not found" });
    const field = listQualFields(db, run.step_id).find((f) => f.id === Number(field_id));
    if (!field) return res.status(404).json({ error: "Field not found" });
    if (field.is_derived) return res.status(400).json({ error: "Derived field" });

    saveQualRunValue(db, runId, field.id, field.field_type, value);
    recomputeDerivedAndSummary(db, run.experiment_id, run.step_id, step.step_number);

    return res.json({ ok: true });
  });

  router.post("/qual-runs/:id/flags", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer", "operator"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const runId = Number(req.params.id);
    const done = Number(req.body.done ? 1 : 0);
    const exclude = Number(req.body.exclude ? 1 : 0);
    updateQualRunFlags(db, runId, done, exclude);
    return res.json({ ok: true });
  });

  router.post("/experiments/:id/qualification/:step/runs", (req, res) => {
    if (!hasRole(req, ["admin", "manager", "engineer"])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const experimentId = Number(req.params.id);
    const stepNumber = Number(req.params.step);
    const step = getQualStep(db, experimentId, stepNumber);
    if (!step) return res.status(404).json({ error: "Step not found" });
    createQualRuns(db, experimentId, step.id, 1);
    const runs = listQualRuns(db, step.id);
    const run = runs[runs.length - 1];
    return res.json({ run });
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
        derived_formula_code: null
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
      derived_formula_code: null
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
        derived_formula_code: null
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
        derived_formula_code: null
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
    const id = insertQualField(db, {
      experiment_id: experimentId,
      step_id: step.id,
      code,
      label,
      field_type: fieldType,
      unit: req.body.unit ? String(req.body.unit) : null,
      group_label: req.body.group_label ? String(req.body.group_label) : null,
      required: req.body.required ? 1 : 0,
      is_enabled: 1,
      is_derived: 0,
      allowed_values_json: req.body.allowed_values_json
        ? String(req.body.allowed_values_json)
        : null,
      derived_formula_code: null
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
      derived_formula_code: null
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
    const settings = {
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
      custom_fields: customFields
    };
    upsertQualStepSettings(db, experimentId, stepNumber, JSON.stringify(settings));
    recomputeDerivedAndSummary(db, experimentId, step.id, stepNumber);
    return res.json({ ok: true });
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
    res.render("param_library", { params });
  });

  return router;
}
