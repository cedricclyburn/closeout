import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.ts";
import { repoRoot } from "../src/root.ts";

test("a missing API key is a startup failure", async () => {
  const saved = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  try {
    const result = await runAgent({ cwd: repoRoot, prompt: "do nothing" });
    assert.equal(result.outcome, "startup-error");
    if (result.outcome !== "startup-error") {
      return;
    }
    assert.match(result.message, /CURSOR_API_KEY/);
    assert.equal(result.runId, null);
    assert.equal(result.retryable, false);
  } finally {
    if (saved === undefined) {
      delete process.env.CURSOR_API_KEY;
    } else {
      process.env.CURSOR_API_KEY = saved;
    }
  }
});

test("the Cursor SDK is imported only from src/agent.ts", () => {
  const dir = path.join(repoRoot, "src");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name === "agent.ts") {
      continue;
    }
    const text = readFileSync(path.join(dir, name), "utf8");
    assert.equal(text.includes("@cursor/sdk"), false, name);
  }
  const agent = readFileSync(path.join(dir, "agent.ts"), "utf8");
  assert.match(agent, /settingSources: \[\]/);
  assert.match(agent, /composer-2\.5/);
  assert.match(agent, /CURSOR_MODEL/);
  assert.match(agent, /Agent\.resume/);
  assert.match(agent, /CursorAgentError/);
  assert.match(agent, /\.stream\(\)/);
  assert.match(agent, /\.wait\(\)/);
});
