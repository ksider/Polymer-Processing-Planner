import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import {
  DOE_ANALYTICS_CONTRACT_VERSION,
  type DoeAnalyticsHealth,
  type DoeAnalyticsRequest,
  type DoeAnalyticsResponse,
  type DoeAnalyticsSuccess,
  isDoeAnalyticsResponse
} from "./analytics_contract.js";

export interface DoeAnalyticsClient {
  health(): Promise<DoeAnalyticsHealth>;
  analyze(request: DoeAnalyticsRequest): Promise<DoeAnalyticsResponse>;
}

export class DoeAnalyticsServiceError extends Error {
  readonly code: "ANALYTICS_UNAVAILABLE" | "INVALID_ANALYTICS_RESPONSE";
  readonly retryable: boolean;

  constructor(
    code: "ANALYTICS_UNAVAILABLE" | "INVALID_ANALYTICS_RESPONSE",
    message: string,
    retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DoeAnalyticsServiceError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class MockDoeAnalyticsClient implements DoeAnalyticsClient {
  async health(): Promise<DoeAnalyticsHealth> {
    return {
      status: "ok",
      contractVersion: DOE_ANALYTICS_CONTRACT_VERSION,
      engine: mockEngine()
    };
  }

  async analyze(request: DoeAnalyticsRequest): Promise<DoeAnalyticsSuccess> {
    const responseKey = request.specification.responseKey;
    const availableRows = request.dataset.rows.filter((row) =>
      (request.specification.includeExcluded || !row.excluded) &&
      (request.specification.includeIncomplete || row.done)
    );
    const usedRows = availableRows.filter((row) => typeof row.values[responseKey] === "number");
    return {
      ok: true,
      contractVersion: DOE_ANALYTICS_CONTRACT_VERSION,
      requestId: request.requestId,
      datasetRevision: request.dataset.datasetRevision,
      engine: mockEngine(),
      specification: request.specification,
      summary: {
        rowsAvailable: availableRows.length,
        rowsUsed: usedRows.length,
        rowsExcluded: request.dataset.rows.length - availableRows.length,
        rowsMissingResponse: availableRows.length - usedRows.length,
        metrics: []
      },
      coefficients: [],
      anova: [],
      diagnostics: [],
      plots: {
        mainEffects: [],
        meanByFactor: [],
        interactions: [],
        qq: [],
        residualOrder: [],
        surface: null,
        surfaces: []
      },
      warnings: [
        {
          code: "MOCK_ENGINE",
          message: "Statistical calculations are disabled; this result only validates the integration contract."
        }
      ]
    };
  }
}

export class HttpDoeAnalyticsClient implements DoeAnalyticsClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 15_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async health(): Promise<DoeAnalyticsHealth> {
    const response = await this.fetchJson("/health", { method: "GET" });
    if (!isRecord(response) || response.status !== "ok" || !isRecord(response.engine)) {
      throw new DoeAnalyticsServiceError(
        "INVALID_ANALYTICS_RESPONSE",
        "Analytics health response does not match the expected contract.",
        false
      );
    }
    return response as DoeAnalyticsHealth;
  }

  async analyze(request: DoeAnalyticsRequest): Promise<DoeAnalyticsResponse> {
    const response = await this.fetchJson("/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": request.requestId
      },
      body: JSON.stringify(request)
    });
    if (!isDoeAnalyticsResponse(response) || response.requestId !== request.requestId) {
      throw new DoeAnalyticsServiceError(
        "INVALID_ANALYTICS_RESPONSE",
        "Analytics result does not match the expected contract or request ID.",
        false
      );
    }
    return response;
  }

  private async fetchJson(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal
      });
      const body = await response.text();
      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch (error) {
        throw new DoeAnalyticsServiceError(
          "INVALID_ANALYTICS_RESPONSE",
          `Analytics service returned non-JSON data with status ${response.status}.`,
          false,
          { cause: error }
        );
      }
      if (!response.ok) {
        if (isDoeAnalyticsResponse(parsed) && parsed.ok === false) return parsed;
        throw new DoeAnalyticsServiceError(
          "ANALYTICS_UNAVAILABLE",
          `Analytics service returned HTTP ${response.status}.`,
          response.status >= 500
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof DoeAnalyticsServiceError) throw error;
      const message = error instanceof Error && error.name === "AbortError"
        ? `Analytics request timed out after ${this.timeoutMs} ms.`
        : "Analytics service is unavailable.";
      throw new DoeAnalyticsServiceError(
        "ANALYTICS_UNAVAILABLE",
        message,
        true,
        { cause: error }
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class RscriptDoeAnalyticsClient implements DoeAnalyticsClient {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 15_000) {
    this.timeoutMs = timeoutMs;
  }

  async health(): Promise<DoeAnalyticsHealth> {
    const response = await runLocalRscript("--health", "", this.timeoutMs);
    if (!isRecord(response) || response.status !== "ok" || !isRecord(response.engine)) {
      throw new DoeAnalyticsServiceError(
        "INVALID_ANALYTICS_RESPONSE",
        "Local R health response does not match the expected contract.",
        false
      );
    }
    return response as DoeAnalyticsHealth;
  }

  async analyze(request: DoeAnalyticsRequest): Promise<DoeAnalyticsResponse> {
    const response = await runLocalRscript("--analyze", JSON.stringify(request), this.timeoutMs);
    if (!isDoeAnalyticsResponse(response) || response.requestId !== request.requestId) {
      throw new DoeAnalyticsServiceError(
        "INVALID_ANALYTICS_RESPONSE",
        "Local R result does not match the expected contract or request ID.",
        false
      );
    }
    return response;
  }
}

export function createDoeAnalyticsClient(env: NodeJS.ProcessEnv = process.env): DoeAnalyticsClient {
  const defaultMode = env.NODE_ENV === "production"
    ? "http"
    : env.NODE_ENV === "test"
      ? "mock"
      : canUseLocalRscript(env)
        ? "rscript"
        : "mock";
  const mode = String(env.DOE_ANALYTICS_MODE ?? defaultMode)
    .trim()
    .toLowerCase();
  if (mode === "mock") return new MockDoeAnalyticsClient();
  const configuredTimeout = Number(env.DOE_ANALYTICS_TIMEOUT_MS ?? 15_000);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 15_000;
  if (mode === "rscript") return new RscriptDoeAnalyticsClient(timeout);
  if (mode !== "http") {
    throw new Error(`Unsupported DOE_ANALYTICS_MODE: ${mode}. Use mock, rscript, or http.`);
  }
  const url = String(env.DOE_ANALYTICS_URL ?? "http://analytics-r:8000").trim();
  return new HttpDoeAnalyticsClient(url, timeout);
}

function canUseLocalRscript(env: NodeJS.ProcessEnv): boolean {
  const paths = localRPaths();
  const result = spawnSync(
    "Rscript",
    ["-e", "quit(status=if(requireNamespace('jsonlite', quietly=TRUE)) 0 else 1)"],
    {
      cwd: paths.analyticsDir,
      env: localREnvironment(env, paths.libraryDir),
      stdio: "ignore",
      timeout: 3_000
    }
  );
  return result.status === 0;
}

async function runLocalRscript(mode: string, input: string, timeoutMs: number): Promise<unknown> {
  const paths = localRPaths();
  return new Promise((resolve, reject) => {
    const child = spawn("Rscript", [paths.runnerPath, mode], {
      cwd: paths.analyticsDir,
      env: localREnvironment(process.env, paths.libraryDir),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new DoeAnalyticsServiceError(
        "ANALYTICS_UNAVAILABLE",
        `Local R calculation timed out after ${timeoutMs} ms.`,
        true
      ));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 20 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new DoeAnalyticsServiceError(
          "INVALID_ANALYTICS_RESPONSE",
          "Local R result exceeded the 20 MB limit.",
          false
        ));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(new DoeAnalyticsServiceError(
      "ANALYTICS_UNAVAILABLE",
      "Unable to start local Rscript.",
      true,
      { cause: error }
    )));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new DoeAnalyticsServiceError(
          "ANALYTICS_UNAVAILABLE",
          detail ? `Local R failed: ${detail.slice(0, 500)}` : `Local R exited with code ${code}.`,
          false
        ));
        return;
      }
      try {
        finish(undefined, JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        finish(new DoeAnalyticsServiceError(
          "INVALID_ANALYTICS_RESPONSE",
          "Local R returned invalid JSON.",
          false,
          { cause: error }
        ));
      }
    });
    child.stdin.end(input);
  });
}

function localRPaths() {
  const analyticsDir = path.resolve(process.cwd(), "analytics-r");
  return {
    analyticsDir,
    libraryDir: path.join(analyticsDir, "library"),
    runnerPath: path.join(analyticsDir, "local_runner.R")
  };
}

function localREnvironment(env: NodeJS.ProcessEnv, libraryDir: string): NodeJS.ProcessEnv {
  const existing = String(env.R_LIBS_USER ?? "").trim();
  return {
    ...env,
    R_LIBS_USER: existing ? `${libraryDir}${path.delimiter}${existing}` : libraryDir
  };
}

function mockEngine() {
  return {
    name: "planner-contract-mock",
    version: "1.0.0",
    mode: "mock" as const,
    packages: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
