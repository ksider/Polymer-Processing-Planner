import crypto from "node:crypto";
import type { Db } from "../../db.js";
import type { DoeInterpretationResponse } from "./doe_interpretation_contract.js";

export type DoeAiInterpretation = {
  id: number;
  doeId: number;
  analysisId: number;
  analysisRevisionId: number;
  datasetRevision: string;
  mode: "provider" | "mock";
  providerName: string | null;
  model: string | null;
  contractVersion: string;
  promptVersion: string;
  response: DoeInterpretationResponse;
  createdByUserId: number | null;
  createdAt: string;
};

type InterpretationRow = {
  id: number;
  doe_id: number;
  analysis_id: number;
  analysis_revision_id: number;
  dataset_revision: string;
  mode: "provider" | "mock";
  provider_name: string | null;
  model: string | null;
  contract_version: string;
  prompt_version: string;
  response_json: string;
  created_by_user_id: number | null;
  created_at: string;
};

export function createDoeAiInterpretation(
  db: Db,
  input: Omit<DoeAiInterpretation, "id" | "createdAt">
): DoeAiInterpretation {
  const responseJson = JSON.stringify(input.response);
  const responseHash = crypto.createHash("sha256").update(responseJson).digest("hex");
  const timestamp = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO doe_ai_interpretations
     (doe_id, analysis_id, analysis_revision_id, dataset_revision, mode, provider_name, model,
      contract_version, prompt_version, response_json, response_sha256, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(analysis_revision_id, response_sha256) DO NOTHING`
  ).run(
    input.doeId,
    input.analysisId,
    input.analysisRevisionId,
    input.datasetRevision,
    input.mode,
    input.providerName,
    input.model,
    input.contractVersion,
    input.promptVersion,
    responseJson,
    responseHash,
    input.createdByUserId,
    timestamp
  );
  const row = result.changes
    ? db.prepare("SELECT * FROM doe_ai_interpretations WHERE id = ?").get(Number(result.lastInsertRowid)) as InterpretationRow
    : db.prepare("SELECT * FROM doe_ai_interpretations WHERE analysis_revision_id = ? AND response_sha256 = ?").get(input.analysisRevisionId, responseHash) as InterpretationRow | undefined;
  if (!row) throw new Error("Saved AI interpretation could not be loaded.");
  return mapInterpretation(row);
}

export function listDoeAiInterpretations(db: Db, analysisId: number, analysisRevisionId?: number): DoeAiInterpretation[] {
  const rows = (analysisRevisionId === undefined
    ? db.prepare("SELECT * FROM doe_ai_interpretations WHERE analysis_id = ? ORDER BY id DESC").all(analysisId)
    : db.prepare("SELECT * FROM doe_ai_interpretations WHERE analysis_id = ? AND analysis_revision_id = ? ORDER BY id DESC").all(analysisId, analysisRevisionId)
  ) as InterpretationRow[];
  return rows.map(mapInterpretation);
}

function mapInterpretation(row: InterpretationRow): DoeAiInterpretation {
  return {
    id: row.id,
    doeId: row.doe_id,
    analysisId: row.analysis_id,
    analysisRevisionId: row.analysis_revision_id,
    datasetRevision: row.dataset_revision,
    mode: row.mode,
    providerName: row.provider_name,
    model: row.model,
    contractVersion: row.contract_version,
    promptVersion: row.prompt_version,
    response: JSON.parse(row.response_json) as DoeInterpretationResponse,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at
  };
}
