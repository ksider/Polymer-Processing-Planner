import express from "express";
import type { Db } from "../db.js";
import {
  createMachine,
  deleteMachine,
  getMachine,
  listMachinesForLibrary,
  updateMachine
} from "../repos/machines_repo.js";
import {
  createMachineParam,
  deleteMachineParamsByIds,
  listMachineParams,
  updateMachineParam
} from "../repos/machine_params_repo.js";
import { getStoredFileForOwner, linkStoredFile, listStoredFilesForOwner, unlinkStoredFilesForEntityPlacement } from "../repos/files_repo.js";
import { storeUserFiles } from "../services/file_storage_service.js";
import { insertAudit } from "../repos/audit_repo.js";

type MachineSettings = Record<string, unknown>;

function parseNumber(value: unknown) {
  if (value == null) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  const normalized = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw;
  return parseFloat(normalized);
}

const baseMachineParamDefs = [
  { code: "clamp_force_kN", label: "Clamp force", unit: "kN" },
  { code: "clamp_force_t", label: "Clamp force", unit: "t" },
  { code: "intensification_ratio", label: "Intensification ratio", unit: null },
  { code: "injection_pressure_bar", label: "Injection pressure", unit: "bar" },
  { code: "screw_diameter_mm", label: "Screw diameter", unit: "mm" },
  { code: "tie_bar_distance_mm", label: "Tie bar distance", unit: "mm" },
  { code: "platen_size_mm", label: "Platen size", unit: "mm" },
  { code: "opening_stroke_mm", label: "Opening stroke", unit: "mm" },
  { code: "min_mold_height_mm", label: "Min mold height", unit: "mm" },
  { code: "max_mold_height_mm", label: "Max mold height", unit: "mm" },
  { code: "injection_volume_cm3", label: "Injection volume", unit: "cm3" },
  { code: "injection_weight_g", label: "Injection weight", unit: "g" },
  { code: "screw_speed_rpm", label: "Screw speed", unit: "rpm" },
  { code: "plasticizing_rate_g_s", label: "Plasticizing rate", unit: "g/s" }
] as const;
const baseMachineCodes = new Set<string>(baseMachineParamDefs.map((def) => def.code));

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildSettings(body: Record<string, unknown>): MachineSettings {
  const fields = [
    "clamp_force_kN",
    "clamp_force_t",
    "tie_bar_distance_mm",
    "platen_size_mm",
    "opening_stroke_mm",
    "min_mold_height_mm",
    "max_mold_height_mm",
    "screw_diameter_mm",
    "injection_volume_cm3",
    "injection_weight_g",
    "injection_pressure_bar",
    "intensification_ratio",
    "screw_speed_rpm",
    "plasticizing_rate_g_s"
  ];
  const settings: MachineSettings = {};
  for (const key of fields) {
    const raw = body[key];
    if (raw == null || raw === "") continue;
    const num = parseNumber(raw);
    settings[key] = Number.isFinite(num) ? num : String(raw).trim();
  }
  const customRaw = body.custom_fields_json ? String(body.custom_fields_json) : "";
  if (customRaw) {
    try {
      const parsed = JSON.parse(customRaw) as Array<{
        id?: string;
        code?: string;
        label?: string;
        unit?: string;
        value?: string | number | null;
      }>;
      if (Array.isArray(parsed)) {
        const customFields = parsed.flatMap((item, idx) => {
            const label = item.label ? String(item.label).trim() : "";
            if (!label) return [];
            const code = item.code ? String(item.code).trim() : slugify(label) || `field_${idx + 1}`;
            const unit = item.unit ? String(item.unit).trim() : "";
            const value = item.value != null ? item.value : "";
            return [{ id: item.id || "", code, label, unit, value }];
          });
        if (customFields.length) {
          settings.custom_fields = customFields;
        }
      }
    } catch {
      // ignore malformed custom fields
    }
  }
  return settings;
}

type MachineParamInput = {
  id?: string;
  code?: string;
  label?: string;
  unit?: string | null;
  value?: string | number | null;
};

function parseCustomParamInputs(raw: string): MachineParamInput[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as MachineParamInput[];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item, idx) => {
        const label = item.label ? String(item.label).trim() : "";
        if (!label) return [];
        const code = item.code ? String(item.code).trim() : slugify(label) || `field_${idx + 1}`;
        const unit = item.unit ? String(item.unit).trim() : null;
        const value = item.value != null ? item.value : "";
        return [{ id: item.id || "", code, label, unit, value }];
      });
  } catch {
    return [];
  }
}

