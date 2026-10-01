import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAnalyticsRequest,
  createDoeAnalyticsClient,
  DoeAnalyticsValidationError,
  MockDoeAnalyticsClient,
  isDoeAnalysisV2Enabled,
  normalizeAnalysisSpecification,
  type DoeAnalysisDataset
} from "../modules/doe_analysis/index.js";

test("analytics contract chooses design-aware defaults and mock preserves request identity", async () => {
  const dataset = fixtureDataset("BBD");
  const request = createAnalyticsRequest(dataset, null, "request-fixture");

  assert.equal(request.specification.modelFamily, "response_surface");
  assert.equal(request.specification.useCodedFactors, true);
  assert.equal(request.specification.responseKey, "response:1");
  assert.deepEqual(request.specification.factorKeys, ["factor:1", "factor:2"]);

  const result = await new MockDoeAnalyticsClient().analyze(request);
  assert.equal(result.ok, true);
  assert.equal(result.requestId, "request-fixture");
  assert.equal(result.datasetRevision, dataset.datasetRevision);
  assert.equal(result.summary.rowsAvailable, 1);
  assert.equal(result.summary.rowsUsed, 1);
  assert.equal(result.summary.rowsExcluded, 2);
  assert.equal(result.warnings[0]?.code, "MOCK_ENGINE");
});

test("analytics specification rejects unknown columns and invalid model options", () => {
  const dataset = fixtureDataset("FFA");
  assert.throws(
    () => normalizeAnalysisSpecification(dataset, {
      responseKey: "response:missing",
      factorKeys: ["factor:1", "factor:missing"],
      confidenceLevel: 1
    }),
    (error: unknown) => {
      assert.ok(error instanceof DoeAnalyticsValidationError);
      assert.equal(error.issues.length, 3);
      return true;
    }
  );
});

test("default analysis prefers the populated numeric response", () => {
  const dataset = fixtureDataset("FFA");
  dataset.columns.push(column("response:2", "response", "number"));
  for (const row of dataset.rows) {
    row.values["response:1"] = null;
    row.values["response:2"] = 20 + row.runId;
    row.responseSources["response:2"] = "measurement";
  }
  const request = createAnalyticsRequest(dataset, null, "populated-response");
  assert.equal(request.specification.responseKey, "response:2");
});

test("analytics client mode is explicit and production defaults to HTTP", () => {
  assert.ok(createDoeAnalyticsClient({ NODE_ENV: "test" }) instanceof MockDoeAnalyticsClient);
  assert.equal(createDoeAnalyticsClient({ NODE_ENV: "production" }).constructor.name, "HttpDoeAnalyticsClient");
  assert.throws(
    () => createDoeAnalyticsClient({ DOE_ANALYTICS_MODE: "invalid" }),
    /Unsupported DOE_ANALYTICS_MODE/
  );
});

test("Analysis V2 workspace flag is safe by default in production", () => {
  assert.equal(isDoeAnalysisV2Enabled({ NODE_ENV: "production" }), false);
  assert.equal(isDoeAnalysisV2Enabled({ NODE_ENV: "development" }), true);
  assert.equal(isDoeAnalysisV2Enabled({ NODE_ENV: "production", DOE_ANALYSIS_V2_ENABLED: "true" }), true);
  assert.equal(isDoeAnalysisV2Enabled({ NODE_ENV: "test", DOE_ANALYSIS_V2_ENABLED: "off" }), false);
});

function fixtureDataset(designType: string): DoeAnalysisDataset {
  return {
    contractVersion: "1.0",
    datasetRevision: "fixture-revision",
    experimentId: 1,
    doe: {
      id: 2,
      name: "Contract fixture",
      designType,
      seed: 42,
      centerPoints: 3,
      maxRuns: 20,
      replicateCount: 1,
      recipeAsBlock: false
    },
    designMetadata: {},
    columns: [
      column("factor:1", "factor", "number"),
      column("factor:2", "factor", "number"),
      column("response:1", "response", "number")
    ],
    rows: [
      row(1, true, false, 10),
      row(2, false, false, 11),
      row(3, true, true, 12)
    ],
    responseAudit: {
      counts: {
        measurement_only: 3,
        legacy_only: 0,
        equal: 0,
        conflict: 0,
        ambiguous_legacy: 0,
        missing: 0
      },
      entries: [],
      hasConflicts: false,
      hasLegacyOnlyValues: false
    },
    warnings: []
  };
}

function column(
  key: string,
  role: "factor" | "response",
  dataType: "number"
): DoeAnalysisDataset["columns"][number] {
  return {
    key,
    code: key,
    label: key,
    unit: null,
    dataType,
    role,
    source: role === "factor"
      ? { kind: "factor", paramDefinitionId: Number(key.split(":")[1]) }
      : { kind: "response", analysisFieldId: Number(key.split(":")[1]) },
    active: true,
    groupLabel: null,
    allowedValues: [],
    factor: role === "factor"
      ? { mode: "RANGE", levels: [-1, 1], coding: "two-level" }
      : undefined
  };
}

function row(
  runId: number,
  done: boolean,
  excluded: boolean,
  response: number
): DoeAnalysisDataset["rows"][number] {
  return {
    runId,
    runCode: `R${runId}`,
    runOrder: runId,
    done,
    excluded,
    dueAt: null,
    recipeId: null,
    recipeName: null,
    replicateKey: null,
    replicateIndex: null,
    values: {
      "factor:1": -1,
      "factor:2": 1,
      "response:1": response
    },
    codedValues: {
      "factor:1": -1,
      "factor:2": 1
    },
    responseSources: { "response:1": "measurement" }
  };
}
