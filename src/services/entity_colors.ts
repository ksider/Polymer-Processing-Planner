export type CalendarEntityType = "experiment" | "qualification_step" | "doe" | "run" | "report" | "task";

// Must stay aligned with notes/journal palette in src/public/app.css (.entity-* / .journal-rail-dot.entity-*).
export const ENTITY_COLOR_MAP: Record<CalendarEntityType, string> = {
  experiment: "#9fb2c8",
  qualification_step: "#9f86dd",
  doe: "#6ba8de",
  run: "#63b083",
  report: "#d6925f",
  task: "#d97777"
};

export function getEntityColor(entityType: string): string {
  const key = String(entityType || "").trim().toLowerCase() as CalendarEntityType;
  return ENTITY_COLOR_MAP[key] || "#8f8f8f";
}
