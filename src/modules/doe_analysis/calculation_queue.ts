import crypto from "node:crypto";
import type { Db } from "../../db.js";
import type { DoeAnalysisDataset } from "./types.js";
import {
  createAnalyticsRequest,
  DOE_ANALYTICS_CONTRACT_VERSION,
  type DoeAnalysisSpecification,
  type DoeAnalyticsFailure
} from "./analytics_contract.js";
import { DoeAnalyticsServiceError, type DoeAnalyticsClient } from "./analytics_client.js";
import {
  getDoeAnalysis,
  getDoeAnalysisRevision,
  recordDoeAnalysisEvent,
  saveFailedDoeAnalysisRevision,
  saveSuccessfulDoeAnalysisRevision,
  type DoeAnalysisRevisionRecord
} from "./analysis_repo.js";

export type DoeAnalysisJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type DoeAnalysisJobRecord = {
  id: number;
  analysisId: number;
  doeId: number;
  status: DoeAnalysisJobStatus;
  datasetRevision: string;
  requestId: string;
  specification: DoeAnalysisSpecification;
  requestedByUserId: number | null;
  revisionId: number | null;
  error: DoeAnalyticsFailure["error"] | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type JobRow = {
  id: number;
  analysis_id: number;
  doe_id: number;
  status: DoeAnalysisJobStatus;
  dataset_revision: string;
  request_id: string;
  specification_json: string;
  dataset_json: string;
  requested_by_user_id: number | null;
  revision_id: number | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type QueuedJob = DoeAnalysisJobRecord & { dataset: DoeAnalysisDataset };

export class DoeAnalysisCalculationQueue {
  private draining = false;

  constructor(
    private readonly db: Db,
    private readonly analyticsClient: DoeAnalyticsClient
  ) {
    // A process can stop while R is running. The request and its immutable
    // dataset snapshot are persisted, so it is safe to resume it on startup.
    db.prepare(
      "UPDATE doe_analysis_jobs SET status = 'QUEUED', started_at = NULL WHERE status = 'RUNNING'"
    ).run();
    this.schedule();
  }

  enqueue(input: {
    analysisId: number;
    doeId: number;
    dataset: DoeAnalysisDataset;
    specification: DoeAnalysisSpecification;
    requestedByUserId?: number | null;
  }): DoeAnalysisJobRecord {
    const active = findActiveDoeAnalysisJob(this.db, input.analysisId);
    if (active) return active;
    const timestamp = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO doe_analysis_jobs
       (analysis_id, doe_id, status, dataset_revision, request_id,
        specification_json, dataset_json, requested_by_user_id, created_at)
       VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)`
    ).run(
      input.analysisId,
      input.doeId,
      input.dataset.datasetRevision,
      crypto.randomUUID(),
      JSON.stringify(input.specification),
      JSON.stringify(input.dataset),
      input.requestedByUserId ?? null,
      timestamp
    );
    const job = getDoeAnalysisJob(this.db, input.analysisId, Number(result.lastInsertRowid));
    if (!job) throw new Error("Queued DOE analysis calculation could not be loaded");
    recordDoeAnalysisEvent(this.db, {
      analysisId: input.analysisId,
      action: "CALCULATION_QUEUED",
      actorUserId: input.requestedByUserId ?? null,
      details: { jobId: job.id, datasetRevision: job.datasetRevision }
    });
    this.schedule();
    return job;
  }

  private schedule(): void {
    queueMicrotask(() => { void this.drain(); });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let job = claimNextDoeAnalysisJob(this.db);
      while (job) {
        await this.process(job);
        job = claimNextDoeAnalysisJob(this.db);
      }
    } finally {
      this.draining = false;
    }
  }

  private async process(job: QueuedJob): Promise<void> {
    const analysis = getDoeAnalysis(this.db, job.doeId, job.analysisId);
    if (!analysis || analysis.archivedAt) {
      const failure = {
        code: "ANALYSIS_UNAVAILABLE",
        message: "The analysis was archived or removed before its calculation started.",
        retryable: false
      };
      completeDoeAnalysisJob(this.db, job, "CANCELLED", null, failure);
      if (analysis) {
        recordDoeAnalysisEvent(this.db, {
          analysisId: analysis.id,
          action: "CALCULATION_CANCELLED",
          actorUserId: job.requestedByUserId,
          details: { jobId: job.id, datasetRevision: job.datasetRevision, errorCode: failure.code }
        });
      }
      return;
    }
    try {
      const result = await this.analyticsClient.analyze(
        createAnalyticsRequest(job.dataset, job.specification, job.requestId)
      );
      const currentAnalysis = getDoeAnalysis(this.db, job.doeId, job.analysisId);
      if (!currentAnalysis || currentAnalysis.archivedAt) {
        const failure = {
          code: "ANALYSIS_UNAVAILABLE",
          message: "The analysis was archived or removed while it was being calculated.",
          retryable: false
        };
        completeDoeAnalysisJob(this.db, job, "CANCELLED", null, failure);
        if (currentAnalysis) {
          recordDoeAnalysisEvent(this.db, {
            analysisId: currentAnalysis.id,
            action: "CALCULATION_CANCELLED",
            actorUserId: job.requestedByUserId,
            details: { jobId: job.id, datasetRevision: job.datasetRevision, errorCode: failure.code }
          });
        }
        return;
      }
      const revision = result.ok
        ? saveSuccessfulDoeAnalysisRevision(this.db, currentAnalysis, result, job.requestedByUserId, job.dataset)
        : saveFailedDoeAnalysisRevision(this.db, currentAnalysis, {
            datasetRevision: job.datasetRevision,
            contractVersion: result.contractVersion,
            requestId: result.requestId,
            specification: job.specification,
            error: result.error,
            calculatedByUserId: job.requestedByUserId
          });
      completeDoeAnalysisJob(
        this.db,
        job,
        result.ok ? "SUCCEEDED" : "FAILED",
        revision,
        result.ok ? null : result.error
      );
      recordDoeAnalysisEvent(this.db, {
        analysisId: currentAnalysis.id,
        action: result.ok ? "CALCULATED" : "CALCULATION_FAILED",
        actorUserId: job.requestedByUserId,
        details: {
          jobId: job.id,
          revisionId: revision.id,
          datasetRevision: job.datasetRevision,
          ...(result.ok ? {} : { errorCode: result.error.code })
        }
      });
    } catch (error) {
      const failure = asJobFailure(error);
      const revision = saveFailedDoeAnalysisRevision(this.db, analysis, {
        datasetRevision: job.datasetRevision,
        contractVersion: DOE_ANALYTICS_CONTRACT_VERSION,
        requestId: job.requestId,
        specification: job.specification,
        error: failure,
        calculatedByUserId: job.requestedByUserId
      });
      completeDoeAnalysisJob(this.db, job, "FAILED", revision, failure);
      recordDoeAnalysisEvent(this.db, {
        analysisId: analysis.id,
        action: "CALCULATION_FAILED",
        actorUserId: job.requestedByUserId,
        details: { jobId: job.id, revisionId: revision.id, datasetRevision: job.datasetRevision, errorCode: failure.code }
      });
    }
  }
}

export function getDoeAnalysisJob(
  db: Db,
  analysisId: number,
  jobId: number
): DoeAnalysisJobRecord | null {
  const row = db.prepare(
    "SELECT * FROM doe_analysis_jobs WHERE id = ? AND analysis_id = ?"
  ).get(jobId, analysisId) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export function getDoeAnalysisJobRevision(
  db: Db,
  job: DoeAnalysisJobRecord
): DoeAnalysisRevisionRecord | null {
  return job.revisionId ? getDoeAnalysisRevision(db, job.analysisId, job.revisionId) : null;
}

export function findActiveDoeAnalysisJob(db: Db, analysisId: number): DoeAnalysisJobRecord | null {
  const row = db.prepare(
    `SELECT * FROM doe_analysis_jobs
     WHERE analysis_id = ? AND status IN ('QUEUED', 'RUNNING')
     ORDER BY id DESC LIMIT 1`
  ).get(analysisId) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

function claimNextDoeAnalysisJob(db: Db): QueuedJob | null {
  const candidate = db.prepare(
    "SELECT * FROM doe_analysis_jobs WHERE status = 'QUEUED' ORDER BY id LIMIT 1"
  ).get() as JobRow | undefined;
  if (!candidate) return null;
  const startedAt = new Date().toISOString();
  const update = db.prepare(
    "UPDATE doe_analysis_jobs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'"
  ).run(startedAt, candidate.id);
  if (update.changes !== 1) return null;
  return { ...mapJob(candidate), status: "RUNNING", startedAt, dataset: JSON.parse(candidate.dataset_json) as DoeAnalysisDataset };
}

function completeDoeAnalysisJob(
  db: Db,
  job: DoeAnalysisJobRecord,
  status: Exclude<DoeAnalysisJobStatus, "QUEUED" | "RUNNING">,
  revision: DoeAnalysisRevisionRecord | null,
  error: DoeAnalyticsFailure["error"] | null
): void {
  db.prepare(
    `UPDATE doe_analysis_jobs
     SET status = ?, revision_id = ?, error_json = ?, finished_at = ?
     WHERE id = ?`
  ).run(
    status,
    revision?.id ?? null,
    error ? JSON.stringify(error) : null,
    new Date().toISOString(),
    job.id
  );
}

function mapJob(row: JobRow): DoeAnalysisJobRecord {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    doeId: row.doe_id,
    status: row.status,
    datasetRevision: row.dataset_revision,
    requestId: row.request_id,
    specification: JSON.parse(row.specification_json) as DoeAnalysisSpecification,
    requestedByUserId: row.requested_by_user_id,
    revisionId: row.revision_id,
    error: row.error_json ? JSON.parse(row.error_json) as DoeAnalyticsFailure["error"] : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function asJobFailure(error: unknown): DoeAnalyticsFailure["error"] {
  if (error instanceof DoeAnalyticsServiceError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "ANALYSIS_JOB_FAILED",
    message: error instanceof Error ? error.message : "Analysis calculation failed.",
    retryable: false
  };
}
