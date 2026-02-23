import Database from "better-sqlite3";
import path from "path";

export type Db = any;

export function openDb(): Db {
  const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || "im_doe.sqlite");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  // Better read latency for local web app workloads.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -20000");
  db.pragma("busy_timeout = 3000");
  initDb(db);
  return db;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function initDb(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      google_sub TEXT,
      role TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      temp_password INTEGER NOT NULL DEFAULT 0,
      reset_requested_at TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      allowed_domain TEXT,
      require_https INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      user_id INTEGER,
      expires_at TEXT,
      data TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      target_user_id INTEGER,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'init',
      owner_user_id INTEGER,
      due_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS task_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL, -- qualification_step | doe | report
      entity_id INTEGER NOT NULL,
      label TEXT,
      weight REAL NOT NULL DEFAULT 1,
      progress_mode TEXT NOT NULL DEFAULT 'toggle', -- toggle | milestone
      status TEXT NOT NULL DEFAULT 'init', -- init | in_progress | done | failed
      signature_required INTEGER NOT NULL DEFAULT 0,
      signature_user_id INTEGER,
      signature_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (signature_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS task_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      author_id INTEGER,
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS note_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL UNIQUE,
      entity_type TEXT NOT NULL, -- experiment | qualification_step | doe | run | report | task
      entity_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS note_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      author_id INTEGER,
      body_md TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS note_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS note_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      body_md TEXT NOT NULL,
      edited_by_user_id INTEGER,
      edit_kind TEXT NOT NULL DEFAULT 'manual', -- manual | append | checklist | system
      created_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (edited_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS entity_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL, -- qualification_step | doe
      entity_id INTEGER NOT NULL,
      assignee_user_id INTEGER,
      assigned_by_user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active', -- active | revoked
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(entity_type, entity_id),
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
      FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS assignment_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL UNIQUE,
      task_id INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (assignment_id) REFERENCES entity_assignments(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- assignment | system | message (future)
      title TEXT NOT NULL,
      body TEXT,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'unread', -- unread | read | archived
      created_at TEXT NOT NULL,
      read_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipe_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL,
      component_name TEXT NOT NULL,
      phr REAL NOT NULL,
      FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      image_url TEXT,
      vendor TEXT,
      model TEXT,
      settings_json TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machine_params (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER NOT NULL,
      code TEXT,
      label TEXT NOT NULL,
      unit TEXT,
      value_text TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      design_type TEXT NOT NULL,
      seed INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      notes TEXT,
      machine_id INTEGER,
      owner_user_id INTEGER,
      archived_at TEXT,
      center_points INTEGER DEFAULT 3,
      max_runs INTEGER DEFAULT 200,
      replicate_count INTEGER DEFAULT 1,
      recipe_as_block INTEGER DEFAULT 0,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE SET NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS experiment_recipes (
      experiment_id INTEGER NOT NULL,
      recipe_id INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, recipe_id),
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
      FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS param_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      experiment_id INTEGER,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      unit TEXT,
      field_kind TEXT NOT NULL,
      field_type TEXT NOT NULL,
      group_label TEXT,
      allowed_values_json TEXT,
      UNIQUE(scope, experiment_id, code),
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS param_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      param_def_id INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL,
      fixed_value_real REAL,
      range_min_real REAL,
      range_max_real REAL,
      list_json TEXT,
      level_count INTEGER,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
      FOREIGN KEY (param_def_id) REFERENCES param_definitions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      run_order INTEGER NOT NULL,
      run_code TEXT NOT NULL,
      recipe_id INTEGER,
      replicate_key TEXT,
      replicate_index INTEGER,
      done INTEGER NOT NULL DEFAULT 0,
      exclude_from_analysis INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
      FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS run_values (
      run_id INTEGER NOT NULL,
      param_def_id INTEGER NOT NULL,
      value_real REAL,
      value_text TEXT,
      value_tags_json TEXT,
      PRIMARY KEY (run_id, param_def_id),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (param_def_id) REFERENCES param_definitions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS design_metadata (
      experiment_id INTEGER NOT NULL,
      doe_id INTEGER NOT NULL,
      json_blob TEXT NOT NULL,
      PRIMARY KEY (experiment_id, doe_id),
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS analysis_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL,
      scope_id INTEGER,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL,
      unit TEXT,
      group_label TEXT,
      allowed_values_json TEXT,
      is_standard INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scope_type, scope_id, code)
    );
    CREATE TABLE IF NOT EXISTS analysis_run_values (
      run_id INTEGER NOT NULL,
      field_id INTEGER NOT NULL,
      value_real REAL,
      value_text TEXT,
      value_tags_json TEXT,
      PRIMARY KEY (run_id, field_id),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (field_id) REFERENCES analysis_fields(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS doe_studies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      design_type TEXT NOT NULL,
      seed INTEGER NOT NULL,
      center_points INTEGER DEFAULT 3,
      max_runs INTEGER DEFAULT 200,
      replicate_count INTEGER DEFAULT 1,
      recipe_as_block INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS report_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      executors TEXT,
      include_json TEXT,
      doe_ids_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS report_documents (
      report_id INTEGER PRIMARY KEY,
      content_json TEXT NOT NULL,
      html_snapshot TEXT,
      content_md TEXT,
      editor_kind TEXT NOT NULL DEFAULT 'editorjs',
      schema_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (report_id) REFERENCES report_configs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS qual_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      step_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      UNIQUE(experiment_id, step_number),
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS qual_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      step_id INTEGER NOT NULL,
      run_order INTEGER NOT NULL,
      run_code TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      exclude_from_analysis INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES qual_steps(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS qual_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      step_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL,
      unit TEXT,
      group_label TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      is_derived INTEGER NOT NULL DEFAULT 0,
      allowed_values_json TEXT,
      derived_formula_code TEXT,
      UNIQUE(step_id, code),
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES qual_steps(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS qual_run_values (
      run_id INTEGER NOT NULL,
      field_id INTEGER NOT NULL,
      value_real REAL,
      value_text TEXT,
      value_tags_json TEXT,
      PRIMARY KEY (run_id, field_id),
      FOREIGN KEY (run_id) REFERENCES qual_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (field_id) REFERENCES qual_fields(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS qual_step_summary (
      experiment_id INTEGER NOT NULL,
      step_number INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (experiment_id, step_number),
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS qual_step_settings (
      experiment_id INTEGER NOT NULL,
      step_number INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (experiment_id, step_number),
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_actor_user_id ON audit_log(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_experiment_id ON tasks(experiment_id);
    CREATE INDEX IF NOT EXISTS idx_task_entities_task_id ON task_entities(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_task_id ON task_assignments(task_id);
    CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id);
    CREATE INDEX IF NOT EXISTS idx_entity_assignments_experiment_id ON entity_assignments(experiment_id);
    CREATE INDEX IF NOT EXISTS idx_entity_assignments_assignee ON entity_assignments(assignee_user_id);
    CREATE INDEX IF NOT EXISTS idx_entity_assignments_exp_assignee_status ON entity_assignments(experiment_id, assignee_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_status ON notifications(user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_experiments_owner_archived ON experiments(owner_user_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_qual_step_summary_experiment_step ON qual_step_summary(experiment_id, step_number);
    CREATE INDEX IF NOT EXISTS idx_qual_runs_experiment_id ON qual_runs(experiment_id);
    CREATE INDEX IF NOT EXISTS idx_qual_run_values_run_id ON qual_run_values(run_id);
    CREATE INDEX IF NOT EXISTS idx_report_configs_experiment_id ON report_configs(experiment_id);
    CREATE INDEX IF NOT EXISTS idx_param_definitions_scope_group ON param_definitions(scope, group_label, id);
    CREATE INDEX IF NOT EXISTS idx_param_definitions_scope_kind_group ON param_definitions(scope, field_kind, group_label, id);
  `);

  const adminSettingsCount = db
    .prepare("SELECT COUNT(*) as count FROM admin_settings")
    .get() as { count: number };
  if (adminSettingsCount.count === 0) {
    db.prepare("INSERT INTO admin_settings (allowed_domain) VALUES (NULL)").run();
  }

  // Safe migrations for new columns.
  const experimentColumns = [
    ["center_points", "ALTER TABLE experiments ADD COLUMN center_points INTEGER DEFAULT 3"],
    ["max_runs", "ALTER TABLE experiments ADD COLUMN max_runs INTEGER DEFAULT 200"],
    ["replicate_count", "ALTER TABLE experiments ADD COLUMN replicate_count INTEGER DEFAULT 1"],
    ["recipe_as_block", "ALTER TABLE experiments ADD COLUMN recipe_as_block INTEGER DEFAULT 0"],
    ["machine_id", "ALTER TABLE experiments ADD COLUMN machine_id INTEGER"],
    ["status_done_manual", "ALTER TABLE experiments ADD COLUMN status_done_manual INTEGER NOT NULL DEFAULT 0"]
  ] as const;
  for (const [column, sql] of experimentColumns) {
    if (!hasColumn(db, "experiments", column)) {
      db.exec(sql);
    }
  }
  if (!hasColumn(db, "experiments", "owner_user_id")) {
    db.exec("ALTER TABLE experiments ADD COLUMN owner_user_id INTEGER");
  }
  if (!hasColumn(db, "experiments", "archived_at")) {
    db.exec("ALTER TABLE experiments ADD COLUMN archived_at TEXT");
  }
  if (!hasColumn(db, "recipes", "archived_at")) {
    db.exec("ALTER TABLE recipes ADD COLUMN archived_at TEXT");
  }

  const adminRow = db
    .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined;
  if (adminRow) {
    db.prepare("UPDATE experiments SET owner_user_id = ? WHERE owner_user_id IS NULL").run(adminRow.id);
  }

  if (!hasColumn(db, "analysis_fields", "is_standard")) {
    db.exec("ALTER TABLE analysis_fields ADD COLUMN is_standard INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "analysis_fields", "is_active")) {
    db.exec("ALTER TABLE analysis_fields ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "analysis_fields", "doe_id")) {
    db.exec("ALTER TABLE analysis_fields ADD COLUMN doe_id INTEGER");
  }
  if (!hasColumn(db, "users", "reset_requested_at")) {
    db.exec("ALTER TABLE users ADD COLUMN reset_requested_at TEXT");
  }
  if (!hasColumn(db, "users", "name")) {
    db.exec("ALTER TABLE users ADD COLUMN name TEXT");
  }
  if (!hasColumn(db, "admin_settings", "require_https")) {
    db.exec("ALTER TABLE admin_settings ADD COLUMN require_https INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "param_configs", "doe_id")) {
    db.exec("ALTER TABLE param_configs ADD COLUMN doe_id INTEGER");
  }
  if (!hasColumn(db, "design_metadata", "doe_id")) {
    db.exec("ALTER TABLE design_metadata ADD COLUMN doe_id INTEGER");
  }
  if (!hasColumn(db, "report_configs", "signed_at")) {
    db.exec("ALTER TABLE report_configs ADD COLUMN signed_at TEXT");
  }
  if (!hasColumn(db, "report_configs", "signed_by_user_id")) {
    db.exec("ALTER TABLE report_configs ADD COLUMN signed_by_user_id INTEGER");
  }
  if (!hasColumn(db, "entity_assignments", "status")) {
    db.exec("ALTER TABLE entity_assignments ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!hasColumn(db, "notifications", "payload_json")) {
    db.exec("ALTER TABLE notifications ADD COLUMN payload_json TEXT");
  }
  if (!hasColumn(db, "notifications", "status")) {
    db.exec("ALTER TABLE notifications ADD COLUMN status TEXT NOT NULL DEFAULT 'unread'");
  }
  if (!hasColumn(db, "notifications", "read_at")) {
    db.exec("ALTER TABLE notifications ADD COLUMN read_at TEXT");
  }
  if (!hasColumn(db, "report_documents", "content_md")) {
    db.exec("ALTER TABLE report_documents ADD COLUMN content_md TEXT");
  }
  if (!hasColumn(db, "report_documents", "editor_kind")) {
    db.exec("ALTER TABLE report_documents ADD COLUMN editor_kind TEXT NOT NULL DEFAULT 'editorjs'");
  }
  if (!hasColumn(db, "report_documents", "schema_version")) {
    db.exec("ALTER TABLE report_documents ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1");
  }
  const designMetaInfo = db
    .prepare("PRAGMA table_info(design_metadata)")
    .all() as Array<{ name: string; pk: number }>;
  const designMetaPkColumns = designMetaInfo.filter((col) => col.pk > 0).map((col) => col.name);
  if (
    designMetaPkColumns.length === 1 &&
    designMetaPkColumns[0] === "experiment_id" &&
    hasColumn(db, "design_metadata", "doe_id")
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS design_metadata_new (
        experiment_id INTEGER NOT NULL,
        doe_id INTEGER NOT NULL,
        json_blob TEXT NOT NULL,
        PRIMARY KEY (experiment_id, doe_id),
        FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
      );
      INSERT INTO design_metadata_new (experiment_id, doe_id, json_blob)
      SELECT experiment_id, COALESCE(doe_id, 0) as doe_id, json_blob FROM design_metadata;
      DROP TABLE design_metadata;
      ALTER TABLE design_metadata_new RENAME TO design_metadata;
    `);
  }
  if (!hasColumn(db, "runs", "doe_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN doe_id INTEGER");
  }

  const standardFields: Array<{
    code: string;
    label: string;
    field_type: string;
    unit: string | null;
    group_label: string;
    allowed_values_json: string | null;
  }> = [
    { code: "part_weight_g", label: "Part weight", field_type: "number", unit: "g", group_label: "Core quality", allowed_values_json: null },
    { code: "density_g_cm3", label: "Density", field_type: "number", unit: "g/cm3", group_label: "Core quality", allowed_values_json: null },
    { code: "critical_dim_mm", label: "Critical dimension", field_type: "number", unit: "mm", group_label: "Core quality", allowed_values_json: null },
    { code: "shrinkage_pct", label: "Shrinkage", field_type: "number", unit: "%", group_label: "Core quality", allowed_values_json: null },
    { code: "water_solubility_pct", label: "Water solubility", field_type: "number", unit: "%", group_label: "Water / bio properties", allowed_values_json: null },
    { code: "water_uptake_g_g", label: "Water uptake / swelling", field_type: "number", unit: "g/g", group_label: "Water / bio properties", allowed_values_json: null },
    { code: "flexural_strength_mpa", label: "Flexural strength", field_type: "number", unit: "MPa", group_label: "Mechanical", allowed_values_json: null },
    { code: "flexural_modulus_mpa", label: "Flexural modulus", field_type: "number", unit: "MPa", group_label: "Mechanical", allowed_values_json: null },
    { code: "impact_strength_kj_m2", label: "Impact strength", field_type: "number", unit: "kJ/m2", group_label: "Mechanical", allowed_values_json: null },
    { code: "tensile_strength_mpa", label: "Tensile strength", field_type: "number", unit: "MPa", group_label: "Mechanical", allowed_values_json: null },
    { code: "surface_roughness_ra_um", label: "Surface roughness Ra", field_type: "number", unit: "um", group_label: "Surface & demolding", allowed_values_json: null },
    { code: "demold_ok", label: "Demolding OK", field_type: "boolean", unit: null, group_label: "Surface & demolding", allowed_values_json: null },
    { code: "visual_score_1_5", label: "Visual score", field_type: "number", unit: "score_1_5", group_label: "Surface & demolding", allowed_values_json: null },
    { code: "fill_time_s", label: "Fill time", field_type: "number", unit: "s", group_label: "Process proxies", allowed_values_json: null },
    { code: "peak_injection_pressure_bar", label: "Peak injection pressure", field_type: "number", unit: "bar", group_label: "Process proxies", allowed_values_json: null },
    { code: "actual_cushion_mm", label: "Actual cushion", field_type: "number", unit: "mm", group_label: "Process proxies", allowed_values_json: null },
    { code: "cycle_time_s", label: "Cycle time", field_type: "number", unit: "s", group_label: "Process proxies", allowed_values_json: null },
    {
      code: "defects",
      label: "Defect tags",
      field_type: "tag",
      unit: null,
      group_label: "Defects",
      allowed_values_json: JSON.stringify([
        "short_shot",
        "flash",
        "sticking",
        "warpage",
        "bubbles",
        "burn_marks",
        "sink_marks",
        "brittle",
        "poor_surface",
        "demold_damage"
      ])
    }
  ];

  const existingStandard = new Set(
    db.prepare("SELECT code FROM analysis_fields WHERE scope_type = 'GLOBAL'").all()
      .map((row: { code: string }) => row.code)
  );
  const insertStandard = db.prepare(
    `INSERT INTO analysis_fields
     (scope_type, scope_id, code, label, field_type, unit, group_label, allowed_values_json, is_standard, is_active)
     VALUES ('GLOBAL', NULL, ?, ?, ?, ?, ?, ?, 1, 0)`
  );
  for (const field of standardFields) {
    if (existingStandard.has(field.code)) continue;
    insertStandard.run(
      field.code,
      field.label,
      field.field_type,
      field.unit,
      field.group_label,
      field.allowed_values_json
    );
  }

  const experimentFieldCount = db
    .prepare("SELECT COUNT(*) as count FROM analysis_fields WHERE scope_type = 'EXPERIMENT'")
    .get() as { count: number };
  if (experimentFieldCount.count === 0) {
    const experiments = db.prepare("SELECT id FROM experiments").all() as Array<{ id: number }>;
    const outputParams = db
      .prepare("SELECT code, label, field_type, unit, group_label, allowed_values_json FROM param_definitions WHERE field_kind = 'OUTPUT'")
      .all() as Array<{
        code: string;
        label: string;
        field_type: string;
        unit: string | null;
        group_label: string | null;
        allowed_values_json: string | null;
      }>;
    const insertExperimentField = db.prepare(
      `INSERT INTO analysis_fields
       (scope_type, scope_id, code, label, field_type, unit, group_label, allowed_values_json, is_standard, is_active)
       VALUES ('EXPERIMENT', ?, ?, ?, ?, ?, ?, ?, 0, 1)`
    );
    for (const experiment of experiments) {
      for (const output of outputParams) {
        insertExperimentField.run(
          experiment.id,
          output.code,
          output.label,
          output.field_type,
          output.unit,
          output.group_label,
          output.allowed_values_json
        );
      }
    }

    const experimentFieldRows = db
      .prepare("SELECT id, scope_id, code, field_type FROM analysis_fields WHERE scope_type = 'EXPERIMENT'")
      .all() as Array<{ id: number; scope_id: number; code: string; field_type: string }>;
    const fieldMap = new Map(
      experimentFieldRows.map((row) => [`${row.scope_id}:${row.code}`, row])
    );
    const outputValues = db
      .prepare(
        `SELECT r.id as run_id, r.experiment_id, p.code, rv.value_real, rv.value_text, rv.value_tags_json
         FROM run_values rv
         JOIN runs r ON r.id = rv.run_id
         JOIN param_definitions p ON p.id = rv.param_def_id
         WHERE p.field_kind = 'OUTPUT'`
      )
      .all() as Array<{
        run_id: number;
        experiment_id: number;
        code: string;
        value_real: number | null;
        value_text: string | null;
        value_tags_json: string | null;
      }>;
    const insertAnalysisValue = db.prepare(
      `INSERT OR REPLACE INTO analysis_run_values
       (run_id, field_id, value_real, value_text, value_tags_json)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const row of outputValues) {
      const field = fieldMap.get(`${row.experiment_id}:${row.code}`);
      if (!field) continue;
      insertAnalysisValue.run(
        row.run_id,
        field.id,
        row.value_real,
        row.value_text,
        row.value_tags_json
      );
    }
  }

  const machineCount = db.prepare("SELECT COUNT(*) as count FROM machines").get() as { count: number };
  if (machineCount.count === 0) {
    const settings = {
      clamp_force_kN: 1100,
      clamp_force_t: 110,
      tie_bar_distance_mm: "470 x 470",
      platen_size_mm: "670 x 660",
      opening_stroke_mm: 600,
      min_mold_height_mm: 250,
      max_mold_height_mm: 550,
      screw_diameter_mm: "35 / 40 / 45",
      injection_volume_cm3: "158 - 231",
      injection_weight_g: "144 - 205",
      injection_pressure_bar: 2020,
      intensification_ratio: null,
      screw_speed_rpm: 200,
      plasticizing_rate_g_s: "20 - 25"
    };
    const createdAt = new Date().toISOString();
    const result = db.prepare(
      `INSERT INTO machines (name, image_url, vendor, model, settings_json, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "Demag Ergotech 110/470-310",
      null,
      "Demag",
      "Ergotech 110/470-310",
      JSON.stringify(settings),
      null,
      createdAt
    );
    const machineId = Number(result.lastInsertRowid);
    const insertParam = db.prepare(
      `INSERT INTO machine_params (machine_id, code, label, unit, value_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const params: Array<{ code: string; label: string; unit: string | null; value: string }> = [
      { code: "clamp_force_kN", label: "Clamp force", unit: "kN", value: "1100" },
      { code: "clamp_force_t", label: "Clamp force", unit: "t", value: "110" },
      { code: "tie_bar_distance_mm", label: "Tie bar distance", unit: "mm", value: "470 x 470" },
      { code: "platen_size_mm", label: "Platen size", unit: "mm", value: "670 x 660" },
      { code: "opening_stroke_mm", label: "Opening stroke", unit: "mm", value: "600" },
      { code: "min_mold_height_mm", label: "Min mold height", unit: "mm", value: "250" },
      { code: "max_mold_height_mm", label: "Max mold height", unit: "mm", value: "550" },
      { code: "screw_diameter_mm", label: "Screw diameter", unit: "mm", value: "35 / 40 / 45" },
      { code: "injection_volume_cm3", label: "Injection volume", unit: "cm3", value: "158 - 231" },
      { code: "injection_weight_g", label: "Injection weight", unit: "g", value: "144 - 205" },
      { code: "injection_pressure_bar", label: "Injection pressure", unit: "bar", value: "2020" },
      { code: "intensification_ratio", label: "Intensification ratio", unit: null, value: "" },
      { code: "screw_speed_rpm", label: "Screw speed", unit: "rpm", value: "200" },
      { code: "plasticizing_rate_g_s", label: "Plasticizing rate", unit: "g/s", value: "20 - 25" }
    ];
    params.forEach((param) => {
      insertParam.run(machineId, param.code, param.label, param.unit, param.value, createdAt);
    });
  }

  // DOE migration: create default DOE per experiment and attach existing DOE data.
  const doeCount = db.prepare("SELECT COUNT(*) as count FROM doe_studies").get() as { count: number };
  if (doeCount.count === 0) {
    const experiments = db
      .prepare("SELECT id, design_type, seed, center_points, max_runs, replicate_count, recipe_as_block FROM experiments")
      .all() as Array<{
      id: number;
      design_type: string;
      seed: number;
      center_points: number;
      max_runs: number;
      replicate_count: number;
      recipe_as_block: number;
    }>;
    const insertDoe = db.prepare(
      `INSERT INTO doe_studies
       (experiment_id, name, design_type, seed, center_points, max_runs, replicate_count, recipe_as_block, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateRuns = db.prepare("UPDATE runs SET doe_id = ? WHERE experiment_id = ? AND doe_id IS NULL");
    const updateConfigs = db.prepare(
      "UPDATE param_configs SET doe_id = ? WHERE experiment_id = ? AND doe_id IS NULL"
    );
    const updateMeta = db.prepare(
      "UPDATE design_metadata SET doe_id = ? WHERE experiment_id = ? AND (doe_id IS NULL OR doe_id = 0)"
    );
    const updateAnalysis = db.prepare(
      "UPDATE analysis_fields SET scope_type = 'DOE', scope_id = ?, doe_id = ? WHERE scope_type = 'EXPERIMENT' AND scope_id = ?"
    );

    const now = new Date().toISOString();
    for (const exp of experiments) {
      const res = insertDoe.run(
        exp.id,
        "DOE 1",
        exp.design_type,
        exp.seed,
        exp.center_points ?? 3,
        exp.max_runs ?? 200,
        exp.replicate_count ?? 1,
        exp.recipe_as_block ?? 0,
        now
      );
      const doeId = Number(res.lastInsertRowid);
      updateRuns.run(doeId, exp.id);
      updateConfigs.run(doeId, exp.id);
      updateMeta.run(doeId, exp.id);
      updateAnalysis.run(doeId, doeId, exp.id);
    }
  }
}
