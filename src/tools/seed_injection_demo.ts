import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "../db.js";

const DEMO_MARKER = "demo-seed:injection-source-copy";

type IdMap = Map<number, number>;

function copyIdMap(db: Db, rows: any[], insert: (row: any) => number): IdMap {
  const map: IdMap = new Map();
  rows.forEach((row) => map.set(row.id, insert(row)));
  return map;
}

function clearDemoExperiment(db: Db, experimentId: number) {
  const doeIds = db.prepare("SELECT id FROM doe_studies WHERE experiment_id = ?").all(experimentId) as Array<{ id: number }>;
  const runIds = db.prepare("SELECT id FROM runs WHERE experiment_id = ?").all(experimentId) as Array<{ id: number }>;
  const qualRunIds = db.prepare("SELECT id FROM qual_runs WHERE experiment_id = ?").all(experimentId) as Array<{ id: number }>;
  const placeholders = (ids: Array<{ id: number }>) => ids.map(() => "?").join(",") || "NULL";
  if (runIds.length) {
    db.prepare(`DELETE FROM analysis_run_values WHERE run_id IN (${placeholders(runIds)})`).run(...runIds.map((row) => row.id));
    db.prepare(`DELETE FROM run_values WHERE run_id IN (${placeholders(runIds)})`).run(...runIds.map((row) => row.id));
    db.prepare(`DELETE FROM file_links WHERE entity_type = 'run' AND entity_id IN (${placeholders(runIds)})`).run(...runIds.map((row) => row.id));
  }
  if (qualRunIds.length) {
    db.prepare(`DELETE FROM file_links WHERE entity_type = 'qualification_run' AND entity_id IN (${placeholders(qualRunIds)})`).run(...qualRunIds.map((row) => row.id));
  }
  db.prepare("DELETE FROM file_links WHERE entity_type = 'experiment' AND entity_id = ?").run(experimentId);
  db.prepare("DELETE FROM report_configs WHERE experiment_id = ?").run(experimentId);
  db.prepare("DELETE FROM qual_step_settings WHERE experiment_id = ?").run(experimentId);
  db.prepare("DELETE FROM qual_step_summary WHERE experiment_id = ?").run(experimentId);
  db.prepare("DELETE FROM qual_steps WHERE experiment_id = ?").run(experimentId);
  db.prepare("DELETE FROM runs WHERE experiment_id = ?").run(experimentId);
  if (doeIds.length) {
    db.prepare(`DELETE FROM analysis_fields WHERE scope_type = 'DOE' AND scope_id IN (${placeholders(doeIds)})`).run(...doeIds.map((row) => row.id));
  }
  db.prepare("DELETE FROM design_metadata WHERE experiment_id = ?").run(experimentId);
  db.prepare("DELETE FROM param_configs WHERE experiment_id = ?").run(experimentId);
  db.prepare("DELETE FROM doe_studies WHERE experiment_id = ?").run(experimentId);
  db.prepare("DELETE FROM experiment_recipes WHERE experiment_id = ?").run(experimentId);
}

