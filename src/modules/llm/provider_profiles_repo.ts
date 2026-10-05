import type { Db } from "../../db.js";
import { decryptLlmSetting, encryptLlmSetting } from "./settings_crypto.js";

export type LlmProviderKind = "openai_compatible" | "ollama";
export type LlmProviderProfile = {
  id: number;
  name: string;
  providerKind: LlmProviderKind;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  enabled: boolean;
  defaultForDoe: boolean;
  hasApiKey: boolean;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type LlmProviderProfileForUse = LlmProviderProfile & { apiKey: string | null };

export type SaveLlmProviderProfileInput = {
  name: string;
  providerKind: LlmProviderKind;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  enabled: boolean;
  defaultForDoe: boolean;
  apiKey?: string | null;
  createdByUserId?: number | null;
};

export type LlmUsagePurpose = "initial_interpretation" | "clarification" | "follow_up";
export type LlmUsageStatus = "succeeded" | "failed";
export type LlmTokenSource = "provider" | "estimated" | "unknown";

export type RecordLlmUsageInput = {
  userId: number | null;
  providerProfileId: number | null;
  providerName: string;
  model: string;
  analysisId?: number | null;
  revisionId?: number | null;
  purpose: LlmUsagePurpose;
  status: LlmUsageStatus;
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputTokenSource?: LlmTokenSource;
  outputTokenSource?: LlmTokenSource;
};

export type LlmUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
};

