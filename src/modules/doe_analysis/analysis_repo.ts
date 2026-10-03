import type { Db } from "../../db.js";
import type {
  DoeAnalysisSpecification,
  DoeAnalyticsFailure,
  DoeAnalyticsSuccess
} from "./analytics_contract.js";
import type { DoeAnalysisDataset } from "./types.js";

export type DoeAnalysisStoredState = "draft" | "calculated" | "stale" | "failed" | "archived";

export type DoeAnalysisRecord = {
  id: number;
  doeId: number;
  name: string;
  description: string | null;
  specification: DoeAnalysisSpecification;
  latestSuccessfulRevisionId: number | null;
  createdByUserId: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DoeAnalysisRevisionRecord = {
  id: number;
  analysisId: number;
  status: "SUCCEEDED" | "FAILED";
  datasetRevision: string;
  contractVersion: string;
  requestId: string;
  engineName: string | null;
  engineVersion: string | null;
  specification: DoeAnalysisSpecification;
  dataset: DoeAnalysisDataset | null;
  result: DoeAnalyticsSuccess | null;
  error: DoeAnalyticsFailure["error"] | null;
  calculatedByUserId: number | null;
  calculatedAt: string;
};

export type DoeAnalysisEventAction =
  | "CREATED"
  | "RENAMED"
  | "CALCULATION_QUEUED"
  | "CALCULATED"
  | "CALCULATION_FAILED"
  | "CALCULATION_CANCELLED"
  | "ARCHIVED"
  | "RESTORED";

export type DoeAnalysisEventRecord = {
  id: number;
  analysisId: number;
  action: DoeAnalysisEventAction;
  details: Record<string, unknown>;
  actorUserId: number | null;
  actorName: string | null;
  createdAt: string;
};

type AnalysisRow = {
  id: number;
  doe_id: number;
  name: string;
  description: string | null;
  specification_json: string;
  latest_successful_revision_id: number | null;
  created_by_user_id: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  id: number;
  analysis_id: number;
  status: "SUCCEEDED" | "FAILED";
  dataset_revision: string;
  contract_version: string;
  request_id: string;
  engine_name: string | null;
  engine_version: string | null;
  specification_json: string;
  dataset_json: string | null;
  result_json: string | null;
  error_json: string | null;
  calculated_by_user_id: number | null;
  calculated_at: string;
};

type EventRow = {
  id: number;
  analysis_id: number;
  action: DoeAnalysisEventAction;
  details_json: string | null;
  actor_user_id: number | null;
  actor_name: string | null;
  created_at: string;
};

export function listDoeAnalyses(db: Db, doeId: number): DoeAnalysisRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM doe_analyses
       WHERE doe_id = ?
       ORDER BY archived_at IS NOT NULL, updated_at DESC, id DESC`
    )
    .all(doeId) as AnalysisRow[];
  return rows.map(mapAnalysis);
}

export function getDoeAnalysis(db: Db, doeId: number, analysisId: number): DoeAnalysisRecord | null {
  const row = db
    .prepare("SELECT * FROM doe_analyses WHERE id = ? AND doe_id = ?")
    .get(analysisId, doeId) as AnalysisRow | undefined;
  return row ? mapAnalysis(row) : null;
}

export function createDoeAnalysis(
  db: Db,
  input: {
    doeId: number;
    name: string;
    description?: string | null;
    specification: DoeAnalysisSpecification;
    createdByUserId?: number | null;
  }
): DoeAnalysisRecord {
  const timestamp = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO doe_analyses
       (doe_id, name, description, specification_json, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.doeId,
      input.name,
      input.description?.trim() || null,
      JSON.stringify(input.specification),
      input.createdByUserId ?? null,
      timestamp,
      timestamp
    );
  const created = getDoeAnalysis(db, input.doeId, Number(result.lastInsertRowid));
  if (!created) throw new Error("Created DOE analysis could not be loaded");
  return created;
}

export function updateDoeAnalysisSpecification(
  db: Db,
  analysisId: number,
  specification: DoeAnalysisSpecification
): void {
  db.prepare(
    `UPDATE doe_analyses
     SET specification_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(specification), new Date().toISOString(), analysisId);
}

