import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { openDb } from "../db.js";
import { linkStoredFile } from "../repos/files_repo.js";
import { createUser } from "../repos/users_repo.js";
import { getCsrfToken } from "./csrf_test_helpers.js";

test("uploaded files stay owned by their uploader and are visible in the admin repository", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-files-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.FILE_STORAGE_PATH = path.join(tempDir, "uploads");
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_TEMP_PASSWORD = "TempPass123!";
  try {
    const db = openDb();
    const passwordHash = bcrypt.hashSync("TestPass123!", 12);
    const adminId = createUser(db, { email: "admin@example.com", name: "Admin", passwordHash, role: "admin", status: "ACTIVE", tempPassword: 0 });
    const aliceId = createUser(db, { email: "alice@example.com", name: "Alice", passwordHash, role: "engineer", status: "ACTIVE", tempPassword: 0 });
    createUser(db, { email: "bob@example.com", name: "Bob", passwordHash, role: "engineer", status: "ACTIVE", tempPassword: 0 });
    const { createApp } = await import("../app.js");
    const app = createApp();
    const login = async (email: string) => {
      const agent = request.agent(app);
      const token = await getCsrfToken(agent, "/auth/login");
      await agent.post("/auth/login").type("form").send({ email, password: "TestPass123!", _csrf: token }).expect(302);
      return agent;
    };
    const alice = await login("alice@example.com");
    const aliceCsrf = await getCsrfToken(alice, "/me?tab=files");
    const uploaded = await alice
      .post("/files/upload")
      .field("_csrf", aliceCsrf)
      .attach("files", Buffer.from("private lab note"), "lab-note.txt")
      .expect(302);
    assert.match(String(uploaded.headers.location), /\/me\?tab=files&notice=/);

    const stored = db.prepare("SELECT * FROM stored_files").get() as { id: number; owner_user_id: number; storage_key: string; original_name: string };
    assert.equal(stored.owner_user_id, aliceId);
    assert.equal(stored.original_name, "lab-note.txt");
    assert.equal(db.prepare("SELECT entity_type, entity_id, placement FROM file_links WHERE file_id = ?").get(stored.id).entity_id, aliceId);
    assert.equal(fs.existsSync(path.join(process.env.FILE_STORAGE_PATH!, stored.storage_key)), true);

    await alice.get("/me/files").expect(302).expect("Location", "/me?tab=files");
    await alice.get("/me?tab=files").expect(200).expect(/role="tabpanel" aria-label="My files"/).expect(/lab-note\.txt/).expect(/aria-label="Download lab-note\.txt"/);
    await alice.get(`/files/${stored.id}/download`).expect(200).expect("Content-Type", /text\/plain/);

    const bob = await login("bob@example.com");
    await bob.get(`/files/${stored.id}/download`).expect(403);
    await bob.get("/me?tab=files").expect(200).expect(/You have not uploaded any files/);

    const admin = await login("admin@example.com");
    const adminRepository = await admin
      .get(`/admin/files?owner_user_id=${aliceId}&entity_type=user&placement=library&type=document&sort=name`)
      .expect(200)
      .expect(/File repository/)
      .expect(/lab-note\.txt/)
      .expect(new RegExp(`href="/users/${aliceId}"`))
      .expect(/id="fileRegistryFilters"/)
      .expect(/name="entity_type"/)
      .expect(/Alice/);
    assert.match(adminRepository.text, />1 shown</);
    await admin.get(`/files/${stored.id}/download`).expect(200);

    linkStoredFile(db, { fileId: stored.id, entityType: "machine", entityId: 42, placement: "cover_image" });
    const deleteCsrf = await getCsrfToken(alice, "/me?tab=files");
    await alice.post(`/me/files/${stored.id}/delete`).type("form").send({ _csrf: deleteCsrf }).expect(302).expect("Location", /error=/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stored_files WHERE id = ?").get(stored.id).count, 1);

    db.prepare("DELETE FROM file_links WHERE file_id = ? AND entity_type = 'machine'").run(stored.id);
    await alice.post(`/me/files/${stored.id}/delete`).type("form").send({ _csrf: deleteCsrf }).expect(302).expect("Location", /notice=/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stored_files WHERE id = ?").get(stored.id).count, 0);
    assert.equal(fs.existsSync(path.join(process.env.FILE_STORAGE_PATH!, stored.storage_key)), false);
    assert.ok(adminId > 0);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
