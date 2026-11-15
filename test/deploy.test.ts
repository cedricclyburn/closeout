import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createDeployer } from "../src/deployer.ts";
import { repoRoot } from "../src/root.ts";

const port = 18765;

function copyRelease(marker: string): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "closeout-release-")), "tree");
  cpSync(path.join(repoRoot, "sample"), dir, { recursive: true });
  writeFileSync(path.join(dir, "logs", "app.log"), marker);
  return dir;
}

async function body(pathname: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return response.text();
}

test("ansible deploy probes the server and rollback restores the previous tree", { timeout: 120_000 }, async () => {
  const deployRoot = mkdtempSync(path.join(tmpdir(), "closeout-runtime-"));
  const deployer = createDeployer({ repoRoot, deployRoot, port });
  const first = copyRelease("release-one\n");
  const second = copyRelease("release-two\n");
  try {
    const deployed = await deployer.deploy({ releaseDir: first });
    assert.equal(deployed.outcome, "pass", deployed.detail);
    assert.equal(await body("/health"), "ok");
    assert.equal(await body("/log?name=app.log"), "release-one\n");

    const replaced = await deployer.deploy({ releaseDir: second });
    assert.equal(replaced.outcome, "pass", replaced.detail);
    assert.equal(await body("/log?name=app.log"), "release-two\n");

    const rolled = await deployer.rollback();
    assert.equal(rolled.outcome, "pass", rolled.detail);
    assert.equal(await body("/health"), "ok");
    assert.equal(await body("/log?name=app.log"), "release-one\n");
  } finally {
    const pidFile = path.join(deployRoot, "server.pid");
    try {
      const pid = readFileSync(pidFile, "utf8").trim();
      if (pid) {
        execFileSync("kill", [pid]);
      }
    } catch {
      // The playbook may already have stopped it.
    }
    rmSync(deployRoot, { recursive: true, force: true });
    rmSync(path.dirname(first), { recursive: true, force: true });
    rmSync(path.dirname(second), { recursive: true, force: true });
  }
});
