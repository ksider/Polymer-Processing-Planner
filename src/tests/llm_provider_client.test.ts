import assert from "node:assert/strict";
import test from "node:test";
import {
  LlmProviderError,
  requestDoeInterpretation
} from "../modules/llm/provider_client.js";
import type { DoeInterpretationContext } from "../modules/llm/doe_interpretation_contract.js";
import type { LlmProviderProfileForUse } from "../modules/llm/provider_profiles_repo.js";

const context: DoeInterpretationContext = {
  contractVersion: "1.1",
  promptVersion: "1.4",
  source: {
    analysisId: 12,
    revisionId: 48,
    datasetRevision: "revision-hash",
    calculatedAt: "2026-10-05T10:00:00.000Z",
    engine: { name: "im-planner-r", version: "0.1.0" }
  },
  experiment: {
    description: "Assess the practical effect of melt temperature on quality."
  },
  design: {
    type: "factorial",
    totalRuns: 8,
    rowsAvailable: 8,
    rowsUsed: 8,
    rowsExcluded: 0,
    rowsMissingResponse: 0,
    replicateCount: 1,
    centerPoints: 0
  },
  model: {
    response: { key: "response:quality", label: "Quality", unit: "%", type: "continuous" },
    responseTransform: "none",
    family: "factorial",
    terms: [{ key: "main:factor:temperature", label: "Temperature" }],
    factors: [{ key: "factor:temperature", label: "Temperature", unit: "°C", coding: "two-level", levels: [190, 220] }],
    blocks: []
  },
  results: {
    metrics: [{ key: "r_squared", label: "R-squared", value: 0.91, evidenceId: "summary_metric:r_squared" }],
    anova: [],
    coefficients: [],
    warnings: [],
    diagnosticSummary: { evidenceId: "diagnostic_summary", count: 8, largestAbsoluteStandardizedResidual: 1.2, largestCooksDistance: 0.1 },
    optimizer: null,
    recommendations: []
  },
  evidence: [{ id: "summary_metric:r_squared", kind: "summary_metric", label: "R-squared", values: { key: "r_squared", value: 0.91 } }]
};

const profile: LlmProviderProfileForUse = {
  id: 4,
  name: "Mistral test",
  providerKind: "openai_compatible",
  baseUrl: "https://api.mistral.ai/v1",
  model: "mistral-small-latest",
  maxOutputTokens: 900,
  temperature: 0.2,
  timeoutMs: 12_000,
  enabled: true,
  defaultForDoe: true,
  hasApiKey: true,
  apiKey: "not-a-real-secret",
  createdByUserId: 1,
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-05T10:00:00.000Z"
};

test("Mistral-compatible adapter sends structured messages and records provider token counts", async () => {
  const result = await requestDoeInterpretation(profile, { context, locale: "en" }, async (input, init) => {
    assert.equal(String(input), "https://api.mistral.ai/v1/chat/completions");
    assert.equal(init?.headers && new Headers(init.headers).get("authorization"), "Bearer not-a-real-secret");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "mistral-small-latest");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.name, "doe_interpretation");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");
    assert.match(body.messages[1].content, /ANALYSIS_CONTEXT/);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: `Model output:\n\n\`\`\`json\n${JSON.stringify({
        summary: "The fitted model explains the observed response.",
        findings: [{
          claim: "Model fit is reported.",
          evidenceIds: ["summary_metric:r_squared"],
          confidence: "medium",
          interpretation: "R-squared is 0.91."
        }],
        cautions: [],
        nextSteps: [{ text: "Review diagnostics before changing the process.", kind: "inspect" }],
        clarifyingQuestions: []
      })}\n\`\`\`` } }],
      usage: { prompt_tokens: 120, completion_tokens: 58 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(result.interpretation.findings[0]?.evidenceIds[0], "summary_metric:r_squared");
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    outputTokens: 58,
    inputTokenSource: "provider",
    outputTokenSource: "provider"
  });
});

test("openai-compatible adapter refuses an insecure endpoint before a request", async () => {
  await assert.rejects(
    () => requestDoeInterpretation({ ...profile, baseUrl: "http://example.test/v1" }, { context, locale: "en" }),
    (error: unknown) => error instanceof LlmProviderError && error.code === "CONFIGURATION"
  );
});
