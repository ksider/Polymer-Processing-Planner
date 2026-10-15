import crypto from "crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db.js";
import { createStoredFile, linkStoredFile, type StoredFile } from "../repos/files_repo.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const allowedMimeTypes = new Set([
  "application/pdf", "text/plain", "text/csv", "application/json",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip", "application/octet-stream"
]);

export type UploadCandidate = { originalname: string; mimetype: string; size: number; buffer: Buffer };

export type UploadPolicy = { imagesOnly?: boolean };

export function storageRoot() {
  return path.resolve(process.env.FILE_STORAGE_PATH || path.join(process.cwd(), "storage", "uploads"));
}

export async function storeUserFiles(db: Db, ownerUserId: number, candidates: UploadCandidate[], policy: UploadPolicy = {}): Promise<StoredFile[]> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) throw new Error("A file owner is required.");
  if (!candidates.length) throw new Error("Choose at least one file.");
  const root = storageRoot();
  await fs.mkdir(root, { recursive: true });
  const normalizedCandidates = candidates.map((candidate) => normalizeCandidate(candidate, policy));
  const writtenPaths: string[] = [];
  try {
    const pending = [] as Array<{ storageKey: string; originalName: string; mimeType: string; buffer: Buffer; sha256: string }>;
    for (const normalized of normalizedCandidates) {
      const storageKey = `${crypto.randomUUID()}${normalized.extension}`;
      const destination = path.join(root, storageKey);
      await fs.writeFile(destination, normalized.buffer, { flag: "wx", mode: 0o600 });
      writtenPaths.push(destination);
      pending.push({ storageKey, originalName: normalized.originalName, mimeType: normalized.mimeType, buffer: normalized.buffer, sha256: crypto.createHash("sha256").update(normalized.buffer).digest("hex") });
    }
    const createdAt = new Date().toISOString();
    const stored = db.transaction(() => pending.map((item) => {
      const id = createStoredFile(db, {
        owner_user_id: ownerUserId, storage_key: item.storageKey, original_name: item.originalName,
        mime_type: item.mimeType, size_bytes: item.buffer.length, sha256: item.sha256
      });
      linkStoredFile(db, { fileId: id, entityType: "user", entityId: ownerUserId, placement: "library" });
      return { id, owner_user_id: ownerUserId, storage_key: item.storageKey, original_name: item.originalName, mime_type: item.mimeType, size_bytes: item.buffer.length, sha256: item.sha256, created_at: createdAt, deleted_at: null };
    }))();
    return stored;
  } catch (error) {
    await Promise.all(writtenPaths.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }
}

export function resolveStoredFilePath(file: Pick<StoredFile, "storage_key">) {
  const root = storageRoot();
  const destination = path.resolve(root, file.storage_key);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Invalid storage key.");
  return destination;
}

function normalizeCandidate(candidate: UploadCandidate, policy: UploadPolicy) {
  if (!candidate.buffer?.length) throw new Error("Empty files cannot be uploaded.");
  if (candidate.buffer.length > MAX_UPLOAD_BYTES) throw new Error("Each file must be 25 MB or smaller.");
  const originalName = path.basename(candidate.originalname || "upload").replace(/[\u0000-\u001f]/g, "_").slice(0, 180) || "upload";
  const mimeType = detectMimeType(candidate.buffer, String(candidate.mimetype || "").toLowerCase());
  if (!(mimeType.startsWith("image/") || allowedMimeTypes.has(mimeType))) throw new Error("This file type is not allowed.");
  if (policy.imagesOnly && !mimeType.startsWith("image/")) throw new Error("Choose an image file.");
  return { originalName, mimeType, buffer: candidate.buffer, extension: safeExtension(originalName, mimeType) };
}

function detectMimeType(buffer: Buffer, declared: string) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return declared || "application/octet-stream";
}

function safeExtension(originalName: string, mimeType: string) {
  const extension = path.extname(originalName).toLowerCase();
  if (/^\.[a-z0-9]{1,12}$/.test(extension)) return extension;
  return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf" } as Record<string, string>)[mimeType] ?? "";
}