export function renameDoeAnalysis(db: Db, analysisId: number, name: string): void {
  db.prepare(
    `UPDATE doe_analyses
     SET name = ?, updated_at = ?
     WHERE id = ?`
  ).run(name.trim(), new Date().toISOString(), analysisId);
}

export function archiveDoeAnalysis(db: Db, analysisId: number): void {
  const timestamp = new Date().toISOString();
  db.prepare(
    `UPDATE doe_analyses
     SET archived_at = COALESCE(archived_at, ?), updated_at = ?
     WHERE id = ?`
  ).run(timestamp, timestamp, analysisId);
}

export function restoreDoeAnalysis(db: Db, analysisId: number): void {
  db.prepare(
    `UPDATE doe_analyses
     SET archived_at = NULL, updated_at = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), analysisId);
}

export function recordDoeAnalysisEvent(
  db: Db,
  input: {
    analysisId: number;
    action: DoeAnalysisEventAction;
    actorUserId?: number | null;
    details?: Record<string, unknown>;
  }
): void {
  db.prepare(
    `INSERT INTO doe_analysis_events
     (analysis_id, action, details_json, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    input.analysisId,
    input.action,
    input.details ? JSON.stringify(input.details) : null,
    input.actorUserId ?? null,
    new Date().toISOString()
  );
}

export function listDoeAnalysisEvents(
  db: Db,
  analysisId: number,
  limit = 20
): DoeAnalysisEventRecord[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = db.prepare(
    `SELECT e.*, u.name AS actor_name
     FROM doe_analysis_events e
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.analysis_id = ?
     ORDER BY e.id DESC
     LIMIT ?`
  ).all(analysisId, safeLimit) as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    analysisId: row.analysis_id,
    action: row.action,
    details: row.details_json ? JSON.parse(row.details_json) as Record<string, unknown> : {},
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    createdAt: row.created_at
  }));
}