type ProviderProfileRow = {
  id: number;
  name: string;
  provider_kind: LlmProviderKind;
  base_url: string;
  api_key_ciphertext: string | null;
  model: string;
  max_output_tokens: number;
  temperature: number;
  timeout_ms: number;
  enabled: number;
  default_for_doe: number;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

function mapProfile(row: ProviderProfileRow): LlmProviderProfile {
  return {
    id: row.id,
    name: row.name,
    providerKind: row.provider_kind,
    baseUrl: row.base_url,
    model: row.model,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    timeoutMs: row.timeout_ms,
    enabled: row.enabled === 1,
    defaultForDoe: row.default_for_doe === 1,
    hasApiKey: Boolean(row.api_key_ciphertext),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getProfileRow(db: Db, profileId: number): ProviderProfileRow | null {
  return db.prepare("SELECT * FROM llm_provider_profiles WHERE id = ?").get(profileId) as ProviderProfileRow | undefined ?? null;
}

export function listLlmProviderProfiles(db: Db): LlmProviderProfile[] {
  const rows = db.prepare(
    "SELECT * FROM llm_provider_profiles ORDER BY default_for_doe DESC, enabled DESC, name COLLATE NOCASE, id"
  ).all() as ProviderProfileRow[];
  return rows.map(mapProfile);
}

export function getLlmProviderProfile(db: Db, profileId: number): LlmProviderProfile | null {
  const row = getProfileRow(db, profileId);
  return row ? mapProfile(row) : null;
}

export function getLlmProviderProfileForUse(db: Db, profileId: number): LlmProviderProfileForUse | null {
  const row = getProfileRow(db, profileId);
  if (!row) return null;
  return {
    ...mapProfile(row),
    apiKey: row.api_key_ciphertext ? decryptLlmSetting(row.api_key_ciphertext) : null
  };
}

export function getDefaultDoeLlmProviderProfileForUse(db: Db): LlmProviderProfileForUse | null {
  const row = db.prepare(
    "SELECT * FROM llm_provider_profiles WHERE enabled = 1 AND default_for_doe = 1 LIMIT 1"
  ).get() as ProviderProfileRow | undefined;
  if (!row) return null;
  return {
    ...mapProfile(row),
    apiKey: row.api_key_ciphertext ? decryptLlmSetting(row.api_key_ciphertext) : null
  };
}

export function createLlmProviderProfile(db: Db, input: SaveLlmProviderProfileInput): LlmProviderProfile {
  const now = new Date().toISOString();
  const apiKeyCiphertext = normalizeApiKey(input.apiKey);
  const transaction = db.transaction(() => {
    if (input.defaultForDoe) db.prepare("UPDATE llm_provider_profiles SET default_for_doe = 0").run();
    const result = db.prepare(
      `INSERT INTO llm_provider_profiles
       (name, provider_kind, base_url, api_key_ciphertext, model, max_output_tokens, temperature,
        timeout_ms, enabled, default_for_doe, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.name,
      input.providerKind,
      input.baseUrl,
      apiKeyCiphertext,
      input.model,
      input.maxOutputTokens,
      input.temperature,
      input.timeoutMs,
      input.enabled ? 1 : 0,
      input.defaultForDoe ? 1 : 0,
      input.createdByUserId ?? null,
      now,
      now
    );
    return Number(result.lastInsertRowid);
  });
  const profileId = transaction();
  const created = getLlmProviderProfile(db, profileId);
  if (!created) throw new Error("Created LLM provider profile could not be loaded.");
  return created;
}

export function updateLlmProviderProfile(
  db: Db,
  profileId: number,
  input: Omit<SaveLlmProviderProfileInput, "createdByUserId">
): LlmProviderProfile | null {
  const current = getProfileRow(db, profileId);
  if (!current) return null;
  const apiKeyCiphertext = input.apiKey === undefined
    ? current.api_key_ciphertext
    : normalizeApiKey(input.apiKey);
  const now = new Date().toISOString();
  db.transaction(() => {
    if (input.defaultForDoe) {
      db.prepare("UPDATE llm_provider_profiles SET default_for_doe = 0 WHERE id <> ?").run(profileId);
    }
    db.prepare(
      `UPDATE llm_provider_profiles
       SET name = ?, provider_kind = ?, base_url = ?, api_key_ciphertext = ?, model = ?,
           max_output_tokens = ?, temperature = ?, timeout_ms = ?, enabled = ?,
           default_for_doe = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.name,
      input.providerKind,
      input.baseUrl,
      apiKeyCiphertext,
      input.model,
      input.maxOutputTokens,
      input.temperature,
      input.timeoutMs,
      input.enabled ? 1 : 0,
      input.defaultForDoe ? 1 : 0,
      now,
      profileId
    );
  })();
  return getLlmProviderProfile(db, profileId);
}

export function deleteLlmProviderProfile(db: Db, profileId: number): boolean {
  return db.prepare("DELETE FROM llm_provider_profiles WHERE id = ?").run(profileId).changes > 0;
}

export function recordLlmUsage(db: Db, input: RecordLlmUsageInput): void {
  const inputTokens = normalizeTokenCount(input.inputTokens);
  const outputTokens = normalizeTokenCount(input.outputTokens);
  const totalTokens = inputTokens === null && outputTokens === null
    ? null
    : (inputTokens ?? 0) + (outputTokens ?? 0);
  db.prepare(
    `INSERT INTO llm_usage_events
     (user_id, provider_profile_id, provider_name, model, analysis_id, revision_id, purpose, status,
      input_tokens, output_tokens, total_tokens, input_token_source, output_token_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.userId,
    input.providerProfileId,
    input.providerName,
    input.model,
    input.analysisId ?? null,
    input.revisionId ?? null,
    input.purpose,
    input.status,
    inputTokens,
    outputTokens,
    totalTokens,
    input.inputTokenSource ?? (inputTokens === null ? "unknown" : "provider"),
    input.outputTokenSource ?? (outputTokens === null ? "unknown" : "provider"),
    new Date().toISOString()
  );
}

export function getLlmUsageTotalsForUser(
  db: Db,
  userId: number,
  from?: string,
  to?: string
): LlmUsageTotals {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COUNT(*) AS request_count
     FROM llm_usage_events
     WHERE user_id = ?
       AND (? IS NULL OR created_at >= ?)
       AND (? IS NULL OR created_at < ?)`
  ).get(userId, from ?? null, from ?? null, to ?? null, to ?? null) as {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    request_count: number;
  };
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    requestCount: row.request_count
  };
}

function normalizeApiKey(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? encryptLlmSetting(trimmed) : null;
}

function normalizeTokenCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("LLM token counts must be non-negative integers.");
  }
  return value;
}
