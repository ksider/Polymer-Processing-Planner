import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import { createUser } from "../repos/users_repo.js";
import {
  createRecipe,
  listRecipesForUser,
  replaceRecipeAccess,
  replaceRecipeComponents
} from "../repos/recipes_repo.js";

let tempDir = "";

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-recipe-visibility-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test("recipe repository shares records by visibility without copying components", () => {
  const db = openDb();
  const ownerId = createUser(db, { email: "owner@example.com", name: "Owner", passwordHash: null, role: "engineer", status: "ACTIVE", tempPassword: 0 });
  const peerId = createUser(db, { email: "peer@example.com", name: "Peer", passwordHash: null, role: "engineer", status: "ACTIVE", tempPassword: 0 });
  const adminId = createUser(db, { email: "admin@example.com", name: "Admin", passwordHash: null, role: "admin", status: "ACTIVE", tempPassword: 0 });

  const privateRecipe = createRecipe(db, "Private formulation", null, { ownerUserId: ownerId, visibility: "PRIVATE" });
  const sharedRecipe = createRecipe(db, "Shared formulation", null, { ownerUserId: ownerId, visibility: "SHARED" });
  const teamRecipe = createRecipe(db, "Team formulation", null, { ownerUserId: ownerId, visibility: "TEAM" });
  replaceRecipeComponents(db, privateRecipe, [{ recipe_id: privateRecipe, component_name: "Base polymer", phr: 100 }]);
  replaceRecipeAccess(db, sharedRecipe, [peerId], ownerId);

  assert.deepEqual(listRecipesForUser(db, { id: ownerId, role: "engineer" }).map((recipe) => recipe.name).sort(), ["Private formulation", "Shared formulation", "Team formulation"]);
  assert.deepEqual(listRecipesForUser(db, { id: peerId, role: "engineer" }).map((recipe) => recipe.name).sort(), ["Shared formulation", "Team formulation"]);
  assert.deepEqual(listRecipesForUser(db, { id: adminId, role: "admin" }).map((recipe) => recipe.name).sort(), ["Private formulation", "Shared formulation", "Team formulation"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recipe_components WHERE recipe_id = ?").get(privateRecipe).count, 1);
});