export function listDoeAnalysisRevisions(
  db: Db,
  analysisId: number,
  limit = 20
): DoeAnalysisRevisionRecord[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = db
    .prepare(
      `SELECT * FROM doe_analysis_revisions
       WHERE analysis_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(analysisId, safeLimit) as RevisionRow[];
  return rows.map(mapRevision);
}

export function getDoeAnalysisRevision(
  db: Db,
  analysisId: number,
  revisionId: number
): DoeAnalysisRevisionRecord | null {
  return getRevision(db, analysisId, revisionId);
}

export function getLatestSuccessfulDoeAnalysisRevision(
  db: Db,
  analysis: DoeAnalysisRecord
): DoeAnalysisRevisionRecord | null {
  if (!analysis.latestSuccessfulRevisionId) return null;
  const row = db
    .prepare(
      `SELECT * FROM doe_analysis_revisions
       WHERE id = ? AND analysis_id = ? AND status = 'SUCCEEDED'`
    )
    .get(analysis.latestSuccessfulRevisionId, analysis.id) as RevisionRow | undefined;
  return row ? mapRevision(row) : null;
}

export function saveSuccessfulDoeAnalysisRevision(
  db: Db,
  analysis: DoeAnalysisRecord,
  result: DoeAnalyticsSuccess,
  calculatedByUserId?: number | null,
  dataset?: DoeAnalysisDataset | null
): DoeAnalysisRevisionRecord {
  const transaction = db.transaction(() => {
    const timestamp = new Date().toISOString();
    const insert = db
      .prepare(
        `INSERT INTO doe_analysis_revisions
         (analysis_id, status, dataset_revision, contract_version, request_id,
          engine_name, engine_version, specification_json, dataset_json, result_json, error_json,
          calculated_by_user_id, calculated_at)
         VALUES (?, 'SUCCEEDED', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        analysis.id,
        result.datasetRevision,
        result.contractVersion,
        result.requestId,
        result.engine.name,
        result.engine.version,
        JSON.stringify(result.specification),
        dataset ? boundedJson(dataset) : null,
        boundedJson(result),
        calculatedByUserId ?? null,
        timestamp
      );
    const revisionId = Number(insert.lastInsertRowid);
    db.prepare(
      `UPDATE doe_analyses
       SET latest_successful_revision_id = ?, specification_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(revisionId, JSON.stringify(result.specification), timestamp, analysis.id);
    return revisionId;
  });
  const revisionId = transaction();
  const revision = getRevision(db, analysis.id, revisionId);
  if (!revision) throw new Error("Saved DOE analysis revision could not be loaded");
  return revision;
}

export function saveFailedDoeAnalysisRevision(
  db: Db,
  analysis: DoeAnalysisRecord,
  input: {
    datasetRevision: string;
    contractVersion: string;
    requestId: string;
    specification: DoeAnalysisSpecification;
    error: DoeAnalyticsFailure["error"];
    calculatedByUserId?: number | null;
  }
): DoeAnalysisRevisionRecord {
  const timestamp = new Date().toISOString();
  const insert = db
    .prepare(
      `INSERT INTO doe_analysis_revisions
       (analysis_id, status, dataset_revision, contract_version, request_id,
        engine_name, engine_version, specification_json, result_json, error_json,
        calculated_by_user_id, calculated_at)
       VALUES (?, 'FAILED', ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)`
    )
    .run(
      analysis.id,
      input.datasetRevision,
      input.contractVersion,
      input.requestId,
      JSON.stringify(input.specification),
      JSON.stringify(input.error),
      input.calculatedByUserId ?? null,
      timestamp
    );
  db.prepare("UPDATE doe_analyses SET updated_at = ? WHERE id = ?").run(timestamp, analysis.id);
  const revision = getRevision(db, analysis.id, Number(insert.lastInsertRowid));
  if (!revision) throw new Error("Failed DOE analysis revision could not be loaded");
  return revision;
}

export function resolveDoeAnalysisState(
  db: Db,
  analysis: DoeAnalysisRecord,
  currentDatasetRevision: string
): DoeAnalysisStoredState {
  if (analysis.archivedAt) return "archived";
  const revisions = listDoeAnalysisRevisions(db, analysis.id, 1);
  if (!revisions.length) return "draft";
  if (revisions[0].status === "FAILED") return "failed";
  const successful = getLatestSuccessfulDoeAnalysisRevision(db, analysis);
  if (!successful) return "draft";
  return successful.datasetRevision === currentDatasetRevision ? "calculated" : "stale";
}

function getRevision(db: Db, analysisId: number, revisionId: number): DoeAnalysisRevisionRecord | null {
  const row = db
    .prepare("SELECT * FROM doe_analysis_revisions WHERE id = ? AND analysis_id = ?")
    .get(revisionId, analysisId) as RevisionRow | undefined;
  return row ? mapRevision(row) : null;
}

function mapAnalysis(row: AnalysisRow): DoeAnalysisRecord {
  return {
    id: row.id,
    doeId: row.doe_id,
    name: row.name,
    description: row.description,
    specification: JSON.parse(row.specification_json) as DoeAnalysisSpecification,
    latestSuccessfulRevisionId: row.latest_successful_revision_id,
    createdByUserId: row.created_by_user_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRevision(row: RevisionRow): DoeAnalysisRevisionRecord {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    status: row.status,
    datasetRevision: row.dataset_revision,
    contractVersion: row.contract_version,
    requestId: row.request_id,
    engineName: row.engine_name,
    engineVersion: row.engine_version,
    specification: JSON.parse(row.specification_json) as DoeAnalysisSpecification,
    dataset: row.dataset_json ? JSON.parse(row.dataset_json) as DoeAnalysisDataset : null,
    result: row.result_json ? JSON.parse(row.result_json) as DoeAnalyticsSuccess : null,
    error: row.error_json ? JSON.parse(row.error_json) as DoeAnalyticsFailure["error"] : null,
    calculatedByUserId: row.calculated_by_user_id,
    calculatedAt: row.calculated_at
  };
}

function boundedJson(result: unknown): string {
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, "utf8") > 5 * 1024 * 1024) {
    throw new Error("DOE analysis result exceeds the 5 MB persistence limit");
  }
  return json;
}
