import type { ExecutionProtocolField } from "./execution_protocol_types.js";

export type ProtocolStoredValue = {
  value_real: number | null;
  value_text: string | null;
  value_tags_json: string | null;
};

export function formatProtocolStoredValue(
  value: ProtocolStoredValue | undefined,
  fieldType: ExecutionProtocolField["fieldType"]
): string {
  if (!value) return "";
  if (fieldType === "tag") {
    if (!value.value_tags_json) return "";
    try {
      const parsed = JSON.parse(value.value_tags_json);
      return Array.isArray(parsed) ? parsed.map(String).join(", ") : String(parsed);
    } catch {
      return value.value_tags_json;
    }
  }
  if (fieldType === "text") return value.value_text?.trim() ?? "";
  if (value.value_real == null || !Number.isFinite(value.value_real)) return "";
  if (fieldType === "boolean") return value.value_real === 1 ? "Yes" : "No";
  return Number(value.value_real.toFixed(6)).toString();
}
