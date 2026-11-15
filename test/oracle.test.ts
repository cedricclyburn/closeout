import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
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
