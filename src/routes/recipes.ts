import express from "express";
import multer from "multer";
import type { Db } from "../db.js";
import { FILE_UPLOAD_LIMITER } from "../middleware/rate_limit.js";
import { recipeFileFilter, fileSizeLimit, handleFileUploadError } from "../middleware/file_upload.js";
import {
  canManageRecipe,
  createRecipe,
  deleteAllRecipes,
  deleteRecipe,
  getRecipe,
  getRecipeComponents,
  listRecipeAccessUserIds,
  listRecipesForUser,
  normalizeRecipeVisibility,
  replaceRecipeAccess,
  replaceRecipeComponents,
  updateRecipe,
  type RecipeComponent,
  type RecipeVisibility
} from "../repos/recipes_repo.js";
import { listProcessesForOwner } from "../repos/processes_repo.js";
import { listUsers } from "../repos/users_repo.js";
import { importRecipesFromPlainText, importRecipesFromText } from "../services/recipes_service.js";

const upload = multer({ storage: multer.memoryStorage(), fileFilter: recipeFileFilter, limits: fileSizeLimit });

function parseComponents(body: Record<string, unknown>, recipeId: number): RecipeComponent[] {
  const names = body.component_name;
  const phrs = body.component_phr;
  const nameList = Array.isArray(names) ? names : typeof names === "string" ? [names] : [];
  const phrList = Array.isArray(phrs) ? phrs : typeof phrs === "string" ? [phrs] : [];
  return nameList
    .map((componentName, index) => {
      const name = typeof componentName === "string" ? componentName.trim() : "";
      const rawPhr = typeof phrList[index] === "string" ? phrList[index].trim() : "";
      const phr = Number(rawPhr.includes(",") && !rawPhr.includes(".") ? rawPhr.replace(",", ".") : rawPhr);
      return name && Number.isFinite(phr) ? { recipe_id: recipeId, component_name: name, phr } : null;
    })
    .filter((component): component is RecipeComponent => Boolean(component));
}

function parseUserIds(value: unknown) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return raw.map((item) => Number(item)).filter((id) => Number.isInteger(id) && id > 0);
}

export function createRecipesRouter(db: Db) {
  const router = express.Router();
  const hasRole = (req: express.Request, roles: string[]) => roles.includes(req.user?.role ?? "");
  const canCreateRecipes = (req: express.Request) =>
    hasRole(req, ["admin", "manager", "engineer"]) || Boolean(req.user?.id && listProcessesForOwner(db, req.user.id).length);
  const canManageAllRecipes = (req: express.Request) => hasRole(req, ["admin", "manager"]);

  router.get("/recipes", (req, res) => {
    const importedCount = req.query.imported ? Number(req.query.imported) : null;
    const error = req.query.error ? String(req.query.error) : null;
    const recipes = listRecipesForUser(db, req.user).map((recipe) => ({
      ...recipe,
      components: getRecipeComponents(db, recipe.id),
      accessUserIds: listRecipeAccessUserIds(db, recipe.id),
      canManage: canManageRecipe(recipe, req.user)
    }));
    res.render("recipes", {
      recipes,
      recipeUsers: canCreateRecipes(req) ? listUsers(db).filter((user) => user.status === "ACTIVE") : [],
      canCreateRecipes: canCreateRecipes(req),
      canManageAllRecipes: canManageAllRecipes(req),
      importedCount: Number.isFinite(importedCount) ? importedCount : null,
      error
    });
  });

  router.post("/recipes/import", FILE_UPLOAD_LIMITER, upload.single("matrix"), handleFileUploadError, (req: express.Request, res: express.Response) => {
    if (!canCreateRecipes(req) || !req.user?.id) return res.status(403).send("Forbidden");
    if (!req.file) return res.redirect("/recipes?error=No%20file%20uploaded.");
    const visibility = normalizeRecipeVisibility(req.body.visibility);
    const count = importRecipesFromText(db, req.file.buffer.toString("utf8"), req.user.id, visibility === "SHARED" ? "PRIVATE" : visibility);
    return res.redirect(`/recipes?imported=${count}`);
  });

  router.post("/recipes/import-text", (req, res) => {
    if (!canCreateRecipes(req) || !req.user?.id) return res.status(403).send("Forbidden");
    const text = typeof req.body.recipe_text === "string" ? req.body.recipe_text : "";
    if (!text.trim()) return res.redirect("/recipes?error=No%20text%20provided.");
    const visibility = normalizeRecipeVisibility(req.body.visibility);
    const count = importRecipesFromPlainText(db, text, req.user.id, visibility === "SHARED" ? "PRIVATE" : visibility);
    if (!count) return res.redirect("/recipes?error=No%20valid%20recipe%20found.");
    return res.redirect(`/recipes?imported=${count}`);
  });

  router.post("/recipes/quick-create", (req, res) => {
    if (!canCreateRecipes(req) || !req.user?.id) return res.status(403).json({ error: "forbidden" });
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 160) return res.status(400).json({ error: "Recipe name is required." });
    const recipeId = createRecipe(db, name, null, { ownerUserId: req.user.id, visibility: "PRIVATE" });
    const components = parseComponents(req.body, recipeId);
    if (!components.length) {
      deleteRecipe(db, recipeId);
      return res.status(400).json({ error: "Add at least one component with a numeric PHR value." });
    }
    replaceRecipeComponents(db, recipeId, components);
    const recipe = getRecipe(db, recipeId);
    return res.status(201).json({ recipe: { ...recipe, components, accessUserIds: [], canManage: true } });
  });

  router.post("/recipes/:id/update", (req, res) => {
    const recipeId = Number(req.params.id);
    const recipe = Number.isFinite(recipeId) ? getRecipe(db, recipeId) : null;
    if (!recipe || !canManageRecipe(recipe, req.user)) return res.status(403).send("Forbidden");
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const components = parseComponents(req.body, recipeId);
    if (!name) return res.redirect("/recipes?error=Recipe%20name%20required.");
    if (!components.length) return res.redirect("/recipes?error=No%20components%20provided.");
    const visibility = normalizeRecipeVisibility(req.body.visibility);
    updateRecipe(db, recipeId, name, null, visibility);
    replaceRecipeComponents(db, recipeId, components);
    replaceRecipeAccess(db, recipeId, visibility === "SHARED" ? parseUserIds(req.body.access_user_ids) : [], req.user?.id ?? null);
    return res.redirect("/recipes");
  });

  router.post("/recipes/:id/delete", (req, res) => {
    const recipeId = Number(req.params.id);
    const recipe = Number.isFinite(recipeId) ? getRecipe(db, recipeId) : null;
    if (!recipe || !canManageRecipe(recipe, req.user)) return res.status(403).send("Forbidden");
    deleteRecipe(db, recipeId);
    return res.redirect("/recipes");
  });

  router.post("/recipes/clear", (req, res) => {
    if (!canManageAllRecipes(req)) return res.status(403).send("Forbidden");
    deleteAllRecipes(db);
    return res.redirect("/recipes");
  });

  return router;
}
