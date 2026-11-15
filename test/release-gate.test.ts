import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PIN_FILE, type Finding, type Ports } from "../src/domain.ts";
import { createDeployer } from "../src/deployer.ts";
import { git } from "../src/diff.ts";
import { checkService } from "../src/oracle-run.ts";
import { repoRoot } from "../src/root.ts";
import { followUp, releaseHeld, runFinding } from "../src/run.ts";
import { createStore } from "../src/store.ts";
import { prepareService } from "../src/worktree.ts";

const pinFinding: Finding = {
  id: "ADV-2026-014",
  kind: "known-upgrade",
  runtimeImport: false,
  pin: { name: "widget", pinned: "1.2.0", fixed: "1.4.0" },
};

const defectFinding: Finding = {
  id: "ADV-2026-015",
  kind: "code-defect",
  runtimeImport: true,
  location: { file: "src/logview.py", symbol: "read_log" },
};

function livePorts(
  parent: string,
  port: number,
  edit: Ports["agent"]["edit"],
): { ports: Ports; deployRoot: string; artifactsRoot: string } {
  const deployRoot = path.join(parent, "runtime");
  const artifactsRoot = path.join(parent, "artifacts");
  const ports: Ports = {
    agent: { edit },
    oracle: {
      async check(input) {
        return checkService(repoRoot, input.servicePath, input.finding, input.followUp);
      },
    },
    deployer: createDeployer({ repoRoot, deployRoot, port }),
    store: createStore({ artifactsRoot }),
  };
  return { ports, deployRoot, artifactsRoot };
}

