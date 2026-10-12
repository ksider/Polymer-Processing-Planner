import type { Db } from "../db.js";

export type RecipeVisibility = "PRIVATE" | "SHARED" | "TEAM";

export type Recipe = {
  id: number;
  name: string;
  description: string | null;
  owner_user_id: number | null;
  visibility: RecipeVisibility;
  archived_at: string | null;
  created_at: string;
  owner_name?: string | null;
  owner_email?: string | null;
};

export type RecipeComponent = {
  recipe_id: number;
  component_name: string;
  phr: number;
};

type RecipeUser = { id?: number; role?: string | null } | undefined;

function isCatalogueModerator(user: RecipeUser) {
  return user?.role === "admin" || user?.role === "manager";
}

const recipeSelect = `
  SELECT recipes.*, users.name AS owner_name, users.email AS owner_email
  FROM recipes
  LEFT JOIN users ON users.id = recipes.owner_user_id
`;

export function normalizeRecipeVisibility(value: unknown): RecipeVisibility {
  const visibility = String(value ?? "").trim().toUpperCase();
  return visibility === "PRIVATE" || visibility === "SHARED" || visibility === "TEAM"
    ? visibility
    : "PRIVATE";
}

export function listRecipes(db: Db, includeArchived = false): Recipe[] {
  const archivedSql = includeArchived ? "" : "WHERE recipes.archived_at IS NULL";
  return db.prepare(`${recipeSelect} ${archivedSql} ORDER BY recipes.id DESC`).all() as Recipe[];
}

/** Returns catalogue items available to this user without duplicating them. */
export function listRecipesForUser(db: Db, user: RecipeUser, includeArchived = false): Recipe[] {
  if (!user?.id) return [];
  if (isCatalogueModerator(user)) return listRecipes(db, includeArchived);
  const archivedSql = includeArchived ? "" : "AND recipes.archived_at IS NULL";
  return db.prepare(
    `${recipeSelect}
     WHERE (
       recipes.visibility = 'TEAM'
       OR recipes.owner_user_id = ?
       OR EXISTS (
         SELECT 1 FROM recipe_user_access access
         WHERE access.recipe_id = recipes.id AND access.user_id = ?
       )
     )
     ${archivedSql}
     ORDER BY recipes.id DESC`
  ).all(user.id, user.id) as Recipe[];
}

export function getRecipe(db: Db, id: number): Recipe | undefined {
  return db.prepare(`${recipeSelect} WHERE recipes.id = ?`).get(id) as Recipe | undefined;
}

export function canViewRecipe(db: Db, recipe: Recipe, user: RecipeUser) {
  if (!user?.id) return false;
  if (isCatalogueModerator(user) || recipe.visibility === "TEAM" || recipe.owner_user_id === user.id) return true;
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM recipe_user_access WHERE recipe_id = ? AND user_id = ?")
      .get(recipe.id, user.id) as { ok: number } | undefined
  );
}

export function canManageRecipe(recipe: Recipe, user: RecipeUser) {
  return Boolean(user?.id && (isCatalogueModerator(user) || recipe.owner_user_id === user.id));
}

export function getRecipeComponents(db: Db, recipeId: number): RecipeComponent[] {
  return db
    .prepare("SELECT recipe_id, component_name, phr FROM recipe_components WHERE recipe_id = ? ORDER BY id")
    .all(recipeId) as RecipeComponent[];
}

export function createRecipe(
  db: Db,
  name: string,
  description: string | null,
  options: { ownerUserId?: number | null; visibility?: RecipeVisibility } = {}
): number {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO recipes (name, description, owner_user_id, visibility, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, description ?? null, options.ownerUserId ?? null, options.visibility ?? "PRIVATE", createdAt);
  return Number(result.lastInsertRowid);
}

export function updateRecipe(
  db: Db,
  id: number,
  name: string,
  description: string | null,
  visibility?: RecipeVisibility
) {
  db.prepare("UPDATE recipes SET name = ?, description = ?, visibility = COALESCE(?, visibility) WHERE id = ?")
    .run(name, description ?? null, visibility ?? null, id);
}

export function listRecipeAccessUserIds(db: Db, recipeId: number): number[] {
  return (db.prepare("SELECT user_id FROM recipe_user_access WHERE recipe_id = ? ORDER BY user_id").all(recipeId) as Array<{ user_id: number }>)
    .map((row) => row.user_id);
}

export function replaceRecipeAccess(db: Db, recipeId: number, userIds: number[], grantedByUserId: number | null) {
  const uniqueIds = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
  const now = new Date().toISOString();
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM recipe_user_access WHERE recipe_id = ?").run(recipeId);
    const insert = db.prepare(
      "INSERT INTO recipe_user_access (recipe_id, user_id, granted_by_user_id, created_at) VALUES (?, ?, ?, ?)"
    );
    uniqueIds.forEach((userId) => insert.run(recipeId, userId, grantedByUserId, now));
  });
  replace();
}

export function replaceRecipeComponents(db: Db, recipeId: number, components: RecipeComponent[]) {
  const del = db.prepare("DELETE FROM recipe_components WHERE recipe_id = ?");
  const insert = db.prepare(
    "INSERT INTO recipe_components (recipe_id, component_name, phr) VALUES (?, ?, ?)"
  );
  const tx = db.transaction(() => {
    del.run(recipeId);
    for (const component of components) insert.run(recipeId, component.component_name, component.phr);
  });
  tx();
}

export function deleteRecipe(db: Db, recipeId: number) {
  db.prepare("UPDATE recipes SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), recipeId);
}

export function deleteAllRecipes(db: Db) {
  db.prepare("DELETE FROM recipes").run();
}