function cloneQualification(db: Db, sourceId: number, targetId: number) {
  const steps = db.prepare("SELECT * FROM qual_steps WHERE experiment_id = ? ORDER BY display_order, step_number, id").all(sourceId);
  const stepMap = copyIdMap(db, steps, (step) => Number(db.prepare(
    `INSERT INTO qual_steps (experiment_id, step_number, status, stage_code, display_order, title, is_blocked, blocked_reason, blocked_by_user_id, blocked_at, status_before_block, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(targetId, step.step_number, step.status, step.stage_code, step.display_order, step.title, step.is_blocked, step.blocked_reason, step.blocked_by_user_id, step.blocked_at, step.status_before_block, step.is_active).lastInsertRowid));
  const fields = db.prepare("SELECT * FROM qual_fields WHERE experiment_id = ? ORDER BY id").all(sourceId);
  const fieldMap = copyIdMap(db, fields, (field) => Number(db.prepare(
    `INSERT INTO qual_fields (experiment_id, step_id, code, label, field_type, unit, group_label, required, is_enabled, is_derived, allowed_values_json, derived_formula_code, param_def_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(targetId, stepMap.get(field.step_id), field.code, field.label, field.field_type, field.unit, field.group_label, field.required, field.is_enabled, field.is_derived, field.allowed_values_json, field.derived_formula_code, field.param_def_id).lastInsertRowid));
  const runs = db.prepare("SELECT * FROM qual_runs WHERE experiment_id = ? ORDER BY id").all(sourceId);
  const runMap = copyIdMap(db, runs, (run) => Number(db.prepare(
    `INSERT INTO qual_runs (experiment_id, step_id, run_order, run_code, done, exclude_from_analysis, due_at, run_group, performed_at, responsible_user_id, source_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(targetId, stepMap.get(run.step_id), run.run_order, run.run_code, run.done, run.exclude_from_analysis, run.due_at, run.run_group, run.performed_at, run.responsible_user_id).lastInsertRowid));
  runs.forEach((run: any) => {
    if (run.source_run_id && runMap.has(run.source_run_id)) {
      db.prepare("UPDATE qual_runs SET source_run_id = ? WHERE id = ?").run(runMap.get(run.source_run_id), runMap.get(run.id));
    }
  });
  const values = db.prepare(
    "SELECT value.* FROM qual_run_values value JOIN qual_runs run ON run.id = value.run_id WHERE run.experiment_id = ?"
  ).all(sourceId);
  values.forEach((value: any) => db.prepare(
    "INSERT INTO qual_run_values (run_id, field_id, value_real, value_text, value_tags_json) VALUES (?, ?, ?, ?, ?)"
  ).run(runMap.get(value.run_id), fieldMap.get(value.field_id), value.value_real, value.value_text, value.value_tags_json));
  const series = db.prepare("SELECT * FROM qual_run_series WHERE experiment_id = ? ORDER BY id").all(sourceId);
  const seriesMap = copyIdMap(db, series, (item) => Number(db.prepare(
    `INSERT INTO qual_run_series (experiment_id, step_id, run_id, series_code, contract_version, source_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(targetId, stepMap.get(item.step_id), runMap.get(item.run_id), item.series_code, item.contract_version, item.source_name, item.created_at, item.updated_at).lastInsertRowid));
  const points = db.prepare(
    "SELECT point.* FROM qual_run_series_points point JOIN qual_run_series series ON series.id = point.series_id WHERE series.experiment_id = ?"
  ).all(sourceId);
  points.forEach((point: any) => db.prepare(
    "INSERT INTO qual_run_series_points (series_id, point_order, x_value, y_value, extra_json) VALUES (?, ?, ?, ?, ?)"
  ).run(seriesMap.get(point.series_id), point.point_order, point.x_value, point.y_value, point.extra_json));
  db.prepare(
    `INSERT INTO qual_step_settings (experiment_id, step_number, settings_json, created_at)
     SELECT ?, step_number, settings_json, created_at FROM qual_step_settings WHERE experiment_id = ?`
  ).run(targetId, sourceId);
  const outputs = db.prepare("SELECT * FROM qual_step_outputs WHERE experiment_id = ? ORDER BY id").all(sourceId);
  outputs.forEach((item: any) => db.prepare(
    `INSERT INTO qual_step_outputs (experiment_id, step_id, output_group, output_code, value_real, value_text, updated_at, param_def_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(targetId, stepMap.get(item.step_id), item.output_group, item.output_code, item.value_real, item.value_text, item.updated_at, item.param_def_id));
  db.prepare(
    `INSERT INTO qual_step_summary (experiment_id, step_number, summary_json, created_at)
     SELECT ?, step_number, summary_json, created_at FROM qual_step_summary WHERE experiment_id = ?`
  ).run(targetId, sourceId);
}

function cloneDoe(db: Db, sourceId: number, targetId: number): IdMap {
  const sourceDoes = db.prepare("SELECT * FROM doe_studies WHERE experiment_id = ? ORDER BY id").all(sourceId);
  const doeMap = copyIdMap(db, sourceDoes, (doe) => Number(db.prepare(
    `INSERT INTO doe_studies (experiment_id, name, design_type, seed, center_points, max_runs, replicate_count, recipe_as_block, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(targetId, doe.name, doe.design_type, doe.seed, doe.center_points, doe.max_runs, doe.replicate_count, doe.recipe_as_block, doe.created_at).lastInsertRowid));
  sourceDoes.forEach((doe: any) => {
    const targetDoeId = doeMap.get(doe.id)!;
    db.prepare(
      `INSERT INTO param_configs (experiment_id, doe_id, param_def_id, active, mode, fixed_value_real, range_min_real, range_max_real, list_json, level_count)
       SELECT ?, ?, param_def_id, active, mode, fixed_value_real, range_min_real, range_max_real, list_json, level_count
       FROM param_configs WHERE experiment_id = ? AND doe_id = ?`
    ).run(targetId, targetDoeId, sourceId, doe.id);
    const metadata = db.prepare("SELECT json_blob FROM design_metadata WHERE experiment_id = ? AND doe_id = ?").get(sourceId, doe.id) as { json_blob: string } | undefined;
    if (metadata) db.prepare("INSERT INTO design_metadata (experiment_id, doe_id, json_blob) VALUES (?, ?, ?)").run(targetId, targetDoeId, metadata.json_blob);
  });
  const sourceRuns = db.prepare(
    `SELECT run.* FROM runs run JOIN doe_studies doe ON doe.id = run.doe_id
     WHERE doe.experiment_id = ? ORDER BY run.id`
  ).all(sourceId);
  const runMap = copyIdMap(db, sourceRuns, (run) => Number(db.prepare(
    `INSERT INTO runs (experiment_id, doe_id, run_order, run_code, recipe_id, replicate_key, replicate_index, owner_user_id, due_at, done, exclude_from_analysis, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(targetId, doeMap.get(run.doe_id), run.run_order, run.run_code, run.recipe_id, run.replicate_key, run.replicate_index, run.owner_user_id, run.due_at, run.done, run.exclude_from_analysis, run.created_at).lastInsertRowid));
  const runValues = db.prepare(
    `SELECT value.* FROM run_values value JOIN runs run ON run.id = value.run_id
     JOIN doe_studies doe ON doe.id = run.doe_id WHERE doe.experiment_id = ?`
  ).all(sourceId);
  runValues.forEach((value: any) => db.prepare(
    "INSERT INTO run_values (run_id, param_def_id, value_real, value_text, value_tags_json) VALUES (?, ?, ?, ?, ?)"
  ).run(runMap.get(value.run_id), value.param_def_id, value.value_real, value.value_text, value.value_tags_json));
  const sourceFields = db.prepare(
    "SELECT field.* FROM analysis_fields field JOIN doe_studies doe ON doe.id = field.scope_id WHERE field.scope_type = 'DOE' AND doe.experiment_id = ? ORDER BY field.id"
  ).all(sourceId);
  const fieldMap = copyIdMap(db, sourceFields, (field) => Number(db.prepare(
    `INSERT INTO analysis_fields (scope_type, scope_id, doe_id, code, label, field_type, unit, group_label, allowed_values_json, param_def_id, is_standard, is_active, created_at)
     VALUES ('DOE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(doeMap.get(field.scope_id), doeMap.get(field.scope_id), field.code, field.label, field.field_type, field.unit, field.group_label, field.allowed_values_json, field.param_def_id, field.is_standard, field.is_active, field.created_at).lastInsertRowid));
  const analysisValues = db.prepare(
    `SELECT value.* FROM analysis_run_values value JOIN runs run ON run.id = value.run_id
     JOIN doe_studies doe ON doe.id = run.doe_id WHERE doe.experiment_id = ?`
  ).all(sourceId);
  analysisValues.forEach((value: any) => db.prepare(
    "INSERT INTO analysis_run_values (run_id, field_id, value_real, value_text, value_tags_json) VALUES (?, ?, ?, ?, ?)"
  ).run(runMap.get(value.run_id), fieldMap.get(value.field_id), value.value_real, value.value_text, value.value_tags_json));
  const analyses = db.prepare(
    "SELECT analysis.* FROM doe_analyses analysis JOIN doe_studies doe ON doe.id = analysis.doe_id WHERE doe.experiment_id = ? ORDER BY analysis.id"
  ).all(sourceId);
  const analysisMap = copyIdMap(db, analyses, (analysis) => Number(db.prepare(
    `INSERT INTO doe_analyses (doe_id, name, description, specification_json, latest_successful_revision_id, created_by_user_id, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(doeMap.get(analysis.doe_id), analysis.name, analysis.description, analysis.specification_json, analysis.created_by_user_id, analysis.archived_at, analysis.created_at, analysis.updated_at).lastInsertRowid));
  const revisions = db.prepare(
    "SELECT revision.* FROM doe_analysis_revisions revision JOIN doe_analyses analysis ON analysis.id = revision.analysis_id JOIN doe_studies doe ON doe.id = analysis.doe_id WHERE doe.experiment_id = ? ORDER BY revision.id"
  ).all(sourceId);
  const revisionMap = copyIdMap(db, revisions, (revision) => Number(db.prepare(
    `INSERT INTO doe_analysis_revisions (analysis_id, status, dataset_revision, contract_version, request_id, engine_name, engine_version, specification_json, result_json, error_json, calculated_by_user_id, calculated_at, dataset_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(analysisMap.get(revision.analysis_id), revision.status, revision.dataset_revision, revision.contract_version, revision.request_id, revision.engine_name, revision.engine_version, revision.specification_json, revision.result_json, revision.error_json, revision.calculated_by_user_id, revision.calculated_at, revision.dataset_json).lastInsertRowid));
  analyses.forEach((analysis: any) => {
    const latest = analysis.latest_successful_revision_id ? revisionMap.get(analysis.latest_successful_revision_id) ?? null : null;
    db.prepare("UPDATE doe_analyses SET latest_successful_revision_id = ? WHERE id = ?").run(latest, analysisMap.get(analysis.id));
  });
  const events = db.prepare(
    "SELECT event.* FROM doe_analysis_events event JOIN doe_analyses analysis ON analysis.id = event.analysis_id JOIN doe_studies doe ON doe.id = analysis.doe_id WHERE doe.experiment_id = ? ORDER BY event.id"
  ).all(sourceId);
  events.forEach((event: any) => db.prepare(
    "INSERT INTO doe_analysis_events (analysis_id, action, details_json, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(analysisMap.get(event.analysis_id), event.action, event.details_json, event.actor_user_id, event.created_at));
  const jobs = db.prepare(
    "SELECT job.* FROM doe_analysis_jobs job JOIN doe_analyses analysis ON analysis.id = job.analysis_id JOIN doe_studies doe ON doe.id = analysis.doe_id WHERE doe.experiment_id = ? ORDER BY job.id"
  ).all(sourceId);
  jobs.forEach((job: any) => db.prepare(
    `INSERT INTO doe_analysis_jobs (analysis_id, doe_id, status, dataset_revision, request_id, specification_json, dataset_json, requested_by_user_id, revision_id, error_json, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(analysisMap.get(job.analysis_id), doeMap.get(job.doe_id), job.status, job.dataset_revision, job.request_id, job.specification_json, job.dataset_json, job.requested_by_user_id, job.revision_id ? revisionMap.get(job.revision_id) ?? null : null, job.error_json, job.created_at, job.started_at, job.finished_at));
  const interpretations = db.prepare(
    "SELECT item.* FROM doe_ai_interpretations item JOIN doe_studies doe ON doe.id = item.doe_id WHERE doe.experiment_id = ? ORDER BY item.id"
  ).all(sourceId);
  interpretations.forEach((item: any) => db.prepare(
    `INSERT INTO doe_ai_interpretations (doe_id, analysis_id, analysis_revision_id, dataset_revision, mode, provider_name, model, contract_version, prompt_version, response_json, response_sha256, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(doeMap.get(item.doe_id), analysisMap.get(item.analysis_id), revisionMap.get(item.analysis_revision_id), item.dataset_revision, item.mode, item.provider_name, item.model, item.contract_version, item.prompt_version, item.response_json, item.response_sha256, item.created_by_user_id, item.created_at));
  return doeMap;
}

function cloneReports(db: Db, sourceId: number, targetId: number, doeMap: IdMap) {
  const reports = db.prepare("SELECT * FROM report_configs WHERE experiment_id = ? ORDER BY id").all(sourceId);
  reports.forEach((report: any) => {
    let sourceDoeIds: number[] = [];
    try { sourceDoeIds = JSON.parse(report.doe_ids_json || "[]") as number[]; } catch { /* preserve empty scope */ }
    const targetDoeIds = sourceDoeIds.map((id) => doeMap.get(id)).filter((id): id is number => Boolean(id));
    const targetReportId = Number(db.prepare(
      `INSERT INTO report_configs (experiment_id, name, executors, include_json, doe_ids_json, created_at, signed_at, signed_by_user_id, description, author_user_id, responsible_user_id, due_at, submitted_for_signature_at, submitted_by_user_id, signature_due_at, signature_sla_days, report_number, report_type, template_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(targetId, report.name, report.executors, report.include_json, JSON.stringify(targetDoeIds), report.created_at, report.signed_at, report.signed_by_user_id, report.description, report.author_user_id, report.responsible_user_id, report.due_at, report.submitted_for_signature_at, report.submitted_by_user_id, report.signature_due_at, report.signature_sla_days, report.report_number, report.report_type, report.template_code).lastInsertRowid);
    const document = db.prepare("SELECT * FROM report_documents WHERE report_id = ?").get(report.id) as any;
    if (document) db.prepare(
      `INSERT INTO report_documents (report_id, content_json, html_snapshot, updated_at, content_md, editor_kind, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(targetReportId, document.content_json, document.html_snapshot, document.updated_at, document.content_md, document.editor_kind, document.schema_version);
  });
}

export function seedInjectionDemoFromSource(db: Db, sourceExperimentId: number) {
  const source = db.prepare("SELECT * FROM experiments WHERE id = ?").get(sourceExperimentId) as any;
  if (!source) throw new Error(`Injection source experiment ${sourceExperimentId} was not found.`);
  const target = db.prepare("SELECT * FROM experiments WHERE notes = ? ORDER BY id LIMIT 1").get(DEMO_MARKER) as any;
  const targetId = target?.id ?? Number(db.prepare(
    `INSERT INTO experiments (name, design_type, seed, created_at, notes, machine_id, process_id, owner_user_id, archived_at, center_points, max_runs, replicate_count, recipe_as_block)
     VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(`${source.name} · demo copy`, source.design_type, source.seed, DEMO_MARKER, source.machine_id, source.process_id, source.owner_user_id, source.center_points, source.max_runs, source.replicate_count, source.recipe_as_block).lastInsertRowid);
  clearDemoExperiment(db, targetId);
  db.prepare(
    `UPDATE experiments SET name = ?, design_type = ?, seed = ?, notes = ?, machine_id = ?, process_id = ?, owner_user_id = ?, archived_at = NULL, center_points = ?, max_runs = ?, replicate_count = ?, recipe_as_block = ? WHERE id = ?`
  ).run(`${source.name} · demo copy`, source.design_type, source.seed, DEMO_MARKER, source.machine_id, source.process_id, source.owner_user_id, source.center_points, source.max_runs, source.replicate_count, source.recipe_as_block, targetId);
  db.prepare("INSERT INTO experiment_recipes (experiment_id, recipe_id) SELECT ?, recipe_id FROM experiment_recipes WHERE experiment_id = ?").run(targetId, sourceExperimentId);
  cloneQualification(db, sourceExperimentId, targetId);
  const doeMap = cloneDoe(db, sourceExperimentId, targetId);
  cloneReports(db, sourceExperimentId, targetId, doeMap);
  return targetId;
}

function main() {
  const sourceArg = process.argv.find((arg) => arg.startsWith("--source-experiment="));
  const sourceExperimentId = Number(sourceArg?.split("=")[1]);
  if (!process.argv.includes("--upsert") || !Number.isInteger(sourceExperimentId) || sourceExperimentId <= 0) {
    console.log("Usage: node dist/tools/seed_injection_demo.js --upsert --source-experiment=10");
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  try {
    const targetId = db.transaction(() => seedInjectionDemoFromSource(db, sourceExperimentId))();
    console.log(`Injection demo copy is ready: source ${sourceExperimentId} → /injection/${targetId} (${DEMO_MARKER}).`);
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
