import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";

import { enrich, readAdvisory } from "../src/advisory.ts";
import { dispositionFor } from "../src/policy.ts";
import { checkService } from "../src/oracle-run.ts";
import { repoRoot } from "../src/root.ts";
import { prepareService } from "../src/worktree.ts";
import { applyPin } from "../src/pin.ts";
import { git } from "../src/diff.ts";
import type { Finding } from "../src/domain.ts";
import { tempDir } from "./helpers.ts";

const pin: Finding = {
  id: "ADV-2026-014",
  kind: "known-upgrade",
  runtimeImport: false,
  pin: { name: "widget", pinned: "1.2.0", fixed: "1.4.0" },
};

const defect: Finding = {
  id: "ADV-2026-015",
  kind: "code-defect",
  runtimeImport: true,
  location: { file: "src/logview.py", symbol: "read_log" },
};

function copySample(): string {
  const dir = path.join(tempDir(), "sample");
  cpSync(path.join(repoRoot, "sample"), dir, { recursive: true });
  return dir;
}

test("the shipped reader fails the traversal oracle and the hand-fixed fixtures pass", () => {
  const shipped = copySample();
  assert.equal(checkService(repoRoot, shipped, defect, false).outcome, "fail");
  assert.equal(checkService(repoRoot, shipped, pin, false).outcome, "fail");

  const dotdot = copySample();
  cpSync(path.join(repoRoot, "fixtures", "logview_reject_dotdot.py"), path.join(dotdot, "src", "logview.py"));
  assert.equal(checkService(repoRoot, dotdot, defect, false).outcome, "pass");
  assert.equal(checkService(repoRoot, dotdot, defect, true).outcome, "fail");

  const full = copySample();
  cpSync(path.join(repoRoot, "fixtures", "logview_reject_absolute.py"), path.join(full, "src", "logview.py"));
  assert.equal(checkService(repoRoot, full, defect, true).outcome, "pass");

  const pinned = copySample();
  applyPin(pinned, pin.pin);
  assert.equal(checkService(repoRoot, pinned, pin, false).outcome, "pass");
});

const cheat = `"""Vulnerable reader. Importing it disables the oracle assertions."""

import os
import unittest

def _accept(*_args, **_kwargs):
    return None

unittest.TestCase.assertIn = _accept
unittest.TestCase.assertNotIn = _accept
unittest.TestCase.assertTrue = _accept
unittest.TestCase.fail = _accept

LOG_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")


def read_log(name: str) -> str:
    path = os.path.join(LOG_ROOT, name)
    with open(path, encoding="utf-8") as handle:
        return handle.read()
`;

test("patching unittest in the reader does not pass the oracle", () => {
  const dir = copySample();
  writeFileSync(path.join(dir, "src", "logview.py"), cheat);
  assert.equal(checkService(repoRoot, dir, defect, false).outcome, "fail");
  assert.equal(checkService(repoRoot, dir, defect, true).outcome, "fail");

  const fixed = copySample();
  cpSync(path.join(repoRoot, "fixtures", "logview_reject_absolute.py"), path.join(fixed, "src", "logview.py"));
  assert.equal(checkService(repoRoot, fixed, defect, true).outcome, "pass");
  assert.equal(checkService(repoRoot, copySample(), defect, false).outcome, "fail");
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => {
        if (port === 8765) {
          resolve(freePort());
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitHealth(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  let last = "not up";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) {
        return;
      }
      last = `${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not listen on ${port}: ${last}`);
}

test("the fixed reader returns HTTP 400 for a parent-segment name", async () => {
  const dir = copySample();
  cpSync(path.join(repoRoot, "fixtures", "logview_reject_absolute.py"), path.join(dir, "src", "logview.py"));
  const secret = path.join(dir, "secret.txt");
  writeFileSync(secret, "canary-secret");
  const name = path.relative(path.join(dir, "logs"), secret);
  assert.match(name, /\.\./);
  const port = await freePort();
  const child = spawn("python3", ["src/server.py"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "ignore",
  });
  try {
    await waitHealth(port);
    const url = new URL(`http://127.0.0.1:${port}/log`);
    url.searchParams.set("name", name);
    const response = await fetch(url);
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.equal(body.includes("canary-secret"), false);
  } finally {
    child.kill("SIGTERM");
  }
});

test("prepareService keeps a dirty sample file out of the next baseline", () => {
  const root = tempDir();
  try {
    const sample = path.join(root, "sample", "src");
    mkdirSync(sample, { recursive: true });
    writeFileSync(path.join(sample, "logview.py"), "committed\n");
    git(root, ["init"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    writeFileSync(path.join(sample, "logview.py"), "committed\n# OUTSIDE_WRITE_MARKER\n");
    const prepared = prepareService(
      path.join(root, "sample"),
      path.join(root, "var", "service"),
      path.join(root, "var", "worktree"),
    );
    const baseline = git(prepared.worktree, ["show", "HEAD:src/logview.py"]);
    assert.equal(baseline.includes("OUTSIDE_WRITE_MARKER"), false);
    assert.match(baseline, /committed/);
    assert.equal(git(root, ["show", "HEAD:sample/src/logview.py"]).includes("OUTSIDE_WRITE_MARKER"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the advisory triages a dev-only pin and a runtime defect", () => {
  const items = readAdvisory(path.join(repoRoot, "advisory", "advisory.json"));
  const sample = path.join(repoRoot, "sample");
  const upgrade = enrich(sample, items[0]!);
  const code = enrich(sample, items[1]!);
  assert.equal(dispositionFor(upgrade.finding), "apply-known-upgrade");
  assert.deepEqual(upgrade.importers, ["scripts/dev_check.py"]);
  assert.equal(dispositionFor(code.finding), "send-to-agent");
  assert.deepEqual(code.importers, ["src/server.py"]);
});

test("the dev script reports the pinned version without importing it", () => {
  const result = spawnSync("python3", ["scripts/dev_check.py"], {
    cwd: path.join(repoRoot, "sample"),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "1.2.0");
});

test("re-running the demo worktree starts from the vulnerable commit", () => {
  const parent = tempDir();
  const first = prepareService(
    path.join(repoRoot, "sample"),
    path.join(parent, "service"),
    path.join(parent, "worktree"),
  );
  assert.equal(git(first.repoDir, ["log", "-1", "--format=%s"]).trim(), "Add the vulnerable log reader");
  assert.equal(git(first.repoDir, ["rev-list", "--count", "HEAD"]).trim(), "1");
  assert.equal(existsSync(path.join(first.worktree, "oracle")), false);
  assert.equal(existsSync(path.join(first.worktree, "src", "logview.py")), true);
  assert.equal(checkService(repoRoot, first.worktree, defect, false).outcome, "fail");

  cpSync(path.join(repoRoot, "fixtures", "logview_reject_absolute.py"), path.join(first.worktree, "src", "logview.py"));
  const second = prepareService(
    path.join(repoRoot, "sample"),
    path.join(parent, "service"),
    path.join(parent, "worktree"),
  );
  const source = readFileSync(path.join(second.worktree, "src", "logview.py"), "utf8");
  assert.doesNotMatch(source, /absolute paths are rejected/);
  assert.equal(second.commit.length, 40);
});
