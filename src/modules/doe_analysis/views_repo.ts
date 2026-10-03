import type { Db } from "../../db.js";

export type DoeAnalysisView = {
  id: number;
  doeId: number;
  analysisId: number | null;
  analysisRevisionId: number | null;
  name: string;
  chartType: "interaction" | "surface" | "scatter";
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export function listDoeAnalysisViews(db: Db, doeId: number): DoeAnalysisView[] {
  return (db.prepare("SELECT * FROM doe_analysis_views WHERE doe_id = ? ORDER BY id DESC").all(doeId) as ViewRow[]).map(mapView);
}

export function createDoeAnalysisView(db: Db, input: Omit<DoeAnalysisView, "id" | "createdAt" | "updatedAt"> & { createdByUserId: number | null }): DoeAnalysisView {
  const timestamp = new Date().toISOString();
  const result = db.prepare(`INSERT INTO doe_analysis_views (doe_id, analysis_id, analysis_revision_id, name, chart_type, config_json, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.doeId, input.analysisId, input.analysisRevisionId, input.name, input.chartType, JSON.stringify(input.config), input.createdByUserId, timestamp, timestamp);
  return mapView(db.prepare("SELECT * FROM doe_analysis_views WHERE id = ?").get(Number(result.lastInsertRowid)) as ViewRow);
}

export function deleteDoeAnalysisView(db: Db, doeId: number, viewId: number): boolean {
  return db.prepare("DELETE FROM doe_analysis_views WHERE id = ? AND doe_id = ?").run(viewId, doeId).changes > 0;
}

type ViewRow = { id: number; doe_id: number; analysis_id: number | null; analysis_revision_id: number | null; name: string; chart_type: "interaction" | "surface" | "scatter"; config_json: string; created_at: string; updated_at: string };
function mapView(row: ViewRow): DoeAnalysisView { return { id: row.id, doeId: row.doe_id, analysisId: row.analysis_id, analysisRevisionId: row.analysis_revision_id, name: row.name, chartType: row.chart_type, config: JSON.parse(row.config_json) as Record<string, unknown>, createdAt: row.created_at, updatedAt: row.updated_at }; }
