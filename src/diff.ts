import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { ALLOWED_AGENT_FILE } from "./domain.ts";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function headCommit(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

export type TreeDiff = {
  files: string[];
  committed: boolean;
  hash: string;
};

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function treeDiff(cwd: string, baseCommit: string): TreeDiff {
  const head = headCommit(cwd);
  const tracked = lines(git(cwd, ["diff", "--name-only", baseCommit]));
  const untracked = lines(git(cwd, ["ls-files", "--others", "--exclude-standard"]));
  const files = [...new Set([...tracked, ...untracked])].sort();
  const patch = git(cwd, ["diff", baseCommit]);
  const untrackedBody = untracked
    .map((file) => git(cwd, ["hash-object", "--", file]))
    .join("\n");
  const hash = createHash("sha256").update(patch).update(untrackedBody).digest("hex");
  return { files, committed: head !== baseCommit, hash };
}

export function judgeAgentDiff(diff: TreeDiff, allowed: readonly string[] = [ALLOWED_AGENT_FILE]): string | null {
  if (diff.committed) {
    return "agent created a commit";
  }
  const extra = diff.files.filter((file) => !allowed.includes(file));
  if (extra.length > 0) {
    return `agent changed ${extra.join(", ")}`;
  }
  return null;
}
