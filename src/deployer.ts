import { spawnSync } from "node:child_process";
import path from "node:path";

import type { CheckResult, DeployerPort } from "./domain.ts";

export function createDeployer(options: {
  repoRoot: string;
  deployRoot: string;
  port: number;
}): DeployerPort {
  const run = (playbook: string, extra: string[]): CheckResult => {
    const result = spawnSync(
      "ansible-playbook",
      [
        "-i",
        path.join(options.repoRoot, "deploy", "hosts"),
        path.join(options.repoRoot, "deploy", playbook),
        "-e",
        `deploy_root=${options.deployRoot}`,
        "-e",
        `listen_port=${options.port}`,
        ...extra,
      ],
      { encoding: "utf8" },
    );
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.status === 0) {
      return { outcome: "pass", detail };
    }
    return { outcome: "fail", detail: detail || `ansible exited ${result.status}` };
  };

  return {
    async deploy({ releaseDir }) {
      return run("deploy.yml", ["-e", `release_src=${path.resolve(releaseDir)}`]);
    },
    async rollback() {
      return run("rollback.yml", []);
    },
  };
}
