import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDoeInterpretationContext,
  createMockDoeInterpretation,
  DoeInterpretationContractError,
  validateDoeInterpretationResponse,
  type DoeInterpretationResponse
} from "../modules/llm/doe_interpretation_contract.js";
import type { DoeAnalysisRevisionRecord } from "../modules/doe_analysis/analysis_repo.js";

function fixtureRevision(): DoeAnalysisRevisionRecord {
  return {
    id: 7,
    analysisId: 4,
    status: "SUCCEEDED",
    datasetRevision: "dataset-revision-unique",
    contractVersion: "1.0",
    requestId: "request-7",
    engineName: "im-planner-r",
    engineVersion: "0.1.0",
    calculatedByUserId: 1,
    calculatedAt: "2026-10-05T09:00:00.000Z",
    specification: {
      responseKey: "response:quality",
      factorKeys: ["factor:temperature"],
      blockKeys: [],
      modelFamily: "factorial",
      modelTerms: ["main:factor:temperature"],
      useCodedFactors: true,
      includeExcluded: false,
      includeIncomplete: false,
      confidenceLevel: 0.95,
      responseTransform: "none",
      responseModel: "continuous"
    },
    dataset: {
      contractVersion: "1.0",
      datasetRevision: "dataset-revision-unique",
      experimentId: 9,
      doe: {
        id: 3,
        name: "Confidential DOE name",
        designType: "FFA",
        seed: 1,
        centerPoints: 0,
        maxRuns: 20,
        replicateCount: 1,
        recipeAsBlock: false
      },
      designMetadata: {},
      columns: [
        {
          key: "factor:temperature",
          code: "melt_temperature",
          label: "Melt temperature",
          unit: "°C",
          dataType: "number",
          role: "factor",
          source: { kind: "factor", paramDefinitionId: 1 },
          active: true,
          groupLabel: null,
          allowedValues: [],
          factor: { mode: "LIST", levels: [190, 220], coding: "two-level" }
        },
        {
          key: "response:quality",
          code: "quality",
          label: "Quality",
          unit: "%",
          dataType: "number",
          role: "response",
          source: { kind: "response", analysisFieldId: 2 },
          active: true,
          groupLabel: null,
          allowedValues: []
        }
      ],
      rows: [{
        runId: 1,
        runCode: "raw-run-secret-should-not-leave-planner",
        runOrder: 1,
        done: true,
        excluded: false,
        dueAt: null,
        recipeId: null,
        recipeName: null,
        replicateKey: null,
        replicateIndex: null,
        values: { "factor:temperature": 190, "response:quality": 91.25 },
        codedValues: { "factor:temperature": -1 },
        responseSources: { "response:quality": "measurement" }
      }],
      responseAudit: {
        counts: { measurement_only: 1, legacy_only: 0, equal: 0, conflict: 0, ambiguous_legacy: 0, missing: 0 },
        entries: [],
        hasConflicts: false,
        hasLegacyOnlyValues: false
      },
      warnings: []
    },
    result: {
      ok: true,
      contractVersion: "1.0",
      requestId: "request-7",
      datasetRevision: "dataset-revision-unique",
      engine: { name: "im-planner-r", version: "0.1.0", mode: "r", packages: {} },
      specification: {
        responseKey: "response:quality",
        factorKeys: ["factor:temperature"],
        blockKeys: [],
        modelFamily: "factorial",
        modelTerms: ["main:factor:temperature"],
        useCodedFactors: true,
        includeExcluded: false,
        includeIncomplete: false,
        confidenceLevel: 0.95,
        responseTransform: "none",
        responseModel: "continuous"
      },
      summary: {
        rowsAvailable: 8,
        rowsUsed: 8,
        rowsExcluded: 0,
        rowsMissingResponse: 0,
        metrics: [{ key: "r_squared", label: "R-squared", value: 0.91 }]
      },
      coefficients: [{ term: "main:factor:temperature", estimate: 2.4, standardError: 0.4, statistic: 6, pValue: 0.003, confidenceLow: 1.5, confidenceHigh: 3.3 }],
      anova: [{ term: "main:factor:temperature", degreesOfFreedom: 1, sumOfSquares: 8, meanSquare: 8, statistic: 36, pValue: 0.003 }],
      diagnostics: [{ runId: 1, fitted: 90, residual: 1.25, standardizedResidual: 1.2, leverage: 0.1, cooksDistance: 0.03 }],
      optimizer: null,
      recommendations: undefined,
      warnings: [{ code: "LOW_REPLICATION", message: "No pure-error estimate is available." }]
    },
    error: null
  };
}

test("DOE interpretation context is evidence-linked and excludes worksheet rows", () => {
  const context = buildDoeInterpretationContext(fixtureRevision());
  assert.equal(context.source.revisionId, 7);
  assert.equal(context.model.response.label, "Quality");
  assert.equal(context.results.anova[0]?.label, "Melt temperature");
  assert.ok(context.evidence.some((item) => item.id.startsWith("anova:")));
  assert.doesNotMatch(JSON.stringify(context), /raw-run-secret-should-not-leave-planner/);
  assert.doesNotMatch(JSON.stringify(context), /Confidential DOE name/);
  assert.equal("rows" in context, false);
});

test("mock DOE interpretation validates only known evidence IDs", () => {
  const context = buildDoeInterpretationContext(fixtureRevision());
  const response = createMockDoeInterpretation({ context, locale: "ru" });
  assert.equal(validateDoeInterpretationResponse(context, response).findings.length, 1);

  const invalid: DoeInterpretationResponse = {
    ...response,
    findings: [{
      claim: "Unsupported claim",
      interpretation: "Unsupported interpretation",
      confidence: "low",
      evidenceIds: ["unknown:evidence"]
    }]
  };
  assert.throws(
    () => validateDoeInterpretationResponse(context, invalid),
    DoeInterpretationContractError
  );
});
