import type { Db } from "../db.js";

export type ProcessTypeRow = {
  id: number;
  code: string;
  name: string;
  created_at: string;
};

export type ProcessRow = {
  id: number;
  process_type_id: number;
  name: string;
  route_code: string | null;
  owner_user_id: number | null;
  show_on_home?: number;
  status: string;
  meta_json: string | null;
  created_at: string;
  process_type_code?: string;
  process_type_name?: string;
  experiment_count?: number;
};

export function listProcessTypes(db: Db): ProcessTypeRow[] {
  return db
    .prepare("SELECT * FROM process_types ORDER BY name, id")
    .all() as ProcessTypeRow[];
}

export function listProcesses(db: Db): ProcessRow[] {
  return db
    .prepare(
      `
      SELECT p.*, pt.code as process_type_code, pt.name as process_type_name
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      WHERE p.status = 'active'
      ORDER BY pt.name, p.name, p.id
      `
    )
    .all() as ProcessRow[];
}

export function listProcessesWithStats(db: Db): ProcessRow[] {
  return db
    .prepare(
      `
      SELECT
        p.*,
        pt.code as process_type_code,
        pt.name as process_type_name,
        COUNT(e.id) as experiment_count
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      LEFT JOIN experiments e ON e.process_id = p.id AND e.archived_at IS NULL
      WHERE p.status = 'active'
      GROUP BY p.id
      ORDER BY pt.name, p.name, p.id
      `
    )
    .all() as ProcessRow[];
}

export function listProcessesForOwner(db: Db, userId: number): ProcessRow[] {
  return db
    .prepare(
      `
      SELECT
        p.*,
        pt.code as process_type_code,
        pt.name as process_type_name,
        COUNT(e.id) as experiment_count
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      LEFT JOIN experiments e ON e.process_id = p.id AND e.archived_at IS NULL
      WHERE p.status = 'active' AND p.owner_user_id = ?
      GROUP BY p.id
      ORDER BY pt.name, p.name, p.id
      `
    )
    .all(userId) as ProcessRow[];
}

export function getProcessById(db: Db, processId: number): ProcessRow | null {
  const row = db
    .prepare(
      `
      SELECT p.*, pt.code as process_type_code, pt.name as process_type_name
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      WHERE p.id = ?
      LIMIT 1
      `
    )
    .get(processId) as ProcessRow | undefined;
  return row ?? null;
}

export function isProcessOwner(db: Db, processId: number, userId: number): boolean {
  const row = db
    .prepare("SELECT 1 as ok FROM processes WHERE id = ? AND owner_user_id = ? LIMIT 1")
    .get(processId, userId) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

export function normalizeRouteCode(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9_-]+/g, "");
  return normalized || null;
}

export function getProcessRouteCode(process: Pick<ProcessRow, "route_code" | "process_type_code"> | null | undefined): string | null {
  const fromProcess = normalizeRouteCode(process?.route_code);
  if (fromProcess) return fromProcess;
  const fromType = normalizeRouteCode(process?.process_type_code);
  return fromType || null;
}

export function getProcessByRouteCode(db: Db, routeCode: string): ProcessRow | null {
  const normalized = normalizeRouteCode(routeCode);
  if (!normalized) return null;
  const direct = db
    .prepare(
      `
      SELECT p.*, pt.code as process_type_code, pt.name as process_type_name
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      WHERE p.status = 'active' AND lower(p.route_code) = ?
      LIMIT 1
      `
    )
    .get(normalized) as ProcessRow | undefined;
  if (direct) return direct;
  const fallback = db
    .prepare(
      `
      SELECT p.*, pt.code as process_type_code, pt.name as process_type_name
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      WHERE p.status = 'active' AND lower(pt.code) = ?
      ORDER BY p.id
      LIMIT 1
      `
    )
    .get(normalized) as ProcessRow | undefined;
  return fallback ?? null;
}

export function updateProcessSettings(db: Db, processId: number, ownerUserId: number | null, routeCode: string | null): void {
  const normalizedRouteCode = normalizeRouteCode(routeCode);
  db.prepare("UPDATE processes SET owner_user_id = ?, route_code = ? WHERE id = ?").run(ownerUserId, normalizedRouteCode, processId);
}

export function updateProcessOwner(db: Db, processId: number, ownerUserId: number | null): void {
  db.prepare("UPDATE processes SET owner_user_id = ? WHERE id = ?").run(ownerUserId, processId);
}

export function updateProcessHomeVisibility(db: Db, processId: number, showOnHome: number): void {
  db.prepare("UPDATE processes SET show_on_home = ? WHERE id = ?").run(showOnHome ? 1 : 0, processId);
}

export function getDefaultProcessId(db: Db): number | null {
  const row = db
    .prepare(
      `
      SELECT p.id
      FROM processes p
      JOIN process_types pt ON pt.id = p.process_type_id
      WHERE pt.code = 'injection' AND p.name = 'Injection Default Process'
      LIMIT 1
      `
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}
