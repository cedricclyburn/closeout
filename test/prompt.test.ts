import assert from "node:assert/strict";
import { test } from "node:test";

import { defectPrompt, followUpSentence } from "../src/prompt.ts";

test("the first prompt names the file and forbids commits, dependencies, and absolute-path hints", () => {
  const text = defectPrompt({
    id: "ADV-2026-015",
    kind: "code-defect",
    runtimeImport: true,
    location: { file: "src/logview.py", symbol: "read_log" },
  });
  assert.match(text, /src\/logview\.py/);
  assert.match(text, /read_log/);
  assert.match(text, /\.\./);
  assert.match(text, /Do not commit/);
  assert.match(text, /Do not add dependencies/);
  assert.doesNotMatch(text, /absolute/i);
});

test("a follow-up sends the sentence unchanged", () => {
  assert.equal(followUpSentence("  also reject absolute paths  "), "also reject absolute paths");
  assert.throws(() => followUpSentence("   "), /empty/);
});
