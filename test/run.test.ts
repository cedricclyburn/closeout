import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  type AgentEditResult,
  type AgentPort,
  type CheckResult,
  type DeployerPort,
  type Evidence,
  type Finding,
  type OraclePort,
  type Ports,
  type StorePort,
} from "../src/domain.ts";
import { git } from "../src/diff.ts";
import { followUp, releaseHeld, runFinding } from "../src/run.ts";
import { initRepo } from "./helpers.ts";

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

function harness(agent: AgentPort["edit"], oracle: OraclePort["check"], deployOk = true) {
  const calls = {
    agent: 0,
    oracle: 0,
    deploy: 0,
    promote: 0,
    followUp: false,
    resumed: undefined as string | undefined,
    evidence: undefined as Evidence | undefined,
  };
  const ports: Ports = {
    agent: {
      async edit(input) {
        calls.agent += 1;
        calls.resumed = input.agentId;
        return agent(input);
      },
    },
    oracle: {
      async check(input) {
        calls.oracle += 1;
        calls.followUp = input.followUp;
        return oracle(input);
      },
    },
    deployer: {
      async deploy() {
        calls.deploy += 1;
        const result: CheckResult = deployOk
          ? { outcome: "pass", detail: "probed /health" }
          : { outcome: "fail", detail: "probe failed" };
        return result;
      },
      async rollback() {
        return { outcome: "pass", detail: "restored" };
      },
    } satisfies DeployerPort,
    store: {
      async promote(input) {
        calls.promote += 1;
        calls.evidence = input.evidence;
        return { uri: `file://artifacts/${input.evidence.version}` };
      },
    } satisfies StorePort,
  };
  return { ports, calls };
}

const passOracle: OraclePort["check"] = async () => ({ outcome: "pass", detail: "pass" });

test("a known pin with a passing oracle deploys and does not call an agent", async () => {
  const repo = initRepo({ "requirements-dev.txt": "widget==1.2.0\n", "src/logview.py": "old\n" });
  const { ports, calls } = harness(async () => {
    throw new Error("agent should not be called");
  }, passOracle);
  try {
    const result = await runFinding(pinFinding, repo.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "pin-ADV-2026-014",
      prompt: "unused",
      baseCommit: repo.commit,
    });
    assert.deepEqual(result.phases, ["ingested", "triaged", "patching", "oracle", "releasing", "deployed"]);
    assert.equal(result.record.phase, "deployed");
    assert.equal(calls.agent, 0);
    assert.equal(calls.deploy, 1);
    assert.equal(calls.promote, 1);
    assert.equal(readFileSync(path.join(repo.dir, "requirements-dev.txt"), "utf8"), "widget==1.4.0\n");
    if (result.record.phase !== "deployed") {
      return;
    }
    assert.equal(result.record.evidence.disposition, "apply-known-upgrade");
    assert.equal(result.record.evidence.agentId, null);
    assert.equal(result.record.evidence.runId, null);
    assert.equal(result.record.evidence.releasedBy, "policy");
    assert.equal(result.record.evidence.oracleResult.outcome, "pass");
    assert.equal(result.record.evidence.ansibleResult.outcome, "pass");
    assert.deepEqual(result.record.evidence.findingIds, ["ADV-2026-014"]);
    assert.match(result.record.evidence.diffHash, /^[a-f0-9]{64}$/);
  } finally {
    repo.cleanup();
  }
});

test("a failing pin oracle does not deploy", async () => {
  const repo = initRepo({ "requirements-dev.txt": "widget==1.2.0\n" });
  const { ports, calls } = harness(async () => {
    throw new Error("agent should not be called");
  }, async () => ({ outcome: "fail", detail: "still 1.2.0" }));
  try {
    const result = await runFinding(pinFinding, repo.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "pin-ADV-2026-014",
      prompt: "unused",
    });
    assert.equal(result.record.phase, "rejected");
    if (result.record.phase === "rejected") {
      assert.match(result.record.reason, /oracle failed/);
    }
    assert.equal(calls.deploy, 0);
    assert.equal(calls.promote, 0);
  } finally {
    repo.cleanup();
  }
});

