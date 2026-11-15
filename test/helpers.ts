import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { git } from "../src/diff.ts";

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "closeout-"));
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

export function initRepo(files: Record<string, string>): {
  dir: string;
  commit: string;
  cleanup: () => void;
} {
  const dir = tempDir();
  writeTree(dir, files);
  git(dir, ["init"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "Add the vulnerable log reader"]);
  const commit = git(dir, ["rev-parse", "HEAD"]).trim();
  return {
    dir,
    commit,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
