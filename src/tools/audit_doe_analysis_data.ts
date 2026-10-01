import Database from "better-sqlite3";
import path from "node:path";
import { buildDoeAnalysisDataset } from "../modules/doe_analysis/dataset_builder.js";
import type { DoeLegacyResponseAuditStatus } from "../modules/doe_analysis/types.js";

type DoeRow = {
  id: number;
  experiment_id: number;
  name: string;
  design_type: string;
};

const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || "im_doe.sqlite");
const summaryOnly = process.argv.includes("--summary");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

try {
  const studies = db
    .prepare("SELECT id, experiment_id, name, design_type FROM doe_studies ORDER BY experiment_id, id")
    .all() as DoeRow[];
  const report = studies.map((study) => {
    const dataset = buildDoeAnalysisDataset(db, study.experiment_id, study.id, {
      includeInactiveResponses: true
    });
    return {
      experimentId: study.experiment_id,
      doeId: study.id,
      doeName: study.name,
      designType: study.design_type,
      datasetRevision: dataset.datasetRevision,
      runCount: dataset.rows.length,
      responseCount: dataset.columns.filter((column) => column.role === "response").length,
      responseAudit: dataset.responseAudit.counts,
      warningCount: dataset.warnings.length,
      warnings: dataset.warnings
    };
  });

  const totals = emptyCounts();
  for (const study of report) {
    for (const status of Object.keys(totals) as DoeLegacyResponseAuditStatus[]) {
      totals[status] += study.responseAudit[status];
    }
  }

  const output: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    databasePath: dbPath,
    readOnly: true,
    studyCount: report.length,
    totals,
    hasConflicts: totals.conflict > 0 || totals.ambiguous_legacy > 0,
    hasLegacyOnlyValues: totals.legacy_only > 0
  };
  if (!summaryOnly) output.studies = report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  db.close();
}

function emptyCounts(): Record<DoeLegacyResponseAuditStatus, number> {
  return {
    measurement_only: 0,
    legacy_only: 0,
    equal: 0,
    conflict: 0,
    ambiguous_legacy: 0,
    missing: 0
  };
}
