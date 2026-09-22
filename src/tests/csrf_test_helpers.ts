import assert from "node:assert/strict";

export async function getCsrfToken(agent: { get: (path: string) => Promise<{ text: string }> }, path: string) {
  const response = await agent.get(path);
  const match = response.text.match(/<meta\s+name="csrf-token"\s+content="([a-f0-9]+)"/i);
  assert.ok(match?.[1], `CSRF token missing from ${path}`);
  return match[1];
}
