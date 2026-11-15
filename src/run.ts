import { headCommit, judgeAgentDiff, treeDiff } from "./diff.ts";
import {
  PIN_FILE,
  type CheckResult,
  type DeployedRecord,
  type Disposition,
  type Evidence,
  type Finding,
  type GateRecord,
  type HeldRecord,
  type Phase,
  type Ports,
  type RejectedRecord,
} from "./domain.ts";
import { applyPin } from "./pin.ts";
import { dispositionFor } from "./policy.ts";

export type RunOptions = {
  releasedBy: string;
  artifactName: string;
  version: string;
  prompt: string;
  baseCommit?: string;
  followUp?: boolean;
  resumeAgentId?: string;
};

export type RunResult = {
  phases: Phase[];
  record: GateRecord;
};

function rejected(
  finding: Finding,
  disposition: Disposition | null,
  reason: string,
  agentId: string | null = null,
  runId: string | null = null,
): RejectedRecord {
  return { phase: "rejected", finding, disposition, reason, agentId, runId };
}

function evidenceFor(input: {
  finding: Finding;
  disposition: Exclude<Disposition, "refuse">;
  agentId: string | null;
  runId: string | null;
  oracleResult: CheckResult;
  diffHash: string;
  releasedBy: string;
  artifactName: string;
  version: string;
  ansibleResult: CheckResult;
}): Evidence {
  return {
    name: input.artifactName,
    version: input.version,
    findingIds: [input.finding.id],
    disposition: input.disposition,
    agentId: input.agentId,
    runId: input.runId,
    oracleResult: input.oracleResult,
    diffHash: input.diffHash,
    releasedBy: input.releasedBy,
    ansibleResult: input.ansibleResult,
  };
}

export async function runFinding(
  finding: Finding,
  servicePath: string,
  ports: Ports,
  options: RunOptions,
): Promise<RunResult> {
  const phases: Phase[] = ["ingested", "triaged"];
  const disposition = dispositionFor(finding);
  if (disposition === "refuse") {
    phases.push("rejected");
    return {
      phases,
      record: rejected(finding, disposition, "policy refused this finding"),
    };
  }

  phases.push("patching");
  const baseCommit = options.baseCommit ?? headCommit(servicePath);
  let agentId: string | null = options.resumeAgentId ?? null;
  let runId: string | null = null;

  if (finding.kind === "known-upgrade") {
    try {
      applyPin(servicePath, finding.pin);
    } catch (error) {
      phases.push("rejected");
      const message = error instanceof Error ? error.message : "pin edit failed";
      return { phases, record: rejected(finding, disposition, message) };
    }
  } else {
    const edited = await ports.agent.edit({
      cwd: servicePath,
      prompt: options.prompt,
      agentId: options.resumeAgentId,
    });
    if (edited.outcome === "startup-error") {
      phases.push("rejected");
      return {
        phases,
        record: rejected(
          finding,
          disposition,
          `agent did not start: ${edited.message}`,
          edited.agentId,
          edited.runId,
        ),
      };
    }
    if (edited.outcome === "run-error") {
      phases.push("rejected");
      return {
        phases,
        record: rejected(
          finding,
          disposition,
          `agent run failed: ${edited.message}`,
          edited.agentId,
          edited.runId,
        ),
      };
    }
    agentId = edited.agentId;
    runId = edited.runId;
  }

  const diff = treeDiff(servicePath, baseCommit);
  if (finding.kind === "code-defect") {
    const violation = judgeAgentDiff(diff);
    if (violation) {
      phases.push("rejected");
      return {
        phases,
        record: rejected(finding, disposition, violation, agentId, runId),
      };
    }
  } else if (diff.committed || diff.files.join(",") !== PIN_FILE) {
    phases.push("rejected");
    return {
      phases,
      record: rejected(
        finding,
        disposition,
        `pin edit changed ${diff.files.join(", ") || "nothing"}`,
        agentId,
        runId,
      ),
    };
  }
  phases.push("oracle");
  const oracleResult = await ports.oracle.check({
    servicePath,
    finding,
    followUp: options.followUp === true,
  });
  if (oracleResult.outcome === "fail") {
    phases.push("rejected");
    return {
      phases,
      record: rejected(
        finding,
        disposition,
        `oracle failed: ${oracleResult.detail}`,
        agentId,
        runId,
      ),
    };
  }

  if (disposition === "send-to-agent") {
    if (!agentId || !runId) {
      phases.push("rejected");
      return {
        phases,
        record: rejected(finding, disposition, "agent finished without an id", agentId, runId),
      };
    }
    phases.push("held");
    const record: HeldRecord = {
      phase: "held",
      finding,
      disposition,
      agentId,
      runId,
      diffHash: diff.hash,
      oracleResult,
      baseCommit,
      servicePath,
    };
    return { phases, record };
  }

  return releaseRecord({
    finding,
    disposition,
    agentId,
    runId,
    diffHash: diff.hash,
    oracleResult,
    servicePath,
    ports,
    options,
    phases,
  });
}

