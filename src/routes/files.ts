import express from "express";
import multer from "multer";
import fs from "node:fs";
import type { Db } from "../db.js";
import { insertAudit } from "../repos/audit_repo.js";
import { deleteStoredFileForOwnerIfUnused, getStoredFile, getStoredFileForOwner, hasStoredFileLink, listStoredFileUsageLinks } from "../repos/files_repo.js";
import { MAX_UPLOAD_BYTES, resolveStoredFilePath, storeUserFiles } from "../services/file_storage_service.js";

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10, fields: 10 }
});

// Equipment uses the same image policy but its form also contains the machine
// specification and custom-field payload. Keep that form's field limit local
// instead of weakening the generic multi-file upload endpoint.
const machineImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 50 }
});

// Multipart bodies must be parsed before the application-wide CSRF middleware
// so its ordinary hidden form token remains usable for upload forms.
export const fileUploadMiddleware = fileUpload.array("files", 10);
export const machineImageUploadMiddleware = machineImageUpload.single("machine_image");

function wantsJson(req: express.Request) {
  const accept = String(req.get("accept") || "").toLowerCase();
  return req.get("X-Requested-With") === "fetch" || accept.includes("application/json");
}

export function createFilesRouter(db: Db) {
  const router = express.Router();

  router.get("/me/files", (req, res) => {
    if (!req.user?.id) return res.redirect("/auth/login");
    const query = new URLSearchParams({ tab: "files" });
    if (typeof req.query.notice === "string") query.set("notice", req.query.notice);
    if (typeof req.query.error === "string") query.set("error", req.query.error);
    return res.redirect(`/me?${query.toString()}`);
  });

  router.post("/files/upload", async (req, res) => {
    if (!req.user?.id) return res.status(401).send("Unauthorized");
    const files = (req.files ?? []) as Express.Multer.File[];
    try {
      const stored = await storeUserFiles(db, req.user.id, files);
      insertAudit(db, {
        actorUserId: req.user.id,
        action: "file.upload",
        targetUserId: req.user.id,
        detailsJson: JSON.stringify({ file_ids: stored.map((file) => file.id), count: stored.length })
      });
      if (wantsJson(req)) return res.status(201).json({ files: stored.map((file) => ({ id: file.id, name: file.original_name, mimeType: file.mime_type, sizeBytes: file.size_bytes, downloadUrl: `/files/${file.id}/download` })) });
      return res.redirect(`/me?tab=files&notice=${encodeURIComponent(`${stored.length} file${stored.length === 1 ? "" : "s"} uploaded.`)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Files could not be uploaded.";
      if (wantsJson(req)) return res.status(400).json({ error: message });
      return res.redirect(`/me?tab=files&error=${encodeURIComponent(message)}`);
    }
  });

  router.get("/files/:id/download", (req, res) => {
    const fileId = Number(req.params.id);
    if (!Number.isInteger(fileId) || fileId <= 0) return res.status(404).send("Not found");
    const file = getStoredFile(db, fileId);
    if (!file) return res.status(404).send("Not found");
    const canReadMachineCover = hasStoredFileLink(db, file.id, "machine", "cover_image");
    if (req.user?.role !== "admin" && req.user?.id !== file.owner_user_id && !canReadMachineCover) return res.status(403).send("Forbidden");
    try {
      const filePath = resolveStoredFilePath(file);
      if (!fs.existsSync(filePath)) return res.status(404).send("Stored content is unavailable");
      res.setHeader("Cache-Control", "private, no-store");
      return res.type(file.mime_type).download(filePath, file.original_name);
    } catch {
      return res.status(404).send("Stored content is unavailable");
    }
  });

  router.get("/files/:id/preview", (req, res) => {
    const fileId = Number(req.params.id);
    if (!Number.isInteger(fileId) || fileId <= 0) return res.status(404).send("Not found");
    const file = getStoredFile(db, fileId);
    if (!file || !file.mime_type.startsWith("image/")) return res.status(404).send("Not found");
    const canReadMachineCover = hasStoredFileLink(db, file.id, "machine", "cover_image");
    if (req.user?.role !== "admin" && req.user?.id !== file.owner_user_id && !canReadMachineCover) return res.status(403).send("Forbidden");
    try {
      const filePath = resolveStoredFilePath(file);
      if (!fs.existsSync(filePath)) return res.status(404).send("Stored content is unavailable");
      res.setHeader("Cache-Control", "private, no-store");
      return res.type(file.mime_type).sendFile(filePath);
    } catch {
      return res.status(404).send("Stored content is unavailable");
    }
  });

  router.post("/me/files/:id/delete", async (req, res) => {
    if (!req.user?.id) return res.status(401).send("Unauthorized");
    const fileId = Number(req.params.id);
    if (!Number.isInteger(fileId) || fileId <= 0) return res.redirect("/me?tab=files&error=File%20not%20found.");
    const file = getStoredFileForOwner(db, fileId, req.user.id);
    if (!file) return res.redirect("/me?tab=files&error=File%20not%20found.");
    const usageLinks = listStoredFileUsageLinks(db, file.id, req.user.id);
    if (usageLinks.length) {
      const first = usageLinks[0];
      const message = `File is still attached to ${first.entity_type} #${first.entity_id} (${first.placement}). Remove that attachment first.`;
      return res.redirect(`/me?tab=files&error=${encodeURIComponent(message)}`);
    }
    try {
      const deleted = deleteStoredFileForOwnerIfUnused(db, file.id, req.user.id);
      if (!deleted.file) return res.redirect("/me?tab=files&error=File%20could%20not%20be%20deleted.");
      await fs.promises.rm(resolveStoredFilePath(deleted.file), { force: true });
      insertAudit(db, {
        actorUserId: req.user.id,
        action: "file.delete",
        targetUserId: req.user.id,
        detailsJson: JSON.stringify({ file_id: deleted.file.id, original_name: deleted.file.original_name })
      });
      return res.redirect(`/me?tab=files&notice=${encodeURIComponent("File deleted.")}`);
    } catch {
      return res.redirect(`/me?tab=files&error=${encodeURIComponent("File could not be deleted.")}`);
    }
  });

  return router;
}
