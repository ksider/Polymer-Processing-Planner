import type { Db } from "../db.js";

export type WorkspacePreferences = {
  defaultView: "table" | "board" | "calendar";
  lastScope: "mine" | "others" | "all";
  density: "comfortable" | "compact";
};

const defaults: WorkspacePreferences = { defaultView: "table", lastScope: "mine", density: "comfortable" };

export function getWorkspacePreferences(db: Db, userId: number): WorkspacePreferences {
  const row = db.prepare("SELECT default_view, last_scope, density FROM workspace_preferences WHERE user_id = ?").get(userId) as { default_view?: string; last_scope?: string; density?: string } | undefined;
  return {
    defaultView: row?.default_view === "board" || row?.default_view === "calendar" ? row.default_view : "table",
    lastScope: row?.last_scope === "others" || row?.last_scope === "all" ? row.last_scope : "mine",
    density: row?.density === "compact" ? "compact" : "comfortable"
  };
}

export function updateWorkspacePreferences(db: Db, userId: number, changes: Partial<WorkspacePreferences>): WorkspacePreferences {
  const current = getWorkspacePreferences(db, userId);
  const next = { ...current, ...changes };
  db.prepare(`
    INSERT INTO workspace_preferences (user_id, default_view, last_scope, density, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET default_view = excluded.default_view, last_scope = excluded.last_scope, density = excluded.density, updated_at = excluded.updated_at
  `).run(userId, next.defaultView, next.lastScope, next.density, new Date().toISOString());
  return next;
}