function stopPidFile(deployRoot: string): void {
  const pidFile = path.join(deployRoot, "server.pid");
  if (!existsSync(pidFile)) {
    return;
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

function startDecoy(port: number): ChildProcess {
  return spawn(
    "python3",
    [
      "-c",
      [
        "from http.server import BaseHTTPRequestHandler, HTTPServer",
        "class Handler(BaseHTTPRequestHandler):",
        "    def do_GET(self):",
        "        body = b'decoy'",
        "        self.send_response(200)",
        "        self.send_header('Content-Length', str(len(body)))",
        "        self.end_headers()",
        "        self.wfile.write(body)",
        "    def log_message(self, fmt, *args):",
        "        return",
        `HTTPServer(('127.0.0.1', ${port}), Handler).serve_forever()`,
      ].join("\n"),
    ],
    { stdio: "ignore" },
  );
}

async function waitForBody(url: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const body = await fetch(url).then((response) => response.text());
      if (body === expected) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

test("an occupied port does not promote a release", { timeout: 120_000 }, async () => {
  const port = 18611;
  const parent = mkdtempSync(path.join(tmpdir(), "closeout-occupied-"));
  const prepared = prepareService(
    path.join(repoRoot, "sample"),
    path.join(parent, "service"),
    path.join(parent, "worktree"),
  );
  const { ports, artifactsRoot } = livePorts(parent, port, async () => {
    throw new Error("agent should not run");
  });
  const decoy = startDecoy(port);
  try {
    await waitForBody(`http://127.0.0.1:${port}/health`, "decoy");
    const result = await runFinding(pinFinding, prepared.worktree, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "pin-ADV-2026-014",
      prompt: "unused",
      baseCommit: prepared.commit,
    });
    const evidencePath = path.join(artifactsRoot, "closeout-sample", "pin-ADV-2026-014", "evidence.json");
    assert.equal(result.record.phase, "rejected");
    if (result.record.phase === "rejected") {
      assert.match(result.record.reason, /deploy failed/);
    }
    assert.equal(existsSync(evidencePath), false);
    assert.equal(await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.text()), "decoy");
  } finally {
    decoy.kill("SIGTERM");
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a resumed edit stays held when the extra oracle passes and bytecode is present", { timeout: 60_000 }, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "closeout-pycache-"));
  const prepared = prepareService(
    path.join(repoRoot, "sample"),
    path.join(parent, "service"),
    path.join(parent, "worktree"),
  );
  const { ports } = livePorts(parent, 18619, async (input) => {
    cpSync(
      path.join(repoRoot, "fixtures", "logview_reject_absolute.py"),
      path.join(input.cwd, "src", "logview.py"),
    );
    return {
      outcome: "finished",
      agentId: input.agentId ?? "ag_1",
      runId: input.agentId ? "run_2" : "run_1",
    };
  });
  try {
    const first = await runFinding(defectFinding, prepared.worktree, ports, {
      releasedBy: "unused",
      artifactName: "closeout-sample",
      version: "v",
      prompt: "fix",
      baseCommit: prepared.commit,
    });
    assert.equal(first.record.phase, "held");
    if (first.record.phase !== "held") {
      return;
    }
    assert.equal(existsSync(path.join(prepared.worktree, "src", "__pycache__")), true);
    const second = await followUp(first.record, "also reject absolute paths", ports);
    assert.equal(second.record.phase, "held");
    if (second.record.phase === "held") {
      assert.equal(second.record.agentId, "ag_1");
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("releasing a held logview fix keeps the pin that already shipped", { timeout: 120_000 }, async () => {
  const port = 18612;
  const parent = mkdtempSync(path.join(tmpdir(), "closeout-pin-"));
  const prepared = prepareService(
    path.join(repoRoot, "sample"),
    path.join(parent, "service"),
    path.join(parent, "worktree"),
  );
  const { ports, deployRoot, artifactsRoot } = livePorts(parent, port, async (input) => {
    cpSync(
      path.join(repoRoot, "fixtures", "logview_reject_dotdot.py"),
      path.join(input.cwd, "src", "logview.py"),
    );
    return { outcome: "finished", agentId: "ag_1", runId: "run_1" };
  });
  try {
    const pinResult = await runFinding(pinFinding, prepared.worktree, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "pin-ADV-2026-014",
      prompt: "unused",
      baseCommit: prepared.commit,
    });
    assert.equal(pinResult.record.phase, "deployed");
    git(prepared.worktree, ["checkout", "--", PIN_FILE]);
    const defectResult = await runFinding(defectFinding, prepared.worktree, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
      prompt: "fix",
      baseCommit: prepared.commit,
    });
    assert.equal(defectResult.record.phase, "held");
    if (defectResult.record.phase !== "held") {
      return;
    }
    const released = await releaseHeld(defectResult.record, ports, {
      releasedBy: "cedric",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
    });
    assert.equal(released.record.phase, "deployed");
    assert.equal(readFileSync(path.join(deployRoot, "current", PIN_FILE), "utf8").trim(), "widget==1.4.0");
    assert.equal(
      readFileSync(path.join(artifactsRoot, "closeout-sample", "defect-ADV-2026-015", "tree", PIN_FILE), "utf8").trim(),
      "widget==1.4.0",
    );
    assert.match(readFileSync(path.join(deployRoot, "current", "src", "logview.py"), "utf8"), /path escapes the log root/);
  } finally {
    stopPidFile(deployRoot);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("release rejects a tree that fails the traversal oracle and does not record a pass", { timeout: 120_000 }, async () => {
  const port = 18613;
  const parent = mkdtempSync(path.join(tmpdir(), "closeout-stale-oracle-"));
  const prepared = prepareService(
    path.join(repoRoot, "sample"),
    path.join(parent, "service"),
    path.join(parent, "worktree"),
  );
  const { ports, deployRoot, artifactsRoot } = livePorts(parent, port, async (input) => {
    cpSync(
      path.join(repoRoot, "fixtures", "logview_reject_dotdot.py"),
      path.join(input.cwd, "src", "logview.py"),
    );
    return { outcome: "finished", agentId: "ag_1", runId: "run_1" };
  });
  try {
    const held = await runFinding(defectFinding, prepared.worktree, ports, {
      releasedBy: "unused",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
      prompt: "fix",
      baseCommit: prepared.commit,
    });
    assert.equal(held.record.phase, "held");
    if (held.record.phase !== "held") {
      return;
    }
    cpSync(path.join(repoRoot, "sample", "src", "logview.py"), path.join(prepared.worktree, "src", "logview.py"));
    const released = await releaseHeld(held.record, ports, {
      releasedBy: "cedric",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
    });
    const evidencePath = path.join(artifactsRoot, "closeout-sample", "defect-ADV-2026-015", "evidence.json");
    assert.equal(released.record.phase, "rejected");
    if (released.record.phase === "rejected") {
      assert.match(released.record.reason, /oracle failed/);
    }
    if (existsSync(evidencePath)) {
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { oracleResult?: { outcome?: string } };
      assert.notEqual(evidence.oracleResult?.outcome, "pass");
    }
  } finally {
    stopPidFile(deployRoot);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("demo clears prior evidence and rollback cannot restore the previous tree", { timeout: 180_000 }, async () => {
  const port = 18614;
  const runtime = path.join(repoRoot, "var", "runtime");
  const defectDir = path.join(repoRoot, "artifacts", "release", "closeout-sample", "defect-ADV-2026-015");
  const stale = path.join(defectDir, "STALE");
  const marker = "pre-rerun-marker";
  mkdirSync(path.join(runtime, "current", "src"), { recursive: true });
  cpSync(path.join(repoRoot, "sample"), path.join(runtime, "current"), { recursive: true });
  cpSync(path.join(runtime, "current"), path.join(runtime, "previous"), { recursive: true });
  writeFileSync(path.join(runtime, "current", "MARKER"), marker);
  mkdirSync(defectDir, { recursive: true });
  writeFileSync(stale, "stale-defect-evidence\n");
  writeFileSync(
    path.join(defectDir, "evidence.json"),
    `${JSON.stringify({ oracleResult: { outcome: "pass", detail: "stale-pass-after-tamper" } }, null, 2)}\n`,
  );
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete childEnv.CURSOR_API_KEY;
  delete childEnv.ARTIFACTORY_URL;
  delete childEnv.ARTIFACTORY_TOKEN;
  try {
    const demo = spawnSync("node", ["src/cli.ts", "demo"], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
    });
    assert.equal(demo.status, 0, `${demo.stdout}\n${demo.stderr}`);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(path.join(defectDir, "evidence.json")), false);
    assert.equal(existsSync(path.join(runtime, "current", "MARKER")), false);
    assert.equal(existsSync(path.join(runtime, "previous", "MARKER")), false);
    assert.equal(readFileSync(path.join(runtime, "current", PIN_FILE), "utf8").trim(), "widget==1.4.0");

    const rolled = spawnSync("npm", ["run", "rollback"], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
    });
    assert.notEqual(rolled.status, 0);
    assert.equal(readFileSync(path.join(runtime, "current", PIN_FILE), "utf8").trim(), "widget==1.4.0");
    assert.equal(existsSync(path.join(runtime, "current", "MARKER")), false);
    const traversal = await fetch(`http://127.0.0.1:${port}/log?name=../requirements-dev.txt`).then((response) => response.text());
    assert.equal(traversal.trim(), "widget==1.4.0");
  } finally {
    stopPidFile(runtime);
    rmSync(path.join(repoRoot, "var"), { recursive: true, force: true });
    rmSync(path.join(repoRoot, "artifacts"), { recursive: true, force: true });
  }
});
