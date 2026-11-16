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

function nulSplit(text: string): string[] {
  return text.split("\0").filter((part) => part.length > 0);
}

function gitText(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function blobHash(cwd: string, file: string): string | null {
  const text = gitText(cwd, ["hash-object", "--", file]);
  return text === null ? null : text.trim();
}

function committedBlobs(cwd: string, commit: string): Map<string, string> {
  const raw = git(cwd, ["ls-tree", "-r", "-z", commit]);
  const blobs = new Map<string, string>();
  for (const entry of nulSplit(raw)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const hash = entry.slice(0, tab).split(" ").at(2);
    const file = entry.slice(tab + 1);
    if (hash && file) {
      blobs.set(file, hash);
    }
  }
  return blobs;
}

function isBytecodePath(file: string): boolean {
  return file.endsWith(".pyc") || file.split("/").includes("__pycache__");
}

export function treeDiff(cwd: string, baseCommit: string): TreeDiff {
  const head = headCommit(cwd);
  const blobs = committedBlobs(cwd, baseCommit);
  const index = nulSplit(git(cwd, ["ls-files", "-z"]));
  const changed: string[] = [];
  for (const file of new Set([...blobs.keys(), ...index])) {
    if (isBytecodePath(file)) {
      continue;
    }
    const committed = blobs.get(file) ?? null;
    if (committed !== blobHash(cwd, file)) {
      changed.push(file);
    }
  }
  const untracked = nulSplit(git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"])).filter(
    (file) => !isBytecodePath(file),
  );
  const files = [...new Set([...changed, ...untracked])].sort();
  const patch = git(cwd, ["diff", baseCommit]);
  const visible = new Set(nulSplit(git(cwd, ["diff", "-z", "--name-only", baseCommit])));
  const hiddenBody = changed
    .filter((file) => !visible.has(file))
    .sort()
    .map((file) => `${file}\0${blobHash(cwd, file) ?? "missing"}\0`)
    .join("");
  const untrackedBody = untracked.map((file) => git(cwd, ["hash-object", "--", file])).join("\n");
  const hash = createHash("sha256").update(patch).update(hiddenBody).update(untrackedBody).digest("hex");
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
