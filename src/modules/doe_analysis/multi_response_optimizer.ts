export type MultiResponseGoal = {
  responseKey: string;
  objective: "minimize" | "maximize" | "target";
  target?: number;
  importance?: number;
  observedMin: number;
  observedMax: number;
};

export type MultiResponsePrediction = { responseKey: string; predicted: number };

// The optimiser deliberately exposes every component desirability: a high
// combined score must never hide a poor compromise for an individual response.
export function scoreMultiResponseCandidate(
  goals: MultiResponseGoal[],
  predictions: MultiResponsePrediction[]
): { desirability: number; components: Record<string, number> } {
  const byResponse = new Map(predictions.map((item) => [item.responseKey, item.predicted]));
  const components: Record<string, number> = {};
  let logTotal = 0;
  let weightTotal = 0;
  for (const goal of goals) {
    const predicted = byResponse.get(goal.responseKey);
    const span = goal.observedMax - goal.observedMin;
    if (!Number.isFinite(predicted) || !(span > 0)) return { desirability: 0, components };
    const raw = goal.objective === "maximize"
      ? (predicted! - goal.observedMin) / span
      : goal.objective === "minimize"
        ? (goal.observedMax - predicted!) / span
        : 1 - Math.abs(predicted! - Number(goal.target)) / span;
    const value = Math.max(0, Math.min(1, raw));
    const weight = Math.max(1, Math.min(5, Number(goal.importance ?? 1)));
    components[goal.responseKey] = value;
    if (value === 0) return { desirability: 0, components };
    logTotal += weight * Math.log(value);
    weightTotal += weight;
  }
  return { desirability: weightTotal ? Math.exp(logTotal / weightTotal) : 0, components };
}
