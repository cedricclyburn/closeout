import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PIN_FILE, type CheckResult, type DeployerPort } from "./domain.ts";
import { keepShippedPins } from "./pin.ts";

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
      preserveShippedPins(options.deployRoot, releaseDir);
      return run("deploy.yml", ["-e", `release_src=${path.resolve(releaseDir)}`]);
    },
    async rollback() {
      return run("rollback.yml", []);
    },
  };
}

function preserveShippedPins(deployRoot: string, releaseDir: string): void {
  const shippedPath = path.join(deployRoot, "current", PIN_FILE);
  if (!existsSync(shippedPath)) {
    return;
  }
  const candidatePath = path.join(releaseDir, PIN_FILE);
  const shipped = readFileSync(shippedPath, "utf8");
  const candidate = existsSync(candidatePath) ? readFileSync(candidatePath, "utf8") : "";
  const next = keepShippedPins(shipped, candidate);
  if (next !== candidate) {
    writeFileSync(candidatePath, next);
  }
}

function signal(pid: number, signo: NodeJS.Signals): void {
  try {
    process.kill(pid, signo);
  } catch {
    return;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function clearDemoHistory(deployRoot: string, artifactsDir: string): void {
  const pidFile = path.join(deployRoot, "server.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
      signal(pid, "SIGTERM");
      const deadline = Date.now() + 2000;
      while (processAlive(pid) && Date.now() < deadline) {
        spawnSync("sleep", ["0.1"]);
      }
      if (processAlive(pid)) {
        signal(pid, "SIGKILL");
      }
    }
  }
  rmSync(deployRoot, { recursive: true, force: true });
  rmSync(artifactsDir, { recursive: true, force: true });
}
