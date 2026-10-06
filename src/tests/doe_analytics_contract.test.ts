import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAnalyticsRequest,
  createDoeAnalyticsClient,
  defaultAnalysisSpecification,
  DoeAnalyticsValidationError,
  isModelFamilySupportedByDataset,
  modelFamilyOptionsForDataset,
  MockDoeAnalyticsClient,
  isDoeAnalysisV2Enabled,
  normalizeAnalysisSpecification,
  type DoeAnalysisDataset
} from "../modules/doe_analysis/index.js";
import { scoreMultiResponseCandidate } from "../modules/doe_analysis/multi_response_optimizer.js";
import { specificationToTemplate, templateToSpecification } from "../modules/doe_analysis/templates_repo.js";

test("multi-response desirability exposes each response trade-off", () => {
  const scored = scoreMultiResponseCandidate([
    { responseKey: "response:quality", objective: "maximize", importance: 2, observedMin: 0, observedMax: 100 },
    { responseKey: "response:cycle", objective: "minimize", importance: 1, observedMin: 10, observedMax: 30 }
  ], [
    { responseKey: "response:quality", predicted: 80 },
    { responseKey: "response:cycle", predicted: 15 }
  ]);
  assert.equal(scored.components["response:quality"], 0.8);
  assert.equal(scored.components["response:cycle"], 0.75);
  assert.ok(scored.desirability > 0 && scored.desirability < 1);
});

test("analytics contract chooses design-aware defaults and mock preserves request identity", async () => {
  const dataset = fixtureDataset("BBD");
  const request = createAnalyticsRequest(dataset, null, "request-fixture");

  assert.equal(request.specification.modelFamily, "response_surface");
  assert.equal(request.specification.useCodedFactors, true);
  assert.equal(request.specification.responseKey, "response:1");
  assert.equal(request.specification.responseModel, "continuous");
  assert.deepEqual(request.specification.factorKeys, ["factor:1", "factor:2"]);
  assert.deepEqual(request.specification.modelTerms, [
    "main:factor:1",
    "main:factor:2",
    "interaction:factor:1|factor:2",
    "quadratic:factor:1",
    "quadratic:factor:2"
  ]);

  const result = await new MockDoeAnalyticsClient().analyze(request);
  assert.equal(result.ok, true);
  assert.equal(result.requestId, "request-fixture");
  assert.equal(result.datasetRevision, dataset.datasetRevision);
  assert.equal(result.summary.rowsAvailable, 1);
  assert.equal(result.summary.rowsUsed, 1);
  assert.equal(result.summary.rowsExcluded, 2);
  assert.equal(result.warnings[0]?.code, "MOCK_ENGINE");
});

