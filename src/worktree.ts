import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import { git, headCommit } from "./diff.ts";

export type PreparedService = {
  repoDir: string;
  worktree: string;
  commit: string;
};

function materializeHead(sourceDir: string, repoDir: string): void {
  const top = realpathSync(git(sourceDir, ["rev-parse", "--show-toplevel"]).trim());
  const relative = path.relative(top, realpathSync(sourceDir)).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`sample ${sourceDir} is outside ${top}`);
  }
  const treeish = relative.length === 0 ? "HEAD" : `HEAD:${relative}`;
  const archive = execFileSync("git", ["archive", "--format=tar", treeish], {
    cwd: top,
    maxBuffer: 8 * 1024 * 1024,
  });
  mkdirSync(repoDir, { recursive: true });
  execFileSync("tar", ["-x", "-C", repoDir], { input: archive });
}

export function prepareService(sourceDir: string, repoDir: string, worktreeDir: string): PreparedService {
  rmSync(worktreeDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(path.dirname(repoDir), { recursive: true });
  mkdirSync(path.dirname(worktreeDir), { recursive: true });
  materializeHead(sourceDir, repoDir);
  git(repoDir, ["init"]);
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "Add the vulnerable log reader"]);
  const commit = headCommit(repoDir);
  git(repoDir, ["worktree", "add", "--detach", worktreeDir, commit]);
  return { repoDir, worktree: worktreeDir, commit };
}
