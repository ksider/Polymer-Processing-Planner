import type { Db } from "../db.js";

type ReportConfigRow = {
  id: number;
  experiment_id: number;
  name: string;
  executors: string | null;
  description: string | null;
  author_user_id: number | null;
  responsible_user_id: number | null;
  due_at: string | null;
  submitted_for_signature_at: string | null;
  submitted_by_user_id: number | null;
  signature_due_at: string | null;
  signature_sla_days: number;
  report_number: string | null;
  report_type: "QUALIFICATION" | "DOE" | "COMBINED";
  template_code: string;
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
    & Partial<Pick<ReportConfigRow, "description" | "author_user_id" | "responsible_user_id" | "due_at" | "report_type" | "template_code">>
): number {
  const result = db
    .prepare(
      `
      INSERT INTO report_configs (experiment_id, name, executors, description, author_user_id, responsible_user_id, due_at, report_type, template_code, include_json, doe_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `
    )
    .run(
      data.experiment_id,
      data.name,
      data.executors,
      data.description ?? null,
      data.author_user_id ?? null,
      data.responsible_user_id ?? null,
      data.due_at ?? null,
      data.report_type ?? "COMBINED",
      data.template_code ?? "standard-combined",
      data.include_json,
      data.doe_ids_json
    );
  return Number(result.lastInsertRowid);
}

export function updateReportSetup(
  db: Db,
  reportId: number,
  data: Pick<ReportConfigRow, "name" | "description" | "author_user_id" | "responsible_user_id" | "due_at" | "report_number" | "report_type" | "template_code" | "signature_sla_days">
) {
  db.prepare(
    `UPDATE report_configs
     SET name = ?, description = ?, author_user_id = ?, responsible_user_id = ?, due_at = ?, report_number = ?, report_type = ?, template_code = ?, signature_sla_days = ?
     WHERE id = ?`
  ).run(
    data.name,
    data.description,
    data.author_user_id,
    data.responsible_user_id,
    data.due_at,
    data.report_number,
    data.report_type,
    data.template_code,
    data.signature_sla_days,
    reportId
  );
}

export function submitReportForSignature(db: Db, reportId: number, submittedByUserId: number, signatureDueAt: string) {
  db.prepare(
    `UPDATE report_configs
     SET submitted_for_signature_at = datetime('now'), submitted_by_user_id = ?, signature_due_at = ?
     WHERE id = ?`
  ).run(submittedByUserId, signatureDueAt, reportId);
}

export function clearReportSignatureSubmission(db: Db, reportId: number) {
  db.prepare(
    `UPDATE report_configs
     SET submitted_for_signature_at = NULL, submitted_by_user_id = NULL, signature_due_at = NULL
     WHERE id = ?`
  ).run(reportId);
}

export function updateReportNumber(db: Db, reportId: number, reportNumber: string) {
  db.prepare("UPDATE report_configs SET report_number = ? WHERE id = ?").run(reportNumber, reportId);
}

export function isReportNumberInUse(db: Db, reportNumber: string, exceptReportId: number) {
  const row = db.prepare(
    "SELECT 1 as ok FROM report_configs WHERE report_number = ? AND id <> ? LIMIT 1"
  ).get(reportNumber, exceptReportId) as { ok: number } | undefined;
  return Boolean(row?.ok);
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