export async function releaseHeld(
  held: HeldRecord,
  ports: Ports,
  options: Pick<RunOptions, "releasedBy" | "artifactName" | "version">,
): Promise<RunResult> {
  const phases: Phase[] = ["held"];
  const oracleResult = await ports.oracle.check({
    servicePath: held.servicePath,
    finding: held.finding,
    followUp: false,
  });
  if (oracleResult.outcome === "fail") {
    phases.push("rejected");
    return {
      phases,
      record: rejected(
        held.finding,
        held.disposition,
        `oracle failed: ${oracleResult.detail}`,
        held.agentId,
        held.runId,
      ),
    };
  }
  return releaseRecord({
    finding: held.finding,
    disposition: held.disposition,
    agentId: held.agentId,
    runId: held.runId,
    diffHash: held.diffHash,
    oracleResult,
    servicePath: held.servicePath,
    ports,
    options,
    phases,
  });
}

export async function followUp(
  held: HeldRecord,
  sentence: string,
  ports: Ports,
): Promise<RunResult> {
  return runFinding(held.finding, held.servicePath, ports, {
    releasedBy: "unused",
    artifactName: "unused",
    version: "unused",
    prompt: sentence,
    baseCommit: held.baseCommit,
    followUp: true,
    resumeAgentId: held.agentId,
  });
}

async function releaseRecord(input: {
  finding: Finding;
  disposition: Exclude<Disposition, "refuse">;
  agentId: string | null;
  runId: string | null;
  diffHash: string;
  oracleResult: CheckResult;
  servicePath: string;
  ports: Ports;
  options: Pick<RunOptions, "releasedBy" | "artifactName" | "version">;
  phases: Phase[];
}): Promise<RunResult> {
  input.phases.push("releasing");
  const ansibleResult = await input.ports.deployer.deploy({ releaseDir: input.servicePath });
  const evidence = evidenceFor({
    finding: input.finding,
    disposition: input.disposition,
    agentId: input.agentId,
    runId: input.runId,
    oracleResult: input.oracleResult,
    diffHash: input.diffHash,
    releasedBy: input.options.releasedBy,
    artifactName: input.options.artifactName,
    version: input.options.version,
    ansibleResult,
  });
  if (ansibleResult.outcome === "fail") {
    input.phases.push("rejected");
    return {
      phases: input.phases,
      record: rejected(
        input.finding,
        input.disposition,
        `deploy failed: ${ansibleResult.detail.split("\n").slice(-30).join("\n")}`,
        input.agentId,
        input.runId,
      ),
    };
  }
  const saved = await input.ports.store.promote({
    treePath: input.servicePath,
    evidence,
  });
  input.phases.push("deployed");
  const record: DeployedRecord = {
    phase: "deployed",
    finding: input.finding,
    disposition: input.disposition,
    agentId: input.agentId,
    runId: input.runId,
    diffHash: input.diffHash,
    oracleResult: input.oracleResult,
    evidence,
    uri: saved.uri,
  };
  return { phases: input.phases, record };
}