test("a runtime defect stays held when the oracle passes", async () => {
  const repo = initRepo({ "src/logview.py": "vulnerable\n" });
  const { ports, calls } = harness(async ({ cwd }) => {
    writeFileSync(path.join(cwd, "src/logview.py"), "fixed\n");
    const edited: AgentEditResult = { outcome: "finished", agentId: "ag_1", runId: "run_1" };
    return edited;
  }, passOracle);
  try {
    const result = await runFinding(defectFinding, repo.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
      prompt: "fix the traversal",
      baseCommit: repo.commit,
    });
    assert.deepEqual(result.phases, ["ingested", "triaged", "patching", "oracle", "held"]);
    assert.equal(result.record.phase, "held");
    assert.equal(calls.deploy, 0);
    assert.equal(calls.promote, 0);
    if (result.record.phase !== "held") {
      return;
    }
    assert.equal(result.record.agentId, "ag_1");
    assert.equal(result.record.runId, "run_1");

    const released = await releaseHeld(result.record, ports, {
      releasedBy: "cedric",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
    });
    assert.equal(released.record.phase, "deployed");
    assert.equal(calls.deploy, 1);
    assert.equal(calls.evidence?.releasedBy, "cedric");
    assert.equal(calls.evidence?.agentId, "ag_1");
    assert.equal(calls.evidence?.runId, "run_1");
    assert.equal(calls.evidence?.disposition, "send-to-agent");
  } finally {
    repo.cleanup();
  }
});

test("an edit outside src/logview.py rejects the run before the oracle", async () => {
  const repo = initRepo({ "src/logview.py": "vulnerable\n" });
  const { ports, calls } = harness(async ({ cwd }) => {
    writeFileSync(path.join(cwd, "src/logview.py"), "fixed\n");
    writeFileSync(path.join(cwd, "README.md"), "extra\n");
    return { outcome: "finished", agentId: "ag_1", runId: "run_1" };
  }, passOracle);
  try {
    const result = await runFinding(defectFinding, repo.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
      prompt: "fix",
    });
    assert.equal(result.record.phase, "rejected");
    if (result.record.phase === "rejected") {
      assert.match(result.record.reason, /README.md/);
      assert.equal(result.record.agentId, "ag_1");
    }
    assert.equal(calls.oracle, 0);
    assert.equal(calls.deploy, 0);
  } finally {
    repo.cleanup();
  }
});

test("a skip-worktree edit of src/server.py rejects the run before the oracle", async () => {
  const repo = initRepo({ "src/logview.py": "vulnerable\n", "src/server.py": "server\n" });
  const { ports, calls } = harness(async ({ cwd }) => {
    git(cwd, ["update-index", "--skip-worktree", "src/server.py"]);
    writeFileSync(path.join(cwd, "src", "server.py"), "server\nGATE_BYPASS\n");
    writeFileSync(path.join(cwd, "src", "logview.py"), "fixed\n");
    return { outcome: "finished", agentId: "ag_1", runId: "run_1" };
  }, passOracle);
  try {
    const result = await runFinding(defectFinding, repo.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
      prompt: "fix",
      baseCommit: repo.commit,
    });
    assert.equal(result.record.phase, "rejected");
    if (result.record.phase === "rejected") {
      assert.match(result.record.reason, /src\/server\.py/);
    }
    assert.equal(calls.oracle, 0);
    assert.equal(calls.deploy, 0);
    assert.equal(calls.promote, 0);
  } finally {
    repo.cleanup();
  }
});

test("a skip-worktree edit of src/server.py rejects a pin release before deploy", async () => {
  const repo = initRepo({ "requirements-dev.txt": "widget==1.2.0\n", "src/server.py": "server\n" });
  const { ports, calls } = harness(async () => {
    throw new Error("agent should not be called");
  }, passOracle);
  try {
    git(repo.dir, ["update-index", "--skip-worktree", "src/server.py"]);
    writeFileSync(path.join(repo.dir, "src", "server.py"), "server\nGATE_BYPASS\n");
    const result = await runFinding(pinFinding, repo.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "pin-ADV-2026-014",
      prompt: "unused",
      baseCommit: repo.commit,
    });
    assert.equal(result.record.phase, "rejected");
    if (result.record.phase === "rejected") {
      assert.match(result.record.reason, /src\/server\.py/);
    }
    assert.equal(calls.agent, 0);
    assert.equal(calls.oracle, 0);
    assert.equal(calls.deploy, 0);
    assert.equal(calls.promote, 0);
  } finally {
    repo.cleanup();
  }
});

