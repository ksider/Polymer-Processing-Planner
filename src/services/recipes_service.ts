import type { Db } from "../db.js";
import { createRecipe, replaceRecipeComponents, type RecipeVisibility } from "../repos/recipes_repo.js";
import { parseRecipeMatrix, parseRecipePlainText } from "../domain/imports.js";

function persistImportedRecipes(
  db: Db,
  imported: ReturnType<typeof parseRecipeMatrix>,
  ownerUserId: number,
  visibility: RecipeVisibility
) {
  // Do not overwrite a recipe hidden from the importing user just because it
  // has the same name. The catalogue permits distinct private formulations.
  const findByName = db.prepare("SELECT id FROM recipes WHERE name = ? AND owner_user_id = ? AND archived_at IS NULL");
  for (const recipe of imported) {
    const existing = findByName.get(recipe.name, ownerUserId) as { id: number } | undefined;
    const recipeId = existing
      ? existing.id
      : createRecipe(db, recipe.name, null, { ownerUserId, visibility });
    replaceRecipeComponents(
      db,
      recipeId,
      recipe.components.map((component) => ({
        recipe_id: recipeId,
        component_name: component.name,
        phr: component.phr
      }))
    );
  }
  return imported.length;
}

export function importRecipesFromText(db: Db, text: string, ownerUserId: number, visibility: RecipeVisibility) {
  const imported = parseRecipeMatrix(text);
  return persistImportedRecipes(db, imported, ownerUserId, visibility);
}

export function importRecipesFromPlainText(db: Db, text: string, ownerUserId: number, visibility: RecipeVisibility) {
  const imported = parseRecipePlainText(text);
  return persistImportedRecipes(db, imported, ownerUserId, visibility);
}
