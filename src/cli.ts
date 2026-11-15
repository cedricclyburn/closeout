import path from "node:path";

import { enrich, readAdvisory, type AdvisoryItem } from "./advisory.ts";
import { runAgent } from "./agent.ts";
import { blastRadius } from "./blast.ts";
import { ARTIFACT_NAME, PIN_FILE, type Finding, type GateRecord, type Phase, type Ports } from "./domain.ts";
import { git, treeDiff } from "./diff.ts";
import { createDeployer } from "./deployer.ts";
import { checkService } from "./oracle-run.ts";
import { dispositionFor } from "./policy.ts";
import { defectPrompt, followUpSentence } from "./prompt.ts";
import { repoRoot } from "./root.ts";
import { followUp, releaseHeld, runFinding } from "./run.ts";
import { loadSession, replaceRecord, saveSession, type Session } from "./session.ts";
import { createStore } from "./store.ts";
import { prepareService } from "./worktree.ts";

function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function listenPort(): number {
  const raw = process.env.PORT ?? "8765";
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PORT must be a positive integer, got ${raw}`);
  }
  return value;
}

function livePorts(): Ports {
  return {
    agent: { edit: runAgent },
    oracle: {
      async check({ servicePath, finding, followUp: isFollowUp }) {
        return checkService(repoRoot, servicePath, finding, isFollowUp);
      },
    },
    store: createStore({
      artifactsRoot: path.join(repoRoot, "artifacts", "release"),
      artifactoryUrl: process.env.ARTIFACTORY_URL?.trim() || undefined,
      artifactoryToken: process.env.ARTIFACTORY_TOKEN,
    }),
    deployer: createDeployer({
      repoRoot,
      deployRoot: path.join(repoRoot, "var", "runtime"),
      port: listenPort(),
    }),
  };
}

function importersFor(servicePath: string, finding: Finding): string[] {
  const target =
    finding.kind === "known-upgrade" ? finding.pin.name : path.basename(finding.location.file, ".py");
  return blastRadius(servicePath, target).importers;
}

function printRecord(record: GateRecord, importers: string[], phases?: Phase[], extra: string[] = []): void {
  const finding = record.finding;
  if (finding.kind === "known-upgrade") {
    say(`${finding.id}  known-upgrade  ${finding.pin.name} ${finding.pin.pinned} -> ${finding.pin.fixed}`);
  } else {
    say(`${finding.id}  code-defect  ${finding.location.file}:${finding.location.symbol}`);
  }
  say(`  imports: ${importers.join(", ") || "none"}`);
  const disposition = "disposition" in record && record.disposition ? record.disposition : dispositionFor(finding);
  say(`  disposition: ${disposition}`);
  if (phases) {
    say(`  path: ${phases.join(" -> ")}`);
  } else {
    say(`  phase: ${record.phase}`);
  }
  if (record.phase === "rejected") {
    say(`  reason: ${record.reason}`);
  }
  if (record.phase === "held") {
    say(`  agent: ${record.agentId}`);
    say(`  run: ${record.runId}`);
    say(`  oracle: ${record.oracleResult.outcome}`);
    say("  server: unchanged until npm run release");
    say(`  next: npm run follow-up -- "also reject absolute paths"`);
    say("  next: npm run release");
  }
  if (record.phase === "deployed") {
    say(`  oracle: ${record.evidence.oracleResult.outcome}`);
    say(`  released by: ${record.evidence.releasedBy}`);
    say(`  diff: ${record.diffHash}`);
    say(`  evidence: ${path.relative(repoRoot, record.uri)}/evidence.json`);
    say(`  health: http://127.0.0.1:${listenPort()}/health`);
  }
  for (const line of extra) {
    say(`  ${line}`);
  }
  say("");
}

function readSession(): Session {
  try {
    return loadSession(repoRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Run npm run demo first.");
    }
    throw error;
  }
}