test("model families are constrained by DOE design and SCREEN defaults to main effects", () => {
  const expected = {
    SIM: ["regression"],
    FFA: ["factorial", "regression"],
    BBD: ["response_surface", "regression"],
    SCREEN: ["regression"]
  } as const;
  for (const [designType, families] of Object.entries(expected)) {
    const dataset = fixtureDataset(designType);
    assert.deepEqual(modelFamilyOptionsForDataset(dataset).map((option) => option.value), families);
    assert.equal(defaultAnalysisSpecification(dataset).modelFamily, families[0]);
  }

  const screen = fixtureDataset("SCREEN");
  assert.equal(isModelFamilySupportedByDataset(screen, "factorial"), false);
  assert.doesNotThrow(() => normalizeAnalysisSpecification(screen, { modelFamily: "factorial" }));
  assert.throws(
    () => createAnalyticsRequest(screen, { modelFamily: "factorial" }),
    (error: unknown) => error instanceof DoeAnalyticsValidationError &&
      error.issues.includes("factorial is not applicable to a SCREEN design. Choose: Screening (main effects).")
  );
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

test("analysis specification supports a hierarchical subset of model terms", () => {
  const dataset = fixtureDataset("BBD");
  const specification = normalizeAnalysisSpecification(dataset, {
    modelFamily: "response_surface",
    factorKeys: ["factor:1", "factor:2"],
    modelTerms: ["main:factor:1", "main:factor:2", "interaction:factor:1|factor:2"]
  });
  assert.deepEqual(specification.modelTerms, [
    "main:factor:1",
    "main:factor:2",
    "interaction:factor:1|factor:2"
  ]);
  assert.throws(
    () => normalizeAnalysisSpecification(dataset, {
      modelFamily: "response_surface",
      factorKeys: ["factor:1", "factor:2"],
      modelTerms: ["main:factor:1", "interaction:factor:1|factor:2"]
    }),
    (error: unknown) => error instanceof DoeAnalyticsValidationError &&
      error.issues.includes("Interaction interaction:factor:1|factor:2 requires both corresponding main effects.")
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

test("analysis specification preserves a reproducible derived numeric response", async () => {
  const dataset = fixtureDataset("FFA");
  dataset.columns.push(column("response:2", "response", "number"));
  for (const row of dataset.rows) {
    row.values["response:2"] = 2;
    row.responseSources["response:2"] = "measurement";
  }
  const specification = normalizeAnalysisSpecification(dataset, {
    ...defaultAnalysisSpecification(dataset),
    responseKey: "response:1",
    derivedResponse: { operation: "difference", leftKey: "response:1", rightKey: "response:2" }
  });
  assert.deepEqual(specification.derivedResponse, {
    operation: "difference",
    leftKey: "response:1",
    rightKey: "response:2"
  });
  const result = await new MockDoeAnalyticsClient().analyze(createAnalyticsRequest(dataset, specification, "derived-response"));
  assert.equal(result.ok, true);
  assert.equal(result.summary.rowsUsed, 1);
  assert.throws(
    () => normalizeAnalysisSpecification(dataset, {
      ...specification,
      derivedResponse: { operation: "ratio", leftKey: "response:1", rightKey: "response:1" }
    }),
    (error: unknown) => error instanceof DoeAnalyticsValidationError &&
      error.issues.includes("A derived response must use two different measured responses.")
  );
});

test("boolean responses select the binary model and use boolean observations", async () => {
  const dataset = fixtureDataset("FFA");
  dataset.columns[2] = { ...dataset.columns[2], dataType: "boolean" };
  for (const [index, row] of dataset.rows.entries()) row.values["response:1"] = index % 2 === 0;
  const specification = defaultAnalysisSpecification(dataset);
  assert.equal(specification.responseModel, "binary");
  const result = await new MockDoeAnalyticsClient().analyze(createAnalyticsRequest(dataset, specification, "boolean-response"));
  assert.equal(result.ok, true);
  assert.equal(result.summary.rowsUsed, 1);
});

test("tag presence is normalized as a binary response", async () => {
  const dataset = fixtureDataset("FFA");
  dataset.columns[2] = { ...dataset.columns[2], dataType: "tags", allowedValues: ["flash", "short shot"] };
  for (const [index, row] of dataset.rows.entries()) row.values["response:1"] = index % 2 === 0 ? ["flash"] : [];
  const specification = defaultAnalysisSpecification(dataset);
  assert.equal(specification.responseModel, "binary");
  assert.deepEqual(specification.tagResponse, { tag: "flash" });
  const result = await new MockDoeAnalyticsClient().analyze(createAnalyticsRequest(dataset, specification, "tag-response"));
  assert.equal(result.ok, true);
  assert.equal(result.summary.rowsUsed, 1);
});

test("process-type template maps field codes onto the current DOE field keys", () => {
  const source = fixtureDataset("FFA");
  const template = specificationToTemplate(source, defaultAnalysisSpecification(source));
  const target = structuredClone(source);
  const keyMap: Record<string, string> = {
    "factor:1": "factor:101",
    "factor:2": "factor:102",
    "response:1": "response:201"
  };
  target.columns = target.columns.map((column) => ({ ...column, key: keyMap[column.key] || column.key }));
  target.rows = target.rows.map((row) => ({
    ...row,
    values: Object.fromEntries(Object.entries(row.values).map(([key, value]) => [keyMap[key] || key, value])),
    codedValues: Object.fromEntries(Object.entries(row.codedValues).map(([key, value]) => [keyMap[key] || key, value])),
    responseSources: Object.fromEntries(Object.entries(row.responseSources).map(([key, value]) => [keyMap[key] || key, value]))
  }));
  const applied = templateToSpecification(target, template);
  assert.equal(applied.responseKey, "response:201");
  assert.deepEqual(applied.factorKeys, ["factor:101", "factor:102"]);
  assert.deepEqual(applied.modelTerms, ["main:factor:101", "main:factor:102", "interaction:factor:101|factor:102"]);
});

test("analysis specification preserves a categorical execution block", () => {
  const dataset = fixtureDataset("FFA");
  dataset.columns.push({
    key: "block:batch",
    code: "batch",
    label: "Batch",
    unit: null,
    dataType: "category",
    role: "block",
    source: { kind: "recipe" },
    active: true,
    groupLabel: null,
    allowedValues: ["A", "B"]
  });
  for (const [index, row] of dataset.rows.entries()) row.values["block:batch"] = index === 0 ? "A" : "B";

  const specification = normalizeAnalysisSpecification(dataset, {
    ...defaultAnalysisSpecification(dataset),
    blockKeys: ["block:batch"]
  });
  assert.deepEqual(specification.blockKeys, ["block:batch"]);
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
