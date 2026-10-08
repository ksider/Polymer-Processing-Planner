import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../db.js";
import {
  createEmailSenderProfile,
  createResendProviderProfile,
  getDefaultSenderForDelivery,
  listEmailProviderProfiles,
  listEmailSenderProfiles
} from "../repos/email_profiles_repo.js";
import { decryptAppSetting, encryptAppSetting, hasAppSettingsEncryptionKey } from "../services/settings_crypto.js";

test("Resend profiles store only encrypted API keys and select the default sender by purpose", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-email-"));
  const previousDbPath = process.env.DB_PATH;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousKey = process.env.APP_SETTINGS_ENCRYPTION_KEY;
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.APP_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

  try {
    assert.equal(hasAppSettingsEncryptionKey(), true);
    const ciphertext = encryptAppSetting("re_secret_key");
    assert.doesNotMatch(ciphertext, /re_secret_key/);
    assert.equal(decryptAppSetting(ciphertext), "re_secret_key");

    const db = openDb();
    const providerId = createResendProviderProfile(db, { name: "Primary", apiKeyCiphertext: ciphertext, actorUserId: null });
    const senderId = createEmailSenderProfile(db, {
      provider_profile_id: providerId,
      purpose: "auth",
      name: "Planner auth",
      from_name: "IM Planner",
      from_email: "noreply@example.com",
      reply_to: "support@example.com",
      makeDefault: true,
      actorUserId: null
    });

    assert.equal(listEmailProviderProfiles(db)[0]?.name, "Primary");
    assert.equal(listEmailSenderProfiles(db)[0]?.id, senderId);
    const sender = getDefaultSenderForDelivery(db, "auth");
    assert.equal(sender?.id, senderId);
    assert.equal(sender?.reply_to, "support@example.com");
    assert.equal(decryptAppSetting(sender?.api_key_ciphertext || ""), "re_secret_key");
    db.close();
  } finally {
    if (previousDbPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previousDbPath;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousKey === undefined) delete process.env.APP_SETTINGS_ENCRYPTION_KEY; else process.env.APP_SETTINGS_ENCRYPTION_KEY = previousKey;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
