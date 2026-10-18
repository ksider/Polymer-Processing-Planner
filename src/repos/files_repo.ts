import type { Db } from "../db.js";

export type StoredFile = {
  id: number;
  owner_user_id: number;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  deleted_at: string | null;
};

export type StoredFileRegistryRow = StoredFile & {
  owner_name: string | null;
  owner_email: string;
  entity_type: string | null;
  entity_id: number | null;
  placement: string | null;
  links_summary?: string | null;
};

export type StoredFileUsageLink = {
  entity_type: string;
  entity_id: number;
  placement: string;
};

export function listStoredFileLinks(db: Db, fileId: number): StoredFileUsageLink[] {
  return db.prepare(
    `SELECT entity_type, entity_id, placement
     FROM file_links
     WHERE file_id = ?
     ORDER BY entity_type, entity_id, placement`
  ).all(fileId) as StoredFileUsageLink[];
}

export function createStoredFile(db: Db, input: Omit<StoredFile, "id" | "created_at" | "deleted_at">): number {
  const result = db.prepare(
    `INSERT INTO stored_files
     (owner_user_id, storage_key, original_name, mime_type, size_bytes, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.owner_user_id, input.storage_key, input.original_name, input.mime_type,
    input.size_bytes, input.sha256, new Date().toISOString()
  );
  return Number(result.lastInsertRowid);
}

export function linkStoredFile(db: Db, input: { fileId: number; entityType: string; entityId: number; placement: string }) {
  db.prepare(
    `INSERT OR IGNORE INTO file_links (file_id, entity_type, entity_id, placement, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(input.fileId, input.entityType, input.entityId, input.placement, new Date().toISOString());
}

export function unlinkStoredFilesForEntityPlacement(db: Db, input: { entityType: string; entityId: number; placement: string }) {
  db.prepare("DELETE FROM file_links WHERE entity_type = ? AND entity_id = ? AND placement = ?")
    .run(input.entityType, input.entityId, input.placement);
}

export function hasStoredFileLink(db: Db, fileId: number, entityType: string, placement: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS ok FROM file_links WHERE file_id = ? AND entity_type = ? AND placement = ? LIMIT 1"
  ).get(fileId, entityType, placement));
}

export function getStoredFile(db: Db, fileId: number): StoredFile | undefined {
  return db.prepare("SELECT * FROM stored_files WHERE id = ? AND deleted_at IS NULL").get(fileId) as StoredFile | undefined;
}

export function getStoredFileForOwner(db: Db, fileId: number, ownerUserId: number): StoredFile | undefined {
  return db.prepare(
    "SELECT * FROM stored_files WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL"
  ).get(fileId, ownerUserId) as StoredFile | undefined;
}

/** Returns the current source file attached to a specific entity slot.
 * A slot is deliberately single-valued: replacing an instrument export must
 * not leave a hidden second source attached to the same measurement. */
export function getStoredFileForEntityPlacement(
  db: Db,
  input: { entityType: string; entityId: number; placement: string }
): StoredFile | undefined {
  return db.prepare(
    `SELECT file.*
     FROM stored_files file
     JOIN file_links link ON link.file_id = file.id
     WHERE link.entity_type = ?
       AND link.entity_id = ?
       AND link.placement = ?
       AND file.deleted_at IS NULL
     ORDER BY datetime(link.created_at) DESC, link.id DESC
     LIMIT 1`
  ).get(input.entityType, input.entityId, input.placement) as StoredFile | undefined;
}

// The personal-library link records ownership and must not prevent the owner
// from deleting an otherwise unused upload. Every other link is an in-product
// use of the file and must be removed by that feature first.
export function listStoredFileUsageLinks(db: Db, fileId: number, ownerUserId: number): StoredFileUsageLink[] {
  return db.prepare(
    `SELECT entity_type, entity_id, placement
     FROM file_links
     WHERE file_id = ?
       AND NOT (entity_type = 'user' AND entity_id = ? AND placement = 'library')
     ORDER BY entity_type, entity_id, placement`
  ).all(fileId, ownerUserId) as StoredFileUsageLink[];
}

