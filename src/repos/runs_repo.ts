import type { Db } from "../db.js";

export type Run = {
  id: number;
  experiment_id: number;
  doe_id: number | null;
  run_order: number;
  run_code: string;
  recipe_id: number | null;
  replicate_key: string | null;
  replicate_index: number | null;
  owner_user_id: number | null;
  due_at: string | null;
  done: number;
  exclude_from_analysis: number;
  created_at: string;
};

export type RunValue = {
  run_id: number;
  param_def_id: number;
  value_real: number | null;
  value_text: string | null;
  value_tags_json: string | null;
};

export function listRuns(db: Db, doeId: number): Run[] {
  return db
    .prepare("SELECT * FROM runs WHERE doe_id = ? ORDER BY run_order")
    .all(doeId) as Run[];
}

export function deleteRunsForExperiment(db: Db, doeId: number) {
  const delValues = db.prepare(
    "DELETE FROM run_values WHERE run_id IN (SELECT id FROM runs WHERE doe_id = ?)"
  );
  const delRuns = db.prepare("DELETE FROM runs WHERE doe_id = ?");
  const tx = db.transaction(() => {
    delValues.run(doeId);
    delRuns.run(doeId);
  });
  tx();
}

export function insertRuns(
  db: Db,
  experimentId: number,
  doeId: number,
  runs: Array<
    Omit<Run, "id" | "created_at" | "experiment_id" | "doe_id" | "owner_user_id" | "due_at"> & {
      owner_user_id?: number | null;
      due_at?: string | null;
    }
  >,
  values: Array<RunValue>
) {
  const insertRun = db.prepare(
    `INSERT INTO runs
     (experiment_id, doe_id, run_order, run_code, recipe_id, replicate_key, replicate_index, owner_user_id, due_at, done, exclude_from_analysis, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertValue = db.prepare(
    "INSERT INTO run_values (run_id, param_def_id, value_real, value_text, value_tags_json) VALUES (?, ?, ?, ?, ?)"
  );
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const run of runs) {
      const res = insertRun.run(
        experimentId,
        doeId,
        run.run_order,
        run.run_code,
        run.recipe_id,
        run.replicate_key,
        run.replicate_index,
        run.owner_user_id ?? null,
        run.due_at ?? null,
        run.done,
        run.exclude_from_analysis,
        now
      );
      const runId = Number(res.lastInsertRowid);
      const runValues = values.filter((v) => v.run_id === run.run_order);
      for (const value of runValues) {
        insertValue.run(
          runId,
          value.param_def_id,
          value.value_real,
          value.value_text,
          value.value_tags_json
        );
      }
    }
  });
  tx();
}

export function getRun(db: Db, runId: number): Run | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Run | undefined;
}

export function listRunValues(db: Db, runId: number): RunValue[] {
  return db
    .prepare("SELECT * FROM run_values WHERE run_id = ?")
    .all(runId) as RunValue[];
}

export function upsertRunValue(db: Db, value: RunValue) {
  const existing = db
    .prepare("SELECT run_id FROM run_values WHERE run_id = ? AND param_def_id = ?")
    .get(value.run_id, value.param_def_id) as { run_id: number } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE run_values SET value_real = ?, value_text = ?, value_tags_json = ? WHERE run_id = ? AND param_def_id = ?"
    ).run(
      value.value_real,
      value.value_text,
      value.value_tags_json,
      value.run_id,
      value.param_def_id
    );
  } else {
    db.prepare(
      "INSERT INTO run_values (run_id, param_def_id, value_real, value_text, value_tags_json) VALUES (?, ?, ?, ?, ?)"
    ).run(
      value.run_id,
      value.param_def_id,
      value.value_real,
      value.value_text,
      value.value_tags_json
    );
  }
}

export function updateRunStatus(
  db: Db,
  runId: number,
  done: number,
  excludeFromAnalysis: number,
  dueAt?: string | null
) {
  if (typeof dueAt !== "undefined") {
    db.prepare("UPDATE runs SET done = ?, exclude_from_analysis = ?, due_at = ? WHERE id = ?").run(
      done,
      excludeFromAnalysis,
      dueAt,
      runId
    );
    return;
  }
  db.prepare("UPDATE runs SET done = ?, exclude_from_analysis = ? WHERE id = ?").run(done, excludeFromAnalysis, runId);
}

export function updateRunSchedule(db: Db, runId: number, dueAt: string | null) {
  db.prepare("UPDATE runs SET due_at = ? WHERE id = ?").run(dueAt, runId);
}

export function getNextPrevRunIds(db: Db, doeId: number, runOrder: number) {
  const prev = db
    .prepare(
      "SELECT id FROM runs WHERE doe_id = ? AND run_order < ? ORDER BY run_order DESC LIMIT 1"
    )
    .get(doeId, runOrder) as { id: number } | undefined;
  const next = db
    .prepare(
      "SELECT id FROM runs WHERE doe_id = ? AND run_order > ? ORDER BY run_order ASC LIMIT 1"
    )
    .get(doeId, runOrder) as { id: number } | undefined;
  return { prevId: prev?.id ?? null, nextId: next?.id ?? null };
}
