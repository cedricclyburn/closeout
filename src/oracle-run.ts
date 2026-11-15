import { spawnSync } from "node:child_process";
import path from "node:path";

import type { CheckResult, Finding } from "./domain.ts";

export function oracleScripts(repoRoot: string, finding: Finding, followUp: boolean): string[] {
  if (finding.kind === "known-upgrade") {
    return [path.join(repoRoot, "oracle", "test_pin.py")];
  }
  const scripts = [path.join(repoRoot, "oracle", "test_traversal.py")];
  if (followUp) {
    scripts.push(path.join(repoRoot, "oracle", "test_absolute.py"));
  }
  return scripts;
}

export function runOracleScript(
  script: string,
  servicePath: string,
  extraEnv: Record<string, string> = {},
): CheckResult {
  const python = process.env.CLOSEOUT_PYTHON ?? "python3";
  const result = spawnSync(python, [script], {
    env: { ...process.env, CLOSEOUT_SERVICE: servicePath, ...extraEnv },
    encoding: "utf8",
  });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    return { outcome: "pass", detail: detail || script };
  }
  return { outcome: "fail", detail: detail || `${script} exited ${result.status}` };
}

export function checkService(
  repoRoot: string,
  servicePath: string,
  finding: Finding,
  followUp: boolean,
): CheckResult {
  const extra: Record<string, string> =
    finding.kind === "known-upgrade"
      ? {
          CLOSEOUT_PIN_NAME: finding.pin.name,
          CLOSEOUT_PIN_PINNED: finding.pin.pinned,
          CLOSEOUT_PIN_FIXED: finding.pin.fixed,
        }
      : {};
  const details: string[] = [];
  for (const script of oracleScripts(repoRoot, finding, followUp)) {
    const result = runOracleScript(script, servicePath, extra);
    details.push(result.detail);
    if (result.outcome === "fail") {
      return { outcome: "fail", detail: details.join("\n") };
    }
  }
  return { outcome: "pass", detail: details.join("\n") };
}