export function deleteStoredFileForOwnerIfUnused(db: Db, fileId: number, ownerUserId: number): { file?: StoredFile; usageLinks: StoredFileUsageLink[] } {
  return db.transaction(() => {
    const file = getStoredFileForOwner(db, fileId, ownerUserId);
    if (!file) return { usageLinks: [] };
    const usageLinks = listStoredFileUsageLinks(db, fileId, ownerUserId);
    if (usageLinks.length) return { usageLinks };
    db.prepare("DELETE FROM stored_files WHERE id = ? AND owner_user_id = ?").run(fileId, ownerUserId);
    return { file, usageLinks: [] };
  })();
}

export function listStoredFilesForOwner(db: Db, ownerUserId: number): StoredFileRegistryRow[] {
  return db.prepare(
    `SELECT file.*, user.name AS owner_name, user.email AS owner_email,
            link.entity_type, link.entity_id, link.placement
     FROM stored_files file
     JOIN users user ON user.id = file.owner_user_id
     LEFT JOIN file_links link ON link.file_id = file.id AND link.entity_type = 'user' AND link.entity_id = file.owner_user_id AND link.placement = 'library'
     WHERE file.owner_user_id = ? AND file.deleted_at IS NULL
     ORDER BY datetime(file.created_at) DESC, file.id DESC`
  ).all(ownerUserId) as StoredFileRegistryRow[];
}

export function listStoredFilesForAdmin(
  db: Db,
  filters: { ownerUserId?: number | null; entityType?: string | null; mimeGroup?: "image" | "document" | "other" | null; placement?: string | null; sort?: "newest" | "oldest" | "name" | "size" }
): StoredFileRegistryRow[] {
  const clauses = ["file.deleted_at IS NULL"];
  const values: Array<string | number> = [];
  if (filters.ownerUserId) {
    clauses.push("file.owner_user_id = ?");
    values.push(filters.ownerUserId);
  }
  if (filters.entityType) {
    clauses.push("link.entity_type = ?");
    values.push(filters.entityType);
  }
  if (filters.placement) {
    clauses.push("link.placement = ?");
    values.push(filters.placement);
  }
  if (filters.mimeGroup === "image") clauses.push("file.mime_type LIKE 'image/%'");
  if (filters.mimeGroup === "document") clauses.push("file.mime_type NOT LIKE 'image/%' AND file.mime_type <> 'application/octet-stream'");
  if (filters.mimeGroup === "other") clauses.push("file.mime_type = 'application/octet-stream'");
  const orderBy = filters.sort === "oldest"
    ? "datetime(file.created_at) ASC, file.id ASC"
    : filters.sort === "name"
      ? "lower(file.original_name) ASC, file.id DESC"
      : filters.sort === "size"
        ? "file.size_bytes DESC, file.id DESC"
        : "datetime(file.created_at) DESC, file.id DESC";
  return db.prepare(
    `SELECT file.*, user.name AS owner_name, user.email AS owner_email,
            MIN(link.entity_type) AS entity_type, MIN(link.entity_id) AS entity_id, MIN(link.placement) AS placement,
            GROUP_CONCAT(DISTINCT link.entity_type || ' #' || link.entity_id || ' · ' || link.placement) AS links_summary
     FROM stored_files file
     JOIN users user ON user.id = file.owner_user_id
     LEFT JOIN file_links link ON link.file_id = file.id
     WHERE ${clauses.join(" AND ")}
     GROUP BY file.id
     ORDER BY ${orderBy}
     LIMIT 500`
  ).all(...values) as StoredFileRegistryRow[];
}

export function listFileRegistryFilterValues(db: Db) {
  return {
    entityTypes: db.prepare("SELECT DISTINCT entity_type FROM file_links ORDER BY entity_type").all() as Array<{ entity_type: string }>,
    placements: db.prepare("SELECT DISTINCT placement FROM file_links ORDER BY placement").all() as Array<{ placement: string }>
  };
}
