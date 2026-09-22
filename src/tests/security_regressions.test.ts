import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToSafeHtml } from "../services/markdown_service.js";

test("report markdown renderer never emits executable URLs or script tags", () => {
  const html = markdownToSafeHtml([
    "# <script>alert(1)</script>",
    "[unsafe](javascript:alert(1))",
    "![unsafe image](javascript:alert(1))",
    "![chart](data:image/png;base64,aGVsbG8=)"
  ].join("\n"));

  assert.doesNotMatch(html, /<script|javascript:/i);
  assert.match(html, /<img src="data:image\/png;base64,aGVsbG8=" alt="chart">/);
});
