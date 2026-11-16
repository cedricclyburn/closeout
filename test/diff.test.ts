import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { judgeAgentDiff, treeDiff } from "../src/diff.ts";
import { git } from "../src/diff.ts";
import { initRepo } from "./helpers.ts";

test("a logview-only edit is allowed", () => {
  const repo = initRepo({ "src/logview.py": "old\n" });
  try {
    writeFileSync(path.join(repo.dir, "src/logview.py"), "new\n");
    const diff = treeDiff(repo.dir, repo.commit);
    assert.equal(judgeAgentDiff(diff), null);
    assert.deepEqual(diff.files, ["src/logview.py"]);
    assert.equal(diff.committed, false);
  } finally {
    repo.cleanup();
  }
});

test("a skip-worktree bit does not hide a server.py content change", () => {
  for (const hide of ["--skip-worktree", "--assume-unchanged"] as const) {
    const repo = initRepo({ "src/logview.py": "old\n", "src/server.py": "server\n" });
    try {
      git(repo.dir, ["update-index", hide, "src/server.py"]);
      writeFileSync(path.join(repo.dir, "src", "server.py"), "server\nGATE_BYPASS\n");
      const diff = treeDiff(repo.dir, repo.commit);
      assert.equal(judgeAgentDiff(diff), "agent changed src/server.py");
      assert.ok(diff.files.includes("src/server.py"));
    } finally {
      repo.cleanup();
    }
  }
});

test("any other path is rejected, including a commit of the allowed file", () => {
  const extra = initRepo({ "src/logview.py": "old\n" });
  try {
    writeFileSync(path.join(extra.dir, "src/logview.py"), "new\n");
    writeFileSync(path.join(extra.dir, "src/extra.py"), "nope\n");
    const diff = treeDiff(extra.dir, extra.commit);
    assert.match(judgeAgentDiff(diff) ?? "", /src\/extra.py/);
  } finally {
    extra.cleanup();
  }

  const committed = initRepo({ "src/logview.py": "old\n" });
  try {
    writeFileSync(path.join(committed.dir, "src/logview.py"), "new\n");
    git(committed.dir, ["add", "src/logview.py"]);
    git(committed.dir, ["commit", "-m", "agent commit"]);
    const diff = treeDiff(committed.dir, committed.commit);
    assert.equal(judgeAgentDiff(diff), "agent created a commit");
  } finally {
    committed.cleanup();
  }
});
