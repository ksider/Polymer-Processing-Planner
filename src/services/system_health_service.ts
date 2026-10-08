import type { Db } from "../db.js";
import { isEmailConfigured } from "./email.js";
import {
  createDoeAnalyticsClient,
  type DoeAnalyticsClient
} from "../modules/doe_analysis/analytics_client.js";
import { hasLlmSettingsEncryptionKey } from "../modules/llm/settings_crypto.js";

export type HealthStatus = "healthy" | "warning" | "unknown";

export type RecentBackgroundJob = {
  id: number;
  analysisId: number;
  doeId: number;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type SystemHealthOverview = {
  database: { status: HealthStatus };
  analytics: { status: HealthStatus; mode: string };
  smtp: { configured: boolean };
  aiSettings: { configured: boolean };
  jobs: {
    queued: number;
    running: number;
    failed: number;
    succeeded: number;
    cancelled: number;
  };
  recentJobs: RecentBackgroundJob[];
};

type JobCountRow = { status: RecentBackgroundJob["status"]; count: number };
type RecentJobRow = {
  id: number;
  analysis_id: number;
  doe_id: number;
  status: RecentBackgroundJob["status"];
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function analyticsMode(): string {
  const configured = String(process.env.DOE_ANALYTICS_MODE ?? "").trim().toLowerCase();
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? "http" : "automatic";
}

function safeErrorCode(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : "JOB_FAILED";
  } catch {
    return "JOB_FAILED";
  }
}

function jobSummary(db: Db): Pick<SystemHealthOverview, "jobs" | "recentJobs"> {
  const jobs: SystemHealthOverview["jobs"] = {
    queued: 0,
    running: 0,
    failed: 0,
    succeeded: 0,
    cancelled: 0
  };
  const rows = db.prepare(
    "SELECT status, COUNT(*) as count FROM doe_analysis_jobs GROUP BY status"
  ).all() as JobCountRow[];
  rows.forEach((row) => {
    const key = row.status.toLowerCase() as keyof typeof jobs;
    if (key in jobs) jobs[key] = Number(row.count || 0);
  });
  const recentRows = db.prepare(
    `SELECT id, analysis_id, doe_id, status, error_json, created_at, started_at, finished_at
     FROM doe_analysis_jobs
     ORDER BY id DESC
     LIMIT 12`
  ).all() as RecentJobRow[];
  return {
    jobs,
    recentJobs: recentRows.map((row) => ({
      id: row.id,
      analysisId: row.analysis_id,
      doeId: row.doe_id,
      status: row.status,
      errorCode: safeErrorCode(row.error_json),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    }))
  };
}

export function getSystemHealthOverview(db: Db): SystemHealthOverview {
  let databaseStatus: HealthStatus = "healthy";
  try {
    db.prepare("SELECT 1").get();
  } catch {
    databaseStatus = "warning";
  }
  const background = jobSummary(db);
  return {
    database: { status: databaseStatus },
    analytics: { status: "unknown", mode: analyticsMode() },
    smtp: { configured: isEmailConfigured(db) },
    aiSettings: { configured: hasLlmSettingsEncryptionKey() },
    ...background
  };
}

export async function runSystemHealthChecks(
  db: Db,
  analyticsClient: DoeAnalyticsClient = createDoeAnalyticsClient()
) {
  const overview = getSystemHealthOverview(db);
  let analytics: {
    status: HealthStatus;
    checkedAt: string;
    engine: string | null;
    message: string;
  };
  try {
    const result = await analyticsClient.health();
    analytics = {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      engine: result.engine.name || null,
      message: "Analytics service responded to its health check."
    };
  } catch {
    analytics = {
      status: "warning",
      checkedAt: new Date().toISOString(),
      engine: null,
      message: "Analytics service did not complete its health check."
    };
  }
  return {
    database: overview.database,
    smtp: overview.smtp,
    aiSettings: overview.aiSettings,
    jobs: overview.jobs,
    analytics
  };
}
