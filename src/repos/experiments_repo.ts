import type { Db } from "../db.js";

export type Experiment = {
  id: number;
  name: string;
  design_type: string;
  seed: number;
  created_at: string;
  notes: string | null;
  machine_id: number | null;
  owner_user_id: number | null;
  archived_at: string | null;
  center_points: number;
  max_runs: number;
  replicate_count: number;
  recipe_as_block: number;
  status_done_manual?: number;
};

export type ExperimentListRow = Experiment & {
  owner_name: string | null;
  owner_email: string | null;
  qual_summary_count: number;
  qual_run_value_count: number;
};

export function listExperiments(db: Db, includeArchived = false): Experiment[] {
  if (includeArchived) {
    return db.prepare("SELECT * FROM experiments ORDER BY id DESC").all() as Experiment[];
  }
  return db
    .prepare("SELECT * FROM experiments WHERE archived_at IS NULL ORDER BY id DESC")
    .all() as Experiment[];
}

export function listExperimentsWithMeta(db: Db, includeArchived = false): ExperimentListRow[] {
  const baseSql = `
    SELECT
      experiments.*,
      users.name as owner_name,
      users.email as owner_email,
      (
        SELECT COUNT(DISTINCT step_number)
        FROM qual_step_summary
        WHERE qual_step_summary.experiment_id = experiments.id
      ) as qual_summary_count,
      (
        SELECT COUNT(*)
        FROM qual_run_values
        JOIN qual_runs ON qual_runs.id = qual_run_values.run_id
        WHERE qual_runs.experiment_id = experiments.id
      ) as qual_run_value_count
    FROM experiments
    LEFT JOIN users ON users.id = experiments.owner_user_id
  `;
  const sql = includeArchived
    ? `${baseSql} ORDER BY experiments.id DESC`
    : `${baseSql} WHERE experiments.archived_at IS NULL ORDER BY experiments.id DESC`;
  return db.prepare(sql).all() as ExperimentListRow[];
}

export function listExperimentsForOwner(
  db: Db,
  ownerUserId: number,
  includeArchived = false
): Experiment[] {
  if (includeArchived) {
    return db
      .prepare("SELECT * FROM experiments WHERE owner_user_id = ? ORDER BY id DESC")
      .all(ownerUserId) as Experiment[];
  }
  return db
    .prepare("SELECT * FROM experiments WHERE owner_user_id = ? AND archived_at IS NULL ORDER BY id DESC")
    .all(ownerUserId) as Experiment[];
}

export function listExperimentsForOwnerWithMeta(
  db: Db,
  ownerUserId: number,
  includeArchived = false
): ExperimentListRow[] {
  const baseSql = `
    SELECT
      experiments.*,
      users.name as owner_name,
      users.email as owner_email,
      (
        SELECT COUNT(DISTINCT step_number)
        FROM qual_step_summary
        WHERE qual_step_summary.experiment_id = experiments.id
      ) as qual_summary_count,
      (
        SELECT COUNT(*)
        FROM qual_run_values
        JOIN qual_runs ON qual_runs.id = qual_run_values.run_id
        WHERE qual_runs.experiment_id = experiments.id
      ) as qual_run_value_count
    FROM experiments
    LEFT JOIN users ON users.id = experiments.owner_user_id
    WHERE experiments.owner_user_id = ?
  `;
  const sql = includeArchived
    ? `${baseSql} ORDER BY experiments.id DESC`
    : `${baseSql} AND experiments.archived_at IS NULL ORDER BY experiments.id DESC`;
  return db.prepare(sql).all(ownerUserId) as ExperimentListRow[];
}

export function listExperimentsForUserWithMeta(
  db: Db,
  userId: number,
  includeArchived = false
): ExperimentListRow[] {
  const archivedSql = includeArchived ? "" : "AND experiments.archived_at IS NULL";
  const sql = `
    SELECT
      experiments.*,
      users.name as owner_name,
      users.email as owner_email,
      (
        SELECT COUNT(DISTINCT step_number)
        FROM qual_step_summary
        WHERE qual_step_summary.experiment_id = experiments.id
      ) as qual_summary_count,
      (
        SELECT COUNT(*)
        FROM qual_run_values
        JOIN qual_runs ON qual_runs.id = qual_run_values.run_id
        WHERE qual_runs.experiment_id = experiments.id
      ) as qual_run_value_count
    FROM experiments
    LEFT JOIN users ON users.id = experiments.owner_user_id
    WHERE (
      experiments.owner_user_id = ?
      OR EXISTS (
        SELECT 1 FROM entity_assignments ea
        WHERE ea.experiment_id = experiments.id
          AND ea.assignee_user_id = ?
          AND ea.status = 'active'
      )
    )
    ${archivedSql}
    ORDER BY experiments.id DESC
  `;
  return db.prepare(sql).all(userId, userId) as ExperimentListRow[];
}