test("an oracle file changed while the agent runs is rejected and not held", async () => {
  const gate = initRepo({ "oracle/test_traversal.py": "print('trusted')\n" });
  const service = initRepo({ "src/logview.py": "vulnerable\n" });
  const { ports, calls } = harness(async () => {
    writeFileSync(path.join(gate.dir, "oracle", "test_traversal.py"), "import sys\nsys.exit(0)\n");
    writeFileSync(path.join(service.dir, "src", "logview.py"), "fixed\n");
    return { outcome: "finished", agentId: "ag_out", runId: "run_out" };
  }, passOracle);
  try {
    const result = await runFinding(defectFinding, service.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "defect-ADV-2026-015",
      prompt: "fix",
      baseCommit: service.commit,
      oracleRepo: gate.dir,
    });
    assert.equal(result.record.phase, "rejected");
    if (result.record.phase === "rejected") {
      assert.match(result.record.reason, /oracle/);
    }
    assert.notEqual(result.record.phase, "held");
    assert.equal(calls.oracle, 0);
    assert.equal(calls.deploy, 0);
    assert.equal(calls.promote, 0);
  } finally {
    gate.cleanup();
    service.cleanup();
  }
});

test("startup failure and run failure stay distinct", async () => {
  const repo = initRepo({ "src/logview.py": "vulnerable\n" });
  try {
    const startup = harness(async () => ({
      outcome: "startup-error",
      message: "missing CURSOR_API_KEY",
      retryable: false,
      agentId: null,
      runId: null,
    }), passOracle);
    const started = await runFinding(defectFinding, repo.dir, startup.ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "v",
      prompt: "fix",
    });
    assert.equal(started.record.phase, "rejected");
    if (started.record.phase === "rejected") {
      assert.match(started.record.reason, /did not start/);
    }

    const failed = harness(async () => ({
      outcome: "run-error",
      message: "tool loop died",
      agentId: "ag_1",
      runId: "run_9",
    }), passOracle);
    const ran = await runFinding(defectFinding, repo.dir, failed.ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "v",
      prompt: "fix",
    });
    assert.equal(ran.record.phase, "rejected");
    if (ran.record.phase === "rejected") {
      assert.match(ran.record.reason, /run failed/);
      assert.equal(ran.record.runId, "run_9");
    }
    assert.equal(startup.calls.oracle, 0);
    assert.equal(failed.calls.oracle, 0);
  } finally {
    repo.cleanup();
  }
});

test("a refused finding never reaches the agent or the oracle", async () => {
  const { ports, calls } = harness(async () => {
    throw new Error("no agent");
  }, passOracle);
  const finding: Finding = { ...defectFinding, runtimeImport: false };
  const result = await runFinding(finding, "/unused", ports, {
    releasedBy: "policy",
    artifactName: "closeout-sample",
    version: "v",
    prompt: "fix",
  });
  assert.equal(result.record.phase, "rejected");
  if (result.record.phase === "rejected") {
    assert.equal(result.record.disposition, "refuse");
  }
  assert.equal(calls.agent, 0);
  assert.equal(calls.oracle, 0);
});

test("a follow-up stays held when the second oracle passes", async () => {
  const repo = initRepo({ "src/logview.py": "vulnerable\n" });
  const { ports, calls } = harness(async ({ cwd, agentId }) => {
    writeFileSync(path.join(cwd, "src/logview.py"), agentId ? "stricter\n" : "fixed\n");
    return { outcome: "finished", agentId: agentId ?? "ag_1", runId: agentId ? "run_2" : "run_1" };
  }, passOracle);
  try {
    const first = await runFinding(defectFinding, repo.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "v",
      prompt: "fix dotdot",
      baseCommit: repo.commit,
    });
    assert.equal(first.record.phase, "held");
    if (first.record.phase !== "held") {
      return;
    }
    const second = await followUp(first.record, "also reject absolute paths", ports);
    assert.equal(second.record.phase, "held");
    assert.equal(calls.followUp, true);
    assert.equal(calls.resumed, "ag_1");
    assert.equal(calls.deploy, 0);
    if (second.record.phase === "held") {
      assert.equal(second.record.runId, "run_2");
      assert.equal(second.record.agentId, "ag_1");
    }
  } finally {
    repo.cleanup();
  }
});

test("a failed deploy does not promote a release", async () => {
  const repo = initRepo({ "requirements-dev.txt": "widget==1.2.0\n" });
  const { ports, calls } = harness(async () => {
    throw new Error("no agent");
  }, passOracle, false);
  try {
    const result = await runFinding(pinFinding, repo.dir, ports, {
      releasedBy: "policy",
      artifactName: "closeout-sample",
      version: "pin-ADV-2026-014",
      prompt: "unused",
    });
    assert.equal(result.record.phase, "rejected");
    if (result.record.phase === "rejected") {
      assert.match(result.record.reason, /deploy failed/);
    }
    assert.equal(calls.deploy, 1);
    assert.equal(calls.promote, 0);
  } finally {
    repo.cleanup();
  }
});
