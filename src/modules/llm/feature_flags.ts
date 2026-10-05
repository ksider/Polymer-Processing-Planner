export function isDoeAnalysisLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = String(env.DOE_ANALYSIS_LLM_ENABLED ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(configured);
}
