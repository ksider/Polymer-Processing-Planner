import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../db.js";
import {
  createLlmProviderProfile,
  getLlmProviderProfileForUse,
  getLlmUsageTotalsForUser,
  listLlmProviderProfiles,
  recordLlmUsage,
  updateLlmProviderProfile
} from "../modules/llm/provider_profiles_repo.js";
import { decryptLlmSetting, encryptLlmSetting } from "../modules/llm/settings_crypto.js";

function createTestDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-planner-llm-"));
  process.env.DB_PATH = path.join(tempDir, "test.sqlite");
  process.env.LLM_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  return { db: openDb(), tempDir };
}

test("LLM credentials are encrypted and never returned from profile listing", () => {
  const { db, tempDir } = createTestDb();
  try {
    const profile = createLlmProviderProfile(db, {
      name: "Hosted model",
      providerKind: "openai_compatible",
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      maxOutputTokens: 1200,
      temperature: 0.2,
      timeoutMs: 30000,
      enabled: true,
      defaultForDoe: true,
      apiKey: "top-secret"
    });
    const stored = db.prepare("SELECT api_key_ciphertext FROM llm_provider_profiles WHERE id = ?")
      .get(profile.id) as { api_key_ciphertext: string };
    assert.notEqual(stored.api_key_ciphertext, "top-secret");
    assert.equal(listLlmProviderProfiles(db)[0]?.hasApiKey, true);
    assert.equal((listLlmProviderProfiles(db)[0] as Record<string, unknown>).apiKey, undefined);
    assert.equal(getLlmProviderProfileForUse(db, profile.id)?.apiKey, "top-secret");

    const second = createLlmProviderProfile(db, {
      name: "Local Ollama",
      providerKind: "ollama",
      baseUrl: "http://ollama:11434",
      model: "llama3.2",
      maxOutputTokens: 800,
      temperature: 0.1,
      timeoutMs: 30000,
      enabled: true,
      defaultForDoe: true
    });
    assert.equal(listLlmProviderProfiles(db).find((item) => item.id === profile.id)?.defaultForDoe, false);
    assert.equal(listLlmProviderProfiles(db).find((item) => item.id === second.id)?.defaultForDoe, true);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("LLM profile updates keep an existing key until explicitly replaced or cleared", () => {
  const { db, tempDir } = createTestDb();
  try {
    const profile = createLlmProviderProfile(db, {
      name: "Hosted model",
      providerKind: "openai_compatible",
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      maxOutputTokens: 1200,
      temperature: 0.2,
      timeoutMs: 30000,
      enabled: true,
      defaultForDoe: true,
      apiKey: "first-key"
    });
    updateLlmProviderProfile(db, profile.id, {
      name: "Renamed",
      providerKind: "openai_compatible",
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      maxOutputTokens: 1200,
      temperature: 0.2,
      timeoutMs: 30000,
      enabled: true,
      defaultForDoe: true
    });
    assert.equal(getLlmProviderProfileForUse(db, profile.id)?.apiKey, "first-key");

    updateLlmProviderProfile(db, profile.id, {
      name: "Renamed",
      providerKind: "openai_compatible",
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      maxOutputTokens: 1200,
      temperature: 0.2,
      timeoutMs: 30000,
      enabled: true,
      defaultForDoe: true,
      apiKey: null
    });
    assert.equal(getLlmProviderProfileForUse(db, profile.id)?.apiKey, null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("LLM usage retains provider and estimated token accounting per user", () => {
  const { db, tempDir } = createTestDb();
  try {
    const userId = Number(db.prepare(
      "INSERT INTO users (email, created_at) VALUES (?, ?)"
    ).run("analyst@example.test", new Date().toISOString()).lastInsertRowid);
    recordLlmUsage(db, {
      userId,
      providerProfileId: null,
      providerName: "Ollama",
      model: "llama3.2",
      purpose: "initial_interpretation",
      status: "succeeded",
      inputTokens: 120,
      outputTokens: 80,
      inputTokenSource: "provider",
      outputTokenSource: "provider"
    });
    recordLlmUsage(db, {
      userId,
      providerProfileId: null,
      providerName: "Hosted model",
      model: "small-model",
      purpose: "follow_up",
      status: "failed",
      inputTokens: 40,
      outputTokens: null,
      inputTokenSource: "estimated",
      outputTokenSource: "unknown"
    });
    assert.deepEqual(getLlmUsageTotalsForUser(db, userId), {
      inputTokens: 160,
      outputTokens: 80,
      totalTokens: 240,
      requestCount: 2
    });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("LLM setting cipher rejects a different encryption key", () => {
  const keyOne = Buffer.alloc(32, 3).toString("base64");
  const keyTwo = Buffer.alloc(32, 4).toString("base64");
  const encrypted = encryptLlmSetting("secret", { LLM_SETTINGS_ENCRYPTION_KEY: keyOne });
  assert.equal(decryptLlmSetting(encrypted, { LLM_SETTINGS_ENCRYPTION_KEY: keyOne }), "secret");
  assert.throws(() => decryptLlmSetting(encrypted, { LLM_SETTINGS_ENCRYPTION_KEY: keyTwo }));
});
