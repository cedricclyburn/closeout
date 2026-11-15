import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { git, headCommit } from "./diff.ts";

export type PreparedService = {
  repoDir: string;
  worktree: string;
  commit: string;
};

export function prepareService(sourceDir: string, repoDir: string, worktreeDir: string): PreparedService {
  rmSync(worktreeDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(path.dirname(repoDir), { recursive: true });
  mkdirSync(path.dirname(worktreeDir), { recursive: true });
  cpSync(sourceDir, repoDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git" && path.basename(source) !== "__pycache__",
  });
  git(repoDir, ["init"]);
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "Add the vulnerable log reader"]);
  const commit = headCommit(repoDir);
  git(repoDir, ["worktree", "add", "--detach", worktreeDir, commit]);
  return { repoDir, worktree: worktreeDir, commit };
}
