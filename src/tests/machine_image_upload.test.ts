import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { openDb } from "../db.js";
import { getMachine } from "../repos/machines_repo.js";
import { createUser } from "../repos/users_repo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test("equipment form stores an uploaded image and links it as the active machine cover", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-machine-image-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.FILE_STORAGE_PATH = path.join(tempDir, "uploads");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  try {
    const db = openDb();
    const passwordHash = bcrypt.hashSync("TestPass123!", 12);
    const engineerId = createUser(db, { email: "engineer@example.com", name: "Engineer", passwordHash, role: "engineer", status: "ACTIVE", tempPassword: 0 });
    createUser(db, { email: "viewer@example.com", name: "Viewer", passwordHash, role: "viewer", status: "ACTIVE", tempPassword: 0 });
    const { createApp } = await import("../app.js");
    const app = createApp();
    const login = async (email: string) => {
      const agent = request.agent(app);
      const token = await getCsrfToken(agent, "/auth/login");
      await agent.post("/auth/login").type("form").send({ email, password: "TestPass123!", _csrf: token }).expect(302);
      return agent;
    };
    const engineer = await login("engineer@example.com");
    const csrf = await getCsrfToken(engineer, "/machines/new");
    await engineer
      .post("/machines")
      .field({
        _csrf: csrf,
        name: "Twin screw",
        vendor: "Acme",
        model: "TS-70",
        notes: "Production equipment",
        clamp_force_kN: "1200",
        clamp_force_t: "122",
        intensification_ratio: "10",
        injection_pressure_bar: "1800",
        screw_diameter_mm: "70",
        tie_bar_distance_mm: "500 x 500",
        platen_size_mm: "700 x 700",
        opening_stroke_mm: "600",
        min_mold_height_mm: "200",
        max_mold_height_mm: "650",
        injection_volume_cm3: "900",
        injection_weight_g: "700",
        screw_speed_rpm: "300",
        plasticizing_rate_g_s: "45",
        custom_fields_json: JSON.stringify([{ label: "Cooling circuit", value: "Water" }])
      })
      .attach("machine_image", png, "twin-screw.png")
      .expect(302)
      .expect("Location", "/machines");

    const machine = db.prepare("SELECT id FROM machines WHERE name = ?").get("Twin screw") as { id: number };
    const saved = getMachine(db, machine.id)!;
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stored_files").get().count, 1);
    assert.match(saved.image_url || "", /^\/files\/\d+\/download$/);
    const fileId = Number((saved.image_url || "").match(/\d+/)?.[0]);
    assert.equal(db.prepare("SELECT owner_user_id FROM stored_files WHERE id = ?").get(fileId).owner_user_id, engineerId);
    assert.equal(db.prepare("SELECT placement FROM file_links WHERE file_id = ? AND entity_type = 'machine' AND entity_id = ?").get(fileId, machine.id).placement, "cover_image");
    const library = await engineer.get("/machines").expect(200);
    assert.match(library.text, new RegExp(`src="${saved.image_url}"`));
    const editPage = await engineer.get(`/machines/${machine.id}`).expect(200);
    assert.match(editPage.text, /Choose from my files/);
    assert.match(editPage.text, /twin-screw\.png/);
    assert.match(editPage.text, /data-modal-toggle="machineImagePicker"/);
    assert.match(editPage.text, /data-modal-hide="machineImagePicker"/);
    assert.match(editPage.text, /class="block w-full cursor-pointer[^\"]*" type="file" name="machine_image" id="machineImageUpload"/);
    assert.doesNotMatch(editPage.text, /Image URL/);

    const viewer = await login("viewer@example.com");
    await viewer.get(saved.image_url!).expect(200).expect("Content-Type", /image\/png/);
    await viewer.get(`/files/${fileId}/preview`).expect(200).expect("Content-Type", /image\/png/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
