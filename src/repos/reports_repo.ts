import type { Db } from "../db.js";

type ReportConfigRow = {
  id: number;
  experiment_id: number;
  name: string;
  executors: string | null;
  include_json: string | null;
  doe_ids_json: string | null;
  created_at: string;
  signed_at: string | null;
  signed_by_user_id: number | null;
};

export function listReportConfigs(db: Db, experimentId: number): ReportConfigRow[] {
  return db
    .prepare("SELECT * FROM report_configs WHERE experiment_id = ? ORDER BY id DESC")
    .all(experimentId) as ReportConfigRow[];
}

export function getReportConfig(db: Db, reportId: number): ReportConfigRow | null {
  const row = db.prepare("SELECT * FROM report_configs WHERE id = ?").get(reportId) as ReportConfigRow | undefined;
  return row ?? null;
}

export function createReportConfig(
  db: Db,
  data: Pick<ReportConfigRow, "experiment_id" | "name" | "executors" | "include_json" | "doe_ids_json">
): number {
  const result = db
    .prepare(
      `
      INSERT INTO report_configs (experiment_id, name, executors, include_json, doe_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      `
    )
    .run(
      data.experiment_id,
      data.name,
      data.executors,
      data.include_json,
      data.doe_ids_json
    );
  return Number(result.lastInsertRowid);
}

export function deleteReportConfig(db: Db, reportId: number) {
  db.prepare("DELETE FROM report_configs WHERE id = ?").run(reportId);
}

export function updateReportConfig(
  db: Db,
  reportId: number,
  data: Pick<ReportConfigRow, "name" | "executors" | "include_json" | "doe_ids_json">
) {
  db.prepare(
    `
    UPDATE report_configs
    SET name = ?, executors = ?, include_json = ?, doe_ids_json = ?
    WHERE id = ?
    `
  ).run(data.name, data.executors, data.include_json, data.doe_ids_json, reportId);
}

export function signReportConfig(db: Db, reportId: number, userId: number) {
  db.prepare(
    "UPDATE report_configs SET signed_at = datetime('now'), signed_by_user_id = ? WHERE id = ?"
  ).run(userId, reportId);
}

export function unsignReportConfig(db: Db, reportId: number) {
  db.prepare(
    "UPDATE report_configs SET signed_at = NULL, signed_by_user_id = NULL WHERE id = ?"
  ).run(reportId);
}

type ReportDocumentRow = {
  report_id: number;
  content_json: string;
  html_snapshot: string | null;
  content_md: string | null;
  editor_kind: string;
  schema_version: number;
  updated_at: string;
};

export function getReportDocument(db: Db, reportId: number): ReportDocumentRow | null {
  const row = db
    .prepare("SELECT * FROM report_documents WHERE report_id = ?")
    .get(reportId) as ReportDocumentRow | undefined;
  return row ?? null;
}

export function upsertReportDocument(
  db: Db,
  reportId: number,
  contentJson: string,
  htmlSnapshot: string | null,
  contentMd: string | null,
  editorKind = "tiptap",
  schemaVersion = 1
) {
  db.prepare(
    `
    INSERT INTO report_documents (report_id, content_json, html_snapshot, content_md, editor_kind, schema_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(report_id) DO UPDATE SET
      content_json = excluded.content_json,
      html_snapshot = excluded.html_snapshot,
      content_md = excluded.content_md,
      editor_kind = excluded.editor_kind,
      schema_version = excluded.schema_version,
      updated_at = excluded.updated_at
    `
  ).run(reportId, contentJson, htmlSnapshot, contentMd, editorKind, schemaVersion);
}

export type { ReportConfigRow };