function buildMachineParamsFromSettings(
  settings: MachineSettings,
  customParams: MachineParamInput[]
) {
  const baseParams = baseMachineParamDefs.map((def) => ({
    code: def.code,
    label: def.label,
    unit: def.unit,
    value: settings[def.code] != null ? String(settings[def.code]) : ""
  }));
  return [...baseParams, ...customParams];
}

function syncMachineParams(
  db: Db,
  machineId: number,
  params: MachineParamInput[]
) {
  const existing = listMachineParams(db, machineId);
  const existingIds = new Set(existing.map((p) => p.id));
  const existingByCode = new Map(
    existing.filter((p) => p.code).map((param) => [String(param.code), param])
  );
  const keepIds = new Set<number>();

  params.forEach((param) => {
    const label = param.label ? String(param.label).trim() : "";
    if (!label) return;
    const code = param.code ? String(param.code).trim() : null;
    const unit = param.unit ? String(param.unit).trim() : null;
    const valueText =
      param.value == null || param.value === "" ? null : String(param.value);
    const idNum = param.id ? Number(param.id) : NaN;
    if (Number.isFinite(idNum) && existingIds.has(idNum)) {
      updateMachineParam(db, idNum, { code, label, unit, value_text: valueText });
      keepIds.add(idNum);
      return;
    }
    if (code && existingByCode.has(code)) {
      const existingParam = existingByCode.get(code);
      if (existingParam) {
        updateMachineParam(db, existingParam.id, {
          code,
          label,
          unit,
          value_text: valueText
        });
        keepIds.add(existingParam.id);
        return;
      }
    }
    const newId = createMachineParam(db, {
      machine_id: machineId,
      code,
      label,
      unit,
      value_text: valueText
    });
    keepIds.add(newId);
  });

  const toDelete = existing
    .filter((param) => !keepIds.has(param.id))
    .map((param) => param.id);
  deleteMachineParamsByIds(db, toDelete);
}

