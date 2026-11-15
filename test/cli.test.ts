import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { GateRecord } from "../src/domain.ts";
import { repoRoot } from "../src/root.ts";
import { saveSession } from "../src/session.ts";
import { tempDir } from "./helpers.ts";

const honestFollowUp =
  "The demo already ran, the code defect is still triaged, no agent was started, and CURSOR_API_KEY must be set before a later demo can reach a held fix.\n";

function keylessDemo(dir: string): void {
  cpSync(path.join(repoRoot, "src"), path.join(dir, "src"), { recursive: true });
  cpSync(path.join(repoRoot, "package.json"), path.join(dir, "package.json"));
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
  const records: GateRecord[] = [
    {
      phase: "deployed",
      finding: {
        id: "ADV-2026-014",
        kind: "known-upgrade",
        runtimeImport: false,
        pin: { name: "widget", pinned: "1.2.0", fixed: "1.4.0" },
      },
      disposition: "apply-known-upgrade",
      agentId: null,
      runId: null,
      diffHash: "pin",
      oracleResult: { outcome: "pass", detail: "ok" },
      evidence: {
        name: "closeout-sample",
        version: "pin-ADV-2026-014",
        findingIds: ["ADV-2026-014"],
        disposition: "apply-known-upgrade",
        agentId: null,
        runId: null,
        oracleResult: { outcome: "pass", detail: "ok" },
        diffHash: "pin",
        releasedBy: "policy",
        ansibleResult: { outcome: "pass", detail: "copied" },
      },
      uri: path.join(dir, "artifacts", "pin-ADV-2026-014"),
    },
    {
      phase: "triaged",
      finding: {
        id: "ADV-2026-015",
        kind: "code-defect",
        runtimeImport: true,
        location: { file: "src/logview.py", symbol: "read_log" },
      },
      disposition: "send-to-agent",
    },
  ];
  saveSession(dir, {
    worktree: path.join(dir, "var", "worktree"),
    baseCommit: "014e9ded23c39b0e7ca21d3c1929c63e2cf1237a",
    records,
  });
}

test("a follow-up after a keyless demo says the code defect is still triaged", () => {
  const dir = tempDir();
  try {
    keylessDemo(dir);
    const env = { ...process.env, PORT: "28772" };
    delete env.CURSOR_API_KEY;
    const result = spawnSync(process.execPath, ["src/cli.ts", "follow-up"], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, honestFollowUp);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