export function getExperiment(db: Db, id: number): Experiment | undefined {
  return db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Experiment | undefined;
}

export function deleteExperiment(db: Db, id: number) {
  db.prepare("DELETE FROM experiments WHERE id = ?").run(id);
}

export function archiveExperiment(db: Db, id: number) {
  db.prepare("UPDATE experiments SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function restoreExperiment(db: Db, id: number, ownerUserId: number | null) {
  db.prepare(
    "UPDATE experiments SET archived_at = NULL, owner_user_id = ? WHERE id = ?"
  ).run(ownerUserId, id);
}

export function updateExperiment(
  db: Db,
  id: number,
  updates: Partial<Omit<Experiment, "id" | "created_at">>
) {
  const current = getExperiment(db, id);
  if (!current) return;
  const next = { ...current, ...updates };
  db.prepare(
    `UPDATE experiments
     SET name = ?, design_type = ?, seed = ?, notes = ?, machine_id = ?, owner_user_id = ?, center_points = ?, max_runs = ?, replicate_count = ?, recipe_as_block = ?
     WHERE id = ?`
  ).run(
    next.name,
    next.design_type,
    next.seed,
    next.notes ?? null,
    next.machine_id ?? null,
    next.owner_user_id ?? null,
    next.center_points ?? 3,
    next.max_runs ?? 200,
    next.replicate_count ?? 1,
    next.recipe_as_block ?? 0,
    id
  );
}

export function updateExperimentOwner(db: Db, id: number, ownerUserId: number | null) {
  db.prepare("UPDATE experiments SET owner_user_id = ? WHERE id = ?").run(ownerUserId, id);
}

export function updateExperimentManualDone(db: Db, id: number, done: number) {
  db.prepare("UPDATE experiments SET status_done_manual = ? WHERE id = ?").run(done ? 1 : 0, id);
}

export function createExperiment(
  db: Db,
  data: Pick<
    Experiment,
    | "name"
    | "design_type"
    | "seed"
    | "notes"
    | "machine_id"
    | "owner_user_id"
    | "center_points"
    | "max_runs"
    | "replicate_count"
    | "recipe_as_block"
  >
): number {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO experiments
        (name, design_type, seed, created_at, notes, machine_id, owner_user_id, center_points, max_runs, replicate_count, recipe_as_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name,
      data.design_type,
      data.seed,
      createdAt,
      data.notes ?? null,
      data.machine_id ?? null,
      data.owner_user_id ?? null,
      data.center_points ?? 3,
      data.max_runs ?? 200,
      data.replicate_count ?? 1,
      data.recipe_as_block ?? 0
    );
  return Number(result.lastInsertRowid);
}

export function setExperimentRecipes(db: Db, experimentId: number, recipeIds: number[]) {
  const del = db.prepare("DELETE FROM experiment_recipes WHERE experiment_id = ?");
  const insert = db.prepare(
    "INSERT INTO experiment_recipes (experiment_id, recipe_id) VALUES (?, ?)"
  );
  const tx = db.transaction(() => {
    del.run(experimentId);
    for (const recipeId of recipeIds) {
      insert.run(experimentId, recipeId);
    }
  });
  tx();
}

export function getExperimentRecipes(db: Db, experimentId: number): number[] {
  const rows = db
    .prepare("SELECT recipe_id FROM experiment_recipes WHERE experiment_id = ?")
    .all(experimentId) as Array<{ recipe_id: number }>;
  return rows.map((row) => row.recipe_id);
}

export function upsertDesignMetadata(
  db: Db,
  experimentId: number,
  doeId: number,
  jsonBlob: string
) {
  const existing = db
    .prepare("SELECT experiment_id FROM design_metadata WHERE experiment_id = ? AND doe_id = ?")
    .get(experimentId, doeId) as { experiment_id: number } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE design_metadata SET json_blob = ? WHERE experiment_id = ? AND doe_id = ?"
    ).run(
      jsonBlob,
      experimentId,
      doeId
    );
  } else {
    db.prepare("INSERT INTO design_metadata (experiment_id, doe_id, json_blob) VALUES (?, ?, ?)").run(
      experimentId,
      doeId,
      jsonBlob
    );
  }
}

export function getDesignMetadata(db: Db, experimentId: number, doeId: number): string | null {
  const row = db
    .prepare("SELECT json_blob FROM design_metadata WHERE experiment_id = ? AND doe_id = ?")
    .get(experimentId, doeId) as { json_blob: string } | undefined;
  return row?.json_blob ?? null;
}