function parseSettings(json: string | null): MachineSettings {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as MachineSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function createMachinesRouter(db: Db) {
  const router = express.Router();
  const canManageMachines = (req: express.Request) =>
    ["admin", "manager", "engineer"].includes(req.user?.role ?? "");
  const linkMachineImage = (machineId: number, fileId: number) => {
    unlinkStoredFilesForEntityPlacement(db, { entityType: "machine", entityId: machineId, placement: "cover_image" });
    linkStoredFile(db, { fileId, entityType: "machine", entityId: machineId, placement: "cover_image" });
    updateMachine(db, machineId, { image_url: `/files/${fileId}/download` });
  };
  const attachMachineImage = async (req: express.Request, machineId: number) => {
    const image = req.file as Express.Multer.File | undefined;
    if (!image) return null;
    if (!req.user?.id) throw new Error("A signed-in uploader is required.");
    const [stored] = await storeUserFiles(db, req.user.id, [image], { imagesOnly: true });
    linkMachineImage(machineId, stored.id);
    insertAudit(db, {
      actorUserId: req.user.id,
      action: "machine.image.upload",
      targetUserId: req.user.id,
      detailsJson: JSON.stringify({ machine_id: machineId, file_id: stored.id })
    });
    return `/files/${stored.id}/download`;
  };
  const selectMachineImage = (req: express.Request, machineId: number) => {
    const selectedFileId = Number(req.body.selected_file_id || 0);
    if (!Number.isInteger(selectedFileId) || selectedFileId <= 0) return null;
    if (!req.user?.id) throw new Error("A signed-in uploader is required.");
    const selected = getStoredFileForOwner(db, selectedFileId, req.user.id);
    if (!selected || !selected.mime_type.startsWith("image/")) throw new Error("Choose an image from your file library.");
    linkMachineImage(machineId, selected.id);
    insertAudit(db, {
      actorUserId: req.user.id,
      action: "machine.image.select",
      targetUserId: req.user.id,
      detailsJson: JSON.stringify({ machine_id: machineId, file_id: selected.id })
    });
    return `/files/${selected.id}/download`;
  };

  router.get("/machines", (req, res) => {
    const machines = listMachinesForLibrary(db);
    res.render("machine_library", { machines, canManageMachines: canManageMachines(req), activeAdminPath: "/machines" });
  });

  router.get("/machines/new", (req, res) => {
    if (!canManageMachines(req)) return res.status(403).send("Forbidden");
    res.render("machine_edit", {
      activeAdminPath: "/machines",
      machine: null,
      settings: {},
      machineParams: [],
      machineParamByCode: {},
      myImageFiles: req.user?.id ? listStoredFilesForOwner(db, req.user.id).filter((file) => file.mime_type.startsWith("image/")) : []
    });
  });

  router.get("/machines/:id", (req, res) => {
    if (!canManageMachines(req)) return res.status(403).send("Forbidden");
    const id = Number(req.params.id);
    const machine = getMachine(db, id);
    if (!machine) return res.status(404).send("Machine not found");
    const settings = parseSettings(machine.settings_json);
    let allMachineParams = listMachineParams(db, id);
    const missingBase = baseMachineParamDefs.some(
      (def) => !allMachineParams.some((param) => param.code === def.code)
    );
    if (missingBase) {
      const customParams = allMachineParams
        .filter((param) => !(param.code && baseMachineCodes.has(param.code)))
        .map((param) => ({
          id: String(param.id),
          code: param.code || undefined,
          label: param.label || "",
          unit: param.unit || null,
          value: param.value_text ?? ""
        }));
      const mergedParams = buildMachineParamsFromSettings(settings, customParams);
      syncMachineParams(db, id, mergedParams);
      allMachineParams = listMachineParams(db, id);
    }
    const machineParams = allMachineParams
      .filter((param) => !(param.code && baseMachineCodes.has(param.code)))
      .map((param) => ({
        id: String(param.id),
        code: param.code || "",
        label: param.label,
        unit: param.unit || "",
        value: param.value_text ?? ""
      }));
    const machineParamByCode = Object.fromEntries(
      allMachineParams
        .filter((param) => param.code)
        .map((param) => [String(param.code), param])
    );
    res.render("machine_edit", {
      activeAdminPath: "/machines",
      machine,
      settings,
      machineParams,
      machineParamByCode,
      myImageFiles: req.user?.id ? listStoredFilesForOwner(db, req.user.id).filter((file) => file.mime_type.startsWith("image/")) : []
    });
  });

  router.post("/machines", async (req, res) => {
    if (!canManageMachines(req)) return res.status(403).send("Forbidden");
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).send("Name required");
    const settings = buildSettings(req.body);
    const machineId = createMachine(db, {
      name,
      image_url: req.body.image_url ? String(req.body.image_url).trim() : null,
      vendor: req.body.vendor ? String(req.body.vendor).trim() : null,
      model: req.body.model ? String(req.body.model).trim() : null,
      settings_json: JSON.stringify(settings),
      notes: req.body.notes ? String(req.body.notes).trim() : null
    });
    try {
      if (req.file) await attachMachineImage(req, machineId);
      else selectMachineImage(req, machineId);
      const customRaw = req.body.custom_fields_json ? String(req.body.custom_fields_json) : "";
      const customParams = parseCustomParamInputs(customRaw);
      const mergedParams = buildMachineParamsFromSettings(settings, customParams);
      syncMachineParams(db, machineId, mergedParams);
    } catch (error) {
      deleteMachine(db, machineId);
      return res.status(400).send(error instanceof Error ? error.message : "Machine image could not be uploaded");
    }
    res.redirect("/machines");
  });

  router.post("/machines/:id", async (req, res) => {
    if (!canManageMachines(req)) return res.status(403).send("Forbidden");
    const id = Number(req.params.id);
    const machine = getMachine(db, id);
    if (!machine) return res.status(404).send("Machine not found");
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).send("Name required");
    const settings = buildSettings(req.body);
    updateMachine(db, id, {
      name,
      image_url: req.body.image_url ? String(req.body.image_url).trim() : machine.image_url,
      vendor: req.body.vendor ? String(req.body.vendor).trim() : null,
      model: req.body.model ? String(req.body.model).trim() : null,
      settings_json: JSON.stringify(settings),
      notes: req.body.notes ? String(req.body.notes).trim() : null
    });
    try {
      if (req.file) await attachMachineImage(req, id);
      else selectMachineImage(req, id);
      const customRaw = req.body.custom_fields_json ? String(req.body.custom_fields_json) : "";
      const customParams = parseCustomParamInputs(customRaw);
      const mergedParams = buildMachineParamsFromSettings(settings, customParams);
      syncMachineParams(db, id, mergedParams);
    } catch (error) {
      return res.status(400).send(error instanceof Error ? error.message : "Machine image could not be uploaded");
    }
    res.redirect("/machines");
  });

  router.post("/machines/:id/delete", (req, res) => {
    if (!canManageMachines(req)) return res.status(403).send("Forbidden");
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).send("Invalid id");
    deleteMachine(db, id);
    res.redirect("/machines");
  });

  return router;
}