export async function demo(): Promise<number> {
  say("closeout");
  say("advisory: local scanner export");
  const prepared = prepareService(
    path.join(repoRoot, "sample"),
    path.join(repoRoot, "var", "service"),
    path.join(repoRoot, "var", "worktree"),
  );
  say(`worktree: ${path.relative(repoRoot, prepared.worktree)}`);
  say(`commit: ${prepared.commit.slice(0, 12)}`);
  say("");

  const items = readAdvisory(path.join(repoRoot, "advisory", "advisory.json")).sort(byKind);
  const ports = livePorts();
  const records: GateRecord[] = [];

  for (const item of items) {
    const { finding, importers } = enrich(prepared.worktree, item);
    if (finding.kind === "code-defect" && !process.env.CURSOR_API_KEY) {
      const record: GateRecord = {
        phase: "triaged",
        finding,
        disposition: dispositionFor(finding),
      };
      records.push(record);
      printRecord(record, importers, undefined, [
        "agent: not started",
        `server: http://127.0.0.1:${listenPort()}/health is the pin release. src/logview.py is unchanged`,
        "Export CURSOR_API_KEY from https://cursor.com/dashboard/integrations",
        "Then run npm run demo again. Tests of the gate do not need a key.",
      ]);
      continue;
    }

    const result = await runFinding(finding, prepared.worktree, ports, {
      releasedBy: "policy",
      artifactName: ARTIFACT_NAME,
      version: versionFor(finding),
      prompt: finding.kind === "code-defect" ? defectPrompt(finding) : "apply the named pin",
      baseCommit: prepared.commit,
    });
    if (finding.kind === "known-upgrade" && result.record.phase === "deployed") {
      git(prepared.worktree, ["checkout", "--", PIN_FILE]);
      const dirty = treeDiff(prepared.worktree, prepared.commit);
      if (dirty.committed || dirty.files.length > 0) {
        throw new Error(`worktree still dirty after the pin release: ${dirty.files.join(", ")}`);
      }
    }
    records.push(result.record);
    printRecord(result.record, importers, result.phases);
    if (result.record.phase === "rejected") {
      break;
    }
  }

  saveSession(repoRoot, {
    worktree: prepared.worktree,
    baseCommit: prepared.commit,
    records,
  });
  return records.some((record) => record.phase === "rejected") ? 1 : 0;
}

export async function release(): Promise<number> {
  const session = readSession();
  const held = session.records.find((record) => record.phase === "held");
  if (!held || held.phase !== "held") {
    say("No held fix. Export CURSOR_API_KEY, run npm run demo, then npm run release.");
    return 1;
  }
  const result = await releaseHeld(held, livePorts(), {
    releasedBy: process.env.USER || process.env.LOGNAME || "unknown",
    artifactName: ARTIFACT_NAME,
    version: versionFor(held.finding),
  });
  saveSession(repoRoot, replaceRecord(session, result.record));
  printRecord(result.record, importersFor(held.servicePath, held.finding), result.phases);
  return result.record.phase === "deployed" ? 0 : 1;
}

export async function follow(sentence: string): Promise<number> {
  const text = followUpSentence(sentence);
  const session = readSession();
  const held = session.records.find((record) => record.phase === "held");
  if (!held || held.phase !== "held") {
    say("No agent id to resume. Export CURSOR_API_KEY and run npm run demo first.");
    return 1;
  }
  say(`follow-up: ${text}`);
  const result = await followUp(held, text, livePorts());
  saveSession(repoRoot, replaceRecord(session, result.record));
  printRecord(result.record, importersFor(held.servicePath, held.finding), result.phases);
  return result.record.phase === "held" ? 0 : 1;
}

function versionFor(finding: Finding): string {
  return finding.kind === "known-upgrade" ? `pin-${finding.id}` : `defect-${finding.id}`;
}

function byKind(a: AdvisoryItem, b: AdvisoryItem): number {
  if (a.kind === b.kind) {
    return 0;
  }
  return a.kind === "known-upgrade" ? -1 : 1;
}

const command = process.argv[2];
const main =
  command === "demo"
    ? demo()
    : command === "release"
      ? release()
      : command === "follow-up"
        ? follow(process.argv.slice(3).join(" ").trim() || "also reject absolute paths")
        : Promise.reject(new Error("usage: node src/cli.ts demo|release|follow-up"));

main
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
